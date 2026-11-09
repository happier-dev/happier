import type { SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

/** An inverse is valid only while this exact Home still exposes the accepted marker. */
export async function undoSessionBotChange(params: Readonly<{
    address: SessionAddress;
    accepted: SessionBotV1 | null;
    previous: SessionBotV1 | null;
}>) {
    // This already-bundled owner is evaluated only on an Undo invocation.
    const { getStorage } = require('@/sync/domains/state/storageStore') as typeof import('@/sync/domains/state/storageStore');
    const state = getStorage().getState();
    const session = state.sessions[params.address.sessionId];
    if (!session || !session.metadata || session.serverId !== params.address.serverId
        || session.access?.role !== 'owner' || session.access.capabilities.renameSession !== true) {
        return { ok: false as const, errorCode: 'session_not_current', error: 'Session is unavailable' };
    }
    const executeInverse = createFrontDoorActionExecute();
    return executeInverse('session.bot.set', { sessionId: params.address.sessionId, bot: params.previous, expectedBot: params.accepted },
        { surface: 'ui', serverId: params.address.serverId });
}
