import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListViewFilterDefaults } from './search/sessionListViewFilters';
import 'fake-indexeddb/auto';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

// Item is the list-row presentation leaf; the rail line only needs its title and trailing slot.
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Readonly<{ title?: React.ReactNode; rightElement?: React.ReactNode }>) => React.createElement('Item', props, props.title, props.rightElement),
}));

type StateProps = React.ComponentProps<typeof import('./SessionListViewEmptyState').SessionListViewEmptyState>;
const filters = {
    ...createSessionListViewFilterDefaults(),
    scope: 'my_work',
    attention: 'any',
    homeServerIds: ['home-a'],
    audiences: { include: [], exclude: [] },
    tagIds: { include: [], exclude: [] },
    source: 'all',
    searchQuery: '',
} satisfies StateProps['filters'];

function stateProps(overrides: Partial<StateProps> = {}): StateProps {
    return {
        presentation: { kind: 'ready', complete: true },
        visibleSessionCount: 0,
        filters,
        defaults: filters,
        viewContext: { kind: 'global' },
        includeInactive: true,
        hasHiddenInactiveSessions: false,
        onRetry: vi.fn(),
        onLoadMore: vi.fn(),
        onClearFilters: vi.fn(),
        onBrowseAllAccessible: vi.fn(),
        onShowInactive: vi.fn(),
        ...overrides,
    };
}

// Collect the real query-state component before the per-case runtime budget begins.
const { SessionListViewEmptyState } = await import('./SessionListViewEmptyState');

describe('SessionListViewEmptyState in the rail', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('says an empty scope in one line with a quiet way to show everything', async () => {
        const props = stateProps();
        const screen = await renderScreen(<SessionListViewEmptyState {...props} />);

        expect(screen.findByTestId('session-list-query-empty-state')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionsList.queryMyWorkEmptyTitle');
        // One line: no purpose paragraph, no full-width button; the way forward is the line's inline link.
        expect(screen.findByTestId('session-list-query-action:browse_all_accessible')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('sessionsList.queryScopeEmptyDescription');
        await screen.pressByTestIdAsync('session-list-query-action:browse_all_accessible');
        expect(props.onBrowseAllAccessible).toHaveBeenCalledTimes(1);
    });

    it('says a failed refresh in one line with Retry', async () => {
        const props = stateProps({ presentation: { kind: 'error', retainedRows: false } });
        const screen = await renderScreen(<SessionListViewEmptyState {...props} />);

        expect(screen.findByTestId('session-list-query-empty-state')).toBeTruthy();
        expect(screen.getTextContent()).toContain('sessionsList.queryRefreshFailedTitle');
        expect(screen.getTextContent()).not.toContain('sessionsList.queryRefreshFailedEmptyDescription');
        await screen.pressByTestIdAsync('session-list-query-action:retry');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
    });

    it.each([
        { visibleSessionCount: 0, reason: 'unsupported', descriptionKey: 'sessionsList.queryHomesNeedUpdateDescription' },
        { visibleSessionCount: 3, reason: 'unsupported', descriptionKey: 'sessionsList.queryHomesNeedUpdateDescription' },
        { visibleSessionCount: 0, reason: 'not_selected', descriptionKey: 'sessionsList.queryHomesNotSelectedDescription' },
        { visibleSessionCount: 3, reason: 'not_selected', descriptionKey: 'sessionsList.queryHomesNotSelectedDescription' },
    ] as const)('shows $reason Home repair guidance without clearing filters when $visibleSessionCount rows remain', async ({ visibleSessionCount, reason, descriptionKey }) => {
        const props = stateProps({
            presentation: { kind: 'partial', unavailableHomes: [{ serverId: 'home-a', reason }] },
            visibleSessionCount,
        });
        const screen = await renderScreen(<SessionListViewEmptyState {...props} />);

        expect(screen.findByTestId('session-list-query-action:clear_filters')).toBeNull();
        expect(screen.findByTestId('session-list-query-action:retry')).toBeNull();
        expect(screen.getTextContent()).toContain('sessionsList.queryIncompleteTitle');
        expect(screen.getTextContent()).toContain(descriptionKey);
    });

    it('keeps an actionable retry for an unreachable Home', async () => {
        const props = stateProps({
            presentation: { kind: 'partial', unavailableHomes: [{ serverId: 'home-a', reason: 'offline' }] },
        });
        const screen = await renderScreen(<SessionListViewEmptyState {...props} />);

        await screen.pressByTestIdAsync('session-list-query-action:retry');
        expect(props.onRetry).toHaveBeenCalledTimes(1);
        expect(props.onClearFilters).not.toHaveBeenCalled();
    });

    it('holds the first load with skeleton rows in the list shape instead of a loading message', async () => {
        const props = stateProps({ presentation: { kind: 'initial_loading' } });
        const screen = await renderScreen(<SessionListViewEmptyState {...props} />);

        expect(screen.getTextContent()).not.toContain('sessionsList.queryInitialLoadingTitle');
        expect(screen.findByTestId('session-list-skeleton')).toBeTruthy();
        expect(screen.findByTestId('session-list-skeleton-row:0')).toBeTruthy();
    });
});
