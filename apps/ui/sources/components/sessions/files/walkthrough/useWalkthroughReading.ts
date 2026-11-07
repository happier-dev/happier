import * as React from 'react';

import { buildWalkthroughReading, type WalkthroughReading, type WalkthroughReadingInput } from './walkthroughReading';
import { createWalkthroughReviewedSource } from './walkthroughReviewedProjection';

export function useWalkthroughReading(input: WalkthroughReadingInput, observation?: 'keyed'): WalkthroughReading;
export function useWalkthroughReading(input: WalkthroughReadingInput | null, observation?: 'keyed'): WalkthroughReading | null;
export function useWalkthroughReading(input: WalkthroughReadingInput | null, observation?: 'keyed'): WalkthroughReading | null {
    const comparison = input?.comparison ?? null;
    const walkthrough = input?.walkthrough ?? null;
    const analysis = input?.analysis ?? null;
    const reviewed = input?.reviewed ?? null;
    const recordSource = input?.reviewedRecordSource;
    const provenance = input?.provenance;
    // Code/evidence has its own lifetime. A mark changes only the personal facts
    // projected below; it cannot invalidate hunk parsing, Find or code-card props.
    const base = React.useMemo(() => comparison
        ? buildWalkthroughReading({ comparison, walkthrough, analysis, reviewed: null, provenance }) : null,
    [comparison, walkthrough, analysis, provenance]);
    // Only captured structure replaces the source. Initialize from the current record so restored
    // readings choose the same first unread stop; subsequent records arrive through the subscription.
    const source = React.useMemo(() => {
        if (!base || !comparison) return null;
        const next = createWalkthroughReviewedSource(base, comparison);
        next.apply(recordSource ? recordSource.getSnapshot() : reviewed);
        return next;
    }, [base, comparison]);
    React.useLayoutEffect(() => {
        if (!source) return;
        const apply = () => source.apply(recordSource ? recordSource.getSnapshot() : reviewed);
        const unsubscribe = recordSource?.subscribe(apply);
        apply();
        return unsubscribe;
    }, [source, recordSource, reviewed]);
    const read = observation === 'keyed' ? source?.getBase : source?.getSnapshot;
    return React.useSyncExternalStore(observation === 'keyed' ? noSubscribe : source?.subscribe ?? noSubscribe, read ?? empty, read ?? empty);
}

const noSubscribe = () => () => {};
const empty = () => null;
