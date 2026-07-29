import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { serializeExternalSessionSourceForComparison } from '@/sync/domains/session/external/serializeExternalSessionSourceForComparison';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { readSessionDisplayTitleField } from '@/sync/state/selectors';
import {
    readPendingAgentStateCompletedRequestSignature,
    readPendingAgentStateRequestSignature,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import type { ActivityAttentionSource } from './activityAttentionSourceTypes';
import { collectRecordIds, forEachRecordValue } from './recordIteration';

type StoreActivityAttentionSource = Pick<
    ActivityAttentionSource,
    | 'concurrentSessionListCacheByServerId'
    | 'isDataReady'
    | 'sessionListIndexByServerId'
    | 'sessionListRenderablesById'
    | 'sessionMessagesById'
    | 'sessionsById'
>;

type SignatureCacheEntry<T> = Readonly<{
    signature: string;
    value: T;
}>;

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
const EMPTY_RENDERABLES_BY_ID: ActivityAttentionSource['sessionListRenderablesById'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ConcurrentSessionListCacheByServerId = {};

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readObjectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' ? value as Readonly<Record<string, unknown>> : null;
}

function joinSignatureParts(parts: readonly unknown[]): string {
    return parts.map((part) => {
        const value = part == null ? '' : String(part);
        return `${value.length}:${value}`;
    }).join('');
}

function readRuntimeIssueSignature(issue: SessionRuntimeIssueV1 | null | undefined): string {
    if (!issue) return '';
    return joinSignatureParts([
        issue.v,
        issue.scope,
        issue.status,
        issue.code,
        issue.source,
        readNumber(issue.occurredAt) ?? '',
        readNumber(issue.sessionSeq) ?? '',
        readString(issue.agentId),
        readString(issue.agentTurnId),
        readString(issue.sanitizedPreview),
    ]);
}

function readLinkedExternalSessionSignature(metadata: unknown): string {
    const link = readExternalSessionLink(metadata);
    if (!link) return '';
    return joinSignatureParts([
        link.v,
        link.agentId,
        link.machineId,
        link.remoteSessionId,
        serializeExternalSessionSourceForComparison(link.source),
        readNumber(link.lastKnownActivityAtMs) ?? '',
        link.codexBackendMode ?? '',
    ]);
}

function readExternalSessionAttentionSignature(metadata: unknown): string {
    const record = readObjectRecord(metadata);
    const attention = readObjectRecord(record?.externalSessionAttentionV1);
    if (attention?.v !== 1) return '';
    return joinSignatureParts([
        readString(attention.observedProgressToken),
        readString(attention.viewedProgressToken),
        readNumber(attention.observedAtMs) ?? '',
        readNumber(attention.viewedAtMs) ?? '',
    ]);
}

function readSessionMetadataActivitySignature(metadata: unknown): string {
    const record = readObjectRecord(metadata);
    const readState = readObjectRecord(record?.readStateV1);
    const displayTitle = readSessionDisplayTitleField({ metadata });
    return joinSignatureParts([
        readString(record?.path),
        readString(record?.host),
        readString(record?.homeDir),
        readString(record?.machineId),
        readString(record?.name),
        displayTitle.value ?? '',
        displayTitle.updatedAt ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        readLinkedExternalSessionSignature(metadata),
        readExternalSessionAttentionSignature(metadata),
    ]);
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasRenderablePendingRequestProjection(renderable: SessionListRenderableSession): boolean {
    return renderable.hasPendingPermissionRequests === true || renderable.hasPendingUserActionRequests === true;
}

function buildHiddenSessionSignature(session: Readonly<{
    id: string;
    metadata?: unknown;
    metadataUnavailable?: boolean;
    serverId?: string | null;
}>): string {
    return joinSignatureParts([
        session.id,
        session.metadataUnavailable === true ? 1 : 0,
        isUserFacingSession(session) ? 1 : 0,
        session.serverId ?? '',
    ]);
}

function buildSessionActivitySignature(session: Session): string {
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const visibilitySession = {
        id: session.id,
        serverId: session.serverId,
        metadata: ownerMetadata,
        metadataUnavailable: session.metadataLayoutVersion === 1 && ownerMetadata == null,
    };
    if (
        !isUserFacingSession(visibilitySession)
        && !isVoiceConversationCustodySessionMetadata(ownerMetadata)
    ) {
        return buildHiddenSessionSignature(visibilitySession);
    }
    const agentState = session.agentState;
    return joinSignatureParts([
        session.id,
        session.serverId ?? '',
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        readNumber(session.optimisticThinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readRuntimeIssueSignature(session.lastRuntimeIssue),
        readNumber(session.lastTurnCompletedAt) ?? '',
        readNumber(session.seq) ?? '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(session.pendingVersion) ?? '',
        readNumber(session.pendingCount) ?? '',
        readNumber(session.pendingBlockedCount) ?? '',
        hasProjectedPendingRequestCounts(session) ? readNumber(session.updatedAt) ?? '' : '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readNumber(session.agentStateVersion) ?? '',
        readPendingAgentStateRequestSignature(agentState),
        readPendingAgentStateCompletedRequestSignature(agentState),
        readSessionMetadataActivitySignature(ownerMetadata),
    ]);
}

function buildHiddenRenderableSignature(renderable: SessionListRenderableSession): string {
    return joinSignatureParts([
        renderable.id,
        renderable.metadataUnavailable === true ? 1 : 0,
        isUserFacingSession(renderable) ? 1 : 0,
    ]);
}

function buildRenderableActivitySignature(renderable: SessionListRenderableSession): string {
    if (
        !isUserFacingSession(renderable)
        && !isVoiceConversationCustodySessionMetadata(renderable.metadata)
    ) {
        return buildHiddenRenderableSignature(renderable);
    }

    return joinSignatureParts([
        renderable.id,
        readNumber(renderable.seq) ?? '',
        renderable.hasUnreadMessages === true ? 1 : 0,
        renderable.metadataUnavailable === true ? 1 : 0,
        renderable.active === true ? 1 : 0,
        readNumber(renderable.activeAt) ?? '',
        renderable.presence,
        renderable.thinking === true ? 1 : 0,
        readNumber(renderable.thinkingAt) ?? '',
        readNumber(renderable.optimisticThinkingAt) ?? '',
        renderable.latestTurnStatus ?? '',
        readNumber(renderable.latestTurnStatusObservedAt) ?? '',
        readNumber(renderable.meaningfulActivityAt) ?? '',
        readRuntimeIssueSignature(renderable.lastRuntimeIssue),
        readNumber(renderable.lastTurnCompletedAt) ?? '',
        readNumber(renderable.latestReadyEventSeq) ?? '',
        readNumber(renderable.pendingVersion) ?? '',
        readNumber(renderable.pendingCount) ?? '',
        readNumber(renderable.pendingBlockedCount) ?? '',
        hasRenderablePendingRequestProjection(renderable) ? readNumber(renderable.updatedAt) ?? '' : '',
        renderable.hasPendingPermissionRequests === true ? 1 : 0,
        renderable.hasPendingUserActionRequests === true ? 1 : 0,
        readNumber(renderable.pendingRequestObservedAt) ?? '',
        readNumber(renderable.agentStateVersion) ?? '',
        readSessionMetadataActivitySignature(renderable.metadata),
    ]);
}

function buildSessionMessagesActivitySignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return joinSignatureParts([
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst.length,
    ]);
}

function buildCachedRecordSignature<T>(
    record: Readonly<Record<string, T>>,
    cache: Map<string, SignatureCacheEntry<T>>,
    buildValueSignature: (value: T) => string,
): string {
    const ids = collectRecordIds(record).sort();
    for (const cachedId of cache.keys()) {
        if (!Object.prototype.hasOwnProperty.call(record, cachedId)) {
            cache.delete(cachedId);
        }
    }
    return joinSignatureParts(ids.map((id) => {
        const value = record[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildValueSignature(value);
        if (cached?.value !== value) {
            cache.set(id, { signature, value });
        }
        return joinSignatureParts([id, signature]);
    }));
}

function collectPotentialSessionIds(state: StorageState): string[] {
    const ids = new Set<string>();
    for (const id of collectRecordIds(state.sessions)) ids.add(id);
    for (const id of collectRecordIds(state.sessionListRenderables ?? {})) ids.add(id);
    forEachRecordValue(state.sessionListIndexByServerId ?? {}, (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (item.type !== 'session') continue;
            const sessionId = item.sessionId.trim();
            if (sessionId) ids.add(sessionId);
        }
    });
    forEachRecordValue(state.concurrentSessionListCacheByServerId ?? {}, (entry) => {
        for (const id of collectRecordIds(entry?.sessions ?? {})) ids.add(id);
    });
    return Array.from(ids).sort();
}

function buildSessionMessagesRecordSignature(
    sessionIds: readonly string[],
    sessionMessages: StorageState['sessionMessages'],
    cache: Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    for (const cachedId of cache.keys()) {
        if (!sessionIds.includes(cachedId)) {
            cache.delete(cachedId);
        }
    }
    return joinSignatureParts(sessionIds.map((id) => {
        const value = sessionMessages[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildSessionMessagesActivitySignature(value);
        if (value) {
            cache.set(id, { signature, value });
        } else {
            cache.delete(id);
        }
        return joinSignatureParts([id, signature]);
    }));
}

function buildSessionListIndexSignature(
    indexByServerId: StorageState['sessionListIndexByServerId'],
): string {
    return joinSignatureParts(collectRecordIds(indexByServerId ?? {}).sort().map((serverId) => {
        const items = indexByServerId?.[serverId] ?? [];
        const itemSignature = Array.isArray(items)
            ? joinSignatureParts(items.map((item: SessionListIndexItem) => (
                item.type === 'session'
                    ? joinSignatureParts(['s', item.sessionId, item.serverId ?? '', item.serverName ?? ''])
                    : joinSignatureParts(['h', item.type])
            )))
            : '';
        return joinSignatureParts([serverId, itemSignature]);
    }));
}

function buildConcurrentCacheSignature(
    cacheByServerId: StorageState['concurrentSessionListCacheByServerId'],
): string {
    return joinSignatureParts(collectRecordIds(cacheByServerId ?? {}).sort().map((serverId) => {
        const entry = cacheByServerId?.[serverId];
        const sessionSignature = joinSignatureParts(collectRecordIds(entry?.sessions ?? {}).sort().map((sessionId) => {
            const session = entry?.sessions?.[sessionId];
            return joinSignatureParts([sessionId, session ? buildRenderableActivitySignature(session) : '']);
        }));
        return joinSignatureParts([serverId, entry?.serverName ?? '', sessionSignature]);
    }));
}

function buildSourceFromState(state: StorageState): StoreActivityAttentionSource {
    return {
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRenderablesById: state.sessionListRenderables ?? EMPTY_RENDERABLES_BY_ID,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId:
            state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
        sessionMessagesById: state.sessionMessages,
    };
}

export function createActivityAttentionStoreSourceSelector(): (state: StorageState) => StoreActivityAttentionSource {
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const renderableSignatureCache = new Map<string, SignatureCacheEntry<SessionListRenderableSession>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    let previousSignature: string | null = null;
    let previousSource: StoreActivityAttentionSource | null = null;

    return (state) => {
        const sessionIds = collectPotentialSessionIds(state);
        const signature = joinSignatureParts([
            state.isDataReady === true ? 1 : 0,
            buildCachedRecordSignature(state.sessions, sessionSignatureCache, buildSessionActivitySignature),
            buildCachedRecordSignature(
                state.sessionListRenderables ?? {},
                renderableSignatureCache,
                buildRenderableActivitySignature,
            ),
            buildSessionListIndexSignature(state.sessionListIndexByServerId),
            buildConcurrentCacheSignature(state.concurrentSessionListCacheByServerId),
            buildSessionMessagesRecordSignature(sessionIds, state.sessionMessages, sessionMessagesSignatureCache),
        ]);

        if (previousSource && previousSignature === signature) {
            return previousSource;
        }

        previousSignature = signature;
        previousSource = buildSourceFromState(state);
        return previousSource;
    };
}
