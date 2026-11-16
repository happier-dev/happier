import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { LiveFileWrite } from '../derivation/deriveLiveFileWrites';
import { useFileWriteSessionRunningSnapshots } from './fileWriteSessionSnapshots';
import { useLiveFileWritesFromSessionSnapshots } from './useSessionLiveFileWrites';

/** Workspace presence includes nested subagents, attributed to their real containing Session. */
export function useWorkspaceLiveFileWrites(scope: WorkspaceScopeBase | null): ReadonlyMap<string, LiveFileWrite> {
    return useLiveFileWritesFromSessionSnapshots(useFileWriteSessionRunningSnapshots({ scope }), scope?.rootPath ?? null, true);
}
