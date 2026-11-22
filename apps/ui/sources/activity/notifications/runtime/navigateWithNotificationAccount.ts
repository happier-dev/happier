import { AppState } from 'react-native';

import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';

import { resolveNotificationPermissionTarget } from './resolveNotificationPermissionTarget';

export type NotificationAccountNavigationTarget = Readonly<{
    serverUrl: string | null;
    route: string;
    accountId?: string | null;
    expectedScope?: ServerAccountScope;
}>;

let latestNavigationIntent: symbol | null = null;

export type NotificationNavigationIntent = Readonly<{ isCurrent: () => boolean }>;

/** Carry the accepted click through any Home work before Account admission. */
export function claimNotificationNavigationIntent(): NotificationNavigationIntent {
    const intent = Symbol();
    latestNavigationIntent = intent;
    return { isCurrent: () => latestNavigationIntent === intent };
}

export async function navigateWithNotificationAccount(params: Readonly<{
    target: NotificationAccountNavigationTarget;
    navigate: () => void;
    refreshAuth: (() => Promise<void>) | null;
    isDisposed: () => boolean;
    intent?: NotificationNavigationIntent;
}>): Promise<void> {
    const { target, navigate, refreshAuth } = params;
    if (params.isDisposed()) return;
    const intent = params.intent ?? claimNotificationNavigationIntent();
    // A newer click owns navigation while an earlier Home admission is pending.
    const isInactive = () => params.isDisposed() || !intent.isCurrent();
    if (isInactive()) return;
    const accountId = target.expectedScope?.accountId ?? target.accountId;
    try {
        if (!target.expectedScope && !accountId) {
            navigate();
            return;
        }
        if (target.expectedScope && target.accountId && target.accountId !== accountId) {
            throw new Error('Notification Account does not match');
        }
        const scope = target.serverUrl
            ? await resolveNotificationPermissionTarget(target.serverUrl, accountId)
            : null;
        if (!scope || (target.expectedScope && !areServerAccountScopesEqual(scope, target.expectedScope))) {
            throw new Error('Notification Account unavailable');
        }
        const routeServerId = readSessionRouteServerId({
            serverId: new URL(target.route, 'https://happier.invalid').searchParams.get('serverId'),
        });
        if (routeServerId && !areServerProfileIdentifiersEquivalent(routeServerId, scope.serverId)) {
            throw new Error('Notification route Home does not match');
        }
        const profile = getServerProfileById(scope.serverId);
        if (!profile) throw new Error('Notification Home unavailable');
        if (isInactive()) return;
        await setActiveServerAndSwitch({ serverId: profile.id, scope: 'device', refreshAuth });
        if (isInactive()) return;
        const currentProfile = getServerProfileById(scope.serverId);
        if (!currentProfile || !areServerAccountScopesEqual(
            await resolveNotificationPermissionTarget(currentProfile.serverUrl, accountId), scope,
        ) || !areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, scope.serverId)) {
            throw new Error('Notification Account changed');
        }
        if (!isInactive()) navigate();
    } catch {
        if (isInactive()) return;
        console.warn('[notifications] Session navigation Account unavailable');
        const [{ Modal }, { t }] = await withTimeout(
            () => Promise.all([import('@/modal'), import('@/text')]),
            EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS,
            'notification navigation UI module load',
        );
        if (!isInactive() && AppState.currentState === 'active') {
            Modal.alert(t('common.error'), t('notifications.permissionActionReviewUnavailable'));
        }
    }
}
