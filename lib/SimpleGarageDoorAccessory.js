const BaseAccessory = require('./BaseAccessory');

// Configuring any state value opts into distinct endpoints plus a shared
// moving value. Existing installations retain the ambiguous 11/12/13 model.
const STATE_OPEN = 3;
const STATE_MOVING = 4;
const STATE_CLOSED = 5;
const LEGACY_STATE_STOPPED = 11;
const LEGACY_STATE_OPENING_OR_OPEN = 12;
const LEGACY_STATE_CLOSING_OR_CLOSED = 13;

// How long to wait between the stop and the close in the stop-before-close
// path. Overridable per-device via the `stopBeforeCloseMs` config option.
const DEFAULT_STOP_BEFORE_CLOSE_MS = 1500;

class SimpleGarageDoorAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.GARAGE_DOOR_OPENER;
    }

    constructor(...props) {
        super(...props);
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;
        this.accessory.addService(Service.GarageDoorOpener, this.device.context.name);
        this._reconcileOptionalServices();
        super._registerPlatformAccessory();
    }

    _reconcileOptionalServices() {
        const {Service} = this.hap;

        const partialOpenMs = parseInt(this.device.context.partialOpenMs, 10);
        const wantPartialOpen = Number.isFinite(partialOpenMs) && partialOpenMs > 0;
        const partialName = this.device.context.name + ' Partial Open';
        let partialSwitch = this.accessory.getServiceById(Service.Switch, 'partialOpen');
        if (wantPartialOpen) {
            if (partialSwitch) this._checkServiceName(partialSwitch, partialName);
            else this.accessory.addService(Service.Switch, partialName, 'partialOpen');
        } else if (partialSwitch) {
            this.accessory.removeService(partialSwitch);
        }

        const wantForceSwitches = this._coerceBoolean(this.device.context.forceSwitches, false);
        const forceOpenName = this.device.context.name + ' Force Open';
        const forceCloseName = this.device.context.name + ' Force Close';
        let forceOpenSwitch = this.accessory.getServiceById(Service.Switch, 'forceOpen');
        let forceCloseSwitch = this.accessory.getServiceById(Service.Switch, 'forceClose');
        if (wantForceSwitches) {
            if (forceOpenSwitch) this._checkServiceName(forceOpenSwitch, forceOpenName);
            else this.accessory.addService(Service.Switch, forceOpenName, 'forceOpen');
            if (forceCloseSwitch) this._checkServiceName(forceCloseSwitch, forceCloseName);
            else this.accessory.addService(Service.Switch, forceCloseName, 'forceClose');
        } else {
            if (forceOpenSwitch) this.accessory.removeService(forceOpenSwitch);
            if (forceCloseSwitch) this.accessory.removeService(forceCloseSwitch);
        }
    }

    _registerCharacteristics(dps) {
        this._reconcileOptionalServices();

        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.GarageDoorOpener);
        this._checkServiceName(service, this.device.context.name);

        this.dpOpen = this._getCustomDP(this.device.context.dpOpen) || '101';
        this.dpClose = this._getCustomDP(this.device.context.dpClose) || '102';
        this.dpStop = this._getCustomDP(this.device.context.dpStop) || '103';
        this.dpState = this._getCustomDP(this.device.context.dpState) || '105';
        this._configureStateMapping();
        this._stoppedPartWay = false;

        const partialOpenMs = parseInt(this.device.context.partialOpenMs, 10);
        this.partialOpenMs = Number.isFinite(partialOpenMs) && partialOpenMs > 0 ? partialOpenMs : 0;

        const stopBeforeCloseMs = parseInt(this.device.context.stopBeforeCloseMs, 10);
        this.stopBeforeCloseMs = Number.isFinite(stopBeforeCloseMs) && stopBeforeCloseMs >= 0
            ? stopBeforeCloseMs
            : DEFAULT_STOP_BEFORE_CLOSE_MS;

        // Pending side effects we may need to cancel: the partial-open auto-stop
        // and the close that trails a stop in the stop-before-close path.
        this.partialStopTimer = null;
        this.pendingCloseTimer = null;
        // A partial open that has fired its open but is still waiting for the
        // controller to report it's moving before arming the auto-stop.
        this.partialPending = false;
        // Bumped whenever a partial open starts or is superseded/cancelled, so a
        // stale auto-stop (and its re-sends) from an earlier flow bails out.
        this.partialGeneration = 0;

        // Seed the initial state from whatever the device has already reported.
        // If it hasn't reported yet, fall back to the persisted target, then to
        // CLOSED (the safer assumption for a gate). The real state DP almost
        // always arrives within a second of connecting and corrects this.
        this._committedTarget = this.accessory.context.cachedTargetDoorState === Characteristic.TargetDoorState.OPEN
            ? Characteristic.TargetDoorState.OPEN
            : Characteristic.TargetDoorState.CLOSED;
        this.currentDoorState = this._mapDpState(dps[this.dpState]);
        if (this.currentDoorState === null) {
            this.currentDoorState = this._committedTarget === Characteristic.TargetDoorState.OPEN
                ? Characteristic.CurrentDoorState.OPEN : Characteristic.CurrentDoorState.CLOSED;
        }
        const initialTarget = this._targetForCurrentState(this.currentDoorState);
        this.accessory.context.cachedTargetDoorState = initialTarget;
        // The level-triggered dispatch baseline (see setTargetDoorState). Held
        // separately from cachedTargetDoorState because a legacy stopped report
        // mirrors OPEN into HomeKit without changing this dispatch baseline.
        this._committedTarget = initialTarget;

        this.characteristicTargetDoorState = service.getCharacteristic(Characteristic.TargetDoorState)
            .updateValue(initialTarget)
            .onGet(() => this._reportDoorState(this.accessory.context.cachedTargetDoorState))
            .onSet(value => this.setTargetDoorState(value));

        this.characteristicCurrentDoorState = service.getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(this.currentDoorState)
            .onGet(() => this._reportDoorState(this.currentDoorState));

        // The controller exposes limit switches (l_open/l_close) but they don't
        // work in practice, and there's no obstruction sensor wired up, so this
        // is always reported clear.
        service.getCharacteristic(Characteristic.ObstructionDetected)
            .updateValue(false)
            .onGet(() => this._reportDoorState(false));

        const partialSwitch = this.accessory.getServiceById(Service.Switch, 'partialOpen');
        if (partialSwitch) {
            const onChar = partialSwitch.getCharacteristic(Characteristic.On)
                .updateValue(this._partialSwitchIsOn())
                .onGet(() => this._reportDoorState(this._partialSwitchIsOn()))
                .onSet(value => {
                    // Stateful: the switch mirrors CurrentDoorState (ON while
                    // the gate is open in HomeKit's view — see
                    // _applyReportedState). Tapping it ON triggers a
                    // partial-open; tapping it OFF triggers a full close.
                    if (value) {
                        this._handlePartialOpen();
                    } else {
                        this.setTargetDoorState(Characteristic.TargetDoorState.CLOSED);
                    }
                });
            this.characteristicPartialOpen = onChar;
        }

        const forceOpenSwitch = this.accessory.getServiceById(Service.Switch, 'forceOpen');
        if (forceOpenSwitch) {
            const onChar = forceOpenSwitch.getCharacteristic(Characteristic.On)
                .updateValue(false)
                .onGet(() => false)
                .onSet(value => {
                    if (!value) return;
                    this.setTargetDoorState(Characteristic.TargetDoorState.OPEN, true);
                    setImmediate(() => onChar.updateValue(false));
                });
            this.characteristicForceOpen = onChar;
        }

        const forceCloseSwitch = this.accessory.getServiceById(Service.Switch, 'forceClose');
        if (forceCloseSwitch) {
            const onChar = forceCloseSwitch.getCharacteristic(Characteristic.On)
                .updateValue(false)
                .onGet(() => false)
                .onSet(value => {
                    if (!value) return;
                    this.setTargetDoorState(Characteristic.TargetDoorState.CLOSED, true);
                    setImmediate(() => onChar.updateValue(false));
                });
            this.characteristicForceClose = onChar;
        }

        this.device.on('change', changes => this._onDeviceChange(changes));
    }

    _configureStateMapping() {
        const defaults = {stateOpen: STATE_OPEN, stateMoving: STATE_MOVING, stateClosed: STATE_CLOSED};
        const context = this.device.context;
        const configured = key => context[key] !== undefined && context[key] !== null && context[key] !== '';
        this.stateMapping = null;
        if (!Object.keys(defaults).some(configured)) return;

        const mapping = {};
        for (const key of Object.keys(defaults)) {
            const raw = configured(key) ? context[key] : defaults[key];
            const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
            if (!Number.isInteger(value)) throw new Error(`${context.name}: ${key} must be an integer`);
            mapping[key] = value;
        }
        if (new Set(Object.values(mapping)).size !== 3) {
            throw new Error(`${context.name}: stateOpen, stateMoving and stateClosed must be distinct`);
        }
        this.stateMapping = mapping;
    }

    _mapDpState(raw) {
        const {CurrentDoorState, TargetDoorState} = this.hap.Characteristic;
        if (typeof raw === 'string' && !raw.trim()) return null;
        const value = typeof raw === 'string' ? Number(raw) : raw;
        if (this.stateMapping) {
            if (value === this.stateMapping.stateOpen) return CurrentDoorState.OPEN;
            if (value === this.stateMapping.stateClosed) return CurrentDoorState.CLOSED;
            if (value === this.stateMapping.stateMoving) {
                if (this._stoppedPartWay) return CurrentDoorState.STOPPED;
                return this._committedTarget === TargetDoorState.OPEN
                    ? CurrentDoorState.OPENING : CurrentDoorState.CLOSING;
            }
        } else {
            if (value === LEGACY_STATE_STOPPED || value === LEGACY_STATE_OPENING_OR_OPEN) return CurrentDoorState.OPEN;
            if (value === LEGACY_STATE_CLOSING_OR_CLOSED) return CurrentDoorState.CLOSED;
        }
        return null;
    }

    _targetForCurrentState(current) {
        const {CurrentDoorState, TargetDoorState} = this.hap.Characteristic;
        if (current === CurrentDoorState.OPEN) return TargetDoorState.OPEN;
        if (current === CurrentDoorState.CLOSED) return TargetDoorState.CLOSED;
        return this._committedTarget;
    }

    _partialSwitchIsOn() {
        const {CurrentDoorState} = this.hap.Characteristic;
        return [CurrentDoorState.OPEN, CurrentDoorState.OPENING, CurrentDoorState.STOPPED].includes(this.currentDoorState);
    }

    _onDeviceChange(changes) {
        if (!changes || !changes.hasOwnProperty(this.dpState)) return;
        // Our stop can produce a transient legacy OPEN report; keep the close
        // target committed until the trailing command has been dispatched.
        const raw = typeof changes[this.dpState] === 'string' ? Number(changes[this.dpState]) : changes[this.dpState];
        if (this.pendingCloseTimer) {
            if (this.stateMapping && raw === this.stateMapping.stateClosed) this._cancelPendingClose();
            else return;
        }
        const current = this._mapDpState(changes[this.dpState]);
        if (current === null) {
            this.log.debug(`[SimpleGarageDoor] ${this.device.context.name}: ignoring unknown state DP value ${JSON.stringify(changes[this.dpState])}`);
            return;
        }
        // Shared movement and legacy stop reports cannot establish a target.
        const definitive = this.stateMapping
            ? raw === this.stateMapping.stateOpen || raw === this.stateMapping.stateClosed
            : raw === LEGACY_STATE_OPENING_OR_OPEN || raw === LEGACY_STATE_CLOSING_OR_CLOSED;
        if (definitive) {
            this._stoppedPartWay = false;
            this._committedTarget = this._targetForCurrentState(current);
            // A closed report before motion may still be the starting position.
            if (this.stateMapping && (current === this.hap.Characteristic.CurrentDoorState.OPEN || !this.partialPending)) {
                this._cancelPartialStop();
            }
        }
        this._applyReportedState(current);
    }

    _applyReportedState(current) {
        const {CurrentDoorState} = this.hap.Characteristic;
        if (this.currentDoorState !== current) {
            this.currentDoorState = current;
            this.characteristicCurrentDoorState.updateValue(current);
        }
        if (current === CurrentDoorState.OPEN || current === CurrentDoorState.CLOSED) {
            const target = this._targetForCurrentState(current);
            if (this.accessory.context.cachedTargetDoorState !== target) {
                this.accessory.context.cachedTargetDoorState = target;
                if (this.characteristicTargetDoorState) this.characteristicTargetDoorState.updateValue(target);
            }
        }
        if (this.characteristicPartialOpen) {
            this.characteristicPartialOpen.updateValue(this._partialSwitchIsOn());
        }

        if (this.partialPending && (current === CurrentDoorState.OPENING || (!this.stateMapping && current === CurrentDoorState.OPEN))) {
            this._armPartialStop();
        }
    }

    // onGet helper: a cached/optimistic door value is fine to report while the
    // gate is reachable, but when it's offline HomeKit must show "No Response"
    // instead of a stale state that makes the gate look online and accept taps.
    _reportDoorState(value) {
        if (!this.device.connected) throw this._commError();
        return value;
    }

    setTargetDoorState(value, force = false) {
        // Surface "No Response" for a tap on an unreachable gate instead of
        // silently dropping the command (the write helpers would otherwise just
        // log and skip, leaving HomeKit to believe the open/close succeeded).
        if (!this.device.connected) throw this._commError();

        // The opener is level-triggered: act only when the requested target
        // differs from the one we've already committed to. HomeKit re-sends the
        // same target after a tap — a second controller echoing it, or its own
        // retry a few seconds later — and acting on that repeat would fire another
        // open/close. For a close that means a second stop-before-close into the
        // already-closing gate, halting it mid-travel and restarting it (the
        // reported stutter). A genuine request always flips the target (the Home
        // app toggles to the opposite state). The committed target is reconciled
        // with the gate's real position in _onDeviceChange so external operation
        // still works — but only from a definitive report, never from the
        // "stopped" transient our own stop produces, so the repeat stays caught.
        if (value === this._committedTarget && !(force && this._stoppedPartWay)) {
            this.log.debug(`[SimpleGarageDoor] ${this.device.context.name}: target unchanged — ignoring repeat request`);
            return;
        }

        // A direct open/close (the GarageDoorOpener target, a Force switch, or
        // the partial switch tapped OFF) is manual control: cancel any pending
        // partial-open auto-stop so it can't halt this movement part-way. This
        // must run only for a genuine target change, AFTER the repeat check
        // above: a partial open drives the committed target to OPEN itself, so
        // HomeKit's repeat of that OPEN re-enters here, and cancelling on that
        // swallowed repeat would tear down the auto-stop the partial just armed —
        // letting the gate run all the way open instead of parking part-way.
        this._cancelPartialStop();

        this._applyTarget(value);
    }

    // Optimistically reflects the requested target in HomeKit and fires the
    // matching action on the device. A shared moving report follows the new
    // direction; endpoints still come from the status DP. The device echoes
    // the action DP back to false on its own; we don't wait for it.
    _applyTarget(value) {
        const {Characteristic} = this.hap;
        const open = value === Characteristic.TargetDoorState.OPEN;
        this._committedTarget = value;
        this.accessory.context.cachedTargetDoorState = value;
        if (this.characteristicTargetDoorState) this.characteristicTargetDoorState.updateValue(value);
        this._stoppedPartWay = false;
        const reported = this.device.state ? this.device.state[this.dpState] : undefined;
        const current = this._mapDpState(reported);
        if (this.stateMapping && (current === Characteristic.CurrentDoorState.OPENING || current === Characteristic.CurrentDoorState.CLOSING)) {
            this._applyReportedState(current);
        }
        if (open) this._sendOpen();
        else this._sendClose();
    }

    // Open is always safe to fire directly — the controller reverses on its
    // own, even mid-close. Abandon any pending stop-before-close.
    _sendOpen() {
        this._cancelPendingClose();
        this.log.debug(`[SimpleGarageDoor] ${this.device.context.name}: open (dp${this.dpOpen})`);
        this.setMultiStateLegacyInBackground({[this.dpOpen]: true});
    }

    // Only a definite stationary report permits a direct close. A shared
    // moving report may also mean a recent stop, so retain the stop/wait path.
    _sendClose() {
        const name = this.device.context.name;
        if (this.pendingCloseTimer) {
            // A stop-before-close is already running — don't restart it (and
            // push the close out) on a duplicate or retransmitted request.
            this.log.debug(`[SimpleGarageDoor] ${name}: close ignored — a stop-before-close is already running`);
            return;
        }
        const raw = this.device.state ? this.device.state[this.dpState] : undefined;
        const value = typeof raw === 'string' ? Number(raw) : raw;
        if (this.stateMapping && value === this.stateMapping.stateClosed) {
            this._applyReportedState(this.hap.Characteristic.CurrentDoorState.CLOSED);
            return;
        }
        if (this.stateMapping ? value === this.stateMapping.stateOpen : value === LEGACY_STATE_STOPPED) {
            this.log.debug(`[SimpleGarageDoor] ${name}: close (dp${this.dpClose}) — gate already stopped`);
            this.setMultiStateLegacyInBackground({[this.dpClose]: true});
            return;
        }
        this.log.debug(`[SimpleGarageDoor] ${name}: stop-before-close — stop (dp${this.dpStop}) now, close (dp${this.dpClose}) in ${this.stopBeforeCloseMs}ms`);
        this.setMultiStateLegacyInBackground({[this.dpStop]: true});
        this.pendingCloseTimer = setTimeout(() => {
            this.pendingCloseTimer = null;
            this.log.debug(`[SimpleGarageDoor] ${name}: stop-before-close — firing close (dp${this.dpClose})`);
            this.setMultiStateLegacyInBackground({[this.dpClose]: true});
        }, this.stopBeforeCloseMs);
    }

    _cancelPendingClose() {
        if (this.pendingCloseTimer) {
            clearTimeout(this.pendingCloseTimer);
            this.pendingCloseTimer = null;
        }
    }

    // Partial open: fire the open action, wait partialOpenMs, then fire a stop
    // so the gate ends up parked part-way.
    //
    // The auto-stop is anchored to the controller *reporting the gate is moving*
    // (or the legacy status DP flipping to OPEN), not to the button press: the open
    // command takes time to reach the gate, and a stop fired before the gate is
    // actually moving lands as a no-op the controller drops — letting the gate
    // run all the way open. If the gate already reports movement (or legacy
    // open/opening), arm straight away. A definite OPEN needs no partial stop.
    _handlePartialOpen() {
        const {Characteristic} = this.hap;
        const name = this.device.context.name;
        if (!this.device.connected) throw this._commError();
        if (!this.partialOpenMs) return;
        if (this.partialPending || this.partialStopTimer) {
            // Re-entrant press while a partial is already in progress (e.g. a
            // HomeKit/iOS WRITE retransmit) — ignore so the stop isn't pushed
            // out, which would let the gate run further than intended.
            this.log.debug(`[SimpleGarageDoor] ${name}: partial press ignored — a partial open is already running`);
            return;
        }

        this.log.debug(`[SimpleGarageDoor] ${name}: partial open — opening, will stop ${this.partialOpenMs}ms after the gate starts moving`);
        this.partialGeneration++;
        this.partialPending = true;
        this._applyTarget(Characteristic.TargetDoorState.OPEN);

        const reported = this.device.state ? this.device.state[this.dpState] : undefined;
        const current = this._mapDpState(reported);
        if (this.stateMapping && current === Characteristic.CurrentDoorState.OPEN) {
            this._cancelPartialStop();
        } else if (current === Characteristic.CurrentDoorState.OPENING || (!this.stateMapping && current === Characteristic.CurrentDoorState.OPEN)) {
            this._armPartialStop();
        }
    }

    _armPartialStop() {
        if (!this.partialPending || this.partialStopTimer) return;
        this.partialPending = false;
        const name = this.device.context.name;
        const generation = this.partialGeneration;
        this.partialStopTimer = setTimeout(() => {
            this.partialStopTimer = null;
            this.log.debug(`[SimpleGarageDoor] ${name}: partial open — firing stop (dp${this.dpStop})`);
            this._sendPartialStop(generation, 1);
        }, this.partialOpenMs);
    }

    // The controller occasionally drops a lone write (its command queue can
    // coalesce back-to-back writes, and brief Wi-Fi blips lose individual
    // packets), and a dropped stop here is exactly what lets a partial open run
    // all the way. Re-send it a few times; a stop on an already-parked gate is a
    // harmless no-op. Bails out if the flow was superseded mid-way.
    _sendPartialStop(generation, attempt) {
        if (generation !== this.partialGeneration || !this.device.connected) return;
        if (this.stateMapping) {
            // This controller keeps reporting MOVING after a stop. Retain our
            // local stop until an endpoint or a new command resolves it.
            this.setMultiStateLegacyAsync({[this.dpStop]: true}).then(() => {
                if (generation !== this.partialGeneration || !this.device.connected) return;
                this._stoppedPartWay = true;
                this._applyReportedState(this.hap.Characteristic.CurrentDoorState.STOPPED);
            }, () => {});
        } else {
            this.setMultiStateLegacyInBackground({[this.dpStop]: true});
        }
        if (attempt < 3) setTimeout(() => this._sendPartialStop(generation, attempt + 1), 300);
    }

    _cancelPartialStop() {
        this.partialPending = false;
        this.partialGeneration++;
        if (this.partialStopTimer) {
            clearTimeout(this.partialStopTimer);
            this.partialStopTimer = null;
        }
    }
}

module.exports = SimpleGarageDoorAccessory;
