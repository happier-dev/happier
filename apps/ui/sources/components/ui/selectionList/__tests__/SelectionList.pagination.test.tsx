import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createCapturingLegendListMock, renderScreen } from '@/dev/testkit';

import type { SelectionListProps, SelectionListStep } from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const { module: capturedLegendList, state: legendListState } = createCapturingLegendListMock({
    renderItems: true,
    renderItemLimit: 20,
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: capturedLegendList.LegendList,
}));

const rootStep: SelectionListStep = {
    id: 'root',
    inputPlaceholder: 'Search sessions',
    sections: [{
        kind: 'static',
        id: 'sessions',
        title: 'SESSIONS',
        options: [
            { id: 'session-1', label: 'Session 1' },
            { id: 'session-2', label: 'Session 2' },
        ],
    }],
};

function createProps(overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'browse',
        maxHeight: 320,
        ...overrides,
    };
}

describe('SelectionList pagination contract', () => {
    it('constructs rich visuals only for the virtualized viewport across 10k rows and updates', async () => {
        const constructVisual = vi.fn((id: string) => <React.Fragment>{`Visual ${id}`}</React.Fragment>);
        const makeLargeStep = (loadingId: string | null): SelectionListStep => ({
            id: 'root',
            inputPlaceholder: 'Search sessions',
            sections: [{
                kind: 'static',
                id: 'sessions',
                title: 'SESSIONS',
                virtualization: 'force',
                options: Array.from({ length: 10_000 }, (_, index) => ({
                    id: `session-${index}`,
                    label: `Session ${index}`,
                    subtitle: `Project ${index}`,
                    subtitleContent: () => constructVisual(`subtitle-${index}`),
                    icon: () => constructVisual(`icon-${index}`),
                    rightAccessory: () => constructVisual(`status-${index}`),
                    loading: loadingId === `session-${index}`,
                })),
            }],
        });
        const pagination = {
            hasMore: true,
            loadingMore: false,
            requestKey: 'scope\u0000cursor-1',
            onEndReached: vi.fn(),
            loadingLabel: 'Loading more sessions',
            retryLabel: 'Retry loading sessions',
            endReachedLabel: 'All sessions loaded',
        } as const;
        const { SelectionList } = await import('../SelectionList');
        const largeStep = makeLargeStep(null);
        const screen = await renderScreen(<SelectionList {...createProps({
            rootStep: largeStep,
            pagination,
        })} />);

        expect(legendListState.props?.data).toHaveLength(10_001);
        expect(constructVisual.mock.calls.length).toBeGreaterThan(0);
        expect(constructVisual.mock.calls.length).toBeLessThanOrEqual(120);

        constructVisual.mockClear();
        await screen.update(<SelectionList {...createProps({
            rootStep: largeStep,
            selectedOptionId: 'session-5',
            pagination,
        })} />);

        expect(constructVisual.mock.calls.length).toBeGreaterThan(0);
        expect(constructVisual.mock.calls.length).toBeLessThanOrEqual(240);
        const selectedRow = screen.findByTestId('browse:root:option:session-5');
        expect(
            selectedRow?.props['aria-selected']
                ?? selectedRow?.props.accessibilityState?.selected,
        ).toBe(true);
    });

    it('keeps the virtualized pagination owner mounted for an empty continuation page', async () => {
        const onEndReached = vi.fn();
        const { SelectionList } = await import('../SelectionList');

        const screen = await renderScreen(<SelectionList {...createProps({
            rootStep: {
                ...rootStep,
                sections: [],
            },
            pagination: {
                hasMore: true,
                loadingMore: false,
                requestKey: 'cursor-after-empty-page',
                onEndReached,
                loadingLabel: 'Loading more sessions',
                retryLabel: 'Retry loading sessions',
                endReachedLabel: 'All sessions loaded',
            },
        })} />);

        expect(screen.findByTestId('browse:bodyVirtualizedList')).not.toBeNull();
        expect(typeof legendListState.props?.onEndReached).toBe('function');
        legendListState.props?.onEndReached?.();
        legendListState.props?.onEndReached?.();
        expect(onEndReached).toHaveBeenCalledTimes(1);
    });

    it('forces one virtualized scroll owner and coalesces same-frame end events for a cursor', async () => {
        const onEndReached = vi.fn();
        const { SelectionList } = await import('../SelectionList');

        await renderScreen(<SelectionList {...createProps({
            pagination: {
                hasMore: true,
                loadingMore: false,
                requestKey: 'cursor-1',
                onEndReached,
                loadingLabel: 'Loading more sessions',
                retryLabel: 'Retry loading sessions',
                endReachedLabel: 'All sessions loaded',
            },
        })} />);

        expect(legendListState.props).not.toBeNull();
        expect(typeof legendListState.props?.onEndReached).toBe('function');

        legendListState.props?.onEndReached?.();
        legendListState.props?.onEndReached?.();

        expect(onEndReached).toHaveBeenCalledTimes(1);
    });

    it('re-arms only after the cursor advances and exposes loading, retry, and terminal states accessibly', async () => {
        const onEndReached = vi.fn();
        const onRetry = vi.fn();
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...createProps({
            pagination: {
                hasMore: true,
                loadingMore: true,
                requestKey: 'cursor-1',
                onEndReached,
                loadingLabel: 'Loading more sessions',
                retryLabel: 'Retry loading sessions',
                endReachedLabel: 'All sessions loaded',
            },
        })} />);

        expect(screen.findByTestId('browse:pagination:loading')).not.toBeNull();
        expect(legendListState.props?.onEndReached).toBeUndefined();

        await screen.update(<SelectionList {...createProps({
            pagination: {
                hasMore: true,
                loadingMore: false,
                requestKey: 'cursor-1',
                error: 'The next page could not be loaded',
                onEndReached,
                onRetry,
                loadingLabel: 'Loading more sessions',
                retryLabel: 'Retry loading sessions',
                endReachedLabel: 'All sessions loaded',
            },
        })} />);

        expect(screen.findByTestId('browse:pagination:error')).not.toBeNull();
        expect(screen.findByTestId('browse:pagination:retry')).not.toBeNull();
        expect(legendListState.props?.onEndReached).toBeUndefined();
        await screen.pressByTestIdAsync('browse:pagination:retry');
        expect(onRetry).toHaveBeenCalledTimes(1);

        await screen.update(<SelectionList {...createProps({
            pagination: {
                hasMore: false,
                loadingMore: false,
                requestKey: null,
                onEndReached,
                loadingLabel: 'Loading more sessions',
                retryLabel: 'Retry loading sessions',
                endReachedLabel: 'All sessions loaded',
            },
        })} />);

        expect(screen.findByTestId('browse:pagination:end')).not.toBeNull();
        expect(screen.getTextContent()).toContain('All sessions loaded');
        expect(screen.tree.root.findAll((node) => node.props?.role === 'group')).toHaveLength(2);
        expect(legendListState.props?.onEndReached).toBeUndefined();
    });
});
