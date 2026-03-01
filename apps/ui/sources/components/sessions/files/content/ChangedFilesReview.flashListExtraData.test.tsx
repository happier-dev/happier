import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { lightTheme } from '@/theme';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function toTestIdSafeValue(value: string): string {
    return value.trim().replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Simulate FlashList's optimization: skip re-render when `data` and `extraData` are referentially equal.
vi.mock('@shopify/flash-list', () => {
    const FlashList = React.memo(
        (props: any) => {
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
        },
        (prev: any, next: any) => prev.data === next.data && prev.extraData === next.extraData
    );

    return { FlashList };
});

// Note: Vitest setup already stubs `react-native`, `@expo/vector-icons`, and `react-native-unistyles`.

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
        getDiffState: (_path: string) => ({ kind: 'ready', patch: 'diff --git a/x b/x\n' }),
    }),
}));

vi.mock('@/components/sessions/files/content/review/useChangedFilesReviewDiffBlockRenderer', () => ({
    useChangedFilesReviewDiffBlockRenderer: () => (path: string) =>
        React.createElement('View', { testID: `scm-review-diff-${toTestIdSafeValue(path)}` }),
}));

// Avoid importing SCM project state (which pulls in sync/storage singletons) for this focused unit test.
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

describe('ChangedFilesReview (FlashList extraData)', () => {
    it('re-renders visible rows when collapsed paths change', async () => {
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
                    onFilePressPinned={() => {}}
                />,
            );
        });

        const list = tree!.root.findByType('FlashList' as any);
        expect(list.props.extraData).toBeDefined();

        expect(tree!.root.findAllByProps({ testID: `scm-review-diff-${toTestIdSafeValue(file.fullPath)}` })).toHaveLength(1);

        const row = tree!.root.findByProps({ testID: `scm-change-row-${toTestIdSafeValue(file.fullPath)}` });
        await act(async () => {
            row.props.onPress();
        });

        expect(tree!.root.findAllByProps({ testID: `scm-review-diff-${toTestIdSafeValue(file.fullPath)}` })).toHaveLength(0);
    });

    it('configures FlashList with stable virtualization settings', async () => {
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
                />,
            );
        });

        const list = tree!.root.findByType('FlashList' as any);
        expect(typeof list.props.drawDistance).toBe('number');
        expect(Number.isFinite(list.props.drawDistance)).toBe(true);
        expect(list.props.drawDistance).toBeGreaterThan(0);

        expect(typeof list.props.getItemType).toBe('function');
        expect(list.props.getItemType({ kind: 'section' }, 0)).toBe('section');
        expect(list.props.getItemType({ kind: 'file' }, 0)).toBe('file');
    });
});
