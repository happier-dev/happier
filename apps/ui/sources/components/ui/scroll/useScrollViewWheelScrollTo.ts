import * as React from 'react';
import { Platform } from 'react-native';

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
        onScroll?: (event: any) => void;
        onWheel?: (event: any) => void;
    }> = {},
): ScrollViewWheelScrollHandlers {
    const scrollYRef = React.useRef(0);

    const onScroll = React.useCallback((event: any) => {
        scrollYRef.current = event?.nativeEvent?.contentOffset?.y ?? 0;
        options.onScroll?.(event);
    }, [options]);

    const onWheel = React.useCallback((event: any) => {
        options.onWheel?.(event);
        if (Platform.OS !== 'web') return;

        const deltaY = event?.deltaY;
        if (typeof deltaY !== 'number' || Number.isNaN(deltaY)) return;

        if (event?.cancelable) {
            event?.preventDefault?.();
        }
        event?.stopPropagation?.();
        scrollRef.current?.scrollTo({ y: Math.max(0, scrollYRef.current + deltaY), animated: false });
    }, [options, scrollRef]);

    return { onScroll, onWheel };
}

