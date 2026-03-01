import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let activeGitSubTab: 'commit' | 'update' | 'history' = 'commit';
const loadCommitHistoryMock = vi.fn();

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
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
                text: '#111',
                divider: '#ccc',
                surface: '#fff',
                surfaceHigh: '#f6f6f6',
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
        loadCommitHistory: loadCommitHistoryMock,
    }),
}));

vi.mock('@/hooks/session/files/useFilesScmOperations', () => ({
    useFilesScmOperations: () => ({
        scmOperationBusy: false,
        scmOperationStatus: null,
        commitPreflight: { allowed: true, message: null },
        pullPreflight: { allowed: true, message: null },
        pushPreflight: { allowed: true, message: null },
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
        }),
    },
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromUserAndAwait: vi.fn(),
        invalidateFromUser: vi.fn(),
    },
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitSubTabsBar', () => ({
    SessionRightPanelGitSubTabsBar: () => React.createElement('SubTabs'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitCommitTabContent', () => ({
    SessionRightPanelGitCommitTabContent: () => React.createElement('CommitTab'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitUpdateTab', () => ({
    SessionRightPanelGitUpdateTab: () => React.createElement('UpdateTab'),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitHistoryTab', () => ({
    SessionRightPanelGitHistoryTab: () => React.createElement('HistoryTab'),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('SessionRightPanelGitView (history lazy load)', () => {
    it('prefetches commit history on mount and does not double-load when switching to History', async () => {
        const { SessionRightPanelGitView } = await import('./SessionRightPanelGitView');

        loadCommitHistoryMock.mockClear();
        activeGitSubTab = 'commit';

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree.root.findAllByType('CommitTab' as any)).toHaveLength(1);
        expect(loadCommitHistoryMock).toHaveBeenCalledTimes(1);
        expect(loadCommitHistoryMock.mock.calls[0]?.[0]).toEqual({ reset: true });

        activeGitSubTab = 'history';
        await act(async () => {
            tree.update(<SessionRightPanelGitView sessionId="s1" scopeId="session:s1:2" />);
        });

        expect(tree.root.findAllByType('HistoryTab' as any)).toHaveLength(1);
        expect(loadCommitHistoryMock).toHaveBeenCalledTimes(1);
    });
});
