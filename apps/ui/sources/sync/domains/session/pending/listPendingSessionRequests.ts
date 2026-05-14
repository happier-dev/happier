import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { AgentState, Session } from '@/sync/domains/state/storageTypes';
import { isRequestInterruptedPlaceholder } from './requestInterruptedPlaceholder';
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

type AgentRequestRecord = NonNullable<AgentState['requests']>;

type TranscriptRequestState =
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

function getRequestCompletedAt(completed: unknown): number {
    const completedAt = typeof (completed as { completedAt?: unknown })?.completedAt === 'number'
        ? (completed as { completedAt: number }).completedAt
        : 0;
    const createdAt = typeof (completed as { createdAt?: unknown })?.createdAt === 'number'
        ? (completed as { createdAt: number }).createdAt
        : 0;
    return Math.max(completedAt, createdAt);
}

function isPendingRequestCoveredByCompleted(
    completedRequests: Record<string, unknown> | null | undefined,
    requestId: string,
    createdAt: number | null,
): boolean {
    if (!completedRequests || typeof completedRequests !== 'object') return false;
    const completed = completedRequests[requestId];
    if (!completed) return false;
    return (createdAt ?? 0) <= getRequestCompletedAt(completed);
}

function updateTranscriptRequestState(
    states: Map<string, TranscriptRequestState>,
    requestId: string,
    nextState: TranscriptRequestState,
): void {
    const previousState = states.get(requestId);
    if (!previousState) {
        states.set(requestId, nextState);
        return;
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
            states.set(requestId, nextState);
        }
        return;
    }

    if (previousState.status === 'terminal') {
        if (nextState.createdAt > previousState.createdAt) {
            states.set(requestId, nextState);
        }
        return;
    }

    if (nextState.createdAt >= previousState.createdAt) {
        states.set(requestId, nextState);
    }
}

function collectTranscriptRequestStates(
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
                && !isPendingRequestCoveredByCompleted(completedRequests, requestId, createdAt)
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
): Map<string, TranscriptRequestState> {
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
        (session.agentState?.completedRequests as Record<string, unknown> | null | undefined) ?? null,
        states,
    );
    return states;
}

export function listPendingTranscriptRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    return Array.from(getTranscriptRequestStates(session, messages).values())
        .flatMap((state) => (state.status === 'pending' ? [state.request] : []));
}

function listPendingRequestEntries(agentState: AgentState | null | undefined): Array<{ kind: string }> {
    const requests = agentState?.requests;
    if (!requests) return [];
    const completed = agentState?.completedRequests ?? null;

    return Object.entries(requests as AgentRequestRecord).flatMap(([id, request]) => {
        if (!request || typeof request !== 'object') return [];
        const completedEntry = completed?.[id];
        if (completedEntry && completedEntry.completedAt != null) return [];
        return [{
            kind: resolveAgentRequestKind({
                toolName: typeof request.tool === 'string' ? request.tool : '',
                requestKind: request.kind,
            }),
        }];
    });
}

export function derivePendingRequestFlagsFromAgentState(agentState: AgentState | null | undefined): PendingRequestFlags {
    const requests = listPendingRequestEntries(agentState);
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

    const hasPendingAgentRequests = Object.keys(session.agentState?.requests ?? {}).length > 0;
    if (hasPendingAgentRequests) {
        return false;
    }

    let hasPendingTranscriptRequests = false;
    let newestTerminalTranscriptCreatedAt = 0;
    for (const state of transcriptStates.values()) {
        if (state.status === 'pending') {
            hasPendingTranscriptRequests = true;
            break;
        }
        newestTerminalTranscriptCreatedAt = Math.max(newestTerminalTranscriptCreatedAt, state.createdAt);
    }
    if (hasPendingTranscriptRequests) {
        return false;
    }

    if (newestTerminalTranscriptCreatedAt === 0) {
        return true;
    }

    return session.updatedAt > newestTerminalTranscriptCreatedAt;
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasPendingAgentRequests(session: Session): boolean {
    return Object.keys(session.agentState?.requests ?? {}).length > 0;
}

function readProjectedPendingRequestFlags(session: Session): PendingRequestFlags {
    return {
        hasPendingPermissionRequests: (session.pendingPermissionRequestCount ?? 0) > 0,
        hasPendingUserActionRequests: (session.pendingUserActionRequestCount ?? 0) > 0,
    };
}

export function listPendingSessionRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionPendingRequest[] {
    if (session.active !== true) {
        return [];
    }

    const transcriptStates = getTranscriptRequestStates(session, messages);
    const pending = new Map<string, SessionPendingRequest>();
    const pendingTranscriptRequests = Array.from(transcriptStates.values())
        .flatMap((state) => (state.status === 'pending' ? [state.request] : []));

    for (const request of pendingTranscriptRequests) {
        pending.set(request.id, request);
    }

    const requests = session.agentState?.requests;
    const completed = session.agentState?.completedRequests ?? null;
    if (requests && Object.keys(requests).length > 0) {
        for (const [requestId, req] of Object.entries(requests)) {
            const createdAt = typeof req?.createdAt === 'number' ? req.createdAt : null;
            if (isPendingRequestCoveredByCompleted(completed, requestId, createdAt)) continue;

            const transcriptState = transcriptStates.get(requestId);
            if (
                transcriptState?.status === 'terminal'
                && transcriptState.terminalKind === 'hard'
                && (createdAt ?? 0) <= transcriptState.createdAt
            ) {
                continue;
            }

            const request: SessionPendingRequest = {
                id: requestId,
                tool: req.tool,
                kind: resolveAgentRequestKind({ toolName: req.tool, requestKind: req.kind }),
                arguments: req.arguments,
                createdAt,
                ...(getRequestPermissionSuggestions(req) ? { permissionSuggestions: getRequestPermissionSuggestions(req) } : {}),
            };

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

            pending.set(requestId, request);
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

export function derivePendingRequestFlagsFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
): PendingRequestFlags {
    if (session.active !== true) {
        return EMPTY_PENDING_REQUEST_FLAGS;
    }

    if (hasProjectedPendingRequestCounts(session) && !hasPendingAgentRequests(session)) {
        return readProjectedPendingRequestFlags(session);
    }

    const transcriptStates = getTranscriptRequestStates(session, messages);
    if (shouldUseProjectedPendingRequestCounts(session, transcriptStates)) {
        return readProjectedPendingRequestFlags(session);
    }

    const requests = listPendingSessionRequests(session, messages);
    if (requests.length === 0) {
        return EMPTY_PENDING_REQUEST_FLAGS;
    }

    return {
        hasPendingPermissionRequests: requests.some((request) => request.kind !== 'user_action'),
        hasPendingUserActionRequests: requests.some((request) => request.kind === 'user_action'),
    };
}
