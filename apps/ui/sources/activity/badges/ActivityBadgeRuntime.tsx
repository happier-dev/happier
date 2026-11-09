import * as React from 'react';

import { Platform } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import type { AccountSettings } from '@happier-dev/protocol/account/settings/accountSettings';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useChangelog } from '@/hooks/inbox/useChangelog';
import { useUpdates } from '@/hooks/inbox/useUpdates';
import { storage, useFriendRequestCount, useLocalSetting } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useExactHomeAccountSettings } from '@/activity/delivery/useExactHomeAccountSettings';
import { useActivityPersonalSessionMembership } from '@/activity/source/activityPersonalSessionMembership';
import { useActivityBoundaryRefresh } from '@/activity/source/useActivityBoundaryRefresh';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeResolutions } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { applyExpoNativeBadgeState } from './channels/applyExpoNativeBadgeState';
import { applyTauriBadgeState } from './channels/applyTauriBadgeState';
import {
    createLocalActivityBadgeSnapshotSelector,
    type LocalActivityBadgeSnapshot,
    type LocalActivityBadgeSnapshotSelectorParams,
} from './createLocalActivityBadgeSnapshotSelector';

type ServerBadgeSnapshot = Readonly<{
    count: number;
    serverGeneration: number;
    serverId: string;
}>;

async function fetchServerBadgeCount(): Promise<number | null> {
    try {
        const response = await serverFetch('/v1/account/activity/badge-snapshot', {
            method: 'GET',
        }, { retry: 'none' });
        if (!response.ok) return null;
        const json = await response.json();
        const badgeCount = (json as { badgeCount?: unknown } | null | undefined)?.badgeCount;
        return typeof badgeCount === 'number' && Number.isInteger(badgeCount) && badgeCount >= 0 ? badgeCount : null;
    } catch {
        return null;
    }
}

function canUseServerBadgeSnapshot(options: LocalActivityBadgeSnapshot['sessionOptions']): boolean {
    return options.showUnread
        && options.showPendingPermissionRequests
        && options.showPendingUserActionRequests;
}

function useActivityBadgeLocalSettingsInput(): LocalActivityBadgeSnapshotSelectorParams['localSettings'] {
    const attentionDeviceOverridesV1 = useLocalSetting('attentionDeviceOverridesV1');
    const activityBadgesEnabled = useLocalSetting('activityBadgesEnabled');
    const activityBadgeShowUnread = useLocalSetting('activityBadgeShowUnread');
    const activityBadgeShowPendingPermissionRequests = useLocalSetting('activityBadgeShowPendingPermissionRequests');
    const activityBadgeShowPendingUserActionRequests = useLocalSetting('activityBadgeShowPendingUserActionRequests');
    const activityBadgeShowQueuedUserInput = useLocalSetting('activityBadgeShowQueuedUserInput');
    const activityBadgeShowFriendRequestsInboxCount = useLocalSetting('activityBadgeShowFriendRequestsInboxCount');
    const activityBadgeShowDesktopNonNumericDot = useLocalSetting('activityBadgeShowDesktopNonNumericDot');

    return React.useMemo(() => ({
        attentionDeviceOverridesV1,
        activityBadgesEnabled,
        activityBadgeShowUnread,
        activityBadgeShowPendingPermissionRequests,
        activityBadgeShowPendingUserActionRequests,
        activityBadgeShowQueuedUserInput,
        activityBadgeShowFriendRequestsInboxCount,
        activityBadgeShowDesktopNonNumericDot,
    }), [
        activityBadgeShowDesktopNonNumericDot,
        activityBadgeShowFriendRequestsInboxCount,
        activityBadgeShowPendingPermissionRequests,
        activityBadgeShowPendingUserActionRequests,
        activityBadgeShowQueuedUserInput,
        activityBadgeShowUnread,
        activityBadgesEnabled,
        attentionDeviceOverridesV1,
    ]);
}

/**
 * Each badge-corpus Home's own persisted Account policy.
 *
 * The badge aggregates Sessions from every Home onto one app icon, so it reads each Home's exact
 * Account settings through the canonical exact-Home resolver every other Activity channel uses.
 * Reading the *active* Account's `attentionDeliveryPolicyV1` instead applied one Home's preference
 * to the whole corpus, which made switching the active Home change whether a sibling Home's
 * Sessions were eligible. A Home whose Account this device cannot name is absent here and the
 * snapshot owner fails closed for it.
 */
function useActivityBadgeAccountSettingsByServerId(
    badgeHomeServerIds: readonly string[],
): LocalActivityBadgeSnapshotSelectorParams['accountSettingsByServerId'] {
    const scopeResolutions = useServerCredentialAccountScopeResolutions(badgeHomeServerIds);
    const badgeHomeScopes = React.useMemo(() => {
        const scopes = new Map<string, ServerAccountScope>();
        for (const [serverId, resolution] of scopeResolutions) {
            if (resolution.kind === 'bound') scopes.set(serverId, resolution.scope);
        }
        return scopes;
    }, [scopeResolutions]);
    const resolveExactHomeAccountSettings = useExactHomeAccountSettings(badgeHomeScopes);

    return React.useMemo(() => {
        const accountSettingsByServerId: Record<string, Partial<AccountSettings>> = {};
        for (const serverId of badgeHomeServerIds) {
            const exactHomeAccountSettings = resolveExactHomeAccountSettings(serverId);
            if (exactHomeAccountSettings) accountSettingsByServerId[serverId] = exactHomeAccountSettings;
        }
        return accountSettingsByServerId;
    }, [badgeHomeServerIds, resolveExactHomeAccountSettings]);
}

function useLocalActivityBadgeSnapshot(
    params: LocalActivityBadgeSnapshotSelectorParams,
): LocalActivityBadgeSnapshot {
    const [, advanceBoundary] = React.useReducer((version: number) => version + 1, 0);
    const selector = React.useMemo(
        () => createLocalActivityBadgeSnapshotSelector(params),
        [params],
    );
    const snapshot = storage(useShallow(selector));
    useActivityBoundaryRefresh(snapshot.nextRefreshAtMs, advanceBoundary);
    return snapshot;
}

export function ActivityBadgeRuntime(): React.ReactElement | null {
    // This existing device bootstrap also seeds the first-install changelog
    // baseline on web; it is independent of Account badge-source demand.
    const { hasUnread: changelogHasUnread } = useChangelog();
    if (Platform.OS === 'web' && !isDesktopHost()) return null;
    return <SupportedActivityBadgeRuntime changelogHasUnread={changelogHasUnread} />;
}

function SupportedActivityBadgeRuntime({ changelogHasUnread }: Readonly<{ changelogHasUnread: boolean }>): React.ReactElement | null {
    const friendRequestCount = useFriendRequestCount();
    const localSettings = useActivityBadgeLocalSettingsInput();
    const activeServer = useActiveServerSnapshot();
    const personalSessionMembership = useActivityPersonalSessionMembership();
    // The existing canonical Activity Home set: every saved Home plus the active one. Reusing the
    // personal-query membership keys keeps one owner for "which Homes does Activity cover".
    const personalMembershipByServerId = personalSessionMembership.membershipByServerId;
    const badgeHomeServerIdsKey = Object.keys(personalMembershipByServerId).sort().join('\u0000');
    const badgeHomeServerIds = React.useMemo(
        () => (badgeHomeServerIdsKey ? badgeHomeServerIdsKey.split('\u0000') : []),
        [badgeHomeServerIdsKey],
    );
    const accountSettingsByServerId = useActivityBadgeAccountSettingsByServerId(badgeHomeServerIds);
    const { updateAvailable } = useUpdates();
    const isDesktopShell = isDesktopHost();
    const [serverBadgeSnapshot, setServerBadgeSnapshot] = React.useState<ServerBadgeSnapshot | null>(null);
    const hasNonNumericInboxAttention = updateAvailable || changelogHasUnread;
    const badgeSnapshotParams = React.useMemo<LocalActivityBadgeSnapshotSelectorParams>(() => ({
        accountSettingsByServerId,
        friendRequestCount,
        hasNonNumericInboxAttention,
        localSettings,
        personalSessionListCoverageComplete: personalSessionMembership.coverageComplete,
        personalSessionListMembershipByServerId: personalSessionMembership.membershipByServerId,
        ruleSessionMembershipByServerId: personalSessionMembership.ruleSessionMembershipByServerId,
        personalSessionListQueryStatesByServerId: personalSessionMembership.statesByServerId,
        personalFollowRulesByServerId: personalSessionMembership.followRulesByServerId,
    }), [
        accountSettingsByServerId,
        friendRequestCount,
        hasNonNumericInboxAttention,
        localSettings,
        personalSessionMembership.coverageComplete,
        personalSessionMembership.membershipByServerId,
        personalSessionMembership.ruleSessionMembershipByServerId,
        personalSessionMembership.statesByServerId,
        personalSessionMembership.followRulesByServerId,
    ]);
    const localBadgeSnapshot = useLocalActivityBadgeSnapshot(badgeSnapshotParams);

    const serverSnapshotAllowed = localBadgeSnapshot.policyReady
        && !localBadgeSnapshot.channelDisabled
        && canUseServerBadgeSnapshot(localBadgeSnapshot.sessionOptions);

    React.useEffect(() => {
        if (!serverSnapshotAllowed || !activeServer.serverId || !activeServer.serverUrl) {
            setServerBadgeSnapshot(null);
            return;
        }

        let cancelled = false;
        setServerBadgeSnapshot(null);
        void fetchServerBadgeCount().then((count) => {
            if (cancelled || count === null) return;
            setServerBadgeSnapshot({
                count,
                serverGeneration: activeServer.generation,
                serverId: activeServer.serverId,
            });
        });

        return () => {
            cancelled = true;
        };
    }, [
        activeServer.generation,
        activeServer.serverId,
        activeServer.serverUrl,
        serverSnapshotAllowed,
    ]);

    const badgeState = React.useMemo(() => {
        // Until one Home has answered with its own badge policy there is no truthful value to
        // write: clearing to 0 here would wipe a correct badge on every launch.
        if (!localBadgeSnapshot.policyReady) return null;
        if (localBadgeSnapshot.channelDisabled) return localBadgeSnapshot.localBadgeState;
        // Every source below answers for one Home: `isDataReady` is the active Home's own
        // bootstrap flag, the warm local source is whatever has landed so far, and the server
        // snapshot is fetched for the active Home alone. The badge the OS already shows was
        // written by whoever wrote last; replacing it with a number this app knows is short is
        // worse than leaving it, so a corpus spanning several Homes waits for its coverage.
        // One Home cannot be partial across Homes and never waits.
        if (badgeHomeServerIds.length > 1 && !personalSessionMembership.coverageComplete) return null;
        if (localBadgeSnapshot.isDataReady || localBadgeSnapshot.hasLocalActivitySource) {
            return localBadgeSnapshot.localBadgeState;
        }
        if (
            serverSnapshotAllowed
            && serverBadgeSnapshot
            && serverBadgeSnapshot.serverGeneration === activeServer.generation
            && serverBadgeSnapshot.serverId === activeServer.serverId
        ) {
            return { count: serverBadgeSnapshot.count, showNonNumericDot: false };
        }
        return null;
    }, [
        activeServer.generation,
        activeServer.serverId,
        badgeHomeServerIds,
        localBadgeSnapshot,
        personalSessionMembership.coverageComplete,
        serverBadgeSnapshot,
        serverSnapshotAllowed,
    ]);

    const badgeCount = badgeState?.count;
    const showNonNumericDot = badgeState?.showNonNumericDot;

    React.useEffect(() => {
        if (badgeCount === undefined || showNonNumericDot === undefined) return;
        const nextBadgeState = {
            count: badgeCount,
            showNonNumericDot,
        };
        if (isDesktopShell) {
            fireAndForget(applyTauriBadgeState(nextBadgeState), {
                tag: 'ActivityBadgeRuntime.applyTauriBadgeState',
            });
            return;
        }

        fireAndForget(applyExpoNativeBadgeState(nextBadgeState), {
            tag: 'ActivityBadgeRuntime.applyExpoNativeBadgeState',
        });
    }, [badgeCount, isDesktopShell, showNonNumericDot]);

    return null;
}
