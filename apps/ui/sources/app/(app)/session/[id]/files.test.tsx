import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const filesToolbarSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                textLink: '#08f',
                warning: '#f80',
                input: {
                    background: '#222',
                    placeholder: '#666',
                },
            },
            dark: false,
        },
    }),
    StyleSheet: { create: (value: any) => value },
}));

vi.mock('@react-navigation/native', () => ({
    useRoute: () => ({ params: { id: 'session-1' } }),
    useFocusEffect: () => {},
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 999 },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/git/gitAttribution', () => ({
    getDefaultChangedFilesViewMode: () => 'session',
}));

vi.mock('@/sync/git/gitStatusSync', () => ({
    gitStatusSync: {
        getSync: () => ({
            invalidateAndAwait: vi.fn(async () => {}),
        }),
    },
}));

vi.mock('@/sync/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/sync/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                'session-1': {
                    metadata: {
                        path: '/repo',
                    },
                },
            },
        }),
    },
    useSessionProjectGitOperationLog: () => [],
    useSessionProjectGitInFlightOperation: () => null,
    useSessionProjectGitSnapshot: () => ({
        repo: { isGitRepo: true, rootPath: '/repo' },
        branch: { head: 'main', detached: false },
        hasConflicts: false,
    }),
    useSessionProjectGitTouchedPaths: () => [],
    useProjectForSession: () => ({ id: 'project-1' }),
    useProjectSessions: () => ['session-1', 'session-2'],
    useSetting: () => true,
}));

vi.mock('@/sync/git/operations/featureFlags', () => ({
    resolveGitWriteEnabled: () => true,
}));

vi.mock('./files/hooks/useChangedFilesData', () => ({
    useChangedFilesData: () => ({
        attributionReliability: 'limited',
        showSessionViewToggle: false,
        gitStatusFiles: {
            branch: 'main',
            hasChanges: true,
            totalStaged: 0,
            totalUnstaged: 1,
            files: [],
        },
        changedFilesCount: 1,
        shouldShowAllFiles: false,
        allRepositoryChangedFiles: [],
        sessionAttributedFiles: [],
        repositoryOnlyFiles: [],
        suppressedInferredCount: 1,
    }),
}));

vi.mock('./files/hooks/useGitCommitHistory', () => ({
    useGitCommitHistory: () => ({
        historyEntries: [],
        historyLoading: false,
        historyHasMore: false,
        loadCommitHistory: vi.fn(async () => {}),
    }),
}));

vi.mock('./files/hooks/useFilesGitOperations', () => ({
    useFilesGitOperations: () => ({
        gitOperationBusy: false,
        gitOperationStatus: null,
        commitPreflight: { allowed: true, message: '' },
        pullPreflight: { allowed: true, message: '' },
        pushPreflight: { allowed: true, message: '' },
        runRemoteOperation: vi.fn(async () => {}),
        createCommit: vi.fn(async () => {}),
    }),
}));

vi.mock('./files/hooks/useGitOperationsVisibility', () => ({
    shouldShowGitOperationsPanel: () => false,
}));

vi.mock('./files/components/FilesToolbar', () => ({
    FilesToolbar: (props: any) => {
        filesToolbarSpy(props);
        return React.createElement('FilesToolbar', props);
    },
}));

vi.mock('./files/components/GitBranchSummary', () => ({
    GitBranchSummary: () => null,
}));

vi.mock('./files/components/GitOperationsPanel', () => ({
    GitOperationsPanel: () => null,
}));

vi.mock('./files/components/content/SearchResultsList', () => ({
    SearchResultsList: () => null,
}));

vi.mock('./files/components/content/ChangedFilesList', () => ({
    ChangedFilesList: () => null,
}));

describe('FilesScreen', () => {
    beforeEach(() => {
        filesToolbarSpy.mockClear();
    });

    it('falls back to repository mode when session view is not available', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(filesToolbarSpy).toHaveBeenCalled();
        const seenModes = filesToolbarSpy.mock.calls.map((call) => call[0]?.changedFilesViewMode);
        expect(seenModes).toContain('session');
        expect(seenModes.at(-1)).toBe('repository');
        expect(filesToolbarSpy.mock.calls.at(-1)?.[0]?.showSessionViewToggle).toBe(false);
    });
});
