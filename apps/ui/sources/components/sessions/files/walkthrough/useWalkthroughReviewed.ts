import * as React from 'react';
import type { WalkthroughStop } from './walkthroughReading';
import type { WalkthroughReviewedSource } from './walkthroughReviewedProjection';

const noSubscribe = () => () => {};

export function useWalkthroughReviewedStop(source: WalkthroughReviewedSource | undefined, stop: WalkthroughStop): WalkthroughStop {
    const subscribe = React.useCallback((listener: () => void) => source?.subscribeStop(stop.id, listener) ?? noSubscribe(), [source, stop.id]);
    const read = () => source?.getStop(stop.id) ?? stop;
    return React.useSyncExternalStore(subscribe, read, read);
}

export function useWalkthroughReviewedCount(source: WalkthroughReviewedSource | undefined, fallback: number): number {
    const read = () => source?.getReviewedCount() ?? fallback;
    return React.useSyncExternalStore(source?.subscribeProgress ?? noSubscribe, read, read);
}
