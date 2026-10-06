import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installSessionFilesCommonModuleMocks } from './sessionFilesTestHelpers';
import { SourceControlOperationsHistorySection } from '@/components/workspaces/scm/SourceControlOperationsHistorySection';
import { ScmTimelineGutter } from '@/components/workspaces/scm/history/ScmTimelineGutter';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionFilesCommonModuleMocks({
    typography: async () => await vi.importActual('@/constants/Typography'),
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function makeEntries(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        sha: `sha-${index + 1}`,
        shortSha: `s${index + 1}`,
        subject: `Commit ${index + 1}`,
        timestamp: 0,
    })) as any[];
}

function getCommitRows(screen: { findAllHostsByTestId: (testID: string) => unknown[] }, count: number) {
    return Array.from({ length: count }, (_, index) => `scm-commit-entry-sha-${index + 1}`)
        .flatMap((testID) => screen.findAllHostsByTestId(testID));
}

describe('SourceControlOperationsHistorySection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    const theme = {
        colors: {
            text: {
                primary: '#fff',
                secondary: '#aaa',
                link: '#09f',
            },
            divider: '#333',
            border: { default: '#333' },
            surface: {
                base: '#222',
                inset: '#111',
            },
            surfaceHigh: '#222',
            input: { background: '#111' },
        },
    } as any;

    it('shows more commits initially when more can be loaded, then expands when requested', async () => {

        const onLoadMoreHistory = vi.fn();
        const onOpenCommit = vi.fn();

        const screen = await renderScreen(<SourceControlOperationsHistorySection
                    theme={theme}
                    historyIdentity="repo-a"
                    historyLoading={false}
                    historyEntries={makeEntries(20)}
                    historyHasMore={true}
                    onLoadMoreHistory={onLoadMoreHistory}
                    onOpenCommit={onOpenCommit}
                />);

        const commitRowsBefore = getCommitRows(screen, 12);
        expect(commitRowsBefore).toHaveLength(12);

        // HEAD is now identified by the timeline's emphasized point, not a separate badge.
        const headPoints = screen.findAllByType(ScmTimelineGutter).filter((point) => point.props.tone === 'head');
        expect(headPoints).toHaveLength(1);
        expect(headPoints[0]?.props.testID).toBe('scm-commit-entry-sha-1-when');

        const loadMore = screen.findAllHostsByTestId('scm-commit-load-more');
        expect(loadMore).toHaveLength(1);

        await act(async () => {
            await pressTestInstanceAsync(loadMore[0]);
        });

        expect(onLoadMoreHistory).toHaveBeenCalledTimes(1);

        const commitRowsAfter = getCommitRows(screen, 20);
        expect(commitRowsAfter.length).toBeGreaterThan(12);
        expect(commitRowsAfter).toHaveLength(20);
    });

    it('does not hide commits when no more pages are available', async () => {

        const screen = await renderScreen(<SourceControlOperationsHistorySection
                    theme={theme}
                    historyIdentity="repo-a"
                    historyLoading={false}
                    historyEntries={makeEntries(10)}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={vi.fn()}
                />);

        const commitRows = getCommitRows(screen, 10);
        expect(commitRows).toHaveLength(10);

        const loadMore = screen.findAllHostsByTestId('scm-commit-load-more');
        expect(loadMore).toHaveLength(0);
    });

    it('reveals more already-loaded commits without requesting another page', async () => {

        const onLoadMoreHistory = vi.fn();
        const screen = await renderScreen(<SourceControlOperationsHistorySection
                    theme={theme}
                    historyIdentity="repo-a"
                    historyLoading={false}
                    historyEntries={makeEntries(40)}
                    historyHasMore={true}
                    onLoadMoreHistory={onLoadMoreHistory}
                    onOpenCommit={vi.fn()}
                />);

        const loadMore = screen.findAllHostsByTestId('scm-commit-load-more');
        expect(loadMore).toHaveLength(1);

        await act(async () => {
            await pressTestInstanceAsync(loadMore[0]);
        });

        expect(getCommitRows(screen, 37)).toHaveLength(37);
        expect(onLoadMoreHistory).not.toHaveBeenCalled();
    });

    it('opens commit details from timeline rows', async () => {

        const onOpenCommit = vi.fn();
        const screen = await renderScreen(<SourceControlOperationsHistorySection
                    theme={theme}
                    historyIdentity="repo-a"
                    historyLoading={false}
                    historyEntries={makeEntries(3)}
                    historyHasMore={false}
                    onLoadMoreHistory={vi.fn()}
                    onOpenCommit={onOpenCommit}
                />);

        const firstCommit = screen.findAllHostsByTestId('scm-commit-entry-sha-1');
        expect(firstCommit).toHaveLength(1);

        await act(async () => {
            await pressTestInstanceAsync(firstCommit[0]);
        });

        expect(onOpenCommit).toHaveBeenCalledWith('sha-1');
    });    it('retains expanded commits across a prepended head and resets for another history identity', async () => {
        const entries = makeEntries(50);
        const props = { theme, historyIdentity: 'repo-a', historyLoading: false, historyEntries: entries,
            historyHasMore: false, onLoadMoreHistory: vi.fn(), onOpenCommit: vi.fn() };
        const screen = await renderScreen(<SourceControlOperationsHistorySection {...props} />);
        await screen.pressByTestIdAsync('scm-commit-load-more');
        expect(screen.findByTestId('scm-commit-entry-sha-37')).not.toBeNull();
        await screen.update(<SourceControlOperationsHistorySection {...props}
            historyEntries={[{ ...entries[0], sha: 'new-head' }, ...entries]} />);
        expect(screen.findByTestId('scm-commit-entry-sha-37')).not.toBeNull();
        expect(screen.findByTestId('scm-commit-entry-sha-38')).toBeNull();
        await screen.update(<SourceControlOperationsHistorySection {...props} historyIdentity="repo-b" />);
        expect(screen.findByTestId('scm-commit-entry-sha-12')).not.toBeNull();
        expect(screen.findByTestId('scm-commit-entry-sha-13')).toBeNull();
    });

});
