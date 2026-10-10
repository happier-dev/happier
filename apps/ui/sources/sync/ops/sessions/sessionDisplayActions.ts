import type { SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
export { undoSessionBotChange } from './sessionBotUndo';

let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

function addressFor(sessionId: string, scope?: Readonly<{ serverId?: string | null }>) {
    return scope?.serverId === undefined
        ? resolveSessionAddressFromLocalState(getStorage().getState(), sessionId)
        : normalizeSessionAddress(scope.serverId, sessionId);
}

export const sessionDisplayActions = {
    setBot(sessionId: string, bot: SessionBotV1 | null, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.bot.set', { sessionId: address.sessionId, bot }, { surface: 'ui', serverId: address.serverId });
    },
    setToolCalls(sessionId: string, showToolCalls: boolean | null, scope?: Readonly<{ serverId?: string | null }>) {
        const address = addressFor(sessionId, scope);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.view.toolCalls.set', { sessionId: address.sessionId, showToolCalls }, { surface: 'ui', serverId: address.serverId });
    },
};
