import type { AgentState, Metadata, Session } from '@/sync/domains/state/storageTypes';
import type { PrimaryTurnStatusV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { deriveExternalSessionAttentionHasUnread } from '@/sync/domains/session/external/readExternalSessionAttention';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromAgentState,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionProjectGroupingKeyParts } from './sessionListProjectGroupingKeys';
import {
    areSessionListRenderableMetadataComparisonsEqual,
    readSessionListRenderableMetadataComparison,
    readSessionListRenderableMetadataComparisonFromRenderable,
} from './sessionListRenderableMetadataComparison';
import { deriveSessionListMeaningfulActivityAt } from './deriveSessionListActivity';
import { resolveSessionRuntimePresenceFields } from '../attention/runtimePresentation';

export { derivePendingRequestFlagsFromAgentState } from '@/sync/domains/session/pending/listPendingSessionRequests';

export interface SessionListRenderableMetadata {
    name?: string;
    summaryText?: string | null;
    path: string;
    homeDir?: string | null;
    host?: string | null;
    machineId?: string | null;
    flavor?: string | null;
    externalSessionV1?: {
        v: 1;
        providerId?: string;
    } | null;
    readStateV1?: {
        v: 1;
        sessionSeq: number;
        pendingActivityAt: number;
        updatedAt: number;
    } | null;
    hiddenSystemSession?: boolean;
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
    lastViewedSessionSeq?: number | null;
    latestTurnId?: string | null;
    latestTurnStatus?: PrimaryTurnStatusV1 | null;
    latestTurnStatusObservedAt?: number | null;
    rollbackEligibleTurnStarts?: readonly number[] | null;
    latestReadyEventSeq?: number | null;
    latestReadyEventAt?: number | null;
    lastRuntimeIssue?: SessionRuntimeIssueV1 | null;
    lastTurnCompletedAt?: number | null;
    metadataVersion: number;
    agentStateVersion: number;
    metadata: SessionListRenderableMetadata | null;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number;
    optimisticThinkingAt?: number | null;
    thinkingGraceUntil?: number | null;
    owner?: string;
    accessLevel?: 'view' | 'edit' | 'admin';
    canApprovePermissions?: boolean;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
    pendingRequestObservedAt?: number | null;
    hasUnreadMessages?: boolean;
    keepVisibleWhenInactive?: boolean;
    metadataUnavailable?: boolean;
}

export type SessionListRenderableFieldSnapshot = Readonly<{
    active: boolean;
    createdAt: number;
    updatedAt: number;
    meaningfulActivityAt: number | null;
    activeAt: number;
    archivedAt: number | null;
    pendingVersion: number | null;
    pendingCount: number | null;
    lastViewedSessionSeq: number | null;
    metadataVersion: number;
    agentStateVersion: number;
    accessLevel: SessionListRenderableSession['accessLevel'] | null;
    canApprovePermissions: boolean | null;
    hasPendingPermissionRequests: boolean | null;
    hasPendingUserActionRequests: boolean | null;
    pendingRequestObservedAt: number | null;
    keepVisibleWhenInactive: boolean;
    metadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable>;
}>;

export type SessionListReadableActivitySummary = Readonly<{
    latestCommittedMessageSeq: number | null;
    latestCommittedMessageCreatedAt: number | null;
}>;

type SessionListRenderableStaleFieldSource = Readonly<{
    active?: boolean;
    agentState?: AgentState | null | undefined;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
}>;

export function summarizeSessionListReadableActivityFromMessageRecords(
    messageIds: ReadonlyArray<string> | undefined,
    messagesById: Readonly<Record<string, Pick<Message, 'seq' | 'createdAt'> | undefined>> | null | undefined,
): SessionListReadableActivitySummary | undefined {
    if (!Array.isArray(messageIds)) return undefined;

    let latestCommittedMessageSeq: number | null = null;
    let latestCommittedMessageCreatedAt: number | null = null;
    for (const messageId of messageIds) {
        const message = messagesById?.[messageId];
        if (!message) continue;
        latestCommittedMessageSeq = maxReadSeq(latestCommittedMessageSeq, normalizeReadSeq(message.seq));
        latestCommittedMessageCreatedAt = maxReadSeq(latestCommittedMessageCreatedAt, normalizeReadSeq(message.createdAt));
    }

    return {
        latestCommittedMessageSeq,
        latestCommittedMessageCreatedAt,
    };
}

function summarizeSessionListReadableActivityFromMessages(
    messages: ReadonlyArray<Message> | undefined,
): SessionListReadableActivitySummary | undefined {
    if (!messages) return undefined;

    let latestCommittedMessageSeq: number | null = null;
    let latestCommittedMessageCreatedAt: number | null = null;
    for (const message of messages) {
        latestCommittedMessageSeq = maxReadSeq(latestCommittedMessageSeq, normalizeReadSeq(message.seq));
        latestCommittedMessageCreatedAt = maxReadSeq(latestCommittedMessageCreatedAt, normalizeReadSeq(message.createdAt));
    }

    return {
        latestCommittedMessageSeq,
        latestCommittedMessageCreatedAt,
    };
}

function normalizeLastViewedSessionSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function normalizeReadyEventAt(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : null;
}

function normalizeRollbackEligibleTurnStarts(value: readonly number[] | null | undefined): readonly number[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const normalized = value
        .filter((item) => typeof item === 'number' && Number.isFinite(item))
        .map((item) => Math.max(0, Math.trunc(item)));
    return normalized.length > 0 ? normalized : undefined;
}

function areRollbackEligibleTurnStartsEqual(
    previous: readonly number[] | null | undefined,
    next: readonly number[] | null | undefined,
): boolean {
    const previousStarts = normalizeRollbackEligibleTurnStarts(previous) ?? [];
    const nextStarts = normalizeRollbackEligibleTurnStarts(next) ?? [];
    if (previousStarts.length !== nextStarts.length) return false;
    for (let index = 0; index < previousStarts.length; index += 1) {
        if (previousStarts[index] !== nextStarts[index]) return false;
    }
    return true;
}

function deriveSessionListRenderableExternalSessionUnread(
    metadata: Metadata | null | undefined,
): boolean | null {
    if (!readExternalSessionLink(metadata)) {
        return null;
    }
    return deriveExternalSessionAttentionHasUnread(metadata);
}

export function deriveSessionListRenderableHasUnreadMessagesFromSession(
    session: Pick<Session, 'seq' | 'metadata' | 'lastViewedSessionSeq'> & Partial<Pick<Session, 'latestTurnStatus' | 'latestReadyEventSeq'>>,
    readableActivity?: SessionListReadableActivitySummary,
): boolean {
    const externalSessionHasUnread = deriveSessionListRenderableExternalSessionUnread(session.metadata);
    if (externalSessionHasUnread !== null) {
        return externalSessionHasUnread;
    }

    return computeHasUnreadActivity({
        sessionSeq: resolveSessionListReadableSeq(session, readableActivity),
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
    });
}

export function deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch(params: Readonly<{
    metadata: Metadata | null | undefined;
    nextSessionSeq: number;
    nextLastViewedSessionSeq?: number | null;
    nextLatestTurnStatus?: PrimaryTurnStatusV1 | null;
    nextLatestReadyEventSeq?: number | null;
    readableActivity?: SessionListReadableActivitySummary;
    previousHasUnreadMessages?: boolean;
    recomputeUnread?: boolean;
}>): boolean {
    if (params.metadata !== undefined) {
        const externalSessionHasUnread = deriveSessionListRenderableExternalSessionUnread(params.metadata);
        if (externalSessionHasUnread !== null) {
            return externalSessionHasUnread;
        }
    }

    if (
        params.recomputeUnread === true
        || params.metadata !== undefined
        || typeof params.nextLastViewedSessionSeq === 'number'
    ) {
        return computeHasUnreadActivity({
            sessionSeq: resolveSessionListReadableSeq({
                seq: params.nextSessionSeq,
                latestTurnStatus: params.nextLatestTurnStatus,
                latestReadyEventSeq: params.nextLatestReadyEventSeq,
            }, params.readableActivity),
            pendingActivityAt: 0,
            lastViewedSessionSeq: resolveLastViewedSessionSeq({
                lastViewedSessionSeq: params.nextLastViewedSessionSeq,
                metadata: params.metadata,
            }),
            lastViewedPendingActivityAt: params.metadata?.readStateV1?.pendingActivityAt,
        });
    }

    return params.previousHasUnreadMessages === true;
}

function shouldPreserveSessionListRenderablePendingFlags(
    current: SessionListRenderableStaleFieldSource,
    previous: SessionListRenderableSession | undefined,
): boolean {
    return (
        current.active === true
        && current.agentState == null
        && typeof current.pendingPermissionRequestCount !== 'number'
        && typeof current.pendingUserActionRequestCount !== 'number'
        && typeof current.hasPendingPermissionRequests !== 'boolean'
        && typeof current.hasPendingUserActionRequests !== 'boolean'
        && typeof previous?.hasPendingPermissionRequests === 'boolean'
        && typeof previous?.hasPendingUserActionRequests === 'boolean'
    );
}

export function buildSessionListRenderableFromSession(
    session: Session,
    previous?: SessionListRenderableSession,
    messages?: ReadonlyArray<Message>,
): SessionListRenderableSession {
    const preserveMetadata = session.metadata == null && previous?.metadata != null;
    const preservePendingFlags = shouldPreserveSessionListRenderablePendingFlags(session, previous);
    const pending = preservePendingFlags && previous
        ? {
            hasPendingPermissionRequests: previous.hasPendingPermissionRequests,
            hasPendingUserActionRequests: previous.hasPendingUserActionRequests,
        }
        : derivePendingRequestFlagsFromSession(session, messages);
    const previousMetadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable> = previous?.metadata
        ? readSessionListRenderableMetadataComparisonFromRenderable(previous.metadata)
        : null;
    const nextMetadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable> = preserveMetadata
        ? previousMetadata
        : readSessionListRenderableMetadataComparison(session.metadata, previousMetadata);
    const readableActivity = summarizeSessionListReadableActivityFromMessages(messages);
    const latestCommittedMessageCreatedAt = readableActivity?.latestCommittedMessageCreatedAt ?? null;
    const latestReadyEventSeq =
        normalizeLastViewedSessionSeq(session.latestReadyEventSeq)
        ?? previous?.latestReadyEventSeq
        ?? null;
    const latestReadyEventAt =
        normalizeReadyEventAt(session.latestReadyEventAt)
        ?? previous?.latestReadyEventAt
        ?? null;
    const latestTurnStatus = session.latestTurnStatus ?? null;
    const latestTurnStatusObservedAt = session.latestTurnStatusObservedAt ?? null;
    const runtimePresence = resolveSessionRuntimePresenceFields({
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        latestTurnStatus,
        latestTurnStatusObservedAt,
    });
    const next: SessionListRenderableSession = {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        meaningfulActivityAt: deriveSessionListMeaningfulActivityAt({
            sessionMeaningfulActivityAt: session.meaningfulActivityAt,
            latestCommittedMessageCreatedAt: latestCommittedMessageCreatedAt !== null && latestReadyEventAt !== null
                ? Math.max(latestCommittedMessageCreatedAt, latestReadyEventAt)
                : latestCommittedMessageCreatedAt ?? latestReadyEventAt,
            latestThinkingActivityAt: null,
            latestPendingMessageCreatedAt: null,
            sessionCreatedAt: session.createdAt,
        }),
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        lastViewedSessionSeq: normalizeLastViewedSessionSeq(session.lastViewedSessionSeq),
        latestTurnId: readSessionLatestTurnId(session),
        latestTurnStatus,
        latestTurnStatusObservedAt,
        rollbackEligibleTurnStarts: normalizeRollbackEligibleTurnStarts(session.rollbackEligibleTurnStarts),
        latestReadyEventSeq,
        latestReadyEventAt,
        lastRuntimeIssue: session.lastRuntimeIssue ?? null,
        lastTurnCompletedAt: session.lastTurnCompletedAt ?? null,
        metadataVersion: preserveMetadata && previous ? previous.metadataVersion : session.metadataVersion,
        agentStateVersion: preservePendingFlags && previous ? previous.agentStateVersion : session.agentStateVersion,
        metadata: previous && areSessionListRenderableMetadataComparisonsEqual(previousMetadata, nextMetadata)
            ? previous.metadata
            : nextMetadata,
        thinking: runtimePresence.thinking,
        thinkingAt: runtimePresence.thinkingAt,
        presence: session.presence,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner,
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
        pendingRequestObservedAt: preservePendingFlags && previous
            ? previous.pendingRequestObservedAt ?? null
            : deriveLatestPendingRequestObservedAtFromSession(session, messages),
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromSession({
            ...session,
            latestReadyEventSeq,
        }, readableActivity),
    };

    return previous && areSessionListRenderablesEqual(previous, next) ? previous : next;
}

export function resolveSessionListReadableSeq(
    session: Pick<Session, 'seq'> & Partial<Pick<Session, 'latestTurnStatus' | 'latestReadyEventSeq'>>,
    readableActivity: SessionListReadableActivitySummary | undefined,
): number {
    const sessionSeq = normalizeReadSeq(session.seq) ?? 0;
    let readableSeq: number | null = readableActivity?.latestCommittedMessageSeq ?? null;
    readableSeq = maxReadSeq(readableSeq, normalizeReadSeq(session.latestReadyEventSeq));

    if (isTerminalTurnStatus(session.latestTurnStatus)) {
        readableSeq = maxReadSeq(readableSeq, sessionSeq);
    }

    return readableSeq ?? 0;
}

function normalizeReadSeq(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

function maxReadSeq(left: number | null, right: number | null): number | null {
    if (left === null) return right;
    if (right === null) return left;
    return Math.max(left, right);
}

function isTerminalTurnStatus(value: unknown): value is Exclude<PrimaryTurnStatusV1, 'in_progress'> {
    return value === 'completed' || value === 'cancelled' || value === 'failed';
}

function readSessionLatestTurnId(session: Session): string | null {
    const value = session.latestTurnId;
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function preserveSessionListRenderableTransientState(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    if (previous?.keepVisibleWhenInactive !== true) {
        return next;
    }

    if (next.keepVisibleWhenInactive === true) {
        return next;
    }

    return {
        ...next,
        keepVisibleWhenInactive: true,
    };
}

export function preserveSessionListRenderableStaleFields(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    const preserveMetadata = next.metadata == null && previous?.metadata != null;
    const preserveMetadataUnavailable =
        !preserveMetadata
        && next.metadata == null
        && previous?.metadata == null
        && previous?.metadataUnavailable === true;
    const preservePendingFlags = shouldPreserveSessionListRenderablePendingFlags(next, previous);
    const preserveExternalSessionClassification =
        previous?.metadata?.externalSessionV1 != null
        && next.metadata != null
        && next.metadata.externalSessionV1 == null
        && previous.metadataVersion === next.metadataVersion;
    const preserveReadyEventSeq = next.latestReadyEventSeq == null && previous?.latestReadyEventSeq != null;
    const preserveReadyEventAt = next.latestReadyEventAt == null && previous?.latestReadyEventAt != null;

    if (
        previous == null
        || (
            !preserveMetadata
            && !preserveMetadataUnavailable
            && !preservePendingFlags
            && !preserveExternalSessionClassification
            && !preserveReadyEventSeq
            && !preserveReadyEventAt
        )
    ) {
        return next;
    }

    const nextMetadata = preserveMetadata
        ? previous.metadata
        : preserveExternalSessionClassification
            ? {
                ...(next.metadata as SessionListRenderableMetadata),
                externalSessionV1: previous.metadata?.externalSessionV1 ?? null,
            }
            : next.metadata;

    const latestReadyEventSeq = preserveReadyEventSeq
        ? previous.latestReadyEventSeq ?? null
        : next.latestReadyEventSeq ?? null;
    const latestReadyEventAt = preserveReadyEventAt
        ? previous.latestReadyEventAt ?? null
        : next.latestReadyEventAt ?? null;
    const nextReadableSeq = resolveSessionListReadableSeq({
        seq: next.seq,
        latestTurnStatus: next.latestTurnStatus,
        latestReadyEventSeq,
    }, undefined);
    let hasUnreadMessages = next.hasUnreadMessages;
    if (previous.hasUnreadMessages === true && next.hasUnreadMessages !== true) {
        hasUnreadMessages = nextReadableSeq > 0
            ? computeHasUnreadActivity({
                sessionSeq: nextReadableSeq,
                pendingActivityAt: 0,
                lastViewedSessionSeq: resolveLastViewedSessionSeq({
                    lastViewedSessionSeq: next.lastViewedSessionSeq,
                    metadata: nextMetadata,
                }),
                lastViewedPendingActivityAt: nextMetadata?.readStateV1?.pendingActivityAt,
            })
            : preserveReadyEventSeq || preserveReadyEventAt || resolveSessionListReadableSeq(next, undefined) <= 0;
    }

    return {
        ...next,
        latestReadyEventSeq,
        latestReadyEventAt,
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
        hasUnreadMessages,
    };
}

export function areSessionListRenderablesEqual(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return false;
    const previousMetadata = readSessionListRenderableMetadataComparisonFromRenderable(previous.metadata);
    const nextMetadata = readSessionListRenderableMetadataComparisonFromRenderable(next.metadata);

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
        && (previous.lastViewedSessionSeq ?? null) === (next.lastViewedSessionSeq ?? null)
        && (previous.latestTurnId ?? null) === (next.latestTurnId ?? null)
        && (previous.latestTurnStatus ?? null) === (next.latestTurnStatus ?? null)
        && (previous.latestTurnStatusObservedAt ?? null) === (next.latestTurnStatusObservedAt ?? null)
        && areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)
        && (previous.latestReadyEventSeq ?? null) === (next.latestReadyEventSeq ?? null)
        && (previous.latestReadyEventAt ?? null) === (next.latestReadyEventAt ?? null)
        && JSON.stringify(previous.lastRuntimeIssue ?? null) === JSON.stringify(next.lastRuntimeIssue ?? null)
        && (previous.lastTurnCompletedAt ?? null) === (next.lastTurnCompletedAt ?? null)
        && previous.metadataVersion === next.metadataVersion
        && previous.agentStateVersion === next.agentStateVersion
        && previous.thinking === next.thinking
        && previous.thinkingAt === next.thinkingAt
        && previous.presence === next.presence
        && (previous.optimisticThinkingAt ?? null) === (next.optimisticThinkingAt ?? null)
        && (previous.thinkingGraceUntil ?? null) === (next.thinkingGraceUntil ?? null)
        && (previous.owner ?? null) === (next.owner ?? null)
        && (previous.accessLevel ?? null) === (next.accessLevel ?? null)
        && (previous.canApprovePermissions ?? null) === (next.canApprovePermissions ?? null)
        && (previous.hasPendingPermissionRequests ?? null) === (next.hasPendingPermissionRequests ?? null)
        && (previous.hasPendingUserActionRequests ?? null) === (next.hasPendingUserActionRequests ?? null)
        && (previous.pendingRequestObservedAt ?? null) === (next.pendingRequestObservedAt ?? null)
        && (previous.hasUnreadMessages === true) === (next.hasUnreadMessages === true)
        && (previous.keepVisibleWhenInactive === true) === (next.keepVisibleWhenInactive === true)
        && (previous.metadataUnavailable === true) === (next.metadataUnavailable === true)
        && areSessionListRenderableMetadataComparisonsEqual(previousMetadata, nextMetadata);
}

export function didSessionListRenderableStructuralFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return true;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return true;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;
    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;
    if ((prevMeta?.externalSessionV1?.v ?? null) !== (nextMeta?.externalSessionV1?.v ?? null)) return true;
    if ((prevMeta?.externalSessionV1?.providerId ?? null) !== (nextMeta?.externalSessionV1?.providerId ?? null)) return true;
    if ((prevMeta?.hiddenSystemSession === true) !== (nextMeta?.hiddenSystemSession === true)) return true;

    return false;
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
    if (previous.updatedAt !== next.updatedAt) return true;
    if ((previous.meaningfulActivityAt ?? null) !== (next.meaningfulActivityAt ?? null)) return true;
    if (previous.createdAt !== next.createdAt) return true;
    if (previous.active !== next.active) return true;
    if (previous.activeAt !== next.activeAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.pendingCount ?? null) !== (next.pendingCount ?? null)) return true;
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return true;
    if ((previous.latestTurnId ?? null) !== (next.latestTurnId ?? null)) return true;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return true;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return true;
    if (!areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)) return true;
    if ((previous.accessLevel ?? null) !== (next.accessLevel ?? null)) return true;
    if ((previous.canApprovePermissions ?? null) !== (next.canApprovePermissions ?? null)) return true;
    if (previous.metadataVersion !== next.metadataVersion) return true;
    if (previous.agentStateVersion !== next.agentStateVersion) return true;

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
    if ((prevMeta?.externalSessionV1?.v ?? null) !== (nextMeta?.externalSessionV1?.v ?? null)) return true;
    if ((prevMeta?.externalSessionV1?.providerId ?? null) !== (nextMeta?.externalSessionV1?.providerId ?? null)) return true;

    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return true;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return true;
    if ((previous.pendingRequestObservedAt ?? null) !== (next.pendingRequestObservedAt ?? null)) return true;

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
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return false;
    if ((previous.lastViewedSessionSeq ?? null) !== (next.lastViewedSessionSeq ?? null)) return false;
    if ((previous.latestTurnId ?? null) !== (next.latestTurnId ?? null)) return false;
    if ((previous.latestTurnStatus ?? null) !== (next.latestTurnStatus ?? null)) return false;
    if ((previous.latestTurnStatusObservedAt ?? null) !== (next.latestTurnStatusObservedAt ?? null)) return false;
    if ((previous.lastRuntimeIssue ?? null) !== (next.lastRuntimeIssue ?? null)) return false;
    if (!areRollbackEligibleTurnStartsEqual(previous.rollbackEligibleTurnStarts, next.rollbackEligibleTurnStarts)) return false;
    if ((previous.latestReadyEventSeq ?? null) !== (next.latestReadyEventSeq ?? null)) return false;
    if ((previous.latestReadyEventAt ?? null) !== (next.latestReadyEventAt ?? null)) return false;
    if (previous.metadataVersion !== next.metadataVersion) return false;
    if (previous.agentStateVersion !== next.agentStateVersion) return false;
    if ((previous.accessLevel ?? null) !== (next.accessLevel ?? null)) return false;
    if ((previous.canApprovePermissions ?? null) !== (next.canApprovePermissions ?? null)) return false;
    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return false;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return false;
    if ((previous.pendingRequestObservedAt ?? null) !== (next.pendingRequestObservedAt ?? null)) return false;
    if ((previous.hasUnreadMessages === true) !== (next.hasUnreadMessages === true)) return false;
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return false;
    if ((previous.metadataUnavailable === true) !== (next.metadataUnavailable === true)) return false;
    if (!areSessionListRenderableMetadataComparisonsEqual(
        readSessionListRenderableMetadataComparisonFromRenderable(previous.metadata),
        readSessionListRenderableMetadataComparisonFromRenderable(next.metadata),
    )) {
        return false;
    }

    return previous.seq !== next.seq
        || previous.updatedAt !== next.updatedAt
        || (previous.meaningfulActivityAt ?? null) !== (next.meaningfulActivityAt ?? null)
        || previous.activeAt !== next.activeAt;
}
