import * as React from 'react';
import { Message } from '@/sync/domains/messages/messageTypes';
import { readStoredSessionMessages } from '@/sync/domains/messages/readStoredSessionMessages';
import { storage } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    readDisplayMachineIdForSession,
    readDisplayPathForSession,
    readMachineTargetForSession,
} from '@/sync/ops/sessionMachineTarget';
import { t } from '@/text';
import { resolveAgentRequestKind, shouldShowGenericPermissionPromptForRequest, type AgentRequestKind } from '@/utils/sessions/permissions/permissionPromptPolicy';
import { formatPathRelativeToHome } from './formatPathRelativeToHome';
export { formatPathRelativeToHome } from './formatPathRelativeToHome';

export type SessionState = 'disconnected' | 'thinking' | 'waiting' | 'permission_required' | 'action_required';

export interface SessionStatus {
    state: SessionState;
    isConnected: boolean;
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}

export const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = 15_000;

export type PendingPermissionRequest = Readonly<{
    id: string;
    tool: string;
    kind: AgentRequestKind;
    arguments: unknown;
    createdAt: number | null;
    permissionSuggestions?: unknown;
}>;

type SessionStatusSource = Session | SessionListRenderableSession;

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

function arePendingRequestsEquivalent(left: PendingPermissionRequest, right: PendingPermissionRequest): boolean {
    if (left.kind !== right.kind || left.tool !== right.tool) return false;

    const leftArgs = stringifyPendingRequestArguments(left.arguments);
    const rightArgs = stringifyPendingRequestArguments(right.arguments);
    if (leftArgs && rightArgs && leftArgs === rightArgs) {
        return true;
    }

    return left.createdAt !== null && right.createdAt !== null && left.createdAt === right.createdAt;
}

function mergePendingRequestMetadata(
    preferred: PendingPermissionRequest,
    secondary: PendingPermissionRequest,
): PendingPermissionRequest {
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

function visitPendingTranscriptRequests(
    messages: ReadonlyArray<Message> | null | undefined,
    completedRequests: Record<string, unknown> | null | undefined,
    out: Map<string, PendingPermissionRequest>,
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
        const createdAt = typeof message.createdAt === 'number' ? message.createdAt : null;

        if (
            permission?.status === 'pending' &&
            requestId &&
            toolName &&
            !out.has(requestId) &&
            !isPendingRequestCoveredByCompleted(completedRequests, requestId, createdAt)
        ) {
            out.set(requestId, {
                id: requestId,
                tool: toolName,
                kind: resolveAgentRequestKind({ toolName, requestKind: permission.kind }),
                arguments: message.tool?.input,
                createdAt,
                ...(Array.isArray(permission.suggestions) && permission.suggestions.length > 0
                    ? { permissionSuggestions: permission.suggestions }
                    : {}),
            });
        }

        visitPendingTranscriptRequests(message.children ?? [], completedRequests, out);
    }
}

export function listPendingTranscriptRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
): PendingPermissionRequest[] {
    const transcriptMessages =
        messages ??
        readStoredSessionMessages(storage.getState(), session.id) ??
        [];
    const out = new Map<string, PendingPermissionRequest>();
    visitPendingTranscriptRequests(
        transcriptMessages,
        (session.agentState?.completedRequests as Record<string, unknown> | null | undefined) ?? null,
        out,
    );
    return Array.from(out.values());
}

function listPendingAgentRequests(session: Session, messages?: ReadonlyArray<Message>): PendingPermissionRequest[] {
    const requests = session.agentState?.requests;
    const completed = session.agentState?.completedRequests ?? null;
    const pending = new Map<string, PendingPermissionRequest>();
    const transcriptRequests = listPendingTranscriptRequests(session, messages);

    for (const request of transcriptRequests) {
        pending.set(request.id, request);
    }

    if (requests && Object.keys(requests).length > 0) {
        for (const [permId, req] of Object.entries(requests)) {
            const createdAt = typeof req?.createdAt === 'number' ? req.createdAt : null;
            if (isPendingRequestCoveredByCompleted(completed, permId, createdAt)) continue;
            const request: PendingPermissionRequest = {
                id: permId,
                tool: req.tool,
                kind: resolveAgentRequestKind({ toolName: req.tool, requestKind: req.kind }),
                arguments: req.arguments,
                createdAt,
                ...(getRequestPermissionSuggestions(req) ? { permissionSuggestions: getRequestPermissionSuggestions(req) } : {}),
            };

            const transcriptMatch = transcriptRequests.find((transcriptRequest) =>
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

            pending.set(permId, request);
        }
    }

    return Array.from(pending.values());
}

export function listPendingPermissionRequests(session: Session, messages?: ReadonlyArray<Message>): PendingPermissionRequest[] {
    return listPendingAgentRequests(session, messages).filter((r) =>
        shouldShowGenericPermissionPromptForRequest({ toolName: r.tool, requestKind: r.kind })
    );
}

export function listPendingUserActionRequests(session: Session, messages?: ReadonlyArray<Message>): PendingPermissionRequest[] {
    return listPendingAgentRequests(session, messages).filter((r) => r.kind === 'user_action');
}

function hasPendingPermissionRequests(session: SessionStatusSource): boolean {
    if (typeof (session as SessionListRenderableSession).hasPendingPermissionRequests === 'boolean') {
        return (session as SessionListRenderableSession).hasPendingPermissionRequests === true;
    }
    return listPendingPermissionRequests(session as Session).length > 0;
}

function hasPendingUserActionRequests(session: SessionStatusSource): boolean {
    if (typeof (session as SessionListRenderableSession).hasPendingUserActionRequests === 'boolean') {
        return (session as SessionListRenderableSession).hasPendingUserActionRequests === true;
    }
    return listPendingUserActionRequests(session as Session).length > 0;
}

export function shouldShowAbortButtonForSessionState(state: SessionState): boolean {
    // Abort should only be available when there's an in-flight operation or a permission gate.
    // Idle online sessions are represented as `waiting` today.
    return state === 'thinking' || state === 'permission_required' || state === 'action_required';
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
export function getSessionStatus(session: SessionStatusSource, nowMs: number = Date.now(), vibingIndex?: number): SessionStatus {
    const isOnline = session.presence === "online";
    const hasPermissions = hasPendingPermissionRequests(session);
    const hasUserActions = hasPendingUserActionRequests(session);

    const optimisticThinkingAt = session.optimisticThinkingAt ?? null;
    const isOptimisticThinking = typeof optimisticThinkingAt === 'number' && nowMs - optimisticThinkingAt < OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS;
    const thinkingGraceUntil = session.thinkingGraceUntil ?? null;
    const isThinkingGraceActive = typeof thinkingGraceUntil === 'number' && nowMs < thinkingGraceUntil;
    const isThinking = session.thinking === true || isOptimisticThinking || isThinkingGraceActive;

    const vibingMessage = (() => {
        const idx = typeof vibingIndex === 'number'
            ? vibingIndex
            : Math.floor(Math.random() * vibingMessages.length);
        return vibingMessages[idx % vibingMessages.length].toLowerCase() + '…';
    })();

    if (!isOnline) {
        return {
            state: 'disconnected',
            isConnected: false,
            statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
            shouldShowStatus: true,
            statusColor: '#999',
            statusDotColor: '#999'
        };
    }

    // Check if user action is required (structured prompt), then permissions.
    if (hasUserActions) {
        return {
            state: 'action_required',
            isConnected: true,
            statusText: t('status.actionRequired'),
            shouldShowStatus: true,
            statusColor: '#FF9500',
            statusDotColor: '#FF9500',
            isPulsing: true
        };
    }

    if (hasPermissions) {
        return {
            state: 'permission_required',
            isConnected: true,
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            statusColor: '#FF9500',
            statusDotColor: '#FF9500',
            isPulsing: true
        };
    }

    if (isThinking) {
        return {
            state: 'thinking',
            isConnected: true,
            statusText: vibingMessage,
            shouldShowStatus: true,
            statusColor: '#007AFF',
            statusDotColor: '#007AFF',
            isPulsing: true
        };
    }

    return {
        state: 'waiting',
        isConnected: true,
        statusText: t('status.online'),
        shouldShowStatus: false,
        statusColor: '#34C759',
        statusDotColor: '#34C759'
    };
}

/**
 * Hook wrapper around `getSessionStatus` that keeps vibing text stable while the session is thinking.
 */
export function useSessionStatus(session: SessionStatusSource): SessionStatus {
    const isOnline = session.presence === "online";
    const hasPermissions = hasPendingPermissionRequests(session);
    const hasUserActions = hasPendingUserActionRequests(session);

    const now = Date.now();
    const optimisticThinkingAt = session.optimisticThinkingAt ?? null;
    const isOptimisticThinking = typeof optimisticThinkingAt === 'number' && now - optimisticThinkingAt < OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS;
    const thinkingGraceUntil = session.thinkingGraceUntil ?? null;
    const isThinkingGraceActive = typeof thinkingGraceUntil === 'number' && now < thinkingGraceUntil;
    const isThinking = session.thinking === true || isOptimisticThinking || isThinkingGraceActive;

    const vibingIndex = React.useMemo(() => {
        return Math.floor(Math.random() * vibingMessages.length);
    }, [isOnline, hasPermissions, hasUserActions, isThinking]);

    return getSessionStatus(session, now, vibingIndex);
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: SessionStatusSource): string {
    const summaryText = (session.metadata as any)?.summary?.text ?? (session.metadata as any)?.summaryText;
    if (typeof summaryText === 'string' && summaryText.trim()) {
        return summaryText;
    } else if (session.metadata?.name) {
        const name = session.metadata.name.trim();
        if (name.length > 0) return name;
    } else if (session.metadata) {
        const displayPath = readDisplayPathForSession({
            sessionId: session.id,
            metadata: session.metadata ?? null,
        });
        const segments = displayPath.split('/').filter(Boolean);
        const lastSegment = segments.pop();
        if (!lastSegment) {
            return t('status.unknown');
        }
        return lastSegment;
    }
    return t('status.unknown');
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: SessionStatusSource): string {
    const reachableMachineId = readDisplayMachineIdForSession({
        sessionId: session.id,
        metadata: session.metadata ?? null,
    });
    const reachablePath = readMachineTargetForSession(session.id)?.basePath ?? session.metadata?.path ?? null;

    if (reachableMachineId && reachablePath) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${reachableMachineId}:${reachablePath}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/**
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: SessionStatusSource): string {
    const reachableTarget = readMachineTargetForSession(session.id);
    const path = reachableTarget?.basePath ?? session.metadata?.path ?? null;
    if (path) {
        return formatPathRelativeToHome(path, session.metadata?.homeDir ?? undefined);
    }
    return t('status.unknown');
}

/**
 * Checks if a session is currently online based on the active flag.
 * A session is considered online if the active flag is true.
 */
export function isSessionOnline(session: Session): boolean {
    return session.active;
}

/**
 * Checks if a session should be shown in the active sessions group.
 * Uses the active flag directly.
 */
export function isSessionActive(session: Session): boolean {
    return session.active;
}

/**
 * Formats OS platform string into a more readable format
 */
export function formatOSPlatform(platform?: string): string {
    if (!platform) return '';

    const osMap: Record<string, string> = {
        'darwin': 'macOS',
        'win32': 'Windows',
        'linux': 'Linux',
        'android': 'Android',
        'ios': 'iOS',
        'aix': 'AIX',
        'freebsd': 'FreeBSD',
        'openbsd': 'OpenBSD',
        'sunos': 'SunOS'
    };

    return osMap[platform.toLowerCase()] || platform;
}

/**
 * Formats the last seen time of a session into a human-readable relative time.
 * @param activeAt - Timestamp when the session was last active
 * @param isActive - Whether the session is currently active
 * @returns Formatted string like "Active now", "5 minutes ago", "2 hours ago", or a date
 */
export function formatLastSeen(activeAt: number, isActive: boolean = false): string {
    if (isActive) {
        return t('status.activeNow');
    }

    const now = Date.now();
    const diffMs = now - activeAt;
    const diffSeconds = Math.floor(diffMs / 1000);
    const diffMinutes = Math.floor(diffSeconds / 60);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSeconds < 60) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else if (diffDays < 7) {
        return t('sessionHistory.daysAgo', { count: diffDays });
    } else {
        // Format as date
        const date = new Date(activeAt);
        const options: Intl.DateTimeFormatOptions = {
            month: 'short',
            day: 'numeric',
            year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
        };
        return date.toLocaleDateString(undefined, options);
    }
}

const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];
