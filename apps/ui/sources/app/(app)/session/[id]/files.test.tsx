import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const filesToolbarSpy = vi.fn();
const routerPushSpy = vi.fn();
let mockLocalSearchParams: Record<string, any> = {};
let sourceControlOperationsPanelProps: any = null;
let changedFilesListProps: any = null;
let changedFilesReviewProps: any = null;
let repositoryTreeListProps: any = null;
let focusEffectHasRun = false;
const clearCommitSelectionPathsSpy = vi.fn();
const clearCommitSelectionPatchesSpy = vi.fn();
const setRepositoryTreeExpandedPathsSpy = vi.fn();
let mockScmSnapshot: any = null;
let mockScmSnapshotError: any = null;
let mockSessionPath: string | null = '/repo';
let mockSessionActive = true;
let mockShouldShowAllFiles = false;
const invalidateAndAwaitSpy = vi.fn(async () => {});
let sourceControlUnavailableStateProps: any = null;

vi.mock('react-native', () => {
    const platform = {
        OS: 'node',
        select: (value: any) => value?.[platform.OS] ?? value?.default ?? value?.web ?? value?.ios ?? value?.android,
    };

    return {
        View: 'View',
        ActivityIndicator: 'ActivityIndicator',
        Platform: platform,
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
    StyleSheet: { create: (value: any) => (typeof value === 'function' ? value() : value) },
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
    useLocalSearchParams: () => mockLocalSearchParams,
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
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
            invalidateAndAwait: invalidateAndAwaitSpy,
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
                        path: mockSessionPath,
                    },
                },
            },
            clearSessionProjectScmCommitSelectionPaths: clearCommitSelectionPathsSpy,
            clearSessionProjectScmCommitSelectionPatches: clearCommitSelectionPatchesSpy,
            setSessionRepositoryTreeExpandedPaths: setRepositoryTreeExpandedPathsSpy,
        }),
    },
    useSession: () => (mockSessionPath
        ? ({ metadata: { path: mockSessionPath }, active: mockSessionActive } as any)
        : null),
    useMachine: () => null,
    useSessionProjectScmOperationLog: () => [],
    useSessionProjectScmInFlightOperation: () => null,
    useSessionProjectScmSnapshot: () => mockScmSnapshot,
    useSessionProjectScmSnapshotError: () => mockScmSnapshotError,
    useSessionProjectScmCommitSelectionPaths: () => [],
    useSessionProjectScmCommitSelectionPatches: () => [{ path: 'a.txt', patch: 'diff --git a/a.txt b/a.txt\n' }],
    useSessionProjectScmTouchedPaths: () => [],
    useSessionRepositoryTreeExpandedPaths: () => [],
    useProjectForSession: () => ({ id: 'project-1' }),
    useProjectSessions: () => ['session-1', 'session-2'],
    useSetting: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: () => ({
        attributionReliability: 'limited',
        showSessionViewToggle: false,
        scmStatusFiles: {
            branch: 'main',
            hasChanges: true,
            totalIncluded: 0,
            totalPending: 1,
            files: [],
        },
        changedFilesCount: 1,
        shouldShowAllFiles: mockShouldShowAllFiles,
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
        sourceControlOperationsPanelProps = props;
        return React.createElement('SourceControlOperationsPanel', props);
    },
}));

vi.mock('@/components/sessions/files/content/SearchResultsList', () => ({
    SearchResultsList: () => null,
}));

vi.mock('@/components/sessions/files/content/RepositoryTreeList', () => ({
    RepositoryTreeList: (props: any) => {
        repositoryTreeListProps = props;
        return React.createElement('RepositoryTreeList', props);
    },
}));

vi.mock('@/components/sessions/files/content/ChangedFilesList', () => ({
    ChangedFilesList: (props: any) => {
        changedFilesListProps = props;
        return React.createElement('ChangedFilesList', props);
    },
}));

vi.mock('@/components/sessions/files/content/ChangedFilesReview', () => ({
    ChangedFilesReview: (props: any) => {
        changedFilesReviewProps = props;
        return React.createElement('ChangedFilesReview', props);
    },
}));

vi.mock('@/components/sessions/sourceControl/states', () => ({
    NotSourceControlRepositoryState: () => React.createElement('NotSourceControlRepositoryState'),
    SourceControlUnavailableState: (props: any) => {
        sourceControlUnavailableStateProps = props;
        return React.createElement('SourceControlUnavailableState', props);
    },
    SourceControlSessionInactiveState: () => React.createElement('SourceControlSessionInactiveState'),
}));

describe('FilesScreen', () => {
    beforeEach(() => {
        filesToolbarSpy.mockClear();
        routerPushSpy.mockClear();
        mockLocalSearchParams = {};
        clearCommitSelectionPathsSpy.mockClear();
        clearCommitSelectionPatchesSpy.mockClear();
        setRepositoryTreeExpandedPathsSpy.mockClear();
        sourceControlOperationsPanelProps = null;
        changedFilesListProps = null;
        changedFilesReviewProps = null;
        repositoryTreeListProps = null;
        focusEffectHasRun = false;
        mockSessionPath = '/repo';
        mockSessionActive = true;
        invalidateAndAwaitSpy.mockClear();
        mockScmSnapshot = {
            repo: { isRepo: true, rootPath: '/repo' },
            branch: { head: 'main', detached: false },
            hasConflicts: false,
            capabilities: {},
        };
        mockScmSnapshotError = null;
        sourceControlUnavailableStateProps = null;
        mockShouldShowAllFiles = false;
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

        expect(sourceControlOperationsPanelProps).toBeTruthy();

        sourceControlOperationsPanelProps.onOpenCommit('\n32a2a2aba05750117ad36d9386b396fdd5416a2e');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/commit',
            params: {
                id: 'session-1',
                sha: '32a2a2aba05750117ad36d9386b396fdd5416a2e',
            },
        });
    });

    it('applies deep-link params to open changed-files review mode', async () => {
        mockLocalSearchParams = {
            presentation: 'review',
            focusPath: 'src/example.ts',
        };

        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        // Toolbar reflects the deep-linked presentation.
        const lastToolbarProps = filesToolbarSpy.mock.calls.at(-1)?.[0];
        expect(lastToolbarProps?.changedFilesPresentation).toBe('review');

        // Review renderer receives the focus path so it can scroll + highlight.
        expect(changedFilesReviewProps).toBeTruthy();
        expect(changedFilesReviewProps.focusPath).toBe('src/example.ts');
    });

    it('sanitizes whitespace-containing commit refs when navigating to the commit screen', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(sourceControlOperationsPanelProps).toBeTruthy();

        // Defensive: Some UIs may pass "oneline" strings by accident; only the first token is a valid ref.
        sourceControlOperationsPanelProps.onOpenCommit('0338a0f chore: stage b.txt');

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

    it('switches to review mode when the toolbar requests it', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(changedFilesListProps).toBeTruthy();
        expect(changedFilesReviewProps).toBeNull();

        const toolbarProps = filesToolbarSpy.mock.calls
            .map((call) => call[0])
            .find((props) => typeof props?.onChangedFilesPresentationChange === 'function');
        expect(typeof toolbarProps?.onChangedFilesPresentationChange).toBe('function');

        await act(async () => {
            toolbarProps.onChangedFilesPresentationChange('review');
        });
        await act(async () => {});

        expect(changedFilesReviewProps).toBeTruthy();
    });

    it('shows commit selection state when only patch selection exists and clears both stores', async () => {
        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(sourceControlOperationsPanelProps).toBeTruthy();
        expect(sourceControlOperationsPanelProps.commitSelectionCount).toBe(1);
        expect(typeof sourceControlOperationsPanelProps.onClearCommitSelection).toBe('function');

        sourceControlOperationsPanelProps.onClearCommitSelection();
        expect(clearCommitSelectionPathsSpy).toHaveBeenCalledWith('session-1');
        expect(clearCommitSelectionPatchesSpy).toHaveBeenCalledWith('session-1');
    });

    it('renders a source-control unavailable state when snapshot refresh errors and no snapshot is available', async () => {
        mockScmSnapshot = null;
        mockScmSnapshotError = { message: 'Session RPC unavailable', at: 1 };

        const Screen = (await import('./files')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(tree!.root.findAllByType('SourceControlUnavailableState').length).toBe(1);
    });

    it('renders a session-inactive state when session is inactive and snapshot fetch fails', async () => {
        mockScmSnapshot = null;
        mockScmSnapshotError = { message: 'RPC method not available', at: 1 };
        mockSessionActive = false;

        const Screen = (await import('./files')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(tree!.root.findAllByType('SourceControlSessionInactiveState').length).toBe(1);
    });

    it('renders a cli-update hint when scm is unsupported (method not available)', async () => {
        const { SCM_OPERATION_ERROR_CODES } = await import('@happier-dev/protocol');
        mockScmSnapshot = null;
        mockScmSnapshotError = {
            message: 'RPC method not available',
            at: 1,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        };

        const Screen = (await import('./files')).default;

        await act(async () => {
            renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(sourceControlUnavailableStateProps?.details).toBe('deps.installNotSupported');
        expect(typeof sourceControlUnavailableStateProps?.onRetry).toBe('function');
    });

    it('refreshes scm snapshot once session path becomes available after first render', async () => {
        mockSessionPath = null;

        const Screen = (await import('./files')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        expect(invalidateAndAwaitSpy).toHaveBeenCalledTimes(0);

        mockSessionPath = '/repo';
        await act(async () => {
            tree!.update(<Screen />);
        });
        await act(async () => {});

        expect(invalidateAndAwaitSpy).toHaveBeenCalledTimes(1);
    });

    it('renders repository tree in all-files view when search query is empty', async () => {
        const Screen = (await import('./files')).default;

        mockShouldShowAllFiles = true;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        // Switch to "All repository files" (search query stays empty).
        const toolbarProps = filesToolbarSpy.mock.calls.at(-1)?.[0];
        expect(toolbarProps).toBeTruthy();
        await act(async () => {
            toolbarProps.onShowAllRepositoryFiles();
        });
        await act(async () => {
            tree!.update(<Screen />);
        });
        await act(async () => {});

        expect(repositoryTreeListProps).toBeTruthy();
        expect(repositoryTreeListProps.sessionId).toBe('session-1');
    });

    it('renders the operations panel inside the scroll container so the screen can scroll naturally', async () => {
        const Screen = (await import('./files')).default;

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<Screen />);
        });
        await act(async () => {});

        const list = tree!.root.findByType('ItemList');
        expect(list.findAllByType('SourceControlOperationsPanel').length).toBe(1);
    });

    it('sets minHeight: 0 on web so the screen can scroll within flex layouts', async () => {
        vi.resetModules();

        const rn = await import('react-native');
        const originalPlatformOs = rn.Platform.OS;
        (rn.Platform as unknown as { OS: string }).OS = 'web';

        const Screen = (await import('./files')).default;

        try {
            let tree: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(<Screen />);
            });
            await act(async () => {});

            const viewNodes = tree!.root.findAllByType('View');
            expect(viewNodes.length).toBeGreaterThan(0);
            const rootView = viewNodes.find((node) => {
                const styleProp = node.props?.style;
                const entries = Array.isArray(styleProp) ? styleProp : [styleProp];
                return entries.some((entry: any) => entry?.maxWidth === 999);
            });
            expect(rootView).toBeTruthy();

            const rootStyleProp = rootView!.props?.style;
            const rootEntries = Array.isArray(rootStyleProp) ? rootStyleProp : [rootStyleProp];
            expect(rootEntries.some((entry: any) => entry?.minHeight === 0)).toBe(true);
        } finally {
            (rn.Platform as unknown as { OS: string }).OS = originalPlatformOs;
            vi.resetModules();
        }
    });
});
