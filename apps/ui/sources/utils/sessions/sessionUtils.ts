import * as React from 'react';
import { Message } from '@/sync/domains/messages/messageTypes';
import { useSession, useSessionMessagesVersion, useSetting } from '@/sync/domains/state/storage';
import { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    deriveSessionRuntimePresentationState,
    isFreshTimestamp,
    readSessionRuntimePresentationFreshnessTimestamps,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
    listPendingRequestListsFromSession,
    listPendingPermissionRequestsFromSession,
    listPendingTranscriptRequests as listPendingTranscriptRequestsFromSession,
    listPendingUserActionRequestsFromSession,
    shouldReadTranscriptForPendingSessionRequests,
    type SessionPendingRequest,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    readDisplayMachineIdForSession,
    readDisplayMachineTargetForSession,
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
export { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS };

export type PendingPermissionRequest = SessionPendingRequest;
export type PendingAgentInputRequests = Readonly<{
    permissionRequests: readonly PendingPermissionRequest[];
    userActionRequests: readonly PendingPermissionRequest[];
}>;

type SessionStatusSource = Session | SessionListRenderableSession;
type SessionStatusColors = Readonly<{
    connected: string;
    connecting: string;
    actionRequired: string;
    disconnected: string;
    error: string;
    default: string;
}>;
export type SessionWorkingTextMode = 'animated' | 'static';
type GetSessionStatusOptions = Readonly<{
    vibingIndex?: number;
    workingTextMode?: SessionWorkingTextMode;
    statusColors?: SessionStatusColors;
}>;
type GetSessionStatusOptionsInput = number | GetSessionStatusOptions;
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

export function listPendingAgentInputRequests(
    session: Session,
    messages?: ReadonlyArray<Message>,
): PendingAgentInputRequests {
    return listPendingRequestListsFromSession(session, messages);
}

export function shouldReadTranscriptForPendingRequests(session: Session): boolean {
    return shouldReadTranscriptForPendingSessionRequests(session);
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

function latestPendingRequestObservedAt(session: SessionStatusSource): number | null {
    if (typeof (session as SessionListRenderableSession).hasPendingPermissionRequests === 'boolean') {
        return (session as SessionListRenderableSession).pendingRequestObservedAt ?? null;
    }
    return deriveLatestPendingRequestObservedAtFromSession(session as Session);
}

type RuntimeStatusFreshnessRefreshInput = Readonly<{
    session: SessionStatusSource;
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    pendingRequestObservedAt: number | null;
}>;

function resolveRuntimeStatusFreshnessRefreshDelayMs(
    input: RuntimeStatusFreshnessRefreshInput,
    nowMs: number,
): number | null {
    const { session } = input;
    if (session.active !== true || session.presence !== 'online') return null;

    const delays: number[] = [];
    const addFreshnessDelay = (timestamp: number | null | undefined) => {
        if (!isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS)) return;
        delays.push(Math.max(0, Math.trunc(timestamp as number) + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS - nowMs));
    };

    for (const timestamp of readSessionRuntimePresentationFreshnessTimestamps({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        hasPendingPermissionRequests: input.hasPendingPermissionRequests,
        hasPendingUserActionRequests: input.hasPendingUserActionRequests,
        pendingRequestObservedAt: input.pendingRequestObservedAt,
    }, nowMs)) {
        addFreshnessDelay(timestamp);
    }

    if (delays.length === 0) return null;
    return Math.min(...delays);
}

function useRuntimeStatusFreshnessRefresh(input: RuntimeStatusFreshnessRefreshInput): void {
    const [, refresh] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => {
        const delayMs = resolveRuntimeStatusFreshnessRefreshDelayMs(input, Date.now());
        if (delayMs === null) return undefined;
        const timeoutId = setTimeout(refresh, delayMs);
        return () => clearTimeout(timeoutId);
    }, [
        input.session.active,
        input.session.activeAt,
        input.session.presence,
        input.session.thinking,
        input.session.thinkingAt,
        input.session.latestTurnStatus,
        input.session.latestTurnStatusObservedAt,
        input.hasPendingPermissionRequests,
        input.hasPendingUserActionRequests,
        input.pendingRequestObservedAt,
    ]);
}

export function shouldShowAbortButtonForSessionState(state: SessionState): boolean {
    // Abort should only be available when there's an in-flight operation or a permission gate.
    // Idle online sessions are represented as `waiting` today.
    return state === 'thinking' || state === 'permission_required' || state === 'action_required';
}

function resolveGetSessionStatusOptions(options?: GetSessionStatusOptionsInput): GetSessionStatusOptions {
    if (typeof options === 'number') return { vibingIndex: options };
    return options ?? {};
}

/**
 * Get the current state of a session based on presence and thinking status.
 * Uses centralized session state from storage.ts
 */
export function getSessionStatus(session: SessionStatusSource, nowMs: number = Date.now(), options?: GetSessionStatusOptionsInput): SessionStatus {
    const { vibingIndex, workingTextMode = 'animated', statusColors = DEFAULT_SESSION_STATUS_COLORS } = resolveGetSessionStatusOptions(options);
    const isOnline = session.presence === "online";
    const hasPermissions = hasPendingPermissionRequests(session);
    const hasUserActions = hasPendingUserActionRequests(session);
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: session.active,
        activeAt: session.activeAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus: session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: hasPermissions,
        hasPendingUserActionRequests: hasUserActions,
        pendingRequestObservedAt: latestPendingRequestObservedAt(session),
        nowMs,
    });

    const workingStatusText = (() => {
        if (workingTextMode === 'static') return t('status.working');
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
            statusColor: statusColors.disconnected,
            statusDotColor: statusColors.disconnected,
        };
    }

    // Pending permission/action prompts are only meaningful while the provider process is running.
    // Do not surface stale "action_required"/"permission_required" states for inactive sessions.
    if (runtimePresentation.freshActionRequired) {
        return {
            state: 'action_required',
            isConnected: true,
            statusText: t('status.actionRequired'),
            shouldShowStatus: true,
            statusColor: statusColors.actionRequired,
            statusDotColor: statusColors.actionRequired,
            isPulsing: true
        };
    }

    if (runtimePresentation.freshPermissionRequired) {
        return {
            state: 'permission_required',
            isConnected: true,
            statusText: t('status.permissionRequired'),
            shouldShowStatus: true,
            statusColor: statusColors.actionRequired,
            statusDotColor: statusColors.actionRequired,
            isPulsing: true
        };
    }

    if (runtimePresentation.working) {
        return {
            state: 'thinking',
            isConnected: true,
            statusText: workingStatusText,
            shouldShowStatus: true,
            statusColor: statusColors.connecting,
            statusDotColor: statusColors.connecting,
            isPulsing: true
        };
    }

    return {
        state: 'waiting',
        isConnected: true,
        statusText: t('status.online'),
        shouldShowStatus: false,
        statusColor: statusColors.connected,
        statusDotColor: statusColors.connected,
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
    const sessionListWorkingStatusAnimatedTextEnabled = useSetting('sessionListWorkingStatusAnimatedTextEnabled');
    const shouldSubscribeToTranscript = options.subscribeToTranscript !== false && sessionId.length > 0;
    const transcriptVersion = useSessionMessagesVersion(sessionId, shouldSubscribeToTranscript);
    void transcriptVersion;

    const resolvedSession = rawSession ?? session;
    const isOnline = resolvedSession.presence === "online";
    const hasPermissions = hasPendingPermissionRequests(resolvedSession);
    const hasUserActions = hasPendingUserActionRequests(resolvedSession);
    const pendingRequestObservedAt = latestPendingRequestObservedAt(resolvedSession);
    useRuntimeStatusFreshnessRefresh({
        session: resolvedSession,
        hasPendingPermissionRequests: hasPermissions,
        hasPendingUserActionRequests: hasUserActions,
        pendingRequestObservedAt,
    });

    const now = Date.now();
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: resolvedSession.active,
        activeAt: resolvedSession.activeAt,
        presence: resolvedSession.presence,
        thinking: resolvedSession.thinking,
        thinkingAt: resolvedSession.thinkingAt,
        latestTurnStatus: resolvedSession.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: resolvedSession.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: resolvedSession.meaningfulActivityAt ?? null,
        lastRuntimeIssue: resolvedSession.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: hasPermissions,
        hasPendingUserActionRequests: hasUserActions,
        pendingRequestObservedAt,
        nowMs: now,
    });

    const vibingIndex = React.useMemo(() => {
        return Math.floor(Math.random() * vibingMessages.length);
    }, [isOnline, hasPermissions, hasUserActions, runtimePresentation.working]);

    return getSessionStatus(resolvedSession, now, {
        vibingIndex,
        workingTextMode: sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated',
        statusColors: theme.colors.status as SessionStatusColors,
    });
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
        const displayPath = readDisplayMachineTargetForSession({
            sessionId: session.id,
            metadata: session.metadata ?? null,
        })?.basePath ?? readDisplayPathForSession({
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
    const reachableTarget = readDisplayMachineTargetForSession({
        sessionId: session.id,
        metadata: session.metadata ?? null,
    });
    const reachableMachineId = reachableTarget?.machineId ?? readDisplayMachineIdForSession({
        sessionId: session.id,
        metadata: session.metadata ?? null,
    });
    const reachablePath = reachableTarget?.basePath ?? session.metadata?.path ?? null;

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
    const path = readDisplayMachineTargetForSession({
        sessionId: session.id,
        metadata: session.metadata ?? null,
    })?.basePath ?? session.metadata?.path ?? null;
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
