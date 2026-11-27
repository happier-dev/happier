import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWorkspaceScmSnapshotController } from '@/hooks/workspaces/scm/useWorkspaceScmSnapshotController';
import { storage, useSessionProjectScmSnapshot } from '@/sync/domains/state/storage';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { hasScmEntriesDemand, readScmSnapshotCounts } from './scmEntriesDemand';
import { useScmSessionAutoRefresh } from './useScmSessionAutoRefresh';
import { ingestWorkspaceMutationMessages } from './workspaceMutationIngestionRuntime';
import { buildScmFileDiffSnapshotSignature } from '@/scm/diffCache/scmDiffCacheKey';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { getCachedWorkspaceRepositoryDirectoryEntries, setCachedWorkspaceRepositoryDirectoryEntries } from '@/sync/domains/workspaces/files/workspaceRepositoryDirectory';

type Request = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: Request) => Promise<unknown>>());
// Only authenticated Machine transport is substituted; demand, invalidation, mapping and publication stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc));

const scope = { serverId: 'watch-home', machineId: 'watch-machine', rootPath: '/watch-repo' };
const managedScope = { ...scope, workspace: {
    v: 2, kind: 'managed', serverId: scope.serverId, rootPath: scope.rootPath,
    workspaceId: 'remote-project', managedId: 'guest',
    controller: { machineId: scope.machineId, installationId: 'controller-installation' },
} } as const;
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
    let holdStatus: ((snapshot: unknown) => Promise<unknown>) | undefined;
    let watchMethodMissing = false;
    let watchThrownFailure: Error | undefined;
    const statusReads = () => rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT).length;

    it.each(['returned', 'thrown'] as const)('retains a %s typed watch refusal for the Session and Workspace recovery details', async mode => {
        const cause = { phase: 'execution_authorization', errorClass: 'Error', errorCode: 'machine_manage_required', httpStatus: 403 } as const;
        if (mode === 'thrown') watchThrownFailure = createActionExecuteFailureError({ ok: false, errorCode: 'credential_scope_denied',
            error: 'Refused', requestId: 'watch-refusal', effectAttempted: false, failureCause: cause });
        const { hook } = await mount();
        if (mode === 'returned') await act(async () => { observation?.({ status: 'unavailable', reason: {
            code: 'credential_scope_denied', message: 'Refused', requestId: 'watch-refusal', effectAttempted: false, failureCause: cause,
        } }); });
        await advance(0);
        expect(hook.getCurrent().error?.failure).toMatchObject({ errorCode: 'credential_scope_denied',
            requestId: 'watch-refusal', effectAttempted: false, failureCause: cause });
        expect(storage.getState().getSessionProjectScmSnapshotError('watch-session', scope.serverId)?.failure)
            .toMatchObject({ requestId: 'watch-refusal', failureCause: cause });
    });

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
        watchThrownFailure = undefined;
        for (const rootPath of [scope.rootPath, `${scope.rootPath}/nested`]) {
            storage.getState().updateWorkspaceScmSnapshot({ ...scope, rootPath }, null);
            storage.getState().updateWorkspaceScmSnapshotError({ ...scope, rootPath }, null);
        }
        storage.getState().updateWorkspaceScmSnapshot(managedScope, null);
        storage.getState().updateWorkspaceScmSnapshotError(managedScope, null);
        const machine = createMachineFixture({ id: scope.machineId, activeAt: Date.now(), presenceProtocolVersion: 1 });
        const session = createSessionFixture({ id: 'watch-session', serverId: scope.serverId,
            metadata: { ...createSessionFixture().metadata!, machineId: machine.id, path: scope.rootPath } });
        storage.setState({ machines: { [machine.id]: machine }, sessions: { [session.id]: session },
            machineListByServerId: { [scope.serverId]: [machine] },
            sessionListRowsByServerId: { [scope.serverId]: { [session.id]: session } } });
        rpc.mockImplementation(async request => {
            if (request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT) {
                const captured = (request.payload as { detail?: string }).detail
                    ? readScmSnapshotCounts(current) : current;
                return holdStatus ? holdStatus(captured) : { success: true, snapshot: captured };
            }
            if (request.method !== 'scm.workspace.watch.v1') throw new Error(`Unexpected RPC ${request.method}`);
            if (watchThrownFailure) throw watchThrownFailure;
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
        scmStatusSync.stop('watch-session');
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

    it.each([undefined, scope.serverId])('loads the Session Git list without a Project consumer (Home=%s)', async serverId => {
        const hook = await renderHook(() => {
            useScmSessionAutoRefresh({ sessionId: 'watch-session', serverId, intervalMs: 300_000 });
            return useSessionProjectScmSnapshot('watch-session', serverId);
        });
        await advance(0);
        expect(hook.getCurrent()?.repo.isRepo).toBe(true);
        expect(hasScmEntriesDemand({ kind: 'workspace', scope })).toBe(true);
        const before = statusReads();
        current = ScmWorkingSnapshotSchema.parse({ ...initial,
            branch: { ...initial.branch, head: 'external-session-edit' },
            entries: [{ path: 'external.txt', previousPath: null, kind: 'untracked',
                includeStatus: '?', pendingStatus: '?', hasIncludedDelta: false, hasPendingDelta: true,
                stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false } }],
            totals: { ...initial.totals, pendingFiles: 1, untrackedFiles: 1 },
        });
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
            await scmStatusSync.getSync('watch-session', serverId).awaitQueue();
        });
        expect(statusReads() - before).toBe(1);
        expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT).at(-1)?.[0].payload).not.toHaveProperty('detail');
        expect(hook.getCurrent()?.branch.head).toBe('external-session-edit');
        expect(hook.getCurrent()?.entries.map(entry => entry.path)).toEqual(['external.txt']);
        await hook.unmount();
    });

    it('upgrades an in-flight summary when Session Git mounts before its first response', async () => {
        let release: (() => void) | undefined;
        holdStatus = captured => {
            holdStatus = undefined;
            return new Promise(resolve => { release = () => resolve({ success: true, snapshot: captured }); });
        };
        const composer = await renderHook(() => useScmSessionAutoRefresh({
            sessionId: 'watch-session', serverId: scope.serverId, intervalMs: 300_000,
        }));
        await advance(0);
        expect(release).toBeTypeOf('function');
        const git = await renderHook(() => useSessionProjectScmSnapshot('watch-session', scope.serverId));
        await act(async () => { release?.(); await vi.advanceTimersByTimeAsync(0); });
        expect(git.getCurrent()?.repo.isRepo).toBe(true);
        expect(git.getCurrent()?.detail).toBeUndefined();
        expect(statusReads()).toBe(2);
        await git.unmount();
        await composer.unmount();
    });

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

    it('keeps one managed Project observation, reads status once per change, and makes no idle RPCs', async () => {
        let renders = 0;
        const project = await renderHook(() => {
            renders++;
            return useWorkspaceScmSnapshotController(managedScope, { detail: 'summary' });
        });
        await advance(0);
        expect(project.getCurrent().snapshot?.branch.head).toBe('main');
        expect(liveSubscriptions).toBe(1);
        const methods = () => rpc.mock.calls.map(([request]) => request.method);
        expect(methods().filter(method => method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toHaveLength(2);
        expect(methods().filter(method => method === RPC_METHODS.SCM_WORKSPACE_WATCH)).toHaveLength(3);
        const settled = methods().length;
        const rendered = renders;
        await advance(600_000);
        expect(methods()).toHaveLength(settled);
        expect(renders).toBe(rendered);
        current = { ...initial, branch: { ...initial.branch, head: 'guest-edit' } };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(methods().slice(settled)).toEqual(expect.arrayContaining([
            RPC_METHODS.SCM_STATUS_SNAPSHOT, RPC_METHODS.SCM_WORKSPACE_WATCH,
        ]));
        expect(methods()).toHaveLength(settled + 2);
        expect(project.getCurrent().snapshot?.branch.head).toBe('guest-edit');
        expect(renders - rendered).toBe(1);
        await project.unmount();
        expect(liveSubscriptions).toBe(0);
        await advance(600_000);
        expect(methods()).toHaveLength(settled + 2);
    });

    it('keeps a stopped managed Project on its typed result without polling', async () => {
        rpc.mockResolvedValueOnce({ success: false, errorCode: 'BACKEND_UNAVAILABLE', actionErrorCode: 'managed_power_required' });
        const project = await renderHook(() => useWorkspaceScmSnapshotController(managedScope, { detail: 'summary' }));
        await advance(0);
        expect(project.getCurrent().error).toMatchObject({ errorCode: 'managed_power_required', nextAction: { kind: 'start_workspace' } });
        expect(statusReads()).toBe(1);
        expect(liveSubscriptions).toBe(0);
        const settled = rpc.mock.calls.length;
        await advance(600_000);
        expect(rpc).toHaveBeenCalledTimes(settled);
        await project.unmount();
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
        let releaseProjectRead: (() => void) | undefined;
        holdStatus = captured => {
            holdStatus = undefined;
            return new Promise(resolve => { releaseProjectRead = () => resolve({ success: true, snapshot: captured }); });
        };
        const project = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        await advance(0);
        expect(releaseProjectRead).toBeTypeOf('function');
        expect(rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT).at(-1)?.[0].payload).not.toHaveProperty('detail');
        await act(async () => { releaseProjectRead?.(); await vi.advanceTimersByTimeAsync(0); });
        expect(project.getCurrent().snapshot?.repo.isRepo).toBe(true);
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

    it('lets the ready watch own unknown mutation hints while preserving real edits and unavailable-watch recovery', async () => {
        const { hook } = await mount();
        const toolMessage = (id: string, name: string, input: Record<string, string>) => ({
            id, localId: null, createdAt: Date.now(), role: 'agent' as const, isSidechain: false,
            content: [{ type: 'tool-call' as const, id, name, input, description: null, uuid: id, parentUUID: null }],
        });
        const before = statusReads();
        for (const id of ['unknown-one', 'unknown-two']) {
            ingestWorkspaceMutationMessages('watch-session', [toolMessage(id, 'bash', { command: 'echo hello' })], scope.serverId);
            await advance(31_000);
        }
        await act(async () => { await scmStatusSync.invalidateFromAutoRefreshAndAwait('watch-session', scope.serverId); });
        expect(statusReads() - before).toBe(0);

        current = { ...initial, branch: { ...initial.branch, head: 'native-edit' } };
        await act(async () => {
            change?.({ status: 'changed', revision: ++revision });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(statusReads() - before).toBe(1);
        expect(hook.getCurrent().snapshot?.branch.head).toBe('native-edit');

        current = { ...initial, branch: { ...initial.branch, head: 'known-edit' } };
        ingestWorkspaceMutationMessages('watch-session', [toolMessage('known-edit', 'file-edit', { filePath: 'a.ts' })], scope.serverId);
        await advance(1_000);
        expect(hook.getCurrent().snapshot?.branch.head).toBe('known-edit');

        await act(async () => {
            observation?.({ status: 'unavailable', reason: { code: 'ENOSPC', message: 'Workspace watch limit reached' } });
            await vi.advanceTimersByTimeAsync(0);
        });
        current = { ...initial, branch: { ...initial.branch, head: 'unknown-recovery' } };
        ingestWorkspaceMutationMessages('watch-session', [toolMessage('unknown-recovery', 'bash', { command: 'echo recovery' })], scope.serverId);
        await advance(31_000);
        expect(hook.getCurrent().snapshot?.branch.head).toBe('unknown-recovery');
        await hook.unmount();
    });

    it.each(['method-missing', 'unavailable'] as const)('publishes nothing and renders nothing when the fallback tick reads an equal snapshot (watch %s)', async watchKind => {
        // I10 (P03 redesign): the 5-min fallback keeps its cadence, but equal content is not a change.
        watchMethodMissing = watchKind === 'method-missing';
        let renders = 0;
        const wrapper = ({ children }: { children?: React.ReactNode }) => (
            <PluginSurfaceFocusEligibilityProvider active presentationActive>{children}</PluginSurfaceFocusEligibilityProvider>);
        const hook = await renderHook(() => {
            renders++;
            useScmSessionAutoRefresh({ sessionId: 'watch-session', serverId: scope.serverId, intervalMs: 300_000 });
            useSessionProjectScmSnapshot('watch-session', scope.serverId);
            return useWorkspaceScmSnapshotController(scope);
        }, { wrapper });
        await advance(0);
        if (watchKind === 'unavailable') {
            await act(async () => {
                observation?.({ status: 'unavailable', reason: { code: 'ENOSPC', message: 'Workspace watch limit reached' } });
                await vi.advanceTimersByTimeAsync(0);
            });
            expect(hook.getCurrent().error?.errorCode).toBe('ENOSPC');
        }
        // Settle the first fallback read so the held snapshot equals what the next tick returns.
        await advance(300_000);
        const heldSnapshot = hook.getCurrent().snapshot;
        let publishes = 0;
        const stop = projectManager.subscribeScmSnapshots(() => { publishes++; }, new Set([buildWorkspaceCacheKey(scope)]));
        const rendersBefore = renders;
        const before = statusReads();
        current = { ...initial, fetchedAt: 2 };
        await advance(300_000);
        stop();
        expect({ reads: statusReads() - before, publishes, renders: renders - rendersBefore })
            .toEqual({ reads: 1, publishes: 0, renders: 0 });
        expect(hook.getCurrent().snapshot).toBe(heldSnapshot);
        if (watchKind === 'unavailable') expect(hook.getCurrent().error?.errorCode).toBe('ENOSPC');
        await hook.unmount();
    });

    it('publishes a repeated fallback read failure once', async () => {
        watchMethodMissing = true;
        const { hook } = await mount();
        holdStatus = async () => { throw new Error('daemon unreachable'); };
        await advance(300_000);
        const firstError = hook.getCurrent().error;
        expect(firstError).not.toBeNull();
        let publishes = 0;
        const stop = projectManager.subscribeScmSnapshots(() => { publishes++; }, new Set([buildWorkspaceCacheKey(scope)]));
        const before = statusReads();
        await advance(300_000);
        stop();
        expect({ reads: statusReads() - before, publishes }).toEqual({ reads: 1, publishes: 0 });
        expect(hook.getCurrent().error).toBe(firstError);
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
