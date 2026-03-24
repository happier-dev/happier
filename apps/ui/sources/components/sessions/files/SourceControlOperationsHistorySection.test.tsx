import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionFilesCommonModuleMocks } from './sessionFilesTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionFilesCommonModuleMocks();

function makeEntries(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        sha: `sha-${index + 1}`,
        shortSha: `s${index + 1}`,
        subject: `Commit ${index + 1}`,
        timestamp: 0,
    })) as any[];
}

function getCommitRows(screen: { findAllByTestId: (testID: string) => unknown[] }, count: number) {
    return Array.from({ length: count }, (_, index) => `scm-commit-entry-sha-${index + 1}`)
        .flatMap((testID) => screen.findAllByTestId(testID));
}

describe('SourceControlOperationsHistorySection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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

        const screen = await renderScreen(<SourceControlOperationsHistorySection
                    theme={theme}
                    historyLoading={false}
                    historyEntries={makeEntries(20)}
                    historyHasMore={true}
                    onLoadMoreHistory={onLoadMoreHistory}
                    onOpenCommit={onOpenCommit}
                />);

        const commitRowsBefore = getCommitRows(screen, 5);
        expect(commitRowsBefore).toHaveLength(5);

        const loadMore = screen.findAllByTestId('scm-commit-load-more');
        expect(loadMore).toHaveLength(1);

        await act(async () => {
            await pressTestInstanceAsync(loadMore[0]);
        });

        expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

        const commitRowsAfter = getCommitRows(screen, 20);
        expect(commitRowsAfter.length).toBeGreaterThan(5);
        expect(commitRowsAfter).toHaveLength(20);
    });

    it('does not hide commits when no more pages are available', async () => {
        const { SourceControlOperationsHistorySection } = await import('./SourceControlOperationsHistorySection');

        const screen = await renderScreen(<SourceControlOperationsHistorySection
                    theme={theme}
                    historyLoading={false}
                    historyEntries={makeEntries(10)}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                />);

        const commitRows = getCommitRows(screen, 10);
        expect(commitRows).toHaveLength(10);

        const loadMore = screen.findAllByTestId('scm-commit-load-more');
        expect(loadMore).toHaveLength(0);
    });
});
