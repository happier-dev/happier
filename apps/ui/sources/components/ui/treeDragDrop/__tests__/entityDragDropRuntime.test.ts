import { describe, expect, it } from 'vitest';
import type { EntityDragItemV1, EntityDropAdmissionV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { createEntityDragDropRuntime } from '../entityDragDropRuntime';
import type { EntityDropTarget } from '../entityDragDropTypes';
import { createEntityDragGestureAdapter } from '../entityDragGestureAdapter';
import { installEntityDragCancellation } from '../entityDragCancellation';

const scope = { serverId: 'home-a', accountId: 'account-a' };
const session: EntityDragItemV1 = { kind: 'session', scope, address: { serverId: scope.serverId, sessionId: 'child' } };
const allowed: EntityDropAdmissionV1 = { status: 'allowed', effect: { actionId: 'session.reports_to.set', input: { sessionId: 'child', leadSessionId: 'lead' }, preview: { verb: 'Put under', target: 'Lead', consequence: 'Both keep running' } } };
const refusal: EntityDropAdmissionV1 = { status: 'refused', reason: { code: 'reports_to_forbidden', message: 'Cannot take reports' } };

function fixture() {
    const runtime = createEntityDragDropRuntime();
    const effects: unknown[] = [];
    let verdict = allowed;
    let bounds = { x: 0, y: 0, width: 100, height: 100 };
    let item = session;
    const retireSource = runtime.registerSource({ id: 'source', scope, getItem: () => item, isCurrent: () => true });
    const target: EntityDropTarget = { id: 'target', scope, acceptedKinds: ['session'], getBounds: () => bounds, resolve: () => verdict, execute: async effect => { effects.push(effect.input); return { status: 'applied' }; } };
    const retireTarget = runtime.registerTarget(target);
    return { runtime, effects, target, retireSource, retireTarget, setVerdict: (next: EntityDropAdmissionV1) => { verdict = next; }, setBounds: (next: typeof bounds) => { bounds = next; }, setItem: (next: EntityDragItemV1) => { item = next; } };
}

describe('mounted entity drag owner', () => {
    it('refreshes only current matching pointer targets at scroll boundaries and ignores a retired measurement completion', async () => {
        const f = fixture();
        let finishMeasurement = () => {};
        f.runtime.registerTarget({ ...f.target, measureBounds: () => new Promise<void>(resolve => {
            finishMeasurement = () => { f.setBounds({ x: 200, y: 0, width: 100, height: 100 }); resolve(); };
        }) });
        const unexpectedMeasurement = async () => { throw new Error('Unrelated mounted surface must not be measured'); };
        f.runtime.registerTarget({ ...f.target, id: 'foreign', scope: { ...scope, accountId: 'other' }, getBounds: () => null, measureBounds: unexpectedMeasurement });
        f.runtime.registerTarget({ ...f.target, id: 'different-kind', acceptedKinds: ['destination'], measureBounds: unexpectedMeasurement });
        f.runtime.registerTarget({ ...f.target, id: 'retired', isCurrent: () => false, measureBounds: unexpectedMeasurement });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 50, y: 50 });
        const refresh = f.runtime.refreshMeasurements();
        finishMeasurement();
        await refresh;
        expect(f.runtime.getSnapshot().phase).toBe('carrying');
        expect(f.runtime.getSnapshot().targetId).toBeNull();
        expect(f.effects).toEqual([]);
        const oldRefresh = f.runtime.refreshMeasurements();
        carry.cancel();
        const keyboard = f.runtime.begin('source', 'keyboard')!;
        keyboard.choose('target');
        const snapshot = f.runtime.getSnapshot();
        finishMeasurement();
        await oldRefresh;
        await f.runtime.refreshMeasurements();
        expect(f.runtime.getSnapshot()).toBe(snapshot);
        expect(f.effects).toEqual([]);
    });
    it('retains refused settlement feedback after its ephemeral source retires, then clears it on cancel', async () => {
        const f = fixture();
        let finish = (_outcome: EntityDropOutcomeV1) => {};
        let sourceBounds: { x: number; y: number; width: number; height: number } | null = null;
        const retire = f.runtime.registerSource({ id: 'source', scope, getItem: () => session, isCurrent: () => true,
            describe: () => ({ title: 'Child', subtitle: 'Project' }), getBounds: () => sourceBounds });
        f.runtime.registerTarget({ ...f.target, execute: async () => new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; }) });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 50, y: 50 });
        const release = carry.release();
        expect(f.runtime.getSnapshot().phase).toBe('pending');
        sourceBounds = { x: 10, y: 20, width: 300, height: 40 };
        const outcome: EntityDropOutcomeV1 = { status: 'refused', reason: { code: 'reports_to_forbidden', message: 'Cannot take reports' } };
        finish(outcome);
        expect(await release).toEqual(outcome);
        retire();
        expect(f.runtime.getSnapshot()).toMatchObject({ phase: 'settled', sourceId: 'source', outcome });
        expect(f.runtime.describeSource('source')).toEqual({ title: 'Child', subtitle: 'Project' });
        expect(f.runtime.getSourceBounds('source')).toEqual(sourceBounds);
        expect(f.runtime.getPointer()).toEqual({ x: 50, y: 50 });
        expect(await carry.release()).toBeNull();
        f.runtime.cancel('feedback-finished');
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        expect(f.runtime.describeSource('source')).toBeNull();
        expect(f.runtime.getSourceBounds('source')).toBeNull();
        expect(f.runtime.getPointer()).toBeNull();
    });

    it('refreshes idle semantic destinations when mounted sources or targets change without replacing the carry snapshot', () => {
        const f = fixture();
        const snapshot = f.runtime.getSnapshot();
        let destinations = f.runtime.getDestinations('source');
        const unsubscribe = f.runtime.subscribe(() => { destinations = f.runtime.getDestinations('source'); });
        f.retireTarget();
        expect(destinations).toEqual([]);
        const retire = f.runtime.registerTarget(f.target);
        expect(destinations).toHaveLength(1);
        f.retireSource();
        expect(destinations).toEqual([]);
        expect(f.runtime.getSnapshot()).toBe(snapshot);
        expect(f.effects).toEqual([]);
        retire(); unsubscribe();
    });
    it('measures native and hosted targets at final release, preserving cancellation before dispatch', async () => {
        const f = fixture();
        let finishMeasurement = () => {};
        const measuredTarget = { ...f.target, measureBounds: () => new Promise<void>(resolve => {
            finishMeasurement = () => { f.setBounds({ x: 200, y: 0, width: 100, height: 100 }); resolve(); };
        }) };
        f.runtime.registerTarget(measuredTarget);
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 50, y: 50 });
        const release = carry.release();
        expect(f.effects).toEqual([]);
        finishMeasurement();
        expect(await release).toBeNull();
        expect(f.effects).toEqual([]);

        f.setBounds({ x: 0, y: 0, width: 100, height: 100 });
        const canceled = f.runtime.begin('source')!;
        canceled.move({ x: 50, y: 50 });
        const canceledRelease = canceled.release();
        canceled.cancel('source-retired');
        finishMeasurement();
        expect(await canceledRelease).toBeNull();
        expect(f.effects).toEqual([]);
    });
    it('joins concurrent release while measuring and refuses failed geometry without dispatch', async () => {
        const f = fixture();
        let finishMeasurement = () => {};
        f.runtime.registerTarget({ ...f.target, measureBounds: () => new Promise<void>(resolve => { finishMeasurement = resolve; }) });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 50, y: 50 });
        const first = carry.release();
        const second = carry.release();
        finishMeasurement();
        expect(await first).toEqual({ status: 'applied' });
        expect(await second).toEqual({ status: 'applied' });
        expect(f.effects).toHaveLength(1);
        f.runtime.registerTarget({ ...f.target, measureBounds: async () => { throw new Error('Native view retired'); } });
        const failed = f.runtime.begin('source')!;
        failed.move({ x: 50, y: 50 });
        expect(await failed.release()).toMatchObject({ status: 'refused', reason: { code: 'target-geometry-unavailable' } });
        expect(f.effects).toHaveLength(1);
    });
    it('keeps a declared Session binding above a nested reference target without losing pointer feedback', async () => {
        const f = fixture();
        const binding = { ...f.target, id: 'binding', captureKinds: ['session'] as const, resolve: () => refusal };
        f.runtime.registerTarget(binding);
        f.runtime.registerTarget({ ...f.target, id: 'composer', parentId: 'binding',
            getBounds: () => ({ x: 25, y: 25, width: 50, height: 50 }) });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 50, y: 50 });
        expect(f.runtime.getSnapshot().targetId).toBe('binding');
        expect(f.runtime.getPointer()).toEqual({ x: 50, y: 50 });
        expect(await carry.release()).toEqual({ status: 'refused', reason: refusal.reason });
        expect(f.effects).toEqual([]);
        f.runtime.registerTarget({ ...f.target, id: 'outside', getBounds: () => ({ x: 200, y: 0, width: 100, height: 100 }) });
        const next = f.runtime.begin('source')!;
        next.move({ x: 50, y: 50 });
        next.move({ x: 250, y: 50 });
        expect(f.runtime.getSnapshot().targetId).toBe('outside');
        expect(await next.release()).toEqual({ status: 'applied' });
        expect(f.effects).toHaveLength(1);
    });
    it('reads source descriptions live and hides unavailable or retired source identity', () => {
        const runtime = createEntityDragDropRuntime();
        let title = 'Child';
        let current = true;
        const retire = runtime.registerSource({ id: 'source', scope, getItem: () => session,
            isCurrent: () => current, describe: () => ({ title, subtitle: 'Project' }) });
        expect(runtime.describeSource('source')).toEqual({ title: 'Child', subtitle: 'Project' });
        runtime.begin('source');
        title = 'Renamed';
        expect(runtime.describeSource('source')?.title).toBe('Renamed');
        current = false;
        expect(runtime.describeSource('source')).toBeNull();
        current = true;
        retire();
        expect(runtime.describeSource('source')).toBeNull();
        runtime.registerSource({ id: 'source', scope, getItem: () => session, isCurrent: () => true });
        expect(runtime.describeSource('source')).toBeNull();
    });

    it('enumerates semantic destinations without mounted row geometry and revalidates at execution', async () => {
        const f = fixture();
        let available = true;
        let destinations = [{ destination: { leadId: 'lead' }, label: 'Lead', group: 'Sessions' },
            { destination: { leadId: 'blocked' }, label: 'Blocked', group: 'Sessions' }];
        f.runtime.registerTarget({ ...f.target, getBounds: () => null,
            listDestinations: item => item.kind === 'session' && item.address.sessionId === 'child' ? destinations : [],
            resolve: ({ destination }) => available && destination !== null && typeof destination === 'object'
                && !Array.isArray(destination) && 'leadId' in destination && destination.leadId === 'lead' ? allowed : refusal });
        expect(f.runtime.getDestinations('source')).toEqual([
            { targetId: 'target', ...destinations[0], admission: allowed },
            { targetId: 'target', ...destinations[1], admission: refusal },
        ]);
        expect(f.effects).toEqual([]);
        const carry = f.runtime.begin('source', 'keyboard')!;
        carry.choose('target', destinations[0].destination);
        expect(f.runtime.getSnapshot().admission).toEqual(allowed);
        available = false;
        expect(await carry.release()).toEqual({ status: 'refused', reason: refusal.reason });
        expect(f.effects).toEqual([]);
        available = true;
        expect(await f.runtime.perform('source', 'target', destinations[0].destination)).toEqual({ status: 'applied' });
        expect(f.effects).toHaveLength(1);
        destinations = [];
        expect(f.runtime.getDestinations('source')).toEqual([]);
        f.runtime.registerTarget({ ...f.target, id: 'foreign', scope: { ...scope, accountId: 'other' },
            listDestinations: () => { throw new Error('A foreign realm must not enumerate these rows'); } });
        expect(f.runtime.getDestinations('source')).toMatchObject([
            { targetId: 'foreign', admission: { status: 'refused', reason: { code: 'scope-mismatch' } } },
        ]);
    });

    it('realm cancellation retires uncommitted input, preserves dispatched outcomes and removes its listeners', async () => {
        const f = fixture();
        const events = new EventTarget();
        const uninstall = installEntityDragCancellation(f.runtime, events);
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 25, y: 25 });
        events.dispatchEvent(new Event('blur'));
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        await carry.release();
        expect(f.effects).toEqual([]);
        const next = f.runtime.begin('source')!;
        next.move({ x: 25, y: 25 });
        events.dispatchEvent(Object.assign(new Event('keydown'), { key: 'a' }));
        expect(f.runtime.getSnapshot().phase).toBe('carrying');
        events.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
        await next.release();
        expect(f.effects).toEqual([]);
        uninstall();
        const third = f.runtime.begin('source')!;
        third.move({ x: 25, y: 25 });
        events.dispatchEvent(new Event('blur'));
        expect(await third.release()).toEqual({ status: 'applied' });
    });
    it('the native adapter commits successful end once and never commits unsuccessful end or finalize', async () => {
        const f = fixture();
        const failed = createEntityDragGestureAdapter(f.runtime.begin('source')!);
        failed.update({ x: 25, y: 25 });
        await failed.end(false);
        failed.finalize();
        expect(f.effects).toEqual([]);
        const finalized = createEntityDragGestureAdapter(f.runtime.begin('source')!);
        finalized.update({ x: 25, y: 25 });
        finalized.finalize();
        await finalized.end(true);
        expect(f.effects).toEqual([]);
        const successful = createEntityDragGestureAdapter(f.runtime.begin('source')!);
        await successful.end(true, { x: 25, y: 25 });
        successful.finalize();
        await successful.end(true);
        expect(f.effects).toHaveLength(1);
    });
    it('keeps the final measured pointer when successful gesture end has no newer coordinates', async () => {
        const f = fixture();
        const gesture = createEntityDragGestureAdapter(f.runtime.begin('source')!);
        gesture.update({ x: 25, y: 25 });
        expect(await gesture.end(true, null)).toEqual({ status: 'applied' });
        expect(f.effects).toHaveLength(1);
    });
    it('stages without effects, revalidates the current verdict and bounds on successful release', async () => {
        const f = fixture();
        const carry = f.runtime.begin('source');
        expect(carry).not.toBeNull();
        carry!.move({ x: 50, y: 50 });
        expect(f.runtime.getSnapshot().admission).toEqual(allowed);
        expect(f.effects).toEqual([]);
        f.setVerdict(refusal);
        expect(await carry!.release()).toEqual({ status: 'refused', reason: refusal.reason });
        expect(f.effects).toEqual([]);
        const next = f.runtime.begin('source')!;
        next.move({ x: 50, y: 50 });
        f.setVerdict(allowed);
        f.setBounds({ x: 200, y: 0, width: 100, height: 100 });
        expect(await next.release()).toBeNull();
        expect(f.effects).toEqual([]);
    });

    it('canceled, retired and stale callbacks cannot write or cancel a subsequent carry', async () => {
        const f = fixture();
        const first = f.runtime.begin('source')!;
        first.move({ x: 50, y: 50 });
        first.cancel('escape');
        const second = f.runtime.begin('source')!;
        second.move({ x: 50, y: 50 });
        first.cancel();
        expect(await first.release()).toBeNull();
        expect(f.runtime.getSnapshot().phase).toBe('carrying');
        f.retireTarget();
        expect(f.runtime.getSnapshot().targetId).toBeNull();
        expect(await second.release()).toBeNull();
        expect(f.effects).toEqual([]);
        f.runtime.registerTarget(f.target);
        const third = f.runtime.begin('source')!;
        third.move({ x: 50, y: 50 });
        f.retireSource();
        expect(f.runtime.getSnapshot().item).toBeNull();
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        expect(await third.release()).toBeNull();
        expect(f.effects).toEqual([]);
    });

    it('a refused inner accepted target owns the drop; other-kind children yield to the parent', async () => {
        const f = fixture();
        const retire = f.runtime.registerTarget({ ...f.target, id: 'inner', parentId: 'target', getBounds: () => ({ x: 20, y: 20, width: 20, height: 20 }), resolve: () => refusal });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 25, y: 25 });
        expect(f.runtime.getSnapshot().targetId).toBe('inner');
        expect(await carry.release()).toEqual({ status: 'refused', reason: refusal.reason });
        expect(f.effects).toEqual([]);
        retire();
        f.runtime.registerTarget({ ...f.target, id: 'files', parentId: 'target', acceptedKinds: ['repository-file'] });
        const second = f.runtime.begin('source')!;
        second.move({ x: 25, y: 25 });
        expect(await second.release()).toEqual({ status: 'applied' });
        expect(f.effects).toHaveLength(1);
    });

    it('same-id references in another Home or Account refuse without invoking the domain writer', async () => {
        const f = fixture();
        f.setItem({ ...session, scope: { ...scope, accountId: 'other' } });
        expect(f.runtime.begin('source')).toBeNull();
        f.setItem(session);
        f.runtime.registerTarget({ ...f.target, id: 'foreign', scope: { ...scope, serverId: 'home-b' }, getBounds: () => ({ x: 20, y: 20, width: 20, height: 20 }) });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 25, y: 25 });
        expect(f.runtime.getSnapshot().admission?.status).toBe('refused');
        await carry.release();
        expect(f.effects).toEqual([]);
    });

    it('pointer frames do not notify semantic subscribers or scroll a refused target', () => {
        const f = fixture();
        let feedbackUpdates = 0;
        let pointerUpdates = 0;
        const scrolled: number[] = [];
        f.runtime.registerTarget({ ...f.target, autoscroll: pointer => scrolled.push(pointer.y) });
        f.runtime.subscribe(() => { feedbackUpdates += 1; });
        f.runtime.subscribePointer(() => { pointerUpdates += 1; });
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 40, y: 40 });
        const afterSelection = feedbackUpdates;
        carry.move({ x: 41, y: 41 });
        expect(feedbackUpdates).toBe(afterSelection);
        expect(pointerUpdates).toBe(2);
        f.runtime.autoscroll();
        expect(scrolled).toEqual([41]);
        f.setVerdict(refusal);
        f.runtime.refresh();
        f.runtime.autoscroll();
        expect(scrolled).toEqual([41]);
    });

    it('keyboard and chooser use the same resolver, and dispatch outcome cannot be rewritten as cancellation', async () => {
        const f = fixture();
        let finish: (outcome: EntityDropOutcomeV1) => void = () => {};
        const pending = new Promise<EntityDropOutcomeV1>(resolve => { finish = resolve; });
        f.runtime.registerTarget({ ...f.target, execute: async effect => { f.effects.push(effect.input); return pending; } });
        const carry = f.runtime.begin('source', 'keyboard')!;
        carry.choose('target', { position: 'middle' });
        const dispatched = carry.release();
        expect(f.runtime.getSnapshot().phase).toBe('pending');
        carry.cancel();
        f.retireSource();
        expect(f.runtime.getSnapshot().item).toBeNull();
        expect(f.runtime.getSnapshot().phase).toBe('pending');
        expect(await carry.release()).toBeNull();
        const unknown = { status: 'unknown', reason: { code: 'disconnected', message: 'Check the relation owner' } } as const;
        finish(unknown);
        expect(await dispatched).toEqual(unknown);
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        expect(f.runtime.getSnapshot().outcome).toBeNull();
        expect(f.effects).toHaveLength(1);
    });

    it('retiring a settled source clears its scoped feedback', async () => {
        const f = fixture();
        const carry = f.runtime.begin('source')!;
        carry.move({ x: 25, y: 25 });
        await carry.release();
        f.retireSource();
        expect(f.runtime.getSnapshot().phase).toBe('idle');
        expect(f.runtime.getSnapshot().item).toBeNull();
    });
});
