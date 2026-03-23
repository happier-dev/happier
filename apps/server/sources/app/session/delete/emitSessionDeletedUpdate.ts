import { eventRouter, buildDeleteSessionUpdate } from '@/app/events/eventRouter';
import { randomKeyNaked } from '@/utils/keys/randomKeyNaked';
import { log } from '@/utils/logging/log';

export async function emitSessionDeletedUpdate(params: {
    sessionId: string;
    accountId: string;
    cursor: number;
}): Promise<void> {
    const updatePayload = buildDeleteSessionUpdate(params.sessionId, params.cursor, randomKeyNaked(12));

    log({
        module: 'session-delete',
        userId: params.accountId,
        sessionId: params.sessionId,
        updateType: 'delete-session',
        updateId: updatePayload.id,
        updateSeq: updatePayload.seq,
    }, 'Emitting delete-session update to user-scoped connections');

    eventRouter.emitUpdate({
        userId: params.accountId,
        payload: updatePayload,
        recipientFilter: { type: 'user-scoped-only' },
    });
}
