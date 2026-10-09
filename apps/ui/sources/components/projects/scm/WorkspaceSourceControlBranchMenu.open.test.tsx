import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installFileFindAccountBoundaryMocks } from '@/components/appShell/panes/fileFindSeedTestHelpers';
import { WorkspaceScmBranchPopover } from '@/components/workspaces/scm/branches/WorkspaceScmBranchPopover';
import { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { WorkspaceSourceControlBranchMenu } from './WorkspaceSourceControlBranchMenu';

installFileFindAccountBoundaryMocks('home', 'account');
const boundary = vi.hoisted(() => ({ values: new Map<string, string>(), sequence: 100, push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: boundary.push } }).module;
});
// The modal presentation is the boundary: on a computer Open is the dialog over the current page.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles'); return createUnistylesMock();
});
// Genuine device persistence/randomness; SCM, menu and retained draft owners remain real.
vi.mock('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage', () => ({ getSessionDraftPersistenceStorage: () => ({
    getString: (key: string) => boundary.values.get(key), set: (key: string, value: string) => boundary.values.set(key, value),
    delete: (key: string) => boundary.values.delete(key),
}) }));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => `00000000-0000-4000-8000-${String(boundary.sequence++).padStart(12, '0')}` }));
const snapshot: ScmWorkingSnapshot = { projectKey: 'project', fetchedAt: 1, hasConflicts: false, entries: [],
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    branch: { head: 'feature', upstream: null, ahead: 0, behind: 0, detached: false },
    capabilities: createScmCapabilities({ worktreeCreate: true }), totals: {
        includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } };

describe('retained Open SCM entrance', () => {
    beforeEach(() => { standardCleanup(); boundary.values.clear(); boundary.push.mockReset(); resetSessionDraftRepositoryForTests(); });
    it('retains the current branch and exact Machine folder without creating or switching a checkout', async () => {
        const select = vi.fn();
        const screen = await renderScreen(<WorkspaceSourceControlBranchMenu serverId="home" machineId="machine"
            rootPath="/repo" currentBranch="feature" snapshot={snapshot} onRefreshSnapshot={async () => { throw new Error('No SCM mutation'); }}
            onSelectWorkspacePath={select} />);
        const popover = screen.tree.findByType(WorkspaceScmBranchPopover);
        await act(async () => { await popover.props.onSelectItem('worktree:create-current-branch', { closeMenu: () => {}, reopenMenu: () => {} }); });
        const { Modal } = await import('@/modal');
        const dialog = vi.mocked(Modal.show).mock.calls.map(([config]) => config as { chrome?: { testID?: string }; props?: { routeParams?: { draftId: string } } })
            .find(config => config.chrome?.testID === 'projects.open.dialog');
        expect(boundary.push).not.toHaveBeenCalled();
        const route = { params: dialog!.props!.routeParams! };
        expect(getSessionDraftSnapshot({ serverId: 'home', accountId: 'account' }, { kind: 'projectOpen', draftId: route.params.draftId })?.document)
            .toMatchObject({ target: { kind: 'projectOpen' }, selection: { value: { serverId: 'home', machineId: 'machine',
                source: { kind: 'folder', path: '/repo' }, ref: 'feature', materialization: { kind: 'worktree',
                    checkout: { kind: 'git_worktree', displayName: '', baseRef: 'feature' } } } } });
        expect(select).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
