import * as React from 'react';
import { Message } from '@/sync/domains/messages/messageTypes';
import { useSession, useSessionMessagesVersion } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    derivePendingRequestFlagsFromSession,
    listPendingPermissionRequestsFromSession,
    listPendingTranscriptRequests as listPendingTranscriptRequestsFromSession,
    listPendingUserActionRequestsFromSession,
    type SessionPendingRequest,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    readDisplayMachineIdForSession,
    readDisplayPathForSession,
} from '@/sync/ops/sessionMachineTarget';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { t } from '@/text';
import { formatPathRelativeToHome } from './formatPathRelativeToHome';
import { useUnistyles } from 'react-native-unistyles';
export { formatPathRelativeToHome } from './formatPathRelativeToHome';

export type SessionState = 'disconnected' | 'resuming' | 'thinking' | 'waiting' | 'permission_required' | 'action_required';

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

export type PendingPermissionRequest = SessionPendingRequest;

type SessionStatusSource = Session | SessionListRenderableSession;
type SessionStatusColors = Readonly<{
    connected: string;
    connecting: string;
    actionRequired: string;
    disconnected: string;
    error: string;
    default: string;
}>;
type UseSessionStatusOptions = Readonly<{
    subscribeToSession?: boolean;
    subscribeToTranscript?: boolean;
}>;

const DEFAULT_SESSION_STATUS_COLORS: SessionStatusColors = {
    connected: '#34C759',
    connecting: '#007AFF',
    actionRequired: '#FF9500',
    disconnected: '#999999',
    error: '#FF3B30',
    default: '#8E8E93',
};

export function listPendingTranscriptRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
): PendingPermissionRequest[] {
    return listPendingTranscriptRequestsFromSession(session, messages);
}

export function listPendingPermissionRequests(session: Session, messages?: ReadonlyArray<Message>): PendingPermissionRequest[] {
    return listPendingPermissionRequestsFromSession(session, messages);
}

export function listPendingUserActionRequests(session: Session, messages?: ReadonlyArray<Message>): PendingPermissionRequest[] {
    return listPendingUserActionRequestsFromSession(session, messages);
}

function hasPendingPermissionRequests(session: SessionStatusSource): boolean {
    if (typeof (session as SessionListRenderableSession).hasPendingPermissionRequests === 'boolean') {
        return (session as SessionListRenderableSession).hasPendingPermissionRequests === true;
    }
    return derivePendingRequestFlagsFromSession(session as Session).hasPendingPermissionRequests;
}

function hasPendingUserActionRequests(session: SessionStatusSource): boolean {
    if (typeof (session as SessionListRenderableSession).hasPendingUserActionRequests === 'boolean') {
        return (session as SessionListRenderableSession).hasPendingUserActionRequests === true;
    }
    return derivePendingRequestFlagsFromSession(session as Session).hasPendingUserActionRequests;
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
    const isSessionActive = session.active === true;
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

    if (!isSessionActive && isOptimisticThinking) {
        return {
            state: 'resuming',
            isConnected: true,
            statusText: t('session.resuming'),
            shouldShowStatus: true,
            statusColor: DEFAULT_SESSION_STATUS_COLORS.connecting,
            statusDotColor: DEFAULT_SESSION_STATUS_COLORS.connecting,
            isPulsing: true
        };
    }

    if (!isOnline) {
        return {
            state: 'disconnected',
            isConnected: false,
            statusText: t('status.lastSeen', { time: formatLastSeen(session.activeAt, false) }),
            shouldShowStatus: true,
            statusColor: DEFAULT_SESSION_STATUS_COLORS.disconnected,
            statusDotColor: DEFAULT_SESSION_STATUS_COLORS.disconnected,
        };
    }

    // Pending permission/action prompts are only meaningful while the provider process is running.
    // Do not surface stale "action_required"/"permission_required" states for inactive sessions.
    if (isSessionActive && hasUserActions) {
        return {
            state: 'action_required',
            isConnected: true,
            statusText: t('status.actionRequired'),
            shouldShowStatus: true,
            statusColor: DEFAULT_SESSION_STATUS_COLORS.actionRequired,
            statusDotColor: DEFAULT_SESSION_STATUS_COLORS.actionRequired,
            isPulsing: true
        };
    }

    if (isSessionActive && hasPermissions) {
        return {
            state: 'permission_required',
            isConnected: true,
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            statusColor: DEFAULT_SESSION_STATUS_COLORS.actionRequired,
            statusDotColor: DEFAULT_SESSION_STATUS_COLORS.actionRequired,
            isPulsing: true
        };
    }

    if (isThinking) {
        return {
            state: 'thinking',
            isConnected: true,
            statusText: vibingMessage,
            shouldShowStatus: true,
            statusColor: DEFAULT_SESSION_STATUS_COLORS.connecting,
            statusDotColor: DEFAULT_SESSION_STATUS_COLORS.connecting,
            isPulsing: true
        };
    }

    return {
        state: 'waiting',
        isConnected: true,
        statusText: t('status.online'),
        shouldShowStatus: false,
        statusColor: DEFAULT_SESSION_STATUS_COLORS.connected,
        statusDotColor: DEFAULT_SESSION_STATUS_COLORS.connected,
    };
}

/**
 * Hook wrapper around `getSessionStatus` that keeps vibing text stable while the session is thinking.
 */
export function useSessionStatus(session: SessionStatusSource, options: UseSessionStatusOptions = {}): SessionStatus {
    const { theme } = useUnistyles();
    const sessionId = typeof session.id === 'string' ? session.id : '';
    const shouldSubscribeToSession = options.subscribeToSession !== false && sessionId.length > 0;
    const rawSession = useSession(shouldSubscribeToSession ? sessionId : '');
    const shouldSubscribeToTranscript = options.subscribeToTranscript !== false && sessionId.length > 0;
    const transcriptVersion = useSessionMessagesVersion(sessionId, shouldSubscribeToTranscript);
    void transcriptVersion;

    const resolvedSession = rawSession ?? session;
    const isOnline = resolvedSession.presence === "online";
    const hasPermissions = hasPendingPermissionRequests(resolvedSession);
    const hasUserActions = hasPendingUserActionRequests(resolvedSession);

    const now = Date.now();
    const optimisticThinkingAt = resolvedSession.optimisticThinkingAt ?? null;
    const isOptimisticThinking = typeof optimisticThinkingAt === 'number' && now - optimisticThinkingAt < OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS;
    const thinkingGraceUntil = resolvedSession.thinkingGraceUntil ?? null;
    const isThinkingGraceActive = typeof thinkingGraceUntil === 'number' && now < thinkingGraceUntil;
    const isThinking = resolvedSession.thinking === true || isOptimisticThinking || isThinkingGraceActive;

    const vibingIndex = React.useMemo(() => {
        return Math.floor(Math.random() * vibingMessages.length);
    }, [isOnline, hasPermissions, hasUserActions, isThinking]);

    const status = getSessionStatus(resolvedSession, now, vibingIndex);
    const statusColors = theme.colors.status as SessionStatusColors;
    return {
        ...status,
        statusColor: resolveStatusColor(status.state, statusColors),
        statusDotColor: resolveStatusColor(status.state, statusColors),
    };
}

function resolveStatusColor(state: SessionState, statusColors: SessionStatusColors): string {
    switch (state) {
        case 'resuming':
        case 'thinking':
            return statusColors.connecting;
        case 'disconnected':
            return statusColors.disconnected;
        case 'action_required':
        case 'permission_required':
            return statusColors.actionRequired;
        case 'waiting':
            return statusColors.connected;
    }
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or 'unknown' if no path is available.
 */
export function getSessionName(session: SessionStatusSource): string {
    const summaryText = readSessionDisplayTitleField(session).value;
    if (summaryText) {
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
    const reachablePath = readDisplayPathForSession({
        sessionId: session.id,
        metadata: session.metadata ?? null,
    }) || session.metadata?.path || null;

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
    const path = readDisplayPathForSession({
        sessionId: session.id,
        metadata: session.metadata ?? null,
    }) || session.metadata?.path || null;
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
