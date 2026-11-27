import type { SessionBotFaceV1, SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { SESSION_STATUS_CLEAR_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
export { undoSessionBotChange } from './sessionBotUndo';

let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;
const BOT: SessionBotV1 = Object.freeze({ kind: 'bot' });

function addressFor(sessionId: string, scope?: Readonly<{ serverId?: string | null }>) {
    return scope?.serverId === undefined
        ? resolveSessionAddressFromLocalState(getStorage().getState(), sessionId)
        : normalizeSessionAddress(scope.serverId, sessionId);
}

export const sessionDisplayActions = {
    clearStatus(sessionId: string, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute(SESSION_STATUS_CLEAR_ACTION_ID_V1, { sessionId: address.sessionId }, { surface: 'ui', serverId: address.serverId });
    },
    setBot(sessionId: string, bot: SessionBotV1 | null, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.bot.set', { sessionId: address.sessionId, bot }, { surface: 'ui', serverId: address.serverId });
    },
    /**
     * Pause (an epoch time) or resume (`null`) a Bot's new work. The marker stays a Bot, and only while it
     * still is one: a Bot demoted meanwhile is refused rather than promoted back.
     */
    setBotPausedAt(sessionId: string, pausedAt: number | null, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.bot.set', { sessionId: address.sessionId, bot: BOT, expectedBot: BOT, pausedAt },
            { surface: 'ui', serverId: address.serverId });
    },
    /** A Bot's face: the concrete choice the picker shows (null clears every override). */
    setBotFace(sessionId: string, face: SessionBotFaceV1 | null, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.bot.face.set', { sessionId: address.sessionId, face }, { surface: 'ui', serverId: address.serverId });
    },
    setToolCalls(sessionId: string, showToolCalls: boolean | null, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.view.toolCalls.set', { sessionId: address.sessionId, showToolCalls }, { surface: 'ui', serverId: address.serverId });
    },
};
