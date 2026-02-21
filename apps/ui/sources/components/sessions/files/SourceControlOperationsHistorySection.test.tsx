import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

function makeEntries(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        sha: `sha-${index + 1}`,
        shortSha: `s${index + 1}`,
        subject: `Commit ${index + 1}`,
        timestamp: 0,
    })) as any[];
}

describe('SourceControlOperationsHistorySection', () => {
    const theme = {
        colors: {
            text: '#fff',
            textSecondary: '#aaa',
            textLink: '#09f',
            divider: '#333',
            surfaceHigh: '#222',
            input: { background: '#111' },
        },
    } as any;

    it('shows 5 commits initially when more can be loaded, then expands when requested', async () => {
        const { SourceControlOperationsHistorySection } = await import('./SourceControlOperationsHistorySection');

        const onLoadMoreHistory = vi.fn();
        const onOpenCommit = vi.fn();

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlOperationsHistorySection
                    theme={theme}
                    historyLoading={false}
                    historyEntries={makeEntries(20)}
                    historyHasMore={true}
                    onLoadMoreHistory={onLoadMoreHistory}
                    onOpenCommit={onOpenCommit}
                />
            );
        });

        const commitRowsBefore = (tree! as any).root.findAll((node: any) => String(node.props?.testID ?? '').startsWith('scm-commit-entry-'));
        expect(commitRowsBefore).toHaveLength(5);

        const loadMore = (tree! as any).root.findAll((node: any) => node.props?.testID === 'scm-commit-load-more');
        expect(loadMore).toHaveLength(1);

        await act(async () => {
            loadMore[0].props.onPress();
        });

        expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

        const commitRowsAfter = (tree! as any).root.findAll((node: any) => String(node.props?.testID ?? '').startsWith('scm-commit-entry-'));
        expect(commitRowsAfter.length).toBeGreaterThan(5);
        expect(commitRowsAfter).toHaveLength(20);
    });

    it('does not hide commits when no more pages are available', async () => {
        const { SourceControlOperationsHistorySection } = await import('./SourceControlOperationsHistorySection');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SourceControlOperationsHistorySection
                    theme={theme}
                    historyLoading={false}
                    historyEntries={makeEntries(10)}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                />
            );
        });

        const commitRows = (tree! as any).root.findAll((node: any) => String(node.props?.testID ?? '').startsWith('scm-commit-entry-'));
        expect(commitRows).toHaveLength(10);

        const loadMore = (tree! as any).root.findAll((node: any) => node.props?.testID === 'scm-commit-load-more');
        expect(loadMore).toHaveLength(0);
    });
});

