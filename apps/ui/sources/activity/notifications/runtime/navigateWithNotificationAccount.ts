import { AppState, Platform } from 'react-native';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { navigateToSession, type SessionNavigationRouter } from '@/hooks/session/useNavigateToSession';
import { matchWorkspaceDestinationRoute } from '@/components/appShell/workspace/workspaceRoutes';
import { Modal } from '@/modal';
import { t } from '@/text';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { resolveNotificationSavedHome as findSavedServerProfile } from '../resolveNotificationSavedHome';

export type NotificationAccountNavigationTarget = Readonly<{
    serverId?: string | null;
    serverUrl?: string | null;
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

/** Admits the notification's original Home and Account again before navigation. */
export async function navigateWithNotificationAccount({ target, navigate, refreshAuth, isDisposed, intent: requestedIntent }: Readonly<{
    target: NotificationAccountNavigationTarget;
    navigate: (href?: Parameters<SessionNavigationRouter['navigate']>[0],
        options?: Parameters<SessionNavigationRouter['navigate']>[1]) => void;
    refreshAuth: (() => Promise<void>) | null;
    isDisposed: () => boolean;
    intent?: NotificationNavigationIntent;
}>): Promise<void> {
    if (isDisposed()) return;
    const intent = requestedIntent ?? claimNotificationNavigationIntent();
    // A newer click owns navigation while an earlier Home admission is pending.
    const isInactive = () => isDisposed() || !intent.isCurrent();
    if (isInactive()) return;
    const accountId = target.expectedScope?.accountId ?? target.accountId;
    try {
        if (!target.expectedScope && !accountId) { navigate(); return; }
        if (target.expectedScope && target.accountId && target.accountId !== accountId) {
            throw new Error('Notification Account does not match');
        }
        const saved = findSavedServerProfile({ serverId: target.serverId, serverUrl: target.serverUrl ?? '' });
        if (!saved) throw new Error('Notification Home unavailable');
        const admitted = await resolveServerCredentialAccountScope(saved.id);
        if (admitted.kind !== 'bound' || admitted.scope.accountId !== accountId
            || (target.expectedScope && !areServerAccountScopesEqual(admitted.scope, target.expectedScope))) {
            throw new Error('Notification Account unavailable');
        }
        const route = new URL(target.route, 'https://internal.invalid');
        const routeServerId = readSessionRouteServerId({
            serverId: route.searchParams.get('serverId'),
        });
        if (routeServerId && !areServerProfileIdentifiersEquivalent(routeServerId, admitted.scope.serverId)) {
            throw new Error('Notification route Home does not match');
        }
        if (isInactive()) return;
        if (!areServerProfileIdentifiersEquivalent(saved.id, getActiveServerSnapshot().serverId)) {
            const switched = await setActiveServerAndSwitch({
                serverId: saved.id,
                scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                refreshAuth: refreshAuth,
            });
            if (switched === 'blocked') throw new Error('Notification Home switch blocked');
        }
        if (isInactive()) return;
        const current = await resolveServerCredentialAccountScope(saved.id);
        if (current.kind !== 'bound' || !areServerAccountScopesEqual(current.scope, admitted.scope)
            || !areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, admitted.scope.serverId)) {
            throw new Error('Notification Account changed');
        }
        if (isInactive()) return;
        const destination = matchWorkspaceDestinationRoute(route.pathname);
        if (destination?.routeKey.startsWith('session/') && destination.params.id) {
            // Account admission stays here; Session opening has the same Home,
            // telemetry and route owner as Search, menus and Voice.
            const opened = await navigateToSession(destination.params.id, {
                serverId: admitted.scope.serverId, requireActiveHome: true,
                suffix: route.pathname.replace(/^\/session\/[^/]+/, ''),
                query: Object.fromEntries(route.searchParams),
            }, {
                router: { navigate: (href, options) => { if (!isInactive()) navigate(href, options); } },
                refreshFromActiveServer: refreshAuth ?? (async () => {}),
                activeHomeScope: current.scope,
            });
            if (!opened) throw new Error('Notification Home switch blocked');
        } else navigate();
    } catch {
        if (isInactive()) return;
        console.warn('[notifications] Session navigation Account unavailable');
        if (!isInactive() && AppState.currentState === 'active') {
            Modal.alert(t('common.error'), t('notifications.permissionActionReviewUnavailable'));
        }
    }
}
