import type { PermissionToolCallMessageLocation } from './permissionToolCallLocationTypes';
import { isStableSessionMessageRouteId } from '@/sync/domains/messages/messageRouteIds';

function encodeRouteSegment(value: string): string {
    return encodeURIComponent(value);
}

export function buildPermissionToolCallRoute(params: Readonly<{
    sessionId: string;
    location: PermissionToolCallMessageLocation | null;
}>): string {
    const sessionId = params.sessionId.trim();
    const location = params.location;

    if (!location) {
        return `/session/${encodeRouteSegment(sessionId)}`;
    }

    if (location.kind === 'top' && typeof location.seq === 'number') {
        return `/session/${encodeRouteSegment(sessionId)}?jumpSeq=${location.seq}`;
    }

    if (location.kind === 'top') {
        return `/session/${encodeRouteSegment(sessionId)}/message/${encodeRouteSegment(location.messageId)}`;
    }

    return `/session/${encodeRouteSegment(sessionId)}/message/${encodeRouteSegment(location.parentMessageId)}?jumpChildId=${encodeRouteSegment(location.messageId)}`;
}

export function canOpenPermissionToolCallRoute(location: PermissionToolCallMessageLocation | null): boolean {
    if (!location) return false;

    if (location.kind === 'top') {
        return typeof location.seq === 'number' || isStableSessionMessageRouteId(location.messageId);
    }

    return (
        isStableSessionMessageRouteId(location.parentMessageId)
        && isStableSessionMessageRouteId(location.messageId)
    );
}
