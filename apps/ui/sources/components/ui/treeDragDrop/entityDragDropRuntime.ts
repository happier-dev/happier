import { sameStrictJsonValue } from '@happier-dev/protocol';
import {
    EntityDragItemV1Schema, EntityDropOutcomeV1Schema,
    entityDragKindV1, entityDragScopesEqualV1,
    type EntityDragItemV1, type EntityDropAdmissionV1, type EntityDropOutcomeV1,
} from '@happier-dev/protocol/plugins/ui/entityDragDrop';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { isFiniteRect } from './geometry/treeDropCoordinateSpace';
import type {
    EntityDragDropRuntime, EntityDragDropSnapshot, EntityDragSource, EntityDropTarget,
    EntityDragInput, EntityDragCarry, EntityDropDestination, EntityDragSourceDescription,
} from './entityDragDropTypes';
import type { WindowBounds, WindowPointer } from './treeDragDropTypes';

const IDLE: EntityDragDropSnapshot = Object.freeze({ phase: 'idle', item: null, sourceId: null, targetId: null, admission: null, outcome: null });

/** Mounted realm owner; no persistence and no global target materialization. */
export function createEntityDragDropRuntime(options: Readonly<{
    /** Host localization of lifecycle failures; domain refusals already carry their own message. */
    describeReason?: (code: string) => string;
}> = {}): EntityDragDropRuntime {
    const sources = new Map<string, EntityDragSource>();
    const targets = new Map<string, EntityDropTarget>();
    const listeners = new Set<() => void>();
    const pointerListeners = new Set<() => void>();
    let snapshot = IDLE;
    let pointer: WindowPointer | null = null;
    type Carry = {
        source: EntityDragSource;
        item: EntityDragItemV1;
        input: EntityDragInput;
        selected: EntityDropTarget | null;
        destination: PluginUiJsonValueV1 | null;
        dispatched: boolean;
        releasePromise?: Promise<EntityDropOutcomeV1 | null>;
    };
    let carry: Carry | null = null;
    // The source registration can retire on acknowledgement. Its return feedback lasts only until
    // the existing cancel/new-begin boundary; it grants no dispatch or registration authority.
    let sourceFeedback: Readonly<{ sourceId: string; description: EntityDragSourceDescription | null; bounds: WindowBounds | null }> | null = null;
    const captureSourceFeedback = (source: EntityDragSource) => {
        const bounds = source.getBounds?.() ?? null;
        sourceFeedback = {
            sourceId: source.id,
            description: source.describe?.() ?? null,
            bounds: bounds && isFiniteRect(bounds) && bounds.width > 0 && bounds.height > 0
                ? { ...bounds } : sourceFeedback?.sourceId === source.id ? sourceFeedback.bounds : null,
        };
    };
    const isRefusedPointerFeedback = () => snapshot.phase === 'settled' && snapshot.outcome?.status === 'refused' && pointer !== null;

    const reason = (code: string) => ({ code, message: options.describeReason?.(code) ?? code });
    const refused = (code: string): EntityDropAdmissionV1 => ({ status: 'refused', reason: reason(code) });
    const notify = () => { for (const listener of [...listeners]) listener(); };
    const setPointer = (next: WindowPointer | null) => {
        if (pointer?.x === next?.x && pointer?.y === next?.y) return;
        pointer = next;
        for (const listener of [...pointerListeners]) listener();
    };
    const publish = (next: EntityDragDropSnapshot) => {
        // Only semantic feedback changes wake rows/targets. Geometry/pointer frames have a separate channel.
        if (snapshot.phase === next.phase && snapshot.sourceId === next.sourceId
            && snapshot.targetId === next.targetId && snapshot.item === next.item
            && JSON.stringify(snapshot.admission) === JSON.stringify(next.admission)
            && snapshot.outcome === next.outcome) return false;
        snapshot = next;
        notify();
        return true;
    };
    const cancel = (_reason?: string) => {
        if (carry?.dispatched || snapshot.phase === 'pending') return;
        carry = null;
        sourceFeedback = null;
        setPointer(null);
        publish(IDLE);
    };
    const retireFeedback = () => {
        sourceFeedback = null;
        setPointer(null);
        if (snapshot.phase === 'pending') {
            // Scope retirement hides feedback, not the already-dispatched owner's outcome.
            publish({ ...IDLE, phase: 'pending' });
        } else cancel('retired');
    };
    const readItem = (source: EntityDragSource): EntityDragItemV1 | null => {
        if (!source.isCurrent()) return null;
        const parsed = EntityDragItemV1Schema.safeParse(source.getItem());
        return parsed.success && entityDragScopesEqualV1(parsed.data.scope, source.scope) ? parsed.data : null;
    };
    const sourceCurrent = (active: Carry) => {
        if (sources.get(active.source.id) !== active.source || !active.source.isCurrent()) return false;
        try {
            const item = readItem(active.source);
            return item !== null && sameStrictJsonValue(item, active.item);
        } catch { return false; }
    };
    const targetCurrent = (target: EntityDropTarget) => targets.get(target.id) === target && target.isCurrent?.() !== false;
    const accepts = (target: EntityDropTarget, item: EntityDragItemV1) => target.acceptedKinds.includes(entityDragKindV1(item));
    const resolve = (active: Carry, target: EntityDropTarget): EntityDropAdmissionV1 => {
        if (!targetCurrent(target)) return refused('target-retired');
        if (!entityDragScopesEqualV1(active.item.scope, target.scope)) return refused('scope-mismatch');
        if (!accepts(target, active.item)) return refused('kind-not-accepted');
        try {
            return target.resolve({
                item: active.item, pointer: active.input === 'pointer' ? pointer : null,
                destination: active.destination, input: active.input,
            });
        } catch { return refused('admission-unavailable'); }
    };
    const depth = (target: EntityDropTarget) => {
        const seen = new Set<string>([target.id]);
        let parentId = target.parentId;
        let value = 0;
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            value += 1;
            parentId = targets.get(parentId)?.parentId;
        }
        return value;
    };
    const hitTarget = (active: Carry) => {
        if (!pointer) return null;
        let selected: EntityDropTarget | null = null;
        let selectedDepth = -1;
        let selectedArea = Infinity;
        let selectedCapturesKind = false;
        for (const target of targets.values()) {
            if (!targetCurrent(target) || !accepts(target, active.item)) continue;
            const bounds = target.getBounds();
            if (!bounds || !isFiniteRect(bounds) || bounds.width <= 0 || bounds.height <= 0) continue;
            if (pointer.x < bounds.x || pointer.x > bounds.x + bounds.width
                || pointer.y < bounds.y || pointer.y > bounds.y + bounds.height
                || target.containsPointer?.(pointer) === false) continue;
            const targetDepth = depth(target);
            const area = bounds.width * bounds.height;
            const capturesKind = target.captureKinds?.includes(entityDragKindV1(active.item)) === true;
            // A refused inner target still owns the event. Never fall through to a permissive parent.
            // A declared kind owner (Workflow Session binding) also owns a refusing release over
            // its composer. Keep pointer input/feedback intact rather than selecting a keyboard target.
            if ((capturesKind && !selectedCapturesKind) || (capturesKind === selectedCapturesKind
                && (targetDepth > selectedDepth || (targetDepth === selectedDepth && area < selectedArea)))) {
                selected = target;
                selectedDepth = targetDepth;
                selectedArea = area;
                selectedCapturesKind = capturesKind;
            }
        }
        return selected;
    };
    const refresh = (notifyDestinations = false) => {
        const active = carry;
        if (!active || active.dispatched) return;
        if (!sourceCurrent(active)) { cancel('source-retired'); return; }
        const target = active.input === 'pointer' ? hitTarget(active) : active.selected;
        if (target && !targetCurrent(target)) { cancel('target-retired'); return; }
        active.selected = target;
        const admission = target ? resolve(active, target) : null;
        if (carry !== active) return;
        if (!publish({ phase: 'carrying', item: active.item, sourceId: active.source.id,
            targetId: target?.id ?? null, admission, outcome: null }) && notifyDestinations) {
            // A chooser has no selected target yet; current destination admission can still change.
            notify();
        }
    };
    const matchingMeasurementTargets = (active: Carry) => active.input === 'pointer' ? [...targets.values()].filter(target =>
        targetCurrent(target) && accepts(target, active.item)
        && entityDragScopesEqualV1(active.item.scope, target.scope) && target.measureBounds) : [];
    const refreshMeasurements = async () => {
        const active = carry;
        if (!active || active.input !== 'pointer' || active.dispatched || active.releasePromise) return;
        try { await Promise.all(matchingMeasurementTargets(active).map(target => target.measureBounds!())); }
        catch { if (carry === active) cancel('target-geometry-unavailable'); return; }
        if (carry === active) refresh();
    };
    const move = (next: WindowPointer | null) => {
        if (!carry || carry.dispatched || carry.releasePromise) return;
        carry.input = 'pointer';
        carry.destination = null;
        captureSourceFeedback(carry.source);
        setPointer(next && Number.isFinite(next.x) && Number.isFinite(next.y) ? next : null);
        refresh();
    };
    const choose = (targetId: string, destination?: PluginUiJsonValueV1) => {
        if (!carry || carry.dispatched || carry.releasePromise) return;
        if (carry.input === 'pointer') carry.input = 'keyboard';
        carry.selected = targets.get(targetId) ?? null;
        carry.destination = destination ?? null;
        setPointer(null);
        refresh();
    };
    const finishRelease = async (active: Carry): Promise<EntityDropOutcomeV1 | null> => {
        captureSourceFeedback(active.source);
        const measuredTargets = matchingMeasurementTargets(active);
        if (measuredTargets.length > 0) {
            try { await Promise.all(measuredTargets.map(target => target.measureBounds!())); }
            catch {
                if (carry !== active) return null;
                const outcome: EntityDropOutcomeV1 = { status: 'refused', reason: reason('target-geometry-unavailable') };
                carry = null;
                publish({ ...snapshot, phase: 'settled', outcome });
                return outcome;
            }
        }
        if (carry !== active) return null;
        captureSourceFeedback(active.source);
        refresh();
        if (carry !== active) return null;
        const target = active.selected;
        const admission = snapshot.admission;
        if (!target || !admission) { cancel(); return null; }
        if (active.input === 'pointer' && target.measureBounds && !measuredTargets.includes(target)) { cancel(); return null; }
        // Resolvers may observe retirement while reading current domain state.
        if (!sourceCurrent(active) || !readItem(active.source) || !targetCurrent(target)) { cancel(); return null; }
        if (admission.status === 'refused') {
            const outcome: EntityDropOutcomeV1 = { status: 'refused', reason: admission.reason };
            carry = null;
            publish({ ...snapshot, phase: 'settled', outcome });
            return outcome;
        }
        // Dispatch is the commitment boundary. From here only the effect owner settles the outcome.
        active.dispatched = true;
        publish({ ...snapshot, phase: 'pending' });
        let outcome: EntityDropOutcomeV1;
        try {
            const parsed = EntityDropOutcomeV1Schema.safeParse(await target.execute(admission.effect));
            outcome = parsed.success ? parsed.data : { status: 'unknown', reason: reason('invalid-effect-outcome') };
        } catch {
            outcome = { status: 'unknown', reason: reason('effect-outcome-unknown') };
        }
        if (snapshot.item) captureSourceFeedback(active.source);
        carry = null;
        // The release promise keeps the real outcome, but a retired realm must not
        // display the previous scope's potentially domain-specific reason text.
        publish(snapshot.item ? { ...snapshot, phase: 'settled', outcome } : IDLE);
        return outcome;
    };
    const release = (): Promise<EntityDropOutcomeV1 | null> => {
        const active = carry;
        if (!active || active.dispatched) return Promise.resolve(null);
        if (!active.releasePromise) active.releasePromise = finishRelease(active);
        return active.releasePromise;
    };
    const start = (sourceId: string, input: EntityDragInput): EntityDragCarry | null => {
        if (snapshot.phase === 'pending') return null;
        cancel();
        const source = sources.get(sourceId);
        const item = source && readItem(source);
        if (!source || !item) return null;
        const active: Carry = { source, item, input, selected: null, destination: null, dispatched: false };
        carry = active;
        captureSourceFeedback(source);
        publish({ phase: 'carrying', item, sourceId, targetId: null, admission: null, outcome: null });
        // A transient object reference fences delayed native callbacks; no durable gesture identity.
        return {
            move: next => { if (carry === active) move(next); },
            choose: (targetId, destination) => { if (carry === active) choose(targetId, destination); },
            release: () => carry === active ? release() : Promise.resolve(null),
            cancel: reason => { if (carry === active) cancel(reason); },
        };
    };
    return {
        registerSource: source => {
            if (snapshot.sourceId === source.id) retireFeedback();
            sources.set(source.id, source);
            notify();
            return () => {
                if (sources.get(source.id) !== source) return;
                sources.delete(source.id);
                if (snapshot.sourceId === source.id && !isRefusedPointerFeedback()) retireFeedback();
                notify();
            };
        },
        describeSource: sourceId => {
            const source = sources.get(sourceId);
            if (source) return readItem(source) ? source.describe?.() ?? null : null;
            return isRefusedPointerFeedback() && sourceFeedback?.sourceId === sourceId ? sourceFeedback.description : null;
        },
        getSourceBounds: sourceId => sourceFeedback?.sourceId === sourceId ? sourceFeedback.bounds : null,
        registerTarget: target => {
            if (snapshot.targetId === target.id) retireFeedback();
            targets.set(target.id, target);
            refresh();
            notify();
            return () => {
                if (targets.get(target.id) !== target) return;
                targets.delete(target.id);
                if (snapshot.targetId === target.id) retireFeedback();
                notify();
            };
        },
        begin: (sourceId, input = 'pointer') => start(sourceId, input),
        move, choose, release, cancel, refresh: () => refresh(true), refreshMeasurements,
        autoscroll: () => {
            refresh();
            if (carry && !carry.dispatched && pointer && snapshot.admission?.status === 'allowed') carry.selected?.autoscroll?.(pointer);
        },
        getDestinations: sourceId => {
            const source = sources.get(sourceId);
            const item = source && readItem(source);
            if (!source || !item) return [];
            const active: Carry = { source, item, input: 'chooser', selected: null, destination: null, dispatched: false };
            return [...targets.values()].filter(target => targetCurrent(target) && accepts(target, item))
                .flatMap((target): EntityDropDestination[] => {
                    if (!target.listDestinations || !entityDragScopesEqualV1(item.scope, target.scope)) {
                        return [{ targetId: target.id, admission: resolve(active, target) }];
                    }
                    return target.listDestinations(item).map(destination => ({
                        ...destination, targetId: target.id,
                        admission: resolve({ ...active, destination: destination.destination }, target),
                    }));
                });
        },
        perform: async (sourceId, targetId, destination, input = 'chooser') => {
            if (carry) return null;
            const active = start(sourceId, input);
            if (!active) return null;
            active.choose(targetId, destination);
            return active.release();
        },
        getSnapshot: () => snapshot,
        subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getPointer: () => pointer,
        subscribePointer: listener => { pointerListeners.add(listener); return () => { pointerListeners.delete(listener); }; },
    };
}
