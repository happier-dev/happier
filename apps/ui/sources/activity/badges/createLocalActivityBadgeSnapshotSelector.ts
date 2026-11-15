import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';

import { createActivityOverviewSummaryProjector } from '@/activity/source/activityOverviewSummaryProjector';
import type { ActivityOverviewSummary } from '@/activity/source/buildActivityOverviewFromSource';
import { createActivityAttentionStoreSourceSelector } from '@/activity/source/createActivityAttentionStoreSourceSelector';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { ActivitySourceProjector } from '@/activity/source/sharedActivitySourceProjection';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import type { ActivityAttentionDeliveryEventKind } from '@/activity/delivery/activityAttentionDeliveryPlanTypes';
import { readNextActivityAttentionDeliveryBoundaryMs, resolveActivityAttentionDeliveryPlan } from '@/activity/delivery/resolveActivityAttentionDeliveryPlan';
import type { StorageState } from '@/sync/store/types';

import { buildActivityBadgeStateFromAttentionCount, type ActivityBadgeSessionOptions } from './buildActivityBadgeState';
import { forEachRecordValue, hasRecordValues } from '../source/recordIteration';

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

const EMPTY_INDEX_BY_SERVER_ID: ActivityAttentionSource['sessionListIndexByServerId'] = {};
const EMPTY_CONCURRENT_CACHE_BY_SERVER_ID: ActivityAttentionSource['concurrentSessionListCacheByServerId'] = {};
/** Every policy field of the badge source is identity-stable, so the summary table stays incremental. */
const EMPTY_SERVER_PROFILES_BY_ID: ActivityAttentionSource['serverProfilesById'] = {};

function joinSignatureParts(parts: readonly unknown[]): string {
    return parts.map((part) => {
        const value = part == null ? '' : String(part);
        return `${value.length}:${value}`;
    }).join('');
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
        serverProfilesById: EMPTY_SERVER_PROFILES_BY_ID,
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
    const personalSessionListMembershipByServerId = params.personalSessionListMembershipByServerId ?? {};
    const ruleSessionMembershipByServerId = includesRuleFacts ? params.ruleSessionMembershipByServerId ?? {} : {};
    const personalSource = {
        personalSessionListCoverageComplete: params.personalSessionListCoverageComplete,
        personalSessionListMembershipByServerId,
        ruleSessionMembershipByServerId,
        personalSessionListQueryStatesByServerId: params.personalSessionListQueryStatesByServerId,
        personalFollowRulesByServerId: params.personalFollowRulesByServerId,
    };
    let previousRuleSource: ReturnType<NonNullable<typeof selectRuleSource>> | null = null;
    let previousSnapshot: LocalActivityBadgeSnapshot | null = null;
    let previousNowMs: number | null = null;
    let previousSourceIdentity: BadgeSnapshotSourceIdentity | null = null;
    let nextPolicyBoundaryMs: number | null = null;
    let policyBoundaryReadAtMs: number | null = null;
    // The canonical per-address summary: a publication re-classifies the Sessions the store names.
    // It is rebuilt for a new per-Home policy and at every time boundary, so time-sensitive facts
    // are classified again at the new instant.
    let summaryProjector: ActivitySourceProjector<ActivityOverviewSummary> | null = null;
    let summaryPolicy: string | null = null;

    return (state) => {
        const ruleSource = selectRuleSource?.(state) ?? null;
        const ruleSourceChanged = ruleSource !== previousRuleSource;
        previousRuleSource = ruleSource;
        const nowMs = Date.now();
        const clockMovedBackwards = previousNowMs !== null && nowMs < previousNowMs;
        const boundaryReached = previousSnapshot?.nextRefreshAtMs != null && nowMs >= previousSnapshot.nextRefreshAtMs;
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
        previousNowMs = nowMs;

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
        const badgeModel = resolveBadgeModel(params, parsedLocalSettings, now, state.profileScope?.serverId ?? null);
        const localSourceAvailable = hasLocalActivitySource(state, personalSessionListMembershipByServerId, ruleSessionMembershipByServerId)
            || params.friendRequestCount > 0
            || params.hasNonNumericInboxAttention;
        if (badgeModel.channelDisabled || !badgeModel.policyReady) {
            summaryProjector = null;
            previousSnapshot = keepEqualSnapshot(previousSnapshot, {
                nextRefreshAtMs: nextPolicyBoundaryMs,
                channelDisabled: badgeModel.channelDisabled,
                policyReady: badgeModel.policyReady,
                hasLocalActivitySource: localSourceAvailable,
                isDataReady: state.isDataReady,
                localBadgeState: { count: 0, showNonNumericDot: false },
                sessionOptions: badgeModel.sessionOptions,
            });
            return previousSnapshot;
        }

        const policy = joinSignatureParts(badgeModel.homeSignatureParts);
        if (summaryProjector === null || summaryPolicy !== policy || boundaryReached || clockMovedBackwards) {
            summaryProjector = createActivityOverviewSummaryProjector({
                resolveSessionOptionsForServerId: badgeModel.resolveSessionOptionsForServerId,
                includeHydratedMessages: true,
            });
            summaryPolicy = policy;
        }
        const summary = summaryProjector.project({
            source: buildActivitySourceFromState(state, personalSource, ruleSource ?? undefined),
            nowMs,
            state,
        });

        previousSnapshot = keepEqualSnapshot(previousSnapshot, {
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
        });
        return previousSnapshot;
    };
}

/**
 * A recomputation whose result equals the published snapshot republishes nothing: the badge
 * runtime reads this through `useShallow`, so a new object with equal facts (one per streamed
 * transcript delta of a viewed Session) re-rendered it on every arrival.
 */
function keepEqualSnapshot(
    previous: LocalActivityBadgeSnapshot | null,
    next: LocalActivityBadgeSnapshot,
): LocalActivityBadgeSnapshot {
    if (previous === null) return next;
    return previous.nextRefreshAtMs === next.nextRefreshAtMs
        && previous.channelDisabled === next.channelDisabled
        && previous.policyReady === next.policyReady
        && previous.hasLocalActivitySource === next.hasLocalActivitySource
        && previous.isDataReady === next.isDataReady
        && previous.localBadgeState.count === next.localBadgeState.count
        && previous.localBadgeState.showNonNumericDot === next.localBadgeState.showNonNumericDot
        && previous.sessionOptions.showPendingPermissionRequests === next.sessionOptions.showPendingPermissionRequests
        && previous.sessionOptions.showPendingUserActionRequests === next.sessionOptions.showPendingUserActionRequests
        && previous.sessionOptions.showUnread === next.sessionOptions.showUnread
        ? previous
        : next;
}
