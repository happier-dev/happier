import {
    PendingRequestedActionV1Schema,
    PendingResetStartCancelInputV1Schema,
} from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

/** One exact Pending purpose for both signed Action proof and direct route admission. */
export function readExternalActionPendingResetStartPurpose(input: Readonly<{
    actionId: string;
    method: string;
    path: string;
    body: unknown;
}>): Readonly<{ sessionId: string; localId: string }> | null {
    const isSet = input.actionId === 'session.pending.resetStart.set';
    if (!isSet && input.actionId !== 'session.pending.resetStart.cancel') return null;
    if (input.method.toUpperCase() !== (isSet ? 'PATCH' : 'POST')) return null;
    const match = (isSet ? /^\/v2\/sessions\/([^/?]+)\/pending\/([^/?]+)\/action$/u
        : /^\/v2\/sessions\/([^/?]+)\/pending\/([^/?]+)\/withdraw$/u).exec(input.path);
    if (!match || typeof input.body !== 'object' || input.body === null || Array.isArray(input.body)) return null;
    const body = input.body as Readonly<Record<string, unknown>>;
    if (isSet) {
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'requestedAction')) return null;
        const requestedAction = PendingRequestedActionV1Schema.safeParse(body.requestedAction);
        if (!requestedAction.success || requestedAction.data.kind !== 'reset_start') return null;
    } else if (Object.keys(body).length !== 0) return null;
    try {
        const ids = PendingResetStartCancelInputV1Schema.safeParse({
            sessionId: decodeURIComponent(match[1]), localId: decodeURIComponent(match[2]),
        });
        return ids.success ? ids.data : null;
    } catch {
        return null;
    }
}
