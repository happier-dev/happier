import * as React from 'react';
import { Platform } from 'react-native';

import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';

type ScrollToOptions = Readonly<{
    y: number;
    animated?: boolean;
}>;

type ScrollToCapable = Readonly<{
    scrollTo: (options: ScrollToOptions) => void;
}>;

export type ScrollViewWheelScrollHandlers = Readonly<{
    onScroll: (event: any) => void;
    onWheel: (event: any) => void;
}>;

export function useScrollViewWheelScrollTo(
    scrollRef: React.RefObject<ScrollToCapable | null>,
    options: Readonly<{
        enabled?: boolean;
        onScroll?: (event: any) => void;
        onWheel?: (event: any) => void;
    }> = {},
): ScrollViewWheelScrollHandlers {
    const scrollYRef = React.useRef(0);
    const isInsideModalBoundary = useIsInsideModalBoundary();
    const enabled = options.enabled ?? isInsideModalBoundary;
    const onScrollOption = options.onScroll;
    const onWheelOption = options.onWheel;

    const onScroll = React.useCallback((event: any) => {
        if (enabled) {
            scrollYRef.current = event?.nativeEvent?.contentOffset?.y ?? 0;
        }
        onScrollOption?.(event);
    }, [enabled, onScrollOption]);

    const onWheel = React.useCallback((event: any) => {
        onWheelOption?.(event);
        if (!enabled) return;
        if (Platform.OS !== 'web') return;

        const deltaY = event?.deltaY;
        if (typeof deltaY !== 'number' || Number.isNaN(deltaY)) return;

        if (event?.cancelable) {
            event?.preventDefault?.();
        }
        event?.stopPropagation?.();
        scrollRef.current?.scrollTo({ y: Math.max(0, scrollYRef.current + deltaY), animated: false });
    }, [enabled, onWheelOption, scrollRef]);

    return { onScroll, onWheel };
}
