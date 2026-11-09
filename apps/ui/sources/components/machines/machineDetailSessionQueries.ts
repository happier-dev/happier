import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';

export function filterUserFacingMachineDetailSessions<T extends Session | SessionListRenderableSession>(
    sessions: ReadonlyArray<T | string>,
): T[] {
    return sessions.filter((item): item is T => {
        if (typeof item === 'string') return false;
        return isUserFacingSession(item);
    });
}
