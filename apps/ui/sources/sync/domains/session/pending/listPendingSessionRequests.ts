import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { AgentState, Session } from '@/sync/domains/state/storageTypes';
import { buildStableJsonSignature } from '@/sync/domains/session/metadata/sessionMetadataStability';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import { isRequestInterruptedPlaceholder } from './requestInterruptedPlaceholder';
import {
    isAgentStateRequestCoveredByCompletedRequests,
    resolveAgentStateRequestCoverageOptions,
} from '@happier-dev/agents';
import { SessionPublicCompletedRequestV1Schema } from '@happier-dev/protocol';
import {
    resolveAgentRequestKind,
    shouldShowGenericPermissionPromptForRequest,
    type AgentRequestKind,
} from '@/utils/sessions/permissions/permissionPromptPolicy';

export type SessionPendingRequest = Readonly<{
    id: string;
    tool: string;
    kind: AgentRequestKind;
    arguments: unknown;
    createdAt: number | null;
    permissionSuggestions?: unknown;
}>;

type PendingRequestFlags = Readonly<{
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
}>;

export type SessionPendingRequestLists = Readonly<{
    permissionRequests: readonly SessionPendingRequest[];
    userActionRequests: readonly SessionPendingRequest[];
}>;

type AgentRequestRecord = NonNullable<AgentState['requests']>;

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
 * (e.g. one session-list renderable build) so the transcript is walked at most
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
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): Map<string, TranscriptRequestState> {
    if (statesCache?.states) {
        return statesCache.states;
    }
    const transcriptMessages = (() => {
        if (messages) {
            return messages;
        }
        const storageState = readRegisteredStorageState();
        return storageState ? (readStoredSessionMessages(storageState, session.id) ?? []) : [];
    })();
    const states = new Map<string, TranscriptRequestState>();
    collectTranscriptRequestStates(
        transcriptMessages,
        readSessionPresentationCompletedRequests(session),
        states,
    );
    if (statesCache) {
        statesCache.states = states;
    }
    return states;
}

export function listPendingTranscriptRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return Array.from(getTranscriptRequestStates(session, messages).values())
        .flatMap((state) => (state.status === 'pending' ? [state.request] : []));
}

function listPendingAgentStateRequests(agentState: AgentState | null | undefined): SessionPendingRequest[] {
    const requests = agentState?.requests;
    if (!requests) return [];
    const completed = agentState?.completedRequests ?? null;

    return Object.entries(requests as AgentRequestRecord).flatMap(([id, request]) => {
        if (!request || typeof request !== 'object') return [];
        const toolName = typeof request.tool === 'string' ? request.tool.trim() : '';
        if (!toolName) return [];
        const createdAt = typeof request.createdAt === 'number' ? request.createdAt : null;
        if (isPendingRequestCoveredByCompleted(completed as Record<string, unknown> | null | undefined, id, createdAt, request)) return [];
        return [{
            id,
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

export function derivePendingRequestFlagsFromAgentState(agentState: AgentState | null | undefined): PendingRequestFlags {
    const requests = listPendingAgentStateRequests(agentState);
    if (requests.length === 0) {
        return EMPTY_PENDING_REQUEST_FLAGS;
    }
    return {
        hasPendingPermissionRequests: requests.some((request) => request.kind !== 'user_action'),
        hasPendingUserActionRequests: requests.some((request) => request.kind === 'user_action'),
    };
}

function shouldUseProjectedPendingRequestCounts(session: Session, transcriptStates: Map<string, TranscriptRequestState>): boolean {
    if (
        typeof session.pendingPermissionRequestCount !== 'number'
        && typeof session.pendingUserActionRequestCount !== 'number'
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

    const projectedObservedAt = readProjectedPendingRequestObservedAt(session);
    const projectedReferenceAt = projectedObservedAt
        ?? (Number.isFinite(session.updatedAt) ? Math.trunc(session.updatedAt) : null);
    return projectedReferenceAt !== null
        && projectedReferenceAt > newestTerminalTranscriptCreatedAt;
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasPendingAgentRequests(session: Session): boolean {
    return listPendingAgentStateRequests(session.agentState).length > 0;
}

function hasPendingAgentUserActionRequests(session: Session): boolean {
    return derivePendingRequestFlagsFromAgentState(session.agentState).hasPendingUserActionRequests;
}

function readProjectedPendingRequestFlags(session: Session): PendingRequestFlags {
    return {
        hasPendingPermissionRequests: (session.pendingPermissionRequestCount ?? 0) > 0,
        hasPendingUserActionRequests: (session.pendingUserActionRequestCount ?? 0) > 0,
    };
}

function readProjectedPendingRequestObservedAt(session: Session): number | null {
    const value = session.pendingRequestObservedAt;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : null;
}

function buildProjectedPendingRequestCountSignature(value: unknown): string | number {
    if (typeof value !== 'number') return 'absent';
    return Number.isFinite(value) ? Math.trunc(value) : 'nonfinite';
}

export function readPendingAgentStateRequestSignature(agentState: AgentState | null | undefined): string {
    return buildStableJsonSignature(agentState?.requests ?? null);
}

export function readPendingAgentStateCompletedRequestSignature(agentState: AgentState | null | undefined): string {
    return buildStableJsonSignature(agentState?.completedRequests ?? null);
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

export function buildPendingSessionRequestsSourceSignature(session: Session): string {
    return buildStableJsonSignature({
        active: session.active === true,
        presentationCompletedRequests: readSessionPresentationCompletedRequests(session),
        agentStateRequests: session.agentState?.requests ?? null,
        pendingPermissionRequestCount: buildProjectedPendingRequestCountSignature(session.pendingPermissionRequestCount),
        pendingRequestObservedAt: readProjectedPendingRequestObservedAt(session),
        pendingUserActionRequestCount: buildProjectedPendingRequestCountSignature(session.pendingUserActionRequestCount),
        sessionId: session.id,
    });
}

function hasProjectedPendingRequests(session: Session): boolean {
    return (session.pendingPermissionRequestCount ?? 0) > 0
        || (session.pendingUserActionRequestCount ?? 0) > 0;
}

export function shouldReadTranscriptForPendingSessionRequests(session: Session): boolean {
    if (session.active !== true) {
        return false;
    }

    if (hasProjectedPendingRequestCounts(session)) {
        return hasProjectedPendingRequests(session);
    }

    if (hasPendingAgentRequests(session)) {
        return true;
    }

    return true;
}

export function listPendingSessionRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): SessionPendingRequest[] {
    const pendingAgentStateRequests = listPendingAgentStateRequests(session.agentState);

    if (session.active !== true) {
        return pendingAgentStateRequests.filter((request) => request.kind === 'user_action');
    }

    // A pre-filled states cache stands in for the transcript, so the
    // storage-read short-circuit must not fire when one is provided.
    if (
        !messages
        && !statesCache?.states
        && !shouldReadTranscriptForPendingSessionRequests(session)
        && !hasPendingAgentUserActionRequests(session)
    ) {
        return [];
    }

    const transcriptStates = getTranscriptRequestStates(session, messages, statesCache);
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

export function listPendingPermissionRequestsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return listPendingSessionRequests(session, messages).filter((request) =>
        shouldShowGenericPermissionPromptForRequest({ toolName: request.tool, requestKind: request.kind })
    );
}

export function listPendingUserActionRequestsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return listPendingSessionRequests(session, messages).filter((request) => request.kind === 'user_action');
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

export function deriveLatestPendingRequestObservedAtFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): number | null {
    if (session.active !== true) {
        return latestPendingRequestCreatedAt(
            listPendingAgentStateRequests(session.agentState).filter((request) => request.kind === 'user_action'),
        );
    }

    if (hasProjectedPendingRequestCounts(session)) {
        const pendingFlags = derivePendingRequestFlagsFromSession(session, messages, statesCache);
        if (!pendingFlags.hasPendingPermissionRequests && !pendingFlags.hasPendingUserActionRequests) {
            return null;
        }
        if (hasProjectedPendingRequests(session)) {
            const projectedObservedAt = readProjectedPendingRequestObservedAt(session);
            if (projectedObservedAt !== null) {
                return projectedObservedAt;
            }
        }
    }

    return latestPendingRequestCreatedAt(listPendingSessionRequests(session, messages, statesCache));
}

export function listPendingRequestListsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequestLists {
    const requests = listPendingSessionRequests(session, messages);
    if (requests.length === 0) {
        return {
            permissionRequests: [],
            userActionRequests: [],
        };
    }

    return {
        permissionRequests: requests.filter((request) =>
            shouldShowGenericPermissionPromptForRequest({ toolName: request.tool, requestKind: request.kind })
        ),
        userActionRequests: requests.filter((request) => request.kind === 'user_action'),
    };
}

export function derivePendingRequestFlagsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    statesCache?: TranscriptRequestStatesCache,
): PendingRequestFlags {
    if (session.active !== true) {
        const agentStateFlags = derivePendingRequestFlagsFromAgentState(session.agentState);
        return {
            hasPendingPermissionRequests: false,
            hasPendingUserActionRequests: agentStateFlags.hasPendingUserActionRequests,
        };
    }

    if (hasProjectedPendingRequestCounts(session)) {
        const transcriptStates = getTranscriptRequestStates(session, messages, statesCache);
        if (shouldUseProjectedPendingRequestCounts(session, transcriptStates)) {
            const projectedFlags = readProjectedPendingRequestFlags(session);
            const agentStateFlags = derivePendingRequestFlagsFromAgentState(session.agentState);
            return {
                hasPendingPermissionRequests: projectedFlags.hasPendingPermissionRequests,
                hasPendingUserActionRequests:
                    projectedFlags.hasPendingUserActionRequests || agentStateFlags.hasPendingUserActionRequests,
            };
        }
        const pendingTranscriptRequests = Array.from(transcriptStates.values())
            .flatMap((state) => (state.status === 'pending' ? [state.request] : []));
        if (pendingTranscriptRequests.length === 0) {
            return EMPTY_PENDING_REQUEST_FLAGS;
        }
        return {
            hasPendingPermissionRequests: pendingTranscriptRequests.some((request) => request.kind !== 'user_action'),
            hasPendingUserActionRequests: pendingTranscriptRequests.some((request) => request.kind === 'user_action'),
        };
    }

    const transcriptStates = getTranscriptRequestStates(session, messages, statesCache);
    if (shouldUseProjectedPendingRequestCounts(session, transcriptStates)) {
        return readProjectedPendingRequestFlags(session);
    }

    const requests = listPendingSessionRequests(session, messages, statesCache);
    if (requests.length === 0) {
        return EMPTY_PENDING_REQUEST_FLAGS;
    }

    return {
        hasPendingPermissionRequests: requests.some((request) => request.kind !== 'user_action'),
        hasPendingUserActionRequests: requests.some((request) => request.kind === 'user_action'),
    };
}
