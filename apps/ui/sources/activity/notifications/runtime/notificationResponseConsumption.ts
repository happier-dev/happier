import { isNotificationExecutionAction, type ParsedNotificationTap } from '../notificationRouting';

// Permission callbacks can reach headless handling and a later foreground mount.
// Presentation consumption is shared for those callbacks; ordinary navigation is hook-local.
const handledResponses = new Set<string>();

function responseKey(parsed: ParsedNotificationTap): string | null {
    if (!isNotificationExecutionAction(parsed)) return null;
    const permission = parsed.questionAction ?? parsed.permissionAction;
    const identity = parsed.dedupeKey ?? (permission?.occurrenceId
        ? JSON.stringify([permission.sessionId, permission.requestId, permission.occurrenceId])
        : null);
    return identity ? JSON.stringify([
        parsed.serverUrl, parsed.accountId ?? null, identity, parsed.route,
        permission?.sessionId, permission?.requestId, permission?.occurrenceId,
    ]) : null;
}

export function wasNotificationResponseHandled(parsed: ParsedNotificationTap): boolean {
    const key = responseKey(parsed);
    return key !== null && handledResponses.has(key);
}

export function markNotificationResponseHandled(parsed: ParsedNotificationTap): void {
    const key = responseKey(parsed);
    if (key !== null) handledResponses.add(key);
}
