import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCapturingLegendListMock, renderScreen } from '@/dev/testkit';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

const accessibilityPlatform = vi.hoisted(() => ({
    os: 'web' as 'web' | 'ios' | 'android',
}));
const announceForAccessibilityMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const base = await createReactNativeWebMock();
    return {
        ...base,
        AccessibilityInfo: {
            ...base.AccessibilityInfo,
            announceForAccessibility: announceForAccessibilityMock,
        },
        Platform: {
            ...base.Platform,
            get OS() {
                return accessibilityPlatform.os;
            },
        },
    };
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    renderItemLimit: 20,
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

type CandidatePresentationReadCounts = {
    candidateKey: number;
    title: number;
    details: number;
    updatedAtMs: number;
    activity: number;
};

function createInstrumentedCandidates(
    count: number,
    reads: CandidatePresentationReadCounts,
) {
    return Array.from({ length: count }, (_, index) => {
        const candidateWithGetters: {
            remoteSessionId: string;
            candidateKey: string;
            title: string;
            updatedAtMs: number;
            activity: 'idle';
            details: { path: string };
            linkedSessionId?: string;
            imported?: boolean;
        } = {
            remoteSessionId: `session-${index}`,
            candidateKey: `candidate-${index}`,
            title: `Session ${index}`,
            updatedAtMs: 0,
            activity: 'idle',
            details: { path: `/repo/project-${index % 4}` },
            linkedSessionId: index % 2 === 0 ? `linked-${index}` : undefined,
            imported: index % 3 === 0,
        };
        Object.defineProperties(candidateWithGetters, {
            candidateKey: {
                enumerable: true,
                get: () => {
                    reads.candidateKey += 1;
                    return `candidate-${index}`;
                },
            },
            title: {
                enumerable: true,
                get: () => {
                    reads.title += 1;
                    return `Session ${index}`;
                },
            },
            details: {
                enumerable: true,
                get: () => {
                    reads.details += 1;
                    return { path: `/repo/project-${index % 4}` };
                },
            },
            updatedAtMs: {
                enumerable: true,
                get: () => {
                    reads.updatedAtMs += 1;
                    return 1_700_000_000_000 + index;
                },
            },
            activity: {
                enumerable: true,
                get: () => {
                    reads.activity += 1;
                    return 'idle' as const;
                },
            },
        });
        return candidateWithGetters;
    });
}

function defaultProps() {
    return {
        candidates: [candidate],
        loading: false,
        error: null,
        offline: false,
        nextCursor: 'cursor-1',
        paginationRequestKey: 'scope-default\u0000cursor-1',
        loadingMore: false,
        searchAugmenting: false,
        searchIncomplete: false,
        annotationsIncomplete: false,
        preparation: null,
        linkingSessionId: null,
        searchQuery: '',
        onSearchQueryChange: vi.fn(),
        selectionAuthorityGeneration: 0,
        onSelectCandidate: vi.fn(),
        onLoadMore: vi.fn(),
        onRetry: vi.fn(),
        onCancelPreparation: vi.fn(),
    } as const;
}

describe('ExternalSessionBrowseCandidatesList SelectionList shell', () => {
    beforeEach(() => {
        accessibilityPlatform.os = 'web';
        announceForAccessibilityMock.mockClear();
    });

    it('keeps candidate options and pending-state projection within the virtualized window', async () => {
        const props = defaultProps();
        const reads: CandidatePresentationReadCounts = {
            candidateKey: 0,
            title: 0,
            details: 0,
            updatedAtMs: 0,
            activity: 0,
        };
        const candidates = createInstrumentedCandidates(10_000, reads);
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={candidates}
            agentId="claude"
        />);

        expect(screen.findAllByType('LegendListItem' as never)).toHaveLength(20);
        // Project grouping is structural and may read every candidate path. The
        // rest of the candidate projection must stay inside the mounted window.
        expect(reads.details).toBe(10_000);
        expect(reads.candidateKey).toBeLessThan(200);
        expect(reads.title).toBeLessThan(200);
        expect(reads.updatedAtMs).toBeLessThan(200);
        expect(reads.activity).toBeLessThan(200);

        reads.candidateKey = 0;
        reads.title = 0;
        reads.details = 0;
        reads.updatedAtMs = 0;
        reads.activity = 0;
        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={candidates}
            agentId="claude"
            linkingSessionId="candidate-5000"
        />);

        expect(reads.details).toBe(0);
        expect(reads.candidateKey).toBeLessThan(200);
        expect(reads.title).toBeLessThan(200);
        expect(reads.updatedAtMs).toBeLessThan(200);
        expect(reads.activity).toBeLessThan(200);
    });

    it('preserves first-seen project grouping before virtualizing candidates', async () => {
        const props = defaultProps();
        const candidates = [
            { ...candidate, remoteSessionId: 'project-a-first', candidateKey: 'project-a-first', details: { path: '/repo/a' } },
            { ...candidate, remoteSessionId: 'project-b-only', candidateKey: 'project-b-only', details: { path: '/repo/b' } },
            { ...candidate, remoteSessionId: 'project-a-second', candidateKey: 'project-a-second', details: { path: '/repo/a' } },
        ];
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={candidates}
        />);

        expect(screen.findByTestId('direct-session-candidates:section:project:/repo/a:header')).not.toBeNull();
        expect(screen.findByTestId('direct-session-candidates:section:project:/repo/b:header')).not.toBeNull();
        const candidateOrder = Array.from(new Set(screen.tree.root.findAll(
            (node) => typeof node.props?.testID === 'string'
                && node.props.testID.startsWith('direct-session-candidate:'),
        ).map((node) => node.props.testID)));
        expect(candidateOrder).toEqual([
            'direct-session-candidate:project-a-first',
            'direct-session-candidate:project-a-second',
            'direct-session-candidate:project-b-only',
        ]);
    });

    it('retains lazy candidate visuals when linking state updates the mounted row', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList {...props} />);

        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            linkingSessionId="session-1"
        />);

        const optionRow = screen.findByTestId('direct-session-candidate:session-1');
        expect(optionRow?.props.disabled).toBe(true);
    });

    it('skips a pending candidate during keyboard navigation and activates the next grouped row', async () => {
        const props = defaultProps();
        const candidates = [
            { ...candidate, remoteSessionId: 'session-a', candidateKey: 'candidate-a' },
            { ...candidate, remoteSessionId: 'session-b', candidateKey: 'candidate-b' },
            { ...candidate, remoteSessionId: 'session-c', candidateKey: 'candidate-c' },
        ];
        const { act } = await import('react-test-renderer');
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={candidates}
            linkingSessionId="candidate-b"
        />);
        const keyboardHost = screen
            .findAllByTestId('direct-session-candidates:header')
            .find((node) => typeof node.props?.onKeyPress === 'function');
        expect(keyboardHost).toBeDefined();

        await act(async () => {
            (keyboardHost!.props.onKeyPress as (event: unknown) => void)({
                key: 'ArrowDown',
                nativeEvent: { key: 'ArrowDown' },
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });
        await act(async () => {
            (keyboardHost!.props.onKeyPress as (event: unknown) => void)({
                key: 'Enter',
                nativeEvent: { key: 'Enter' },
                preventDefault: () => {},
                stopPropagation: () => {},
            });
        });

        expect(props.onSelectCandidate).toHaveBeenCalledWith(candidates[2]);
    });

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

    it('marks a stopped index build incomplete with a retry instead of an end-of-list marker', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            nextCursor={null}
            paginationRequestKey={null}
            preparation={null}
            preparationStopped
        />);

        const candidateRow = screen.findByTestId('direct-session-candidate:session-1');
        expect(candidateRow).not.toBeNull();
        expect(candidateRow?.props.disabled).toBeFalsy();
        expect(screen.findByTestId('direct-session-candidates:pagination:end')).toBeNull();
        const notice = screen.findByTestId('direct-session-candidates:pagination:error');
        expect(notice?.findAllByProps({
            children: 'externalSessions.browseIndexingCancelled',
        }).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('direct-session-candidates:pagination:retry');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it('presents incomplete link and import annotations without disabling candidate actions', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            annotationsIncomplete
        />);

        const notice = screen.findByTestId('direct-session-candidates-annotations-incomplete');
        expect(notice).not.toBeNull();
        expect(notice?.props).toMatchObject({
            accessibilityLiveRegion: 'polite',
            role: 'status',
            'aria-live': 'polite',
        });
        expect(notice?.props.children).toBe('externalSessions.browseAnnotationsIncomplete');
        expect(screen.findByTestId('direct-session-candidate:session-1')?.props.disabled).toBeFalsy();
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

    it('names the incremental-search progressbar without exposing a second unlabeled wrapper', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            searchAugmenting
            searchQuery="hidden session"
        />);

        const searchProgress = screen.findByTestId('direct-session-candidates-search-augmenting');
        expect(searchProgress?.props.accessibilityLabel).toBeUndefined();
        expect(searchProgress?.findAllByProps({
            accessibilityRole: 'progressbar',
            accessibilityLabel: 'common.loading',
        })).toHaveLength(1);
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

        const offline = screen.findByTestId('direct-session-candidates:offline');
        expect(offline).not.toBeNull();
        expect(offline?.props.accessibilityRole).toBe('alert');
        expect(offline?.props.accessibilityLiveRegion).toBe('assertive');
        expect(offline?.props.role).toBe('alert');
        expect(offline?.props['aria-live']).toBe('assertive');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'assertive' })).toHaveLength(1);
        await screen.pressByTestIdAsync('direct-session-candidates:offline-action');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it('prefers the current machine-offline reason over a stale candidate Agent failure', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            error="externalSessions.browseAgentUnavailable"
            offline
            nextCursor={null}
        />);

        const text = screen.getTextContent();
        expect(text).toContain('newSession.machineOfflineInlineBody');
        expect(text).not.toContain('externalSessions.browseAgentUnavailable');
    });

    it('announces an empty-list load failure without adding a second live region', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            error="List failed"
            nextCursor={null}
        />);

        const error = screen.findByTestId('direct-session-candidates:error');
        expect(error?.props.accessibilityRole).toBe('alert');
        expect(error?.props.accessibilityLiveRegion).toBe('assertive');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'assertive' })).toHaveLength(1);
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

    it('continues an empty cursor page through SelectionList without a manual action', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            nextCursor="cursor-after-empty-page"
        />);

        expect(screen.findByTestId('direct-session-candidates:empty-continuation')).toBeNull();
        expect(screen.getTextContent()).not.toContain('externalSessions.browseLoadMore');
        expect(typeof legendListState.props?.onEndReached).toBe('function');
        legendListState.props?.onEndReached?.();
        legendListState.props?.onEndReached?.();
        expect(props.onLoadMore).toHaveBeenCalledTimes(1);
    });

    it('allows the same opaque cursor to paginate again after the browse scope changes', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            paginationRequestKey={'scope-a\u0000cursor-1'}
        />);

        legendListState.props?.onEndReached?.();
        expect(props.onLoadMore).toHaveBeenCalledTimes(1);

        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            machineLabel="Another machine"
            paginationRequestKey={'scope-b\u0000cursor-1'}
        />);
        legendListState.props?.onEndReached?.();

        expect(props.onLoadMore).toHaveBeenCalledTimes(2);
    });

    it('formats section and row paths against the selected machine home directory', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[{
                ...candidate,
                title: 'Home project',
                details: { path: 'C:\\Users/alice\\projects/happier' },
            }]}
            machineHomeDir="C:\\Users\\alice"
        />);

        expect(screen.getTextContent()).toContain('~/projects/happier');
        expect(screen.getTextContent()).not.toContain('C:\\Users');
    });

    it('names a candidate with its visible project identity and trailing activity/link state', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[{
                ...candidate,
                details: { path: '/Users/alice/projects/happier' },
                linkedSessionId: 'happier-session-1',
                imported: true,
            }]}
            agentLabel="Codex"
            machineLabel="MacBook Pro"
            machineHomeDir="/Users/alice"
        />);

        const option = screen.findByTestId('direct-session-candidate:session-1');
        expect(option?.props.accessibilityLabel).toBe(
            `Existing session, Codex · MacBook Pro · ~/projects/happier, ${formatShortRelativeTime(candidate.updatedAtMs)}, status.ready, externalSessions.browseLinked, externalSessions.browseImported`,
        );
        expect(option?.props.accessibilityLabel).not.toContain('/Users/alice');
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

    it('keeps indexing progress and its cancel affordance reachable beside served rows', async () => {
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[candidate]}
            loading
            nextCursor={null}
            preparation={{
                kind: 'building_candidate_index',
                scanned: 50,
                total: 100,
            }}
        />);

        expect(screen.findByTestId('direct-session-candidate:session-1')).not.toBeNull();
        const progress = screen.findByTestId('direct-session-candidates:indexing');
        expect(progress).not.toBeNull();
        expect(progress?.props.accessibilityLabel).toBe('externalSessions.browseIndexingProgress');
        expect(screen.findAllByProps({
            testID: 'direct-session-candidates:indexing',
        })).toHaveLength(1);
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
        expect(progress?.props.accessibilityLiveRegion).toBeUndefined();
        expect(progress?.props['aria-live']).toBeUndefined();
        expect(progress?.findAllByProps({
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants',
            'aria-hidden': true,
        })).toHaveLength(1);
    });

    it('coalesces indexing announcements while keeping the current progress value queryable', async () => {
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

        const announcement = screen.findByTestId('direct-session-candidates:indexing:a11y-status');
        expect(announcement?.props).toMatchObject({
            accessibilityLiveRegion: 'polite',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': true,
        });
        expect((announcement?.props.children as { props?: { children?: unknown } } | undefined)?.props?.children)
            .toBe('externalSessions.browseIndexing');

        const progress = screen.findByTestId('direct-session-candidates:indexing');
        expect(progress?.props.accessibilityLiveRegion).toBeUndefined();
        expect(progress?.props['aria-live']).toBeUndefined();
        expect(progress?.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 50 });

        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            loading
            nextCursor={null}
            preparation={{
                kind: 'building_candidate_index',
                scanned: 75,
                total: 100,
            }}
        />);

        const updatedAnnouncement = screen.findByTestId('direct-session-candidates:indexing:a11y-status');
        expect((updatedAnnouncement?.props.children as { props?: { children?: unknown } } | undefined)?.props?.children)
            .toBe('externalSessions.browseIndexing');
        expect(screen.findByTestId('direct-session-candidates:indexing')?.props.accessibilityValue)
            .toEqual({ min: 0, max: 100, now: 75 });
    });

    it('announces indexing and incomplete candidate-status changes on iOS', async () => {
        accessibilityPlatform.os = 'ios';
        const props = defaultProps();
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            loading
            nextCursor={null}
            preparation={null}
        />);

        expect(announceForAccessibilityMock).toHaveBeenCalledOnce();
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            'common.loading',
        );

        await screen.update(<ExternalSessionBrowseCandidatesList
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

        expect(screen.findByTestId('direct-session-candidates:indexing:a11y-status')).toBeNull();
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            'externalSessions.browseIndexing',
        );

        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[]}
            loading
            nextCursor={null}
            preparation={{
                kind: 'building_candidate_index',
                scanned: 75,
                total: 100,
            }}
        />);

        const updatedProgress = screen.findByTestId('direct-session-candidates:indexing');
        expect(updatedProgress?.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 75 });
        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(2);

        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[candidate]}
            searchIncomplete
        />);

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(3);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            'externalSessions.browseSearchIncomplete',
        );

        await screen.update(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[candidate]}
            searchIncomplete
            annotationsIncomplete
        />);

        expect(announceForAccessibilityMock).toHaveBeenCalledTimes(4);
        expect(announceForAccessibilityMock).toHaveBeenLastCalledWith(
            'externalSessions.browseSearchIncomplete externalSessions.browseAnnotationsIncomplete',
        );
    });

    it('distinguishes same-title projects accessibly and selects by the opaque daemon key', async () => {
        const props = defaultProps();
        const projectACandidate = {
            ...candidate,
            candidateKey: 'project-a-key',
            details: { path: '/Users/alice/projects/project-a' },
            linkData: { projectId: 'project-a' },
        };
        const projectBCandidate = {
            ...candidate,
            candidateKey: 'project-b-key',
            details: { path: '/Users/alice/projects/project-b' },
            linkData: { projectId: 'project-b' },
        };
        const { ExternalSessionBrowseCandidatesList } = await import('./ExternalSessionBrowseCandidatesList');
        const screen = await renderScreen(<ExternalSessionBrowseCandidatesList
            {...props}
            candidates={[projectACandidate, projectBCandidate]}
            machineHomeDir="/Users/alice"
        />);

        const projectALabel = screen.findByTestId('direct-session-candidate:project-a-key')?.props.accessibilityLabel;
        const projectBLabel = screen.findByTestId('direct-session-candidate:project-b-key')?.props.accessibilityLabel;
        expect(projectALabel).toContain('~/projects/project-a');
        expect(projectBLabel).toContain('~/projects/project-b');
        expect(projectALabel).not.toBe(projectBLabel);
        expect(`${String(projectALabel)} ${String(projectBLabel)}`).not.toContain('/Users/alice');

        await screen.pressByTestIdAsync('direct-session-candidate:project-b-key');

        expect(props.onSelectCandidate).toHaveBeenCalledWith(projectBCandidate);
    });
});
