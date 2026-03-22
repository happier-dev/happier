import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function toTestIdSafeValue(value: string) {
    return String(value ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

const theme = {
    colors: {
        surface: '#111',
        surfaceHigh: '#222',
        divider: '#333',
        textSecondary: '#aaa',
    },
    dark: false,
} as const;

const sessionScmDiffFileSpy: any = vi.fn(async (_sessionId: string, req: any) => ({
    success: true,
    diff: `diff --git a/${req.path} b/${req.path}\n--- a/${req.path}\n+++ b/${req.path}\n@@ -1 +1 @@\n-old\n+new\n`,
    error: null,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        View: 'View',
                                        Image: 'Image',
                                        Pressable: 'Pressable',
                                        FlatList: 'FlatList',
                                        ScrollView: 'ScrollView',
                                        ActivityIndicator: 'ActivityIndicator',
                                        TextInput: 'TextInput',
                                        Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
                                        useWindowDimensions: () => ({ width: 1200, height: 800 }),
                                        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
                                    }
    );
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        Text: 'Text',
        TextInput: 'TextInput',
    };
});

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/sessions/sourceControl/changes/ScmChangeRow', () => ({
    ScmChangeRow: (props: any) => React.createElement('ScmChangeRow', props),
}));

vi.mock('@/components/ui/code/diff/DiffViewer', () => ({
    DiffViewer: (props: any) => React.createElement('DiffViewer', props),
}));

vi.mock('@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer', () => ({
    DiffReviewCommentsViewer: (props: any) => React.createElement('DiffReviewCommentsViewer', props),
}));

vi.mock('@/components/ui/code/view/CodeLinesView', () => ({
    CodeLinesView: (props: any) => React.createElement('CodeLinesView', props),
}));

vi.mock('@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting', () => ({
    useCodeLinesSyntaxHighlighting: () =>
        React.useMemo(
            () => ({
                mode: 'off',
                language: null,
                maxBytes: 1_000_000,
                maxLines: 10_000,
                maxLineLength: 10_000,
            }),
            [],
        ),
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionScmDiffFile: (sessionId: string, req: any) => sessionScmDiffFileSpy(sessionId, req),
            sessionReadFile: vi.fn(async () => ({ success: false as const, content: '', error: 'nope' })),
        },
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useSetting: (key: string) => {
            if (key === 'wrapLinesInDiffs') return true;
            if (key === 'showLineNumbers') return true;
            if (key === 'filesDiffInlineVirtualizationLineThreshold') return undefined;
            if (key === 'filesDiffInlineVirtualizationByteThreshold') return undefined;
            return undefined;
        },
    });
});

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: () => ({
            diffModeConfig: () => ({
                defaultMode: 'pending',
                availableModes: ['pending'],
                labels: { pending: 'Pending' },
            }),
            errorNormalizer: (err: any) => (err instanceof Error ? err.message : String(err)),
        }),
    },
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewPrefetch', () => ({
    useChangedFilesReviewPrefetch: () => ({
        onViewableItemsChanged: undefined,
        prefetchEnabled: false,
        requestedPaths: undefined,
    }),
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewDiffLoading', () => ({
    useChangedFilesReviewDiffLoading: () => ({
        diffStateSource: {
            getDiffState: (_path: string) => ({ status: 'loaded', diff: 'diff --git a/x b/x\n', error: null }),
            subscribe: () => () => {},
            reset: () => {},
            prune: () => {},
            setDiffState: () => {},
            updateDiffState: () => {},
        },
    }),
}));

vi.mock('@/components/sessions/files/content/review/useScmDiffExpandedKeys', () => ({
    useScmDiffExpandedKeys: (input: any) => ({
        collapsedKeys: new Set<string>(),
        toggleCollapsed: vi.fn(),
        expandedKeys: new Set<string>(Array.isArray(input.allKeys) ? input.allKeys : []),
    }),
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewFocusPath', () => ({
    useChangedFilesReviewFocusPath: () => null,
}));

vi.mock('@/components/sessions/files/content/review/useInitialScrollRestore', () => ({
    useInitialScrollRestore: () => undefined,
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewDiffBlockRenderer', () => ({
    useChangedFilesReviewDiffBlockRenderer: () => (path: string) =>
        React.createElement('View', { testID: `scm-review-diff-${toTestIdSafeValue(path)}` }),
}));

vi.mock('@/components/ui/code/diff/DiffFilesListView', () => ({
    DiffFilesListView: React.forwardRef((props: any, _ref: any) => {
        const data = Array.isArray(props.files) ? props.files : [];
        const header = props.ListHeaderComponent
            ? (typeof props.ListHeaderComponent === 'function' ? props.ListHeaderComponent() : props.ListHeaderComponent)
            : null;

        const rows = data.map((file: any, index: number) => {
            const expanded = props.expandedKeys?.has?.(file.key) === true;
            const row = props.renderFileRow
                ? props.renderFileRow({
                    file,
                    index,
                    expanded,
                    focused: false,
                    onToggleExpanded: () => props.onToggleExpanded?.(file.key),
                })
                : React.createElement('ScmChangeRow', { file, index, expanded, focused: false });
            const inline = props.canRenderInlineDiffs && expanded && props.renderInlineUnifiedDiff
                ? props.renderInlineUnifiedDiff({
                    file,
                    virtualized: false,
                    maxVirtualizedHeight: 0,
                    wrapLines: props.wrapLines,
                    showLineNumbers: props.showLineNumbers,
                    showPrefix: props.showPrefix,
                })
                : null;
            return React.createElement(React.Fragment, { key: file.key }, row, inline);
        });

        return React.createElement('FlashList', props, header, ...rows);
    }),
}));

vi.mock('@/scm/statusSync/projectState', () => ({
    buildSnapshotSignature: () => 'snapshot-sig',
}));

vi.mock('@/scm/diffCache/scmDiffCacheSingleton', () => ({
    scmDiffCache: null,
}));

vi.mock('@/components/sessions/files/changedFiles/ChangedFilesSectionHeader', () => ({
    ChangedFilesSectionHeader: (props: any) => React.createElement('ChangedFilesSectionHeader', props, props.children),
}));

vi.mock('@/components/sessions/files/content/review/ChangedFilesReviewDiffAreaSelector', () => ({
    ChangedFilesReviewDiffAreaSelector: () => React.createElement('ChangedFilesReviewDiffAreaSelector'),
}));

vi.mock('@/scm/review/useScmReviewViewabilityConfig', () => ({
    useScmReviewViewabilityConfig: () => ({
        enabled: false,
        aheadCount: 0,
        behindCount: 0,
        debounceMs: 0,
    }),
}));

vi.mock('@/components/ui/scroll/resolveWebScrollableElement', () => ({
    resolveWebScrollableElement: () => null,
}));

async function renderChangedFilesReview() {
    const { ChangedFilesReview } = await import('./ChangedFilesReview');

    const snapshot = {
        projectKey: 'p',
        fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git' },
        capabilities: { readDiffFile: true },
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 3,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 3,
            pendingRemoved: 0,
        },
    } as any;

    const fileA = { fileName: 'a.ts', filePath: 'src', fullPath: 'src/a.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;
    const fileB = { fileName: 'b.ts', filePath: 'src', fullPath: 'src/b.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;
    const fileC = { fileName: 'c.ts', filePath: 'src', fullPath: 'src/c.ts', status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1 } as any;

    const screen = await renderScreen(
        <ChangedFilesReview
            theme={theme}
            sessionId="session-1"
            snapshot={snapshot}
            changedFilesViewMode="repository"
            attributionReliability="high"
            allRepositoryChangedFiles={[fileA, fileB, fileC]}
            sessionAttributedFiles={[]}
            repositoryOnlyFiles={[]}
            suppressedInferredCount={0}
            maxFiles={1}
            maxChangedLines={2000}
            onFilePress={vi.fn()}
        />,
    );
    await flushHookEffects({ cycles: 2 });
    return screen;
}

describe('ChangedFilesReview (tooLarge behavior)', () => {
    beforeEach(() => {
        sessionScmDiffFileSpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps diff rows expanded by default even when tooLarge', async () => {
        const screen = await renderChangedFilesReview();

        const diffTestIds = screen.findAll((node) =>
            typeof node.props?.testID === 'string' && node.props.testID.startsWith('scm-review-diff-'),
        ).map((node) => node.props.testID);

        expect(diffTestIds).toContain('scm-review-diff-src_a.ts');
        expect(diffTestIds).toContain('scm-review-diff-src_b.ts');
        expect(diffTestIds).toContain('scm-review-diff-src_c.ts');
    });
});
