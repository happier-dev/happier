import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { router } from 'expo-router';
import { resolveHref } from 'expo-router/build/link/href';
import { withInternalRouteQueryParams } from '@/utils/path/routeUtils';
import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { connectHomeAtAddress } from '@/sync/ops/home/connectHomeAtAddress';
import { confirmCanonicalHomeUrl, confirmInsecureHomeHttp, homeConnectFailureMessage } from '@/components/homes/add/homeConnectPresentation';
import { openAddHome } from '@/components/homes/add/openAddHome';
import { Modal } from '@/modal';
import { t } from '@/text';
import { executeNotificationPermissionAction, isNotificationExecutionAction, wasNotificationResponseHandled, markNotificationResponseHandled } from './notificationPermissionActions';
import { consumeNotificationPermissionRecoveryNotice, markNotificationPermissionRecoveryNeeded } from './notificationPermissionRecovery';
import {
    areServerProfileIdentifiersEquivalent,
    getActiveServerSnapshot,
    getServerProfileById,
    listServerProfiles,
    resolveSavedServerProfileByUrl,
} from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } from '@/sync/domains/pending/pendingNotificationNav';
import {
    clearPendingNotificationAction,
    getPendingNotificationAction,
} from '@/sync/domains/pending/pendingNotificationAction';
import { loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { desktopHostKind, isDesktopHost } from '@/utils/platform/desktopHost';

import { isUnsafeNotificationServerUrl, parseNotificationTap } from '../notificationRouting';
// The same saved-Home rule names the Home of an arriving foreground notification.
import { resolveNotificationSavedHome as findSavedServerProfile } from '../resolveNotificationSavedHome';
import type { ActivityInteractionCommand } from '@/activity/actions/resolveActivityInteractionCommand';
import { executeGuardStopWarningAction, reconcileGuardStopWarningNotifications } from '../guardStopWarningLifecycle';
import { resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { claimNotificationNavigationIntent, navigateWithNotificationAccount, type NotificationAccountNavigationTarget, type NotificationNavigationIntent } from './navigateWithNotificationAccount';
import { usePluginNotificationCategories } from './usePluginNotificationCategories';
import { subscribeDesktopNotificationResponses } from '../channels/tauriNotificationPlugin';
import { usePluginPageExplicitNavigation } from '@/components/plugins/pages/pluginPageNavigation';

type ExpoNotificationsWithClear = ExpoNotificationsModule & Readonly<{
    clearLastNotificationResponseAsync?: () => Promise<void>;
}>;

function resolveNotificationCommandRoute(command: ActivityInteractionCommand): string | null {
    switch (command.kind) {
        case 'openSession':
        case 'openNotice':
        case 'openInbox':
        case 'focusComposer':
        case 'openSettings':
        case 'openWorkflowRun':
        case 'openMachine':
            return command.route;
        case 'executeAction':
            return command.route ?? createActivitySurfaceSessionRoute(command.defaultSessionId, command.target.serverId);
        case 'ignore':
        default:
            return null;
    }
}

function resolveNotificationCommandRouteForVerifiedHome(command: ActivityInteractionCommand, serverId: string): string | null {
    switch (command.kind) {
        case 'openMachine':
            return machinePageHref({ door: 'rail', target: { machineId: command.machineId, serverId }, tab: command.tab });
        case 'openSession':
        case 'focusComposer':
        case 'executeAction': {
            const route = resolveNotificationCommandRoute(command);
            return route ? withInternalRouteQueryParams(route, { serverId }) : null;
        }
        default:
            return resolveNotificationCommandRoute(command);
    }
}

function resolveNotificationCommandServerUrl(command: ActivityInteractionCommand): string | null {
    switch (command.kind) {
        case 'openSession':
        case 'focusComposer':
        case 'openWorkflowRun':
        case 'openMachine':
            return command.serverUrl;
        case 'executeAction':
            return command.target.serverUrl ?? null;
        case 'openInbox':
        case 'openSettings':
        case 'ignore':
        default:
            return null;
    }
}

function resolveNotificationCommandServerId(command: ActivityInteractionCommand): string | null {
    switch (command.kind) {
        case 'openSession':
        case 'focusComposer':
        case 'openWorkflowRun':
        case 'openMachine':
            return command.serverId;
        case 'executeAction':
            return command.target.serverId;
        case 'openInbox':
        case 'openSettings':
        case 'ignore':
        default:
            return null;
    }
}

function isNotificationServerActive(params: Readonly<{
    serverId?: string | null;
    serverUrl: string;
}>): boolean {
    const active = getActiveServerSnapshot();
    const serverId = String(params.serverId ?? '').trim();
    const targetUrlKey = createServerUrlComparableKey(params.serverUrl);
    const activeUrlKey = createServerUrlComparableKey(active.serverUrl);
    if (serverId) {
        return areServerProfileIdentifiersEquivalent(serverId, active.serverId);
    }

    const saved = resolveSavedServerProfileByUrl(params.serverUrl);
    if (saved.kind === 'resolved') {
        return areServerProfileIdentifiersEquivalent(saved.profile.id, active.serverId);
    }

    // Legacy URL-only records created before a profile was persisted can still
    // complete once their URL is the active Home. Ambiguous saved matches fail closed.
    return saved.kind === 'missing' && Boolean(targetUrlKey && targetUrlKey === activeUrlKey);
}

/**
 * Names the Home a notification was admitted for, synchronously at the moment
 * `isNotificationServerActive` proved it. An explicit notification Home wins; a
 * legacy URL-only record was only admitted because its URL is the focused Home
 * right now, so that Home is captured before any await can move focus.
 */
function resolveAdmittedNotificationServerId(serverId: string | null | undefined): string | null {
    const explicit = String(serverId ?? '').trim();
    if (explicit) return explicit;
    const active = String(getActiveServerSnapshot().serverId ?? '').trim();
    return active || null;
}

export function useNotificationResponseRouting(params: Readonly<{
    enabled: boolean;
    refreshAuth: () => Promise<void>;
}>): void {
    const navigateExplicit = usePluginPageExplicitNavigation();
    usePluginNotificationCategories(params.enabled);
    const handledNavigationResponses = React.useRef(new Set<string>());
    const refreshAuthRef = React.useRef(params.refreshAuth);

    React.useEffect(() => {
        refreshAuthRef.current = params.refreshAuth;
    }, [params.refreshAuth]);

    React.useEffect(() => {
        if (!params.enabled) {
            handledNavigationResponses.current.clear();
            return;
        }

        const nativeDesktop = isDesktopHost() && desktopHostKind() === 'tauri';
        if (Platform.OS === 'web' && !nativeDesktop) return;
        const cancellation = new AbortController();
        const showPermissionRecovery = () => {
            try {
                if ((Platform.OS !== 'android' && Platform.OS !== 'ios') || cancellation.signal.aborted || AppState.currentState !== 'active') return;
                const notice = consumeNotificationPermissionRecoveryNotice();
                if (!notice) return;
                Modal.alert(t('common.error'), t('notifications.permissionActionNeedsReview'), [
                    { text: t('common.cancel'), style: 'cancel' },
                    {
                        text: t('notifications.actions.reviewPendingRequests'),
                        onPress: () => {
                            const profile = notice.target ? getServerProfileById(notice.target.serverId) : null;
                            fireAndForget(navigateWithNotificationAccount({
                                target: { serverId: notice.target?.serverId, serverUrl: profile?.serverUrl ?? null,
                                    route: '/inbox', expectedScope: notice.target ?? undefined },
                                navigate: () => { navigateExplicit('/inbox'); },
                                refreshAuth: refreshAuthRef.current,
                                isDisposed: () => cancellation.signal.aborted || AppState.currentState !== 'active',
                            }), { tag: 'notificationPermissionAction.review' });
                        },
                    },
                ]);
            } catch {
                console.warn('[notifications] Permission action recovery unavailable');
            }
        };

        const navigateToNotificationAccount = (target: NotificationAccountNavigationTarget, navigate: () => void, intent?: NotificationNavigationIntent): void => {
            fireAndForget(navigateWithNotificationAccount({ target, navigate,
                refreshAuth: refreshAuthRef.current, isDisposed: () => cancellation.signal.aborted, intent,
            }), { tag: 'notificationSessionNavigation' });
        };

        const connectAndSwitchUnsavedHome = (serverUrl: string, route: string, command: ActivityInteractionCommand, tag: string, accountId: string | null | undefined, initialIntent: NotificationNavigationIntent): void => {
            let intent = initialIntent;
            const isInactive = () => cancellation.signal.aborted || !intent.isCurrent();
            setPendingNotificationNav({ serverUrl, route, ...(accountId ? { accountId } : {}) });
            fireAndForget((async () => {
                try {
                    const connected = await connectHomeAtAddress({
                        serverUrl,
                        source: 'notification',
                        confirmInsecureHttp: async () => {
                            const accepted = await confirmInsecureHomeHttp();
                            if (accepted && !cancellation.signal.aborted) intent = claimNotificationNavigationIntent();
                            return accepted;
                        },
                        confirmCanonicalUrl: async (addressChange) => {
                            const accepted = await confirmCanonicalHomeUrl(addressChange);
                            // Keep/Use both choose an address; a mismatch Cancel grants nothing.
                            if ((accepted || !addressChange) && !cancellation.signal.aborted) intent = claimNotificationNavigationIntent();
                            return accepted;
                        },
                    });
                    if (isInactive()) return;
                    if (connected.kind !== 'connected') {
                        if (connected.kind === 'declined') clearPendingNotificationNav();
                        const message = homeConnectFailureMessage(connected);
                        if (message) Modal.alert(t('common.error'), message);
                        return;
                    }
                    const verifiedRoute = resolveNotificationCommandRouteForVerifiedHome(command, connected.profile.id);
                    if (!verifiedRoute) return;
                    setPendingNotificationNav({
                        serverUrl: connected.profile.serverUrl,
                        serverId: connected.profile.id,
                        route: verifiedRoute,
                        ...(accountId ? { accountId } : {}),
                    });
                    const switched = await setActiveServerAndSwitch({
                        serverId: connected.profile.id,
                        scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                        refreshAuth: refreshAuthRef.current,
                    });
                    if (switched === 'blocked' || isInactive()) return;
                    clearPendingNotificationNav();
                    navigateToNotificationAccount({ serverUrl: connected.profile.serverUrl, serverId: connected.profile.id,
                        route: verifiedRoute, accountId }, () => { navigateExplicit(verifiedRoute); }, intent);
                } catch (error) {
                    if (isInactive()) return;
                    Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
                }
            })(), { tag });
        };

        const pendingAction = getPendingNotificationAction();
        if (pendingAction) {
            clearPendingNotificationAction();
            console.warn('[notifications] Saved permission action requires in-app review');
            if (Platform.OS === 'android') markNotificationPermissionRecoveryNeeded();
            else setPendingNotificationNav({ serverUrl: pendingAction.serverUrl,
                ...(pendingAction.serverId ? { serverId: pendingAction.serverId } : {}),
                route: createActivitySurfaceSessionRoute(pendingAction.sessionId, pendingAction.serverId) });
        }

        const pending = getPendingNotificationNav();
        if (pending) {
            if (isNotificationServerActive(pending)) {
                clearPendingNotificationNav();
                const admittedServerId = resolveAdmittedNotificationServerId(pending.serverId);
                const route = admittedServerId
                    ? withInternalRouteQueryParams(pending.route, { serverId: admittedServerId })
                    : pending.route;
                navigateToNotificationAccount({ ...pending, route }, () => { navigateExplicit(route); });
                return () => { cancellation.abort(); };
            }
        }

        const maybeRedirectFromResponse = (response: unknown, defaultActionIdentifier: string, allowExecution = true, expectedAccountId?: string) => {
            const parsed = parseNotificationTap({
                response,
                defaultActionIdentifier,
            });
            if (!parsed) return;
            let command = parsed.command;
            if (isNotificationExecutionAction(parsed)) {
                if (allowExecution) {
                    fireAndForget(executeNotificationPermissionAction(parsed).then(showPermissionRecovery),
                        { tag: 'notificationPermissionAction' });
                    return;
                }
                if (wasNotificationResponseHandled(parsed)) return;
                // A saved launch is navigation intent only, never an answer.
                if (command.kind !== 'executeAction') return;
                const route = resolveNotificationCommandRoute(command);
                if (!route) return;
                command = { kind: 'openSession', sessionId: command.defaultSessionId,
                    serverId: command.target.serverId, serverUrl: command.target.serverUrl ?? null,
                    identity: command.identity, route };
            }
            if (isNotificationExecutionAction(parsed)) {
                if (wasNotificationResponseHandled(parsed)) return;
                markNotificationResponseHandled(parsed);
            } else if (parsed.dedupeKey) {
                const handled = handledNavigationResponses.current;
                if (handled.size > 512) handled.clear();
                if (handled.has(parsed.dedupeKey)) return;
                handled.add(parsed.dedupeKey);
            }
            if (command.kind === 'ignore' || cancellation.signal.aborted) return;
            const route = resolveNotificationCommandRoute(command);
            if (!route) return;
            const navigationIntent = claimNotificationNavigationIntent();

            if (command.kind === 'openNotice') {
                const notice = command;
                fireAndForget((async () => {
                    // Plugin effects retain their own prerequisite admission;
                    // every resulting navigation uses the same Account owner.
                    if (notice.pluginNotificationPress) {
                        const admitted = await resolveServerCredentialAccountScope(notice.serverId);
                        if (cancellation.signal.aborted || admitted.kind !== 'bound' || admitted.scope.accountId !== notice.accountId) return;
                    }
                    const route = notice.pluginNotificationPress
                        ? await (await import('../pluginNotificationActions')).executePluginNotificationButton(notice, {
                            allowExecution, signal: cancellation.signal,
                        }) : notice.route;
                    if (!route || cancellation.signal.aborted) return;
                    navigateToNotificationAccount({ ...notice, route }, () => { navigateExplicit(route); }, navigationIntent);
                })(), { tag: 'RootLayout.notificationNav.notice' });
                return;
            }

            if (command.kind === 'executeAction' && command.guardWarning) {
                fireAndForget((async () => {
                    const result = await executeGuardStopWarningAction(command, cancellation.signal, expectedAccountId);
                    if (cancellation.signal.aborted) return;
                    if (result && !result.ok) Modal.alert(t('common.error'), result.error);
                    await reconcileGuardStopWarningNotifications();
                    navigateToNotificationAccount({ serverId: command.target.serverId, serverUrl: command.target.serverUrl,
                        route, accountId: expectedAccountId ?? parsed.accountId }, () => { navigateExplicit(route); }, navigationIntent);
                })(), { tag: 'RootLayout.guardNotificationAction' });
                return;
            }

            const serverUrl = resolveNotificationCommandServerUrl(command);
            const serverId = resolveNotificationCommandServerId(command);
            const navigationAccountId = command.kind === 'openSettings' || command.kind === 'openInbox' ? null : expectedAccountId ?? parsed.accountId;
            const navigationTarget = { serverId, serverUrl, accountId: navigationAccountId };
            // Opening a disk alert is the person's intent to prepare the low-disk pile on that exact Home (STO-23).
            if (command.kind === 'openMachine' && command.serverId) {
                beginMachinePageTabIntent({ serverId: command.serverId, machineId: command.machineId }, command.tab);
            }
            // Account-bound navigation admits and switches through one owner. Native
            // URI input can only target an already saved Home and Account.
            const savedAccountHome = navigationAccountId
                ? findSavedServerProfile({ serverId, serverUrl: serverUrl ?? '' }) : null;
            if (navigationAccountId && (savedAccountHome || expectedAccountId)) {
                const accountRoute = savedAccountHome
                    ? resolveNotificationCommandRouteForVerifiedHome(command, savedAccountHome.id) ?? route : route;
                navigateToNotificationAccount({ ...navigationTarget,
                    serverId: savedAccountHome?.id ?? serverId,
                    serverUrl: savedAccountHome?.serverUrl ?? serverUrl, route: accountRoute },
                () => { navigateExplicit(accountRoute); }, navigationIntent);
                return;
            }
            const routeToServerSettingsForUrl = (url: string) => {
                openAddHome({ ...router, push: href => navigateExplicit(resolveHref(href)) }, { address: url, source: 'notification' });
            };

            if (serverUrl) {
                if (!isNotificationServerActive({ serverId, serverUrl })) {
                    const saved = findSavedServerProfile({ serverId, serverUrl });
                    if (saved) {
                        const savedRoute = resolveNotificationCommandRouteForVerifiedHome(command, saved.id) ?? route;
                        setPendingNotificationNav({ serverUrl: saved.serverUrl, serverId: saved.id, route: savedRoute,
                            ...(navigationAccountId ? { accountId: navigationAccountId } : {}),
                        });
                        fireAndForget((async () => {
                            try {
                                await setActiveServerAndSwitch({
                                    serverId: saved.id,
                                    scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                                    refreshAuth: refreshAuthRef.current,
                                });
                                if (cancellation.signal.aborted || !navigationIntent.isCurrent()) return;
                                clearPendingNotificationNav();
                                navigateToNotificationAccount({ ...navigationTarget, serverId: saved.id, serverUrl: saved.serverUrl,
                                    route: savedRoute }, () => { navigateExplicit(savedRoute); }, navigationIntent);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.savedServer' });
                        return;
                    }

                    if (isUnsafeNotificationServerUrl(serverUrl)) {
                        // Unsafe/mismatched server url: fail closed for actions; navigate only.
                        navigateToNotificationAccount({ ...navigationTarget, route }, () => { navigateExplicit(route); }, navigationIntent);
                        return;
                    }

                    if (listServerProfiles().length === 0) {
                        connectAndSwitchUnsavedHome(serverUrl, route, command, 'RootLayout.notificationNav.autoAddServer', navigationAccountId, navigationIntent);
                        return;
                    }
                    // Servers exist but the target isn't saved: redirect to server settings with a prefilled url.
                    setPendingNotificationNav({ serverUrl, route, ...(navigationAccountId ? { accountId: navigationAccountId } : {}) });
                    routeToServerSettingsForUrl(serverUrl);
                    return;
                }
            }

            // Every URL-addressed path reaching here has proved its Home is
            // active. Keep the navigation route qualified to that admitted Home.
            const admittedServerId = resolveAdmittedNotificationServerId(serverId);
            const admittedRoute = serverUrl && !serverId && admittedServerId
                ? resolveNotificationCommandRouteForVerifiedHome(command, admittedServerId) ?? route
                : route;

            if (
                command.kind === 'openSession'
                || command.kind === 'openInbox'
                || command.kind === 'focusComposer'
                || command.kind === 'openSettings'
                || command.kind === 'openWorkflowRun'
                || command.kind === 'openMachine'
            ) {
                navigateToNotificationAccount({ ...navigationTarget, route: admittedRoute }, () => { navigateExplicit(admittedRoute); }, navigationIntent);
            }
        };

        const recoverySubscription = AppState.addEventListener('change', state => {
            if (state === 'active') showPermissionRecovery();
        });
        showPermissionRecovery();
        let disposed = false;
        let subscription: { remove: () => void } | null = null;
        if (nativeDesktop) {
            fireAndForget(subscribeDesktopNotificationResponses(response => {
                const content = response?.notification?.request?.content;
                // URI activation is public input. Guard keeps its action authority;
                // ordinary Activity permits only a default Session navigation.
                if (!content?.accountId) return;
                if (content.data?.topic === 'guard_stop_warning') {
                    maybeRedirectFromResponse(response, 'default', true, content.accountId);
                    return;
                }
                const tap = parseNotificationTap({ response, defaultActionIdentifier: 'default' });
                if (response.actionIdentifier !== 'default' || tap?.command.kind !== 'openSession'
                    || !tap.accountId || tap.accountId !== content.accountId) return;
                maybeRedirectFromResponse(response, 'default', false, content.accountId);
            }, cancellation.signal).then(remove => {
                if (disposed) remove();
                else subscription = { remove };
            }), { tag: 'RootLayout.desktopNotificationResponse' });
        } else void loadExpoNotifications()
            .then((Notifications) => {
                if (disposed) return;
                const defaultActionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER;
                void Notifications.getLastNotificationResponseAsync()
                    .then(async (response) => {
                        if (!response) return;
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
            cancellation.abort();
            subscription?.remove();
            recoverySubscription?.remove();
        };
    }, [params.enabled]);
}
