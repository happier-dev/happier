import type { Metadata, Session } from '@/sync/domains/state/storageTypes';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import {
    derivePendingRequestFlagsFromAgentState,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { resolveLastViewedSessionSeq } from '@/sync/domains/session/readCursor/resolveLastViewedSessionSeq';
import { resolveSessionProjectGroupingKeyParts } from './sessionListProjectGroupingKeys';

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
    hiddenSystemSession?: boolean;
}

export interface SessionListRenderableSession {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    archivedAt?: number | null;
    pendingVersion?: number;
    pendingCount?: number;
    lastViewedSessionSeq?: number | null;
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
    hasUnreadMessages?: boolean;
    keepVisibleWhenInactive?: boolean;
    metadataUnavailable?: boolean;
}

type DirectSessionRenderableMetadata = NonNullable<SessionListRenderableMetadata['directSessionV1']>;
type ReadStateRenderableMetadata = NonNullable<SessionListRenderableMetadata['readStateV1']>;

function normalizeLastViewedSessionSeq(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : null;
}

export function deriveSessionListRenderableHasUnreadMessagesFromSession(
    session: Pick<Session, 'seq' | 'metadata' | 'lastViewedSessionSeq'>,
): boolean {
    return computeHasUnreadActivity({
        sessionSeq: session.seq ?? 0,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
    });
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
        hiddenSystemSession: metadata.systemSessionV1?.hidden === true,
    };
}

export function buildSessionListRenderableFromSession(
    session: Session,
    messages?: ReadonlyArray<Message>,
): SessionListRenderableSession {
    const pending = derivePendingRequestFlagsFromSession(session, messages);
    return {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        lastViewedSessionSeq: normalizeLastViewedSessionSeq(session.lastViewedSessionSeq),
        metadataVersion: session.metadataVersion,
        agentStateVersion: session.agentStateVersion,
        metadata: buildSessionListRenderableMetadata(session.metadata),
        thinking: session.thinking,
        thinkingAt: session.thinkingAt,
        presence: session.presence,
        optimisticThinkingAt: session.optimisticThinkingAt ?? null,
        thinkingGraceUntil: session.thinkingGraceUntil ?? null,
        owner: session.owner,
        accessLevel: session.accessLevel,
        canApprovePermissions: session.canApprovePermissions,
        hasPendingPermissionRequests: pending.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pending.hasPendingUserActionRequests,
        hasUnreadMessages: deriveSessionListRenderableHasUnreadMessagesFromSession(session),
    };
}

export function preserveSessionListRenderableTransientState(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): SessionListRenderableSession {
    return {
        ...next,
        keepVisibleWhenInactive: previous?.keepVisibleWhenInactive === true,
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
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.archivedAt ?? null) === (next.archivedAt ?? null)
        && (previous.pendingVersion ?? null) === (next.pendingVersion ?? null)
        && (previous.pendingCount ?? null) === (next.pendingCount ?? null)
        && (previous.lastViewedSessionSeq ?? null) === (next.lastViewedSessionSeq ?? null)
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
        && (previous.hasUnreadMessages === true) === (next.hasUnreadMessages === true)
        && (previous.keepVisibleWhenInactive === true) === (next.keepVisibleWhenInactive === true)
        && (previous.metadataUnavailable === true) === (next.metadataUnavailable === true)
        && areSessionListRenderableMetadataEqual(previous.metadata, next.metadata);
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

export function didSessionListRenderableReachabilityPeerFieldsChange(
    previous: SessionListRenderableSession | undefined,
    next: SessionListRenderableSession,
): boolean {
    if (!previous) return true;
    if (previous.active !== next.active) return true;
    if (previous.updatedAt !== next.updatedAt) return true;
    if (previous.metadataVersion !== next.metadataVersion) return true;

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
    if (previous.createdAt !== next.createdAt) return true;
    if (previous.active !== next.active) return true;
    if (previous.activeAt !== next.activeAt) return true;
    if ((previous.archivedAt ?? null) !== (next.archivedAt ?? null)) return true;
    if ((previous.pendingCount ?? null) !== (next.pendingCount ?? null)) return true;
    if ((previous.pendingVersion ?? null) !== (next.pendingVersion ?? null)) return true;
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
    if ((prevMeta?.directSessionV1?.v ?? null) !== (nextMeta?.directSessionV1?.v ?? null)) return true;
    if ((prevMeta?.directSessionV1?.providerId ?? null) !== (nextMeta?.directSessionV1?.providerId ?? null)) return true;

    if ((previous.hasPendingPermissionRequests ?? null) !== (next.hasPendingPermissionRequests ?? null)) return true;
    if ((previous.hasPendingUserActionRequests ?? null) !== (next.hasPendingUserActionRequests ?? null)) return true;

    return false;
}
