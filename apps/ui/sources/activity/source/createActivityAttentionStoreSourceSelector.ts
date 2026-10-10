import { readSessionViewerAttentionSignature } from '@/sync/domains/session/readState/sessionViewerAttention';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import {
    serializeExternalSessionJsonForComparison,
    serializeExternalSessionSourceForComparison,
} from '@/sync/domains/session/external/serializeExternalSessionSourceForComparison';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
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
    | 'ordinarySessionListMembershipByServerId'
    | 'sessionListIndexByServerId'
    | 'sessionListRowsByServerId'
    | 'sessionMessagesById'
    | 'sessionsById'
    | 'workspacePathDisplayModeV1'
    | 'workspaceRefsV1'
>;

type SignatureCacheEntry<T> = Readonly<{
    signature: string;
    value: T;
}>;

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
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

function buildWorkspaceDisplaySettingsSignature(state: StorageState): string {
    return joinSignatureParts([
        state.settings.workspacePathDisplayModeV1,
        ...readProjectWorkspaceRefs(state).map((ref) => joinSignatureParts([
            ref.id,
            ref.serverId,
            ref.machineId,
            ref.rootPath,
            ref.label,
        ])),
    ]);
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
        serializeExternalSessionJsonForComparison(link.runtimeDescriptorV1),
        serializeExternalSessionJsonForComparison(link.linkData),
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
    viewer?: Session['viewer'];
    archivedAt?: number | null;
}>): string {
    return joinSignatureParts([
        session.id,
        session.metadataUnavailable === true ? 1 : 0,
        isUserFacingSession(session) ? 1 : 0,
        session.serverId ?? '',
        session.viewer?.attention.presentation ?? '',
        session.viewer?.attention.needsAttention === true ? 1 : 0,
        session.viewer?.attention.reasons.join(',') ?? '',
        session.viewer?.readState.state ?? '',
        session.archivedAt ?? '',
    ]);
}

function buildSessionActivitySignature(session: Session): string {
    const ownerMetadata = readSessionOwnerMetadataView(session);
    const visibilitySession = {
        id: session.id,
        serverId: session.serverId,
        viewer: session.viewer,
        archivedAt: session.archivedAt,
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
        readSessionViewerAttentionSignature(session),
        JSON.stringify(session.access?.audienceContext ?? null),
        session.access?.capabilities.submitAgentInput === true ? 1 : 0,
        session.access?.capabilities.approveRuntimePermissions === true ? 1 : 0,
        session.serverId ?? '',
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        readNumber(session.optimisticThinkingAt) ?? '',
        session.runtimeActivityState ?? '',
        readNumber(session.runtimeActivityActiveCount) ?? '',
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
        readSessionViewerAttentionSignature(renderable),
        JSON.stringify(renderable.access?.audienceContext ?? null),
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
        readSessionViewerAttentionSignature(renderable),
        JSON.stringify(renderable.access?.audienceContext ?? null),
        renderable.access?.capabilities.submitAgentInput === true ? 1 : 0,
        renderable.access?.capabilities.approveRuntimePermissions === true ? 1 : 0,
        readNumber(renderable.seq) ?? '',
        renderable.hasUnreadMessages === true ? 1 : 0,
        renderable.metadataUnavailable === true ? 1 : 0,
        renderable.active === true ? 1 : 0,
        readNumber(renderable.activeAt) ?? '',
        renderable.presence,
        renderable.thinking === true ? 1 : 0,
        readNumber(renderable.thinkingAt) ?? '',
        readNumber(renderable.optimisticThinkingAt) ?? '',
        renderable.runtimeActivityState ?? '',
        readNumber(renderable.runtimeActivityActiveCount) ?? '',
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
    // The shared message reader accepts both the current normalized store and
    // the released array-shaped state. Keep the selector signature aligned
    // with that compatibility seam so an old hydrated cache cannot crash the
    // entire Activity/Inbox projection before normalization completes.
    const stateLike = sessionMessages as Readonly<{
        messageIdsOldestFirst?: unknown;
        messages?: unknown;
    }>;
    const messageCount = Array.isArray(stateLike.messageIdsOldestFirst)
        ? stateLike.messageIdsOldestFirst.length
        : Array.isArray(stateLike.messages) ? stateLike.messages.length : 0;
    return joinSignatureParts([
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        messageCount,
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
    forEachRecordValue(state.ordinarySessionListMembershipByServerId ?? {}, (membership) => {
        if (!Array.isArray(membership)) return;
        for (const id of membership) if (id.trim()) ids.add(id.trim());
    });
    return Array.from(ids).sort();
}

function buildSessionMessagesRecordSignature(
    sessionIds: readonly string[],
    sessionMessages: StorageState['sessionMessages'],
    cache: Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    const liveIds = new Set(sessionIds);
    for (const cachedId of cache.keys()) {
        if (!liveIds.has(cachedId)) {
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
        return joinSignatureParts([
            serverId,
            entry?.serverName ?? '',
            // Home currentness is part of every Session's context line, so a Home going offline or
            // recovering must rebuild this projection (Lane 07.4 §2). Only the phase belongs here:
            // a reachable Home contributes no currentness words, and a Home that cannot be reached
            // cannot advance its last success, so adding the timestamp would rebuild every
            // Activity row on each ordinary refresh for no visible difference.
            entry?.listObservation?.phase ?? '',
        ]);
    }));
}

function buildActivityRowsSignature(
    state: StorageState,
    cache: Map<string, SignatureCacheEntry<SessionListRenderableSession>>,
    personalMembershipByServerId: Readonly<Record<string, readonly string[]>>,
): string {
    const addressesByKey = new Map<string, Readonly<{ serverId: string; sessionId: string }>>();
    for (const membershipByServerId of [
        state.ordinarySessionListMembershipByServerId ?? {},
        personalMembershipByServerId,
    ]) {
        for (const [serverId, membership] of Object.entries(membershipByServerId)) {
            for (const sessionId of membership ?? []) {
                const address = { serverId, sessionId };
                addressesByKey.set(sessionAddressKey(address), address);
            }
        }
    }
    const addresses = [...addressesByKey.entries()]
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    for (const key of cache.keys()) if (!addressesByKey.has(key)) cache.delete(key);
    return joinSignatureParts(addresses.map(([key, { serverId, sessionId }]) => {
        const row = state.sessionListRowsByServerId?.[serverId]?.[sessionId];
        if (!row) return joinSignatureParts([serverId, sessionId, '']);
        const cached = cache.get(key);
        const signature = cached?.value === row ? cached.signature : buildRenderableActivitySignature(row);
        if (cached?.value !== row) cache.set(key, { signature, value: row });
        return joinSignatureParts([serverId, sessionId, signature]);
    }));
}

function buildSourceFromState(
    state: StorageState,
    includeSessionMessages: boolean,
): StoreActivityAttentionSource {
    return {
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRowsByServerId: state.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId:
            state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
        ...(includeSessionMessages ? { sessionMessagesById: state.sessionMessages } : {}),
        workspaceRefsV1: readProjectWorkspaceRefs(state),
        workspacePathDisplayModeV1: state.settings.workspacePathDisplayModeV1,
    };
}

export function createActivityAttentionStoreSourceSelector(
    personalMembershipByServerId: Readonly<Record<string, readonly string[]>> = {},
    options: Readonly<{ includeSessionMessages?: boolean }> = {},
): (state: StorageState) => StoreActivityAttentionSource {
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const renderableSignatureCache = new Map<string, SignatureCacheEntry<SessionListRenderableSession>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    let previousSignature: string | null = null;
    let previousSource: StoreActivityAttentionSource | null = null;
    let previousInputs: StoreActivityAttentionSource | null = null;
    const signatures = { sessions: '', rows: '', index: '', cache: '', messages: '', workspace: '' };
    let potentialSessionIds: readonly string[] = [];
    const includeSessionMessages = options.includeSessionMessages !== false;

    return (state) => {
        const inputs = buildSourceFromState(state, includeSessionMessages);
        const sessionsChanged = !previousInputs || previousInputs.sessionsById !== inputs.sessionsById;
        const membershipChanged = !previousInputs
            || previousInputs.ordinarySessionListMembershipByServerId !== inputs.ordinarySessionListMembershipByServerId;
        const rowsChanged = !previousInputs || previousInputs.sessionListRowsByServerId !== inputs.sessionListRowsByServerId;
        const indexChanged = !previousInputs || previousInputs.sessionListIndexByServerId !== inputs.sessionListIndexByServerId;
        const cacheChanged = !previousInputs
            || previousInputs.concurrentSessionListCacheByServerId !== inputs.concurrentSessionListCacheByServerId;
        const messagesChanged = includeSessionMessages && (sessionsChanged || membershipChanged
            || previousInputs?.sessionMessagesById !== inputs.sessionMessagesById);
        const workspaceChanged = !previousInputs || previousInputs.workspaceRefsV1 !== inputs.workspaceRefsV1
            || previousInputs.workspacePathDisplayModeV1 !== inputs.workspacePathDisplayModeV1;
        if (previousSource && previousInputs?.isDataReady === inputs.isDataReady
            && !sessionsChanged && !membershipChanged && !rowsChanged && !indexChanged
            && !cacheChanged && !messagesChanged && !workspaceChanged) {
            return previousSource;
        }

        // Store domains publish immutable references. Retain each semantic signature independently:
        // an unrelated notification must not sort/parse the unchanged Session collections.
        if (includeSessionMessages && (sessionsChanged || membershipChanged)) {
            potentialSessionIds = collectPotentialSessionIds(state);
        }
        if (sessionsChanged) signatures.sessions = buildCachedRecordSignature(state.sessions, sessionSignatureCache, buildSessionActivitySignature);
        if (rowsChanged || membershipChanged) signatures.rows = buildActivityRowsSignature(state, renderableSignatureCache, personalMembershipByServerId);
        if (indexChanged) signatures.index = buildSessionListIndexSignature(state.sessionListIndexByServerId);
        if (cacheChanged) signatures.cache = buildConcurrentCacheSignature(state.concurrentSessionListCacheByServerId);
        if (messagesChanged) signatures.messages = buildSessionMessagesRecordSignature(potentialSessionIds, state.sessionMessages, sessionMessagesSignatureCache);
        if (workspaceChanged) signatures.workspace = buildWorkspaceDisplaySettingsSignature(state);
        previousInputs = inputs;
        const signature = joinSignatureParts([
            inputs.isDataReady === true ? 1 : 0,
            signatures.sessions, signatures.rows, signatures.index, signatures.cache, signatures.messages, signatures.workspace,
        ]);

        if (previousSource && previousSignature === signature) {
            return previousSource;
        }

        previousSignature = signature;
        previousSource = inputs;
        return previousSource;
    };
}
