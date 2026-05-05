import * as React from 'react';

import {
    beginSessionViewingActivation,
    clearManualUnreadHold,
    endSessionViewingActivation,
    shouldSuppressAutomaticMarkViewed,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
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
    const activationIdRef = React.useRef<number | null>(null);

    const markSessionViewed = React.useCallback((opts?: { sessionSeq?: number }) => {
        fireAndForget(
            sync.markSessionViewed(input.sessionId, opts).then(() => {
                clearManualUnreadHold({ sessionId: input.sessionId });
            }),
            { tag: 'SessionView.markSessionViewed' },
        );
    }, [input.sessionId]);

    React.useEffect(() => {
        if (!input.surfaceFocused) return;

        const activationId = beginSessionViewingActivation(input.sessionId);
        activationIdRef.current = activationId;
        const current = storage.getState().sessions[input.sessionId];
        if (shouldSuppressAutomaticMarkViewed({
            sessionId: input.sessionId,
            sessionSeq: current?.seq ?? 0,
            activationId,
        })) {
            return () => {
                endSessionViewingActivation(input.sessionId, activationId);
                if (activationIdRef.current === activationId) {
                    activationIdRef.current = null;
                }
            };
        }

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
                if (!shouldSuppressAutomaticMarkViewed({
                    sessionId: input.sessionId,
                    sessionSeq: sessionSeqAtBlur,
                    activationId,
                })) {
                    markSessionViewed({ sessionSeq: sessionSeqAtBlur });
                }
            });
            endSessionViewingActivation(input.sessionId, activationId);
            if (activationIdRef.current === activationId) {
                activationIdRef.current = null;
            }
        };
    }, [input.sessionId, input.surfaceFocused, markSessionViewed]);

    React.useEffect(() => {
        if (!input.surfaceFocused) return;

        const sessionSeq = input.sessionSeq ?? 0;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;

        if (shouldSuppressAutomaticMarkViewed({
            sessionId: input.sessionId,
            sessionSeq,
            activationId: activationIdRef.current,
        })) {
            return;
        }

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
