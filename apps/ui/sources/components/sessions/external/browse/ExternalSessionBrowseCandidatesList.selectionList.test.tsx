import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createCapturingLegendListMock, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

vi.mock('@/text', () => ({ t: (key: string) => key }));

const candidate = {
    remoteSessionId: 'session-1',
    title: 'Existing session',
    updatedAtMs: 1_700_000_000_000,
    activity: 'idle' as const,
    details: { path: '/repo' },
};

function defaultProps() {
    return {
        candidates: [candidate],
        loading: false,
        error: null,
        offline: false,
        nextCursor: 'cursor-1',
        loadingMore: false,
        searchAugmenting: false,
        searchIncomplete: false,
        preparation: null,
        linkingSessionId: null,
        searchQuery: '',
        onSearchQueryChange: vi.fn(),
        onSelectCandidate: vi.fn(),
        onLoadMore: vi.fn(),
        onRetry: vi.fn(),
        onCancelPreparation: vi.fn(),
    } as const;
}

describe('ExternalSessionBrowseCandidatesList SelectionList shell', () => {
    it('keeps loaded candidates mounted when the next page fails and retries inline', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            error="Next page failed"
        />);

        expect(screen.findByTestId('direct-session-candidate:session-1')).not.toBeNull();
        expect(screen.findByTestId('direct-session-candidates:pagination:error')).not.toBeNull();
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:retry');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it('uses automatic end reach without rendering a manual Load More row', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList {...props} />);

        expect(screen.findByTestId('direct-session-candidates-load-more')).toBeNull();
        legendListState.props?.onEndReached?.();
        legendListState.props?.onEndReached?.();
        expect(props.onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('renders an actionable offline state instead of an empty list', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            error="Machine offline"
            offline
            nextCursor={null}
        />);

        expect(screen.findByTestId('direct-session-candidates:offline')).not.toBeNull();
        await screen.pressByTestIdAsync('direct-session-candidates:offline-action');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it('orients an empty result with safe Agent and source display labels', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            nextCursor={null}
            agentLabel="Claude Code"
            sourceLabel="Default Claude config"
        />);

        const empty = screen.findByTestId('direct-session-candidates:empty');
        expect(empty?.findAllByProps({
            children: 'externalSessions.browseNoCandidates\nClaude Code · Default Claude config',
        }).length).toBeGreaterThan(0);
    });

    it('keeps an empty cursor page actionable instead of stranding its continuation', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            nextCursor="cursor-after-empty-page"
        />);

        expect(screen.findByTestId('direct-session-candidates:empty-continuation')).not.toBeNull();
        await screen.pressByTestIdAsync('direct-session-candidates:empty-continuation-action');
        expect(props.onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('renders mounted cold-index progress instead of an empty result', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            loading
            nextCursor={null}
            preparation={{
                kind: 'building_candidate_index',
                scanned: 50,
                total: 100,
            }}
        />);

        const progress = screen.findByTestId('direct-session-candidates:indexing');
        expect(progress).not.toBeNull();
        expect(progress?.props.accessibilityLabel).toBe('externalSessions.browseIndexingProgress');
        expect(progress?.findAllByProps({
            testID: 'direct-session-candidates:indexing:cancel',
        })).toHaveLength(0);
        expect(screen.findByTestId('direct-session-candidates:loading')).toBeNull();
        await screen.pressByTestIdAsync('direct-session-candidates:indexing:cancel');
        expect(props.onCancelPreparation).toHaveBeenCalledTimes(1);
    });

    it('renders accessible bounded indeterminate progress when the total is unknown', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            loading
            nextCursor={null}
            preparation={{
                kind: 'building_candidate_index',
                scanned: 50,
            }}
        />);

        const progress = screen.findByTestId('direct-session-candidates:indexing');
        expect(progress?.props.accessibilityRole).toBe('progressbar');
        expect(progress?.props.accessibilityLabel).toBe('externalSessions.browseIndexing');
        expect(progress?.props.accessibilityValue).toBeUndefined();
        expect(progress?.props.accessibilityLiveRegion).toBe('polite');
    });

    it('selects the project-qualified candidate by its opaque daemon key', async () => {
        const props = defaultProps();
        const projectACandidate = {
            ...candidate,
            candidateKey: 'project-a-key',
            linkData: { projectId: 'project-a' },
        };
        const projectBCandidate = {
            ...candidate,
            candidateKey: 'project-b-key',
            linkData: { projectId: 'project-b' },
        };
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[projectACandidate, projectBCandidate]}
        />);

        await screen.pressByTestIdAsync('direct-session-candidate:project-b-key');

        expect(props.onSelectCandidate).toHaveBeenCalledWith(projectBCandidate);
    });
});
