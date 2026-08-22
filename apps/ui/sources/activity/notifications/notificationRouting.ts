import {
    resolveActivityInteractionCommand,
    type ActivityInteractionCommand,
} from '@/activity/actions/resolveActivityInteractionCommand';
import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';
import { isLoopbackHostname } from '@happier-dev/protocol';

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
    const command = resolveActivityInteractionCommand({
        actionIdentifier,
        defaultActionIdentifier: params.defaultActionIdentifier,
        data: readNotificationData({ response: params.response }),
        requireKnownIdentity: false,
    });

    const notificationId = readNotificationId({ response: params.response });
    return {
        command,
        dedupeKey: notificationId ? `${notificationId}:${actionIdentifier}` : null,
    };
}
