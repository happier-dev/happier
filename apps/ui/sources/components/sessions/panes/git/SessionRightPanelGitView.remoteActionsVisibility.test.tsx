import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    Text: (props: any) => React.createElement('Text', props, props.children),
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
    AppState: {
        addEventListener: () => ({ remove: () => {} }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                textSecondary: '#666',
                divider: '#ddd',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
            },
        },
    }),
    StyleSheet: {
        absoluteFillObject: {},
        create: (value: any) => value,
    },
}));

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
        activeGitSubTab: 'update',
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
        pullPreflight: { allowed: false, reason: 'upstream_required', message: 'Set a tracking target before pull or push.' },
        pushPreflight: { allowed: false, reason: 'upstream_required', message: 'Set a tracking target before pull or push.' },
        runRemoteOperation: vi.fn(),
        createCommitFromMessage: vi.fn(),
        commitMessageGeneratorEnabled: false,
        generateCommitMessageSuggestion: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    __esModule: true,
    useSetting: () => null,
    useAllMachines: () => [{ id: 'm1', active: true, activeAt: 1, metadata: { host: 'mbp', homeDir: '/tmp' } }],
    useProjectForSession: () => null,
    useProjectSessions: () => [],
    useMachine: () => ({ online: true }),
    useSession: () => ({ active: true, metadata: { machineId: 'm1', path: '/repo' } }),
    useSessionProjectScmCommitSelectionPaths: () => [],
    useSessionProjectScmCommitSelectionPatches: () => [],
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmOperationLog: () => [],
    useSessionProjectScmSnapshot: () => ({
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
    }),
    useSessionProjectScmSnapshotError: () => null,
    useSessionProjectScmTouchedPaths: () => [],
    useSessionProjectScmOperationLogEntryIds: () => [],
    useSessionProjectScmTouchedPathsCount: () => 0,
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
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
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('./SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: () => React.createElement('CommitTab'),
}));

vi.mock('./SessionRightPanelGitUpdateTab', () => ({
    SessionRightPanelGitUpdateTab: (props: any) => React.createElement('UpdateTab', props),
}));

vi.mock('./SessionRightPanelGitHistoryTab', () => ({
    SessionRightPanelGitHistoryTab: () => React.createElement('HistoryTab'),
}));

describe('SessionRightPanelGitView (remote action visibility)', () => {
    it('hides pull/push when upstream is required and avoids showing a persistent blocked hint', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
        });

        const updateTab = tree.root.findByType('UpdateTab' as any);
        const actions = (updateTab.props as any).actions as Array<{ key: string }>;
        expect(actions.map((a) => a.key)).toEqual(['fetch']);
        expect((updateTab.props as any).hint).toBeNull();
    });
});
