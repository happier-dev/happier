import { useSessionArchivePending } from '@/hooks/session/useSessionArchivePending';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { readSessionRuntimeObservation } from '@/sync/domains/session/sessionRuntimeObservation';
import { resolveSessionAwarenessContentLabel } from '@/sync/domains/session/awareness/sessionAwarenessContentLabels';
import { isSessionAwarenessContentReadableV1 } from '@happier-dev/protocol/sessions/awareness/availability';
import { readSessionAwarenessWorkStatusV1, type SessionAwarenessPresentationFactsV1, type SessionAwarenessPresentationStateV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import * as React from 'react';
import { Message } from "@happier-dev/session-core/messages";
import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessage';
import { storage, useSession, useSessionMessagesVersion, useSessionPendingMessages } from '@/sync/domains/state/storage';
import { getSettledMachineDisplayName } from './machineDisplayNames';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveSessionWorkspaceDisplayPresentation } from '@/sync/domains/session/listing/sessionWorkspaceDisplayPresentation';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    isFreshTimestamp,
    readSessionRuntimePresentationFreshnessExpirations,
    SESSION_OPTIMISTIC_PENDING_THINKING_MS,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
    listPendingPermissionRequestsFromSession,
    listPendingTranscriptRequests as listPendingTranscriptRequestsFromSession,
    listPendingUserActionRequestsFromSession,
    shouldReadTranscriptForPendingSessionRequests,
    type SessionPendingRequest,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import {
    readDisplayMachineIdForSession,
    readDisplayIdentityForSession,
    readDisplayMachineTargetForSession,
    readDisplayPathForSession,
} from '@/sync/ops/sessionMachineTarget';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionListRenderableOwnerMetadataView, readSessionListRenderableSharedMetadata,
    readSessionListPresentationRuntime, readSessionListPresentationPendingFlags, readSessionListPresentationPendingObservedAt,
    readSessionListPresentationDisplay,
    type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionListRowForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatSessionPath } from './formatPathRelativeToHome';
import { useUnistyles } from 'react-native-unistyles';
export { formatPathRelativeToHome } from './formatPathRelativeToHome';

/**
 * The canonical presented answer for one Session's awareness: which state it is in, how that
 * state is worded, and whether it is worth saying at all. It carries no colour, dot, pill
 * variant or animation — those belong to each presenter's own chrome.
 */
export type SessionAwarenessPresentationV1 = Readonly<{
    state: SessionAwarenessPresentationStateV1;
    actionRequiredReason?: ReturnType<typeof readSessionAwarenessWorkStatusV1>['actionRequiredReason'];
    statusText: string;
    /** The canonical owner's judgement that this state needs no badge (idle online, archived). */
    quiet: boolean;
}>;

type UiSessionAwareness = SessionAwarenessPresentationFactsV1;

export interface SessionStatus {
    actionRequiredReason?: ReturnType<typeof readSessionAwarenessWorkStatusV1>['actionRequiredReason'];
    /** Optional authored explanation, independent of the runtime-derived status label. */
    statusReason?: string;
    /**
     * The canonical projection this status was localized from. Required, not optional: a consumer
     * that has a `SessionStatus` always has the semantic answer too, so none of them needs a
     * second derivation path to fall back to.
     */
    awareness: import('@happier-dev/protocol').SessionAwarenessProjectionV1;
    state: SessionAwarenessPresentationStateV1;
    isConnected: boolean;
    bucket: ReturnType<typeof readSessionAwarenessWorkStatusV1>['bucket'];
    tone: ReturnType<typeof readSessionAwarenessWorkStatusV1>['tone'];
    statusText: string;
    shouldShowStatus: boolean;
    statusColor: string;
    statusDotColor: string;
    isPulsing?: boolean;
}
export const OPTIMISTIC_SESSION_THINKING_TIMEOUT_MS = SESSION_OPTIMISTIC_PENDING_THINKING_MS;
export { SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS };

export type PendingPermissionRequest = SessionPendingRequest;

type SessionStatusSource = Session | SessionListRenderableSession;
type SessionDisplayNameSource = Readonly<{
    id: string;
    serverId?: string;
    metadata: unknown;
    metadataLayoutVersion?: number;
    ownerMetadataView?: unknown;
    lockedDisplayTitle?: string | null;
    access?: Session['access'];
    accessLevel?: Session['accessLevel'];
}>;
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
    presentationSource?: SessionListPresentationSource;
    archiving?: boolean;
    includeTitle?: boolean;
    /** Work rows already carry an age, while Session-list rows can retain Last seen. */
    disconnectedTextMode?: 'lastSeen' | 'offline';
    vibingIndex?: number;
    workingTextMode?: SessionWorkingTextMode;
    statusColors?: SessionStatusColors;
    hasPendingUserMessages?: boolean;
    optimisticPendingUserMessageAt?: number | null;
}>;
type GetSessionStatusOptionsInput = number | GetSessionStatusOptions;
type UseSessionStatusOptions = Readonly<{
    subscribeToSession?: boolean;
    subscribeToTranscript?: boolean;
    /** Compact status/announcement consumers use stable words, independent of list-row animation. */
    workingTextMode?: SessionWorkingTextMode;
}>;

/** Hook inputs while no Session is bound. Never published as a Session or rendered as a status. */
const UNBOUND_SESSION_STATUS_SOURCE: SessionListRenderableSession = Object.freeze({
    id: '', seq: 0, createdAt: 0, updatedAt: 0, active: false, activeAt: 0,
    metadataVersion: 0, agentStateVersion: 0, metadata: null, thinking: false, thinkingAt: 0,
});

/**
 * The owner metadata view a display helper may read. A hydrated Session keeps it in its own
 * field; a list row composes it into `metadata`. Reading a row through the Session-only reader
 * found no owner view, so an owner's untitled row said "Untitled session" while its detail header
 * named the workspace — and a locked row then fell to "Encrypted session".
 * Narrow display projections retain `ownerMetadataView` without runtime `agentState`.
 */
function readDisplayOwnerMetadata(session: SessionDisplayNameSource): ReturnType<typeof readSessionOwnerMetadataView> {
    return 'ownerMetadataView' in session || 'agentState' in session
        ? readSessionOwnerMetadataView(session)
        : readSessionListRenderableOwnerMetadataView(session);
}

/**
 * The machine a Session ran on, as the Session itself recorded it: the name every surface falls back
 * to while that Machine's record is not loaded, so one page never names it in one pane and not the next.
 */
export function readSessionOwnerHostName(session: SessionDisplayNameSource): string | null {
    const host = readDisplayOwnerMetadata(session)?.host?.trim();
    return host ? host : null;
}

function readPrivateDisplayMachineTarget(
    session: SessionDisplayNameSource,
    ownerMetadata: ReturnType<typeof readSessionOwnerMetadataView>,
    serverId?: string | null,
): { machineId: string; basePath: string } | null {
    const resolvedServerId = serverId?.trim() || session.serverId;
    if (session.metadataLayoutVersion === 1) {
        if (!ownerMetadata) return null;
        const target = readDisplayIdentityForSession({
            sessionId: session.id,
            serverId: resolvedServerId,
            metadata: ownerMetadata,
            preferProvidedMetadata: true,
        });
        return target.machineId && target.basePath ? target : null;
    }
    if (session.metadataLayoutVersion !== undefined && session.metadataLayoutVersion !== 0) {
        return null;
    }
    return readDisplayMachineTargetForSession({
        sessionId: session.id,
        serverId: resolvedServerId,
        metadata: ownerMetadata,
    });
}

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

function hasPendingUserMessagesFromSource(session: SessionStatusSource): boolean {
    const pendingCount = (session as SessionListRenderableSession).pendingCount;
    return typeof pendingCount === 'number' && Number.isFinite(pendingCount) && pendingCount > 0;
}

type RuntimeStatusFreshnessRefreshInput = Readonly<{
    session: SessionStatusSource;
    hasPendingPermissionRequests: boolean;
    hasPendingUserActionRequests: boolean;
    pendingRequestObservedAt: number | null;
    hasPendingUserMessages: boolean;
    optimisticPendingUserMessageAt: number | null;
}>;

function resolveRuntimeStatusFreshnessRefreshDelayMs(
    input: RuntimeStatusFreshnessRefreshInput,
    nowMs: number,
): number | null {
    const session = readSessionRuntimeObservation(input.session);
    if (session.presence !== 'online') return null;

    const expirations = [...readSessionRuntimePresentationFreshnessExpirations({
        id: session.id,
        serverId: session.serverId,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt,
        presence: session.presence,
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        optimisticThinkingAt: session.optimisticThinkingAt ?? input.optimisticPendingUserMessageAt ?? null,
        hasPendingUserMessages: input.hasPendingUserMessages,
        latestTurnStatus: session.latestTurnStatus,
        latestTurnStatusObservedAt: session.latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: session.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        hasPendingPermissionRequests: input.hasPendingPermissionRequests,
        hasPendingUserActionRequests: input.hasPendingUserActionRequests,
        pendingRequestObservedAt: input.pendingRequestObservedAt,
    }, nowMs)];
    // Freshness is presentation time, distinct from the persistent active-turn fact.
    if (session.active === true && typeof session.activeAt === 'number' && session.activeAt > 0) {
        const staleAtMs = session.activeAt + SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS + 1;
        if (staleAtMs > nowMs) expirations.push(staleAtMs);
    }

    // Only a deadline still ahead of this observation can change what is already rendered, and a
    // past deadline clamped to zero would re-arm the refresh immediately, forever.
    const delays = expirations
        .map((expiresAtMs) => expiresAtMs - nowMs)
        .filter((delayMs) => delayMs > 0);
    if (delays.length === 0) return null;
    return Math.min(...delays);
}

/** Next presentation change from these Session facts, for consumers of the shared runtime clock. */
export function readSessionStatusNextRefreshAtMs(session: SessionStatusSource, nowMs: number): number | null {
    const delayMs = resolveRuntimeStatusFreshnessRefreshDelayMs({
        session,
        hasPendingPermissionRequests: hasPendingPermissionRequests(session),
        hasPendingUserActionRequests: hasPendingUserActionRequests(session),
        pendingRequestObservedAt: latestPendingRequestObservedAt(session),
        hasPendingUserMessages: hasPendingUserMessagesFromSource(session),
        optimisticPendingUserMessageAt: null,
    }, nowMs);
    return delayMs === null ? null : nowMs + delayMs;
}

function useRuntimeStatusFreshnessRefresh(input: RuntimeStatusFreshnessRefreshInput): void {
    // The revision is a dependency on purpose: one expiration can be followed by a later one from
    // the same unchanged facts, so the effect must re-evaluate its own next deadline after it
    // fires. Without it only the first deadline is ever armed and a later staleness transition
    // stays visually fresh until an unrelated state change.
    const [freshnessRevision, refresh] = React.useReducer((value: number) => value + 1, 0);
    React.useEffect(() => {
        const delayMs = resolveRuntimeStatusFreshnessRefreshDelayMs(input, Date.now());
        if (delayMs === null) return undefined;
        const timeoutId = setTimeout(refresh, delayMs);
        return () => clearTimeout(timeoutId);
    }, [
        freshnessRevision,
        input.session.active,
        input.session.activeAt,
        input.session.presence,
        input.session.thinking,
        input.session.thinkingAt,
        input.session.latestTurnStatus,
        input.session.latestTurnStatusObservedAt,
        input.session.runtimeActivityActiveCount,
        input.session.runtimeActivityObservedAt,
        input.session.runtimeActivityRevision,
        input.session.optimisticThinkingAt,
        input.hasPendingUserMessages,
        input.optimisticPendingUserMessageAt,
        input.hasPendingPermissionRequests,
        input.hasPendingUserActionRequests,
        input.pendingRequestObservedAt,
    ]);
}

export function shouldShowAbortButtonForSessionState(state: SessionAwarenessPresentationStateV1): boolean {
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
/**
 * Localized words for Protocol's shared presentation precedence. Readability, lifecycle,
 * runtime and freshness are decided there, along with Work buckets and tones. Every presenter —
 * the list row, the Session header and the Companion Summary pill — consumes this answer and
 * adds only its own chrome (colour, dot, pill variant, visibility).
 */
export function presentSessionAwarenessV1(
    awareness: UiSessionAwareness,
    options?: Readonly<{
        /** `activeAt` for the "last seen" wording; omit it for a plain disconnected label. */
        lastSeenAtMs?: number | null;
        disconnectedTextMode?: 'lastSeen' | 'offline';
        /** The caller's already-chosen working wording; omitted callers get the static one. */
        workingLabel?: string;
        /** Observation uncertainty changes the wording without settling reported work. */
        freshness?: UiSessionAwareness['freshness'];
    }>,
): SessionAwarenessPresentationV1 {
    const status = readSessionAwarenessWorkStatusV1({ awareness });
    const presented = presentSessionAwarenessStateV1(status.state, {
        ...options, freshness: awareness.freshness,
    });
    return status.actionRequiredReason ? { ...presented, actionRequiredReason: status.actionRequiredReason } : presented;
}

/** Localize an already classified state without running a second presentation decision. */
export function presentSessionAwarenessStateV1(
    state: SessionAwarenessPresentationStateV1,
    options?: Parameters<typeof presentSessionAwarenessV1>[1],
): SessionAwarenessPresentationV1 {
    if (state === 'archived') {
        return { state, statusText: t('status.online'), quiet: true };
    }
    // Settled content blockers keep their recovery copy; unreadable content must not be guessed
    // into an operational state such as working.
    if (state === 'locked' || state === 'preparing' || state === 'repair_needed' || state === 'access_pending' || state === 'setup_required' || state === 'content_unavailable') {
        return { state, statusText: resolveSessionAwarenessContentLabel(state) ?? t('status.unknown'), quiet: false };
    }
    if (state === 'recoverable_unservable') {
        return { state: 'recoverable_unservable', statusText: t('status.disconnected'), quiet: false };
    }
    if (state === 'resuming') {
        return { state: 'resuming', statusText: t('session.resuming'), quiet: false };
    }
    if (state === 'disconnected') {
        const lastSeenAtMs = options?.lastSeenAtMs;
        return {
            state: 'disconnected',
            statusText: options?.disconnectedTextMode === 'offline'
                    ? t('status.offline')
                    : typeof lastSeenAtMs === 'number'
                        ? t('status.lastSeen', { time: formatLastSeen(lastSeenAtMs, false) })
                        : t('status.disconnected'),
            quiet: false,
        };
    }
    if (state === 'unknown') return { state: 'unknown', statusText: '—', quiet: true };
    if (state === 'stale') return { state: 'stale', statusText: t('status.awaitingUpdates'), quiet: false };
    switch (state) {
        case 'archiving': return { state, statusText: t('status.archiving'), quiet: false };
        case 'stopped': return { state, statusText: t('sessionWork.states.stopped'), quiet: false };
        case 'usage_limited': return { state, statusText: t('session.usageLimitRecovery.banner.title'), quiet: false };
        case 'finished_unseen': return { state, statusText: t('workStatus.buckets.finished'), quiet: false };
        case 'mentioned': return { state, statusText: t('status.mentioned'), quiet: false };
        case 'unread': return { state, statusText: t('status.unread'), quiet: false };
        case 'failed': return { state: 'failed', statusText: t('status.error'), quiet: false };
        case 'action_required': return { state: 'action_required', statusText: t('status.actionRequired'), quiet: false };
        case 'permission_required': return { state: 'permission_required', statusText: t('status.permissionRequired'), quiet: false };
        case 'thinking': return {
            state: 'thinking',
            statusText: options?.workingLabel ?? t('status.working'),
            quiet: false,
        };
        case 'ready': return { state: 'ready', statusText: t('status.ready'), quiet: false };
        case 'pending_input': return { state: 'pending_input', statusText: t('status.queuedInput'), quiet: false };
        case 'background_active': return { state, quiet: false,
            statusText: options?.freshness === 'stale' ? t('status.awaitingUpdates') : t('status.backgroundActive') };
        case 'waiting':
            // An idle, reachable Session is not news: the canonical presenter has always kept
            // this one quiet rather than labelling it.
            return { state: 'waiting', statusText: t('status.online'), quiet: true };
    }
}

export function getSessionStatus(session: SessionStatusSource, nowMs: number = Date.now(), options?: GetSessionStatusOptionsInput): SessionStatus {
    const resolvedOptions = resolveGetSessionStatusOptions(options);
    const source = resolvedOptions.presentationSource;
    if (!source) session = readSessionRuntimeObservation(session);
    const pending = source ? readSessionListPresentationPendingFlags(source) : null;
    const { statusColors = DEFAULT_SESSION_STATUS_COLORS } = resolvedOptions;
    const awareness = projectUiSessionAwareness(session, nowMs, {
        ...resolvedOptions,
        hasPendingPermissionRequests: hasPendingPermissionRequests(session),
        hasPendingUserActionRequests: hasPendingUserActionRequests(session),
        pendingRequestObservedAt: latestPendingRequestObservedAt(session),
    });
    const connected = awareness.runtime !== 'offline' && awareness.runtime !== 'unknown';
    const archiving = resolvedOptions.archiving ?? (('archiving' in session && session.archiving === true)
        || Boolean(source?.baseSession && 'archiving' in source.baseSession && source.baseSession.archiving === true));
    const contentReadable = isSessionAwarenessContentReadableV1(awareness.encryption);
    const canAnimate = awareness.freshness === 'live' && contentReadable;
    const facts = { ...awareness, viewer: session.viewer, archiving };
    const status = readSessionAwarenessWorkStatusV1({ awareness: facts });
    const presented = presentSessionAwarenessStateV1(status.state, {
        freshness: awareness.freshness,
        lastSeenAtMs: source ? readSessionRuntimeObservation(readSessionListPresentationRuntime(source)).activeAt : session.activeAt,
        disconnectedTextMode: resolvedOptions.disconnectedTextMode,
    });
    const color = status.tone === 'danger' ? statusColors.error
        : status.tone === 'attention' ? statusColors.actionRequired : statusColors.default;
    return {
        awareness,
        state: presented.state,
        ...(status.actionRequiredReason ? { actionRequiredReason: status.actionRequiredReason } : {}),
        bucket: status.bucket,
        tone: status.tone,
        statusText: presented.statusText,
        ...(awareness.statusReason ? { statusReason: awareness.statusReason } : {}),
        isConnected: status.bucket === 'offline' ? false : connected,
        shouldShowStatus: !presented.quiet,
        statusColor: color,
        statusDotColor: color,
        isPulsing: status.bucket === 'working' && awareness.runtime === 'working' && canAnimate,
    };
}

/**
 * Subscription and freshness binding around the canonical Session presenter.
 */
export function useSessionStatus(session: SessionStatusSource, options?: UseSessionStatusOptions): SessionStatus;
export function useSessionStatus(session: SessionStatusSource | null, options?: UseSessionStatusOptions): SessionStatus | null;
export function useSessionStatus(session: SessionStatusSource | null, options: UseSessionStatusOptions = {}): SessionStatus | null {
    const { theme } = useUnistyles();
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    const scopedAddress = session && 'serverId' in session && typeof session.serverId === 'string'
        ? normalizeSessionAddress(session.serverId, sessionId) : null;
    const archivePending = useSessionArchivePending(scopedAddress);
    const shouldSubscribeToSession = options.subscribeToSession !== false && sessionId.length > 0;
    const rawSession = useSession(shouldSubscribeToSession ? sessionId : '');
    const shouldSubscribeToTranscript = options.subscribeToTranscript !== false && sessionId.length > 0;
    const transcriptVersion = useSessionMessagesVersion(sessionId, shouldSubscribeToTranscript);
    const pendingMessagesState = useSessionPendingMessages(shouldSubscribeToTranscript ? sessionId : '');
    void transcriptVersion;

    const resolvedSession = readSessionRuntimeObservation(rawSession ?? session ?? UNBOUND_SESSION_STATUS_SOURCE);
    const hasPermissions = hasPendingPermissionRequests(resolvedSession);
    const hasUserActions = hasPendingUserActionRequests(resolvedSession);
    const hasPendingUserMessages = hasPendingUserMessagesFromSource(resolvedSession) || pendingMessagesState.messages.length > 0;
    const optimisticPendingUserMessageAt = readLatestLocalOutboundPendingUserMessageAt(pendingMessagesState.messages);
    const pendingRequestObservedAt = latestPendingRequestObservedAt(resolvedSession);
    useRuntimeStatusFreshnessRefresh({
        session: resolvedSession,
        hasPendingPermissionRequests: hasPermissions,
        hasPendingUserActionRequests: hasUserActions,
        hasPendingUserMessages,
        optimisticPendingUserMessageAt,
        pendingRequestObservedAt,
    });

    const now = Date.now();
    if (!session && !rawSession) return null;
    return getSessionStatus(resolvedSession, now, {
        archiving: archivePending || Boolean(session && 'archiving' in session && session.archiving === true),
        statusColors: theme.colors.status as SessionStatusColors,
        hasPendingUserMessages,
        optimisticPendingUserMessageAt,
    });
}

/**
 * The title an authorized Session may safely show while its content stays locked.
 *
 * A safe cached title is kept: encryption pending is not a reason to forget the name
 * this device already legitimately holds. Only when none exists does the locked
 * fallback apply — `getSessionName` would otherwise return the generic unknown
 * label, which reads as a defect rather than as encryption.
 *
 * One owner on purpose, so the list row and the detail header can never disagree
 * about what a locked Session is called.
 */
export function resolveLockedSessionTitle(title: string): string {
    return title.trim().length > 0 && !isUntitledSessionName(title)
        ? title
        : readLockedSessionName();
}

/**
 * What a Session whose content this device cannot read is called when no safe name is held: the
 * Session list, its header, the Inbox and the activity surfaces all say it the same way. (The Board's
 * "Encrypted details unavailable" is a widget sentence, not a Session name.)
 */
export function readLockedSessionName(): string {
    return t('session.access.lockedTitleFallback');
}

/**
 * Whether `name` is the fallback `getSessionName` gives a session with no title, name or path (an
 * External session imported before its transcript loaded, say). It names the session honestly
 * ("Untitled session"), never the runtime-status word "unknown".
 */
export function isUntitledSessionName(name: string): boolean {
    return name === t('session.untitled');
}

/**
 * Extracts a display name from a session's metadata path.
 * Returns the last segment of the path, or "Untitled session" when nothing names it.
 */
export function getSessionName(
    session: SessionDisplayNameSource,
    serverId?: string | null,
    options?: Readonly<{ snapshotOnly?: boolean }>,
): string {
    const summaryText = readSessionDisplayTitleField(session).value;
    const ownerMetadata = readDisplayOwnerMetadata(session);
    if (summaryText) {
        return summaryText;
    }
    if (ownerMetadata?.name) {
        const name = ownerMetadata.name.trim();
        if (name.length > 0) return name;
    }
    // The held row already owns the transcript projection. Full Sessions (headers and notices)
    // reuse its Home-qualified title instead of scanning the transcript or deriving another name.
    if (!options?.snapshotOnly && session.metadata != null && ('agentState' in session || 'ownerMetadataView' in session)) {
        const home = serverId?.trim() || session.serverId?.trim() || getActiveServerId();
        const row = readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, home, session.id);
        const title = readSessionDisplayTitleField(session, {
            fallbackTitle: readSessionDisplayTitleField(row).value,
        }).value;
        if (title) return title;
    }
    if (readSessionDirectoryKind(ownerMetadata) === 'managed') {
        // A no-folder session is not named after its private folder.
        return t('session.folderless.untitledChat');
    }
    if (ownerMetadata) {
        const displayMetadata = ownerMetadata;
        const displayPath = (options?.snapshotOnly ? null : readPrivateDisplayMachineTarget(session, ownerMetadata, serverId))?.basePath
            ?? readDisplayPathForSession({
            sessionId: null,
            metadata: displayMetadata ?? null,
        });
        const segments = displayPath.split('/').filter(Boolean);
        const lastSegment = segments.pop();
        if (!lastSegment) {
            return t('session.untitled');
        }
        return lastSegment;
    }
    return t('session.untitled');
}

/**
 * `getSessionName`, or null when nothing names the Session ("Untitled session"): for surfaces that
 * say their own generic word (a notification, a warning) rather than the untitled one. The name
 * itself is never decided anywhere else.
 */
export function readSessionNameIfNamed(
    session: SessionDisplayNameSource,
    serverId?: string | null,
    /** Exact authorized reads must not borrow another projection's cached title or path. */
    options?: Readonly<{ snapshotOnly?: boolean }>,
): string | null {
    const name = getSessionName(session, serverId, options);
    return isUntitledSessionName(name) ? null : name;
}

/**
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: SessionDisplayNameSource, serverId?: string | null): string {
    const ownerMetadata = readDisplayOwnerMetadata(session);
    const displayMetadata = ownerMetadata;
    const reachableTarget = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId);
    const reachableMachineId = reachableTarget?.machineId ?? readDisplayMachineIdForSession({
        sessionId: null,
        metadata: displayMetadata ?? null,
    });
    const reachablePath = reachableTarget?.basePath ?? ownerMetadata?.path ?? null;

    if (reachableMachineId && readSessionDirectoryKind(ownerMetadata) === 'managed') {
        // Every no-folder session has its own private folder; the session, not the folder, is its identity.
        return `${reachableMachineId}:${session.id}`;
    }
    if (reachableMachineId && reachablePath) {
        // Combine machine ID and path for a unique, deterministic avatar
        return `${reachableMachineId}:${reachablePath}`;
    }
    // Fallback to session ID if metadata is missing
    return session.id;
}

/**
 * The carried card's state line for a Session (DnD lab C2: "Working · happier · devbox"): its state when
 * that is news, then where it works. An idle, reachable Session's state stays quiet, as in its row.
 */
export function getSessionCarriedLine(session: SessionStatusSource, serverId?: string | null,
    source?: SessionListPresentationSource): string | null {
    const status = getSessionStatus(session, undefined, { presentationSource: source });
    return [status.shouldShowStatus ? status.statusText : null,
        getSessionWorkContext(source ? readSessionListPresentationDisplay(source) : session, serverId)].filter(Boolean).join(' · ') || null;
}

/** Display-only identity behind Work bylines and Session reference rows. */
export function getSessionWorkContextParts(session: SessionDisplayNameSource, serverId?: string | null): Readonly<{
    agentId: string | null;
    agentLabel: string | null;
    machineId: string | null;
    locationLabel: string | null;
}> {
    const state = storage.getState();
    const ownerMetadata = readDisplayOwnerMetadata(session);
    const target = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId);
    const home = serverId?.trim() || getActiveServerId();
    const machineId = target?.machineId ?? ownerMetadata?.machineId ?? null;
    const machine = machineId ? state.machineListByServerId[home]?.find(item => item.id === machineId)
        ?? (home === getActiveServerId() ? state.machines[machineId] : undefined) : undefined;
    const machineName = getSettledMachineDisplayName(machine) ?? readSessionOwnerHostName(session);
    const agentId = readSessionPresentationAgentId({
        metadataLayoutVersion: session.metadataLayoutVersion,
        metadata: 'ownerMetadataView' in session || 'agentState' in session
            ? session.metadata
            : readSessionListRenderableSharedMetadata(session),
    });
    const agent = agentId ? resolveAgentCatalogProjection(agentId, { enabledAgentIds: [] }).title : null;
    const workspace = !machineName && ownerMetadata && readSessionDirectoryKind(ownerMetadata) !== 'managed'
        ? resolveSessionWorkspaceDisplayPresentation({ serverId: home, metadata: ownerMetadata,
            machineTarget: target, workspaceRefs: readProjectWorkspaceRefs(state), workspacePathDisplayModeV1: 'name' }).displayTitle
        : null;
    return { agentId, agentLabel: agent, machineId, locationLabel: machineName || workspace || null };
}

/** Compact Work identity: Agent · named machine, otherwise the workspace owner's display name. */
export function getSessionWorkContext(session: SessionDisplayNameSource, serverId?: string | null): string | null {
    const parts = getSessionWorkContextParts(session, serverId);
    return [parts.agentLabel, parts.locationLabel].filter(Boolean).join(' · ') || null;
}

/** Returns the session path for the subtitle on existing path-oriented surfaces. */
export function getSessionSubtitle(session: SessionDisplayNameSource, serverId?: string | null): string {
    const ownerMetadata = readDisplayOwnerMetadata(session);
    if (readSessionDirectoryKind(ownerMetadata) === 'managed') {
        // Where a no-folder session runs is its machine; its private folder is not a place to show.
        const machineId = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId)?.machineId ?? ownerMetadata?.machineId;
        const machine = machineId ? storage.getState().machines[machineId] : undefined;
        return getSettledMachineDisplayName(machine) ?? ownerMetadata?.host ?? t('status.unknown');
    }
    const path = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId)?.basePath
        ?? ownerMetadata?.path
        ?? null;
    if (path) {
        return formatSessionPath(path, ownerMetadata?.homeDir ?? undefined);
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
export function formatOSPlatform(platform?: string | null): string {
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

    // Sessions can reach this without a usable timestamp (0 is the repo-wide
    // "no timestamp" convention); formatting an invalid Date throws in the
    // date-formatting path, so degrade to the unknown label instead of
    // crashing the row.
    if (typeof activeAt !== 'number' || !Number.isFinite(activeAt) || activeAt <= 0) {
        return t('status.unknown');
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
        return formatWithCachedDateTimeFormatter(date, undefined, options);
    }
}
