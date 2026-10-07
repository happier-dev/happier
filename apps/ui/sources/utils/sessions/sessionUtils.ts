import { projectUiSessionAwareness } from '@/sync/domains/session/awareness/sessionAwareness';
import { resolveSessionAwarenessContentLabel } from '@/sync/domains/session/awareness/sessionAwarenessContentLabels';
import { isSessionAwarenessContentReadableV1, readSessionDirectoryKind, type SessionAwarenessEncryptionV1 } from '@happier-dev/protocol';
import * as React from 'react';
import { Message } from "@happier-dev/session-core/messages";
import { readLatestLocalOutboundPendingUserMessageAt } from '@/sync/domains/messages/outgoingUserMessage';
import { storage, useSession, useSessionMessagesVersion, useSessionPendingMessages, useSetting } from '@/sync/domains/state/storage';
import { getMachineDisplayName } from './machineDisplayNames';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    projectUiSessionRuntimeAwareness,
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
import { readSessionListRenderableOwnerMetadataView } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { formatPathRelativeToHome } from './formatPathRelativeToHome';
import { useUnistyles } from 'react-native-unistyles';
export { formatPathRelativeToHome } from './formatPathRelativeToHome';

export type SessionState = 'unknown' | 'stale' | 'locked' | 'preparing' | 'repair_needed' | 'access_pending' | 'setup_required' | 'content_unavailable' | 'failed' | 'ready' | 'pending_input' | 'disconnected' | 'recoverable_unservable' | 'resuming' | 'thinking' | 'background_active' | 'waiting' | 'permission_required' | 'action_required';

/**
 * The canonical presented answer for one Session's awareness: which state it is in, how that
 * state is worded, and whether it is worth saying at all. It carries no colour, dot, pill
 * variant or animation — those belong to each presenter's own chrome.
 */
export type SessionAwarenessPresentationV1 = Readonly<{
    state: SessionState;
    statusText: string;
    /** The canonical owner's judgement that this state needs no badge (idle online, archived). */
    quiet: boolean;
}>;

type UiSessionAwareness = import('@happier-dev/protocol').SessionAwarenessProjectionV1;

export interface SessionStatus {
    /**
     * The canonical projection this status was localized from. Required, not optional: a consumer
     * that has a `SessionStatus` always has the semantic answer too, so none of them needs a
     * second derivation path to fall back to.
     */
    awareness: import('@happier-dev/protocol').SessionAwarenessProjectionV1;
    state: SessionState;
    isConnected: boolean;
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
    includeTitle?: boolean;
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

/**
 * Per-state chrome for the list/header presenter. It is a lookup beside the one ladder rather
 * than a second ladder: adding a Session state makes this table fail to compile until its
 * chrome is stated, which is how the two stayed in step when they were one expression.
 */
const SESSION_STATE_STATUS_CHROME: Readonly<Record<SessionState, Readonly<{
    color: keyof SessionStatusColors;
    pulse: boolean;
    disconnected?: boolean;
}>>> = Object.freeze({
    waiting: { color: 'connected', pulse: false },
    unknown: { color: 'default', pulse: false },
    stale: { color: 'default', pulse: false },
    locked: { color: 'default', pulse: false },
    preparing: { color: 'default', pulse: false },
    repair_needed: { color: 'default', pulse: false },
    access_pending: { color: 'default', pulse: false },
    setup_required: { color: 'default', pulse: false },
    content_unavailable: { color: 'default', pulse: false },
    failed: { color: 'error', pulse: false },
    ready: { color: 'connected', pulse: false },
    pending_input: { color: 'default', pulse: false },
    disconnected: { color: 'disconnected', pulse: false },
    recoverable_unservable: { color: 'error', pulse: false, disconnected: true },
    resuming: { color: 'connecting', pulse: true },
    thinking: { color: 'connecting', pulse: true },
    background_active: { color: 'default', pulse: false },
    permission_required: { color: 'actionRequired', pulse: true },
    action_required: { color: 'actionRequired', pulse: true },
});

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
    const { session } = input;
    if (session.presence !== 'online') return null;

    const expirations = [...readSessionRuntimePresentationFreshnessExpirations({
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

export function shouldShowAbortButtonForSessionState(state: SessionState): boolean {
    // Abort should only be available when there's an in-flight operation or a permission gate.
    // Idle online sessions are represented as `waiting` today.
    return state === 'thinking' || state === 'permission_required' || state === 'action_required';
}

/**
 * Localized copy for each content state this viewer cannot read. Whether content is readable at
 * all stays Protocol's decision (`isSessionAwarenessContentReadableV1`); this is only the wording
 * and the row vocabulary for the answer it already gave.
 */
function presentUnreadableSessionContent(
    encryption: SessionAwarenessEncryptionV1,
): Readonly<{ state: SessionState; statusText: string }> {
    // The wording lives with the shared context line's owner so a row and its context line cannot
    // explain the same envelope differently; only the row's own state vocabulary stays here.
    const statusText = resolveSessionAwarenessContentLabel(encryption) ?? t('status.unknown');
    switch (encryption) {
        case 'locked': return { state: 'locked', statusText };
        case 'preparing': return { state: 'preparing', statusText };
        case 'repair_needed': return { state: 'repair_needed', statusText };
        case 'access_pending': return { state: 'access_pending', statusText };
        case 'setup_required': return { state: 'setup_required', statusText };
        case 'content_unavailable': return { state: 'content_unavailable', statusText };
        default: return { state: 'unknown', statusText };
    }
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
 * The ONE ordering that turns canonical awareness into a presented Session state and its
 * label. Content readability, an unservable runtime, resuming, an offline or unknown runtime
 * and staleness all outrank `operational.primary`, which is why a consumer that reads
 * `operational.primary` alone reports an offline Session as "Online". Every presenter —
 * the list row, the Session header and the Companion Summary pill — consumes this answer and
 * adds only its own chrome (colour, dot, pill variant, visibility).
 */
export function presentSessionAwarenessV1(
    awareness: UiSessionAwareness,
    options?: Readonly<{
        /** `activeAt` for the "last seen" wording; omit it for a plain disconnected label. */
        lastSeenAtMs?: number | null;
        /** The caller's already-chosen working wording; omitted callers get the static one. */
        workingLabel?: string;
    }>,
): SessionAwarenessPresentationV1 {
    if (awareness.lifecycle === 'archived') {
        return { state: 'waiting', statusText: t('status.online'), quiet: true };
    }
    // Every state the content owner cannot read stays visible and quiet: guessing an operational
    // state from facts we cannot see is how a blocked session reports itself as working.
    if (!isSessionAwarenessContentReadableV1(awareness.encryption)) {
        return { ...presentUnreadableSessionContent(awareness.encryption), quiet: false };
    }
    if (awareness.operational.reasons.includes('runtime_unservable')) {
        return { state: 'recoverable_unservable', statusText: t('status.disconnected'), quiet: false };
    }
    if (awareness.operational.reasons.includes('resuming')) {
        return { state: 'resuming', statusText: t('session.resuming'), quiet: false };
    }
    if (awareness.runtime === 'offline') {
        const lastSeenAtMs = options?.lastSeenAtMs;
        return {
            state: 'disconnected',
            statusText: typeof lastSeenAtMs === 'number'
                ? t('status.lastSeen', { time: formatLastSeen(lastSeenAtMs, false) })
                : t('status.disconnected'),
            quiet: false,
        };
    }
    if (awareness.runtime === 'unknown') return { state: 'unknown', statusText: t('status.unknown'), quiet: false };
    if (awareness.freshness === 'stale') return { state: 'stale', statusText: t('status.awaitingUpdates'), quiet: false };
    switch (awareness.operational.primary) {
        case 'failed': return { state: 'failed', statusText: t('status.error'), quiet: false };
        case 'action_required': return { state: 'action_required', statusText: t('status.actionRequired'), quiet: false };
        case 'permission_required': return { state: 'permission_required', statusText: t('status.permissionRequired'), quiet: false };
        case 'working': return {
            state: 'thinking',
            statusText: options?.workingLabel ?? t('status.working'),
            quiet: false,
        };
        case 'ready': return { state: 'ready', statusText: t('status.ready'), quiet: false };
        case 'pending_input': return { state: 'pending_input', statusText: t('status.queuedInput'), quiet: false };
        case 'none': return awareness.runtime === 'background_active'
            ? { state: 'background_active', statusText: t('status.backgroundActive'), quiet: false }
            // An idle, reachable Session is not news: the canonical presenter has always kept
            // this one quiet rather than labelling it.
            : { state: 'waiting', statusText: t('status.online'), quiet: true };
    }
}

export function getSessionStatus(session: SessionStatusSource, nowMs: number = Date.now(), options?: GetSessionStatusOptionsInput): SessionStatus {
    const resolvedOptions = resolveGetSessionStatusOptions(options);
    const { vibingIndex, workingTextMode = 'animated', statusColors = DEFAULT_SESSION_STATUS_COLORS } = resolvedOptions;
    const awareness = projectUiSessionAwareness(session, nowMs, {
        ...resolvedOptions,
        hasPendingPermissionRequests: hasPendingPermissionRequests(session),
        hasPendingUserActionRequests: hasPendingUserActionRequests(session),
        pendingRequestObservedAt: latestPendingRequestObservedAt(session),
    });
    const connected = awareness.runtime !== 'offline' && awareness.runtime !== 'unknown';
    const contentReadable = isSessionAwarenessContentReadableV1(awareness.encryption);
    const canAnimate = awareness.freshness === 'live' && contentReadable;
    const idx = typeof vibingIndex === 'number' ? vibingIndex : Math.floor(Math.random() * vibingMessages.length);
    const presented = presentSessionAwarenessV1(awareness, {
        lastSeenAtMs: session.activeAt,
        ...(workingTextMode === 'static'
            ? {}
            : { workingLabel: vibingMessages[idx % vibingMessages.length].toLowerCase() + '…' }),
    });
    const chrome = SESSION_STATE_STATUS_CHROME[presented.state];
    // An archived Session is quiet rather than connected; its lifecycle, not its state
    // vocabulary, is what withholds the live colour.
    const color = awareness.lifecycle === 'archived'
        ? statusColors.default
        : statusColors[chrome.color];
    return {
        awareness,
        state: presented.state,
        statusText: presented.statusText,
        isConnected: chrome.disconnected ? false : connected,
        shouldShowStatus: !presented.quiet,
        statusColor: color,
        statusDotColor: color,
        isPulsing: chrome.pulse && canAnimate,
    };
}

/**
 * Hook wrapper around `getSessionStatus` that keeps vibing text stable while the session is thinking.
 */
export function useSessionStatus(session: SessionStatusSource, options?: UseSessionStatusOptions): SessionStatus;
export function useSessionStatus(session: SessionStatusSource | null, options?: UseSessionStatusOptions): SessionStatus | null;
export function useSessionStatus(session: SessionStatusSource | null, options: UseSessionStatusOptions = {}): SessionStatus | null {
    const { theme } = useUnistyles();
    const sessionId = typeof session?.id === 'string' ? session.id : '';
    const shouldSubscribeToSession = options.subscribeToSession !== false && sessionId.length > 0;
    const rawSession = useSession(shouldSubscribeToSession ? sessionId : '');
    const sessionListWorkingStatusAnimatedTextEnabled = useSetting('sessionListWorkingStatusAnimatedTextEnabled');
    const shouldSubscribeToTranscript = options.subscribeToTranscript !== false && sessionId.length > 0;
    const transcriptVersion = useSessionMessagesVersion(sessionId, shouldSubscribeToTranscript);
    const pendingMessagesState = useSessionPendingMessages(shouldSubscribeToTranscript ? sessionId : '');
    void transcriptVersion;

    const resolvedSession = rawSession ?? session ?? UNBOUND_SESSION_STATUS_SOURCE;
    const isOnline = resolvedSession.presence === "online";
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
    const runtimePresentation = projectUiSessionRuntimeAwareness({
        active: resolvedSession.active,
        activeAt: resolvedSession.activeAt,
        archivedAt: resolvedSession.archivedAt,
        presence: resolvedSession.presence,
        thinking: resolvedSession.thinking,
        thinkingAt: resolvedSession.thinkingAt,
        optimisticThinkingAt: resolvedSession.optimisticThinkingAt ?? optimisticPendingUserMessageAt ?? null,
        hasPendingUserMessages,
        latestTurnStatus: resolvedSession.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: resolvedSession.latestTurnStatusObservedAt ?? null,
        runtimeActivityState: resolvedSession.runtimeActivityState ?? 'unknown',
        runtimeActivityActiveCount: resolvedSession.runtimeActivityActiveCount ?? null,
        runtimeActivityObservedAt: resolvedSession.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: resolvedSession.runtimeActivityRevision ?? null,
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

    if (!session && !rawSession) return null;
    return getSessionStatus(resolvedSession, now, {
        vibingIndex,
        workingTextMode: options.workingTextMode ?? (sessionListWorkingStatusAnimatedTextEnabled === false ? 'static' : 'animated'),
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
        : t('session.access.lockedTitleFallback');
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
export function getSessionName(session: SessionDisplayNameSource, serverId?: string | null): string {
    const summaryText = readSessionDisplayTitleField(session).value;
    const ownerMetadata = readDisplayOwnerMetadata(session);
    if (summaryText) {
        return summaryText;
    }
    if (ownerMetadata?.name) {
        const name = ownerMetadata.name.trim();
        if (name.length > 0) return name;
    }
    if (readSessionDirectoryKind(ownerMetadata) === 'managed') {
        // A no-folder session is not named after its private folder.
        return t('session.folderless.untitledChat');
    }
    if (ownerMetadata) {
        const displayMetadata = ownerMetadata;
        const displayPath = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId)?.basePath
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
 * Generates a deterministic avatar ID from machine ID and path.
 * This ensures the same machine + path combination always gets the same avatar.
 */
export function getSessionAvatarId(session: SessionStatusSource, serverId?: string | null): string {
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
 * Returns the session path for the subtitle.
 */
export function getSessionSubtitle(session: SessionStatusSource, serverId?: string | null): string {
    const ownerMetadata = readDisplayOwnerMetadata(session);
    if (readSessionDirectoryKind(ownerMetadata) === 'managed') {
        // Where a no-folder session runs is its machine; its private folder is not a place to show.
        const machineId = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId)?.machineId ?? ownerMetadata?.machineId;
        const machine = machineId ? storage.getState().machines[machineId] : undefined;
        return getMachineDisplayName(machine) ?? ownerMetadata?.host ?? t('status.unknown');
    }
    const path = readPrivateDisplayMachineTarget(session, ownerMetadata, serverId)?.basePath
        ?? ownerMetadata?.path
        ?? null;
    if (path) {
        return formatPathRelativeToHome(path, ownerMetadata?.homeDir ?? undefined);
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

const vibingMessages = ["Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing", "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing", "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering", "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering", "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting", "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting", "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching", "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating", "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating", "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling"];
