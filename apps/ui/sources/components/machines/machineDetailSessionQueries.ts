import type { Session } from '@/sync/domains/state/storageTypes';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';

export function filterUserFacingMachineDetailSessions(
    sessions: ReadonlyArray<Session | string>,
): Session[] {
    return sessions.filter((item): item is Session => {
        if (typeof item === 'string') return false;
        return isUserFacingSession(item);
    });
}
