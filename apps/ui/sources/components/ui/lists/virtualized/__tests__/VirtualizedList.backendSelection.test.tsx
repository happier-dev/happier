import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({ os: 'web' }));
const mocks = vi.hoisted(() => ({
    legend: null as null | { module: any; state: any },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        FlatList: (props: any) => {
            const rows = (props.data ?? []).map((item: any, index: number) => React.createElement(
                React.Fragment,
                { key: props.keyExtractor ? props.keyExtractor(item, index) : String(index) },
                props.renderItem?.({ item, index }),
            ));
            return React.createElement('FlatList', props, ...rows);
        },
        Platform: {
            get OS() { return platformState.os; },
            select: (options: any) => options?.[platformState.os] ?? options?.default ?? options?.native,
        },
    });
});

vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    mocks.legend = createCapturingLegendListMock();
    return { LegendList: mocks.legend.module.LegendList };
});

type Row = { id: string };
const rows: Row[] = [{ id: 'a' }, { id: 'b' }];

async function renderList(extra: Record<string, unknown> = {}, ref?: React.Ref<any>) {
    const { VirtualizedList } = await import('../VirtualizedList');
    return renderScreen(
        <VirtualizedList<Row>
            data={rows}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => React.createElement('View', { testID: `row-${item.id}` })}
            ref={ref}
            {...extra}
        />,
    );
}

describe('VirtualizedList backend selection', () => {
    beforeEach(() => {
        platformState.os = 'web';
    });

    it('renders the Legend backend for auto on web', async () => {
        const screen = await renderList();
        expect(screen.findAllByType('LegendList' as any)).toHaveLength(1);
        expect(screen.findAllByType('FlatList' as any)).toHaveLength(0);
    });

    it('renders the Legend backend for auto on native', async () => {
        platformState.os = 'ios';
        const nativeStyle = { height: 320 };
        const screen = await renderList({ estimatedItemSize: 40, style: nativeStyle });
        expect(screen.findAllByType('LegendList' as any)).toHaveLength(1);
        expect(mocks.legend?.state.props?.estimatedItemSize).toBe(40);
        expect(mocks.legend?.state.props?.style).toBe(nativeStyle);
    });

    it('renders the Legend backend when explicitly preferred, on any platform', async () => {
        platformState.os = 'web';
        const screen = await renderList({ backendPreference: 'legend' });
        expect(screen.findAllByType('LegendList' as any)).toHaveLength(1);
        expect(screen.findAllByType('FlatList' as any)).toHaveLength(0);
    });

    it('forwards the stable ref onto the resolved backend handle', async () => {
        platformState.os = 'web';
        const ref = React.createRef<any>();
        await renderList({ backendPreference: 'legend' }, ref);
        ref.current.scrollToOffset({ offset: 120 });
        ref.current.scrollToIndex({ index: 3 });
        ref.current.clearMeasurementCache({ mode: 'sizes' });
        expect(mocks.legend?.state.refHandle.scrollToOffset).toHaveBeenCalledWith({ offset: 120 });
        expect(mocks.legend?.state.refHandle.scrollToIndex).toHaveBeenCalledWith({ index: 3 });
        expect(mocks.legend?.state.refHandle.clearCaches).toHaveBeenCalledWith({ mode: 'sizes' });
        expect(ref.current.getScrollableNode()).toEqual({ kind: 'legend-scrollable-node' });
    });

    it('forwards state-safety and scroll-owner props to Legend', async () => {
        await renderList({
            recycleItems: false,
            showsVerticalScrollIndicator: false,
        });
        expect(mocks.legend?.state.props?.recycleItems).toBe(false);
        expect(mocks.legend?.state.props?.showsVerticalScrollIndicator).toBe(false);
    });

    it('keeps horizontal scrolling inside the selected virtualized backend', async () => {
        await renderList({
            horizontal: true,
            showsHorizontalScrollIndicator: false,
        });

        expect(mocks.legend?.state.props?.horizontal).toBe(true);
        expect(mocks.legend?.state.props?.showsHorizontalScrollIndicator).toBe(false);
    });

    it('preserves native scroll lifecycle handlers without leaking them to the web DOM owner', async () => {
        const onContentSizeChange = vi.fn();
        const onMomentumScrollEnd = vi.fn();
        const onMomentumScrollBegin = vi.fn();
        const onScrollBeginDrag = vi.fn();
        const onScrollEndDrag = vi.fn();
        const extraData = { version: 1 };
        const handlers = {
            extraData,
            keyboardShouldPersistTaps: 'handled' as const,
            keyboardDismissMode: 'on-drag' as const,
            nativeID: 'virtualized-list-native',
            onContentSizeChange,
            onMomentumScrollEnd,
            onMomentumScrollBegin,
            onScrollBeginDrag,
            onScrollEndDrag,
            testID: 'virtualized-list-test',
        };

        platformState.os = 'ios';
        await renderList(handlers);
        expect(mocks.legend?.state.props?.extraData).toBe(extraData);
        expect(mocks.legend?.state.props?.keyboardShouldPersistTaps).toBe('handled');
        expect(mocks.legend?.state.props?.keyboardDismissMode).toBe('on-drag');
        expect(mocks.legend?.state.props?.nativeID).toBe('virtualized-list-native');
        expect(mocks.legend?.state.props?.onContentSizeChange).toBe(onContentSizeChange);
        expect(mocks.legend?.state.props?.onMomentumScrollEnd).toBe(onMomentumScrollEnd);
        expect(mocks.legend?.state.props?.onMomentumScrollBegin).toBe(onMomentumScrollBegin);
        expect(mocks.legend?.state.props?.onScrollBeginDrag).toBe(onScrollBeginDrag);
        expect(mocks.legend?.state.props?.onScrollEndDrag).toBe(onScrollEndDrag);
        expect(mocks.legend?.state.props?.testID).toBe('virtualized-list-test');

        platformState.os = 'web';
        await renderList(handlers);
        expect(mocks.legend?.state.props?.extraData).toBe(extraData);
        expect(mocks.legend?.state.props?.id).toBe('virtualized-list-native');
        expect(mocks.legend?.state.props?.['data-testid']).toBe('virtualized-list-test');
        expect(mocks.legend?.state.props?.keyboardShouldPersistTaps).toBeUndefined();
        expect(mocks.legend?.state.props?.keyboardDismissMode).toBeUndefined();
        expect(mocks.legend?.state.props?.nativeID).toBeUndefined();
        expect(mocks.legend?.state.props?.onContentSizeChange).toBeUndefined();
        expect(mocks.legend?.state.props?.onMomentumScrollEnd).toBe(onMomentumScrollEnd);
        expect(mocks.legend?.state.props?.onMomentumScrollBegin).toBeUndefined();
        expect(mocks.legend?.state.props?.onScrollBeginDrag).toBe(onScrollBeginDrag);
        expect(mocks.legend?.state.props?.onScrollEndDrag).toBeUndefined();
        expect(mocks.legend?.state.props?.testID).toBeUndefined();
    });
});
