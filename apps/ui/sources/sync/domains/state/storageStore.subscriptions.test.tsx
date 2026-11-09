import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionMessagesFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import { storage } from './storageStore';
import { subscribeRegisteredStorageState } from './storageStateReaderBridge';
import { publishStoragePaths, subscribeStoragePaths } from './storageSubscriptions';
import * as storageSubscriptions from './storageSubscriptions';
import { useWorkspaceScmCommitSelectionPaths } from '@/sync/store/scmHooks';

const initial = storage.getState();
afterEach(() => {
    standardCleanup();
    storage.setState(initial, true);
});

const chunk = (text: string, updatedAtMs: number): NormalizedMessage => ({
    id: 'stream', localId: 'stream', createdAt: 1, role: 'agent', isSidechain: false,
    content: [{ type: 'text', text, uuid: 'stream', parentUUID: null }],
    meta: { happierStreamSegmentV1: { v: 1, segmentKind: 'assistant', segmentLocalId: 'stream',
        segmentState: 'streaming', startedAtMs: 1, updatedAtMs } },
});

describe('storage notification locality', () => {
    it('publishes tool and transcript lifecycle invalidation while leaving real text deltas quiet', () => {
        const state = storage.getState();
        storage.setState({ sessions: { tools: createSessionFixture({ id: 'tools', active: true }) } });
        const version = () => storage.getState().sessionMessageToolVersion;
        let previous = version();
        storage.getState().applyMessages('tools', [chunk('first text', 1)]);
        storage.getState().applyMessages('tools', [chunk('more text', 2)]);
        expect(version()).toBe(previous);

        const tool: NormalizedMessage = {
            id: 'tool-call', localId: null, createdAt: 3, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'request', name: 'Bash', input: { command: 'ls' },
                description: null, uuid: 'tool-call', parentUUID: null }],
        };
        storage.getState().applyMessages('tools', [tool]);
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.getState().applyMessages('tools', [{
            id: 'tool-result', localId: null, createdAt: 4, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-result', tool_use_id: 'request', content: 'done', is_error: false,
                uuid: 'tool-result', parentUUID: null, permissions: { date: 4, result: 'approved' } }],
        }]);
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.getState().replaceSessionMessages('tools', []);
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.getState().resetSessionMessages('tools');
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.getState().applyMessagesLoaded('tools');
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.getState().applyMessagesLoaded('tools');
        expect(version()).toBe(previous);
        storage.getState().evictSessionMessages('tools');
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.getState().applyMessagesLoaded('tools');
        expect(version()).toBeGreaterThan(previous);
        previous = version();
        storage.setState({ sessionMessages: state.sessionMessages });
        expect(version()).toBeGreaterThan(previous);
    });

    it('retains equivalent consumed scope across renders and moves subscriptions when the selected ID changes', async () => {
        storage.setState({ sessions: {
            first: createSessionFixture({ id: 'first', active: true }),
            second: createSessionFixture({ id: 'second', active: false }),
        } });
        let subscribed = 0;
        let unsubscribed = 0;
        let checks = 0;
        // Count real index registrations/disposals without replacing notification routing.
        const register = storageSubscriptions.subscribeStoragePaths;
        const census = vi.spyOn(storageSubscriptions, 'subscribeStoragePaths').mockImplementation((...args) => {
            subscribed++;
            const stop = register(...args);
            return () => { unsubscribed++; stop(); };
        });
        const hook = await renderHook(({ sessionId }) => storage(state => {
            checks++;
            return state.sessions[sessionId]?.active;
        }, { sessions: [sessionId] }), { initialProps: { sessionId: 'first' } });
        try {
            expect(hook.getCurrent()).toBe(true);
            const mounted = { subscribed, unsubscribed };
            for (let render = 0; render < 3; render++) await hook.rerender({ sessionId: 'first' });
            expect({ subscribed: subscribed - mounted.subscribed, unsubscribed: unsubscribed - mounted.unsubscribed })
                .toEqual({ subscribed: 0, unsubscribed: 0 });

            await hook.rerender({ sessionId: 'second' });
            expect(hook.getCurrent()).toBe(false);
            expect({ subscribed: subscribed - mounted.subscribed, unsubscribed: unsubscribed - mounted.unsubscribed })
                .toEqual({ subscribed: 1, unsubscribed: 1 });

            const selected = checks;
            await act(async () => { storage.setState({ sessions: {
                ...storage.getState().sessions, first: createSessionFixture({ id: 'first', active: false }),
            } }); });
            expect(checks).toBe(selected);
            await act(async () => { storage.setState({ sessions: {
                ...storage.getState().sessions, second: createSessionFixture({ id: 'second', active: true }),
            } }); });
            expect(hook.getCurrent()).toBe(true);
            expect(checks).toBeGreaterThan(selected);
        } finally {
            await hook.unmount();
            census.mockRestore();
        }
    });

    it('preserves registration order when one publication changes different subscribed keys', () => {
        const prefix = [Symbol('ordered-owner-publication')];
        const calls: number[] = [];
        const stops = [
            subscribeStoragePaths([[...prefix, 'first']], () => calls.push(1)),
            subscribeStoragePaths([[...prefix, 'second']], () => calls.push(2)),
            subscribeStoragePaths([[...prefix, 'first']], () => calls.push(3)),
        ];
        try {
            const state = storage.getState();
            publishStoragePaths(prefix, { first: 1, second: 1 }, { first: 0, second: 0 }, { kind: 'state', state, previous: state });
            expect(calls).toEqual([1, 2, 3]);
        } finally { stops.forEach(stop => stop()); }
    });

    it('honors declared inputs of an opaque query without broadcasting message changes', async () => {
        let external = 'before';
        let checks = 0;
        const hook = await renderHook(() => storage(() => { checks++; return external; }, { machines: true }));
        try {
            const before = checks;
            await act(async () => { storage.getState().applyMessagesLoaded('opaque-query-no-demand'); });
            expect(checks).toBe(before);
            external = 'after';
            await act(async () => { storage.setState({ machines: { ...storage.getState().machines } }); });
            expect(hook.getCurrent()).toBe('after');
        } finally { await hook.unmount(); }
    });

    it('tracks canonical getState reads made beneath a selector', async () => {
        storage.setState({ sessions: { indirect: createSessionFixture({ id: 'indirect', active: true }) } });
        const hook = await renderHook(() => storage(() => storage.getState().sessions.indirect?.active));
        try {
            expect(hook.getCurrent()).toBe(true);
            await act(async () => { storage.setState({ sessions: { indirect: createSessionFixture({ id: 'indirect', active: false }) } }); });
            expect(hook.getCurrent()).toBe(false);
        } finally { await hook.unmount(); }
    });

    it('keeps a replacement subscriber alive when an earlier disposal repeats', () => {
        const path = [Symbol('isolated-owner-lifetime')];
        const stopOld = subscribeStoragePaths([path], () => {});
        stopOld();
        const next = vi.fn();
        const stopNext = subscribeStoragePaths([path], next);
        try {
            stopOld();
            const state = storage.getState();
            publishStoragePaths(path, {}, undefined, { kind: 'state', state, previous: state });
            expect(next).toHaveBeenCalledTimes(1);
        } finally { stopNext(); }
    });

    it('tracks a selector changing its consumed domain without retaining the old demand', async () => {
        storage.setState({ settings: { ...storage.getState().settings, showLineNumbers: false } });
        let checks = 0;
        const hook = await renderHook(() => storage(state => {
            checks++;
            return state.settings.showLineNumbers ? state.machines : state.sessionListRowsByServerId;
        }, { settings: ['showLineNumbers'] }));
        try {
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings, showLineNumbers: true } }); });
            expect(hook.getCurrent()).toBe(storage.getState().machines);
            const before = checks;
            await act(async () => { storage.setState({ sessionListRowsByServerId: { ...storage.getState().sessionListRowsByServerId } }); });
            expect(checks).toBe(before);
            await act(async () => { storage.setState({ machines: { ...storage.getState().machines } }); });
            expect(checks).toBeGreaterThan(before);
            expect(hook.getCurrent()).toBe(storage.getState().machines);
        } finally { await hook.unmount(); }
    });

    it('keeps closure-backed queries and owner-published SCM selections fresh', async () => {
        storage.setState({ sessions: { 'query-session': createSessionFixture({ id: 'query-session', active: true }) } });
        const scope = { serverId: 'query-home', machineId: 'query-machine', rootPath: '/query-repo' };
        const active = await renderHook(() => storage(state => state.getActiveSessions().length));
        const scm = await renderHook(() => useWorkspaceScmCommitSelectionPaths(scope).join(','));
        try {
            expect(active.getCurrent()).toBe(1);
            await act(async () => {
                storage.setState({ sessions: { 'query-session': createSessionFixture({ id: 'query-session', active: false }) } });
                storage.getState().markWorkspaceScmCommitSelectionPaths(scope, ['changed.ts'], 1);
            });
            expect(active.getCurrent()).toBe(0);
            expect(scm.getCurrent()).toBe('changed.ts');
        } finally {
            await active.unmount(); await scm.unmount();
            storage.getState().clearWorkspaceScmCommitSelectionPaths(scope);
        }
    });

    it('runs only the publishing Session selectors for a real text-only message publication', async () => {
        storage.setState({ sessionMessages: Object.fromEntries(Array.from({ length: 1000 }, (_, index) =>
            [`session-${index}`, createSessionMessagesFixture({ isLoaded: true })])) });
        storage.getState().applyMessages('session-0', [chunk('start', 1)]);
        const checks = { unrelated: 0, otherSession: 0, publishingSession: 0 };
        const unrelated = await renderHook(() => Array.from({ length: 1000 }, () => storage(state => {
            checks.unrelated++;
            return state.machineDisplayById;
        })));
        const other = await renderHook(() => storage(state => {
            checks.otherSession++;
            return state.sessionMessages['session-999']?.messagesVersion;
        }, { sessionMessages: ['session-999'] }));
        const publishing = await renderHook(() => storage(state => {
            checks.publishingSession++;
            return state.sessionMessages['session-0']?.messagesVersion;
        }, { sessionMessages: ['session-0'] }));
        const before = { ...checks };
        const version = publishing.getCurrent();
        const changedKeys: string[][] = [];
        const stop = storage.subscribe((state, previous) => changedKeys.push(
            Object.keys(state).filter(key => !Object.is(Reflect.get(state, key), Reflect.get(previous, key))),
        ));
        try {
            await act(async () => { storage.getState().applyMessages('session-0', [chunk('next token', 2)]); });
            expect(changedKeys).toEqual([['sessionMessages']]);
            expect(checks.unrelated - before.unrelated).toBe(0);
            expect(checks.otherSession - before.otherSession).toBe(0);
            expect(checks.publishingSession).toBeGreaterThan(before.publishingSession);
            expect(publishing.getCurrent()).toBeGreaterThan(version!);
            expect(other.getCurrent()).toBe(0);
        } finally {
            stop();
            await unrelated.unmount(); await other.unmount(); await publishing.unmount();
        }
    });

    it('delivers replaced snapshot keys through the registered path and leaves unchanged keys quiet', () => {
        const messages = vi.fn();
        const machines = vi.fn();
        const stopMessages = subscribeRegisteredStorageState(messages, { sessionMessages: ['snapshot-session'] });
        const stopMachines = subscribeRegisteredStorageState(machines, { machines: true });
        try {
            const before = storage.getState();
            const transcript = createSessionMessagesFixture({ isLoaded: true, messagesVersion: 7 });
            storage.setState({ ...before, sessionMessages: { 'snapshot-session': transcript } }, true);
            expect(messages).toHaveBeenCalledTimes(1);
            expect(messages.mock.calls[0][0].sessionMessages['snapshot-session']).toBe(transcript);
            expect(machines).not.toHaveBeenCalled();
            const nextMachines = { ...before.machines };
            storage.setState({ ...storage.getState(), machines: nextMachines }, true);
            expect(machines).toHaveBeenCalledTimes(1);
            expect(machines.mock.calls[0][0].machines).toBe(nextMachines);
            expect(messages).toHaveBeenCalledTimes(1);
        } finally { stopMessages?.(); stopMachines?.(); }
    });

    it('keeps the tab, Machine, origin, row and Settings facts fresh without running their selectors for text', async () => {
        const counts = { tabs: 0, machines: 0, origins: 0, rows: 0, settings: 0 };
        const hook = await renderHook(() => ({
            tabs: storage(state => { counts.tabs++; return state.sessionListRowsByServerId; }),
            machines: storage(state => { counts.machines++; return state.machines; }),
            origins: storage(state => { counts.origins++; return state.profileScope; }),
            rows: storage(state => { counts.rows++; return state.sessionListIndexByServerId; }),
            settings: storage(state => { counts.settings++; return state.settings.showLineNumbers; }, { settings: ['showLineNumbers'] }),
        }));
        try {
            const before = { ...counts };
            await act(async () => { storage.getState().applyMessagesLoaded('freshness-session'); });
            expect(counts).toEqual(before);
            await act(async () => {
                const state = storage.getState();
                storage.setState({ ...state,
                    sessionListRowsByServerId: { ...state.sessionListRowsByServerId },
                    machines: { ...state.machines }, profileScope: { serverId: 'fresh-home', accountId: 'fresh-account' },
                    sessionListIndexByServerId: { ...state.sessionListIndexByServerId },
                    settings: { ...state.settings, showLineNumbers: !state.settings.showLineNumbers },
                }, true);
            });
            for (const key of Object.keys(counts) as (keyof typeof counts)[]) expect(counts[key]).toBeGreaterThan(before[key]);
            const selected = hook.getCurrent();
            expect(selected.tabs).toBe(storage.getState().sessionListRowsByServerId);
            expect(selected.machines).toBe(storage.getState().machines);
            expect(selected.origins).toBe(storage.getState().profileScope);
            expect(selected.rows).toBe(storage.getState().sessionListIndexByServerId);
            expect(selected.settings).toBe(storage.getState().settings.showLineNumbers);
        } finally { await hook.unmount(); }
    });
});
