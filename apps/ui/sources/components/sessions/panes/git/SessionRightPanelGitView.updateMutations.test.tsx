import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ScmMutationResult =
    | { success: true; stdout?: string }
    | { success: false; errorCode?: string; error?: string };

const beginSessionProjectScmOperationMock = vi.hoisted(() => vi.fn());
const finishSessionProjectScmOperationMock = vi.hoisted(() => vi.fn(() => true));
const appendSessionProjectScmOperationMock = vi.hoisted(() => vi.fn());
const sessionScmRemoteAddMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<ScmMutationResult>>(async () => ({ success: true })));
const sessionScmBranchMergeMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<ScmMutationResult>>(async () => ({ success: true, stdout: 'merged' })));
const sessionScmRepositoryRemoveIndexLockMock = vi.hoisted(() => vi.fn());
const sessionScmHostingRepositoryDescribePublishTargetsMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({
    success: false,
    error: 'not configured',
})));
const modalConfirmMock = vi.hoisted(() => vi.fn());

let activeGitSubTab: 'commit' | 'update' | 'history' = 'update';
let sessionSnapshotMock: any = null;
let capturedRemotesProps: any = null;
let capturedBranchProps: any = null;
let capturedPublishProps: any = null;


installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
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
        const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            storage: createStorageStoreMock({
                beginSessionProjectScmOperation: beginSessionProjectScmOperationMock,
                finishSessionProjectScmOperation: finishSessionProjectScmOperationMock,
                appendSessionProjectScmOperation: appendSessionProjectScmOperationMock,
            } as any),
            useSetting: () => null,
            useSettingMutable: () => [null, vi.fn()],
            useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', homeDir: '/tmp' } }],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useMachine: () => ({ online: true }),
            useSession: () => ({ active: true, metadata: { machineId: 'm1', path: '/repo' } }),
            useSessionProjectScmCommitSelectionPaths: () => [],
            useSessionProjectScmCommitSelectionPatches: () => [],
            useSessionProjectScmInFlightOperation: () => null,
            useSessionProjectScmOperationLog: () => [],
            useSessionProjectScmSnapshot: () => sessionSnapshotMock,
            useSessionProjectScmSnapshotError: () => null,
            useSessionProjectScmTouchedPaths: () => [],
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
        pullPreflight: { allowed: true, message: null, reason: null },
        pushPreflight: { allowed: true, message: null, reason: null },
        runRemoteOperation: vi.fn(),
        createCommitFromMessage: vi.fn(),
        commitMessageGeneratorEnabled: false,
        generateCommitMessageSuggestion: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/sourceControl/usePublishBranchAction', () => ({
    usePublishBranchAction: () => ({
        canPublish: false,
        publishBusy: false,
        publishBranch: vi.fn(),
    }),
}));

vi.mock('@/components/workspaces/scm/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            confirm: modalConfirmMock,
        },
    }).module;
});

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => {
    const scmUiBackendRegistry = {
        getPluginForSnapshot: () => ({
            displayName: 'Git',
            commitActionConfig: () => ({ label: 'Commit' }),
            remoteActionConfig: () => ({ fetch: true, pull: true, push: true }),
            inferRemoteTarget: () => ({ remote: 'origin', branch: 'main' }),
            mapCapabilitiesToUiPolicy: () => ({ supportedDiffAreas: ['pending'], changeSetModel: 'index' }),
        }),
    };
    return {
        scmUiBackendRegistry,
        createScmUiBackendRegistry: () => scmUiBackendRegistry,
    };
});

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: vi.fn(),
        invalidateFromAutoRefreshAndAwait: vi.fn(),
        invalidateFromMutationAndAwait: vi.fn(async () => {}),
    },
}));

vi.mock('@/components/workspaces/scm/update/SourceControlRemotesSection', () => ({
    SourceControlRemotesSection: (props: any) => {
        capturedRemotesProps = props;
        return React.createElement('SourceControlRemotesSection');
    },
}));

vi.mock('@/components/workspaces/scm/update/SourceControlBranchIntegrationSection', () => ({
    SourceControlBranchIntegrationSection: (props: any) => {
        capturedBranchProps = props;
        return React.createElement('SourceControlBranchIntegrationSection');
    },
}));

vi.mock('@/components/workspaces/scm/update/SourceControlPublishRepositorySection', () => ({
    SourceControlPublishRepositorySection: (props: any) => {
        capturedPublishProps = props;
        return React.createElement('SourceControlPublishRepositorySection');
    },
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmUpdateTab', () => ({
    WorkspaceScmUpdateTab: (props: any) => React.createElement('WorkspaceScmUpdateTab', props, props.children),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmHistoryTab', () => ({
    WorkspaceScmHistoryTab: () => React.createElement('WorkspaceScmHistoryTab'),
}));

vi.mock('./SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: () => React.createElement('CommitTab'),
}));

vi.mock('@/sync/ops/sessions', () => ({
    sessionScmRemoteAdd: (...args: any[]) => sessionScmRemoteAddMock(...args),
    sessionScmRemoteSetUrl: vi.fn(async () => ({ success: true })),
    sessionScmRemoteRemove: vi.fn(async () => ({ success: true })),
    sessionScmBranchMerge: (...args: any[]) => sessionScmBranchMergeMock(...args),
    sessionScmBranchRebase: vi.fn(async () => ({ success: true })),
    sessionScmBranchOperationContinue: vi.fn(async () => ({ success: true })),
    sessionScmBranchOperationAbort: vi.fn(async () => ({ success: true })),
    sessionScmRepositoryRemoveIndexLock: (...args: any[]) => sessionScmRepositoryRemoveIndexLockMock(...args),
    sessionScmHostingRepositoryDescribePublishTargets: (...args: any[]) => sessionScmHostingRepositoryDescribePublishTargetsMock(...args),
    sessionScmHostingRepositoryPublish: vi.fn(async () => ({ success: true })),
    sessionScmPullRequestOpenCompose: vi.fn(async () => ({ success: true, url: 'https://example.com/compare' })),
    sessionScmPullRequestOpenOrReuse: vi.fn(async () => ({ success: true, pullRequest: null, reused: false, nextAction: { kind: 'none' } })),
    sessionScmRepositoryInit: vi.fn(async () => ({ success: true })),
    sessionScmBranchCreate: vi.fn(async () => ({ success: true })),
}));

function createSnapshot() {
    return {
        fetchedAt: 1,
        projectKey: 'm1:/repo',
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', remotes: [] },
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
            writeRemoteAdd: true,
            writeRemoteSetUrl: true,
            writeRemoteRemove: true,
            writeBranchMerge: true,
            writeBranchRebase: true,
            writeBranchOperationControl: true,
            supportedDiffAreas: ['included', 'pending'],
        },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
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
    };
}

describe('SessionRightPanelGitView update mutations', () => {
    beforeEach(() => {
        activeGitSubTab = 'update';
        sessionSnapshotMock = createSnapshot();
        capturedRemotesProps = null;
        capturedBranchProps = null;
        capturedPublishProps = null;
        beginSessionProjectScmOperationMock.mockReset();
        finishSessionProjectScmOperationMock.mockClear();
        appendSessionProjectScmOperationMock.mockClear();
        sessionScmRemoteAddMock.mockClear();
        sessionScmBranchMergeMock.mockClear();
        sessionScmRepositoryRemoveIndexLockMock.mockReset();
        sessionScmHostingRepositoryDescribePublishTargetsMock.mockClear();
        modalConfirmMock.mockReset();
    });

    it('routes remote add through the session SCM operation lock before invoking the RPC', async () => {
        beginSessionProjectScmOperationMock.mockReturnValue({
            started: false,
            reason: 'operation_in_flight',
            inFlight: {
                id: 'lock-1',
                startedAt: 1,
                sessionId: 'other-session',
                operation: 'push',
            },
        });

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        const response = await capturedRemotesProps.onAddRemote({
            name: 'origin',
            fetchUrl: 'git@example.com:repo.git',
        });

        expect(beginSessionProjectScmOperationMock).toHaveBeenCalledWith('session-1', 'remote_add');
        expect(sessionScmRemoteAddMock).not.toHaveBeenCalled();
        expect(response).toEqual({
            success: false,
            error: 'Another source-control operation is already running (push).',
        });
    });

    it('reports branch merge results through the session operation log', async () => {
        beginSessionProjectScmOperationMock.mockReturnValue({
            started: true,
            operation: {
                id: 'lock-2',
                startedAt: 2,
                sessionId: 'session-1',
                operation: 'branch_merge',
            },
        });

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        const response = await capturedBranchProps.onMerge('feature/review');

        expect(beginSessionProjectScmOperationMock).toHaveBeenCalledWith('session-1', 'branch_merge');
        expect(sessionScmBranchMergeMock).toHaveBeenCalledWith('session-1', { sourceRef: 'feature/review' });
        expect(appendSessionProjectScmOperationMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
            operation: 'branch_merge',
            status: 'success',
        }));
        expect(finishSessionProjectScmOperationMock).toHaveBeenCalledWith('session-1', 'lock-2');
        expect(response).toEqual({ success: true, stdout: 'merged' });
    });

    it('confirms stale index-lock recovery and retries update-tab mutations once', async () => {
        beginSessionProjectScmOperationMock.mockReturnValue({
            started: true,
            operation: {
                id: 'lock-3',
                startedAt: 3,
                sessionId: 'session-1',
                operation: 'remote_add',
            },
        });
        modalConfirmMock.mockResolvedValueOnce(true);
        sessionScmRemoteAddMock
            .mockResolvedValueOnce({
                success: false,
                errorCode: 'COMMAND_FAILED',
                error: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
            })
            .mockResolvedValueOnce({ success: true });
        sessionScmRepositoryRemoveIndexLockMock.mockResolvedValueOnce({
            success: true,
            removed: true,
            lockPath: '/repo/.git/index.lock',
        });

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        const response = await capturedRemotesProps.onAddRemote({
            name: 'origin',
            fetchUrl: 'git@example.com:repo.git',
        });

        expect(modalConfirmMock).toHaveBeenCalledTimes(1);
        expect(sessionScmRepositoryRemoveIndexLockMock).toHaveBeenCalledWith('session-1', {
            cwd: '/repo',
            confirmed: true,
            confirmationToken: expect.any(String),
        });
        expect(sessionScmRemoteAddMock).toHaveBeenCalledTimes(2);
        expect(response).toEqual({ success: true });
    });

    it('describes repository publish targets through the detected hosting provider', async () => {
        sessionSnapshotMock = {
            ...createSnapshot(),
            capabilities: {
                ...createSnapshot().capabilities,
                readHostingRepositoryPublishTargets: true,
                writeHostingRepositoryPublish: true,
            },
            hostingProvider: {
                id: 'scm.gitlab',
                kind: 'gitlab',
                displayName: 'GitLab',
                baseUrl: 'https://gitlab.com',
                nameWithOwner: 'happier-dev/happier',
                repositoryWebUrl: 'https://gitlab.com/happier-dev/happier',
                remoteName: 'origin',
                urlSafety: { allowedSchemes: ['https:'] },
            },
        };

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        await capturedPublishProps.onDescribePublishTargets();

        expect(sessionScmHostingRepositoryDescribePublishTargetsMock).toHaveBeenCalledWith('session-1', {
            providerKind: 'gitlab',
        });
    });
});
