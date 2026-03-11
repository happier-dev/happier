import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SLOW_TEST_TIMEOUT_MS = 60_000;

function toTestIdSafeValue(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

const clearLayoutCacheOnUpdate = vi.fn();

vi.mock('@shopify/flash-list', () => {
    const FlashList = React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            clearLayoutCacheOnUpdate,
            scrollToIndex: vi.fn(),
            getScrollableNode: () => null,
            recomputeViewableItems: vi.fn(),
        }));

        const headerProp = props.ListHeaderComponent ?? null;
        const header = React.isValidElement(headerProp)
            ? headerProp
            : headerProp
                ? React.createElement(headerProp as any)
                : null;
        const items = (props.data ?? []).map((item: any, index: number) =>
            props.renderItem({ item, index })
        );
        return React.createElement('FlashList', props, header, ...items);
    });

    return { FlashList };
});

vi.mock('react-native', async (importOriginal) => {
    const rn = await importOriginal<typeof import('react-native')>();
    return {
        ...rn,
        Platform: {
            ...(rn as any).Platform,
            OS: 'web',
            select: (value: any) => value?.web ?? value?.default ?? null,
        },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider', () => ({
    PierreScrollRootVirtualizerProvider: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/scm/registry/scmUiBackendRegistry', () => ({
    scmUiBackendRegistry: {
        getPluginForSnapshot: () => ({
            diffModeConfig: () => ({ defaultMode: 'pending', availableModes: ['pending'], labels: { pending: 'Pending' } }),
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

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewDiffBlockRenderer', () => ({
    useChangedFilesReviewDiffBlockRenderer: () => (path: string) =>
        React.createElement('View', { testID: `scm-review-diff-${toTestIdSafeValue(path)}` }),
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

describe('ChangedFilesReview (FlashList layout cache)', () => {
    it('clears FlashList layout cache before expanding a row', async () => {
        clearLayoutCacheOnUpdate.mockClear();

        const { ChangedFilesReview } = await import('./ChangedFilesReview');

        const file = {
            fullPath: 'src/file-10.txt',
            filePath: 'src',
            fileName: 'file-10.txt',
            status: 'modified',
            linesAdded: 1,
            linesRemoved: 0,
            isIncluded: false,
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ChangedFilesReview
                    theme={lightTheme}
                    sessionId="s1"
                    snapshot={{
                        repo: { isRepo: true, backendId: 'git' },
                        entries: [],
                        totals: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0 },
                    } as any}
                    changedFilesViewMode="repository"
                    attributionReliability="high"
                    allRepositoryChangedFiles={[file]}
                    sessionAttributedFiles={[]}
                    repositoryOnlyFiles={[]}
                    suppressedInferredCount={0}
                    maxFiles={25}
                    maxChangedLines={2000}
                    onFilePress={() => {}}
                    initialCollapsedPaths={[file.fullPath]}
                />,
            );
        });

        const row = tree!.root.findByProps({ testID: `scm-change-row-${toTestIdSafeValue(file.fullPath)}` });
        await act(async () => {
            if (typeof row.props.onPress === 'function') {
                row.props.onPress();
            } else if (typeof row.props.onClick === 'function') {
                row.props.onClick();
            } else {
                throw new Error('Expected ScmChangeRow to be pressable/clickable');
            }
        });

        expect(clearLayoutCacheOnUpdate).toHaveBeenCalledTimes(1);
    }, SLOW_TEST_TIMEOUT_MS);
});
