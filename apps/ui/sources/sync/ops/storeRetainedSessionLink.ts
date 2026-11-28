import { storage } from '@/sync/domains/state/storage';
import { hasDerivedRetainedSessionLink } from '@/sync/domains/session/directSessions/retainedSessionLink';
import { readDirectSessionLink } from '@/sync/domains/session/directSessions/readDirectSessionLink';

/** Explicit transition into a daemon operation that reads its link from server metadata. */
export async function storeRetainedSessionLink(sessionId: string, serverId?: string | null): Promise<boolean> {
    const metadata = storage.getState().sessions[sessionId]?.metadata;
    if (!hasDerivedRetainedSessionLink(metadata) || !readDirectSessionLink(metadata)) return false;

    const { sync } = await import('@/sync/sync');
    await sync.patchSessionMetadataWithRetry(sessionId, (current) => {
        if (!hasDerivedRetainedSessionLink(current)) return current;
        const link = readDirectSessionLink(current);
        return link ? { ...current, directSessionV1: link } : current;
    }, { serverId, skipUnchanged: true });
    return true;
}
