import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from '../sessionDetailsPanelTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const beginSessionProjectScmOperationMock = vi.hoisted(() => vi.fn());
const finishSessionProjectScmOperationMock = vi.hoisted(() => vi.fn(() => true));
const appendSessionProjectScmOperationMock = vi.hoisted(() => vi.fn());
const invalidateFromMutationAndAwaitMock = vi.hoisted(() => vi.fn(async () => {}));
const daemonProjectionState = vi.hoisted(() => ({
    current: {
        phase: 'unsupported',
        inputs: null,
    } as Readonly<Record<string, unknown>>,
}));

const sessionScmRemoteAddMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    name: string;
    fetchUrl: string;
    pushUrl?: string;
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmRemoteSetUrlMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    name: string;
    fetchUrl?: string;
    pushUrl?: string;
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmRemoteRemoveMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    name: string;
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmBranchMergeMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    sourceRef: string;
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmBranchRebaseMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    sourceRef: string;
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmBranchOperationContinueMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    operation: 'merge' | 'rebase';
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmBranchOperationAbortMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    operation: 'merge' | 'rebase';
}) => Promise<{ success: true }>>(async () => ({ success: true })));
const sessionScmHostingRepositoryDescribePublishTargetsMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    providerKind?: string;
}) => Promise<{
    success: true;
    auth: { kind: 'gh-cli'; authenticated: true };
    defaultRepositoryName: string;
    targets: [];
}>>(async () => ({
    success: true,
    auth: { kind: 'gh-cli', authenticated: true },
    defaultRepositoryName: 'repo',
    targets: [],
})));
const sessionScmHostingRepositoryPublishMock = vi.hoisted(() => vi.fn<(sessionId: string, request: {
    providerKind: string;
    owner: string;
    ownerKind: string;
    repositoryName: string;
    visibility: string;
    remoteName: string;
    remoteConflictStrategy: string;
    remoteUrlKind: string;
    pushCurrentBranch: boolean;
}) => Promise<{ success: true }>>(async () => ({ success: true })));

let activeGitSubTab: 'commit' | 'update' | 'history' = 'update';
let sessionSnapshotMock: any = null;
let capturedRemotesProps: any = null;
let capturedBranchProps: any = null;
let capturedPublishProps: any = null;
let capturedCommitTabProps: any = null;


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
    SourceControlStaleSnapshotNotice: () => null,
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: () => React.createElement('SourceControlUnavailableState'),
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

// Override only the predicate this suite forces; keep every other export real so
// `useSessionMachineReachability` can still resolve `resolveSessionMachineReachabilityState`.
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/sessions/model/resolveSessionMachineReachability')>()),
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => true,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonProjectionState.current,
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: vi.fn(),
        invalidateFromAutoRefreshAndAwait: vi.fn(),
        invalidateFromMutationAndAwait: invalidateFromMutationAndAwaitMock,
    },
}));

vi.mock('@/components/workspaces/scm/update/SourceControlPullRequestSection', () => ({
    SourceControlPullRequestSection: () => React.createElement('SourceControlPullRequestSection'),
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
    WorkspaceScmUpdateTab: (props: any) => React.createElement('WorkspaceScmUpdateTab', { ...props, testID: 'session-right-panel-git-update-tab' }, props.children),
}));

vi.mock('@/components/workspaces/scm/WorkspaceScmHistoryTab', () => ({
    WorkspaceScmHistoryTab: () => React.createElement('WorkspaceScmHistoryTab'),
}));

vi.mock('./SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: (props: any) => {
        capturedCommitTabProps = props;
        return React.createElement('SessionRightPanelGitCommitTabContent');
    },
}));

vi.mock('@/sync/ops/sessions', () => ({
    sessionScmRemoteAdd: (sessionId: string, request: { name: string; fetchUrl: string; pushUrl?: string }) =>
        sessionScmRemoteAddMock(sessionId, request),
    sessionScmRemoteSetUrl: (sessionId: string, request: { name: string; fetchUrl?: string; pushUrl?: string }) =>
        sessionScmRemoteSetUrlMock(sessionId, request),
    sessionScmRemoteRemove: (sessionId: string, request: { name: string }) =>
        sessionScmRemoteRemoveMock(sessionId, request),
    sessionScmBranchMerge: (sessionId: string, request: { sourceRef: string }) =>
        sessionScmBranchMergeMock(sessionId, request),
    sessionScmBranchRebase: (sessionId: string, request: { sourceRef: string }) =>
        sessionScmBranchRebaseMock(sessionId, request),
    sessionScmBranchOperationContinue: (sessionId: string, request: { operation: 'merge' | 'rebase' }) =>
        sessionScmBranchOperationContinueMock(sessionId, request),
    sessionScmBranchOperationAbort: (sessionId: string, request: { operation: 'merge' | 'rebase' }) =>
        sessionScmBranchOperationAbortMock(sessionId, request),
    sessionScmHostingRepositoryDescribePublishTargets: (sessionId: string, request: { providerKind?: string }) =>
        sessionScmHostingRepositoryDescribePublishTargetsMock(sessionId, request),
    sessionScmHostingRepositoryPublish: (sessionId: string, request: {
        providerKind: string;
        owner: string;
        ownerKind: string;
        repositoryName: string;
        visibility: string;
        remoteName: string;
        remoteConflictStrategy: string;
        remoteUrlKind: string;
        pushCurrentBranch: boolean;
    }) => sessionScmHostingRepositoryPublishMock(sessionId, request),
    sessionScmRepositoryInit: vi.fn(async () => ({ success: true })),
    sessionScmBranchCreate: vi.fn(async () => ({ success: true })),
    sessionScmPullRequestOpenCompose: vi.fn(async () => ({ success: true })),
    sessionScmPullRequestOpenOrReuse: vi.fn(async () => ({ success: true })),
    sessionScmRepositoryRemoveIndexLock: vi.fn(async () => ({ success: true })),
}));

function createSnapshot(overrides: Record<string, unknown> = {}) {
    return {
        fetchedAt: 1,
        projectKey: 'm1:/repo',
        repo: {
            isRepo: true,
            rootPath: '/repo',
            backendId: 'git',
            mode: '.git',
            remotes: [
                {
                    name: 'origin',
                    fetchUrl: 'git@example.com:repo.git',
                    pushUrl: 'git@example.com:repo.git',
                },
            ],
        },
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
            readHostingRepositoryPublishTargets: true,
            writeHostingRepositoryPublish: true,
            supportedDiffAreas: ['included', 'pending'],
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
        },
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

describe('SessionRightPanelGitUpdateTab (owner-path compatibility)', () => {
    beforeEach(() => {
        activeGitSubTab = 'update';
        sessionSnapshotMock = createSnapshot();
        capturedRemotesProps = null;
        capturedBranchProps = null;
        capturedPublishProps = null;
        capturedCommitTabProps = null;
        daemonProjectionState.current = { phase: 'unsupported', inputs: null };

        beginSessionProjectScmOperationMock.mockReturnValue({
            started: true,
            operation: {
                id: 'lock-1',
                startedAt: 1,
                sessionId: 'session-1',
                operation: 'remote_add',
            },
        });
        finishSessionProjectScmOperationMock.mockReset();
        finishSessionProjectScmOperationMock.mockReturnValue(true);
        appendSessionProjectScmOperationMock.mockReset();
        invalidateFromMutationAndAwaitMock.mockClear();

        sessionScmRemoteAddMock.mockClear();
        sessionScmRemoteSetUrlMock.mockClear();
        sessionScmRemoteRemoveMock.mockClear();
        sessionScmBranchMergeMock.mockClear();
        sessionScmBranchRebaseMock.mockClear();
        sessionScmBranchOperationContinueMock.mockClear();
        sessionScmBranchOperationAbortMock.mockClear();
        sessionScmHostingRepositoryDescribePublishTargetsMock.mockClear();
        sessionScmHostingRepositoryPublishMock.mockClear();
    });

    it('wires update sub-sections through SessionRightPanelGitView', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        const screen = await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        expect(screen.findByTestId('session-right-panel-git-update-tab')).not.toBeNull();
        expect(capturedRemotesProps).not.toBeNull();
        expect(capturedBranchProps).not.toBeNull();
        expect(capturedPublishProps).not.toBeNull();
        expect(capturedRemotesProps.writeEnabled).toBe(true);
        expect(capturedBranchProps.writeEnabled).toBe(true);
        expect(capturedPublishProps.writeEnabled).toBe(true);
    });

    it('uses the daemon-projected packed backend identity in the session source-control surface', async () => {
        activeGitSubTab = 'commit';
        sessionSnapshotMock = createSnapshot({
            repo: {
                isRepo: true,
                rootPath: '/repo',
                backendId: 'acme.scm/stacked',
                mode: '.stacked',
                remotes: [],
            },
        });
        daemonProjectionState.current = {
            phase: 'ready',
            inputs: {
                pluginProjectionV2: {
                    v: 2,
                    generation: 41,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {
                        scmBackends: {
                            family: 'scmBackends',
                            entriesById: {
                                'acme.scm/stacked': {
                                    id: 'acme.scm/stacked',
                                    localId: 'stacked',
                                    pluginId: 'acme.scm',
                                    title: 'Acme Stacked SCM',
                                    description: 'Packed stacked-change backend',
                                    capabilities: ['detect', 'status', 'diff', 'commit'],
                                },
                            },
                        },
                        scmHostingProviders: {
                            family: 'scmHostingProviders',
                            entriesById: {},
                        },
                        connectedAccounts: {
                            family: 'connectedAccounts',
                            entriesById: {},
                        },
                    },
                    diagnostics: [],
                },
            },
        };

        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        expect(capturedCommitTabProps.backendLabel).toBe('Acme Stacked SCM');
    });

    it('routes remotes and branch-integration callbacks through session-scoped update RPCs', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        await capturedRemotesProps.onAddRemote({
            name: 'backup',
            fetchUrl: 'git@example.com:backup.git',
        });
        await capturedRemotesProps.onSetRemoteUrl({
            name: 'origin',
            fetchUrl: 'git@example.com:next.git',
        });
        await capturedRemotesProps.onRemoveRemote('origin');
        await capturedBranchProps.onMerge('origin/main');
        await capturedBranchProps.onRebase('origin/main');
        await capturedBranchProps.onContinue('merge');
        await capturedBranchProps.onAbort('merge');
        await capturedRemotesProps.onRefresh();
        await capturedBranchProps.onRefresh();

        expect(sessionScmRemoteAddMock).toHaveBeenCalledWith('session-1', {
            name: 'backup',
            fetchUrl: 'git@example.com:backup.git',
        });
        expect(sessionScmRemoteSetUrlMock).toHaveBeenCalledWith('session-1', {
            name: 'origin',
            fetchUrl: 'git@example.com:next.git',
        });
        expect(sessionScmRemoteRemoveMock).toHaveBeenCalledWith('session-1', {
            name: 'origin',
        });
        expect(sessionScmBranchMergeMock).toHaveBeenCalledWith('session-1', { sourceRef: 'origin/main' });
        expect(sessionScmBranchRebaseMock).toHaveBeenCalledWith('session-1', { sourceRef: 'origin/main' });
        expect(sessionScmBranchOperationContinueMock).toHaveBeenCalledWith('session-1', { operation: 'merge' });
        expect(sessionScmBranchOperationAbortMock).toHaveBeenCalledWith('session-1', { operation: 'merge' });
        expect(invalidateFromMutationAndAwaitMock).toHaveBeenCalledWith('session-1');
    });

    it('routes publish controls through the SessionRightPanelGitView update owner contract', async () => {
        sessionSnapshotMock = createSnapshot({
            hostingProvider: {
                kind: 'gitlab',
                baseUrl: 'https://gitlab.com',
                nameWithOwner: 'happier-dev/repo',
            },
        });
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');
        await renderScreen(<SessionRightPanelGitView sessionId="session-1" scopeId="session:1" />);

        await capturedPublishProps.onDescribePublishTargets();
        await capturedPublishProps.onPublishRepository({
            providerKind: 'gitlab',
            owner: 'happier-dev',
            ownerKind: 'organization',
            repositoryName: 'repo',
            visibility: 'private',
            remoteName: 'origin',
            remoteConflictStrategy: 'fail',
            remoteUrlKind: 'https',
            pushCurrentBranch: false,
        });

        expect(sessionScmHostingRepositoryDescribePublishTargetsMock).toHaveBeenCalledWith('session-1', {
            providerKind: 'gitlab',
        });
        expect(sessionScmHostingRepositoryPublishMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
            providerKind: 'gitlab',
            repositoryName: 'repo',
            remoteName: 'origin',
        }));
    });
});
