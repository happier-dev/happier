import {
    resolveActivityInteractionCommand,
    type ActivityInteractionCommand,
} from '@/activity/actions/resolveActivityInteractionCommand';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

import { resolveIncomingActivityRemoteAlert } from './remoteAlerts/activityRemoteAlertRouting';
import { resolveIncomingMachineRemoteAlert } from './remoteAlerts/machineRemoteAlertRouting';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { GuardStopWarningPushDataV1Schema } from '@happier-dev/protocol/activity/webhookPayload';
import { resolveNotificationSavedHome } from './resolveNotificationSavedHome';
import { AccountNoticePushDataV1Schema, PluginSessionPushDataV1Schema, type PluginNotificationPushContextV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { parsePluginNotificationButtonId } from '@happier-dev/protocol/push/pushNotificationActions';
import { resolveInboxNoticePageRoute } from '@/components/inbox/inboxItemFocus';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUnsafeNotificationServerUrl(serverUrl: string): boolean {
    const normalized = normalizeServerUrl(serverUrl);
    if (!normalized) return true;
    try {
        const url = new URL(normalized);
        const host = url.hostname.trim().toLowerCase();
        return isLoopbackHostname(host) || host === '0.0.0.0';
    } catch {
        return true;
    }
}

function readNotificationActionIdentifier(params: Readonly<{
    response: unknown;
    defaultActionIdentifier: string;
}>): string {
    if (!isRecord(params.response)) return params.defaultActionIdentifier;
    const raw = typeof params.response.actionIdentifier === 'string' ? params.response.actionIdentifier : '';
    return raw.trim() || params.defaultActionIdentifier;
}

function readNotificationId(params: Readonly<{ response: unknown }>): string | null {
    if (!isRecord(params.response)) return null;
    const notification = params.response.notification;
    if (!isRecord(notification)) return null;
    const request = notification.request;
    if (!isRecord(request)) return null;
    const identifier = request.identifier;
    const raw = typeof identifier === 'string' ? identifier : '';
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
}

function readNotificationData(params: Readonly<{ response: unknown }>): unknown {
    if (!isRecord(params.response)) return null;
    const notification = params.response.notification;
    if (!isRecord(notification)) return null;
    const request = notification.request;
    if (!isRecord(request)) return null;
    const content = request.content;
    if (!isRecord(content)) return null;
    if (typeof content.dataString === 'string') {
        try { return JSON.parse(content.dataString); } catch { return null; }
    }
    return content.data;
}

export type ParsedNotificationTap = Readonly<{
    command: ActivityInteractionCommand;
    dedupeKey: string | null;
    actionIdentifier?: string;
    accountId?: string | null;
}>;

function readPluginButtonPress(actionIdentifier: string, notification: PluginNotificationPushContextV1 | undefined) {
    const button = parsePluginNotificationButtonId(actionIdentifier);
    return button && notification && button.pluginId === notification.pluginId && button.categoryId === notification.categoryId
        ? { notification, buttonId: button.buttonId } : null;
}

export function parseNotificationTap(params: Readonly<{
    response: unknown;
    defaultActionIdentifier: string;
}>): ParsedNotificationTap | null {
    const actionIdentifier = readNotificationActionIdentifier(params);
    const data = readNotificationData({ response: params.response });
    const notificationId = readNotificationId({ response: params.response });
    const dedupeKey = notificationId ? `${notificationId}:${actionIdentifier}` : null;
    if (isRecord(data) && data.topic === 'plugin_session') {
        const session = PluginSessionPushDataV1Schema.safeParse(data);
        if (!session.success) return { command: { kind: 'ignore', reason: 'malformed' }, dedupeKey };
        const press = readPluginButtonPress(actionIdentifier, session.data.pluginNotification);
        if (actionIdentifier !== params.defaultActionIdentifier && !press) return { command: { kind: 'ignore', reason: 'unknown_action' }, dedupeKey };
        const home = resolveNotificationSavedHome(session.data);
        if (!home) return { command: { kind: 'ignore', reason: 'unknown_server' }, dedupeKey };
        return { command: { kind: 'openNotice', serverId: home.id, serverUrl: home.serverUrl, accountId: session.data.accountId,
            route: createActivitySurfaceSessionRoute(session.data.sessionId, home.id), defaultSessionId: session.data.sessionId,
            ...(press ? { pluginNotificationPress: press } : {}) },
            dedupeKey, actionIdentifier, accountId: session.data.accountId };
    }
    if (isRecord(data) && data.topic === 'account_notice') {
        const notice = AccountNoticePushDataV1Schema.safeParse(data);
        if (!notice.success) return { command: { kind: 'ignore', reason: 'malformed' }, dedupeKey };
        // Plugin buttons never enter Session permission response admission.
        const press = readPluginButtonPress(actionIdentifier, notice.data.pluginNotification);
        if (actionIdentifier !== params.defaultActionIdentifier && !press) return { command: { kind: 'ignore', reason: 'unknown_action' }, dedupeKey };
        const home = resolveNotificationSavedHome({ serverId: notice.data.serverId, serverUrl: notice.data.serverUrl ?? '' });
        if (!home) return { command: { kind: 'ignore', reason: 'unknown_server' }, dedupeKey };
        return { command: { kind: 'openNotice', serverId: home.id, serverUrl: home.serverUrl, accountId: notice.data.accountId,
            route: resolveInboxNoticePageRoute(notice.data.artifactId, { kind: 'account_notice.v1',
                source: notice.data.source, ...(notice.data.page ? { page: notice.data.page } : {}) }, home.id),
            ...(press ? { pluginNotificationPress: press } : {}) },
            dedupeKey, actionIdentifier, accountId: notice.data.accountId };
    }
    if (isRecord(data) && data.topic === 'guard_stop_warning') {
        const warning = GuardStopWarningPushDataV1Schema.safeParse(data);
        if (!warning.success) return { command: { kind: 'ignore', reason: 'malformed' }, dedupeKey };
        const home = resolveNotificationSavedHome({ serverId: warning.data.serverId, serverUrl: warning.data.serverUrl ?? '' });
        if (!home) return { command: { kind: 'ignore', reason: 'unknown_server' }, dedupeKey };
        return { command: resolveActivityInteractionCommand({ actionIdentifier, defaultActionIdentifier: params.defaultActionIdentifier,
            data: { ...warning.data, serverId: home.id, serverUrl: home.serverUrl }, requireKnownIdentity: false }), dedupeKey };
    }

    const machineAlert = resolveIncomingMachineRemoteAlert(data);
    if (machineAlert.kind !== 'not_machine_alert') {
        if (machineAlert.kind === 'unroutable') return { command: { kind: 'ignore', reason: 'unknown_server' }, dedupeKey };
        if (actionIdentifier !== params.defaultActionIdentifier) return { command: { kind: 'ignore', reason: 'unknown_action' }, dedupeKey };
        const tab = { id: 'overview' } as const;
        return { command: { kind: 'openMachine', machineId: machineAlert.alert.machineId, serverId: machineAlert.serverId, serverUrl: machineAlert.serverUrl,
            tab, route: machinePageHref({ door: 'rail', target: { machineId: machineAlert.alert.machineId, serverId: machineAlert.serverId }, tab }) }, dedupeKey };
    }

    // A Home-submitted collaborator alert names its Home by portable identity.
    // Qualify it through the existing profile owner first, then reuse the one
    // interaction resolver; an unresolvable Home never falls back to the active
    // Home (Lane 09C §10.4).
    const remoteAlert = resolveIncomingActivityRemoteAlert(data);
    if (remoteAlert.kind !== 'not_remote_alert') {
        if (remoteAlert.kind === 'unroutable') {
            return { command: { kind: 'ignore', reason: 'unknown_server' }, dedupeKey };
        }
        const command = resolveActivityInteractionCommand({
                actionIdentifier,
                defaultActionIdentifier: params.defaultActionIdentifier,
                data: {
                    sessionId: remoteAlert.target.address.sessionId,
                    serverId: remoteAlert.target.address.serverId,
                    serverUrl: remoteAlert.target.serverUrl,
                },
                requireKnownIdentity: false,
            });
        return {
            command: remoteAlert.target.discussionId && command.kind === 'openSession'
                ? {
                    ...command,
                    route: buildScopedSessionRouteHref({
                        sessionId: command.sessionId,
                        serverId: command.serverId,
                        suffix: `/discussions/${encodeURIComponent(remoteAlert.target.discussionId)}`,
                        query: { sourceSurface: 'collaboration' },
                    }),
                }
                : command,
            dedupeKey,
        };
    }

    const command = resolveActivityInteractionCommand({
        actionIdentifier,
        defaultActionIdentifier: params.defaultActionIdentifier,
        data,
        userText: isRecord(params.response) ? params.response.userText : undefined,
        requireKnownIdentity: false,
    });

    return { command, dedupeKey, actionIdentifier,
        accountId: isRecord(data) && typeof data.accountId === 'string' ? data.accountId.trim() : null };
}
