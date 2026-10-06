import * as React from 'react';
import { beginSessionReminderViewing } from '@/sync/ops/sessionOrganization/sessionReminderViewing';

import {
    beginSessionViewingActivation,
    clearManualUnreadHold,
    endSessionViewingActivation,
    shouldSuppressAutomaticMarkViewed,
} from '@/sync/domains/session/readState/sessionManualUnreadHold';
import { isDemoModeActive } from '@/demoMode/runtime/enterExitDemoMode';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';

const SESSION_VIEWED_SEQ_CHANGE_MARK_DELAY_MS = 250;

export type UseSessionViewedLifecycleInput = Readonly<{
    address: SessionAddress;
    visibleReadSeq: number | null;
    surfaceFocused: boolean;
}>;

function normalizeVisibleReadSeq(value: number | null): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

export function useSessionViewedLifecycle(input: UseSessionViewedLifecycleInput): void {
    const address = normalizeSessionAddress(input.address.serverId, input.address.sessionId);
    const serverId = address?.serverId ?? '';
    const sessionId = address?.sessionId ?? '';
    const demoModeActive = isDemoModeActive();
    const markViewedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastMarkedRef = React.useRef<{ sessionSeq: number } | null>(null);
    const pendingMarkRef = React.useRef<{ sessionSeq: number } | null>(null);
    const activationIdRef = React.useRef<number | null>(null);
    const visibleReadSeqRef = React.useRef<number | null>(null);
    const activeViewingSeqRef = React.useRef<{
        serverId: string;
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
        if (demoModeActive) return;
        const sessionSeq = normalizeVisibleReadSeq(opts.sessionSeq);
        if (sessionSeq === null) return;
        if (shouldSuppressAutomaticMarkViewed({
            sessionId,
            sessionSeq,
            activationId: opts.activationId,
        })) {
            return;
        }
        fireAndForget(
            sync.markSessionViewed({ serverId, sessionId }, { sessionSeq }).then(() => {
                clearManualUnreadHold({ sessionId, activationId: opts.activationId });
            }),
            { tag: 'SessionView.markSessionViewed' },
        );
    }, [demoModeActive, serverId, sessionId]);

    React.useLayoutEffect(() => {
        const active = activeViewingSeqRef.current;
        if (active?.serverId === serverId && active.sessionId === sessionId) {
            active.visibleReadSeq = currentVisibleReadSeq;
        }
    }, [currentVisibleReadSeq, serverId, sessionId]);

    React.useEffect(() => {
        if (!input.surfaceFocused || demoModeActive) return;

        if (!serverId || !sessionId) return;
        const activationId = beginSessionViewingActivation(sessionId);
        const endReminderViewing = beginSessionReminderViewing({ serverId, sessionId });
        activationIdRef.current = activationId;
        const initialVisibleSeq = visibleReadSeqRef.current;
        activeViewingSeqRef.current = {
            serverId,
            sessionId,
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
            endReminderViewing();
            const activeViewingSeq = activeViewingSeqRef.current;
            const activeViewingSeqMatches = activeViewingSeq?.serverId === serverId
                && activeViewingSeq.sessionId === sessionId
                && activeViewingSeq.activationId === activationId;
            const sessionSeqAtBlur = activeViewingSeqMatches ? activeViewingSeq.visibleReadSeq : initialVisibleSeq;
            if (activeViewingSeqMatches) {
                activeViewingSeqRef.current = null;
            }
            cancelMarkViewed();
            clearDelayedMark();
            if (sessionSeqAtBlur !== null && !shouldSuppressAutomaticMarkViewed({
                sessionId,
                sessionSeq: sessionSeqAtBlur,
                activationId,
            })) {
                runAfterInteractionsWithFallback(() => {
                    markSessionViewed({ sessionSeq: sessionSeqAtBlur, activationId });
                });
            }
            endSessionViewingActivation(sessionId, activationId);
            if (activationIdRef.current === activationId) {
                activationIdRef.current = null;
            }
        };
    }, [clearDelayedMark, demoModeActive, input.surfaceFocused, markSessionViewed, serverId, sessionId]);

    React.useEffect(() => {
        if (!input.surfaceFocused || demoModeActive) {
            clearDelayedMark();
            return;
        }

        const sessionSeq = normalizeVisibleReadSeq(input.visibleReadSeq);
        if (sessionSeq === null) return;
        const last = lastMarkedRef.current;
        if (last && last.sessionSeq >= sessionSeq) return;
        const pending = pendingMarkRef.current;
        if (pending && pending.sessionSeq >= sessionSeq) return;

        if (shouldSuppressAutomaticMarkViewed({
            sessionId,
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
    }, [clearDelayedMark, demoModeActive, input.visibleReadSeq, input.surfaceFocused, markSessionViewed, sessionId]);
}
