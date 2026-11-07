import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import * as React from 'react';
import { renderHook } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { hasScmEntriesDemand } from '@/scm/refresh/scmEntriesDemand';
import { scmRepositoryService } from '@/scm/scmRepositoryService';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { useWorkspaceScmSnapshotController } from './useWorkspaceScmSnapshotController';

type RpcRequest = Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope>[0];
const rpc = vi.hoisted(() => vi.fn<(request: RpcRequest) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(request => {
        // These scenarios exercise incumbent refresh behavior while native enrollment is pending.
        if (request.method === RPC_METHODS.SCM_WORKSPACE_WATCH) return new Promise(resolve => {
            request.signal?.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
        });
        return rpc(request);
    }));

const scope = { serverId: 'snapshot-home', machineId: 'snapshot-machine', rootPath: '/snapshot-repo' };
const snapshot = ScmWorkingSnapshotSchema.parse({
    projectKey: 'snapshot-machine:/snapshot-repo', fetchedAt: 1,
    repo: { isRepo: true, rootPath: scope.rootPath, backendId: 'git', mode: '.git' },
    capabilities: createScmCapabilities({ readStatus: true }),
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false,
    entries: [{ path: 'src/a.ts', kind: 'modified', previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
        includeStatus: '', pendingStatus: 'pending', hasIncludedDelta: false, hasPendingDelta: true }],
    totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 0, includedAdded: 0,
        includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0 },
});

describe('useWorkspaceScmSnapshotController', () => {
    beforeEach(() => {
        projectManager.clear();
        storage.setState(storage.getInitialState(), true);
        rpc.mockReset().mockResolvedValue({ success: true, snapshot });
    });
    it('reads accepted repository facts without a mount probe, while retaining explicit refresh', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, snapshot);
        const hook = await renderHook(() => useWorkspaceScmSnapshotController(scope, { refreshOnMount: false }));
        expect(hook.getCurrent().snapshot).toBe(snapshot);
        expect(rpc).not.toHaveBeenCalled();
        await hook.getCurrent().refresh();
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.SCM_STATUS_SNAPSHOT }));
        await hook.unmount();
    });
    describe('a retained surface', () => {
        const summaryOf = (changedFiles: number) => ({ ...snapshot, entries: [], detail: 'summary' as const, fetchedAt: 2,
            totals: { ...snapshot.totals, pendingFiles: changedFiles },
            summary: { changedFiles, includedAdded: 0, includedRemoved: 0, pendingAdded: changedFiles, pendingRemoved: 0 } });
        async function mountRetained() {
            let presented = true;
            const wrapper = ({ children }: { children?: React.ReactNode }) => (
                <PluginSurfaceFocusEligibilityProvider active presentationActive={presented}>{children}</PluginSurfaceFocusEligibilityProvider>);
            const hook = await renderHook(() => useWorkspaceScmSnapshotController(scope), { wrapper });
            await vi.waitFor(() => expect(hook.getCurrent().snapshot?.entries).toHaveLength(1));
            rpc.mockClear();
            return { hook, setPresented: async (next: boolean) => { presented = next; await hook.rerender(); } };
        }
        const readIsSummary = () => rpc.mock.calls.at(-1)?.[0]?.payload as Readonly<{ detail?: string }> | undefined;

        it('keeps its rows while hidden and revalidates once on return even when the counts did not move', async () => {
            const { hook, setPresented } = await mountRetained();
            const shown = hook.getCurrent().snapshot;
            await setPresented(false);
            expect(hook.getCurrent().snapshot).toBe(shown);
            // A hidden Review demands nothing: another reader's refresh of this slot reads counts only.
            expect(hasScmEntriesDemand({ kind: 'workspace', scope })).toBe(false);
            rpc.mockResolvedValue({ success: true, snapshot: summaryOf(1) });
            const counts = await renderHook(() => useWorkspaceScmSnapshotController(scope, { detail: 'summary', refreshOnMount: false }));
            await counts.getCurrent().refresh();
            expect(readIsSummary()?.detail).toBe('summary');
            expect(storage.getState().getWorkspaceScmSnapshot(scope)?.entries).toHaveLength(1);

            rpc.mockClear();
            await setPresented(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(hook.getCurrent().snapshot).toBe(shown);
            expect(rpc).toHaveBeenCalledTimes(1);
            await counts.unmount();
            await hook.unmount();
        });

        it('notices a hidden rename on return without a push or changed counts, with one background read', async () => {
            const { hook, setPresented } = await mountRetained();
            const shown = hook.getCurrent().snapshot;
            await setPresented(false);
            expect(rpc).not.toHaveBeenCalled();
            const moved = { ...snapshot, fetchedAt: 3,
                entries: [{ ...snapshot.entries[0]!, path: 'src/renamed.ts' }] };
            let answer!: (value: unknown) => void;
            rpc.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
            await setPresented(true);
            expect(hook.getCurrent().snapshot).toBe(shown);
            expect(rpc).toHaveBeenCalledTimes(1);
            answer({ success: true, snapshot: moved });
            await vi.waitFor(() => expect(hook.getCurrent().snapshot?.entries[0]?.path).toBe('src/renamed.ts'));
            await hook.rerender();
            expect(rpc).toHaveBeenCalledTimes(1);
            await hook.unmount();
        });

        it('shows its held rows at once and revalidates in the background once when the slot moved', async () => {
            const { hook, setPresented } = await mountRetained();
            const shown = hook.getCurrent().snapshot;
            await setPresented(false);
            rpc.mockResolvedValue({ success: true, snapshot: summaryOf(2) });
            const counts = await renderHook(() => useWorkspaceScmSnapshotController(scope, { detail: 'summary', refreshOnMount: false }));
            await counts.getCurrent().refresh();
            expect(storage.getState().getWorkspaceScmSnapshot(scope)).toMatchObject({ detail: 'summary', summary: { changedFiles: 2 } });
            expect(hook.getCurrent().snapshot).toBe(shown);

            const moved = { ...snapshot, fetchedAt: 3, entries: [snapshot.entries[0]!, { ...snapshot.entries[0]!, path: 'src/b.ts' }],
                totals: { ...snapshot.totals, pendingFiles: 2 } };
            let answer!: (value: unknown) => void;
            rpc.mockReset().mockImplementation(() => new Promise(resolve => { answer = resolve; }));
            await setPresented(true);
            await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
            expect(readIsSummary()?.detail).toBeUndefined();
            // The read is in flight: the reader still has its rows, not a loading state.
            expect(hook.getCurrent().snapshot).toBe(shown);
            answer({ success: true, snapshot: moved });
            await vi.waitFor(() => expect(hook.getCurrent().snapshot?.entries).toHaveLength(2));
            expect(rpc).toHaveBeenCalledTimes(1);
            await counts.unmount();
            await hook.unmount();
        });

        const cachedRows = () => scmRepositoryService.readCachedSnapshotForMachinePath({
            serverId: scope.serverId, machineId: scope.machineId, path: scope.rootPath })?.entries.length ?? 0;

        it('frees the list when it closes, from the slot and the repository cache', async () => {
            const { hook } = await mountRetained();
            const state = storage.getState();
            expect(cachedRows()).toBe(1);
            await hook.unmount();
            await vi.waitFor(() => expect(state.getWorkspaceScmSnapshot(scope)?.entries).toEqual([]));
            expect(state.getWorkspaceScmSnapshot(scope)).toMatchObject({ detail: 'summary', summary: { changedFiles: 1 } });
            expect(cachedRows()).toBe(0);

            rpc.mockClear();
            const reopened = await renderHook(() => useWorkspaceScmSnapshotController(scope));
            await vi.waitFor(() => expect(reopened.getCurrent().snapshot?.entries).toHaveLength(1));
            expect(rpc).toHaveBeenCalled();
            await reopened.unmount();
        });

        it('frees the cached list on close even after the slot already moved to counts while hidden', async () => {
            const { hook, setPresented } = await mountRetained();
            await setPresented(false);
            rpc.mockResolvedValue({ success: true, snapshot: summaryOf(2) });
            const counts = await renderHook(() => useWorkspaceScmSnapshotController(scope, { detail: 'summary', refreshOnMount: false }));
            await counts.getCurrent().refresh();
            expect(storage.getState().getWorkspaceScmSnapshot(scope)?.detail).toBe('summary');
            expect(cachedRows()).toBe(1);
            await hook.unmount();
            await vi.waitFor(() => expect(cachedRows()).toBe(0));
            await counts.unmount();
        });
    });
    it('gives a counts reader no rows it could pin, while another consumer holds the list', async () => {
        const list = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        const counts = await renderHook(() => useWorkspaceScmSnapshotController(scope, { detail: 'summary', refreshOnMount: false }));
        await vi.waitFor(() => expect(list.getCurrent().snapshot?.entries).toHaveLength(1));
        await vi.waitFor(() => expect(counts.getCurrent().snapshot?.summary?.changedFiles).toBe(1));
        const shown = counts.getCurrent().snapshot;
        expect(shown?.entries).toEqual([]);
        expect(shown).toMatchObject({ detail: 'summary', branch: { head: 'main' } });
        await counts.rerender();
        expect(counts.getCurrent().snapshot).toBe(shown);
        await counts.unmount();
        await list.unmount();
    });
    it('keeps the list while another presented consumer of the same workspace still holds it', async () => {
        const state = storage.getState();
        let presented = true;
        const wrapper = ({ children }: { children?: React.ReactNode }) => (
            <PluginSurfaceFocusEligibilityProvider active presentationActive={presented}>{children}</PluginSurfaceFocusEligibilityProvider>);
        const visible = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        const hidden = await renderHook(() => useWorkspaceScmSnapshotController(scope, { refreshOnMount: false }), { wrapper });
        await vi.waitFor(() => expect(visible.getCurrent().snapshot?.entries).toHaveLength(1));
        rpc.mockClear();
        presented = false;
        await hidden.rerender();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(hasScmEntriesDemand({ kind: 'workspace', scope })).toBe(true);
        expect(state.getWorkspaceScmSnapshot(scope)?.entries).toHaveLength(1);
        expect(visible.getCurrent().snapshot?.entries).toHaveLength(1);
        expect(rpc).not.toHaveBeenCalled();
        await hidden.unmount();
        await visible.unmount();
    });
    it('refreshes the addressed workspace, publishes status and prunes only its obsolete selections', async () => {
        const state = storage.getState();
        const other = { ...scope, serverId: 'other-home' };
        state.markWorkspaceScmCommitSelectionPaths(scope, ['src/a.ts', 'deleted.ts']);
        for (const path of ['src/a.ts', 'deleted.ts']) state.upsertWorkspaceScmCommitSelectionPatch(scope, { path, patch: 'retained patch' });
        state.markWorkspaceScmCommitSelectionPaths(other, ['deleted.ts']);
        state.updateWorkspaceScmSnapshotError(scope, { message: 'old error', at: 0 });

        const hook = await renderHook(() => useWorkspaceScmSnapshotController(scope));
        await vi.waitFor(() => expect(hook.getCurrent().snapshot?.entries.map(entry => entry.path)).toEqual(['src/a.ts']));
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
            serverId: scope.serverId, machineId: scope.machineId, method: RPC_METHODS.SCM_STATUS_SNAPSHOT,
            payload: expect.objectContaining({ cwd: scope.rootPath }),
        }));
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: null, snapshot: { branch: { head: 'main' } } });
        expect(state.getWorkspaceScmSnapshot(scope)?.entries.map(entry => entry.path)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmSnapshotError(scope)).toBeNull();
        expect(state.getWorkspaceScmStatus(scope)).not.toBeNull();
        expect(state.getWorkspaceScmCommitSelectionPaths(scope)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmCommitSelectionPatches(scope).map(patch => patch.path)).toEqual(['src/a.ts']);
        expect(state.getWorkspaceScmCommitSelectionPaths(other)).toEqual(['deleted.ts']);
        await hook.unmount();
    });
});
