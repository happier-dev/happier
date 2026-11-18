import * as React from 'react';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';

/** One-shot wake at the instant the Activity owner says its projection expires. */
export function useActivityBoundaryRefresh(nextBoundaryMs: number | null, refresh: () => void): void {
    React.useEffect(() => {
        if (nextBoundaryMs === null) return undefined;
        return armDeadlineTimer(nextBoundaryMs, refresh);
    }, [nextBoundaryMs, refresh]);
}
