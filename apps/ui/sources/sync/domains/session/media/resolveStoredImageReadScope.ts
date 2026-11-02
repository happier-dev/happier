import type { SessionImageFileReferenceV1 } from '@happier-dev/protocol/sessions/media/imageReferenceV1';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

/** Daemon image paths are relative to the capturing Machine's published home, not the Session workspace. */
export function resolveStoredImageReadScope(input: Readonly<{
    storage: SessionImageFileReferenceV1['storage'];
    sessionScope: WorkspaceScopeBase | null;
    daemon: Readonly<{ serverId: string | null; machineId: string | null; happyHomeDir: string | null }>;
}>): WorkspaceScopeBase | null {
    if (input.storage === 'session') return input.sessionScope;
    const { serverId, machineId, happyHomeDir } = input.daemon;
    return serverId && machineId && happyHomeDir ? { serverId, machineId, rootPath: happyHomeDir } : null;
}
