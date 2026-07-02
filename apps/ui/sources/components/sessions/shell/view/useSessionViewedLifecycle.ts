import * as React from 'react';

import {
    beginSessionViewingActivation,
    clearManualUnreadHold,
    endSessionViewingActivation,
    shouldSuppressAutomaticMarkViewed,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';

const SESSION_VIEWED_SEQ_CHANGE_MARK_DELAY_MS = 250;

export type UseSessionViewedLifecycleInput = Readonly<{
    sessionId: string;
    visibleReadSeq: number | null;
    surfaceFocused: boolean;
}>;

function normalizeVisibleReadSeq(value: number | null): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

export function useSessionViewedLifecycle(input: UseSessionViewedLifecycleInput): void {
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);
    const pendingMarkRef = React.useRef<{ sessionSeq: number } | null>(null);
    const activationIdRef = React.useRef<number | null>(null);
    const visibleReadSeqRef = React.useRef<number | null>(null);
    const activeViewingSeqRef = React.useRef<{
        sessionId: string;
        activationId: number;
        visibleReadSeq: number | null;
    } | null>(null);
    const currentVisibleReadSeq = normalizeVisibleReadSeq(input.visibleReadSeq);
    visibleReadSeqRef.current = currentVisibleReadSeq;

    const clearDelayedMark = React.useCallback(() => {
        if (markViewedTimeoutRef.current) {
            clearTimeout(markViewedTimeoutRef.current);
            markViewedTimeoutRef.current = null;
        }
        pendingMarkRef.current = null;
    }, []);

    const markSessionViewed = React.useCallback((opts: { sessionSeq: number; activationId: number | null }) => {
        const sessionSeq = normalizeVisibleReadSeq(opts.sessionSeq);
        if (sessionSeq === null) return;
        if (shouldSuppressAutomaticMarkViewed({
            sessionId: input.sessionId,
            sessionSeq,
            activationId: opts.activationId,
        })) {
            return;
        }
        fireAndForget(
            sync.markSessionViewed(input.sessionId, { sessionSeq }).then(() => {
                clearManualUnreadHold({ sessionId: input.sessionId, activationId: opts.activationId });
            }),
            { tag: 'SessionView.markSessionViewed' },
        );
    }, [input.sessionId]);

    React.useLayoutEffect(() => {
        const active = activeViewingSeqRef.current;
        if (active?.sessionId === input.sessionId) {
            active.visibleReadSeq = currentVisibleReadSeq;
        }
    }, [currentVisibleReadSeq, input.sessionId]);

    React.useEffect(() => {
        if (!input.surfaceFocused) return;

        const activationId = beginSessionViewingActivation(input.sessionId);
        activationIdRef.current = activationId;
        const initialVisibleSeq = visibleReadSeqRef.current;
        activeViewingSeqRef.current = {
            sessionId: input.sessionId,
            activationId,
            visibleReadSeq: initialVisibleSeq,
        };
        lastMarkedRef.current = initialVisibleSeq === null ? null : { sessionSeq: initialVisibleSeq };
        const cancelMarkViewed = initialVisibleSeq === null
            ? () => {}
            : runAfterInteractionsWithFallback(() => {
                markSessionViewed({ sessionSeq: initialVisibleSeq, activationId });
            });

        return () => {
            const activeViewingSeq = activeViewingSeqRef.current;
            const activeViewingSeqMatches = activeViewingSeq?.sessionId === input.sessionId
                && activeViewingSeq.activationId === activationId;
            const sessionSeqAtBlur = activeViewingSeqMatches ? activeViewingSeq.visibleReadSeq : initialVisibleSeq;
            if (activeViewingSeqMatches) {
                activeViewingSeqRef.current = null;
            }
            cancelMarkViewed();
            clearDelayedMark();
            if (sessionSeqAtBlur !== null && !shouldSuppressAutomaticMarkViewed({
                sessionId: input.sessionId,
                sessionSeq: sessionSeqAtBlur,
                activationId,
            })) {
                runAfterInteractionsWithFallback(() => {
                    markSessionViewed({ sessionSeq: sessionSeqAtBlur, activationId });
                });
            }
            endSessionViewingActivation(input.sessionId, activationId);
            if (activationIdRef.current === activationId) {
                activationIdRef.current = null;
            }
        };
    }, [clearDelayedMark, input.sessionId, input.surfaceFocused, markSessionViewed]);

    React.useEffect(() => {
        if (!input.surfaceFocused) return;

        const sessionSeq = normalizeVisibleReadSeq(input.visibleReadSeq);
        if (sessionSeq === null) return;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;
        const pending = pendingMarkRef.current;
        if (pending && pending.sessionSeq >= sessionSeq) return;

        if (shouldSuppressAutomaticMarkViewed({
            sessionId: input.sessionId,
            sessionSeq,
            activationId: activationIdRef.current,
        })) {
            return;
        }

        clearDelayedMark();
        pendingMarkRef.current = { sessionSeq };
        const activationId = activationIdRef.current;
        markViewedTimeoutRef.current = setTimeout(() => {
            markViewedTimeoutRef.current = null;
            pendingMarkRef.current = null;
            lastMarkedRef.current = { sessionSeq };
            markSessionViewed({ sessionSeq, activationId });
        }, SESSION_VIEWED_SEQ_CHANGE_MARK_DELAY_MS);

        return clearDelayedMark;
    }, [clearDelayedMark, input.sessionId, input.visibleReadSeq, input.surfaceFocused, markSessionViewed]);
}
