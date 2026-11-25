import * as React from 'react';

import { focusExactHomeAndRefresh } from '@/sync/domains/server/focusExactHome';

export type ExactHomeDestinationState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'focusing' }>
    /** Focus could not be established; the person stays here and may try again. */
    | Readonly<{ kind: 'blocked'; retry: () => void }>;

export type ExactHomeArrivalOutcome = 'arrived' | 'blocked' | 'retired';

const IDLE: ExactHomeDestinationState = Object.freeze({ kind: 'idle' as const });
const FOCUSING: ExactHomeDestinationState = Object.freeze({ kind: 'focusing' as const });

export type ExactHomeArrival = Readonly<{
    state: ExactHomeDestinationState;
    /**
     * The arrival for a destination that already owns its own composed
     * focus-then-mount opener, such as `openAccountSecurityForHome`. The opener
     * reports whether the exact Home was reached, and a `false` is the blocked
     * state above rather than a silently discarded outcome — which is what would
     * otherwise leave a committed mutation's affordance mounted and invite a
     * second submission of a bearer that has already been consumed.
     */
    continueThrough: (open: () => Promise<boolean>, onArrival?: () => void) => Promise<ExactHomeArrivalOutcome>;
}>;

/**
 * The one focus/blocked/retry state for a committed operation's arrival.
 *
 * Hosts that own nothing but an opener — a generic Connect flow, the Welcome
 * modal — consume this directly; `useExactHomeDestination` composes it for the
 * link landings that also need the focus itself.
 */
export function useExactHomeArrival(): ExactHomeArrival {
    const [state, setState] = React.useState<ExactHomeDestinationState>(IDLE);
    const mountedRef = React.useRef(true);
    const openingRef = React.useRef<Promise<boolean> | null>(null);

    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            openingRef.current = null;
        };
    }, []);

    const continueThrough = React.useCallback(async (
        open: () => Promise<boolean>,
        onArrival?: () => void,
    ): Promise<ExactHomeArrivalOutcome> => {
        setState(FOCUSING);
        const opening = Promise.resolve().then(open);
        openingRef.current = opening;
        let reached = false;
        try {
            reached = await opening;
            if (reached && mountedRef.current && openingRef.current === opening) onArrival?.();
        } catch {
            // A rejected focus/refresh is the same recoverable arrival failure as
            // an explicit false result. The committed operation happened before
            // this owner, so retry must retain only this opener.
            reached = false;
        }
        if (!mountedRef.current || openingRef.current !== opening) return 'retired';
        openingRef.current = null;
        if (reached) {
            setState(IDLE);
            return 'arrived';
        }
        setState({ kind: 'blocked', retry: () => { void continueThrough(open, onArrival); } });
        return 'blocked';
    }, []);

    return React.useMemo(() => ({ state, continueThrough }), [continueThrough, state]);
}

/**
 * Where a mail or invitation link goes once its credentials have committed.
 *
 * Those credentials belong to the Home the link named, which may not be the Home
 * this device is focused on; navigating before that focus moves would show the
 * previous Home's content and read as the operation having done nothing. So the
 * destination is reached only after the exact Home is focused, and a blocked or
 * failed switch is a state this screen keeps — with a retry — rather than a
 * silent redirect.
 *
 * Retry re-runs only the focus and the exact destination. The one-time bearer was
 * already consumed by the operation that succeeded, so nothing here re-submits
 * it, re-provisions, or re-accepts an invitation.
 */
export function useExactHomeDestination(params: Readonly<{
    refreshAuth: () => Promise<void>;
    /** Where the host lands once focus holds. Omit when focus itself is the arrival. */
    onFocused?: () => void;
}>): ExactHomeArrival & Readonly<{
    /**
     * `arrive` overrides where this one continuation lands. A host may reach more
     * than one exact destination from the same committed operation — an atomic
     * Team admission opens that Team, everything else returns to the Home — and
     * both must wait for the same focus rather than growing a second owner.
     */
    continueToHome: (serverId: string, arrive?: () => void) => Promise<ExactHomeArrivalOutcome>;
}> {
    const arrival = useExactHomeArrival();
    const paramsRef = React.useRef(params);
    paramsRef.current = params;

    const { continueThrough } = arrival;
    const continueToHome = React.useCallback((
        serverId: string,
        arrive?: () => void,
    ) => continueThrough(
        () => focusExactHomeAndRefresh({ serverId, refreshAuth: paramsRef.current.refreshAuth }),
        () => (arrive ?? paramsRef.current.onFocused)?.(),
    ), [continueThrough]);

    return React.useMemo(
        () => ({ ...arrival, continueToHome }),
        [arrival, continueToHome],
    );
}
