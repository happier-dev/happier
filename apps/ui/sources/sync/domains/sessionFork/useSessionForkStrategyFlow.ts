import * as React from 'react';

import { SessionForkRpcResultSchema, type LlmTaskRunnerConfigV1, type SessionForkPoint } from '@happier-dev/protocol';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { storage } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { getStorage } from '@/sync/domains/state/storageStore';
import { randomUUID } from '@/platform/randomUUID';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';

import { completeSessionForkNavigation } from './completeSessionForkNavigation';
import {
    classifySessionForkRpcOutcome,
    findForkChildForRequest,
    isForkChildOfRequest,
    type SessionForkChildCandidate,
    type SessionForkOperationRoute,
} from './sessionForkStrategy';

export type SessionForkStrategyRequest = Readonly<{
    parentSessionId: string;
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
    /** Admission created an approval; no fork mutation has been issued. */
    | Readonly<{ type: 'awaiting_approval'; route: SessionForkOperationRoute; artifactId: string }>
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
    /** True while admission, approval custody, an effect or reconciliation is pending. */
    isBusy: boolean;
    /** The existing mounted Action owner has bound this Home's Account. */
    ready: boolean;
    submit: (route: SessionForkOperationRoute) => Promise<void>;
    checkForFork: () => Promise<void>;
    retryOpen: () => Promise<void>;
}>;

function readSessionCandidates(): readonly SessionForkChildCandidate[] {
    const sessions = storage.getState().sessions as Record<string, {
        metadata?: unknown;
        metadataLayoutVersion?: number;
        ownerMetadataView?: unknown;
    } | undefined>;
    const out: SessionForkChildCandidate[] = [];
    for (const [sessionId, session] of Object.entries(sessions)) {
        if (!session) continue;
        out.push({
            sessionId,
            metadata: readSessionOwnerMetadataView({
                metadata: session.metadata ?? null,
                metadataLayoutVersion: session.metadataLayoutVersion,
                ownerMetadataView: session.ownerMetadataView,
            }),
        });
    }
    return out;
}

function readMatchingChildSessionIds(params: Readonly<{
    parentSessionId: string;
    forkPoint: SessionForkPoint;
    route: SessionForkOperationRoute;
    requestId: string;
}>): Set<string> {
    const known = new Set<string>();
    for (const candidate of readSessionCandidates()) {
        if (isForkChildOfRequest(candidate, params)) known.add(candidate.sessionId);
    }
    return known;
}

export function useSessionForkStrategyFlow(params: Readonly<{
    request: SessionForkStrategyRequest;
    navigate: (childSessionId: string, options?: Readonly<{ serverId?: string }>) => void | Promise<void>;
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
    const activeRouteRef = React.useRef<SessionForkOperationRoute | null>(null);
    const onApprovalPending = React.useCallback((registration: ActionApprovalContinuation) => {
        const route = activeRouteRef.current;
        if (route) applyPhase({ type: 'awaiting_approval', route, artifactId: registration.artifactId });
    }, [applyPhase]);
    const execution = useMountedActionExecution(request.serverId ?? getStorage().getState().profileScope?.serverId,
        { onApprovalPending });
    const executeAction = execution.execute;
    React.useEffect(() => {
        if (phase.type === 'awaiting_approval' && execution.approval.approvalStatus === 'executing') {
            applyPhase({ type: 'submitting', route: phase.route });
        }
    }, [applyPhase, execution.approval.approvalStatus, phase]);

    const openChild = React.useCallback(async (
        route: SessionForkOperationRoute,
        childSessionId: string,
    ): Promise<void> => {
        if (!mountedRef.current) return;
        applyPhase({ type: 'opening', route, childSessionId, stalled: false });
        let navigated = false;
        try {
            await completeSessionForkNavigation({
                childSessionId,
                parentSessionId: request.parentSessionId,
                serverId: request.serverId,
                navigate: async (targetSessionId, options) => {
                    if (!mountedRef.current) return;
                    navigated = true;
                    await navigate(targetSessionId, options);
                },
                restoredDraftText: request.restoredDraftText ?? null,
                sourceMessageId: request.sourceMessageId ?? null,
                writeForkInitialPrompt: request.writeForkInitialPrompt === true,
            });
        } catch {
            if (!mountedRef.current) return;
            // Anything that fails AFTER navigation is best-effort follow-up: the
            // fork exists and the user is already looking at it, and the restored
            // draft was written only after the child lineage was proven. Only a
            // failure that never reached navigation leaves the child unopened.
            if (!navigated) {
                applyPhase({ type: 'opening', route, childSessionId, stalled: true });
                return;
            }
        }
        if (!mountedRef.current) return;
        applyPhase({ type: 'navigated' });
        onNavigated();
    }, [applyPhase, navigate, onNavigated, request]);

    const submit = React.useCallback(async (route: SessionForkOperationRoute): Promise<void> => {
        if (!execution.ready || inFlightRef.current) return;
        // An emitted request whose outcome is unknown must never be reissued:
        // that is exactly how a duplicate provider-side fork gets created.
        if (phase.type !== 'choosing') return;

        inFlightRef.current = true;
        activeRouteRef.current = route;
        setFailure(null);
        applyPhase({ type: 'submitting', route });
        knownChildrenRef.current = readMatchingChildSessionIds({
            parentSessionId: request.parentSessionId,
            forkPoint: request.forkPoint,
            route,
            requestId: requestIdFor(route),
        });

        const releaseUserRequestLease = sync.acquireUserRequestLease();
        try {
            const requestId = requestIdFor(route);
            const profileScope = getStorage().getState().profileScope;
            actionOperationPresentationCoordinator.register({
                serverId: request.serverId,
                accountId: profileScope?.serverId === request.serverId ? profileScope.accountId : '',
                requestId,
                onStart: 'current',
            });
            const action = await executeAction('session.fork', {
                ...(request.serverId ? { serverId: request.serverId } : {}),
                sessionId: request.parentSessionId,
                forkPoint: request.forkPoint,
                strategy: route,
                requestId,
                ...(typeof request.replayMaxSeedChars === 'number'
                    ? { replayMaxSeedChars: request.replayMaxSeedChars }
                    : {}),
                ...(request.replaySummaryRunner ? { replaySummaryRunner: request.replaySummaryRunner } : {}),
            }, { actionRequestId: requestId });
            const result = action.ok
                ? SessionForkRpcResultSchema.safeParse(action.result)
                : { success: true as const, data: { ok: false as const, errorCode: action.errorCode, errorMessage: action.error } };
            if (!result.success) {
                applyPhase({ type: 'unknown', route, checking: false, lastCheck: null });
                return;
            }
            const outcome = classifySessionForkRpcOutcome(result.data);
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
        } catch {
            // The historical request was issued with a stable request id. An
            // ambiguous transport result reconciles that identity and never
            // replays the fork mutation.
            applyPhase({ type: 'unknown', route, checking: false, lastCheck: null });
        } finally {
            releaseUserRequestLease();
            inFlightRef.current = false;
        }
    }, [applyPhase, executeAction, execution.ready, openChild, phase.type, request, requestIdFor]);

    const checkForFork = React.useCallback(async (): Promise<void> => {
        if (inFlightRef.current) return;
        if (phase.type !== 'unknown') return;
        const route = phase.route;

        inFlightRef.current = true;
        applyPhase({ type: 'unknown', route, checking: true, lastCheck: phase.lastCheck });
        try {
            try {
                await sync.refreshSessions({ awaitSessionListHydration: true });
            } catch {
                // A failed refresh only means the local view is still stale; the
                // lookup below simply will not find anything yet.
            }
            const lookup = findForkChildForRequest({
                candidates: readSessionCandidates(),
                parentSessionId: request.parentSessionId,
                forkPoint: request.forkPoint,
                route,
                requestId: requestIdFor(route),
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
    }, [applyPhase, openChild, phase, request, requestIdFor]);

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
        || phase.type === 'awaiting_approval'
        || (phase.type === 'opening' && !phase.stalled)
        || (phase.type === 'unknown' && phase.checking);

    return { phase, failure, isBusy, ready: execution.ready, submit, checkForFork, retryOpen };
}
