import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const runtime = await createReactNativeWebMock({
            Platform: { OS: 'web' },
        });
        return {
            ...runtime,
            FlatList: (props: any) => {
                const renderSlot = (slot: any) => {
                    if (!slot) return null;
                    return React.isValidElement(slot) ? slot : React.createElement(slot);
                };
                return React.createElement(
                    'FlatList',
                    props,
                    renderSlot(props.ListHeaderComponent),
                    ...(props.data ?? []).map((item: any, index: number) => (
                        React.createElement(React.Fragment, { key: props.keyExtractor?.(item) ?? String(index) }, props.renderItem({ item, index }))
                    )),
                    renderSlot(props.ListFooterComponent),
                );
            },
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

vi.mock('./sessionListChrome', () => ({
    SessionsListHeader: () => React.createElement('SessionsListHeader'),
    SessionFolderFocusBreadcrumbs: () => React.createElement('SessionFolderFocusBreadcrumbs'),
}));
vi.mock('./NewSessionDraftsSection', () => ({
    NewSessionDraftsSection: (props: Record<string, unknown>) => React.createElement('NewSessionDraftsSection', {
        ...props,
        testID: 'session-drafts-section',
    }),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.title, props.rightElement),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('SessionListVirtualizedContent filtered no-results state', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('says an ordinary list filtered to nothing in one quiet line on the rows\' edge', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

        const screen = await renderScreen(React.createElement(SessionListVirtualizedContent as any, {
            nodes: [{
                id: buildSessionListIndexNodeId({ type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active' }),
                kind: 'header',
                headerKind: 'active',
                rowViewModel: null,
            }],
            rowDensity: 'minimal',
            rowHeight: 48,
            safeAreaBottom: 0,
            renderItem: ({ item }: any) => React.createElement('Row', { testID: `row:${item.id}` }),
            rowExtraData: null,
            onStopScrollEventPropagationOnWeb: vi.fn(),
            folderFocus: null,
            onClearFolderFocus: vi.fn(),
            onSelectFolderBreadcrumb: vi.fn(),
            filteredNoResultsMessage: 'directSessions.browseNoSearchResults',
        }));

        expect(screen.getTextContent()).toContain('directSessions.browseNoSearchResults');
        expect(screen.findByTestId('session-list-filtered-no-results')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.findByTestId('session-drafts-section')).toBeTruthy();
        expect(screen.findByTestId('session-drafts-section')?.props.density).toBe('minimal');
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
            folderFocus: null,
            onClearFolderFocus: vi.fn(),
            onSelectFolderBreadcrumb: vi.fn(),
            showDrafts: false,
        }));

        expect(screen.findByTestId('session-drafts-section')).toBeNull();
        expect(screen.getTextContent()).not.toContain('sessionInfo.archivedSessions');
        expect(screen.getTextContent()).not.toContain('sessionInfo.inactiveAndArchivedSessions');
    });

    it('renders the typed incomplete-search state and loads older query pages', async () => {
        const onLoadMore = vi.fn();
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

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
            nodes: [],
            rowHeight: 48,
            safeAreaBottom: 0,
            renderItem: () => null,
            rowExtraData: null,
            onStopScrollEventPropagationOnWeb: vi.fn(),
            folderFocus: null,
            onClearFolderFocus: vi.fn(),
            onSelectFolderBreadcrumb: vi.fn(),
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
        expect(screen.findByTestId('session-drafts-section')?.props.viewContext).toEqual({
            kind: 'team',
            team: { serverId: 'home-a', teamId: 'team-a' },
            teamDisplayName: 'Design',
        });
        await screen.pressByTestIdAsync('session-list-query-action:load_more');
        expect(onLoadMore).toHaveBeenCalledTimes(1);
    });
});
