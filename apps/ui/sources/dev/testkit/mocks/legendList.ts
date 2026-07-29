import * as React from 'react';
import { vi } from 'vitest';

export type LegendListMockState = {
    contentLength: number;
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
    cancelInitialScrollPreservation: ReturnType<typeof vi.fn>;
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
    refHandle?: Partial<LegendListMockRefHandle>;
    renderItems?: boolean;
    /** Render only the first N virtual rows while retaining the complete captured data set. */
    renderItemLimit?: number;
    /** Stateful geometry feed: merged over the static defaults on every getState() read. */
    resolveState?: () => Partial<LegendListMockState> | null | undefined;
}>;

export function createCapturingLegendListMock(
    options: CapturingLegendListMockOptions = {},
): Readonly<{
    module: Readonly<{ LegendList: React.ForwardRefExoticComponent<any> }>;
    state: CapturingLegendListMockState;
}> {
    let props: any | null = null;
    const scrollableNode = { kind: 'legend-scrollable-node' };
    const refHandle: LegendListMockRefHandle = {
        cancelInitialScrollPreservation: vi.fn(),
        clearCaches: vi.fn(),
        getNativeScrollRef: vi.fn(() => scrollableNode),
        getScrollableNode: vi.fn(() => scrollableNode),
        getState: (): LegendListMockState => ({
            contentLength: 0,
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
    const LegendList = React.forwardRef<any, any>((nextProps, ref) => {
        props = nextProps;
        if (typeof ref === 'function') ref(refHandle);
        else if (ref && typeof ref === 'object') ref.current = refHandle;

        const renderAuxiliary = (component: any) => {
            if (!component) return null;
            if (React.isValidElement(component)) return component;
            return React.createElement(component);
        };
        const items = options.renderItems === false || !Array.isArray(nextProps.data)
            ? []
            : nextProps.data
                .slice(0, options.renderItemLimit ?? nextProps.data.length)
                .map((item: any, index: number) => React.createElement(
                'LegendListItem',
                { key: nextProps.keyExtractor?.(item, index) ?? item?.id ?? String(index) },
                nextProps.renderItem?.({ item, index }),
                ));
        return React.createElement(
            'LegendList',
            nextProps,
            renderAuxiliary(nextProps.ListHeaderComponent),
            ...items,
            renderAuxiliary(nextProps.ListFooterComponent),
        );
    });

    return { module: { LegendList }, state };
}
