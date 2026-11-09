import { readSessionViewerAttentionSignature } from '@/sync/domains/session/readState/sessionViewerAttention';
import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';

import { buildActivityOverviewSummaryFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { createActivityAttentionStoreSourceSelector } from '@/activity/source/createActivityAttentionStoreSourceSelector';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import {
    isFreshTimestamp,
    SESSION_OPTIMISTIC_PENDING_THINKING_MS,
    SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
} from '@/sync/domains/session/attention/runtimePresentation';
import {
    prunePendingRequestObservedAtCache,
    readCachedPendingRequestObservedAt,
    type PendingRequestObservedAtCacheEntry,
} from '@/sync/domains/session/pending/pendingRequestObservedAtCache';
import {
    deriveLatestPendingAgentStateRequestObservedAt,
    derivePendingRequestFlagsFromAgentState,
    readPendingAgentStateCompletedRequestSignature,
    readPendingAgentStateRequestSignature,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import type { ActivityAttentionDeliveryEventKind } from '@/activity/delivery/activityAttentionDeliveryPlanTypes';
import { readNextActivityAttentionDeliveryBoundaryMs, resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import type { StorageState } from '@/sync/store/types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

import { buildActivityBadgeStateFromAttentionCount, type ActivityBadgeSessionOptions } from './buildActivityBadgeState';
import {
    collectRecordIds,
    forEachRecordValue,
    hasRecordValues,
} from '../source/recordIteration';

export type LocalActivityBadgeSnapshot = Readonly<{
    nextRefreshAtMs: number | null;
    channelDisabled: boolean;
    /**
     * Whether any Home's exact Account badge policy is known yet.
     *
     * "No Home has answered" is not the same fact as "a Home answered no": writing 0 while the
     * first answer is still outstanding clears a correct badge on every launch. Fail-closed is
     * per Home — an unresolved Home contributes nothing — and this flag keeps the device from
     * writing anything at all until at least one Home has spoken.
     */
    policyReady: boolean;
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
    /**
     * Each Home's own persisted Account delivery policy, keyed by the `serverId` its Sessions carry.
     *
     * The badge aggregates Sessions from every Home onto one app icon, so one Account setting can
     * never govern the corpus: an absent key fails closed for that Home, and switching the active
     * Home cannot change what a sibling Home contributes.
     */
    accountSettingsByServerId: Readonly<Record<string, Partial<AccountSettings>>>;
    friendRequestCount: number;
    hasNonNumericInboxAttention: boolean;
    localSettings: Partial<LocalSettings> | Readonly<Record<string, unknown>>;
    personalSessionListCoverageComplete?: ActivityAttentionSource['personalSessionListCoverageComplete'];
    personalSessionListMembershipByServerId?: Readonly<Record<string, readonly string[]>>;
    ruleSessionMembershipByServerId?: ActivityAttentionSource['ruleSessionMembershipByServerId'];
    personalSessionListQueryStatesByServerId?: ActivityAttentionSource['personalSessionListQueryStatesByServerId'];
    personalFollowRulesByServerId?: ActivityAttentionSource['personalFollowRulesByServerId'];
}>;

type SignatureCacheEntry<T> = Readonly<{
    signature: string;
    value: T;
}>;

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ActivityAttentionSource['concurrentSessionListCacheByServerId'] = {};

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function joinSignatureParts(parts: readonly unknown[]): string {
    return parts.map((part) => {
        const value = part == null ? '' : String(part);
        return `${value.length}:${value}`;
    }).join('');
}

function readFreshnessBit(
    value: unknown,
    nowMs: number,
    staleMs: number = SESSION_RUNTIME_STATUS_STALE_SIGNAL_MS,
): 0 | 1 {
    const timestamp = readNumber(value);
    return isFreshTimestamp(timestamp, nowMs, staleMs) ? 1 : 0;
}

function hasProjectedPendingRequestCounts(session: Session): boolean {
    return typeof session.pendingPermissionRequestCount === 'number'
        || typeof session.pendingUserActionRequestCount === 'number';
}

function hasPendingAgentRequests(session: Session): boolean {
    const flags = derivePendingRequestFlagsFromAgentState(session.agentState);
    return flags.hasPendingPermissionRequests || flags.hasPendingUserActionRequests;
}

function hasRenderablePendingRequestProjection(renderable: SessionListRenderableSession): boolean {
    return renderable.hasPendingPermissionRequests === true || renderable.hasPendingUserActionRequests === true;
}

function buildSessionActivitySignature(session: Session): string {
    const metadata = readSessionOwnerMetadataView(session);
    const readState = metadata?.readStateV1;
    const agentState = session.agentState;
    return joinSignatureParts([
        session.id,
        readSessionViewerAttentionSignature(session),
        session.active === true ? 1 : 0,
        readNumber(session.activeAt) ?? '',
        session.presence,
        session.thinking === true ? 1 : 0,
        readNumber(session.thinkingAt) ?? '',
        readNumber(session.optimisticThinkingAt) ?? '',
        session.latestTurnStatus ?? '',
        readNumber(session.latestTurnStatusObservedAt) ?? '',
        readNumber(session.meaningfulActivityAt) ?? '',
        readNumber(session.seq) ?? '',
        readNumber(session.pendingBlockedCount) ?? '',
        hasProjectedPendingRequestCounts(session) ? readNumber(session.updatedAt) ?? '' : '',
        readNumber(session.latestReadyEventSeq) ?? '',
        readNumber(session.lastViewedSessionSeq) ?? '',
        readNumber(readState?.sessionSeq) ?? '',
        readNumber(readState?.pendingActivityAt) ?? '',
        metadata?.systemSessionV1?.hidden === true ? 1 : 0,
        readExternalSessionLink(metadata) ? 1 : 0,
        metadata?.externalSessionAttentionV1 ? JSON.stringify(metadata.externalSessionAttentionV1) : '',
        readNumber(session.pendingPermissionRequestCount) ?? '',
        readNumber(session.pendingUserActionRequestCount) ?? '',
        readNumber(session.pendingRequestObservedAt) ?? '',
        readPendingAgentStateRequestSignature(agentState?.requests),
        readPendingAgentStateCompletedRequestSignature(agentState?.completedRequests),
    ]);
}

function buildRenderableActivitySignature(renderable: SessionListRenderableSession): string {
    const metadata = renderable.metadata;
    const readState = metadata?.readStateV1;
    return joinSignatureParts([
        renderable.id,
        readSessionViewerAttentionSignature(renderable),
        readNumber(renderable.seq) ?? '',
        readNumber(renderable.pendingBlockedCount) ?? '',
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
        readNumber(renderable.optimisticThinkingAt) ?? '',
        renderable.latestTurnStatus ?? '',
        readNumber(renderable.latestTurnStatusObservedAt) ?? '',
        readNumber(renderable.meaningfulActivityAt) ?? '',
        renderable.hasPendingPermissionRequests === true ? 1 : 0,
        renderable.hasPendingUserActionRequests === true ? 1 : 0,
        readNumber(renderable.pendingRequestObservedAt) ?? '',
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

function buildRuntimeFreshnessSignature(
    session: Session,
    nowMs: number,
    transcriptPendingRequestObservedAt: number | null,
): string {
    const agentState = session.agentState;
    const pendingRequestObservedAt =
        deriveLatestPendingAgentStateRequestObservedAt(agentState)
        ?? readNumber(session.pendingRequestObservedAt)
        ?? transcriptPendingRequestObservedAt;

    return joinSignatureParts([
        readFreshnessBit(session.thinkingAt, nowMs),
        readFreshnessBit(session.optimisticThinkingAt, nowMs, SESSION_OPTIMISTIC_PENDING_THINKING_MS),
        readFreshnessBit(session.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(session.meaningfulActivityAt, nowMs),
        readFreshnessBit(pendingRequestObservedAt, nowMs),
    ]);
}

function buildRenderableRuntimeFreshnessSignature(
    renderable: SessionListRenderableSession,
    nowMs: number,
): string {
    return joinSignatureParts([
        readFreshnessBit(renderable.thinkingAt, nowMs),
        readFreshnessBit(renderable.optimisticThinkingAt, nowMs, SESSION_OPTIMISTIC_PENDING_THINKING_MS),
        readFreshnessBit(renderable.latestTurnStatusObservedAt, nowMs),
        readFreshnessBit(renderable.meaningfulActivityAt, nowMs),
        readFreshnessBit(renderable.pendingRequestObservedAt, nowMs),
    ]);
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
    return joinSignatureParts(ids.map((id) => {
        const value = record[id];
        const cached = cache.get(id);
        const signature = cached !== undefined && cached.value === value
            ? cached.signature
            : buildValueSignature(value, id);
        if (cached?.value !== value) {
            cache.set(id, { signature, value });
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
        return joinSignatureParts([serverId, entry?.serverName ?? '']);
    }));
}

function buildOrdinaryRowsSignature(
    state: StorageState,
    cache: Map<string, SignatureCacheEntry<SessionListRenderableSession>>,
    buildValueSignature: (row: SessionListRenderableSession) => string,
): string {
    const addresses = Object.entries(state.ordinarySessionListMembershipByServerId ?? {})
        .flatMap(([serverId, membership]) => (membership ?? []).map((sessionId) => {
            const address = { serverId, sessionId };
            return [sessionAddressKey(address), address] as const;
        }))
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const liveKeys = new Set(addresses.map(([key]) => key));
    for (const key of cache.keys()) if (!liveKeys.has(key)) cache.delete(key);
    return joinSignatureParts(addresses.map(([key, { serverId, sessionId }]) => {
        const row = state.sessionListRowsByServerId?.[serverId]?.[sessionId];
        if (!row) return joinSignatureParts([serverId, sessionId, '']);
        const cached = cache.get(key);
        const signature = cached?.value === row ? cached.signature : buildValueSignature(row);
        if (cached?.value !== row) cache.set(key, { signature, value: row });
        return joinSignatureParts([serverId, sessionId, signature]);
    }));
}

function collectPotentialSessionIds(
    state: StorageState,
    personalSessionListMembershipByServerId: Readonly<Record<string, readonly string[]>>,
    ruleSessionMembershipByServerId: Readonly<Record<string, readonly string[]>>,
): string[] {
    const ids = new Set<string>();
    for (const id of collectRecordIds(state.sessions)) ids.add(id);
    forEachRecordValue(state.ordinarySessionListMembershipByServerId ?? {}, (membership) => {
        if (!Array.isArray(membership)) return;
        for (const id of membership) if (id.trim()) ids.add(id.trim());
    });
    forEachRecordValue(personalSessionListMembershipByServerId, (membership) => {
        if (!Array.isArray(membership)) return;
        for (const id of membership) if (id.trim()) ids.add(id.trim());
    });
    forEachRecordValue(ruleSessionMembershipByServerId, (membership) => {
        for (const id of membership) if (id.trim()) ids.add(id.trim());
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

    return joinSignatureParts(ids.map((id) => {
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
        return joinSignatureParts([id, buildRuntimeFreshnessSignature(
            session,
            nowMs,
            transcriptPendingRequestObservedAt,
        )]);
    }));
}

function hasLocalActivitySource(
    state: StorageState,
    personalSessionListMembershipByServerId: Readonly<Record<string, readonly string[]>>,
    ruleSessionMembershipByServerId: Readonly<Record<string, readonly string[]>>,
): boolean {
    let hasIndexedSession = false;
    forEachRecordValue(state.sessionListIndexByServerId ?? {}, (items) => {
        if (Array.isArray(items) && items.length > 0) {
            hasIndexedSession = true;
        }
    });
    let hasOrdinaryMembership = false;
    forEachRecordValue(state.ordinarySessionListMembershipByServerId ?? {}, (membership) => {
        if (Array.isArray(membership) && membership.length > 0) hasOrdinaryMembership = true;
    });
    let hasPersonalMembership = false;
    forEachRecordValue(personalSessionListMembershipByServerId, (membership) => {
        if (Array.isArray(membership) && membership.length > 0) hasPersonalMembership = true;
    });
    let hasRuleMembership = false;
    forEachRecordValue(ruleSessionMembershipByServerId, (membership) => {
        if (membership.length > 0) hasRuleMembership = true;
    });
    return hasRecordValues(state.sessions)
        || hasIndexedSession
        || hasOrdinaryMembership
        || hasPersonalMembership
        || hasRuleMembership;
}

function buildActivitySourceFromState(
    state: StorageState,
    personalSource: Pick<
        ActivityAttentionSource,
        | 'personalSessionListCoverageComplete'
        | 'personalSessionListMembershipByServerId'
        | 'ruleSessionMembershipByServerId'
        | 'personalSessionListQueryStatesByServerId'
        | 'personalFollowRulesByServerId'
    >,
    ruleSource?: Partial<ActivityAttentionSource>,
): ActivityAttentionSource {
    return {
        ...ruleSource,
        isDataReady: state.isDataReady,
        sessionsById: state.sessions,
        sessionListRowsByServerId: state.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
        ...personalSource,
        sessionListIndexByServerId: state.sessionListIndexByServerId ?? EMPTY_INDEX_BY_SERVER_ID,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId ?? EMPTY_CONCURRENT_CACHE_BY_SERVER_ID,
        sessionMessagesById: state.sessionMessages,
        activeServerId: state.profileScope?.serverId ?? null,
        activeServer: null,
        serverProfilesById: {},
    };
}

type BadgeHomeSessionOptions = LocalActivityBadgeSnapshot['sessionOptions'];

type BadgeHomeModel = Readonly<{
    channelDisabled: boolean;
    sessionOptions: BadgeHomeSessionOptions;
}>;

/** Nothing this Home could contribute, used wherever its exact Account policy is unknown. */
const FAIL_CLOSED_BADGE_HOME_MODEL: BadgeHomeModel = Object.freeze({
    channelDisabled: true,
    sessionOptions: Object.freeze({
        showUnread: false,
        showPendingPermissionRequests: false,
        showPendingUserActionRequests: false,
    }),
});

function resolveBadgeHomeModel(
    accountSettings: Partial<AccountSettings> | Readonly<Record<string, unknown>>,
    parsedLocalSettings: ReturnType<typeof localSettingsParse>,
    now: Date,
): BadgeHomeModel {
    const resolvePlan = (event: ActivityAttentionDeliveryEventKind) => resolveActivityAttentionDeliveryPlan({
        accountSettings,
        localSettings: parsedLocalSettings,
        event,
        channel: 'badge',
        now,
    });
    const readyPlan = resolvePlan('ready');
    const permissionPlan = resolvePlan('permission_request');
    const userActionPlan = resolvePlan('user_action_request');

    return {
        channelDisabled: readyPlan.reason === 'channel_disabled'
            && permissionPlan.reason === 'channel_disabled'
            && userActionPlan.reason === 'channel_disabled',
        sessionOptions: {
            showUnread: readyPlan.badgeBehavior.include,
            showPendingPermissionRequests: permissionPlan.badgeBehavior.include,
            showPendingUserActionRequests: userActionPlan.badgeBehavior.include,
        },
    };
}

function resolveBadgeModel(
    params: LocalActivityBadgeSnapshotSelectorParams,
    parsedLocalSettings: ReturnType<typeof localSettingsParse>,
    now: Date,
    activeServerId: string | null,
) {
    const homeServerIds = Object.keys(params.accountSettingsByServerId).sort();
    const homeModels = new Map<string, BadgeHomeModel>(homeServerIds.map((serverId) => [
        serverId,
        resolveBadgeHomeModel(params.accountSettingsByServerId[serverId], parsedLocalSettings, now),
    ]));
    // Device-global inbox facts — friend requests and the update/changelog dot — belong to the
    // Account this device is signed into, so the active Home's own policy governs them. Session
    // candidates are governed one Home at a time, below.
    const activeHomeModel = (activeServerId ? homeModels.get(activeServerId) : undefined)
        ?? FAIL_CLOSED_BADGE_HOME_MODEL;
    // The badge channel is off for this device only when every Home that answered said no.
    const policyReady = homeModels.size > 0;
    const channelDisabled = policyReady
        && [...homeModels.values()].every((model) => model.channelDisabled);
    const deviceOverrides = parsedLocalSettings.attentionDeviceOverridesV1;

    return {
        channelDisabled,
        policyReady,
        deviceOverrides,
        resolveSessionOptionsForServerId: (serverId: string): BadgeHomeSessionOptions | null => {
            const model = homeModels.get(serverId);
            if (!model || model.channelDisabled) return null;
            return model.sessionOptions;
        },
        homeSignatureParts: homeServerIds.map((serverId) => {
            const model = homeModels.get(serverId) ?? FAIL_CLOSED_BADGE_HOME_MODEL;
            return joinSignatureParts([
                serverId,
                model.channelDisabled ? 1 : 0,
                model.sessionOptions.showUnread ? 1 : 0,
                model.sessionOptions.showPendingPermissionRequests ? 1 : 0,
                model.sessionOptions.showPendingUserActionRequests ? 1 : 0,
            ]);
        }),
        /** Exposed for the server-snapshot gate, which is an active-Account route. */
        sessionOptions: activeHomeModel.channelDisabled
            ? FAIL_CLOSED_BADGE_HOME_MODEL.sessionOptions
            : activeHomeModel.sessionOptions,
        includeInboxCounts: !activeHomeModel.channelDisabled,
    };
}

/**
 * The store slices this selector's derivation reads. Identity of each is the cheapest sound proof
 * that a commit cannot have moved the badge: the store replaces a slice object whenever any record
 * inside it changes.
 */
type BadgeSnapshotSourceIdentity = Readonly<{
    profileScope: StorageState['profileScope'];
    concurrentSessionListCacheByServerId: StorageState['concurrentSessionListCacheByServerId'];
    deltaRevision: number | null;
    isDataReady: boolean;
    sessionListIndexByServerId: StorageState['sessionListIndexByServerId'];
    sessionListRowsByServerId: StorageState['sessionListRowsByServerId'];
    ordinarySessionListMembershipByServerId: StorageState['ordinarySessionListMembershipByServerId'];
    sessionMessages: StorageState['sessionMessages'];
    sessions: StorageState['sessions'];
}>;

function readBadgeSnapshotSourceIdentity(state: StorageState): BadgeSnapshotSourceIdentity {
    return {
        profileScope: state.profileScope,
        concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        deltaRevision: state.sessionListRenderableDelta?.revision ?? null,
        isDataReady: state.isDataReady,
        sessionListIndexByServerId: state.sessionListIndexByServerId,
        sessionListRowsByServerId: state.sessionListRowsByServerId,
        ordinarySessionListMembershipByServerId: state.ordinarySessionListMembershipByServerId,
        sessionMessages: state.sessionMessages,
        sessions: state.sessions,
    };
}

function isSameBadgeSnapshotSourceIdentity(
    previous: BadgeSnapshotSourceIdentity,
    state: StorageState,
): boolean {
    return previous.profileScope?.serverId === state.profileScope?.serverId
        && previous.profileScope?.accountId === state.profileScope?.accountId
        && previous.sessions === state.sessions
        && previous.sessionListRowsByServerId === state.sessionListRowsByServerId
        && previous.ordinarySessionListMembershipByServerId === state.ordinarySessionListMembershipByServerId
        && previous.sessionListIndexByServerId === state.sessionListIndexByServerId
        && previous.concurrentSessionListCacheByServerId === state.concurrentSessionListCacheByServerId
        && previous.sessionMessages === state.sessionMessages
        && previous.isDataReady === state.isDataReady
        && previous.deltaRevision === (state.sessionListRenderableDelta?.revision ?? null);
}

export function createLocalActivityBadgeSnapshotSelector(
    params: LocalActivityBadgeSnapshotSelectorParams,
): (state: StorageState) => LocalActivityBadgeSnapshot {
    const parsedLocalSettings = localSettingsParse(params.localSettings);
    const includesRuleFacts = Object.values(params.personalFollowRulesByServerId ?? {}).some(snapshot =>
        snapshot.status === 'ready' && snapshot.rules.some(rule => rule.receiver.kind === 'account' && rule.definition.enabled));
    const selectRuleSource = includesRuleFacts ? createActivityAttentionStoreSourceSelector(
        params.personalSessionListMembershipByServerId, { includeSessionMessages: false, includeFollowRuleFacts: true,
            ruleMembershipByServerId: params.ruleSessionMembershipByServerId },
    ) : null;
    let previousRuleSource: ReturnType<NonNullable<typeof selectRuleSource>> | null = null;
    const sessionSignatureCache = new Map<string, SignatureCacheEntry<Session>>();
    const renderableSignatureCache = new Map<string, SignatureCacheEntry<SessionListRenderableSession>>();
    const sessionMessagesSignatureCache = new Map<string, SignatureCacheEntry<StorageState['sessionMessages'][string]>>();
    const pendingRequestObservedAtCache = new Map<string, PendingRequestObservedAtCacheEntry>();
    let previousSignature: string | null = null;
    let previousSnapshot: LocalActivityBadgeSnapshot | null = null;
    let previousDeltaRevision: number | null = null;
    let previousNowMs: number | null = null;
    let previousSourceIdentity: BadgeSnapshotSourceIdentity | null = null;
    let nextPolicyBoundaryMs: number | null = null;
    let policyBoundaryReadAtMs: number | null = null;

    return (state) => {
        const ruleSource = selectRuleSource?.(state) ?? null;
        const ruleSourceChanged = ruleSource !== previousRuleSource;
        previousRuleSource = ruleSource;
        const nowMs = Date.now();
        const clockMovedBackwards = previousNowMs !== null && nowMs < previousNowMs;
        const boundaryReached = previousSnapshot?.nextRefreshAtMs != null && nowMs >= previousSnapshot.nextRefreshAtMs;
        const personalSessionListMembershipByServerId = params.personalSessionListMembershipByServerId ?? {};
        const ruleSessionMembershipByServerId = includesRuleFacts ? params.ruleSessionMembershipByServerId ?? {} : {};
        const renderableDelta = state.sessionListRenderableDelta;
        const profileScopeChanged = previousSourceIdentity?.profileScope?.serverId !== state.profileScope?.serverId
            || previousSourceIdentity?.profileScope?.accountId !== state.profileScope?.accountId;
        // Source identity is sufficient only until the retained policy/freshness
        // deadline. Unrelated commits before it still cost O(1), even as time moves.
        if (
            previousSnapshot !== null
            && previousSourceIdentity !== null
            && !clockMovedBackwards
            && !boundaryReached
            && !ruleSourceChanged
            && isSameBadgeSnapshotSourceIdentity(previousSourceIdentity, state)
        ) {
            return previousSnapshot;
        }
        previousSourceIdentity = readBadgeSnapshotSourceIdentity(state);

        const now = new Date(nowMs);
        if (policyBoundaryReadAtMs === null || nowMs < policyBoundaryReadAtMs
            || (nextPolicyBoundaryMs !== null && nowMs >= nextPolicyBoundaryMs)) {
            nextPolicyBoundaryMs = null;
            for (const accountSettings of Object.values(params.accountSettingsByServerId)) {
                const boundary = readNextActivityAttentionDeliveryBoundaryMs({ accountSettings, localSettings: parsedLocalSettings, now });
                if (boundary !== null && (nextPolicyBoundaryMs === null || boundary < nextPolicyBoundaryMs)) nextPolicyBoundaryMs = boundary;
            }
            policyBoundaryReadAtMs = nowMs;
        }
        if (
            previousSnapshot
            && !ruleSourceChanged
            && !profileScopeChanged
            && renderableDelta
            && previousDeltaRevision !== null
            && renderableDelta.revision !== previousDeltaRevision
            && renderableDelta.rebuiltSessionListIndex !== true
            && renderableDelta.changedSessionIds.length === 0
            && renderableDelta.removedSessionIds.length === 0
            && previousNowMs === nowMs
            && previousSnapshot.isDataReady === state.isDataReady
        ) {
            previousDeltaRevision = renderableDelta.revision;
            return previousSnapshot;
        }
        const badgeModel = resolveBadgeModel(params, parsedLocalSettings, now, state.profileScope?.serverId ?? null);
        const localSourceAvailable = hasLocalActivitySource(state, personalSessionListMembershipByServerId, ruleSessionMembershipByServerId)
            || params.friendRequestCount > 0
            || params.hasNonNumericInboxAttention;
        const sessionIds = collectPotentialSessionIds(state, personalSessionListMembershipByServerId, ruleSessionMembershipByServerId);
        const snapshotSignature = badgeModel.channelDisabled || !badgeModel.policyReady
            ? joinSignatureParts([
                badgeModel.channelDisabled ? 1 : 0,
                badgeModel.policyReady ? 1 : 0,
                state.isDataReady === true ? 1 : 0,
                localSourceAvailable ? 1 : 0,
            ])
            : joinSignatureParts([
                badgeModel.channelDisabled ? 1 : 0,
                badgeModel.policyReady ? 1 : 0,
                state.isDataReady === true ? 1 : 0,
                localSourceAvailable ? 1 : 0,
                state.profileScope?.serverId ?? '',
                state.profileScope?.accountId ?? '',
                params.friendRequestCount,
                params.hasNonNumericInboxAttention ? 1 : 0,
                // Per-Home policy, not one Account's: a sibling Home's toggles changing must move
                // this signature even when the active Home's own policy did not change.
                joinSignatureParts(badgeModel.homeSignatureParts),
                badgeModel.includeInboxCounts ? 1 : 0,
                badgeModel.deviceOverrides.badge.includeFriendRequestsInboxCount ? 1 : 0,
                badgeModel.deviceOverrides.badge.includeDesktopNonNumericDot ? 1 : 0,
                buildCachedRecordSignature(state.sessions, sessionSignatureCache, buildSessionActivitySignature),
                buildOrdinaryRowsSignature(state, renderableSignatureCache, buildRenderableActivitySignature),
                buildSessionListIndexSignature(state.sessionListIndexByServerId),
                buildConcurrentCacheSignature(state.concurrentSessionListCacheByServerId),
                buildSessionMessagesRecordSignature(sessionIds, state.sessionMessages, sessionMessagesSignatureCache),
                buildRuntimeFreshnessRecordSignature(
                    state.sessions,
                    state.sessionMessages,
                    nowMs,
                    pendingRequestObservedAtCache,
                    sessionSignatureCache,
                    sessionMessagesSignatureCache,
                ),
                buildOrdinaryRowsSignature(
                    state,
                    new Map(),
                    (renderable) => buildRenderableRuntimeFreshnessSignature(renderable, nowMs),
                ),
            ]);

        if (previousSignature === snapshotSignature && previousSnapshot && !boundaryReached && !clockMovedBackwards && !ruleSourceChanged) {
            previousDeltaRevision = renderableDelta?.revision ?? null;
            previousNowMs = nowMs;
            return previousSnapshot;
        }

        previousSignature = snapshotSignature;
        previousDeltaRevision = renderableDelta?.revision ?? null;
        previousNowMs = nowMs;
        if (badgeModel.channelDisabled || !badgeModel.policyReady) {
            previousSnapshot = {
                nextRefreshAtMs: nextPolicyBoundaryMs,
                channelDisabled: badgeModel.channelDisabled,
                policyReady: badgeModel.policyReady,
                hasLocalActivitySource: localSourceAvailable,
                isDataReady: state.isDataReady,
                localBadgeState: { count: 0, showNonNumericDot: false },
                sessionOptions: badgeModel.sessionOptions,
            };
            return previousSnapshot;
        }

        const summary = buildActivityOverviewSummaryFromSource({
            source: buildActivitySourceFromState(state, {
                personalSessionListCoverageComplete: params.personalSessionListCoverageComplete,
                personalSessionListMembershipByServerId,
                ruleSessionMembershipByServerId,
                personalSessionListQueryStatesByServerId: params.personalSessionListQueryStatesByServerId,
                personalFollowRulesByServerId: params.personalFollowRulesByServerId,
            }, ruleSource ?? undefined),
            nowMs,
            resolveSessionOptionsForServerId: badgeModel.resolveSessionOptionsForServerId,
            includeHydratedMessages: true,
            includeWarmSourceWhenNotReady: true,
        });

        previousSnapshot = {
            nextRefreshAtMs: summary.nextAttentionBoundaryMs === null
                ? nextPolicyBoundaryMs
                : nextPolicyBoundaryMs === null
                    ? summary.nextAttentionBoundaryMs
                    : Math.min(summary.nextAttentionBoundaryMs, nextPolicyBoundaryMs),
            channelDisabled: false,
            policyReady: true,
            hasLocalActivitySource: localSourceAvailable,
            isDataReady: state.isDataReady,
            localBadgeState: buildActivityBadgeStateFromAttentionCount({
                attentionCount: summary.totalAttentionCount,
                numericInboxCount:
                    !badgeModel.includeInboxCounts
                    || !badgeModel.deviceOverrides.badge.includeFriendRequestsInboxCount
                        ? 0
                        : params.friendRequestCount,
                hasNonNumericInboxAttention:
                    badgeModel.includeInboxCounts
                    && badgeModel.deviceOverrides.badge.includeDesktopNonNumericDot
                    && params.hasNonNumericInboxAttention,
            }),
            sessionOptions: badgeModel.sessionOptions,
        };
        return previousSnapshot;
    };
}
