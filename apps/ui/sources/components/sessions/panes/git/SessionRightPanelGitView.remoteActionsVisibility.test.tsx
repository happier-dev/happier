import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const publishBranchMock = vi.hoisted(() => vi.fn(async () => true));
const usePublishBranchActionMock = vi.hoisted(() => vi.fn<(input: unknown) => unknown>());
const setScmRemoteConfirmPolicyMock = vi.hoisted(() => vi.fn());
const confirmCommitAdjacentPushMock = vi.hoisted(() => vi.fn<(input: unknown) => Promise<boolean>>(async () => true));
const scmOperationsState = vi.hoisted(() => ({
    pullPreflight: { allowed: false, reason: 'upstream_required', message: 'Set a tracking target before pull or push.' } as any,
    pushPreflight: { allowed: false, reason: 'upstream_required', message: 'Set a tracking target before pull or push.' } as any,
    runRemoteOperation: vi.fn(),
    createCommitFromMessage: vi.fn(),
}));
let activeGitSubTab: 'commit' | 'update' | 'history' = 'update';
let scmSnapshotMock: any = null;
let scmWriteEnabledMock = true;


installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (value: any) => value?.default ?? null,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useSetting: () => null,
            useSettingMutable: (key: string) => (
                key === 'scmRemoteConfirmPolicy'
                    ? ['always', setScmRemoteConfirmPolicyMock]
                    : [null, vi.fn()]
            ),
            useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', homeDir: '/tmp' } }],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useMachine: () => ({ online: true }),
            useSession: () => ({ active: true, metadata: { machineId: 'm1', path: '/repo' } }),
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmOperationLog: () => [],
            useSessionProjectScmSnapshot: () => scmSnapshotMock,
            useSessionProjectScmSnapshotError: () => null,
            useSessionProjectScmTouchedPaths: () => [],
            useSessionProjectScmOperationLogEntryIds: () => [],
            useSessionProjectScmTouchedPathsCount: () => 0,
        });
    },
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {},
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('./useSessionRightPanelGitTabState', () => ({
    useSessionRightPanelGitTabState: () => ({
        activeGitSubTab,
        setActiveGitSubTab: vi.fn(),
        commitDraftMessage: '',
        setCommitDraftMessage: vi.fn(),
    }),
}));

vi.mock('./useSessionRightPanelGitOpenDetails', () => ({
    useSessionRightPanelGitOpenDetails: () => ({
        openFileInDetails: vi.fn(),
        openFileInDetailsPinned: vi.fn(),
        openCommitInDetails: vi.fn(),
    }),
}));

vi.mock('@/hooks/session/files/useScmCommitHistory', () => ({
    useScmCommitHistory: () => ({
        historyEntries: [],
        historyLoading: false,
        historyHasMore: false,
        loadCommitHistory: vi.fn(),
    }),
}));

vi.mock('@/hooks/session/files/useFilesScmOperations', () => ({
    useFilesScmOperations: () => ({
        scmOperationBusy: false,
        scmOperationStatus: null,
        commitPreflight: { allowed: true, message: null },
        pullPreflight: scmOperationsState.pullPreflight,
        pushPreflight: scmOperationsState.pushPreflight,
        runRemoteOperation: scmOperationsState.runRemoteOperation,
        createCommitFromMessage: scmOperationsState.createCommitFromMessage,
        commitMessageGeneratorEnabled: false,
        generateCommitMessageSuggestion: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => scmWriteEnabledMock,
}));

vi.mock('@/hooks/session/sourceControl/usePublishBranchAction', () => ({
    usePublishBranchAction: (input: unknown) => usePublishBranchActionMock(input),
}));

vi.mock('@/scm/operations/commitAdjacentPushConfirmation', () => ({
    confirmCommitAdjacentPush: (input: unknown) => confirmCommitAdjacentPushMock(input),
}));

vi.mock('@/components/workspaces/scm/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: () => ({
            displayName: 'Git',
            commitActionConfig: () => ({ label: 'Commit' }),
            remoteActionConfig: () => ({ fetch: true, pull: true, push: true }),
            inferRemoteTarget: () => ({ remote: 'origin', branch: 'main' }),
            mapCapabilitiesToUiPolicy: () => ({ supportedDiffAreas: ['pending'], changeSetModel: 'index' }),
        }),
    },
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: vi.fn(),
        invalidateFromAutoRefreshAndAwait: vi.fn(),
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('./SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: (props: any) => React.createElement('CommitTab', { ...props, testID: 'session-right-panel-git-commit-tab' }),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmUpdateTab', () => ({
    WorkspaceScmUpdateTab: (props: any) => React.createElement('UpdateTab', { ...props, testID: 'session-right-panel-git-update-tab' }),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmHistoryTab', () => ({
    WorkspaceScmHistoryTab: () => React.createElement('HistoryTab'),
}));

function createScmSnapshot(overrides?: Partial<NonNullable<typeof scmSnapshotMock>>) {
    return {
        fetchedAt: 1,
        projectKey: 'm1:/repo',
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: {
            readStatus: true,
            readDiffFile: true,
            readDiffCommit: true,
            readLog: true,
            writeCommit: true,
            writeInclude: true,
            writeExclude: true,
            writeRemoteFetch: true,
            writeRemotePull: true,
            writeRemotePush: true,
            supportedDiffAreas: ['included', 'pending'],
        },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
        ...overrides,
    };
}

describe('SessionRightPanelGitView (remote action visibility)', () => {
    beforeEach(() => {
        publishBranchMock.mockClear();
        setScmRemoteConfirmPolicyMock.mockClear();
        confirmCommitAdjacentPushMock.mockClear();
        scmOperationsState.runRemoteOperation.mockReset();
        scmOperationsState.createCommitFromMessage.mockReset();
        scmOperationsState.pullPreflight = { allowed: false, reason: 'upstream_required', message: 'Set a tracking target before pull or push.' };
        scmOperationsState.pushPreflight = { allowed: false, reason: 'upstream_required', message: 'Set a tracking target before pull or push.' };
        activeGitSubTab = 'update';
        scmSnapshotMock = createScmSnapshot();
        scmWriteEnabledMock = true;
        usePublishBranchActionMock.mockReturnValue({
            canPublish: true,
            publishBusy: false,
            publishBranch: publishBranchMock,
        });
    });

    it('shows publish when upstream is required and hides blocked pull/push actions', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        const screen = await renderScreen(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);

        const updateTab = screen.findByTestId('session-right-panel-git-update-tab');
        if (!updateTab) {
            throw new Error('Expected git update tab to render');
        }
        const actions = (updateTab.props as any).actions as Array<{ key: string }>;
        expect(actions.map((a) => a.key)).toEqual(['fetch', 'publish']);
        expect((updateTab.props as any).hint).toBeNull();
        expect((updateTab.props as any).branchTrigger).toBeTruthy();
    });

    it('does not render a workspace rail when remote update actions are unavailable', async () => {
        activeGitSubTab = 'commit';
        scmSnapshotMock = createScmSnapshot({
            capabilities: {
                ...createScmSnapshot().capabilities,
                writeRemoteFetch: false,
                writeRemotePull: false,
                writeRemotePush: false,
            },
        });

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        const screen = await renderScreen(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findAllByTestId('session-right-panel-git-update-tab')).toHaveLength(0);
    });

    it('keeps the git tabs visible without a workspace rail', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        const screen = await renderScreen(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findAllByTestId('session-right-panel-git-update-tab')).toHaveLength(1);
    });

    it('hides the update tab when source control writes are disabled', async () => {
        activeGitSubTab = 'update';
        scmWriteEnabledMock = false;

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        const screen = await renderScreen(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);

        expect(screen.findAllByTestId('session-right-panel-git-update-tab')).toHaveLength(0);
        expect(screen.findByTestId('session-rightpanel-git-surface:commit')).toBeTruthy();
    });

    it('passes a canonical push shortcut into the commit tab when the branch is safely ahead', async () => {
        activeGitSubTab = 'commit';
        scmOperationsState.pushPreflight = { allowed: true };
        scmSnapshotMock = createScmSnapshot({
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'git',
                mode: '.git',
                remotes: [{ name: 'origin', fetchUrl: 'git@example.com:repo.git', pushUrl: 'git@example.com:repo.git' }],
            },
            branch: { head: 'main', upstream: 'origin/main', ahead: 2, behind: 0, detached: false },
        });
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        const screen = await renderScreen(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);

        const commitTab = screen.findByTestId('session-right-panel-git-commit-tab');
        expect(commitTab).not.toBeNull();
        if (!commitTab) throw new Error('Expected commit tab to render');
        const pushAction = (commitTab.props as any).commitAdjacentPushAction;
        expect(pushAction).toMatchObject({
            disabled: false,
            busy: false,
        });

        await renderer.act(async () => {
            pushAction.onPress();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(confirmCommitAdjacentPushMock).toHaveBeenCalledWith(expect.objectContaining({
            target: { remote: 'origin', branch: 'main' },
            policy: 'always',
            detachedHeadLabel: 'files.detachedHead',
        }));
        expect(scmOperationsState.runRemoteOperation).toHaveBeenCalledWith('push', { skipConfirmation: true });
    });
});
