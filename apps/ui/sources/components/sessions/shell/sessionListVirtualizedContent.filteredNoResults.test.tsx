import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';

vi.mock('@legendapp/list/react-native', async () => {
    const legendListModule = await import('@/dev/testkit/mocks/legendList');
    return { LegendList: legendListModule.createCapturingLegendListMock({ renderItems: true }).module.LegendList };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

describe('SessionListVirtualizedContent filtered no-results state', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('says an ordinary list filtered to nothing in one quiet line on the rows\' edge', async () => {
        const { SessionListVirtualizedContent, SESSION_LIST_SUPPORTING_SECTIONS_NODE } = await import('./sessionListVirtualizedContent');

        const screen = await renderScreen(React.createElement(SessionListVirtualizedContent as any, {
            nodes: [SESSION_LIST_SUPPORTING_SECTIONS_NODE, {
                id: buildSessionListIndexNodeId({ type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active' }),
                kind: 'header',
                headerKind: 'active',
                rowViewModel: null,
            }],
            rowDensity: 'minimal',
            rowHeight: 48,
            safeAreaBottom: 0,
            showReminders: false,
            renderItem: ({ item }: any) => React.createElement('Row', { testID: `row:${item.id}` }),
            rowExtraData: null,
            onStopScrollEventPropagationOnWeb: vi.fn(),

            filteredNoResultsMessage: 'directSessions.browseNoSearchResults',
        }));

        expect(screen.getTextContent()).toContain('directSessions.browseNoSearchResults');
        expect(screen.findByTestId('session-list-filtered-no-results')?.props.accessibilityLiveRegion).toBe('polite');
    });

    it('omits waiting drafts and any archived shortcut when the host is rendering the archived corpus', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

        const screen = await renderScreen(React.createElement(SessionListVirtualizedContent as any, {
            nodes: [],
            rowHeight: 48,
            safeAreaBottom: 0,
            renderItem: () => null,
            rowExtraData: null,
            onStopScrollEventPropagationOnWeb: vi.fn(),

            showDrafts: false,
            showReminders: false,
        }));

        expect(screen.findByTestId('session-drafts-section')).toBeNull();
        expect(screen.getTextContent()).not.toContain('sessionInfo.archivedSessions');
        expect(screen.getTextContent()).not.toContain('sessionInfo.inactiveAndArchivedSessions');
    });

    it('renders the typed incomplete-search state and loads older query pages', async () => {
        const onLoadMore = vi.fn();
        const { SessionListVirtualizedContent, SESSION_LIST_SUPPORTING_SECTIONS_NODE } = await import('./sessionListVirtualizedContent');

        const filters = {
            scope: 'my_work',
            attention: 'any',
            homeServerIds: ['home-a'],
            audiences: [],
            tagIds: [],
            source: 'all',
            searchQuery: 'auth',
        } as const;
        const screen = await renderScreen(React.createElement(SessionListVirtualizedContent as any, {
            nodes: [SESSION_LIST_SUPPORTING_SECTIONS_NODE],
            rowHeight: 48,
            safeAreaBottom: 0,
            showReminders: false,
            renderItem: () => null,
            rowExtraData: null,
            onStopScrollEventPropagationOnWeb: vi.fn(),

            filteredNoResultsMessage: 'directSessions.browseNoSearchResults',
            viewContext: {
                kind: 'team',
                team: { serverId: 'home-a', teamId: 'team-a' },
                teamDisplayName: 'Design',
            },
            queryPresentationState: {
                presentation: { kind: 'ready', complete: false },
                visibleSessionCount: 0,
                filters,
                defaults: { ...filters, searchQuery: '' },
                // Empty-state presentation is not the draft-section context owner.
                viewContext: { kind: 'global' },
                includeInactive: true,
                hasHiddenInactiveSessions: false,
                onRetry: vi.fn(),
                onLoadMore,
                onClearFilters: vi.fn(),
                onBrowseAllAccessible: vi.fn(),
                onShowInactive: vi.fn(),
            },
        }));

        expect(screen.getTextContent()).toContain('sessionsList.queryNoMatchesLoadedTitle');
        expect(screen.getTextContent()).not.toContain('directSessions.browseNoSearchResults');
        await screen.pressByTestIdAsync('session-list-query-action:load_more');
        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });
});
