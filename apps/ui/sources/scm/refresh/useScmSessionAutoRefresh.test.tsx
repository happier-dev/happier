import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { storage } from '@/sync/domains/state/storage';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const appStateEmitter = vi.hoisted(async () => {
    const { createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeAppStateEmitter('active');
});
const machineRpc = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return 'web'; } },
        AppState: (await appStateEmitter).appState,
    });
});

// The Machine RPC transport is external; the status sync owner, repository service and store stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRpc);
});

const snapshotRequests = () => machineRpc.mock.calls
    .map(([request]) => request)
    .filter((request) => request?.method === RPC_METHODS.SCM_STATUS_SNAPSHOT);

// The status sync is a module singleton, so each scenario refreshes its own Session and repository.
function seedRepository(sessionId: string, serverId?: string) {
    const machine = createMachineFixture({ id: `${sessionId}-machine` });
    const base = createSessionFixture();
    const session = createSessionFixture({ id: sessionId, metadata: { ...base.metadata!, machineId: machine.id, path: `/${sessionId}` } });
    storage.setState({
        machines: { [machine.id]: machine },
        sessions: { [session.id]: session },
        ...(serverId ? {
            machineListByServerId: { [serverId]: [machine] },
            sessionListRowsByServerId: { [serverId]: { [session.id]: session } },
        } : {}),
    });
    machineRpc.mockResolvedValue({
        success: true,
        snapshot: {
            projectKey: `${machine.id}:/${sessionId}`, fetchedAt: 1,
            repo: { isRepo: true, rootPath: `/${sessionId}` },
            branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
            stashCount: 0, hasConflicts: false, entries: [],
            totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
            capabilities: EMPTY_SCM_CAPABILITIES,
        },
    });
}

describe('useScmSessionAutoRefresh', () => {
    const globalWithDocument = globalThis as unknown as {
        document?: { visibilityState?: string };
    };
    const originalDocument = globalWithDocument.document;
    const initialState = storage.getState();
    const mounted: Array<readonly [string, string | undefined]> = [];

    beforeEach(async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS', '0');
        vi.useFakeTimers();
        (await appStateEmitter).emit('active');
        globalWithDocument.document = { visibilityState: 'visible' };
    });

    afterEach(() => {
        standardCleanup();
        for (const [sessionId, serverId] of mounted.splice(0)) scmStatusSync.stop(sessionId, serverId);
        vi.useRealTimers();
        globalWithDocument.document = originalDocument;
        storage.setState(initialState, true);
        machineRpc.mockReset();
        vi.unstubAllEnvs();
    });

    async function mountAutoRefresh(sessionId: string, serverId?: string) {
        seedRepository(sessionId, serverId);
        mounted.push([sessionId, serverId]);
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        await renderHook(() => useScmSessionAutoRefresh({ sessionId, ...(serverId ? { serverId } : {}), intervalMs: 300_000 }));
        await vi.advanceTimersByTimeAsync(0);
    }

    it('activates visible demand after its Home Machine hydrates and observes later external edits without remounting', async () => {
        const sessionId = 'hydrating-session';
        const serverId = 'hydrating-home';
        seedRepository(sessionId, serverId);
        const machine = storage.getState().machines[`${sessionId}-machine`]!;
        const session = createSessionFixture({ id: sessionId, serverId, active: false,
            metadata: { path: `/${sessionId}`, host: machine.metadata!.host } });
        storage.setState({
            sessions: { [sessionId]: session },
            sessionListRowsByServerId: { [serverId]: { [sessionId]: session } },
            machines: {},
            machineListByServerId: {},
            machineListStatusByServerId: { [serverId]: 'loading' },
        });
        mounted.push([sessionId, serverId]);
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        await renderHook(() => useScmSessionAutoRefresh({ sessionId, serverId, intervalMs: 300_000 }));
        await vi.advanceTimersByTimeAsync(600_000);
        expect(snapshotRequests()).toHaveLength(0);

        await act(async () => {
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
                machineListStatusByServerId: { [serverId]: 'idle' } });
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(1);
        const snapshot = storage.getState().getSessionProjectScmSnapshot(sessionId, serverId);
        expect(snapshot?.branch.head).toBe('main');
        expect(storage.getState().sessions[sessionId]).toBe(session);

        machineRpc.mockResolvedValue({ success: true, snapshot: { ...snapshot!, branch: { ...snapshot!.branch, head: 'external-edit' } } });
        await vi.advanceTimersByTimeAsync(300_000);
        expect(snapshotRequests()).toHaveLength(2);
        expect(storage.getState().getSessionProjectScmSnapshot(sessionId, serverId)?.branch.head).toBe('external-edit');
    });

    it('shares one fallback request stream when another visible consumer arrives between polls', async () => {
        await mountAutoRefresh('cadence-session');
        expect(snapshotRequests()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(45_000);
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'cadence-session', intervalMs: 300_000 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(255_000);
        expect(snapshotRequests()).toHaveLength(2);
    });

    it('shares a Machine repository across Sessions in nested directories and keeps both consumers fresh', async () => {
        await mountAutoRefresh('root-session', 'home-b');
        const root = storage.getState().sessions['root-session']!;
        const sibling = createSessionFixture({ id: 'nested-session', metadata: { ...root.metadata!, path: '/root-session/nested' } });
        storage.setState({ sessions: { ...storage.getState().sessions, [sibling.id]: sibling },
            sessionListRowsByServerId: { 'home-b': { 'root-session': root, [sibling.id]: sibling } } });
        mounted.push([sibling.id, 'home-b']);
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        await renderHook(() => useScmSessionAutoRefresh({ sessionId: sibling.id, serverId: 'home-b', intervalMs: 300_000 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(1);
        expect(storage.getState().getSessionProjectScmSnapshot(sibling.id, 'home-b')?.repo.rootPath).toBe('/root-session');
        const snapshot = storage.getState().getSessionProjectScmSnapshot('root-session', 'home-b')!;
        machineRpc.mockResolvedValue({ success: true, snapshot: { ...snapshot, branch: { ...snapshot.branch, head: 'external-edit' } } });
        await vi.advanceTimersByTimeAsync(300_000);
        expect(snapshotRequests()).toHaveLength(2);
        expect(storage.getState().getSessionProjectScmSnapshot(sibling.id, 'home-b')?.branch.head).toBe('external-edit');
        expect(storage.getState().getSessionProjectScmSnapshot('root-session', 'home-b')?.branch.head).toBe('external-edit');
    });

    it('backs off unchanged status once for all consumers, resets for external edits, and releases faster demand', async () => {
        await mountAutoRefresh('adaptive-session', 'home-b');
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        const fast = await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'adaptive-session', serverId: 'home-b',
            intervalMs: 10_000, stepIntervalMs: 10_000, maxIntervalMs: 60_000 }));
        await vi.advanceTimersByTimeAsync(10_000);
        expect(snapshotRequests()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(19_999);
        expect(snapshotRequests()).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(snapshotRequests()).toHaveLength(3);
        const snapshot = storage.getState().getSessionProjectScmSnapshot('adaptive-session', 'home-b')!;
        machineRpc.mockResolvedValue({ success: true, snapshot: { ...snapshot, branch: { ...snapshot.branch, head: 'external-edit' } } });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(snapshotRequests()).toHaveLength(4);
        expect(storage.getState().getSessionProjectScmSnapshot('adaptive-session', 'home-b')?.branch.head).toBe('external-edit');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(snapshotRequests()).toHaveLength(5);
        await fast.unmount();
        await vi.advanceTimersByTimeAsync(299_999);
        expect(snapshotRequests()).toHaveLength(5);
        await vi.advanceTimersByTimeAsync(1);
        expect(snapshotRequests()).toHaveLength(6);
    });

    it('acquires the initial snapshot with automatic polling disabled and leaves explicit refresh available', async () => {
        seedRepository('manual-session');
        mounted.push(['manual-session', undefined]);
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'manual-session', intervalMs: 0 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(snapshotRequests()).toHaveLength(1);
        await scmStatusSync.invalidateFromUserAndAwait('manual-session');
        expect(snapshotRequests()).toHaveLength(2);
    });

    it('applies the existing repository work interval to shared polling demand', async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SCM_AUTO_REFRESH_PROJECT_MIN_INTERVAL_MS', '30000');
        seedRepository('budget-session');
        mounted.push(['budget-session', undefined]);
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'budget-session', intervalMs: 10_000 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(snapshotRequests()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(snapshotRequests()).toHaveLength(2);
    });

    it('parks a mounted hidden surface for ten virtual minutes and reads once when presented', async () => {
        seedRepository('hidden-session');
        mounted.push(['hidden-session', undefined]);
        let visible = false;
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
            PluginSurfaceFocusEligibilityProvider, { active: visible, children },
        );
        const { useScmSessionAutoRefresh } = await import('./useScmSessionAutoRefresh');
        const hook = await renderHook(() => useScmSessionAutoRefresh({ sessionId: 'hidden-session', intervalMs: 300_000 }), { wrapper });
        await vi.advanceTimersByTimeAsync(600_000);
        expect(snapshotRequests()).toHaveLength(0);
        visible = true;
        await hook.rerender();
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(1);
        visible = false;
        await hook.rerender();
        await vi.advanceTimersByTimeAsync(600_000);
        expect(snapshotRequests()).toHaveLength(1);
    });

    it('does not read an unfocused document, then catches up when focus returns', async () => {
        const document = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused });
        const window = new EventTarget();
        const oldWindow = globalThis.window;
        let focused = false;
        globalWithDocument.document = document;
        Object.assign(globalThis, { window });
        try {
            await mountAutoRefresh('unfocused-session');
            await vi.advanceTimersByTimeAsync(600_000);
            expect(snapshotRequests()).toHaveLength(0);
            focused = true;
            window.dispatchEvent(new Event('focus'));
            await vi.advanceTimersByTimeAsync(0);
            expect(snapshotRequests()).toHaveLength(1);
            focused = false;
            window.dispatchEvent(new Event('blur'));
            await vi.advanceTimersByTimeAsync(600_000);
            expect(snapshotRequests()).toHaveLength(1);
        } finally { Object.assign(globalThis, { window: oldWindow }); }
    });

    it('keeps an unchanged exact-Home snapshot identity, then publishes a real pushed branch change', async () => {
        await mountAutoRefresh('unchanged-session', 'home-b');
        const snapshot = storage.getState().getSessionProjectScmSnapshot('unchanged-session', 'home-b');
        expect(snapshot?.branch.head).toBe('main');
        const { useSessionProjectScmSnapshot } = await import('@/sync/domains/state/storage');
        let renders = 0;
        const observer = await renderHook(() => { renders++; return useSessionProjectScmSnapshot('unchanged-session', 'home-b'); });
        const settledRenders = renders;
        // Observe the public store publication cost without replacing its implementation.
        const publications = vi.spyOn(storage.getState(), 'publishSessionProjectScmSnapshots');
        try {
            await vi.advanceTimersByTimeAsync(600_000);
            expect(publications).toHaveBeenCalledTimes(0);
            expect(renders).toBe(settledRenders);
            expect(storage.getState().getSessionProjectScmSnapshot('unchanged-session', 'home-b')).toBe(snapshot);
            machineRpc.mockResolvedValue({ success: true, snapshot: { ...snapshot!, branch: { ...snapshot!.branch, head: 'release' } } });
            const reads = snapshotRequests().length;
            await act(async () => { await scmStatusSync.invalidateFromMutationAndAwait('unchanged-session', 'home-b'); });
            expect(snapshotRequests()).toHaveLength(reads + 1);
            expect(storage.getState().getSessionProjectScmSnapshot('unchanged-session', 'home-b')?.branch.head).toBe('release');
            expect(observer.getCurrent()?.branch.head).toBe('release');
            expect(renders).toBe(settledRenders + 1);
            expect(publications).toHaveBeenCalledTimes(1);
        } finally { publications.mockRestore(); await observer.unmount(); }
    });

    it('keeps every refresh qualified to the mounted Home', async () => {
        await mountAutoRefresh('home-session', 'home-b');
        await vi.advanceTimersByTimeAsync(300_000);

        expect(snapshotRequests()).toEqual([
            expect.objectContaining({ machineId: 'home-session-machine', serverId: 'home-b' }),
            expect.objectContaining({ machineId: 'home-session-machine', serverId: 'home-b' }),
        ]);
    });

    it('catches up once when the app returns to the foreground overdue', async () => {
        await mountAutoRefresh('catch-up-session');
        expect(snapshotRequests()).toHaveLength(1);

        (await appStateEmitter).emit('background');
        await vi.advanceTimersByTimeAsync(300_000 * 3);
        expect(snapshotRequests()).toHaveLength(1);

        (await appStateEmitter).emit('active');
        await vi.advanceTimersByTimeAsync(0);
        expect(snapshotRequests()).toHaveLength(2);
    });
});
