import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
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
    Item: (props: any) => React.createElement('Item', props, props.title),
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

    it('renders accessible feedback when active filters leave only headers', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

        const screen = await renderScreen(React.createElement(SessionListVirtualizedContent as any, {
            nodes: [{ id: 'header:active', rowViewModel: null }],
            rowDensity: 'minimal',
            rowHeight: 48,
            safeAreaBottom: 0,
            renderItem: ({ item }: any) => React.createElement('Row', { testID: `row:${item.id}` }),
            rowExtraData: null,
            onStopScrollEventPropagationOnWeb: vi.fn(),
            onPressArchivedSessions: vi.fn(),
            folderFocus: null,
            onClearFolderFocus: vi.fn(),
            onSelectFolderBreadcrumb: vi.fn(),
            filteredNoResultsMessage: 'directSessions.browseNoSearchResults',
        }));

        expect(screen.getTextContent()).toContain('directSessions.browseNoSearchResults');
        expect(screen.findByProps({ accessibilityLiveRegion: 'polite' })).toBeTruthy();
        expect(screen.findByTestId('session-drafts-section')).toBeTruthy();
        expect(screen.findByTestId('session-drafts-section')?.props.density).toBe('minimal');
    });
});
