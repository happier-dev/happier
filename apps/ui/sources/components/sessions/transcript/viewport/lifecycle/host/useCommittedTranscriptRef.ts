import * as React from 'react';

type MutableRef<T> = { current: T };

/**
 * Publishes an externally callable transcript ref only after its render commits.
 *
 * The previously committed callback remains authoritative through interrupted or
 * abandoned concurrent renders. Insertion phase makes the committed value visible
 * before child layout callbacks can call back into the transcript owner.
 */
export function useCommittedTranscriptRef<T>(
    targetRef: MutableRef<T>,
    value: T,
): void {
    React.useInsertionEffect(() => {
        targetRef.current = value;
    }, [targetRef, value]);
}
