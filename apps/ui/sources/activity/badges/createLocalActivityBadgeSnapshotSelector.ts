import type { AccountSettings } from '@happier-dev/protocol';

import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import {
    isFreshTimestamp,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    prunePendingRequestObservedAtCache,
    readCachedPendingRequestObservedAt,
    type PendingRequestObservedAtCacheEntry,
} from '@/sync/domains/session/pending/pendingRequestObservedAtCache';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import { AttentionDeviceOverridesV1Schema } from '@/sync/domains/settings/attentionDeviceOverridesV1';
import type { StorageState } from '@/sync/store/types';

import { buildActivityBadgeStateFromOverview, type ActivityBadgeSessionOptions } from './buildActivityBadgeState';
import {
    collectRecordIds,
    forEachRecordValue,
    hasRecordValues,
} from '../source/recordIteration';

export type LocalActivityBadgeSnapshot = Readonly<{
    channelDisabled: boolean;
    hasLocalActivitySource: boolean;
    isDataReady: boolean;
    localBadgeState: Readonly<{
        count: number;
        showNonNumericDot: boolean;
    }>;
    sessionOptions: Required<Pick<
        ActivityBadgeSessionOptions,
        'showPendingPermissionRequests' | 'showPendingUserActionRequests' | 'showUnread'
    >>;
}>;

export type LocalActivityBadgeSnapshotSelectorParams = Readonly<{
    accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>;
    friendRequestCount: number;
    hasNonNumericInboxAttention: boolean;
    localSettings: Partial<LocalSettings> | Readonly<Record<string, unknown>>;
}>;

type SignatureCacheEntry<T> = Readonly<{
    signature: string;
    value: T;
}>;

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
const EMPTY_RENDERABLES_BY_ID: ActivityAttentionSource['sessionListRenderablesById'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ActivityAttentionSource['concurrentSessionListCacheByServerId'] = {};

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function readFreshnessBit(value: unknown, nowMs: number): 0 | 1 {
    const timestamp = readNumber(value);
    return isFreshTimestamp(timestamp, nowMs, SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS) ? 1 : 0;
}

function readRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const requests = value as Record<string, {
        createdAt?: unknown;
        kind?: unknown;
        tool?: unknown;
    }>;
    return collectRecordIds(requests).sort().map((requestId) => {
        const request = requests[requestId];
        return [
            requestId,
            typeof request?.tool === 'string' ? request.tool : '',
            typeof request?.kind === 'string' ? request.kind : '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function readCompletedRequestSignature(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const completed = value as Record<string, { completedAt?: unknown; createdAt?: unknown }>;
    return collectRecordIds(completed).sort().map((requestId) => {
        const request = completed[requestId];
        return [
            requestId,
            readNumber(request?.completedAt) ?? '',
            readNumber(request?.createdAt) ?? '',
        ].join(':');
    }).join('|');
}

function hasCompletedRequest(completedValue: unknown, requestId: string): boolean {
    if (!completedValue || typeof completedValue !== 'object') return false;
    const completed = completedValue as Record<string, { completedAt?: unknown } | undefined>;
    return completed[requestId]?.completedAt != null;
}

function readLatestPendingAgentRequestCreatedAt(value: unknown, completedValue: unknown): number | null {
    if (!value || typeof value !== 'object') return null;
    const requests = value as Record<string, { createdAt?: unknown } | undefined>;
    let latest: number | null = null;
    for (const requestId of collectRecordIds(requests)) {
        if (hasCompletedRequest(completedValue, requestId)) continue;
        const createdAt = readNumber(requests[requestId]?.createdAt);
        if (createdAt === null) continue;
        latest = latest === null ? createdAt : Math.max(latest, createdAt);
    }
    return latest;
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasPendingAgentRequests(session: Session): boolean {
    return hasRecordValues(session.agentState?.requests ?? {});
}

function hasRenderablePendingRequestProjection(renderable: SessionListRenderableSession): boolean {
    return renderable.hasPendingPermissionRequests === true || renderable.hasPendingUserActionRequests === true;
}

function buildSessionActivitySignature(session: Session): string {
    const metadata = session.metadata;
    const readState = metadata?.readStateV1;
    const agentState = session.agentState;
    return [
        session.id,
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readNumber(session.seq) ?? '',
        hasProjectedPendingRequestCounts(session) ? readNumber(session.updatedAt) ?? '' : '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        metadata?.systemSessionV1?.hidden === true ? 1 : 0,
        metadata?.externalSessionV1 ? 1 : 0,
        metadata?.externalSessionAttentionV1 ? JSON.stringify(metadata.externalSessionAttentionV1) : '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readRequestSignature(agentState?.requests),
        readCompletedRequestSignature(agentState?.completedRequests),
    ].join('\u001f');
}

function buildRenderableActivitySignature(renderable: SessionListRenderableSession): string {
    const metadata = renderable.metadata;
    const readState = metadata?.readStateV1;
    return [
        renderable.id,
        readNumber(renderable.seq) ?? '',
        hasRenderablePendingRequestProjection(renderable) ? readNumber(renderable.updatedAt) ?? '' : '',
        renderable.hasUnreadMessages === true ? 1 : 0,
        renderable.metadataUnavailable === true ? 1 : 0,
        metadata?.hiddenSystemSession === true ? 1 : 0,
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        renderable.active === true ? 1 : 0,
        readNumber(renderable.activeAt) ?? '',
        renderable.presence,
        renderable.thinking === true ? 1 : 0,
        readNumber(renderable.thinkingAt) ?? '',
        renderable.latestTurnStatus ?? '',
        readNumber(renderable.latestTurnStatusObservedAt) ?? '',
        readNumber(renderable.meaningfulActivityAt) ?? '',
        renderable.hasPendingPermissionRequests === true ? 1 : 0,
        renderable.hasPendingUserActionRequests === true ? 1 : 0,
        readNumber(renderable.pendingRequestObservedAt) ?? '',
    ].join('\u001f');
}

function buildSessionMessagesActivitySignature(
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): string {
    if (!sessionMessages) return '';
    return [
        sessionMessages.isLoaded === true ? 1 : 0,
        readNumber(sessionMessages.messagesVersion) ?? '',
        readNumber(sessionMessages.latestReadyEventSeq) ?? '',
        readNumber(sessionMessages.latestReadyEventAt) ?? '',
        sessionMessages.messageIdsOldestFirst.length,
    ].join('\u001f');
}

function buildRuntimeFreshnessSignature(
    session: Session,
    nowMs: number,
    transcriptPendingRequestObservedAt: number | null,
): string {
    const agentState = session.agentState;
    const pendingRequestObservedAt =
        readLatestPendingAgentRequestCreatedAt(agentState?.requests, agentState?.completedRequests)
        ?? readNumber(session.pendingRequestObservedAt)
        ?? transcriptPendingRequestObservedAt;

    return [
        readFreshnessBit(session.thinkingAt, nowMs),
        readFreshnessBit(session.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(session.meaningfulActivityAt, nowMs),
        readFreshnessBit(pendingRequestObservedAt, nowMs),
    ].join(':');
}

function buildRenderableRuntimeFreshnessSignature(
    renderable: SessionListRenderableSession,
    nowMs: number,
): string {
    return [
        readFreshnessBit(renderable.thinkingAt, nowMs),
        readFreshnessBit(renderable.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(renderable.meaningfulActivityAt, nowMs),
        readFreshnessBit(renderable.pendingRequestObservedAt, nowMs),
    ].join(':');
}

function buildCachedRecordSignature<T>(
    record: Readonly<Record<string, T>>,
    cache: Map<string, SignatureCacheEntry<T>>,
    buildValueSignature: (value: T, id: string) => string,
): string {
    const ids = collectRecordIds(record).sort();
    for (const cachedId of cache.keys()) {
        if (!Object.prototype.hasOwnProperty.call(record, cachedId)) {
            cache.delete(cachedId);
        }
    }
    return ids.map((id) => {
        const value = record[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildValueSignature(value, id);
        if (cached?.value !== value) {
            cache.set(id, { signature, value });
        }
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function buildSessionListIndexSignature(
    indexByServerId: StorageState['sessionListIndexByServerId'],
): string {
    return collectRecordIds(indexByServerId ?? {}).sort().map((serverId) => {
        const items = indexByServerId?.[serverId] ?? [];
        return `${serverId}\u001e${Array.isArray(items)
            ? items.map((item: SessionListIndexItem) => (
                item.type === 'session'
                    ? ['s', item.sessionId, item.serverId ?? '', item.serverName ?? ''].join(':')
                    : ['h', item.type].join(':')
            )).join('|')
            : ''}`;
    }).join('\u001d');
}

function buildConcurrentCacheSignature(
    cacheByServerId: StorageState['concurrentSessionListCacheByServerId'],
    nowMs: number,
): string {
    return collectRecordIds(cacheByServerId ?? {}).sort().map((serverId) => {
        const entry = cacheByServerId?.[serverId];
        const sessions = entry?.sessions ?? {};
        const sessionSignature = collectRecordIds(sessions).sort().map((sessionId) => {
            const session = sessions[sessionId];
            if (!session) return `${sessionId}\u001e`;
            return [
                sessionId,
                buildRenderableActivitySignature(session),
                buildRenderableRuntimeFreshnessSignature(session, nowMs),
            ].join('\u001e');
        }).join('\u001d');
        return [serverId, entry?.serverName ?? '', sessionSignature].join('\u001e');
    }).join('\u001c');
}

function collectPotentialSessionIds(state: StorageState): string[] {
    const ids = new Set<string>();
    for (const id of collectRecordIds(state.sessions)) ids.add(id);
    for (const id of collectRecordIds(state.sessionListRenderables ?? {})) ids.add(id);
    forEachRecordValue(state.sessionListIndexByServerId ?? {}, (items) => {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (item.type === 'session' && item.sessionId.trim()) {
                ids.add(item.sessionId.trim());
            }
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
    return sessionIds.map((id) => {
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
        return `${id}\u001e${signature}`;
    }).join('\u001d');
}

function needsTranscriptPendingFreshnessProbe(
    session: Session,
    sessionMessages: StorageState['sessionMessages'][string] | undefined,
): boolean {
    return session.active === true
        && session.presence === 'online'
        && sessionMessages?.isLoaded === true
        && readNumber(session.pendingRequestObservedAt) === null
        && !hasProjectedPendingRequestCounts(session)
        && !hasPendingAgentRequests(session);
}

function buildRuntimeFreshnessRecordSignature(
    sessions: Readonly<Record<string, Session>>,
    sessionMessages: StorageState['sessionMessages'],
    nowMs: number,
    pendingRequestObservedAtCache: Map<string, PendingRequestObservedAtCacheEntry>,
    sessionSignatureCache: ReadonlyMap<string, SignatureCacheEntry<Session>>,
    sessionMessagesSignatureCache: ReadonlyMap<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>,
): string {
    const ids = collectRecordIds(sessions).sort();
    prunePendingRequestObservedAtCache(pendingRequestObservedAtCache, new Set(ids));

    return ids.map((id) => {
        const session = sessions[id];
        const sessionMessagesForSession = sessionMessages[id];
        const sessionSignature = sessionSignatureCache.get(id)?.signature
            ?? buildSessionActivitySignature(session);
        const sessionMessagesSignature = sessionMessagesSignatureCache.get(id)?.signature
            ?? buildSessionMessagesActivitySignature(sessionMessagesForSession);
        const transcriptPendingRequestObservedAt = needsTranscriptPendingFreshnessProbe(
            session,
            sessionMessagesForSession,
        )
            ? readCachedPendingRequestObservedAt({
                cache: pendingRequestObservedAtCache,
                session,
                sessionMessages: sessionMessagesForSession,
                sessionSignature,
                sessionMessagesSignature,
            })
            : null;
        return `${id}\u001e${buildRuntimeFreshnessSignature(
            session,
            nowMs,
            transcriptPendingRequestObservedAt,
        )}`;
    }).join('\u001d');
}

function hasLocalActivitySource(state: StorageState): boolean {
    let hasIndexedSession = false;
    forEachRecordValue(state.sessionListIndexByServerId ?? {}, (items) => {
        if (Array.isArray(items) && items.length > 0) {
            hasIndexedSession = true;
        }
    });
    let hasCachedSession = false;
    forEachRecordValue(state.concurrentSessionListCacheByServerId ?? {}, (entry) => {
        if (hasRecordValues(entry?.sessions ?? {})) {
            hasCachedSession = true;
        }
    });
    return hasRecordValues(state.sessions)
        || hasRecordValues(state.sessionListRenderables ?? {})
        || hasIndexedSession
        || hasCachedSession;
}

function buildActivitySourceFromState(state: StorageState): ActivityAttentionSource {
    return {
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRenderablesById: state.sessionListRenderables ?? EMPTY_RENDERABLES_BY_ID,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
        sessionMessagesById: state.sessionMessages,
        activeServer: null,
        serverProfilesById: {},
    };
}

function resolveBadgeModel(params: LocalActivityBadgeSnapshotSelectorParams, now: Date) {
    const parsedLocalSettings = localSettingsParse(params.localSettings);
    const readyPlan = resolveActivityAttentionDeliveryPlan({
        accountSettings: params.accountSettings,
        localSettings: parsedLocalSettings,
        event: 'ready',
        channel: 'badge',
        now,
    });
    const permissionPlan = resolveActivityAttentionDeliveryPlan({
        accountSettings: params.accountSettings,
        localSettings: parsedLocalSettings,
        event: 'permission_request',
        channel: 'badge',
        now,
    });
    const userActionPlan = resolveActivityAttentionDeliveryPlan({
        accountSettings: params.accountSettings,
        localSettings: parsedLocalSettings,
        event: 'user_action_request',
        channel: 'badge',
        now,
    });
    const channelDisabled =
        readyPlan.reason === 'channel_disabled'
        && permissionPlan.reason === 'channel_disabled'
        && userActionPlan.reason === 'channel_disabled';
    const deviceOverrides = AttentionDeviceOverridesV1Schema.parse(parsedLocalSettings.attentionDeviceOverridesV1);

    return {
        channelDisabled,
        deviceOverrides,
        sessionOptions: {
            showUnread: readyPlan.badgeBehavior.include,
            showPendingPermissionRequests: permissionPlan.badgeBehavior.include,
            showPendingUserActionRequests: userActionPlan.badgeBehavior.include,
        },
    };
}

export function createLocalActivityBadgeSnapshotSelector(
    params: LocalActivityBadgeSnapshotSelectorParams,
): (state: StorageState) => LocalActivityBadgeSnapshot {
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const renderableSignatureCache = new Map<string, SignatureCacheEntry<SessionListRenderableSession>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    const pendingRequestObservedAtCache = new Map<string, PendingRequestObservedAtCacheEntry>();
    let previousSignature: string | null = null;
    let previousSnapshot: LocalActivityBadgeSnapshot | null = null;

    return (state) => {
        const now = new Date();
        const nowMs = now.getTime();
        const badgeModel = resolveBadgeModel(params, now);
        const localSourceAvailable = hasLocalActivitySource(state)
            || params.friendRequestCount > 0
            || params.hasNonNumericInboxAttention;
        const sessionIds = collectPotentialSessionIds(state);
        const snapshotSignature = badgeModel.channelDisabled
            ? [
                badgeModel.channelDisabled ? 1 : 0,
                state.isDataReady === true ? 1 : 0,
                localSourceAvailable ? 1 : 0,
            ].join('\u001c')
            : [
                badgeModel.channelDisabled ? 1 : 0,
                state.isDataReady === true ? 1 : 0,
                localSourceAvailable ? 1 : 0,
                params.friendRequestCount,
                params.hasNonNumericInboxAttention ? 1 : 0,
                badgeModel.sessionOptions.showUnread ? 1 : 0,
                badgeModel.sessionOptions.showPendingPermissionRequests ? 1 : 0,
                badgeModel.sessionOptions.showPendingUserActionRequests ? 1 : 0,
                badgeModel.deviceOverrides.badge.includeFriendRequestsInboxCount ? 1 : 0,
                badgeModel.deviceOverrides.badge.includeDesktopNonNumericDot ? 1 : 0,
                buildCachedRecordSignature(state.sessions, sessionSignatureCache, buildSessionActivitySignature),
                buildCachedRecordSignature(
                    state.sessionListRenderables ?? {},
                    renderableSignatureCache,
                    buildRenderableActivitySignature,
                ),
                buildSessionListIndexSignature(state.sessionListIndexByServerId),
                buildConcurrentCacheSignature(state.concurrentSessionListCacheByServerId, nowMs),
                buildSessionMessagesRecordSignature(sessionIds, state.sessionMessages, sessionMessagesSignatureCache),
                buildRuntimeFreshnessRecordSignature(
                    state.sessions,
                    state.sessionMessages,
                    nowMs,
                    pendingRequestObservedAtCache,
                    sessionSignatureCache,
                    sessionMessagesSignatureCache,
                ),
                buildCachedRecordSignature(
                    state.sessionListRenderables ?? {},
                    new Map(),
                    (renderable) => buildRenderableRuntimeFreshnessSignature(renderable, nowMs),
                ),
            ].join('\u001c');

        if (previousSignature === snapshotSignature && previousSnapshot) {
            return previousSnapshot;
        }

        previousSignature = snapshotSignature;
        if (badgeModel.channelDisabled) {
            previousSnapshot = {
                channelDisabled: true,
                hasLocalActivitySource: localSourceAvailable,
                isDataReady: state.isDataReady,
                localBadgeState: { count: 0, showNonNumericDot: false },
                sessionOptions: badgeModel.sessionOptions,
            };
            return previousSnapshot;
        }

        const overview = buildActivityOverviewFromSource({
            source: buildActivitySourceFromState(state),
            nowMs,
            sessionOptions: badgeModel.sessionOptions,
            includeWarmSourceWhenNotReady: true,
        });

        previousSnapshot = {
            channelDisabled: false,
            hasLocalActivitySource: localSourceAvailable,
            isDataReady: state.isDataReady,
            localBadgeState: buildActivityBadgeStateFromOverview({
                overview,
                numericInboxCount:
                    !badgeModel.deviceOverrides.badge.includeFriendRequestsInboxCount
                        ? 0
                        : params.friendRequestCount,
                hasNonNumericInboxAttention:
                    badgeModel.deviceOverrides.badge.includeDesktopNonNumericDot
                    && params.hasNonNumericInboxAttention,
                sessionOptions: badgeModel.sessionOptions,
            }),
            sessionOptions: badgeModel.sessionOptions,
        };
        return previousSnapshot;
    };
}
