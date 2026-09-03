import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import type {
    PrimaryTurnStatusV1,
    SessionRuntimeActivityState,
    SessionRuntimeIssueV1,
    PendingActivationAuthorizationV1,
} from '@happier-dev/protocol';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromAgentState,
    derivePendingRequestFlagsFromSession,
    type TranscriptRequestStatesCache,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from '@/sync/domains/messages/messageTypes';
import {
    buildTranscriptRenderableAggregate,
    canReuseTranscriptRenderableAggregateRequestStates,
    type TranscriptRenderableAggregate,
} from '@/sync/domains/messages/transcriptRenderableAggregate';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionReadableSeq } from '@/sync/domains/session/readCursor/resolveSessionReadableSeq';
import { countSessionAgentActivityFromMetadata } from '@/sync/domains/session/agentActivity/countSessionAgentActivityFromMetadata';
import type { AgentActivityCounts } from '@/sync/domains/session/agentActivity/deriveAgentActivityCounts';
import { resolveSessionProjectGroupingKeyParts } from './sessionListProjectGroupingKeys';
import { deriveSessionListMeaningfulActivityAt } from './deriveSessionListActivity';
import type { SessionListAttentionPromotionReason } from './attentionPromotion/sessionListAttentionPromotionTypes';
import {
    didSessionListPlacementProjectionDiverge,
    projectSessionListPlacement,
    resolveSessionListUnreadEntryActivityAt,
} from './placement/sessionListPlacementProjection';
import { didSessionListWorkingRetentionInputsChange } from './placement/sessionListWorkingRetention';
import {
    deriveSessionRuntimePresentationState,
    resolveSessionRuntimePresenceFields,
} from '../attention/deriveSessionRuntimePresentationState';

export { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/pending/listPendingSessionRequests';

export interface SessionListRenderableMetadata {
    name?: string;
    summaryText?: string | null;
    path: string;
    homeDir?: string | null;
    host?: string | null;
    machineId?: string | null;
    flavor?: string | null;
    directSessionV1?: {
        v: 1;
        providerId?: string;
    } | null;
    readStateV1?: {
        v: 1;
        sessionSeq: number;
        pendingActivityAt: number;
        updatedAt: number;
    } | null;
    /**
     * What agent work is live in this session, projected once from the published agent-activity
     * headline.
     *
     * It lives on the PROJECTION rather than being read per row because a list row never holds a
     * session's real metadata — only this narrow copy — and a row that had to reach for the full
     * object to draw a number would put an O(sessions) metadata read back on the session list, which
     * is a shape this repository has already measured as a freeze. Projected here it is computed
     * once per metadata version, and it goes stale exactly when the rest of this object does.
     *
     * The whole tally rather than one scalar: the row says the same sentence the composer chip says,
     * and a lone integer is what let the row understate a five-agent workflow as "1 agent working"
     * while the chip named the workflow.
     */
    agentActivityCounts?: AgentActivityCounts;
    hiddenSystemSession?: boolean;
    terminalControlServiceabilityV1?: {
        v: 1;
        attachmentId?: string;
        state: 'servable' | 'recoverable_unservable' | 'unknown';
        observedAt: number;
        reason?: string;
        retired?: boolean;
    } | null;
}

export interface SessionListRenderableSession {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    meaningfulActivityAt?: number | null;
    active: boolean;
    activeAt: number;
    archivedAt?: number | null;
    pendingVersion?: number;
    pendingCount?: number;
    pendingBlockedCount?: number;
    pendingActivationAuthorization?: PendingActivationAuthorizationV1 | null;
    lastViewedSessionSeq?: number | null;
    metadataVersion: number;
    agentStateVersion: number;
    metadata: SessionListRenderableMetadata | null;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    runtimeActivityState?: SessionRuntimeActivityState | null;
    runtimeActivityActiveCount?: number;
    runtimeActivityObservedAt?: number | null;
    runtimeActivityRevision?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    rollbackEligibleTurnStarts?: readonly number[] | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    optimisticThinkingAt?: number | null;
    resumingAt?: number | null;
    thinkingGraceUntil?: number | null;
    owner?: string;
    accessLevel?: 'view' | 'edit' | 'admin';
    canApprovePermissions?: boolean;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    pendingRequestObservedAt?: number | null;
    hasUnreadMessages?: boolean;
    /**
     * When this session entered its current unread state. Stable for as long
     * as the session stays unread, so the attention lane can order unread rows
     * without re-sorting on every incoming message. Server-materialized when
     * the server reports it; otherwise stamped once by the merge owner
     * (`resolveSessionListRenderableUnreadSince`). Always null when read.
     */
    unreadSince?: number | null;
    keepVisibleWhenInactive?: boolean;
    metadataUnavailable?: boolean;
}

export type SessionListRenderablePatchFields = Readonly<Partial<Omit<SessionListRenderableSession, 'id'>>>;

type DirectSessionRenderableMetadata = NonNullable<SessionListRenderableMetadata['directSessionV1']>;
type ReadStateRenderableMetadata = NonNullable<SessionListRenderableMetadata['readStateV1']>;

function normalizeLastViewedSessionSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function deriveSessionListRenderableHasUnreadMessagesFromSession(
    session: Pick<Session, 'seq' | 'metadata' | 'lastViewedSessionSeq'>
        & Partial<Pick<Session, 'latestTurnStatus' | 'latestReadyEventSeq'>>,
    messages?: ReadonlyArray<Message>,
    transcriptAggregate?: TranscriptRenderableAggregate | null,
): boolean {
    return deriveSessionListRenderableHasUnreadMessagesFromReadableSeq(
        session,
        resolveSessionListReadableSeq(session, messages, transcriptAggregate),
    );
}

export function deriveSessionListRenderableHasUnreadMessagesFromReadableSeq(
    session: Pick<Session, 'metadata' | 'lastViewedSessionSeq'>,
    readableSeq: number,
): boolean {
    return computeHasUnreadActivity({
        sessionSeq: readableSeq,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
    });
}

/**
 * Work still open in this session — the same tally the session header's glyph, the composer chip
 * and the Agents tab badge read. One counter, one grouping rule, one description (R-8).
 *
 * An agent stopped on a permission prompt is open work and is already inside `live`, so there is no
 * second tally to add here and no way for the two to drift.
 */
function readAgentActivityCounts(metadata: Metadata): AgentActivityCounts {
    return countSessionAgentActivityFromMetadata(metadata);
}

export function buildSessionListRenderableMetadata(metadata: Metadata | null | undefined): SessionListRenderableMetadata | null {
    if (!metadata) return null;
    const directSessionV1 = (() : DirectSessionRenderableMetadata | null => {
        const candidate = metadata.directSessionV1;
        if (!candidate || typeof candidate !== 'object') return null;
        if (!('v' in candidate) || candidate.v !== 1) return null;
        return {
            v: 1,
            ...('providerId' in candidate && typeof candidate.providerId === 'string'
                ? { providerId: candidate.providerId }
            : {}),
        };
    })();
    const readStateV1 = (() : ReadStateRenderableMetadata | null => {
        const candidate = metadata.readStateV1;
        if (!candidate || typeof candidate !== 'object') return null;
        if (!('v' in candidate) || candidate.v !== 1) return null;
        const { sessionSeq, pendingActivityAt, updatedAt } = candidate;
        if (
            typeof sessionSeq !== 'number'
            || !Number.isFinite(sessionSeq)
            || typeof pendingActivityAt !== 'number'
            || !Number.isFinite(pendingActivityAt)
            || typeof updatedAt !== 'number'
            || !Number.isFinite(updatedAt)
        ) {
            return null;
        }
        return {
            v: 1,
            sessionSeq: Math.max(0, Math.trunc(sessionSeq)),
            pendingActivityAt: Math.max(0, Math.trunc(pendingActivityAt)),
            updatedAt,
        };
    })();
    return {
        name: typeof metadata.name === 'string' ? metadata.name : undefined,
        summaryText: typeof metadata.summary?.text === 'string' ? metadata.summary.text : null,
        path: typeof metadata.path === 'string' ? metadata.path : '',
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        machineId: typeof metadata.machineId === 'string' ? metadata.machineId : null,
        flavor: typeof metadata.flavor === 'string' ? metadata.flavor : null,
        directSessionV1,
        readStateV1,
        agentActivityCounts: readAgentActivityCounts(metadata),
        hiddenSystemSession: metadata.systemSessionV1?.hidden === true,
        terminalControlServiceabilityV1: metadata.terminal?.controlServiceabilityV1 ?? null,
    };
}

export function buildSessionListRenderableFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
    transcriptAggregate?: TranscriptRenderableAggregate | null,
): SessionListRenderableSession {
    // Single derivation path: the transcript folds live in the aggregate.
    // Hot callers (streaming applyMessages) pass an incrementally-maintained
    // aggregate; cold callers pass messages and pay one full walk here.
    const completedRequests = (session.agentState?.completedRequests as Record<string, unknown> | null | undefined) ?? null;
    const aggregate = (() => {
        if (transcriptAggregate && canReuseTranscriptRenderableAggregateRequestStates(transcriptAggregate, completedRequests)) {
            return transcriptAggregate;
        }
        if (Array.isArray(messages)) {
            return buildTranscriptRenderableAggregate({ messages, completedRequests });
        }
        return null;
    })();
    const statesCache: TranscriptRequestStatesCache = aggregate ? { states: aggregate.requestStates } : {};
    const pending = derivePendingRequestFlagsFromSession(session, messages, statesCache);
    const latestCommittedMessageCreatedAt = aggregate ? aggregate.latestCommittedMessageCreatedAt : null;
    const latestTurnStatus = readSessionLatestTurnStatus(session);
    const latestTurnStatusObservedAt = readSessionNumericField(session, 'latestTurnStatusObservedAt');
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus,
        latestTurnStatusObservedAt,
    });
    const meaningfulActivityAt = deriveSessionListMeaningfulActivityAt({
        sessionCreatedAt: session.createdAt,
        sessionMeaningfulActivityAt: session.meaningfulActivityAt ?? null,
        latestCommittedMessageCreatedAt,
        latestThinkingActivityAt: null,
        latestPendingMessageCreatedAt: null,
    });
    const hasUnreadMessages = deriveSessionListRenderableHasUnreadMessagesFromSession(session, messages, aggregate);
    return {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        meaningfulActivityAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        pendingBlockedCount: session.pendingBlockedCount,
        pendingActivationAuthorization: session.pendingActivationAuthorization ?? null,
        lastViewedSessionSeq: normalizeLastViewedSessionSeq(session.lastViewedSessionSeq),
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        metadata: buildSessionListRenderableMetadata(session.metadata),
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        presence: session.presence,
        latestTurnId: readSessionLatestTurnId(session),
        latestTurnStatus,
        latestTurnStatusObservedAt,
        runtimeActivityState: session.runtimeActivityState ?? null,
        runtimeActivityActiveCount: session.runtimeActivityActiveCount,
        runtimeActivityObservedAt: session.runtimeActivityObservedAt ?? null,
        runtimeActivityRevision: session.runtimeActivityRevision ?? null,
        lastRuntimeIssue: readSessionLastRuntimeIssue(session),
        rollbackEligibleTurnStarts: readRollbackEligibleTurnStarts(session.rollbackEligibleTurnStarts),
        latestReadyEventSeq: readSessionNumericField(session, 'latestReadyEventSeq'),
        latestReadyEventAt: readSessionNumericField(session, 'latestReadyEventAt'),
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        resumingAt: session.resumingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner,
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(session, messages, statesCache),
        hasUnreadMessages,
        // Server-materialized entry fact only, never a client guess: a built
        // renderable carrying a value is what tells the merge owner it holds an
        // authoritative one. Stamping the fallback here would make an older
        // server's rows indistinguishable from a materialized value, and the
        // fallback would then re-derive itself from moving activity on every
        // message. The merge owner stamps it once instead.
        unreadSince: hasUnreadMessages ? readSessionNumericField(session, 'unreadSince') : null,
    };
}

/**
 * Single owner of the unread entry fact across every renderable ingestion
 * path. Unread membership is a boolean edge: while a session stays unread its
 * entry time must not move, otherwise the attention lane re-sorts and the
 * committed session list is invalidated on every incoming message.
 *
 * Precedence: the server-materialized value on the incoming row wins, because
 * it is the only value that is the same on every device and across boots. It
 * is stable by construction (stamped at the read -> unread edge, cleared on
 * the way back), so preferring it cannot move the row while it stays unread.
 * Only when the server supplies none — an older server, or a warm row that has
 * not met the network yet — does the row keep the stamp it already carries,
 * and only a row with no stamp at all gets a fresh one.
 */
function resolveSessionListRenderableUnreadSince(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): number | null {
    if (next.hasUnreadMessages !== true) return null;
    const incoming = normalizeUnreadSince(next.unreadSince);
    if (incoming !== null) return incoming;
    if (previous?.hasUnreadMessages === true) {
        const carried = normalizeUnreadSince(previous.unreadSince);
        if (carried !== null) return carried;
        // The row was already unread but predates the entry fact (raw
        // warm-cache rehydration): adopt ITS activity time so the row keeps
        // the exact position it is already rendered at.
        const previousEntryActivityAt = resolveSessionListUnreadEntryActivityAt(previous);
        if (previousEntryActivityAt !== null) return previousEntryActivityAt;
    }
    // Read -> unread edge (or a row with no usable history): stamp once from the
    // incoming activity time. `next.unreadSince` is provably absent here, so the
    // only remaining source is the activity fallback.
    return resolveSessionListUnreadEntryActivityAt(next);
}

function normalizeUnreadSince(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function preserveSessionListRenderableTransientState(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    return {
        ...next,
        keepVisibleWhenInactive: previous?.keepVisibleWhenInactive === true,
        unreadSince: resolveSessionListRenderableUnreadSince(previous, next),
    };
}

function shouldPreserveSessionListRenderablePendingFlags(
    next: SessionListRenderableSession,
    previous: SessionListRenderableSession | undefined,
): previous is SessionListRenderableSession {
    return Boolean(
        previous
        && next.active === true
        && typeof next.hasPendingPermissionRequests !== 'boolean'
        && typeof next.hasPendingUserActionRequests !== 'boolean'
        && (
            typeof previous.hasPendingPermissionRequests === 'boolean'
            || typeof previous.hasPendingUserActionRequests === 'boolean'
        ),
    );
}

export function preserveSessionListRenderableStaleFields(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    // A projection pass re-derives every renderable, so an unchanged session still arrives as a
    // fresh object. Handing that object on defeats identity all the way up the session list: the
    // row is rebuilt around it, then the array, then the whole list re-renders. Returning the
    // previous renderable when nothing changed is what keeps those reuse checks working — measured
    // on an idle list, ~4000 field-identical rebuilds per 12s, 99.8% of which changed nothing.
    // `areSessionListRenderablesEqual` is the canonical full-field comparison (it already covers
    // seq, timestamps and metadata contents), so this adds no second notion of "unchanged".
    if (previous && areSessionListRenderablesEqual(previous, next)) return previous;

    const preserveMetadata = next.metadata == null && previous?.metadata != null;
    const preserveMetadataUnavailable =
        !preserveMetadata
        && next.metadata == null
        && previous?.metadata == null
        && previous?.metadataUnavailable === true;
    const preservePendingFlags = shouldPreserveSessionListRenderablePendingFlags(next, previous);
    const preserveDirectSessionClassification =
        previous?.metadata?.directSessionV1 != null
        && next.metadata != null
        && next.metadata.directSessionV1 == null
        && previous.metadataVersion === next.metadataVersion;

    if (
        previous == null
        || (!preserveMetadata && !preserveMetadataUnavailable && !preservePendingFlags && !preserveDirectSessionClassification)
    ) {
        return next;
    }

    const nextMetadata = preserveMetadata
        ? previous.metadata
        : preserveDirectSessionClassification
            ? {
                ...(next.metadata as SessionListRenderableMetadata),
                directSessionV1: previous.metadata?.directSessionV1 ?? null,
            }
            : next.metadata;

    return {
        ...next,
        metadataVersion: preserveMetadata ? previous.metadataVersion : next.metadataVersion,
        agentStateVersion: preservePendingFlags ? previous.agentStateVersion : next.agentStateVersion,
        metadata: nextMetadata,
        metadataUnavailable: preserveMetadata
            ? false
            : preserveMetadataUnavailable
                ? true
                : next.metadataUnavailable,
        hasPendingPermissionRequests: preservePendingFlags
            ? previous.hasPendingPermissionRequests
            : next.hasPendingPermissionRequests,
        hasPendingUserActionRequests: preservePendingFlags
            ? previous.hasPendingUserActionRequests
            : next.hasPendingUserActionRequests,
        pendingRequestObservedAt: preservePendingFlags
            ? previous.pendingRequestObservedAt ?? null
            : next.pendingRequestObservedAt ?? null,
    };
}

function areSessionListRenderableMetadataEqual(
    previous: SessionListRenderableMetadata | null | undefined,
    next: SessionListRenderableMetadata | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;

    return (previous.name ?? null) === (next.name ?? null)
        && (previous.summaryText ?? null) === (next.summaryText ?? null)
        && previous.path === next.path
        && (previous.homeDir ?? null) === (next.homeDir ?? null)
        && (previous.host ?? null) === (next.host ?? null)
        && (previous.machineId ?? null) === (next.machineId ?? null)
        && (previous.flavor ?? null) === (next.flavor ?? null)
        && (previous.directSessionV1?.v ?? null) === (next.directSessionV1?.v ?? null)
        && (previous.directSessionV1?.providerId ?? null) === (next.directSessionV1?.providerId ?? null)
        && (previous.readStateV1?.v ?? null) === (next.readStateV1?.v ?? null)
        && (previous.readStateV1?.sessionSeq ?? null) === (next.readStateV1?.sessionSeq ?? null)
        && (previous.readStateV1?.pendingActivityAt ?? null) === (next.readStateV1?.pendingActivityAt ?? null)
        && (previous.readStateV1?.updatedAt ?? null) === (next.readStateV1?.updatedAt ?? null)
        && (previous.hiddenSystemSession === true) === (next.hiddenSystemSession === true);
}

export function areSessionListRenderablesEqual(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;

    return previous.id === next.id
        && previous.seq === next.seq
        && previous.createdAt === next.createdAt
        && previous.updatedAt === next.updatedAt
        && (previous.meaningfulActivityAt ?? null) === (next.meaningfulActivityAt ?? null)
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.archivedAt ?? null) === (next.archivedAt ?? null)
        && (previous.pendingVersion ?? null) === (next.pendingVersion ?? null)
        && (previous.pendingCount ?? null) === (next.pendingCount ?? null)
        && (previous.pendingBlockedCount ?? null) === (next.pendingBlockedCount ?? null)
        && (previous.lastViewedSessionSeq ?? null) === (next.lastViewedSessionSeq ?? null)
        && previous.metadataVersion === next.metadataVersion
        && previous.agentStateVersion === next.agentStateVersion
        && previous.thinking === next.thinking
        && previous.thinkingAt === next.thinkingAt
        && previous.presence === next.presence
        && (previous.latestTurnId ?? null) === (next.latestTurnId ?? null)
        && (previous.latestTurnStatus ?? null) === (next.latestTurnStatus ?? null)
        && (previous.latestTurnStatusObservedAt ?? null) === (next.latestTurnStatusObservedAt ?? null)
        && (previous.runtimeActivityState ?? null) === (next.runtimeActivityState ?? null)
        && (previous.runtimeActivityActiveCount ?? null) === (next.runtimeActivityActiveCount ?? null)
        && (previous.runtimeActivityObservedAt ?? null) === (next.runtimeActivityObservedAt ?? null)
        && (previous.runtimeActivityRevision ?? null) === (next.runtimeActivityRevision ?? null)
        && areSessionRuntimeIssuesEqual(previous.lastRuntimeIssue ?? null, next.lastRuntimeIssue ?? null)
        && areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)
        && (previous.latestReadyEventSeq ?? null) === (next.latestReadyEventSeq ?? null)
        && (previous.latestReadyEventAt ?? null) === (next.latestReadyEventAt ?? null)
        && (previous.optimisticThinkingAt ?? null) === (next.optimisticThinkingAt ?? null)
        && (previous.resumingAt ?? null) === (next.resumingAt ?? null)
        && (previous.thinkingGraceUntil ?? null) === (next.thinkingGraceUntil ?? null)
        && (previous.owner ?? null) === (next.owner ?? null)
        && (previous.accessLevel ?? null) === (next.accessLevel ?? null)
        && (previous.canApprovePermissions ?? null) === (next.canApprovePermissions ?? null)
        && (previous.hasPendingPermissionRequests ?? null) === (next.hasPendingPermissionRequests ?? null)
        && (previous.hasPendingUserActionRequests ?? null) === (next.hasPendingUserActionRequests ?? null)
        && (previous.pendingRequestObservedAt ?? null) === (next.pendingRequestObservedAt ?? null)
        && (previous.hasUnreadMessages === true) === (next.hasUnreadMessages === true)
        && (previous.unreadSince ?? null) === (next.unreadSince ?? null)
        && (previous.keepVisibleWhenInactive === true) === (next.keepVisibleWhenInactive === true)
        && (previous.metadataUnavailable === true) === (next.metadataUnavailable === true)
        && areSessionListRenderableMetadataEqual(previous.metadata, next.metadata);
}

export function applySessionListRenderablePatch(
    renderable: SessionListRenderableSession,
    patch: SessionListRenderablePatchFields,
): SessionListRenderableSession {
    const patched = {
        ...renderable,
        ...patch,
        id: renderable.id,
    };
    // Streaming patches carry whole freshly-built renderables whose unread
    // entry fact is re-stamped from the latest activity; keep the row's
    // existing entry time so an unread row does not move on every message.
    patched.unreadSince = resolveSessionListRenderableUnreadSince(renderable, patched);
    return patched;
}

export function isSessionListRenderablePatchNoop(
    renderable: SessionListRenderableSession,
    patch: SessionListRenderablePatchFields,
): boolean {
    return areSessionListRenderablesEqual(
        renderable,
        applySessionListRenderablePatch(renderable, patch),
    );
}

function readSessionLatestTurnId(session: Session): string | null {
    const value = (session as { latestTurnId?: unknown }).latestTurnId;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readSessionLatestTurnStatus(session: Session): PrimaryTurnStatusV1 | null {
    const value = (session as { latestTurnStatus?: unknown }).latestTurnStatus;
    return value === 'in_progress' || value === 'completed' || value === 'cancelled' || value === 'failed'
        ? value
        : null;
}

export function readRollbackEligibleTurnStarts(value: unknown): readonly number[] | null {
    if (!Array.isArray(value)) return null;
    const starts: number[] = [];
    for (const entry of value) {
        if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
        const seq = Math.trunc(entry);
        if (seq < 0 || starts.includes(seq)) continue;
        starts.push(seq);
    }
    return starts;
}

function resolveSessionListReadableSeq(
    session: Pick<Session, 'seq'> & Partial<Pick<Session, 'latestTurnStatus' | 'latestReadyEventSeq'>>,
    messages: ReadonlyArray<Message> | undefined,
    transcriptAggregate?: TranscriptRenderableAggregate | null,
): number {
    return resolveSessionReadableSeq({
        messages: messages ?? null,
        messagesProjection: transcriptAggregate
            ? {
                hasMessages: transcriptAggregate.messageCount > 0,
                latestUnreadAffectingMessageSeq: transcriptAggregate.latestUnreadAffectingMessageSeq,
            }
            : null,
        sessionSeq: session.seq,
        latestReadyEventSeq: session.latestReadyEventSeq,
        latestTurnStatus: session.latestTurnStatus,
        includeTerminalSessionSeq: true,
    }) ?? 0;
}

function readSessionLastRuntimeIssue(session: Session): SessionRuntimeIssueV1 | null {
    const value = (session as { lastRuntimeIssue?: unknown }).lastRuntimeIssue;
    return isSessionRuntimeIssueV1(value) ? value : null;
}

function readSessionNumericField(
    session: Session,
    key: 'latestReadyEventSeq' | 'latestReadyEventAt' | 'latestTurnStatusObservedAt' | 'unreadSince',
): number | null {
    const value = (session as unknown as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : null;
}

function isSessionRuntimeIssueV1(value: unknown): value is SessionRuntimeIssueV1 {
    if (value == null || typeof value !== 'object') return false;
    const issue = value as Partial<SessionRuntimeIssueV1>;
    return issue.v === 1
        && issue.scope === 'primary_session'
        && issue.status === 'failed'
        && typeof issue.code === 'string'
        && typeof issue.source === 'string'
        && typeof issue.occurredAt === 'number';
}

function areSessionRuntimeIssuesEqual(
    previous: SessionRuntimeIssueV1 | null,
    next: SessionRuntimeIssueV1 | null,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    return previous.v === next.v
        && previous.scope === next.scope
        && previous.status === next.status
        && previous.code === next.code
        && previous.source === next.source
        && previous.occurredAt === next.occurredAt
        && (previous.sessionSeq ?? null) === (next.sessionSeq ?? null)
        && (previous.provider ?? null) === (next.provider ?? null)
        && (previous.providerTurnId ?? null) === (next.providerTurnId ?? null)
        && (previous.sanitizedPreview ?? null) === (next.sanitizedPreview ?? null);
}

type SessionListRenderableAttentionPromotionPlacement = Readonly<{
    kind: 'none' | 'working' | SessionListAttentionPromotionReason;
    timestamp: number | null;
}>;

export function resolveSessionListRenderableAttentionPromotionPlacement(
    session: SessionListRenderableSession,
    nowMs: number = Date.now(),
): SessionListRenderableAttentionPromotionPlacement {
    const projection = projectSessionListPlacement({ session, nowMs });
    return {
        kind: projection.kind,
        timestamp: projection.timestamp,
    };
}

export function didSessionListRenderableStructuralFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;

    return false;
}

export function didSessionListRenderableEmbeddedListRowFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    // High-churn status, pending, unread, and turn-state fields are owned by
    // row-store overlays. Keep embedded list data structural/identity-focused
    // so live streaming does not republish the whole list array.
    if ((previous.metadataUnavailable === true) !== (next.metadataUnavailable === true)) return true;
    if (!areSessionListRenderableMetadataEqual(previous.metadata, next.metadata)) return true;

    return false;
}

export function didSessionListRenderableAttentionPromotionFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
    nowMs: number = Date.now(),
): boolean {
    if (!previous) return true;
    if (didSessionListRenderableRetainedWorkingInvalidationFieldsChange(previous, next)) return true;
    const previousPlacement = resolveSessionListRenderableAttentionPromotionPlacement(previous, nowMs);
    const nextPlacement = resolveSessionListRenderableAttentionPromotionPlacement(next, nowMs);
    return previousPlacement.kind !== nextPlacement.kind
        || previousPlacement.timestamp !== nextPlacement.timestamp;
}

/**
 * Changes that do not move the placement at this instant but WILL change how
 * placement evaluates at a future freshness boundary (extended working
 * windows, refreshed retention inputs). These must not trigger the expensive
 * structural rebuild, but the committed view data has to pick up the fresh
 * session object through the row-refresh channel — otherwise the UI later
 * re-evaluates placement against stale timestamps and, e.g., demotes a
 * still-working session at the stale expiry while its row shows the spinner.
 */
export function didSessionListRenderablePlacementRelevantTimingChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
    nowMs: number = Date.now(),
): boolean {
    if (!previous) return false;
    if (didSessionListRenderableWorkingRetentionInputFieldsChange(previous, next)) return true;
    return didSessionListPlacementProjectionDiverge({ previous, next, nowMs });
}

function didSessionListRenderableRetainedWorkingInvalidationFieldsChange(
    previous: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    if (!isRetainableWorkingProjectionCandidate(previous)) {
        return false;
    }
    return !isRetainableWorkingProjectionCandidate(next);
}

/**
 * Working RETENTION (the 'keep in working group while signals are stale'
 * projection) depends on the UI layer's retained-key set, which is not
 * available at store-commit time, so the placement divergence walk evaluates
 * with retention disabled. Compensate with the canonical retention-input
 * comparison (owned by sessionListWorkingRetention.ts, next to the functions
 * that read those fields), scoped to retainable candidates so ordinary
 * sessions do not pay row refreshes for these high-churn timestamps.
 */
function didSessionListRenderableWorkingRetentionInputFieldsChange(
    previous: SessionListRenderableSession,
    next: SessionListRenderableSession,
): boolean {
    if (!isRetainableWorkingProjectionCandidate(previous) && !isRetainableWorkingProjectionCandidate(next)) {
        return false;
    }
    return didSessionListWorkingRetentionInputsChange(previous, next);
}

function isRetainableWorkingProjectionCandidate(session: SessionListRenderableSession): boolean {
    return session.archivedAt == null
        && session.active === true
        && session.presence === 'online'
        && session.latestTurnStatus === 'in_progress';
}

export function didSessionListRenderableProjectGroupingFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    const prevParts = resolveSessionProjectGroupingKeyParts(prevMeta ?? null);
    const nextParts = resolveSessionProjectGroupingKeyParts(nextMeta ?? null);

    if (prevParts.pathKey !== nextParts.pathKey) return true;
    if (prevParts.machineGroupId !== nextParts.machineGroupId) return true;

    return false;
}

function hasExplicitActiveReachabilityTarget(session: SessionListRenderableSession): boolean {
    return session.active === true
        && String(session.metadata?.machineId ?? '').trim().length > 0
        && String(session.metadata?.path ?? '').trim().length > 0;
}

export function didSessionListRenderableReachabilityPeerFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (
        previous.metadataVersion !== next.metadataVersion
        && (!hasExplicitActiveReachabilityTarget(previous) || !hasExplicitActiveReachabilityTarget(next))
    ) {
        return true;
    }

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;

    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.host ?? '') !== String(nextMeta?.host ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;

    return false;
}

export function didSessionListRenderableWarmCacheFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.seq !== next.seq) return true;
    if (previous.updatedAt !== next.updatedAt) return true;
    if ((previous.meaningfulActivityAt ?? null) !== (next.meaningfulActivityAt ?? null)) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if (previous.active !== next.active) return true;
    if (previous.activeAt !== next.activeAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.lastViewedSessionSeq ?? null) !== (next.lastViewedSessionSeq ?? null)) return true;
    if ((previous.pendingCount ?? null) !== (next.pendingCount ?? null)) return true;
    if ((previous.pendingBlockedCount ?? null) !== (next.pendingBlockedCount ?? null)) return true;
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return true;
    if ((previous.latestTurnId ?? null) !== (next.latestTurnId ?? null)) return true;
    if ((previous.latestTurnStatus ?? null) !== (next.latestTurnStatus ?? null)) return true;
    if ((previous.latestTurnStatusObservedAt ?? null) !== (next.latestTurnStatusObservedAt ?? null)) return true;
    if ((previous.runtimeActivityState ?? null) !== (next.runtimeActivityState ?? null)) return true;
    if ((previous.runtimeActivityActiveCount ?? null) !== (next.runtimeActivityActiveCount ?? null)) return true;
    if ((previous.runtimeActivityObservedAt ?? null) !== (next.runtimeActivityObservedAt ?? null)) return true;
    if ((previous.runtimeActivityRevision ?? null) !== (next.runtimeActivityRevision ?? null)) return true;
    if (!areSessionRuntimeIssuesEqual(previous.lastRuntimeIssue ?? null, next.lastRuntimeIssue ?? null)) return true;
    if (!areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)) return true;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return true;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return true;
    if ((previous.accessLevel ?? null) !== (next.accessLevel ?? null)) return true;
    if ((previous.canApprovePermissions ?? null) !== (next.canApprovePermissions ?? null)) return true;
    if (previous.metadataVersion !== next.metadataVersion) return true;
    if (previous.agentStateVersion !== next.agentStateVersion) return true;
    if ((previous.pendingRequestObservedAt ?? null) !== (next.pendingRequestObservedAt ?? null)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;
    if ((prevMeta?.name ?? null) !== (nextMeta?.name ?? null)) return true;
    if ((prevMeta?.summaryText ?? null) !== (nextMeta?.summaryText ?? null)) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if ((prevMeta?.homeDir ?? null) !== (nextMeta?.homeDir ?? null)) return true;
    if ((prevMeta?.host ?? null) !== (nextMeta?.host ?? null)) return true;
    if ((prevMeta?.machineId ?? null) !== (nextMeta?.machineId ?? null)) return true;
    if ((prevMeta?.flavor ?? null) !== (nextMeta?.flavor ?? null)) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;
    if ((prevMeta?.directSessionV1?.v ?? null) !== (nextMeta?.directSessionV1?.v ?? null)) return true;
    if ((prevMeta?.directSessionV1?.providerId ?? null) !== (nextMeta?.directSessionV1?.providerId ?? null)) return true;

    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return true;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return true;
    if ((previous.hasUnreadMessages === true) !== (next.hasUnreadMessages === true)) return true;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return true;

    return false;
}

export function isSessionListRenderableWarmCacheProgressOnlyChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    if (previous.active !== true || next.active !== true) return false;
    if (previous.active !== next.active) return false;
    if (previous.createdAt !== next.createdAt) return false;
    if (previous.presence !== next.presence) return false;
    if (previous.thinking !== next.thinking) return false;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return false;
    if ((previous.pendingCount ?? null) !== (next.pendingCount ?? null)) return false;
    if ((previous.pendingBlockedCount ?? null) !== (next.pendingBlockedCount ?? null)) return false;
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return false;
    if ((previous.lastViewedSessionSeq ?? null) !== (next.lastViewedSessionSeq ?? null)) return false;
    if ((previous.latestTurnId ?? null) !== (next.latestTurnId ?? null)) return false;
    if ((previous.latestTurnStatus ?? null) !== (next.latestTurnStatus ?? null)) return false;
    if ((previous.latestTurnStatusObservedAt ?? null) !== (next.latestTurnStatusObservedAt ?? null)) return false;
    if ((previous.runtimeActivityState ?? null) !== (next.runtimeActivityState ?? null)) return false;
    if ((previous.runtimeActivityActiveCount ?? null) !== (next.runtimeActivityActiveCount ?? null)) return false;
    if ((previous.runtimeActivityObservedAt ?? null) !== (next.runtimeActivityObservedAt ?? null)) return false;
    if ((previous.runtimeActivityRevision ?? null) !== (next.runtimeActivityRevision ?? null)) return false;
    if (!areSessionRuntimeIssuesEqual(previous.lastRuntimeIssue ?? null, next.lastRuntimeIssue ?? null)) return false;
    if (!areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)) return false;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return false;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return false;
    if (previous.metadataVersion !== next.metadataVersion) return false;
    if (previous.agentStateVersion !== next.agentStateVersion) return false;
    if ((previous.accessLevel ?? null) !== (next.accessLevel ?? null)) return false;
    if ((previous.canApprovePermissions ?? null) !== (next.canApprovePermissions ?? null)) return false;
    if ((previous.pendingRequestObservedAt ?? null) !== (next.pendingRequestObservedAt ?? null)) return false;
    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return false;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return false;
    if ((previous.hasUnreadMessages === true) !== (next.hasUnreadMessages === true)) return false;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return false;
    if (!areSessionListRenderableMetadataEqual(previous.metadata, next.metadata)) return false;

    return previous.seq !== next.seq
        || previous.updatedAt !== next.updatedAt
        || (previous.meaningfulActivityAt ?? null) !== (next.meaningfulActivityAt ?? null)
        || previous.activeAt !== next.activeAt;
}


function areRollbackEligibleTurnStartsEqual(
    previous: readonly number[] | null | undefined,
    next: readonly number[] | null | undefined,
): boolean {
    if (previous === next) return true;
    const previousStarts = previous ?? [];
    const nextStarts = next ?? [];
    if (previousStarts.length !== nextStarts.length) return false;
    for (let index = 0; index < previousStarts.length; index += 1) {
        if (previousStarts[index] !== nextStarts[index]) return false;
    }
    return true;
}
