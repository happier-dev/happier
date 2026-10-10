import { readSessionBotV1, type SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { UiSessionStateMetadataPreprocess } from '@/sync/state/engine';

/** The CAS candidate, not the cached UI snapshot, decides whether an inverse is current. */
export function createSessionBotUndoMetadataPreprocess(accepted: SessionBotV1 | null): UiSessionStateMetadataPreprocess {
    return (metadata) => {
        const current = readSessionBotV1(metadata.bot);
        if (current?.kind !== accepted?.kind) {
            throw Object.assign(new Error('Session marker changed'), { code: 'conflict' });
        }
        return metadata;
    };
}

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
    const current = readSessionBotV1(session.metadata.bot);
    if (current?.kind !== params.accepted?.kind) {
        return { ok: false as const, errorCode: 'session_bot_changed', error: 'Session marker changed' };
    }
    const executeInverse = createFrontDoorActionExecute(undefined, {
        sessionStateMetadataPreprocess: createSessionBotUndoMetadataPreprocess(params.accepted),
    });
    return executeInverse('session.bot.set', { sessionId: params.address.sessionId, bot: params.previous },
        { surface: 'ui', serverId: params.address.serverId });
}
