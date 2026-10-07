import {
    resolveActivityInteractionCommand,
    type ActivityInteractionCommand,
} from '@/activity/actions/resolveActivityInteractionCommand';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';

import { resolveIncomingActivityRemoteAlert } from './remoteAlerts/activityRemoteAlertRouting';

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
    return isRecord(content) ? content.data : null;
}

export type ParsedNotificationTap = Readonly<{
    command: ActivityInteractionCommand;
    dedupeKey: string | null;
}>;

export function parseNotificationTap(params: Readonly<{
    response: unknown;
    defaultActionIdentifier: string;
}>): ParsedNotificationTap | null {
    const actionIdentifier = readNotificationActionIdentifier(params);
    const data = readNotificationData({ response: params.response });
    const notificationId = readNotificationId({ response: params.response });
    const dedupeKey = notificationId ? `${notificationId}:${actionIdentifier}` : null;

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
        requireKnownIdentity: false,
    });

    return { command, dedupeKey };
}
