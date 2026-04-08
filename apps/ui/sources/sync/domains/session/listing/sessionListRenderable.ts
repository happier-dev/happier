import type { AgentState, Metadata, Session } from '@/sync/domains/state/storageTypes';
import { computeHasUnreadActivity } from '@/sync/domains/messages/unread';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { deriveDirectSessionAttentionHasUnread } from '@/sync/domains/session/directSessions/readDirectSessionAttention';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';
import {
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
}

export type SessionListRenderableFieldSnapshot = Readonly<{
    active: boolean;
    createdAt: number;
    updatedAt: number;
    activeAt: number;
    archivedAt: number | null;
    pendingVersion: number | null;
    pendingCount: number | null;
    metadataVersion: number;
    agentStateVersion: number;
    accessLevel: SessionListRenderableSession['accessLevel'] | null;
    canApprovePermissions: boolean | null;
    hasPendingPermissionRequests: boolean | null;
    hasPendingUserActionRequests: boolean | null;
    keepVisibleWhenInactive: boolean;
    metadata: ReturnType<typeof readSessionListRenderableMetadataComparisonFromRenderable>;
}>;

type SessionListRenderableStaleFieldSource = Readonly<{
    active?: boolean;
    agentState?: AgentState | null | undefined;
    pendingPermissionRequestCount?: number;
    pendingUserActionRequestCount?: number;
    hasPendingPermissionRequests?: boolean;
    hasPendingUserActionRequests?: boolean;
}>;

function deriveSessionListRenderableDirectSessionUnread(
    metadata: Metadata | null | undefined,
): boolean | null {
    if (!readDirectSessionLink(metadata)) {
        return null;
    }
    return deriveDirectSessionAttentionHasUnread(metadata);
}

export function deriveSessionListRenderableHasUnreadMessagesFromSession(
    session: Pick<Session, 'seq' | 'metadata' | 'lastViewedSessionSeq'>,
): boolean {
    const directSessionHasUnread = deriveSessionListRenderableDirectSessionUnread(session.metadata);
    if (directSessionHasUnread !== null) {
        return directSessionHasUnread;
    }

    return computeHasUnreadActivity({
        sessionSeq: session.seq ?? 0,
        pendingActivityAt: 0,
        lastViewedSessionSeq: resolveLastViewedSessionSeq(session),
        lastViewedPendingActivityAt: session.metadata?.readStateV1?.pendingActivityAt,
    });
}

export function deriveSessionListRenderableHasUnreadMessagesFromMetadataPatch(params: Readonly<{
    metadata: Metadata | null | undefined;
    nextSessionSeq: number;
    nextLastViewedSessionSeq?: number;
    previousHasUnreadMessages?: boolean;
}>): boolean {
    if (params.metadata !== undefined) {
        const directSessionHasUnread = deriveSessionListRenderableDirectSessionUnread(params.metadata);
        if (directSessionHasUnread !== null) {
            return directSessionHasUnread;
        }
    }

    if (typeof params.nextLastViewedSessionSeq === 'number') {
        return computeHasUnreadActivity({
            sessionSeq: params.nextSessionSeq,
            pendingActivityAt: 0,
            lastViewedSessionSeq: params.nextLastViewedSessionSeq,
            lastViewedPendingActivityAt: undefined,
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
    const next: SessionListRenderableSession = {
        id: session.id,
        seq: session.seq,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        active: session.active,
        activeAt: session.activeAt,
        archivedAt: session.archivedAt ?? null,
        pendingVersion: session.pendingVersion,
        pendingCount: session.pendingCount,
        metadataVersion: preserveMetadata && previous ? previous.metadataVersion : session.metadataVersion,
        agentStateVersion: preservePendingFlags && previous ? previous.agentStateVersion : session.agentStateVersion,
        metadata: previous && areSessionListRenderableMetadataComparisonsEqual(previousMetadata, nextMetadata)
            ? previous.metadata
            : nextMetadata,
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

    return previous && areSessionListRenderablesEqual(previous, next) ? previous : next;
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
    const preservePendingFlags = shouldPreserveSessionListRenderablePendingFlags(next, previous);
    const preserveDirectSessionClassification =
        previous?.metadata?.directSessionV1 != null
        && next.metadata != null
        && next.metadata.directSessionV1 == null
        && previous.metadataVersion === next.metadataVersion;

    if (
        previous == null
        || (!preserveMetadata && !preservePendingFlags && !preserveDirectSessionClassification)
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
        hasPendingPermissionRequests: preservePendingFlags
            ? previous.hasPendingPermissionRequests
            : next.hasPendingPermissionRequests,
        hasPendingUserActionRequests: preservePendingFlags
            ? previous.hasPendingUserActionRequests
            : next.hasPendingUserActionRequests,
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
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.archivedAt ?? null) === (next.archivedAt ?? null)
        && (previous.pendingVersion ?? null) === (next.pendingVersion ?? null)
        && (previous.pendingCount ?? null) === (next.pendingCount ?? null)
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
    if ((previous.keepVisibleWhenInactive === true) !== (next.keepVisibleWhenInactive === true)) return true;

    const prevMeta = previous.metadata;
    const nextMeta = next.metadata;
    if (String(prevMeta?.machineId ?? '') !== String(nextMeta?.machineId ?? '')) return true;
    if (String(prevMeta?.path ?? '') !== String(nextMeta?.path ?? '')) return true;
    if (String(prevMeta?.homeDir ?? '') !== String(nextMeta?.homeDir ?? '')) return true;
    if ((prevMeta?.directSessionV1?.v ?? null) !== (nextMeta?.directSessionV1?.v ?? null)) return true;
    if ((prevMeta?.directSessionV1?.providerId ?? null) !== (nextMeta?.directSessionV1?.providerId ?? null)) return true;
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
