import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';

export type UseSessionViewedLifecycleInput = Readonly<{
    sessionId: string;
    sessionSeq: number | null;
    surfaceFocused: boolean;
}>;

export function useSessionViewedLifecycle(input: UseSessionViewedLifecycleInput): void {
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);

    const markSessionViewed = React.useCallback((opts?: { sessionSeq?: number }) => {
        fireAndForget(sync.markSessionViewed(input.sessionId, opts), { tag: 'SessionView.markSessionViewed' });
    }, [input.sessionId]);

    React.useEffect(() => {
        if (!input.surfaceFocused) return;

        const current = storage.getState().sessions[input.sessionId];
        lastMarkedRef.current = {
            sessionSeq: current?.seq ?? 0,
        };
        const cancelMarkViewed = runAfterInteractionsWithFallback(markSessionViewed);

        return () => {
            const sessionSeqAtBlur = storage.getState().sessions[input.sessionId]?.seq ?? 0;
            cancelMarkViewed();
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
            runAfterInteractionsWithFallback(() => {
                markSessionViewed({ sessionSeq: sessionSeqAtBlur });
            });
        };
    }, [input.sessionId, input.surfaceFocused, markSessionViewed]);

    React.useEffect(() => {
        if (!input.surfaceFocused) return;

        const sessionSeq = input.sessionSeq ?? 0;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;

        lastMarkedRef.current = { sessionSeq };
        if (markViewedTimeoutRef.current) {
            clearTimeout(markViewedTimeoutRef.current);
        }
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            markSessionViewed();
        }, 250);

        return () => {
            if (markViewedTimeoutRef.current) {
                clearTimeout(markViewedTimeoutRef.current);
                markViewedTimeoutRef.current = null;
            }
        };
    }, [input.sessionSeq, input.surfaceFocused, markSessionViewed]);
}
