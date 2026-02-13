import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const filesToolbarSpy = vi.fn();
const routerPushSpy = vi.fn();
let gitOperationsPanelProps: any = null;
let changedFilesListProps: any = null;
let focusEffectHasRun = false;

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    return {
        ...actual,
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
    };
});

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
    useFocusEffect: (cb: any) => {
        // Run once; the real hook triggers on focus, not on every render.
        if (focusEffectHasRun) return;
        focusEffectHasRun = true;
        cb();
    },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('react-native-typography', () => ({
    iOSUIKit: {
        title3: {},
    },
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'Text',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
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

vi.mock('@/scm/scmAttribution', () => ({
    getDefaultChangedFilesViewMode: () => 'session',
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        getSync: () => ({
            invalidateAndAwait: vi.fn(async () => {}),
        }),
    },
}));

vi.mock('@/sync/domains/input/suggestionFile', () => ({
    searchFiles: vi.fn(async () => []),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: {
                'session-1': {
                    metadata: {
                        path: '/repo',
                    },
                },
            },
            setSessionRepositoryTreeExpandedPaths: vi.fn(),
            clearSessionProjectScmCommitSelectionPaths: vi.fn(),
            clearSessionProjectScmCommitSelectionPatches: vi.fn(),
        }),
    },
    useSession: () => ({
        metadata: {
            path: '/repo',
        },
    }),
    useSessionProjectScmOperationLog: () => [],
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmSnapshot: () => ({
        repo: { isRepo: true, rootPath: '/repo' },
        branch: { head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
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
    useSessionProjectScmCommitSelectionPaths: () => [],
    useSessionProjectScmCommitSelectionPatches: () => [],
    useSessionProjectScmTouchedPaths: () => [],
    useSessionRepositoryTreeExpandedPaths: () => [],
    useProjectForSession: () => ({ id: 'project-1' }),
    useProjectSessions: () => ['session-1', 'session-2'],
    useSetting: (key: string) => {
        if (key === 'experiments') return false;
        if (key === 'expScmOperations') return true;
        if (key === 'scmCommitStrategy') return 'atomic';
        if (key === 'scmRemoteConfirmPolicy') return 'always';
        if (key === 'scmPushRejectPolicy') return 'prompt_fetch';
        if (key === 'scmReviewMaxFiles') return 25;
        if (key === 'scmReviewMaxChangedLines') return 2000;
        return true;
    },
}));

vi.mock('@/scm/operations/featureFlags', () => ({
    resolveScmWriteEnabled: () => true,
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: () => ({
        attributionReliability: 'limited',
        showSessionViewToggle: false,
        scmStatusFiles: {
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

vi.mock('@/hooks/session/files/useScmCommitHistory', () => ({
    useScmCommitHistory: () => ({
        historyEntries: [],
        historyLoading: false,
        historyHasMore: false,
        loadCommitHistory: vi.fn(async () => {}),
    }),
}));

vi.mock('@/hooks/session/files/useFilesScmOperations', () => ({
    useFilesScmOperations: () => ({
        scmOperationBusy: false,
        scmOperationStatus: null,
        commitPreflight: { allowed: true, message: '' },
        pullPreflight: { allowed: true, message: '' },
        pushPreflight: { allowed: true, message: '' },
        runRemoteOperation: vi.fn(async () => {}),
        createCommit: vi.fn(async () => {}),
    }),
}));

vi.mock('@/hooks/session/files/useScmOperationsVisibility', () => ({
    shouldShowScmOperationsPanel: () => true,
}));

vi.mock('@/components/sessions/files/FilesToolbar', () => ({
    FilesToolbar: (props: any) => {
        filesToolbarSpy(props);
        return React.createElement('FilesToolbar', props);
    },
}));

vi.mock('@/components/sessions/files/SourceControlBranchSummary', () => ({
    SourceControlBranchSummary: () => null,
}));

vi.mock('@/components/sessions/files/SourceControlOperationsPanel', () => ({
    SourceControlOperationsPanel: (props: any) => {
        gitOperationsPanelProps = props;
        return React.createElement('SourceControlOperationsPanel', props);
    },
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => null,
}));

vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: (props: any) => {
        changedFilesListProps = props;
        return React.createElement('ChangedFilesList', props);
    },
}));

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: () => null,
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: () => null,
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: () => ({
            displayName: 'Git',
            commitActionConfig: () => ({ label: 'Commit' }),
        }),
    },
}));

describe('FilesScreen', () => {
    beforeEach(() => {
        filesToolbarSpy.mockClear();
        routerPushSpy.mockClear();
        gitOperationsPanelProps = null;
        changedFilesListProps = null;
        focusEffectHasRun = false;
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

    it('navigates to commit screen without pre-encoding sha', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(gitOperationsPanelProps).toBeTruthy();

        gitOperationsPanelProps.onOpenCommit('\n32a2a2aba05750117ad36d9386b396fdd5416a2e');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/commit',
            params: {
                id: 'session-1',
                sha: '32a2a2aba05750117ad36d9386b396fdd5416a2e',
            },
        });
    });

    it('sanitizes whitespace-containing commit refs when navigating to the commit screen', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(gitOperationsPanelProps).toBeTruthy();

        // Defensive: Some UIs may pass "oneline" strings by accident; only the first token is a valid ref.
        gitOperationsPanelProps.onOpenCommit('0338a0f chore: stage b.txt');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/commit',
            params: {
                id: 'session-1',
                sha: '0338a0f',
            },
        });
    });

    it('navigates to file screen without pre-encoding path', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(changedFilesListProps).toBeTruthy();

        changedFilesListProps.onFilePress({
            fileName: 'hello world.txt',
            fullPath: 'dir/hello world.txt',
            status: 'modified',
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/file',
            params: {
                id: 'session-1',
                path: 'dir/hello world.txt',
            },
        });
    });
});
