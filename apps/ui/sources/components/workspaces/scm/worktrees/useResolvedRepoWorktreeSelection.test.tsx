import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';
import { renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { useResolvedRepoWorktreeSelection } from './useResolvedRepoWorktreeSelection';

// The daemon transport is the only replaced boundary; selection and SCM cache reads stay real.
const rpc = vi.hoisted(() => vi.fn().mockResolvedValue({ success: false, errorCode: 'FEATURE_UNSUPPORTED' }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: rpc }));

const controller = { serverId: 'worktree-home', machineId: 'controller', rootPath: '/repo' };
const managed: WorkspaceScopeBase = { ...controller, workspace: {
    v: 2, kind: 'managed', serverId: controller.serverId, workspaceId: 'remote-checkout', managedId: 'remote-resource',
    controller: { machineId: controller.machineId, installationId: 'installation' }, rootPath: controller.rootPath,
} };
function snapshot(path: string) {
    return ScmWorkingSnapshotSchema.parse({
        projectKey: 'checkout:/repo', fetchedAt: 1,
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git',
            worktrees: [{ id: 'gitwt_feature', path, branch: 'feature', isCurrent: false }] },
        capabilities: createScmCapabilities({ readStatus: true }),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false, entries: [],
        totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    });
}

describe('useResolvedRepoWorktreeSelection', () => {
    beforeEach(() => {
        projectManager.clear();
        storage.setState(storage.getInitialState(), true);
        rpc.mockClear();
        storage.getState().updateWorkspaceScmSnapshot(controller, snapshot('/repo/controller-feature'));
        storage.getState().updateWorkspaceScmSnapshot(managed, snapshot('/repo/remote-feature'));
    });

    it.each([
        { scope: controller, expectedPath: '/repo/controller-feature' },
        { scope: managed, expectedPath: '/repo/remote-feature' },
    ])('resolves the requested worktree from the exact admitted scope ($expectedPath)', async ({ scope, expectedPath }) => {
        const params = { scope, defaultRootPath: '/repo', requestedRootPath: '/repo/old-feature',
            requestedWorktreeId: 'gitwt_feature', refreshOnMount: false };
        const hook = await renderHook(() => useResolvedRepoWorktreeSelection(params));
        expect(hook.getCurrent()).toMatchObject({ resolvedRootPath: expectedPath,
            resolvedWorktreeId: 'gitwt_feature', didRecoverMissingWorktree: false });
        await hook.unmount();
    });
});
