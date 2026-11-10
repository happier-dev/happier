import * as React from 'react';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/**
 * Mount in a visible status leaf so the loading clock never rerenders the containing page. The clock runs
 * only while its surface is presented: a hidden, retained card holds its last value, and reads the true wait
 * from when it mounted once shown again.
 */
export function useSurfaceStateElapsedSeconds(): number {
    const presented = useLayoutPresentationActive();
    const [startedAt] = React.useState(() => Date.now());
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    React.useEffect(() => {
        if (!presented) return;
        const tick = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
        tick();
        const interval = setInterval(tick, 1_000);
        return () => clearInterval(interval);
    }, [presented, startedAt]);
    return elapsedSeconds;
}
