import { AsyncLock } from '@/utils/system/lock';

const locksBySessionKey = new Map<string, AsyncLock>();

function getSessionAssignmentLock(serverId: string, sessionId: string): AsyncLock {
    const key = `${serverId}:${sessionId}`;
    const existing = locksBySessionKey.get(key);
    if (existing) return existing;
    const lock = new AsyncLock();
    locksBySessionKey.set(key, lock);
    return lock;
}

export async function applyFolderAssignmentChange(params: Readonly<{
    serverId: string;
    sessionId: string;
    folderId: string | null;
    setSessionFolderAssignment: (assignment: Readonly<{
        serverId: string;
        sessionId: string;
        folderId: string | null;
    }>) => Promise<void>;
}>): Promise<void> {
    const lock = getSessionAssignmentLock(params.serverId, params.sessionId);
    await lock.inLock(async () => {
        await params.setSessionFolderAssignment({
            serverId: params.serverId,
            sessionId: params.sessionId,
            folderId: params.folderId,
        });
    });
}
