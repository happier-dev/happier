import type { SetSessionPinRequest } from '@happier-dev/protocol/sessions/organization/mutations';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';

let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

/** Personal pin intent always crosses the shared Action admission and captured Account writer. */
export const sessionOrganizationActions = {
    setPin(sessionId: string, pinned: boolean, options?: Readonly<{
        serverId?: string | null;
        surface?: SetSessionPinRequest['surface'];
        sortKey?: string | null;
    }>) {
        const address = options?.serverId === undefined
            ? resolveSessionAddressFromLocalState(getStorage().getState(), sessionId)
            : normalizeSessionAddress(options.serverId, sessionId);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.organization.pin.set', {
            sessionId: address.sessionId, pinned,
            ...(options?.surface === undefined ? {} : { surface: options.surface }),
            ...(options?.sortKey === undefined ? {} : { sortKey: options.sortKey }),
        }, { surface: 'ui', serverId: address.serverId });
    },
};
