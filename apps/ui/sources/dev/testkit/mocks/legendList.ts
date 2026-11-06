import * as React from 'react';
import { vi } from 'vitest';
import type { LegendListRef } from '@legendapp/list/react-native';

export type LegendListMockState = {
    contentLength: number;
    listen: ReturnType<LegendListRef['getState']>['listen'];
    isAtEnd: boolean;
    isNearEnd: boolean;
    isWithinMaintainScrollAtEndThreshold: boolean;
    positionAtIndex: (index: number) => number;
    scroll: number;
    scrollLength: number;
    sizeAtIndex: (index: number) => number;
    start?: number;
    end?: number;
    startBuffered?: number;
    endBuffered?: number;
};

type LegendListMockRefHandle = Readonly<{
    cancelScroll: ReturnType<typeof vi.fn>;
    clearCaches: ReturnType<typeof vi.fn>;
    getNativeScrollRef: ReturnType<typeof vi.fn>;
    getScrollableNode: ReturnType<typeof vi.fn>;
    getState: () => LegendListMockState;
    scrollToEnd: ReturnType<typeof vi.fn>;
    scrollToIndex: ReturnType<typeof vi.fn>;
    scrollToOffset: ReturnType<typeof vi.fn>;
}>;

export type CapturingLegendListMockState = Readonly<{
    get props(): any | null;
    reset: () => void;
    refHandle: LegendListMockRefHandle;
}>;

type CapturingLegendListMockOptions = Readonly<{
    /**
     * The real module, from `importOriginal`, when the surface under test also
     * reaches `@legendapp/list/section-list`. That entry imports `internal` from
     * this same module, so a whole-module replacement makes the canonical
     * `@/components/ui/lists/virtualized` barrel unimportable. Passing the
     * original keeps every export except the recycler this mock is replacing.
     */
    original?: Readonly<Record<string, unknown>>;
    refHandle?: Partial<LegendListMockRefHandle>;
    renderItems?: boolean;
    /** Render only the first N virtual rows while retaining the complete captured data set. */
    renderItemLimit?: number;
    /** Native viewability follows the rows rendered by this measured-viewport substitute. */
    emitViewability?: boolean;
    /** A warm measured recycler may finish its initial layout before its parent's passive effects. */
    emitLoadDuringLayout?: boolean;
    /** Keep mounted cells until their item or the recycler's dataVersion changes. */
    memoizeItems?: boolean;
    /** Observe memoized cell render work, including invalidation through extraData. */
    onRenderItem?: () => void;
    /** Observe commits at the external recycler boundary without replacing its owning UI. */
    onCommit?: (props: Readonly<Record<string, unknown>>) => void;
    /** Stateful geometry feed: merged over the static defaults on every getState() read. */
    resolveState?: () => Partial<LegendListMockState> | null | undefined;
}>;

/**
 * Canonical vi.mock factory for the whole package. Replace only the recycler;
 * retain exports consumed by the real section-list adapter and capture its state
 * through the callback when a test needs to inspect the native boundary.
 */
export async function createLegendListModuleMock(
    options: Omit<CapturingLegendListMockOptions, 'original'> = {},
    captureState?: (state: CapturingLegendListMockState) => void,
): Promise<Omit<typeof import('@legendapp/list/react-native'), 'LegendList'>
    & ReturnType<typeof createCapturingLegendListMock>['module']> {
    const original = await vi.importActual<typeof import('@legendapp/list/react-native')>('@legendapp/list/react-native');
    const captured = createCapturingLegendListMock(options);
    captureState?.(captured.state);
    return { ...original, ...captured.module };
}

export function createCapturingLegendListMock(
    options: CapturingLegendListMockOptions = {},
): Readonly<{
    module: Readonly<{ LegendList: React.ForwardRefExoticComponent<any> }>;
    state: CapturingLegendListMockState;
}> {
    let props: any | null = null;
    const scrollableNode = { kind: 'legend-scrollable-node' };
    const refHandle: LegendListMockRefHandle = {
        cancelScroll: vi.fn(),
        clearCaches: vi.fn(),
        getNativeScrollRef: vi.fn(() => scrollableNode),
        getScrollableNode: vi.fn(() => scrollableNode),
        getState: (): LegendListMockState => ({
            contentLength: 0,
            // This fixture has static geometry: Legend subscriptions do not emit on registration,
            // and always return cleanup. A pushed-state fixture can override this via resolveState.
            listen: () => () => {},
            isAtEnd: true,
            isNearEnd: true,
            isWithinMaintainScrollAtEndThreshold: true,
            positionAtIndex: (index: number) => index * 120,
            scroll: 0,
            scrollLength: 0,
            sizeAtIndex: () => 120,
            ...(options.resolveState?.() ?? {}),
        }),
        scrollToEnd: vi.fn(() => Promise.resolve()),
        scrollToIndex: vi.fn(() => Promise.resolve()),
        scrollToOffset: vi.fn(() => Promise.resolve()),
        ...options.refHandle,
    };
    const state: CapturingLegendListMockState = {
        get props() {
            return props;
        },
        reset: () => {
            props = null;
        },
        refHandle,
    };
    const MemoizedItem = React.memo((itemProps: Readonly<{
        item: unknown;
        index: number;
        dataVersion: unknown;
        extraData: unknown;
        renderItemRef: React.RefObject<((input: Readonly<{ item: unknown; index: number }>) => React.ReactNode) | undefined>;
    }>) => {
        options.onRenderItem?.();
        return React.createElement('LegendListItem', null, itemProps.renderItemRef.current?.({ item: itemProps.item, index: itemProps.index }));
    });
    const LegendList = React.forwardRef<any, any>((nextProps, ref) => {
        props = nextProps;
        React.useLayoutEffect(() => { options.onCommit?.(nextProps); });
        // Like the recycler, changing renderItem alone updates the callback but does not invalidate a cell.
        const renderItemRef = React.useRef(nextProps.renderItem);
        renderItemRef.current = nextProps.renderItem;
        if (typeof ref === 'function') ref(refHandle);
        else if (ref && typeof ref === 'object') ref.current = refHandle;

        const didLoad = React.useRef(false);
        React.useLayoutEffect(() => {
            if (!options.emitLoadDuringLayout || didLoad.current || !nextProps.data?.length) return;
            didLoad.current = true;
            nextProps.onLoad?.({ elapsedTimeInMs: 0 });
        }, [nextProps.data, nextProps.onLoad]);

        React.useEffect(() => {
            if (!options.emitViewability || !nextProps.onViewableItemsChanged || !Array.isArray(nextProps.data)) return;
            const viewableItems = nextProps.data.slice(0, options.renderItemLimit ?? nextProps.data.length)
                .map((item: unknown, index: number) => ({ item, index, key: nextProps.keyExtractor(item, index), isViewable: true }));
            nextProps.onViewableItemsChanged?.({ viewableItems, changed: viewableItems });
        }, [nextProps.data, nextProps.onViewableItemsChanged]);

        const renderAuxiliary = (component: any) => {
            if (!component) return null;
            if (React.isValidElement(component)) return component;
            return React.createElement(component);
        };
        const items = options.renderItems === false || !Array.isArray(nextProps.data)
            ? []
            : nextProps.data
                .slice(0, options.renderItemLimit ?? nextProps.data.length)
                .map((item: any, index: number) => options.memoizeItems ? React.createElement(MemoizedItem, {
                    key: nextProps.keyExtractor?.(item, index) ?? item?.id ?? String(index),
                    item, index, dataVersion: nextProps.dataVersion, extraData: nextProps.extraData, renderItemRef,
                }) : React.createElement(
                'LegendListItem',
                { key: nextProps.keyExtractor?.(item, index) ?? item?.id ?? String(index) },
                nextProps.renderItem?.({ item, index }),
                ));
        return React.createElement(
            'LegendList',
            nextProps,
            renderAuxiliary(nextProps.ListHeaderComponent),
            ...items,
            Array.isArray(nextProps.data) && nextProps.data.length === 0 ? renderAuxiliary(nextProps.ListEmptyComponent) : null,
            renderAuxiliary(nextProps.ListFooterComponent),
        );
    });

    return { module: { ...(options.original ?? {}), LegendList }, state };
}
