import { router } from 'expo-router';
import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { areServerProfileIdentifiersEquivalent, getActiveServerSnapshot, getActiveServerUrl, getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } from '@/sync/domains/pending/pendingNotificationNav';
import {
    clearPendingNotificationAction,
    getPendingNotificationAction,
} from '@/sync/domains/pending/pendingNotificationAction';
import { EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS, loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { withTimeout } from '@/utils/timing/time';
import { navigateToSessionRoute } from '@/hooks/session/navigateToSessionRoute';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { readSessionIdFromPathname } from '@/components/sessions/shell/readSessionIdFromPathname';
import { executeNotificationPermissionAction } from './notificationPermissionActions';
import { markNotificationResponseHandled, wasNotificationResponseHandled } from './notificationResponseConsumption';
import { consumeNotificationPermissionRecoveryNotice, markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';
import { findSavedNotificationServerProfile as findSavedServerProfileForUrl, resolveNotificationPermissionTarget } from './resolveNotificationPermissionTarget';

import { isNotificationExecutionAction, isUnsafeNotificationServerUrl, parseNotificationTap } from '../notificationRouting';

type ExpoNotificationsWithClear = ExpoNotificationsModule & Readonly<{
    clearLastNotificationResponseAsync?: () => Promise<void>;
}>;

export function useNotificationResponseRouting(params: Readonly<{
    enabled: boolean;
    refreshAuth: () => Promise<void>;
}>): void {
    const refreshAuthRef = React.useRef(params.refreshAuth);
    const handledNavigationResponsesRef = React.useRef(new Set<string>());

    React.useEffect(() => {
        refreshAuthRef.current = params.refreshAuth;
    }, [params.refreshAuth]);

    React.useEffect(() => {
        if (!params.enabled) {
            return;
        }

        if (Platform.OS === 'web') return;

        let disposed = false;
        const showRecoveryIfActive = async () => {
            if (disposed || AppState.currentState !== 'active') return;
            try {
                const [{ Modal }, { t }] = await withTimeout(
                    () => Promise.all([import('@/modal'), import('@/text')]),
                    EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS,
                    'notification recovery UI module load',
                );
                if (disposed || AppState.currentState !== 'active') return;
                const notice = consumeNotificationPermissionRecoveryNotice();
                if (!notice) return;
                Modal.alert(t('common.error'), t('notifications.permissionActionNeedsReview'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('notifications.actions.reviewPendingRequests'),
                        onPress: () => {
                            fireAndForget((async () => {
                                try {
                                    if (AppState.currentState !== 'active') return;
                                    if (notice.target) {
                                        const target = notice.target;
                                        const profile = getServerProfileById(target.serverId);
                                        if (!profile || !areServerAccountScopesEqual(
                                            await resolveNotificationPermissionTarget(profile.serverUrl, target.accountId), target,
                                        )) throw new Error('Recovery target unavailable');
                                        if (AppState.currentState !== 'active') return;
                                        // Switching is an explicit presentation action. Recheck
                                        // after it settles so changed credentials/Home cannot
                                        // redirect the user into another Account's Inbox.
                                        await setActiveServerAndSwitch({
                                            serverId: profile.id,
                                            scope: 'device',
                                            refreshAuth: refreshAuthRef.current,
                                        });
                                        const currentProfile = getServerProfileById(target.serverId);
                                        if (!currentProfile || !areServerAccountScopesEqual(
                                            await resolveNotificationPermissionTarget(currentProfile.serverUrl, target.accountId), target,
                                        ) || !areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, target.serverId)) {
                                            throw new Error('Recovery target changed');
                                        }
                                    }
                                    if (AppState.currentState === 'active') router.push('/(app)/inbox');
                                } catch {
                                    console.warn('[notifications] Permission action review target unavailable');
                                    if (AppState.currentState === 'active') {
                                        Modal.alert(t('common.error'), t('notifications.permissionActionReviewUnavailable'));
                                    }
                                }
                            })(), { tag: 'notificationPermissionAction.review' });
                        },
                    },
                ]);
            } catch {
                console.warn('[notifications] Permission action recovery unavailable');
            }
        };

        const navigateWithNotificationAccount = (
            target: Readonly<{ serverUrl: string | null; route: string; accountId?: string | null }>,
            navigate: () => void,
        ): void => {
            if (!target.accountId) {
                navigate();
                return;
            }
            fireAndForget((async () => {
                try {
                    const scope = target.serverUrl
                        ? await resolveNotificationPermissionTarget(target.serverUrl, target.accountId)
                        : null;
                    if (!scope) throw new Error('Notification Account unavailable');
                    const routeServerId = readSessionRouteServerId({
                        serverId: new URL(target.route, 'https://happier.invalid').searchParams.get('serverId'),
                    });
                    if (routeServerId && !areServerProfileIdentifiersEquivalent(routeServerId, scope.serverId)) {
                        throw new Error('Notification route Home does not match');
                    }
                    const profile = getServerProfileById(scope.serverId);
                    if (!profile) throw new Error('Notification Home unavailable');
                    if (disposed) return;
                    await setActiveServerAndSwitch({
                        serverId: profile.id,
                        scope: 'device',
                        refreshAuth: refreshAuthRef.current,
                    });
                    const currentProfile = getServerProfileById(scope.serverId);
                    if (!currentProfile || !areServerAccountScopesEqual(
                        await resolveNotificationPermissionTarget(currentProfile.serverUrl, target.accountId), scope,
                    ) || !areServerProfileIdentifiersEquivalent(getActiveServerSnapshot().serverId, scope.serverId)) {
                        throw new Error('Notification Account changed');
                    }
                    if (!disposed) navigate();
                } catch {
                    console.warn('[notifications] Session navigation Account unavailable');
                    const [{ Modal }, { t }] = await withTimeout(
                        () => Promise.all([import('@/modal'), import('@/text')]),
                        EXPO_NOTIFICATIONS_LOAD_TIMEOUT_MS,
                        'notification navigation UI module load',
                    );
                    if (!disposed && AppState.currentState === 'active') {
                        Modal.alert(t('common.error'), t('notifications.permissionActionReviewUnavailable'));
                    }
                }
            })(), { tag: 'notificationSessionNavigation' });
        };

        const pendingAction = getPendingNotificationAction();
        if (pendingAction && Platform.OS === 'android') {
            // Old versions queued actions across server switches. Do not replay an
            // old decision when adopting background actions: require in-app review.
            clearPendingNotificationAction();
            try {
                markNotificationPermissionRecoveryNeeded();
            } catch {
                console.warn('[notifications] Permission action recovery storage unavailable');
            }
            console.warn('[notifications] Saved permission action requires in-app review');
        }
        if (pendingAction && Platform.OS !== 'android') {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pendingAction.serverUrl) === active) {
                clearPendingNotificationAction();
                // Legacy pending records have no occurrence identity and are review-only.
                const saved = findSavedServerProfileForUrl(pendingAction.serverUrl);
                fireAndForget((async () => {
                    navigateToSessionRoute({ router, sessionId: pendingAction.sessionId, serverId: saved?.id, refreshAuth: refreshAuthRef.current });
                })(), { tag: 'RootLayout.pendingNotificationAction' });
                return;
            }
        }

        const pending = getPendingNotificationNav();
        if (pending) {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pending.serverUrl) === active) {
                clearPendingNotificationNav();
                navigateWithNotificationAccount(pending, () => { router.push(pending.route); });
                return () => { disposed = true; };
            }
        }

        const maybeRedirectFromResponse = (response: unknown, defaultActionIdentifier: string, allowExecution = true) => {
            let parsed = parseNotificationTap({
                response,
                defaultActionIdentifier,
            });
            if (!parsed) return;

            // Native foregrounding does not control callback ownership. Every
            // live permission response uses the same executor without navigation.
            if (isNotificationExecutionAction(parsed)) {
                if (allowExecution) {
                    fireAndForget(executeNotificationPermissionAction(parsed).then(showRecoveryIfActive), { tag: 'notificationPermissionAction' });
                    return;
                }
                // A cached response only opens review. Native background delivery
                // and live listeners own execution through the shared executor.
                if (wasNotificationResponseHandled(parsed)) return;
                markNotificationResponseHandled(parsed);
                parsed = { ...parsed, permissionAction: null, questionAction: null, isOpenAction: true };
            }

            if (!isNotificationExecutionAction(parsed) && parsed.dedupeKey) {
                if (handledNavigationResponsesRef.current.has(parsed.dedupeKey)) return;
                handledNavigationResponsesRef.current.add(parsed.dedupeKey);
            }

            if (!parsed.route) return;

            const route = parsed.route;
            const routeSessionId = parsed.routeSessionId;
            const serverUrl = parsed.serverUrl;
            const savedTarget = serverUrl ? findSavedServerProfileForUrl(serverUrl) : null;
            const targetsSession = routeSessionId !== null
                || readSessionIdFromPathname(new URL(route, 'https://happier.invalid').pathname) !== null;
            const navigationTarget = { serverUrl, route, accountId: targetsSession ? parsed.accountId : null };
            const rememberNavigationForServer = (targetServerUrl: string) => {
                setPendingNotificationNav({ serverUrl: targetServerUrl, route,
                    ...(navigationTarget.accountId ? { accountId: navigationTarget.accountId } : {}),
                });
            };
            const navigateToRoute = (serverId?: string) => {
                navigateWithNotificationAccount(navigationTarget, () => {
                    if (routeSessionId) {
                        navigateToSessionRoute({ router, sessionId: routeSessionId, serverId, refreshAuth: refreshAuthRef.current });
                    } else {
                        router.push(route);
                    }
                });
            };
            const routeToServerSettingsForUrl = (url: string) => {
                router.push(`/settings/server?url=${encodeURIComponent(url)}&source=notification`);
            };

            if (routeSessionId && (!serverUrl || savedTarget)) {
                navigateToRoute(savedTarget?.id);
                return;
            }

            if (serverUrl) {
                const active = normalizeServerUrl(getActiveServerUrl());
                if (serverUrl !== active) {
                    const saved = findSavedServerProfileForUrl(serverUrl);
                    if (saved) {
                        rememberNavigationForServer(saved.serverUrl);
                        fireAndForget((async () => {
                            try {
                                await setActiveServerAndSwitch({
                                    serverId: saved.id,
                                    scope: 'device',
                                    refreshAuth: refreshAuthRef.current,
                                });
                                clearPendingNotificationNav();
                                navigateToRoute(saved.id);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.savedServer' });
                        return;
                    }

                    if (isUnsafeNotificationServerUrl(serverUrl)) {
                        // Unsafe/mismatched server url: fail closed for actions; navigate only.
                        navigateWithNotificationAccount(navigationTarget, () => { router.push(route); });
                        return;
                    }

                    if (listServerProfiles().length === 0) {
                        rememberNavigationForServer(serverUrl);
                        fireAndForget((async () => {
                            try {
                                await upsertActivateAndSwitchServer({
                                    serverUrl,
                                    source: 'notification',
                                    scope: 'device',
                                    refreshAuth: refreshAuthRef.current,
                                });
                                clearPendingNotificationNav();
                                navigateToRoute(findSavedServerProfileForUrl(serverUrl)?.id);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.autoAddServer' });
                        return;
                    }
                    // Servers exist but the target isn't saved: redirect to server settings with a prefilled url.
                    rememberNavigationForServer(serverUrl);
                    routeToServerSettingsForUrl(serverUrl);
                    return;
                }
            }

            if (parsed.isOpenAction) {
                navigateWithNotificationAccount(navigationTarget, () => { router.push(route); });
            }
        };

        const recoverySubscription = AppState.addEventListener('change', (state) => {
            if (state === 'active') void showRecoveryIfActive();
        });
        void showRecoveryIfActive();
        let subscription: { remove: () => void } | null = null;
        void loadExpoNotifications()
            .then((Notifications) => {
                if (disposed) return;
                const defaultActionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER;
                void Notifications.getLastNotificationResponseAsync()
                    .then(async (response) => {
                        if (disposed || !response) return;
                        maybeRedirectFromResponse(response, defaultActionIdentifier, false);
                        const clearLastNotificationResponseAsync = (Notifications as ExpoNotificationsWithClear).clearLastNotificationResponseAsync;
                        if (typeof clearLastNotificationResponseAsync === 'function') {
                            await clearLastNotificationResponseAsync();
                        }
                    })
                    .catch(() => {});

                subscription = Notifications.addNotificationResponseReceivedListener((response) => {
                    maybeRedirectFromResponse(response, defaultActionIdentifier);
                });
            })
            .catch(() => {});

        return () => {
            disposed = true;
            subscription?.remove();
            recoverySubscription?.remove();
        };
    }, [params.enabled]);
}
