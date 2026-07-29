import { router } from 'expo-router';
import * as React from 'react';
import { Platform } from 'react-native';

import { normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerUrl, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { clearPendingNotificationNav, getPendingNotificationNav, setPendingNotificationNav } from '@/sync/domains/pending/pendingNotificationNav';
import {
    clearPendingNotificationAction,
    getPendingNotificationAction,
    setPendingNotificationAction,
} from '@/sync/domains/pending/pendingNotificationAction';
import { loadExpoNotifications, type ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';

import { isUnsafeNotificationServerUrl, parseNotificationTap } from '../notificationRouting';
import type { ActivityInteractionCommand } from '@/activity/actions/resolveActivityInteractionCommand';

type ExpoNotificationsWithClear = ExpoNotificationsModule & Readonly<{
    clearLastNotificationResponseAsync?: () => Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPermissionDecisionPayload(value: unknown): Readonly<{
    action: 'allow' | 'deny';
    sessionId: string;
    requestId: string;
}> | null {
    if (!isRecord(value) || typeof value.sessionId !== 'string' || typeof value.requestId !== 'string') {
        return null;
    }
    const action = value.decision === 'allow' || value.decision === 'deny'
        ? value.decision
        : value.action === 'allow' || value.action === 'deny'
            ? value.action
            : null;
    if (!action) {
        return null;
    }
    return {
        action,
        sessionId: value.sessionId,
        requestId: value.requestId,
    };
}

function resolveNotificationCommandRoute(command: ActivityInteractionCommand): string | null {
    switch (command.kind) {
        case 'openSession':
        case 'openInbox':
        case 'focusComposer':
        case 'openSettings':
            return command.route;
        case 'executeAction':
            return `/session/${encodeURIComponent(command.defaultSessionId)}`;
        case 'ignore':
        default:
            return null;
    }
}

function resolveNotificationCommandServerUrl(command: ActivityInteractionCommand): string | null {
    switch (command.kind) {
        case 'openSession':
        case 'focusComposer':
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

function findSavedServerProfileForUrl(serverUrl: string): { id: string; serverUrl: string } | null {
    const targetKey = createServerUrlComparableKey(serverUrl);
    if (!targetKey) return null;
    for (const profile of listServerProfiles()) {
        if (createServerUrlComparableKey(profile.serverUrl) === targetKey) {
            return { id: profile.id, serverUrl: profile.serverUrl };
        }
    }
    return null;
}

export function useNotificationResponseRouting(params: Readonly<{
    enabled: boolean;
    refreshAuth: () => Promise<void>;
}>): void {
    const handledNotificationResponseKeysRef = React.useRef<Set<string>>(new Set());
    const refreshAuthRef = React.useRef(params.refreshAuth);

    React.useEffect(() => {
        refreshAuthRef.current = params.refreshAuth;
    }, [params.refreshAuth]);

    React.useEffect(() => {
        if (!params.enabled) {
            handledNotificationResponseKeysRef.current.clear();
            return;
        }

        if (Platform.OS === 'web') return;

        const performPermissionAction = async (actionParams: {
            sessionId: string;
            requestId: string;
            action: 'allow' | 'deny';
        }): Promise<void> => {
            const { sessionAllow, sessionDeny } = await import('@/sync/ops');
            if (actionParams.action === 'allow') {
                await sessionAllow(actionParams.sessionId, actionParams.requestId, undefined, undefined, 'approved');
            } else {
                await sessionDeny(
                    actionParams.sessionId,
                    actionParams.requestId,
                    undefined,
                    undefined,
                    'denied',
                    'Denied from notification',
                );
            }
        };

        const pendingAction = getPendingNotificationAction();
        if (pendingAction) {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pendingAction.serverUrl) === active) {
                clearPendingNotificationAction();
                fireAndForget((async () => {
                    try {
                        await performPermissionAction({
                            sessionId: pendingAction.sessionId,
                            requestId: pendingAction.requestId,
                            action: pendingAction.action,
                        });
                    } catch {
                        // best-effort; navigation still proceeds
                    }
                    router.push(`/session/${encodeURIComponent(pendingAction.sessionId)}`);
                })(), { tag: 'RootLayout.pendingNotificationAction' });
                return;
            }
        }

        const pending = getPendingNotificationNav();
        if (pending) {
            const active = normalizeServerUrl(getActiveServerUrl());
            if (normalizeServerUrl(pending.serverUrl) === active) {
                clearPendingNotificationNav();
                router.push(pending.route);
                return;
            }
        }

        const maybeRedirectFromResponse = (response: unknown, defaultActionIdentifier: string) => {
            const parsed = parseNotificationTap({
                response,
                defaultActionIdentifier,
            });
            if (!parsed) return;
            const command = parsed.command;
            if (command.kind === 'ignore') return;

            if (parsed.dedupeKey) {
                const handled = handledNotificationResponseKeysRef.current;
                if (handled.size > 512) {
                    handled.clear();
                }
                if (handled.has(parsed.dedupeKey)) return;
                handled.add(parsed.dedupeKey);
            }

            const route = resolveNotificationCommandRoute(command);
            if (!route) return;

            const serverUrl = resolveNotificationCommandServerUrl(command);
            const routeToServerSettingsForUrl = (url: string) => {
                router.push(`/server?url=${encodeURIComponent(url)}&source=notification`);
            };

            // Permission action buttons are security-sensitive. Only perform allow/deny when:
            // - the server is already active, OR
            // - the server is already saved (we can switch safely), OR
            // - (otherwise) navigate only and let the user handle it in-app.
            const permissionDecisionPayload = command.kind === 'executeAction'
                && command.actionId === 'session.permission.respond'
                ? readPermissionDecisionPayload(command.payload)
                : null;
            if (command.kind === 'executeAction' && permissionDecisionPayload) {
                const { action, sessionId: actionSessionId, requestId: actionRequestId } = permissionDecisionPayload;
                if (!serverUrl) {
                    router.push(route);
                    return;
                }

                const active = normalizeServerUrl(getActiveServerUrl());
                if (serverUrl !== active) {
                    const saved = findSavedServerProfileForUrl(serverUrl);
                    if (!saved) {
                        if (isUnsafeNotificationServerUrl(serverUrl)) {
                            router.push(route);
                            return;
                        }
                        // If the app has no servers, we can auto-add/switch to restore a working deep link,
                        // but never perform the allow/deny action on an unsaved server.
                        if (listServerProfiles().length === 0) {
                            setPendingNotificationNav({ serverUrl, route });
                            fireAndForget((async () => {
                                try {
                                    await upsertActivateAndSwitchServer({
                                        serverUrl,
                                        source: 'notification',
                                        scope: 'device',
                                        refreshAuth: refreshAuthRef.current,
                                    });
                                    clearPendingNotificationNav();
                                    router.push(route);
                                } catch {
                                    // keep pending notification nav as fallback
                                }
                            })(), { tag: 'RootLayout.notificationNav.autoAddServer.actionTap' });
                            return;
                        }
                        // Servers exist but the target isn't saved: redirect to server settings with a prefilled url.
                        setPendingNotificationNav({ serverUrl, route });
                        routeToServerSettingsForUrl(serverUrl);
                        return;
                    }

                    setPendingNotificationAction({
                        serverUrl: saved.serverUrl,
                        sessionId: actionSessionId,
                        requestId: actionRequestId,
                        action,
                    });
                    fireAndForget((async () => {
                        try {
                            await setActiveServerAndSwitch({
                                serverId: saved.id,
                                scope: 'device',
                                refreshAuth: refreshAuthRef.current,
                            });
                            clearPendingNotificationAction();
                            try {
                                await performPermissionAction({ sessionId: actionSessionId, requestId: actionRequestId, action });
                            } catch {
                                // best-effort
                            }
                            router.push(`/session/${encodeURIComponent(actionSessionId)}`);
                        } catch {
                            // keep pending notification action as fallback
                        }
                    })(), { tag: 'RootLayout.notificationAction.savedServer' });
                    return;
                }
            }

            if (serverUrl) {
                const active = normalizeServerUrl(getActiveServerUrl());
                if (serverUrl !== active) {
                    const saved = findSavedServerProfileForUrl(serverUrl);
                    if (saved) {
                        setPendingNotificationNav({ serverUrl: saved.serverUrl, route });
                        fireAndForget((async () => {
                            try {
                                await setActiveServerAndSwitch({
                                    serverId: saved.id,
                                    scope: 'device',
                                    refreshAuth: refreshAuthRef.current,
                                });
                                clearPendingNotificationNav();
                                router.push(route);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.savedServer' });
                        return;
                    }

                    if (isUnsafeNotificationServerUrl(serverUrl)) {
                        // Unsafe/mismatched server url: fail closed for actions; navigate only.
                        router.push(route);
                        return;
                    }

                    if (listServerProfiles().length === 0) {
                        setPendingNotificationNav({ serverUrl, route });
                        fireAndForget((async () => {
                            try {
                                await upsertActivateAndSwitchServer({
                                    serverUrl,
                                    source: 'notification',
                                    scope: 'device',
                                    refreshAuth: refreshAuthRef.current,
                                });
                                clearPendingNotificationNav();
                                router.push(route);
                            } catch {
                                // keep pending notification nav as fallback
                            }
                        })(), { tag: 'RootLayout.notificationNav.autoAddServer' });
                        return;
                    }
                    // Servers exist but the target isn't saved: redirect to server settings with a prefilled url.
                    setPendingNotificationNav({ serverUrl, route });
                    routeToServerSettingsForUrl(serverUrl);
                    return;
                }
            }

            const activeServerPermissionDecisionPayload = command.kind === 'executeAction'
                && command.actionId === 'session.permission.respond'
                ? readPermissionDecisionPayload(command.payload)
                : null;
            if (command.kind === 'executeAction' && activeServerPermissionDecisionPayload) {
                const { action, sessionId: actionSessionId, requestId: actionRequestId } = activeServerPermissionDecisionPayload;
                fireAndForget((async () => {
                    try {
                        await performPermissionAction({ sessionId: actionSessionId, requestId: actionRequestId, action });
                    } catch {
                        // best-effort
                    }
                    router.push(`/session/${encodeURIComponent(actionSessionId)}`);
                })(), { tag: 'RootLayout.notificationAction.activeServer' });
                return;
            }

            if (command.kind === 'openSession' || command.kind === 'openInbox' || command.kind === 'focusComposer' || command.kind === 'openSettings') {
                router.push(route);
            }
        };

        let disposed = false;
        let subscription: { remove: () => void } | null = null;
        void loadExpoNotifications()
            .then((Notifications) => {
                if (disposed) return;
                const defaultActionIdentifier = Notifications.DEFAULT_ACTION_IDENTIFIER;
                void Notifications.getLastNotificationResponseAsync()
                    .then(async (response) => {
                        if (!response) return;
                        maybeRedirectFromResponse(response, defaultActionIdentifier);
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
        };
    }, [params.enabled]);
}
