import { storage } from '@/sync/domains/state/storage';
import { readSessionArchivePending, resolveSessionArchiveServerId } from '@/sync/domains/session/listing/sessionArchiveState';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';

export function useSessionArchivePending(sessionId: string, serverId?: string | null): boolean {
    const activeServer = useActiveServerSnapshot();
    const targetServerId = resolveSessionArchiveServerId(serverId ?? activeServer.serverId);
    return storage((state) => readSessionArchivePending(state, sessionId, targetServerId));
}
