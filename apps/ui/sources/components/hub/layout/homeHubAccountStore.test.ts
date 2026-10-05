import { describe, expect, it } from 'vitest';
import { createHomeHubAccountStore } from './homeHubAccountStore';
import { HOME_HUB_DEFAULT_LAYOUT, createHomeHubArtifactPortV1, type HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';

function fixture() {
    // The persisted Artifact transport is the system boundary; real semantic admission runs below it.
    const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
    const transport: HomeHubArtifactTransportV1 = { ...boundary.transport, read: async (...args) => {
        const row = await boundary.transport.read(...args);
        return row ? { ...row, ownerAccountId: 'one' } : null;
    } };
    return { boundary, transport, owner: createHomeHubArtifactPortV1(transport, { accountId: 'one' }) };
}

describe('mounted Home Account Artifact projection', () => {
    it('rejects a failed semantic move while preserving its retry, then acknowledges the current Artifact order', async () => {
        const { boundary, transport, owner } = fixture();
        await owner.apply({ kind: 'visibility', sectionId: 'setup', hidden: true });
        const initial = await owner.read();
        let insertAtCommit = false;
        const moving = createHomeHubArtifactPortV1({ ...transport, update: async update => {
            if (insertAtCommit) {
                insertAtCommit = false;
                // A second client's commit makes this move's first CAS stale.
                await owner.apply({ kind: 'widget_add', instance: { v: 1, id: 'inserted', definition: { kind: 'installed', surface: { pluginId: 'acme.checks', localId: 'summary' } }, bindings: {} } });
            }
            return transport.update(update);
        } }, { accountId: 'one' });
        const store = createHomeHubAccountStore({ accountId: 'one', transport, isCurrent: () => true, execute: async intent => (await moving.apply(intent)).layout });
        await store.refresh();
        const intent = { kind: 'move_to' as const, sectionId: 'setup', position: { anchorId: 'start', placement: 'before' as const } };
        boundary.offline(true);
        // Both ordinary callbacks and checked drag moves use the same admission/save queue.
        await expect(store.dispatch(intent, { rethrow: true })).rejects.toThrow('offline');
        expect(store.getSnapshot()).toMatchObject({ layout: initial, status: 'error', failedIntent: intent });
        boundary.offline(false);
        await store.refresh();
        expect(store.getSnapshot()).toMatchObject({ layout: initial, status: 'error', failedIntent: intent });
        insertAtCommit = true;
        await store.retry();
        const acknowledged = store.getSnapshot();
        expect(acknowledged.status).toBe('ready');
        expect(acknowledged.failedIntent).toBeUndefined();
        expect(acknowledged.layout.order).toContain('inserted');
        expect(acknowledged.layout.order.indexOf('setup')).toBeLessThan(acknowledged.layout.order.indexOf('start'));
        expect(await owner.read()).toEqual(acknowledged.layout);
    });
    it('keeps a failed edit visible across invalidation and retries the same semantic intent', async () => {
        const { transport, owner } = fixture();
        let fail = true;
        const store = createHomeHubAccountStore({ accountId: 'one', transport, isCurrent: () => true, execute: async intent => {
            if (fail) throw Object.assign(new Error('server unavailable'), { code: 'server_unreachable' });
            return (await owner.apply(intent)).layout;
        } });
        await store.refresh();
        const intent = { kind: 'setup_visibility' as const, stepId: 'addPhone', hidden: true };
        await store.dispatch(intent);
        expect(store.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'server_unreachable', failedIntent: intent, layout: HOME_HUB_DEFAULT_LAYOUT });
        await store.refresh();
        expect(store.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'server_unreachable', failedIntent: intent });
        fail = false;
        await store.retry();
        expect(store.getSnapshot()).toMatchObject({ status: 'ready', layout: { hidden: expect.arrayContaining(['setup:addPhone']) } });
        expect(store.getSnapshot().failedIntent).toBeUndefined();
        expect(await owner.read()).toEqual(store.getSnapshot().layout);
    });

    it('does not let an older read overwrite an acknowledged edit or retain another Account projection', async () => {
        const { transport, owner } = fixture();
        let finish: (() => void) | undefined;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        let current = true;
        const store = createHomeHubAccountStore({ accountId: 'one', transport: { ...transport, read: async () => { await pending; return null; } }, isCurrent: () => current, execute: async intent => (await owner.apply(intent)).layout });
        const refresh = store.refresh();
        await store.dispatch({ kind: 'setup_visibility', stepId: 'addMachine', hidden: true });
        const acknowledged = store.getSnapshot();
        finish!(); await refresh;
        expect(store.getSnapshot()).toBe(acknowledged);
        current = false;
        await expect(store.dispatch({ kind: 'reset' }, { rethrow: true })).rejects.toMatchObject({ code: 'home_hub_scope_retired' });
        await store.dispatch({ kind: 'reset' });
        expect(await owner.read()).toEqual(acknowledged.layout);
        expect(store.getSnapshot()).toBe(acknowledged);
    });
});
