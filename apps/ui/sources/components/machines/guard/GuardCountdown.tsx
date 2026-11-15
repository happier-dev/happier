import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewedLayoutEffect } from '@/utils/runtime/useHostActivelyViewed';

import { formatMachineCountdown } from '@/components/machines/durationWords';

/**
 * Milliseconds left until `stopAt`, re-read once a second while the stop is under ten minutes away (every
 * half minute before that), only while presented and viewed, and not at all once it has passed.
 * Only the leaf that shows the clock re-renders; revealing it refreshes the time before paint.
 */
export function useGuardRemainingMs(stopAt: number): number {
    const presented = useLayoutPresentationActive();
    const [now, setNow] = React.useState(() => Date.now());
    const remaining = stopAt - now;
    const fast = remaining < 10 * 60_000;
    useHostActivelyViewedLayoutEffect((hostViewed) => {
        if (!presented || !hostViewed) return;
        const current = Date.now();
        setNow(current);
        if (stopAt <= current) return;
        const timer = setInterval(() => setNow(Date.now()), fast ? 1000 : 30_000);
        return () => clearInterval(timer);
    }, [presented, stopAt, fast, remaining <= 0]);
    return remaining;
}

/**
 * "Stops in 4:52": a leaf that ticks once a second only while it is shown and the stop is under ten
 * minutes away (every half minute before that), so nothing above it re-renders with the clock. It
 * ticks without pulsing; screen readers hear it when it appears, not every second.
 */
export const GuardCountdown = React.memo(function GuardCountdown(props: Readonly<{
    stopAt: number;
    format: (remaining: string) => string;
    style?: StyleProp<TextStyle>;
    testID?: string;
}>) {
    const remaining = useGuardRemainingMs(props.stopAt);
    return <Text testID={props.testID} style={props.style}>{props.format(formatMachineCountdown(remaining))}</Text>;
});
