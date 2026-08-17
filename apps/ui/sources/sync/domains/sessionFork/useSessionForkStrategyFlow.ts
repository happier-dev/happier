import * as React from 'react';

import type { LlmTaskRunnerConfigV1, SessionForkPoint } from '@happier-dev/protocol';

import { completeSessionForkNavigation } from '@/components/sessions/transcript/forkContext/completeSessionForkNavigation';
import { forkSession } from '@/sync/ops';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';

import {
    classifySessionForkRpcOutcome,
    findForkChildForRequest,
    isForkChildOfRequest,
    type SessionForkChildCandidate,
    type SessionForkOperationRoute,
} from './sessionForkStrategy';

export type SessionForkStrategyRequest = Readonly<{
    parentSessionId: string;
    /** Carried on the fork RPC and available to the caller's navigation href. */
    serverId: string | null;
    machineId: string | null;
    forkPoint: SessionForkPoint;
    replayMaxSeedChars?: number;
    replaySummaryRunner?: LlmTaskRunnerConfigV1;
    restoredDraftText?: string | null;
    sourceMessageId?: string | null;
    writeForkInitialPrompt?: boolean;
}>;

export type SessionForkStrategyFailure = Readonly<{
    route: SessionForkOperationRoute;
    kind: 'update_required' | 'error';
    message: string | null;
}>;

/**
 * Presentation phases derived from the request promise and real child
 * hydration. They are not persisted, are not on the wire, and never carry a
 * fabricated percentage — the modal can only truthfully say which of these
 * locally observable milestones it has reached.
 */
export type SessionForkStrategyFlowPhase =
    | Readonly<{ type: 'choosing' }>
    | Readonly<{ type: 'submitting'; route: SessionForkOperationRoute }>
    /** The daemon named the child; it is not visible/navigable here yet. */
    | Readonly<{ type: 'opening'; route: SessionForkOperationRoute; childSessionId: string; stalled: boolean }>
    /** The request was emitted and its outcome cannot be established. */
    | Readonly<{
        type: 'unknown';
        route: SessionForkOperationRoute;
        checking: boolean;
        lastCheck: 'none' | 'ambiguous' | null;
    }>
    | Readonly<{ type: 'navigated' }>;

export type SessionForkStrategyFlow = Readonly<{
    phase: SessionForkStrategyFlowPhase;
    failure: SessionForkStrategyFailure | null;
    /** True while an effectful request or a reconciliation pass is running. */
    isBusy: boolean;
    submit: (route: SessionForkOperationRoute) => Promise<void>;
    checkForFork: () => Promise<void>;
    retryOpen: () => Promise<void>;
}>;

function readSessionCandidates(): readonly SessionForkChildCandidate[] {
    const sessions = storage.getState().sessions as Record<string, { metadata?: unknown } | undefined>;
    const out: SessionForkChildCandidate[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
        if (!session) continue;
        out.push({ sessionId, metadata: session.metadata });
    }
    return out;
}

function readMatchingChildSessionIds(params: Readonly<{
    parentSessionId: string;
    forkPoint: SessionForkPoint;
    route: SessionForkOperationRoute;
}>): Set<string> {
    const known = new Set<string>();
    for (const candidate of readSessionCandidates()) {
        if (isForkChildOfRequest(candidate, params)) known.add(candidate.sessionId);
    }
    return known;
}

export function useSessionForkStrategyFlow(params: Readonly<{
    request: SessionForkStrategyRequest;
    navigate: (childSessionId: string) => void | Promise<void>;
    onNavigated: () => void;
}>): SessionForkStrategyFlow {
    const { request, navigate, onNavigated } = params;

    const [phase, setPhase] = React.useState<SessionForkStrategyFlowPhase>({ type: 'choosing' });
    const [failure, setFailure] = React.useState<SessionForkStrategyFailure | null>(null);

    const mountedRef = React.useRef(true);
    React.useEffect(() => () => { mountedRef.current = false; }, []);

    // One key per (modal instance × route). Retrying the same route reuses it so
    // the daemon coalesces onto the in-flight fork instead of committing a
    // second one; choosing the other route is a genuinely different fork and
    // gets its own key.
    const flowIdRef = React.useRef<string | null>(null);
    if (flowIdRef.current === null) flowIdRef.current = randomUUID();
    const requestIdFor = React.useCallback(
        (route: SessionForkOperationRoute) => `${flowIdRef.current}:${route}`,
        [],
    );

    // Children that already existed when the request went out. Newness is proven
    // against this set rather than a daemon-clock timestamp.
    const knownChildrenRef = React.useRef<Set<string>>(new Set());
    const inFlightRef = React.useRef(false);

    const applyPhase = React.useCallback((next: SessionForkStrategyFlowPhase) => {
        if (!mountedRef.current) return;
        setPhase(next);
    }, []);

    const openChild = React.useCallback(async (
        route: SessionForkOperationRoute,
        childSessionId: string,
    ): Promise<void> => {
        applyPhase({ type: 'opening', route, childSessionId, stalled: false });
        let navigated = false;
        try {
            await completeSessionForkNavigation({
                childSessionId,
                parentSessionId: request.parentSessionId,
                navigate: async (targetSessionId) => {
                    navigated = true;
                    await navigate(targetSessionId);
                },
                restoredDraftText: request.restoredDraftText ?? null,
                sourceMessageId: request.sourceMessageId ?? null,
                writeForkInitialPrompt: request.writeForkInitialPrompt === true,
            });
        } catch {
            // Anything that fails AFTER navigation is best-effort follow-up: the
            // fork exists and the user is already looking at it, and the restored
            // draft was written locally before hydration. Only a failure that
            // never reached navigation leaves the child unopened.
            if (!navigated) {
                applyPhase({ type: 'opening', route, childSessionId, stalled: true });
                return;
            }
        }
        applyPhase({ type: 'navigated' });
        onNavigated();
    }, [applyPhase, navigate, onNavigated, request]);

    const submit = React.useCallback(async (route: SessionForkOperationRoute): Promise<void> => {
        if (inFlightRef.current) return;
        // An emitted request whose outcome is unknown must never be reissued:
        // that is exactly how a duplicate provider-side fork gets created.
        if (phase.type !== 'choosing') return;

        inFlightRef.current = true;
        setFailure(null);
        applyPhase({ type: 'submitting', route });
        knownChildrenRef.current = readMatchingChildSessionIds({
            parentSessionId: request.parentSessionId,
            forkPoint: request.forkPoint,
            route,
        });

        try {
            const result = await forkSession({
                ...(request.machineId ? { machineId: request.machineId } : {}),
                ...(request.serverId ? { serverId: request.serverId } : {}),
                parentSessionId: request.parentSessionId,
                forkPoint: request.forkPoint,
                strategy: route,
                requestId: requestIdFor(route),
                ...(typeof request.replayMaxSeedChars === 'number'
                    ? { replayMaxSeedChars: request.replayMaxSeedChars }
                    : {}),
                ...(request.replaySummaryRunner ? { replaySummaryRunner: request.replaySummaryRunner } : {}),
            });

            const outcome = classifySessionForkRpcOutcome(result);
            if (outcome.type === 'created') {
                await openChild(route, outcome.childSessionId);
                return;
            }
            if (outcome.type === 'unknown') {
                applyPhase({ type: 'unknown', route, checking: false, lastCheck: null });
                return;
            }
            if (mountedRef.current) {
                setFailure({ route, kind: outcome.kind, message: outcome.message });
            }
            applyPhase({ type: 'choosing' });
        } finally {
            inFlightRef.current = false;
        }
    }, [applyPhase, openChild, phase.type, request, requestIdFor]);

    const checkForFork = React.useCallback(async (): Promise<void> => {
        if (inFlightRef.current) return;
        if (phase.type !== 'unknown') return;
        const route = phase.route;

        inFlightRef.current = true;
        applyPhase({ type: 'unknown', route, checking: true, lastCheck: phase.lastCheck });
        try {
            try {
                await sync.refreshSessions();
            } catch {
                // A failed refresh only means the local view is still stale; the
                // lookup below simply will not find anything yet.
            }
            const lookup = findForkChildForRequest({
                candidates: readSessionCandidates(),
                parentSessionId: request.parentSessionId,
                forkPoint: request.forkPoint,
                route,
                knownChildSessionIds: knownChildrenRef.current,
            });
            if (lookup.type === 'found') {
                await openChild(route, lookup.childSessionId);
                return;
            }
            applyPhase({
                type: 'unknown',
                route,
                checking: false,
                lastCheck: lookup.type === 'ambiguous' ? 'ambiguous' : 'none',
            });
        } finally {
            inFlightRef.current = false;
        }
    }, [applyPhase, openChild, phase, request]);

    const retryOpen = React.useCallback(async (): Promise<void> => {
        if (inFlightRef.current) return;
        if (phase.type !== 'opening') return;
        inFlightRef.current = true;
        try {
            await openChild(phase.route, phase.childSessionId);
        } finally {
            inFlightRef.current = false;
        }
    }, [openChild, phase]);

    const isBusy = phase.type === 'submitting'
        || (phase.type === 'opening' && !phase.stalled)
        || (phase.type === 'unknown' && phase.checking);

    return { phase, failure, isBusy, submit, checkForFork, retryOpen };
}
