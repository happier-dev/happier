import { describe, expect, it } from 'vitest';
import { createHomeHubAccountStore } from './homeHubAccountStore';
import { getHomeHubDefaultLayoutV1, createHomeHubArtifactPortV1, type HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';

function fixture() {
    // The persisted Artifact transport is the system boundary; real semantic admission runs below it.
    const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
    const transport: HomeHubArtifactTransportV1 = boundary.forAccount('one');
    return { boundary, transport, owner: createHomeHubArtifactPortV1(transport, { accountId: 'one' }) };
}

describe('mounted Home Account Artifact projection', () => {
    it('publishes a group title to a newly loaded client only after its Artifact acknowledgement', async () => {
        const { transport, owner } = fixture();
        await owner.apply({ kind: 'widget_add', instance: { v: 1, id: 'checks',
            definition: { kind: 'builtin', id: 'session_summary' }, bindings: {} } });
        await owner.apply({ kind: 'group_create', groupId: 'group', instanceIds: ['checks'] });
        let release!: () => void;
        let started!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const issued = new Promise<void>(resolve => { started = resolve; });
        const writer = createHomeHubArtifactPortV1({ ...transport, update: async update => {
            started(); await held; return transport.update(update);
        } }, { accountId: 'one' });
        const first = createHomeHubAccountStore({ accountId: 'one', transport, isCurrent: () => true,
            execute: async intent => (await writer.apply(intent)).layout });
        await first.refresh();
        const write = first.dispatch({ kind: 'rename', instanceId: 'group', displayName: 'Release room' }, { rethrow: true });
        try {
            await issued;
            expect(first.getSnapshot().isWriting).toBe(true);
            const before = (await owner.read()).items.find(item => item.kind === 'group' && item.id === 'group');
            expect(before).toMatchObject({ kind: 'group', id: 'group' });
            expect(before).not.toHaveProperty('title', 'Release room');
            release(); await write;
            const reloaded = createHomeHubAccountStore({ accountId: 'one', transport, isCurrent: () => true,
                execute: async intent => (await owner.apply(intent)).layout });
            await reloaded.refresh();
            expect(reloaded.getSnapshot().status).toBe('ready');
            expect(reloaded.getSnapshot().layout.items.find(item => item.kind === 'group' && item.id === 'group'))
                .toMatchObject({ kind: 'group', id: 'group', title: 'Release room' });
            expect(first.getSnapshot().layout).toEqual(reloaded.getSnapshot().layout);
        } finally { release(); await write; }
    });
    it('keeps write presentation pending across reads and neighboring queued writes until both database acknowledgements arrive', async () => {
        const { transport, owner } = fixture();
        await owner.apply({ kind: 'visibility', sectionId: 'setup', hidden: true });
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        let startedFirst!: () => void;
        let startedSecond!: () => void;
        const firstStarted = new Promise<void>(resolve => { startedFirst = resolve; });
        const secondStarted = new Promise<void>(resolve => { startedSecond = resolve; });
        const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
        const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
        let writes = 0;
        const heldTransport = { ...transport, update: async (input: Parameters<typeof transport.update>[0]) => {
            if (++writes === 1) { startedFirst(); await firstHeld; }
            else { startedSecond(); await secondHeld; }
            return transport.update(input);
        } };
        const writer = createHomeHubArtifactPortV1(heldTransport, { accountId: 'one' });
        const store = createHomeHubAccountStore({ accountId: 'one', transport: heldTransport, isCurrent: () => true,
            execute: async intent => (await writer.apply(intent)).layout });
        await store.refresh();
        const first = store.dispatch({ kind: 'setup_visibility', stepId: 'askHappier', hidden: true });
        const second = store.dispatch({ kind: 'setup_visibility', stepId: 'addPhone', hidden: true });
        try {
            await firstStarted;
            expect(store.getSnapshot().isWriting).toBe(true);
            await store.refresh();
            expect(store.getSnapshot().isWriting).toBe(true);
            releaseFirst(); await first; await secondStarted;
            expect(store.getSnapshot().isWriting).toBe(true);
            releaseSecond(); await second;
            expect(store.getSnapshot().isWriting).toBe(false);
            expect(store.getSnapshot()).toMatchObject({ status: 'ready', layout: { hidden: expect.arrayContaining(['setup:askHappier', 'setup:addPhone']) } });
            expect(store.getSnapshot().layout).toEqual(await owner.read());
        } finally { releaseFirst(); releaseSecond(); await Promise.all([first, second]); }
    });
    it('persists Ask Happier offer dismissal and restoration across clients', async () => {
        const { transport, owner } = fixture();
        const first = createHomeHubAccountStore({ accountId: 'one', transport, isCurrent: () => true, execute: async intent => (await owner.apply(intent)).layout });
        const second = createHomeHubAccountStore({ accountId: 'one', transport, isCurrent: () => true, execute: async intent => (await owner.apply(intent)).layout });
        await Promise.all([first.refresh(), second.refresh()]);
        await first.dispatch({ kind: 'setup_visibility', stepId: 'askHappier', hidden: true }, { rethrow: true });
        await second.refresh();
        expect(second.getSnapshot().layout.hidden).toContain('setup:askHappier');
        expect(await owner.read()).toEqual(second.getSnapshot().layout);
        // Dismissal is only the existing offer visibility intent, not a Bot/session deletion.
        await second.dispatch({ kind: 'setup_visibility', stepId: 'askHappier', hidden: false }, { rethrow: true });
        await first.refresh();
        expect(first.getSnapshot().layout.hidden).not.toContain('setup:askHappier');
    });
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
        expect(store.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'server_unreachable', failedIntent: intent, layout: getHomeHubDefaultLayoutV1() });
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
