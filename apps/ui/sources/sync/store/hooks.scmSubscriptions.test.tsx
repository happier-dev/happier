import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { ScmWorkingSnapshotSchema, createScmCapabilities } from '@happier-dev/protocol/scm';
import { storage } from '@/sync/domains/state/storageStore';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { snapshotToScmStatus } from '@/scm/scmRepositoryService';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    useWorkspaceScmStatus, useWorkspaceScmSnapshot, useWorkspaceScmSnapshotError,
    useWorkspaceScmCommitSelectionPaths, useWorkspaceScmCommitSelectionPatches,
    useWorkspaceScmOperationLog, useWorkspaceScmInFlightOperation,
    useSessionProjectScmSnapshot, useSessionProjectScmSnapshotError, useSessionProjectScmStatus,
    useSessionProjectScmCommitSelectionPaths, useSessionProjectScmCommitSelectionPatches,
    useSessionProjectScmOperationLog, useSessionProjectScmInFlightOperation,
    useProjectScmSnapshot, useProjectScmStatus, useSessionProjectScmIsRepo,
    useSessionProjectScmSummarySnapshot, useWorkspaceScmSummarySnapshot,
} from './hooks';
import { hasScmEntriesDemand } from '@/scm/refresh/scmEntriesDemand';

const scope = { serverId: 'scm-sub-home', machineId: 'scm-machine', rootPath: '/repo' };
const snapshot = ScmWorkingSnapshotSchema.parse({
    projectKey: 'runtime-project', fetchedAt: 1, repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    capabilities: createScmCapabilities({ readStatus: true }),
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
        includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
});
const initial = storage.getState();
afterEach(() => { standardCleanup(); projectManager.clear(); storage.setState(initial, true); });

describe('SCM owner subscriptions', () => {
    it.each([undefined, scope.serverId])('delivers status, selection, error and log changes without root pulses or unrelated workspace renders (Home: %s)', async (serverId) => {
        const other = { ...scope, rootPath: '/unrelated' };
        const session = createSessionFixture({ id: 'scm-sub-session', serverId: scope.serverId,
            metadata: { machineId: scope.machineId, path: scope.rootPath, host: 'host' } });
        const machine = createMachineFixture({ id: scope.machineId, active: true });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
        storage.getState().applySessions([session]);
        projectManager.addSession(session, { serverId: scope.serverId });
        const projectId = projectManager.getProjectForWorkspace(scope)!.id;
        let unrelatedRenders = 0;
        const workspace = await renderHook(() => ({
            status: useWorkspaceScmStatus(scope), snapshot: useWorkspaceScmSnapshot(scope),
            error: useWorkspaceScmSnapshotError(scope),
            selected: useWorkspaceScmCommitSelectionPaths(scope), patches: useWorkspaceScmCommitSelectionPatches(scope),
            log: useWorkspaceScmOperationLog(scope), inFlight: useWorkspaceScmInFlightOperation(scope),
        }));
        const sibling = await renderHook(() => ({
            status: useSessionProjectScmStatus(session.id, serverId), snapshot: useSessionProjectScmSnapshot(session.id, serverId),
            error: useSessionProjectScmSnapshotError(session.id, serverId),
            selected: useSessionProjectScmCommitSelectionPaths(session.id, serverId), patches: useSessionProjectScmCommitSelectionPatches(session.id, serverId),
            log: useSessionProjectScmOperationLog(session.id, serverId), inFlight: useSessionProjectScmInFlightOperation(session.id, serverId),
            projectSnapshot: useProjectScmSnapshot(projectId), projectStatus: useProjectScmStatus(projectId),
            isRepo: useSessionProjectScmIsRepo(session.id, serverId),
        }));
        await renderHook(() => {
            unrelatedRenders += 1;
            return { status: useWorkspaceScmStatus(other), error: useWorkspaceScmSnapshotError(other),
                selected: useWorkspaceScmCommitSelectionPaths(other), log: useWorkspaceScmOperationLog(other) };
        });
        const baseline = unrelatedRenders;
        const root = storage.getState();
        const status = snapshotToScmStatus(snapshot);
        await act(async () => { projectManager.updateWorkspaceScmStatus(scope, status); });
        expect(workspace.getCurrent().status).toBe(status);
        expect(sibling.getCurrent().projectStatus).toBe(status);
        await act(async () => {
            projectManager.updateWorkspaceScmSnapshot(scope, snapshot);
            projectManager.updateWorkspaceScmSnapshotError(scope, { message: 'refresh unavailable', at: 1 });
            projectManager.markWorkspaceScmCommitSelectionPaths(scope, ['a.ts'], 1);
            projectManager.upsertWorkspaceScmCommitSelectionPatch(scope, { path: 'a.ts', patch: 'patch' }, 1);
            projectManager.appendWorkspaceScmOperation(scope, { operation: 'refresh', status: 'failed', timestamp: 1 });
            projectManager.beginWorkspaceScmOperation(scope, 'commit', 1);
        });
        expect(workspace.getCurrent()).toMatchObject({ snapshot, error: { message: 'refresh unavailable' },
            selected: ['a.ts'], patches: [{ path: 'a.ts' }],
            log: [{ operation: 'refresh' }], inFlight: { operation: 'commit' } });
        expect(sibling.getCurrent()).toMatchObject({ status, snapshot, projectSnapshot: snapshot, isRepo: true,
            error: { message: 'refresh unavailable' }, selected: ['a.ts'],
            patches: [{ path: 'a.ts' }], log: [{ operation: 'refresh' }], inFlight: { operation: 'commit' } });
        expect(unrelatedRenders).toBe(baseline);
        expect(storage.getState()).toBe(root);
        await act(async () => {
            storage.getState().updateWorkspaceScmStatus(scope, { ...status, branch: 'next' });
            storage.getState().clearWorkspaceScmCommitSelectionPaths(scope);
        });
        expect(workspace.getCurrent().status?.branch).toBe('next');
        expect(workspace.getCurrent().selected).toEqual([]);
        expect(sibling.getCurrent().status?.branch).toBe('next');
        expect(storage.getState()).toBe(root);
        expect(unrelatedRenders).toBe(baseline);
        const operationId = workspace.getCurrent().inFlight!.id;
        await act(async () => { storage.getState().updateSessionProjectScmOperationProgress(session.id, operationId, 'writing', serverId); });
        expect(workspace.getCurrent().inFlight?.progressText).toBe('writing');
        await act(async () => {
            storage.getState().finishSessionProjectScmOperation(session.id, operationId, serverId);
            storage.getState().clearSessionProjectScmCommitSelectionPatches(session.id, serverId);
            projectManager.clearProjectScmStatus(projectId);
        });
        expect(workspace.getCurrent()).toMatchObject({ status: null, snapshot: null, inFlight: null, patches: [] });
        expect(sibling.getCurrent()).toMatchObject({ status: null, snapshot: null, inFlight: null, patches: [], isRepo: null });
        expect(storage.getState()).toBe(root);
        expect(unrelatedRenders).toBe(baseline);
    });

    it.each(['remove', 'move'] as const)('clears the mounted workspace lock when its Session leaves a shared project (%s)', async (change) => {
        const first = createSessionFixture({ id: 'lock-owner', serverId: scope.serverId,
            metadata: { machineId: scope.machineId, path: scope.rootPath, host: 'host' } });
        const second = createSessionFixture({ ...first, id: 'lock-peer' });
        projectManager.addSession(first, { serverId: scope.serverId });
        projectManager.addSession(second, { serverId: scope.serverId });
        const hook = await renderHook(() => useWorkspaceScmInFlightOperation(scope));
        await act(async () => { projectManager.beginSessionProjectScmOperation(first.id, 'commit', 1); });
        expect(hook.getCurrent()?.sessionId).toBe(first.id);
        await act(async () => {
            if (change === 'remove') projectManager.removeSession(first.id);
            else projectManager.addSession(createSessionFixture({ ...first, metadata: { ...first.metadata, host: 'host', path: '/elsewhere' } }),
                { serverId: scope.serverId });
        });
        expect(projectManager.getProjectForWorkspace(scope)?.sessionIds).toEqual([second.id]);
        expect(hook.getCurrent()).toBeNull();
    });

    it('makes the list hooks list demand while mounted and never shows a summary as a clean list', async () => {
        const summary = { ...snapshot, detail: 'summary' as const,
            summary: { changedFiles: 3, includedAdded: 0, includedRemoved: 0, pendingAdded: 5, pendingRemoved: 1 } };
        projectManager.updateWorkspaceScmSnapshot(scope, summary);
        const slot = { kind: 'workspace' as const, scope };
        const summaryReader = await renderHook(() => useWorkspaceScmSummarySnapshot(scope));
        expect(summaryReader.getCurrent()).toBe(summary);
        expect(hasScmEntriesDemand(slot)).toBe(false);

        const listReader = await renderHook(() => useWorkspaceScmSnapshot(scope));
        expect(hasScmEntriesDemand(slot)).toBe(true);
        expect(listReader.getCurrent()).toBeNull();
        await act(async () => { projectManager.updateWorkspaceScmSnapshot(scope, snapshot); });
        expect(listReader.getCurrent()).toBe(snapshot);

        await listReader.unmount();
        expect(hasScmEntriesDemand(slot)).toBe(false);
        await summaryReader.unmount();
    });

    it('keeps Session summary readers out of list demand', async () => {
        const session = createSessionFixture({ id: 'scm-demand-session', serverId: scope.serverId,
            metadata: { machineId: scope.machineId, path: scope.rootPath, host: 'host' } });
        const machine = createMachineFixture({ id: scope.machineId, active: true });
        storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [scope.serverId]: [machine] } });
        storage.getState().applySessions([session]);
        projectManager.addSession(session, { serverId: scope.serverId });
        const slot = { kind: 'workspace' as const, scope };
        const summaryReader = await renderHook(() => useSessionProjectScmSummarySnapshot(session.id, scope.serverId));
        expect(hasScmEntriesDemand(slot)).toBe(false);
        const listReader = await renderHook(() => useSessionProjectScmSnapshot(session.id, scope.serverId));
        expect(hasScmEntriesDemand(slot)).toBe(true);
        await listReader.unmount();
        expect(hasScmEntriesDemand(slot)).toBe(false);
        await summaryReader.unmount();
    });
});
