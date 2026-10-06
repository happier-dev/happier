import type { Message } from "../messages/messageTypes.js";
import type { AgentState } from "../state/agentState.js";
import { isRequestInterruptedPlaceholder } from "./requestInterruptedPlaceholder.js";
import { isAgentStateRequestCoveredByCompletedRequests, resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { SessionPublicCompletedRequestV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { isSessionActionConfirmationRequest } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import { resolvePendingRequestAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import { resolveAgentRequestKind } from '@happier-dev/protocol/activity/agentRequestSummary';
import type { AgentRequestKind, SessionActionConfirmationsV1 } from '@happier-dev/protocol';

export type PendingRequestFacts = Readonly<{
    sessionId: string;
    active: boolean;
    agentState: AgentState | null;
    actionConfirmations: SessionActionConfirmationsV1 | null;
    presentationCompletedRequests: Readonly<Record<string, unknown>> | null;
    projected: Readonly<{
        permissionCount: number | null;
        userActionCount: number | null;
        observedAt: number | null;
        /** Existing session freshness fallback when the projection has no request timestamp. */
        referenceAt?: number | null;
    }> | null;
}>;

export type SessionPendingRequest = Readonly<{
    id: string;
    turnId?: string;
    source?: string;
    responseTarget?: SessionActionConfirmationsV1['requests'][string]['responseTarget'];
    tool: string;
    kind: AgentRequestKind;
    arguments: unknown;
    createdAt: number | null;
    permissionSuggestions?: unknown;
}>;

/** Request age never falls back to session activity; unknown dates follow known dates. */
export function comparePendingRequestsByAge(
    left: Pick<SessionPendingRequest, 'id' | 'createdAt'>,
    right: Pick<SessionPendingRequest, 'id' | 'createdAt'>,
): number {
    if (left.createdAt !== right.createdAt) {
        if (left.createdAt === null) return 1;
        if (right.createdAt === null) return -1;
        return left.createdAt - right.createdAt;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function selectOldestPendingRequest<T extends Pick<SessionPendingRequest, 'id' | 'createdAt'>>(
    requests: readonly T[],
): T | null {
    let oldest: T | null = null;
    for (const request of requests) {
        if (oldest === null || comparePendingRequestsByAge(request, oldest) < 0) oldest = request;
    }
    return oldest;
}

export type PendingRequestFlags = Readonly<{
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
}>;

export type SessionPendingRequestLists = Readonly<{
    permissionRequests: readonly SessionPendingRequest[];
    userActionRequests: readonly SessionPendingRequest[];
}>;

const PENDING_REQUEST_COVERAGE_OPTIONS = resolveAgentStateRequestCoverageOptions({
    kind: 'localPermissionBridge',
});

export type TranscriptRequestState =
    | Readonly<{
        status: 'pending';
        request: SessionPendingRequest;
        createdAt: number;
    }>
    | Readonly<{
        status: 'terminal';
        createdAt: number;
        terminalKind: 'hard' | 'soft_interrupted';
    }>;

/**
 * Single-use memo shared by the pending-request derivations of one caller
 * (e.g. one facts-list renderable build) so the transcript is walked at most
 * once per derivation pass. Callers holding an incrementally-maintained
 * aggregate (see `transcriptRenderableAggregate.ts`) pre-fill `states` so the
 * transcript is not walked at all.
 */
export type TranscriptRequestStatesCache = {
    states?: Map<string, TranscriptRequestState>;
};

const EMPTY_PENDING_REQUEST_FLAGS: PendingRequestFlags = {
    hasPendingPermissionRequests: false,
    hasPendingUserActionRequests: false,
};

function getRequestPermissionSuggestions(req: unknown): unknown[] | null {
    if (!req || typeof req !== 'object') return null;
    const suggestions = (req as { permissionSuggestions?: unknown }).permissionSuggestions;
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
    return suggestions as unknown[];
}

function stringifyPendingRequestArguments(value: unknown): string | null {
    if (typeof value === 'undefined') return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

function arePendingRequestsEquivalent(left: SessionPendingRequest, right: SessionPendingRequest): boolean {
    if (left.kind !== right.kind || left.tool !== right.tool) return false;

    const leftArgs = stringifyPendingRequestArguments(left.arguments);
    const rightArgs = stringifyPendingRequestArguments(right.arguments);
    if (leftArgs && rightArgs && leftArgs === rightArgs) {
        return true;
    }

    return left.createdAt !== null && right.createdAt !== null && left.createdAt === right.createdAt;
}

function mergePendingRequestMetadata(
    preferred: SessionPendingRequest,
    secondary: SessionPendingRequest,
): SessionPendingRequest {
    return {
        ...preferred,
        ...(preferred.responseTarget ?? secondary.responseTarget
            ? { responseTarget: preferred.responseTarget ?? secondary.responseTarget }
            : {}),
        ...(preferred.turnId
            ? { turnId: preferred.turnId }
            : secondary.turnId
                ? { turnId: secondary.turnId }
                : {}),
        ...(preferred.source
            ? { source: preferred.source }
            : secondary.source
                ? { source: secondary.source }
                : {}),
        arguments: typeof preferred.arguments !== 'undefined' ? preferred.arguments : secondary.arguments,
        createdAt: preferred.createdAt ?? secondary.createdAt,
        ...(preferred.permissionSuggestions
            ? { permissionSuggestions: preferred.permissionSuggestions }
            : secondary.permissionSuggestions
                ? { permissionSuggestions: secondary.permissionSuggestions }
                : {}),
    };
}

function isPendingRequestCoveredByCompleted(
    completedRequests: Record<string, unknown> | null | undefined,
    requestId: string,
    createdAt: number | null,
    request?: unknown,
): boolean {
    if (isAgentStateRequestCoveredByCompletedRequests({
        requestId,
        request: request ?? { createdAt: createdAt ?? 0 },
        completedRequests,
        options: PENDING_REQUEST_COVERAGE_OPTIONS,
    })) {
        return true;
    }

    const publicCompletion = SessionPublicCompletedRequestV1Schema.safeParse(
        completedRequests?.[requestId],
    );
    if (!publicCompletion.success || createdAt === null) return false;
    const requestRecord = request && typeof request === 'object' && !Array.isArray(request)
        ? request as Record<string, unknown>
        : {};
    const requestTool = typeof requestRecord.tool === 'string' ? requestRecord.tool : null;
    const requestKind = typeof requestRecord.kind === 'string' ? requestRecord.kind : null;
    return publicCompletion.data.createdAt === createdAt
        && publicCompletion.data.completedAt >= createdAt
        && requestTool === publicCompletion.data.tool
        && (
            requestKind === null
            || publicCompletion.data.kind === undefined
            || requestKind === publicCompletion.data.kind
        );
}

/**
 * Canonical transcript request-state merge. Given the state currently held for
 * a request id and a newly observed state, returns the state that wins.
 * Shared by the full transcript fold below and by the incremental aggregate
 * maintenance in `sync/domains/messages/transcriptRenderableAggregate.ts`.
 */
export function mergeTranscriptRequestState(
    previousState: TranscriptRequestState | undefined,
    nextState: TranscriptRequestState,
): TranscriptRequestState {
    if (!previousState) {
        return nextState;
    }

    if (nextState.status === 'terminal') {
        if (
            previousState.status !== 'terminal'
            || nextState.createdAt > previousState.createdAt
            || (
                nextState.createdAt === previousState.createdAt
                && nextState.terminalKind === 'hard'
                && previousState.terminalKind !== 'hard'
            )
        ) {
            return nextState;
        }
        return previousState;
    }

    if (previousState.status === 'terminal') {
        return nextState.createdAt > previousState.createdAt ? nextState : previousState;
    }

    return nextState.createdAt >= previousState.createdAt ? nextState : previousState;
}

function updateTranscriptRequestState(
    states: Map<string, TranscriptRequestState>,
    requestId: string,
    nextState: TranscriptRequestState,
): void {
    states.set(requestId, mergeTranscriptRequestState(states.get(requestId), nextState));
}

export function collectTranscriptRequestStates(
    messages: ReadonlyArray<Message> | null | undefined,
    completedRequests: Record<string, unknown> | null | undefined,
    states: Map<string, TranscriptRequestState>,
): void {
    if (!Array.isArray(messages) || messages.length === 0) return;

    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;

        const permission = message.tool?.permission;
        const requestId = typeof permission?.id === 'string'
            ? permission.id.trim()
            : typeof message.tool?.id === 'string'
                ? message.tool.id.trim()
                : '';
        const toolName = typeof message.tool?.name === 'string' ? message.tool.name.trim() : '';
        const createdAt = typeof message.createdAt === 'number' ? message.createdAt : 0;
        const permissionStatus = typeof permission?.status === 'string' ? permission.status : null;

        if (requestId && toolName && permissionStatus) {
            if (
                permissionStatus === 'pending'
                && !isPendingRequestCoveredByCompleted(completedRequests, requestId, createdAt, {
                    tool: toolName,
                    kind: permission.kind,
                    arguments: message.tool?.input,
                    createdAt,
                })
            ) {
                updateTranscriptRequestState(states, requestId, {
                    status: 'pending',
                    createdAt,
                    request: {
                        id: requestId,
                        tool: toolName,
                        kind: resolveAgentRequestKind({ toolName, requestKind: permission.kind }),
                        arguments: message.tool?.input,
                        createdAt,
                        ...(Array.isArray(permission.suggestions) && permission.suggestions.length > 0
                            ? { permissionSuggestions: permission.suggestions }
                            : {}),
                    },
                });
            } else if (permissionStatus !== 'pending') {
                updateTranscriptRequestState(states, requestId, {
                    status: 'terminal',
                    createdAt,
                    terminalKind: isRequestInterruptedPlaceholder({
                        permission,
                        result: message.tool?.result as { error?: unknown } | null | undefined,
                    })
                        ? 'soft_interrupted'
                        : 'hard',
                });
            }
        }

        collectTranscriptRequestStates(message.children ?? [], completedRequests, states);
    }
}

function getTranscriptRequestStates(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): Map<string, TranscriptRequestState> {
    if (statesCache?.states) {
        return statesCache.states;
    }
    const transcriptMessages = messages ?? [];
    const states = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates(
        transcriptMessages,
        facts.presentationCompletedRequests,
        states,
    );
    if (statesCache) {
        statesCache.states = states;
    }
    return states;
}

export function listPendingTranscriptRequests(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return Array.from(getTranscriptRequestStates(facts, messages).values())
        .flatMap((state) => (state.status === 'pending' ? [state.request] : []));
}

function listPendingAgentStateRequests(agentState: AgentState | SessionActionConfirmationsV1 | null | undefined): SessionPendingRequest[] {
    const requests = agentState?.requests;
    if (!requests) return [];
    const completed = agentState?.completedRequests ?? null;

    return Object.entries(requests).flatMap(([id, request]) => {
        if (!request || typeof request !== 'object') return [];
        const toolName = typeof request.tool === 'string' ? request.tool.trim() : '';
        if (!toolName) return [];
        const createdAt = typeof request.createdAt === 'number' ? request.createdAt : null;
        if (isPendingRequestCoveredByCompleted(completed as Record<string, unknown> | null | undefined, id, createdAt, request)) return [];
        return [{
            id,
            ...(typeof request.turnId === 'string' && request.turnId.trim().length > 0
                ? { turnId: request.turnId.trim() }
                : {}),
            ...(typeof request.source === 'string' && request.source.trim().length > 0
                ? { source: request.source.trim() }
                : {}),
            ...('responseTarget' in request && request.responseTarget
                ? { responseTarget: request.responseTarget }
                : {}),
            tool: toolName,
            kind: resolveAgentRequestKind({
                toolName,
                requestKind: request.kind,
            }),
            arguments: request.arguments,
            createdAt,
            ...(getRequestPermissionSuggestions(request) ? { permissionSuggestions: getRequestPermissionSuggestions(request) } : {}),
        }];
    });
}

export function derivePendingRequestFlagsFromAgentState(agentState: AgentState | SessionActionConfirmationsV1 | null | undefined): PendingRequestFlags {
    const requests = listPendingAgentStateRequests(agentState);
    if (requests.length === 0) {
        return EMPTY_PENDING_REQUEST_FLAGS;
    }
    return {
        hasPendingPermissionRequests: requests.some((request) => resolvePendingRequestAttentionReasonV1(request) === 'permission_required'),
        hasPendingUserActionRequests: requests.some((request) => resolvePendingRequestAttentionReasonV1(request) === 'user_action_required'),
    };
}

function shouldUseProjectedPendingRequestCounts(facts: PendingRequestFacts, transcriptStates: Map<string, TranscriptRequestState>): boolean {
    if (
        typeof facts.projected?.permissionCount !== 'number'
        && typeof facts.projected?.userActionCount !== 'number'
    ) {
        return false;
    }

    let hasPendingTranscriptRequests = false;
    let newestTerminalTranscriptCreatedAt = 0;
    for (const state of transcriptStates.values()) {
        if (state.status === 'pending') {
            hasPendingTranscriptRequests = true;
            continue;
        }
        newestTerminalTranscriptCreatedAt = Math.max(newestTerminalTranscriptCreatedAt, state.createdAt);
    }
    if (hasPendingTranscriptRequests) {
        return true;
    }

    if (newestTerminalTranscriptCreatedAt === 0) {
        return true;
    }

    const projectedObservedAt = readProjectedPendingRequestObservedAt(facts);
    const projectedReferenceAt = projectedObservedAt
        ?? facts.projected?.referenceAt ?? null;
    return projectedReferenceAt !== null
        && projectedReferenceAt > newestTerminalTranscriptCreatedAt;
}

function hasProjectedPendingRequestCounts(facts: PendingRequestFacts): boolean {
    return typeof facts.projected?.permissionCount === 'number'
        || typeof facts.projected?.userActionCount === 'number';
}

function hasPendingAgentRequests(facts: PendingRequestFacts): boolean {
    return listPendingAgentStateRequests(facts.agentState).length > 0
        || listPendingAgentStateRequests(facts.actionConfirmations).length > 0;
}

function hasPendingAgentUserActionRequests(facts: PendingRequestFacts): boolean {
    return derivePendingRequestFlagsFromAgentState(facts.agentState).hasPendingUserActionRequests;
}

function readProjectedPendingRequestFlags(facts: PendingRequestFacts): PendingRequestFlags {
    return {
        hasPendingPermissionRequests: (facts.projected?.permissionCount ?? 0) > 0,
        hasPendingUserActionRequests: (facts.projected?.userActionCount ?? 0) > 0,
    };
}

function readProjectedPendingRequestObservedAt(facts: PendingRequestFacts): number | null {
    const value = facts.projected?.observedAt;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : null;
}




export function deriveLatestPendingAgentStateRequestObservedAt(agentState: AgentState | null | undefined): number | null {
    let latest: number | null = null;
    for (const request of Object.values(agentState?.requests ?? {})) {
        const createdAt = typeof request?.createdAt === 'number' && Number.isFinite(request.createdAt)
            ? Math.trunc(request.createdAt)
            : null;
        if (createdAt === null) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}


function hasProjectedPendingRequests(facts: PendingRequestFacts): boolean {
    return (facts.projected?.permissionCount ?? 0) > 0
        || (facts.projected?.userActionCount ?? 0) > 0;
}

export function shouldReadTranscriptForPendingRequests(facts: PendingRequestFacts): boolean {
    if (facts.active !== true) {
        return false;
    }

    if (hasProjectedPendingRequestCounts(facts)) {
        return hasProjectedPendingRequests(facts);
    }

    if (hasPendingAgentRequests(facts)) {
        return true;
    }

    return true;
}

/** Whether request details need the app's stored transcript when none was supplied. */
export function shouldReadTranscriptForPendingRequestList(facts: PendingRequestFacts): boolean {
    return facts.active && (
        shouldReadTranscriptForPendingRequests(facts)
        || hasPendingAgentUserActionRequests(facts)
    );
}

export function listPendingRequests(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): SessionPendingRequest[] {
    const sharedActionState = facts.actionConfirmations;
    const pendingAgentStateRequests = [
        ...listPendingAgentStateRequests(facts.agentState),
        ...listPendingAgentStateRequests(sharedActionState),
    ];

    if (facts.active !== true) {
        return pendingAgentStateRequests.filter((request) => request.kind === 'user_action');
    }

    // A pre-filled states cache stands in for the transcript, so the
    // storage-read short-circuit must not fire when one is provided.
    if (
        !messages
        && !statesCache?.states
        && !shouldReadTranscriptForPendingRequestList(facts)
    ) {
        return [];
    }

    const transcriptStates = getTranscriptRequestStates(facts, messages, statesCache);
    const pending = new Map<string, SessionPendingRequest>();
    const pendingTranscriptRequests = Array.from(transcriptStates.values())
        .flatMap((state) => (state.status === 'pending' ? [state.request] : []));

    for (const request of pendingTranscriptRequests) {
        pending.set(request.id, request);
    }

    if (pendingAgentStateRequests.length > 0) {
        for (const request of pendingAgentStateRequests) {
            const transcriptState = transcriptStates.get(request.id);
            if (
                transcriptState?.status === 'terminal'
                && transcriptState.terminalKind === 'hard'
                && (request.createdAt ?? 0) <= transcriptState.createdAt
            ) {
                continue;
            }

            const transcriptMatch = pendingTranscriptRequests.find((transcriptRequest) =>
                arePendingRequestsEquivalent(transcriptRequest, request)
            );
            if (transcriptMatch) {
                pending.set(
                    transcriptMatch.id,
                    mergePendingRequestMetadata(
                        pending.get(transcriptMatch.id) ?? transcriptMatch,
                        request,
                    ),
                );
                continue;
            }

            pending.set(request.id, request);
        }
    }

    return Array.from(pending.values());
}

export function listPendingPermissionRequests(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return listPendingRequests(facts, messages).filter((request) =>
        resolveAgentRequestKind({ toolName: request.tool, requestKind: request.kind }) !== 'user_action'
    );
}

export function listPendingUserActionRequests(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return listPendingRequests(facts, messages).filter((request) => request.kind === 'user_action');
}

function latestPendingRequestCreatedAt(requests: readonly SessionPendingRequest[]): number | null {
    let latest: number | null = null;
    for (const request of requests) {
        const createdAt = request.createdAt;
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) continue;
        latest = latest === null ? Math.trunc(createdAt) : Math.max(latest, Math.trunc(createdAt));
    }
    return latest;
}

export function deriveLatestPendingRequestObservedAt(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): number | null {
    if (facts.active !== true) {
        return latestPendingRequestCreatedAt(
            listPendingAgentStateRequests(facts.agentState).filter((request) => request.kind === 'user_action'),
        );
    }

    if (hasProjectedPendingRequestCounts(facts)) {
        const pendingFlags = derivePendingRequestFlags(facts, messages, statesCache);
        if (!pendingFlags.hasPendingPermissionRequests && !pendingFlags.hasPendingUserActionRequests) {
            return null;
        }
        if (hasProjectedPendingRequests(facts)) {
            const projectedObservedAt = readProjectedPendingRequestObservedAt(facts);
            if (projectedObservedAt !== null) {
                return projectedObservedAt;
            }
        }
    }

    return latestPendingRequestCreatedAt(listPendingRequests(facts, messages, statesCache));
}

export function listPendingRequestLists(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequestLists {
    const requests = listPendingRequests(facts, messages);
    if (requests.length === 0) {
        return {
            permissionRequests: [],
            userActionRequests: [],
        };
    }

    return {
        permissionRequests: requests.filter((request) =>
            resolveAgentRequestKind({ toolName: request.tool, requestKind: request.kind }) !== 'user_action'
        ),
        userActionRequests: requests.filter((request) => request.kind === 'user_action'),
    };
}

export function derivePendingRequestFlags(
    facts: PendingRequestFacts,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): PendingRequestFlags {
    if (facts.active !== true) {
        const agentStateFlags = derivePendingRequestFlagsFromAgentState(facts.agentState);
        return {
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: agentStateFlags.hasPendingUserActionRequests,
        };
    }

    const actionFlags = derivePendingRequestFlagsFromAgentState(
        facts.actionConfirmations,
    );

    if (hasProjectedPendingRequestCounts(facts)) {
        const transcriptStates = getTranscriptRequestStates(facts, messages, statesCache);
        if (shouldUseProjectedPendingRequestCounts(facts, transcriptStates)) {
            const projectedFlags = readProjectedPendingRequestFlags(facts);
            const agentStateFlags = derivePendingRequestFlagsFromAgentState(facts.agentState);
            return {
                hasPendingPermissionRequests:
                    projectedFlags.hasPendingPermissionRequests
                    || listPendingAgentStateRequests(facts.agentState).some(isSessionActionConfirmationRequest)
                    || actionFlags.hasPendingPermissionRequests,
                hasPendingUserActionRequests:
                    projectedFlags.hasPendingUserActionRequests
                    || agentStateFlags.hasPendingUserActionRequests
                    || actionFlags.hasPendingUserActionRequests,
            };
        }
        const pendingTranscriptRequests = Array.from(transcriptStates.values())
            .flatMap((state) => (state.status === 'pending' ? [state.request] : []));
        if (pendingTranscriptRequests.length === 0) {
            return actionFlags;
        }
        return {
            hasPendingPermissionRequests:
                pendingTranscriptRequests.some((request) => resolvePendingRequestAttentionReasonV1(request) === 'permission_required')
                || actionFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests:
                pendingTranscriptRequests.some((request) => resolvePendingRequestAttentionReasonV1(request) === 'user_action_required')
                || actionFlags.hasPendingUserActionRequests,
        };
    }

    const transcriptStates = getTranscriptRequestStates(facts, messages, statesCache);
    if (shouldUseProjectedPendingRequestCounts(facts, transcriptStates)) {
        const projectedFlags = readProjectedPendingRequestFlags(facts);
        return {
            hasPendingPermissionRequests:
                projectedFlags.hasPendingPermissionRequests || actionFlags.hasPendingPermissionRequests,
            hasPendingUserActionRequests:
                projectedFlags.hasPendingUserActionRequests || actionFlags.hasPendingUserActionRequests,
        };
    }

    const requests = listPendingRequests(facts, messages, statesCache);
    if (requests.length === 0) {
        return EMPTY_PENDING_REQUEST_FLAGS;
    }

    return {
        hasPendingPermissionRequests: requests.some((request) => resolvePendingRequestAttentionReasonV1(request) === 'permission_required'),
        hasPendingUserActionRequests: requests.some((request) => resolvePendingRequestAttentionReasonV1(request) === 'user_action_required'),
    };
}
