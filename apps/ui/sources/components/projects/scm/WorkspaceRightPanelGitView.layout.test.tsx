import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmLogEntry } from '@happier-dev/protocol';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
// This external package subpath is absent on some execution hosts. Git never renders streaming
// Markdown: throwing if invoked keeps this unrelated dependency from bypassing the tested path.
const splitStreamingRevealTextParts = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected streaming Markdown in Git'); }));
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts }));
// Unrelated encryption HTTP API is unavailable in the moving checkout. Git does not call it.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unexpected = () => { throw new Error('Unexpected session key-envelope HTTP request in Git'); };
    return { createSessionDataKeyEnvelopeClient: unexpected, readSessionDataKeyEnvelopeCollectionPage: unexpected,
        prepareSessionDataKeyEnvelopesForScope: unexpected, prepareSessionDataKeyEnvelopesDetached: unexpected };
});
// The native list runtime needs a viewport; render its slots at the framework boundary.
vi.mock('@legendapp/list/react-native', () => ({
    LegendList: (props: Readonly<{ ListHeaderComponent?: React.ReactNode; ListFooterComponent?: React.ReactNode; ListEmptyComponent?: React.ReactNode }>) => (
        <React.Fragment>{props.ListHeaderComponent}{props.ListEmptyComponent}{props.ListFooterComponent}</React.Fragment>
    ),
}));
// Machine SCM is the RPC boundary; the controller, store, history and view remain real.
vi.mock('@/sync/ops/scm/machineScm', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/scm/machineScm')>(),
    machineScmStatusSnapshot: vi.fn(async () => ({ success: false, error: 'offline' })),
    machineScmBranchMerge: vi.fn(),
    machineScmBranchRebase: vi.fn(),
    machineScmBranchOperationSkip: vi.fn(),
    machineScmRemoteAdd: vi.fn(),
    machineScmCommitUndoLast: vi.fn(),
    machineScmLogList: vi.fn(async () => ({
        success: true,
        entries: [{ sha: 'abc123', shortSha: 'abc123', subject: 'Saved project change', body: '', authorName: 'Ada', authorEmail: '', timestamp: 1 }],
    })),
}));
// The session placement's public SCM RPC facade is its transport boundary.
vi.mock('@/sync/ops', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops')>(),
    sessionScmLogList: vi.fn(),
    sessionScmBranchCheckout: vi.fn(),
}));
vi.mock('@/sync/ops/sessionScm', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/sessionScm')>(),
    sessionScmStatusSnapshot: vi.fn(),
}));

const scope = { serverId: 's1', machineId: 'm1', rootPath: '/repo' };
const snapshot = {
    projectKey: 'project-layout', fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
    capabilities: { ...EMPTY_SCM_CAPABILITIES, capabilityScope: 'local-backend', readLog: true, writeCommit: true },
    branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
    hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
} satisfies ScmWorkingSnapshot;

describe('project Git presentation', () => {
    beforeEach(async () => {
        const { machineScmStatusSnapshot, machineScmRemoteAdd, machineScmBranchMerge, machineScmBranchRebase, machineScmBranchOperationSkip, machineScmCommitUndoLast } = await import('@/sync/ops/scm/machineScm');
        vi.mocked(machineScmStatusSnapshot).mockReset().mockResolvedValue({ success: false, error: 'offline' });
        vi.mocked(machineScmRemoteAdd).mockReset();
        vi.mocked(machineScmCommitUndoLast).mockReset();
        vi.mocked(machineScmBranchMerge).mockReset();
        vi.mocked(machineScmBranchRebase).mockReset();
        vi.mocked(machineScmBranchOperationSkip).mockReset();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockClear();
        storage.setState({ settings: {
            ...storage.getState().settings,
            scmGitPaneLayout: 'unified', experiments: true,
            featureToggles: { ...storage.getState().settings.featureToggles, 'scm.writeOperations': true },
        } });
        storage.getState().updateWorkspaceScmSnapshot(scope, snapshot);
        storage.getState().updateWorkspaceScmSnapshotError(scope, null);
    });

    it('reconciles an unknown branch switch through the real branch consumer', async () => {
        projectManager.clear();
        storage.getState().applySessions([createSessionFixture({ id: 'branch-session', active: true,
            metadata: { path: '/repo', host: 'localhost', machineId: 'm1' } })]);
        const before = { ...snapshot, capabilities: { ...snapshot.capabilities, writeBranchCheckout: true } };
        storage.getState().updateSessionProjectScmSnapshot('branch-session', before);
        const { sessionScmBranchCheckout } = await import('@/sync/ops');
        const { sessionScmStatusSnapshot } = await import('@/sync/ops/sessionScm');
        vi.mocked(sessionScmBranchCheckout).mockReset().mockImplementationOnce(async () => {
            vi.mocked(sessionScmStatusSnapshot).mockResolvedValue({ success: true, snapshot: {
                ...before, branch: { ...before.branch, head: 'feature' },
            } });
            return { success: false, outcome: { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN',
                reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } };
        });
        const { GitBranchButton } = await import('@/components/sessions/panes/git/branches/GitBranchButton');
        const { WorkspaceScmBranchPopover } = await import('@/components/workspaces/scm/branches/WorkspaceScmBranchPopover');
        const screen = await renderScreen(<GitBranchButton sessionId="branch-session" snapshot={before} />);
        // Activate the real menu's published item callback; no branch service or mutation logic is mocked.
        await act(async () => { await screen.findByType(WorkspaceScmBranchPopover).props.onSelectItem('branch:feature'); });
        expect(storage.getState().getSessionProjectScmSnapshot('branch-session')?.branch.head).toBe('feature');
        expect(storage.getState().getSessionProjectScmOperationLog('branch-session')[0]?.outcome?.kind).toBe('outcome_unknown');
        expect(sessionScmBranchCheckout).toHaveBeenCalledOnce();
    });

    it('reconciles an unknown Undo without repeating the write or losing its outcome', async () => {
        projectManager.clear();
        const expectedHeadOid = 'a'.repeat(40);
        const currentHeadOid = 'b'.repeat(40);
        const before = { ...snapshot, capabilities: { ...snapshot.capabilities, writeCommitUndoLast: true },
            branch: { ...snapshot.branch, headOid: expectedHeadOid } };
        storage.getState().updateWorkspaceScmSnapshot(scope, before);
        const { machineScmStatusSnapshot, machineScmCommitUndoLast } = await import('@/sync/ops/scm/machineScm');
        vi.mocked(machineScmCommitUndoLast).mockImplementationOnce(async () => {
            vi.mocked(machineScmStatusSnapshot).mockResolvedValue({ success: true, snapshot: {
                ...before, branch: { ...before.branch, headOid: currentHeadOid },
            } });
            return { success: false, outcome: { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN',
                reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } };
        });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        await screen.pressByTestIdAsync('project-git-tools');
        await screen.pressByTestIdAsync('workspace-scm-undo-last-commit');
        expect(storage.getState().getWorkspaceScmSnapshot(scope)?.branch.headOid).toBe(currentHeadOid);
        expect(screen.findHostByTestId('session-git-outcome-outcome_unknown')).not.toBeNull();
        await screen.pressByTestIdAsync('session-git-outcome-outcome_unknown.action');
        expect(machineScmCommitUndoLast).toHaveBeenCalledOnce();
        expect(machineScmCommitUndoLast).toHaveBeenCalledWith('m1', { cwd: '/repo', expectedHeadOid }, { serverId: 's1' });
    });

    it('reconciles a rebase conflict and exposes its recovery without a duplicate failure dialog', async () => {
        projectManager.clear();
        const before = { ...snapshot, capabilities: { ...snapshot.capabilities, writeBranchRebase: true,
            writeBranchOperationControl: true, writeBranchOperationSkip: true } };
        storage.getState().updateWorkspaceScmSnapshot(scope, before);
        const { machineScmStatusSnapshot, machineScmBranchRebase, machineScmBranchOperationSkip } = await import('@/sync/ops/scm/machineScm');
        const { Modal } = await import('@/modal');
        const operation = { kind: 'rebase' as const, canContinue: false, canSkip: true, canAbort: true, unresolvedCount: 1 };
        vi.mocked(machineScmBranchRebase).mockImplementationOnce(async () => {
            vi.mocked(machineScmStatusSnapshot).mockResolvedValue({ success: true, snapshot: {
                ...before, hasConflicts: true, operationState: operation,
            } });
            return { success: false, outcome: { v: 1, kind: 'conflicted', errorCode: 'CONFLICTING_WORKTREE',
                repositoryState: { hasConflicts: true, operation }, nextActions: [{ kind: 'resolve_conflicts' }, { kind: 'skip' }, { kind: 'abort' }] } };
        });
        vi.mocked(machineScmBranchOperationSkip).mockResolvedValue({ success: true });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const openReview = vi.fn();
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} onOpenReviewAllChanges={openReview} />);
        await screen.pressByTestIdAsync('project-git-tools');
        await act(async () => { screen.changeTextByTestId('scm-update-branch-source-picker', 'feature'); });
        await screen.pressByTestIdAsync('scm-update-branch-rebase');
        expect(storage.getState().getWorkspaceScmSnapshot(scope)?.hasConflicts).toBe(true);
        expect(screen.findHostByTestId('scm-update-branch-operation-abort')).not.toBeNull();
        expect(screen.findHostByTestId('scm-update-branch-operation-skip')).not.toBeNull();
        expect(screen.findHostByTestId('session-git-outcome-conflicted')).not.toBeNull();
        expect(Modal.alert).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-git-outcome-conflicted.action');
        expect(openReview).toHaveBeenCalledOnce();
        await screen.pressByTestIdAsync('scm-update-branch-operation-skip');
        expect(machineScmBranchOperationSkip).toHaveBeenCalledWith('m1', { cwd: '/repo', operation: 'rebase' }, { serverId: 's1' });
    });

    it('reconciles an unknown remote edit, preserves its draft and offers a read instead of replaying the write', async () => {
        projectManager.clear();
        const before = { ...snapshot, capabilities: { ...snapshot.capabilities, writeRemoteAdd: true } };
        storage.getState().updateWorkspaceScmSnapshot(scope, before);
        const { machineScmStatusSnapshot, machineScmRemoteAdd } = await import('@/sync/ops/scm/machineScm');
        const { Modal } = await import('@/modal');
        vi.mocked(machineScmRemoteAdd).mockImplementationOnce(async () => {
            vi.mocked(machineScmStatusSnapshot).mockResolvedValue({ success: true, snapshot: {
                ...before, repo: { ...before.repo, remotes: [{ name: 'backup', fetchUrl: 'https://example.com/repo.git' }] },
            } });
            return { success: false, outcome: { v: 1, kind: 'outcome_unknown', errorCode: 'COMMAND_OUTCOME_UNKNOWN',
                reconciliation: { kind: 'repository_status', cwd: '/repo' }, nextActions: [{ kind: 'refresh' }] } };
        });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        await screen.pressByTestIdAsync('project-git-tools');
        await act(async () => {
            screen.changeTextByTestId('scm-remote-editor-name', 'backup');
            screen.changeTextByTestId('scm-remote-editor-fetch-url', 'https://example.com/repo.git');
        });
        await screen.pressByTestIdAsync('scm-remote-editor-save');
        expect(storage.getState().getWorkspaceScmSnapshot(scope)?.repo.remotes?.[0]?.name).toBe('backup');
        expect(screen.findHostByTestId('scm-remote-editor-name')?.props.value).toBe('backup');
        expect(screen.findHostByTestId('session-git-outcome-outcome_unknown')).not.toBeNull();
        expect(Modal.alert).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-git-outcome-outcome_unknown.action');
        expect(machineScmRemoteAdd).toHaveBeenCalledOnce();
    });

    it('shows history with changes in Unified and preserves the changes surface when switching layouts', async () => {
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        expect(screen.findByTestId('project-rightpanel-git-subtab:commit')).toBeNull();
        expect(screen.getTextContent()).toContain('Saved project change');
        const { machineScmLogList } = await import('@/sync/ops/scm/machineScm');
        expect(machineScmLogList).toHaveBeenCalledWith('m1', expect.objectContaining({ cwd: '/repo', skip: 0 }), { serverId: 's1' });
        const changesSurface = screen.findHostByTestId('project-rightpanel-git-surface:commit');
        expect(changesSurface).not.toBeNull();
        await act(async () => { screen.changeTextByTestId('scm-commit-message', 'Keep this draft'); });

        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, scmGitPaneLayout: 'tabs' } });
        });
        expect(screen.findByTestId('project-rightpanel-git-subtab:history')).not.toBeNull();
        expect(screen.findByTestId('project-rightpanel-git-subtab:update')).toBeNull();
        await screen.pressByTestIdAsync('project-rightpanel-git-subtab:history');
        expect(screen.findHostByTestId('project-rightpanel-git-surface:commit')).toBe(changesSurface);
        await screen.pressByTestIdAsync('project-rightpanel-git-subtab:commit');
        expect(screen.findHostByTestId('project-rightpanel-git-surface:commit')).toBe(changesSurface);
        expect(screen.findHostByTestId('scm-commit-message')?.props.value).toBe('Keep this draft');
        expect(splitStreamingRevealTextParts).not.toHaveBeenCalled();
    });

    it('keeps repository tools reachable after removing the Sync tab', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, {
            ...snapshot,
            repo: { ...snapshot.repo, defaultBranch: 'main' },
            branch: { ...snapshot.branch, head: 'feature' },
            capabilities: { ...EMPTY_SCM_CAPABILITIES, ...snapshot.capabilities, readPullRequestStatus: true, readHostingRepositoryPublishTargets: true, writePullRequestCreate: true, writeRemoteAdd: true, writeBranchMerge: true },
        });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        await screen.pressByTestIdAsync('project-git-tools');
        expect(screen.findHostByTestId('scm-pull-request-section')).not.toBeNull();
        expect(screen.findHostByTestId('scm-update-remotes-section')).not.toBeNull();
        expect(screen.findHostByTestId('scm-update-branch-integration-section')).not.toBeNull();
        expect(screen.findHostByTestId('scm-remote-editor-name')?.props.editable).not.toBe(false);
        await act(async () => { screen.changeTextByTestId('scm-remote-editor-name', 'backup'); });
        await act(async () => {
            storage.setState({ settings: { ...storage.getState().settings, scmGitPaneLayout: 'tabs' } });
        });
        await screen.pressByTestIdAsync('project-rightpanel-git-subtab:history');
        await screen.pressByTestIdAsync('project-rightpanel-git-subtab:commit');
        expect(screen.findHostByTestId('scm-remote-editor-name')?.props.value).toBe('backup');
        expect(splitStreamingRevealTextParts).not.toHaveBeenCalled();
    });

    it('keeps the observed force-with-lease action available when the branch is behind', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, {
            ...snapshot,
            capabilities: { ...snapshot.capabilities, changeSetModel: 'index', writeRemotePush: true, writeRemotePolicies: true, writeRemoteForceWithLease: true },
            branch: { ...snapshot.branch, upstream: 'origin/main', upstreamOid: 'a'.repeat(40), behind: 1 },
        });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        await screen.pressByTestIdAsync('project-git-tools');
        expect(screen.findHostByTestId('workspace-scm-force-with-lease')?.props.disabled).toBe(false);
    });

    it('reloads the timeline after undo moves HEAD without changing the branch name', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, {
            ...snapshot, branch: { ...snapshot.branch, headOid: 'a'.repeat(40) },
        });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        expect(screen.getTextContent()).toContain('Saved project change');
        const { machineScmLogList } = await import('@/sync/ops/scm/machineScm');
        vi.mocked(machineScmLogList).mockResolvedValueOnce({
            success: true,
            entries: [{ sha: 'parent', shortSha: 'parent', subject: 'Previous project commit', body: '', authorName: 'Ada', authorEmail: '', timestamp: 1 }],
        });
        await act(async () => {
            storage.getState().updateWorkspaceScmSnapshot(scope, {
                ...snapshot, branch: { ...snapshot.branch, headOid: 'b'.repeat(40) },
            });
        });
        expect(screen.getTextContent()).toContain('Previous project commit');
        expect(screen.getTextContent()).not.toContain('Saved project change');
    });

    it('refreshes the moved HEAD after an earlier timeline read finishes', async () => {
        const { machineScmLogList } = await import('@/sync/ops/scm/machineScm');
        let completeInitialLog!: (value: Awaited<ReturnType<typeof machineScmLogList>>) => void;
        vi.mocked(machineScmLogList).mockImplementationOnce(() => new Promise((resolve) => { completeInitialLog = resolve; }));
        storage.getState().updateWorkspaceScmSnapshot(scope, {
            ...snapshot, branch: { ...snapshot.branch, headOid: 'a'.repeat(40) },
        });
        const { WorkspaceRightPanelGitView } = await import('./WorkspaceRightPanelGitView');
        const screen = await renderScreen(<WorkspaceRightPanelGitView {...scope} onOpenFile={() => {}} />);
        vi.mocked(machineScmLogList).mockResolvedValueOnce({
            success: true,
            entries: [{ sha: 'parent', shortSha: 'parent', subject: 'Previous project commit', body: '', authorName: 'Ada', authorEmail: '', timestamp: 1 }],
        });
        await act(async () => {
            storage.getState().updateWorkspaceScmSnapshot(scope, {
                ...snapshot, branch: { ...snapshot.branch, headOid: 'b'.repeat(40) },
            });
        });
        await act(async () => {
            completeInitialLog({ success: true, entries: [{ sha: 'old', shortSha: 'old', subject: 'Saved project change', body: '', authorName: 'Ada', authorEmail: '', timestamp: 1 }] });
        });
        expect(screen.getTextContent()).toContain('Previous project commit');
        expect(screen.getTextContent()).not.toContain('Saved project change');
    });

    it('refreshes the session timeline after HEAD moves during an earlier read', async () => {
        storage.setState(storage.getInitialState(), true);
        projectManager.clear();
        storage.setState({ settings: { ...storage.getState().settings, scmGitPaneLayout: 'unified', scmFilesAutoRefreshIntervalMs: 0 } });
        storage.getState().applySessions([createSessionFixture({ id: 'history-session', active: true,
            metadata: { path: '/repo', host: 'localhost', machineId: 'm1' } })]);
        storage.getState().applyMachines([createMachineFixture({ id: 'm1', activeAt: Date.now() })]);
        storage.getState().updateSessionProjectScmSnapshot('history-session', {
            ...snapshot, branch: { ...snapshot.branch, headOid: 'a'.repeat(40) },
        });
        const { sessionScmLogList } = await import('@/sync/ops');
        let completeInitialLog!: (value: Awaited<ReturnType<typeof sessionScmLogList>>) => void;
        vi.mocked(sessionScmLogList).mockImplementationOnce(() => new Promise((resolve) => { completeInitialLog = resolve; }));
        vi.mocked(sessionScmLogList).mockResolvedValue({ success: true,
            entries: [{ sha: 'parent', shortSha: 'parent', subject: 'Previous session commit', body: '', authorName: 'Ada', authorEmail: '', timestamp: 1 }] });
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { SessionRightPanelGitView } = await import('@/components/sessions/panes/git/SessionRightPanelGitView');
        const screen = await renderScreen(<AppPaneProvider><SessionRightPanelGitView sessionId="history-session" scopeId="session:history-session" /></AppPaneProvider>);
        await act(async () => {
            storage.getState().updateSessionProjectScmSnapshot('history-session', {
                ...snapshot, branch: { ...snapshot.branch, headOid: 'b'.repeat(40) },
            });
        });
        await act(async () => {
            completeInitialLog({ success: true, entries: [{ sha: 'old', shortSha: 'old', subject: 'Saved session change', body: '', authorName: 'Ada', authorEmail: '', timestamp: 1 }] });
        });
        expect(screen.getTextContent()).toContain('Previous session commit');
        expect(screen.getTextContent()).not.toContain('Saved session change');
    });

    it('offers the shared pane preference without unsupported project tree choices', async () => {
        const { GitDisplayOptions } = await import('@/components/sessions/panes/git/display/GitDisplayMenu');
        const screen = await renderScreen(<GitDisplayOptions testIDPrefix="project-display" paneOnly />);
        expect(screen.findHostByTestId('project-display-layout:tabs')).not.toBeNull();
        expect(screen.findByTestId('project-display-show-as:tree')).toBeNull();
    });

    it('keeps the viewed current or incoming commit anchored on refresh and resets for another history', async () => {
        const { GitPaneLayout } = await import('@/components/workspaces/scm/GitPaneLayout');
        const { GitTimelineSection } = await import('@/components/sessions/panes/git/GitTimelineSection');
        const entries: ScmLogEntry[] = Array.from({ length: 25 }, (_, index) => ({
            sha: `sha-${index + 1}`, shortSha: `s${index + 1}`, subject: `Commit ${index + 1}`,
            body: '', authorName: 'Ada', authorEmail: '', timestamp: 0,
        }));
        const scrollTo = vi.fn();
        const renderHistory = (current: ScmLogEntry[], identity = 'repo-a', incoming: ScmLogEntry[] | null = null) => (
            <GitPaneLayout layout="tabs" activeSubTabId="history" onSelectSubTab={() => {}} changedCount={0}
                historyIdentity={identity} testIDPrefix="history-pane" renderChanges={() => null}
                timeline={<GitTimelineSection changedCount={0} selectedCount={0} ahead={0} behind={incoming?.length ?? 0}
                    upstream={incoming ? 'origin/main' : null} entries={current} incoming={incoming}
                    loading={false} hasMore={false} onLoadMore={() => {}} onOpenCommit={() => {}} landedSha={null} />}
            />
        );
        const screen = await renderScreen(renderHistory(entries), {
            createNodeMock: (element) => element.type === 'ScrollView' ? { scrollTo } : null,
        });
        const layout = (sha: string, y: number) => screen.findHostByTestId(`scm-commit-entry-${sha}`)?.props.onLayout?.({
            nativeEvent: { layout: { x: 0, y, width: 300, height: 60 } },
        });
        const scroll = (y: number) => screen.findHostByTestId('scm-history-scroll')?.props.onScroll({ nativeEvent: {
            contentOffset: { x: 0, y }, layoutMeasurement: { width: 300, height: 400 },
            contentSize: { width: 300, height: 1600 },
        } });
        await act(async () => {
            entries.slice(1).forEach((entry, index) => layout(entry.sha, 90 + index * 60));
            scroll(615);
        });
        await screen.update(renderHistory([{ ...entries[0], sha: 'new-head' }, ...entries]));
        await act(async () => { layout('sha-10', 630); });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 675, animated: false });
        await screen.update(renderHistory(entries, 'repo-b'));
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });

        const incoming = entries.slice(0, 2).map((entry, index) => ({ ...entry, sha: `incoming-${index + 1}` }));
        await screen.update(renderHistory(entries, 'repo-incoming', incoming));
        await act(async () => {
            layout('incoming-1', 30);
            layout('incoming-2', 90);
            scroll(95);
        });
        await screen.update(renderHistory([{ ...entries[0], sha: 'new-head' }, ...entries], 'repo-incoming', incoming));
        await act(async () => { layout('incoming-2', 150); });
        expect(scrollTo).toHaveBeenLastCalledWith({ y: 155, animated: false });
    });
});
