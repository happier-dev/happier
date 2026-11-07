import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { storage } from '@/sync/domains/state/storage';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { useScmSessionAutoRefresh } from './useScmSessionAutoRefresh';
import { buildScmFileDiffSnapshotSignature } from '@/scm/diffCache/scmDiffCacheKey';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { getCachedWorkspaceRepositoryDirectoryEntries, setCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';

type Request = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: Request) => Promise<unknown>>());
// Only authenticated Machine transport is substituted; demand, invalidation, mapping and publication stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));

const scope = { serverId: 'watch-home', machineId: 'watch-machine', rootPath: '/watch-repo' };
const initial = ScmWorkingSnapshotSchema.parse({
    projectKey: 'watch-machine:/watch-repo', fetchedAt: 1,
    repo: { isRepo: true, rootPath: scope.rootPath, backendId: 'git', mode: '.git' },
    capabilities: createScmCapabilities({ readStatus: true }),
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0,
        includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
});

describe('presented workspace push through Session and Project demand', () => {
    const saved = storage.getState();
    let current = initial;
    let revision = 0;
    let change: ((reply: unknown) => void) | undefined;
    let observation: ((reply: unknown) => void) | undefined;
    let liveSubscriptions = 0;
    let peakSubscriptions = 0;
    let holdStatus: ((snapshot: typeof initial) => Promise<unknown>) | undefined;
    let watchMethodMissing = false;
    const statusReads = () => rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT).length;

    const advance = async (milliseconds: number) => {
        await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
    };

    beforeEach(() => {
        vi.useFakeTimers();
        current = initial;
        revision = 0;
        change = undefined;
        observation = undefined;
        liveSubscriptions = 0;
        peakSubscriptions = 0;
        holdStatus = undefined;
        watchMethodMissing = false;
        for (const rootPath of [scope.rootPath, `${scope.rootPath}/nested`]) {
            storage.getState().updateWorkspaceScmSnapshot({ ...scope, rootPath }, null);
            storage.getState().updateWorkspaceScmSnapshotError({ ...scope, rootPath }, null);
        }
        const machine = createMachineFixture({ id: scope.machineId, activeAt: Date.now(), presenceProtocolVersion: 1 });
        const session = createSessionFixture({ id: 'watch-session', serverId: scope.serverId,
            metadata: { ...createSessionFixture().metadata!, machineId: machine.id, path: scope.rootPath } });
        storage.setState({ machines: { [machine.id]: machine }, sessions: { [session.id]: session },
            machineListByServerId: { [scope.serverId]: [machine] },
            sessionListRowsByServerId: { [scope.serverId]: { [session.id]: session } } });
        rpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) {
                const captured = current;
                return holdStatus ? holdStatus(captured) : { success: true, snapshot: captured };
            }
            if (request.method !== 'scm.workspace.watch.v1') throw new Error(`Unexpected RPC ${request.method}`);
            if (watchMethodMissing) return { error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            const payload = request.payload as { observationOnly?: boolean; sinceRevision?: number };
            if (!payload.observationOnly && payload.sinceRevision === undefined) return { status: 'ready', revision };
            return new Promise(resolve => {
                if (payload.observationOnly) {
                    observation = resolve;
                    liveSubscriptions++;
                    peakSubscriptions = Math.max(peakSubscriptions, liveSubscriptions);
                } else change = resolve;
                request.signal?.addEventListener('abort', () => {
                    if (payload.observationOnly) liveSubscriptions--;
                    else if (change === resolve) change = undefined;
                    resolve({ status: 'cancelled' });
                }, { once: true });
            });
        });
    });

    afterEach(() => {
        standardCleanup();
        scmStatusSync.stop('watch-session', scope.serverId);
        vi.useRealTimers();
        storage.setState(saved, true);
        rpc.mockReset();
    });

    async function mount(presentedInitially = true) {
        let presented = presentedInitially;
        const wrapper = ({ children }: { children?: React.ReactNode }) => (
            <PluginSurfaceFocusEligibilityProvider active presentationActive={presented}>{children}</PluginSurfaceFocusEligibilityProvider>);
        const hook = await renderHook(() => {
            // Composer, Git and Review all acquire this same Session owner; Project acquires it too.
            useScmSessionAutoRefresh({ sessionId: 'watch-session', serverId: scope.serverId, intervalMs: 300_000 });
            useScmSessionAutoRefresh({ sessionId: 'watch-session', serverId: scope.serverId, intervalMs: 300_000 });
            useScmSessionAutoRefresh({ sessionId: 'watch-session', serverId: scope.serverId, intervalMs: 300_000 });
            return useWorkspaceScmSnapshotController(scope);
        }, { wrapper });
        await advance(0);
        return { hook, setPresented: async (next: boolean) => {
            presented = next;
            await hook.rerender();
            await advance(0);
        } };
    }

    it('shares one observation, publishes an external edit within one push without returning, and releases on hide', async () => {
        const { hook, setPresented } = await mount();
        expect(liveSubscriptions).toBe(1);
        expect(peakSubscriptions).toBe(1);
        const before = statusReads();
        current = { ...initial, branch: { ...initial.branch, head: 'external-edit' } };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(statusReads() - before).toBe(1);
        expect(hook.getCurrent().snapshot?.branch.head).toBe('external-edit');
        expect(storage.getState().getSessionProjectScmSnapshot('watch-session', scope.serverId)?.branch.head).toBe('external-edit');
        await setPresented(false);
        expect(liveSubscriptions).toBe(0);
        const hiddenReads = statusReads();
        await advance(600_000);
        expect(statusReads()).toBe(hiddenReads);
        await hook.unmount();
    });

    it('does not acquire observation or refresh a retained hidden Session or Project', async () => {
        const { hook } = await mount(false);
        await advance(600_000);
        expect(liveSubscriptions).toBe(0);
        expect(statusReads()).toBe(0);
        await hook.unmount();
    });

    it('refreshes the file-content revision for an external edit whose Git status and line counts stay equal', async () => {
        const { hook } = await mount();
        const before = hook.getCurrent().snapshot!;
        expect(before?.repo.isRepo).toBe(true);
        const contentRevision = buildScmFileDiffSnapshotSignature(before, null);
        current = { ...initial, fetchedAt: 2 };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        const after = hook.getCurrent().snapshot!;
        expect(after.fetchedAt).toBe(2);
        expect(buildScmFileDiffSnapshotSignature(after, null)).not.toBe(contentRevision);
        expect(storage.getState().getSessionProjectScmSnapshot('watch-session', scope.serverId)?.fetchedAt).toBe(2);
        await hook.unmount();
    });

    it.each([false, true])('preserves an in-flight content push with concurrent agent mutation=%s', async concurrentMutation => {
        const { hook } = await mount();
        const before = statusReads();
        let release: (() => void) | undefined;
        holdStatus = captured => {
            holdStatus = undefined;
            return new Promise(resolve => { release = () => resolve({ success: true, snapshot: captured }); });
        };
        current = { ...initial, fetchedAt: 2 };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(release).toBeTypeOf('function');
        current = { ...initial, fetchedAt: 3 };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
            if (concurrentMutation) scmStatusSync.invalidateFromMutation('watch-session', scope.serverId);
            release?.();
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(statusReads() - before).toBe(2);
        expect(hook.getCurrent().snapshot?.fetchedAt).toBe(3);
        expect(storage.getState().getSessionProjectScmSnapshot('watch-session', scope.serverId)?.fetchedAt).toBe(3);
        await hook.unmount();
    });

    it('observes a Project without a Session consumer and keeps one observation until its last consumer closes', async () => {
        const project = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        await advance(0);
        expect(liveSubscriptions).toBe(1);
        const session = await renderHook(() => useScmSessionAutoRefresh({
            sessionId: 'watch-session', serverId: scope.serverId, intervalMs: 300_000,
        }));
        await advance(0);
        expect(peakSubscriptions).toBe(1);
        await session.unmount();
        expect(liveSubscriptions).toBe(1);
        const workspaceCacheKey = buildWorkspaceCacheKey(scope);
        setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '',
            entries: [{ name: 'before.txt', type: 'file' }] });
        const before = statusReads();
        current = { ...initial, branch: { ...initial.branch, head: 'project-only-edit' } };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(statusReads() - before).toBe(1);
        expect(project.getCurrent().snapshot?.branch.head).toBe('project-only-edit');
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' })).toBeNull();
        await project.unmount();
        expect(liveSubscriptions).toBe(0);
    });

    it('discovers the repository from a cold nested Session before sharing its observation with Project', async () => {
        const state = storage.getState();
        const seeded = state.sessions['watch-session']!;
        const nested = { ...seeded, metadata: { ...seeded.metadata!, path: '/watch-repo/nested' } };
        storage.setState({ sessions: { [nested.id]: nested },
            sessionListRowsByServerId: { [scope.serverId]: { [nested.id]: nested } } });
        state.updateWorkspaceScmSnapshot(scope, null);
        const session = await renderHook(() => useScmSessionAutoRefresh({
            sessionId: nested.id, serverId: scope.serverId, intervalMs: 300_000,
        }));
        await advance(0);
        expect(liveSubscriptions).toBe(1);
        const observations = rpc.mock.calls.filter(([request]) => request.method === 'scm.workspace.watch.v1'
            && (request.payload as { observationOnly?: boolean }).observationOnly);
        expect(observations).toHaveLength(1);
        expect(observations[0]?.[0].payload).toMatchObject({ directory: scope.rootPath });
        const project = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        await advance(0);
        expect(peakSubscriptions).toBe(1);
        const before = statusReads();
        current = { ...initial, branch: { ...initial.branch, head: 'nested-session-edit' } };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(statusReads() - before).toBe(1);
        expect(project.getCurrent().snapshot?.branch.head).toBe('nested-session-edit');
        expect(state.getSessionProjectScmSnapshot(nested.id, scope.serverId)?.branch.head).toBe('nested-session-edit');
        await project.unmount();
        await session.unmount();
        expect(liveSubscriptions).toBe(0);
    });

    it('loads Git and retains manual and fallback refresh when an older daemon has no watch method', async () => {
        watchMethodMissing = true;
        const { hook } = await mount();
        expect(hook.getCurrent().snapshot?.repo.isRepo).toBe(true);
        expect(hook.getCurrent().error).toBeNull();
        expect(storage.getState().getSessionProjectScmSnapshotError('watch-session', scope.serverId)).toBeNull();
        const watchRequests = rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_WORKSPACE_WATCH).length;
        current = { ...initial, branch: { ...initial.branch, head: 'manual-edit' } };
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().snapshot?.branch.head).toBe('manual-edit');
        expect(hook.getCurrent().error).toBeNull();
        current = { ...initial, branch: { ...initial.branch, head: 'fallback-edit' } };
        const before = statusReads();
        await advance(300_000);
        expect(statusReads() - before).toBe(1);
        expect(hook.getCurrent().snapshot?.branch.head).toBe('fallback-edit');
        expect(hook.getCurrent().error).toBeNull();
        expect(storage.getState().getSessionProjectScmSnapshot('watch-session', scope.serverId)?.branch.head).toBe('fallback-edit');
        expect(storage.getState().getSessionProjectScmSnapshotError('watch-session', scope.serverId)).toBeNull();
        expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_WORKSPACE_WATCH)).toHaveLength(watchRequests);
        await hook.unmount();
    });

    it('runs fallback only while the shared watch is unavailable and disarms it when presentation reacquires a ready watch', async () => {
        const { hook, setPresented } = await mount();
        expect(liveSubscriptions).toBe(1);
        const readyReads = statusReads();
        await advance(600_000);
        expect(statusReads() - readyReads).toBe(0);
        const acquisitions = rpc.mock.calls.filter(([request]) => request.method === 'scm.workspace.watch.v1'
            && (request.payload as { observationOnly?: boolean }).observationOnly).length;
        await act(async () => {
            observation?.({ status: 'unavailable', reason: { code: 'ENOSPC', message: 'Workspace watch limit reached' } });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(hook.getCurrent().snapshot?.branch.head).toBe('main');
        expect(hook.getCurrent().error?.errorCode).toBe('ENOSPC');
        const before = statusReads();
        current = { ...initial, branch: { ...initial.branch, head: 'fallback-edit' } };
        await advance(300_000);
        expect(statusReads() - before).toBe(1);
        expect(hook.getCurrent().snapshot?.branch.head).toBe('fallback-edit');
        expect(hook.getCurrent().error?.errorCode).toBe('ENOSPC');
        expect(rpc.mock.calls.filter(([request]) => request.method === 'scm.workspace.watch.v1'
            && (request.payload as { observationOnly?: boolean }).observationOnly)).toHaveLength(acquisitions);
        await setPresented(false);
        await setPresented(true);
        const recoveredReads = statusReads();
        await advance(600_000);
        expect(statusReads() - recoveredReads).toBe(0);
        await hook.unmount();
    });
});
