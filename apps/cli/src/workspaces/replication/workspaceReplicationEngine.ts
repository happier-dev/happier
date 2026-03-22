import type {
    WorkspaceReplicationEngine,
    WorkspaceReplicationEngineOperations,
    WorkspaceReplicationEngineStores,
} from './workspaceReplicationTypes';
import type { WorkspaceReplicationTransfers } from './transport/workspaceReplicationTransfers';

export function buildWorkspaceReplicationEngine(input: Readonly<{
    activeServerDir: string;
    stores: WorkspaceReplicationEngineStores;
    transfers: WorkspaceReplicationTransfers;
    operations: WorkspaceReplicationEngineOperations;
}>): WorkspaceReplicationEngine {
    return {
        activeServerDir: input.activeServerDir,
        stores: input.stores,
        transfers: input.transfers,
        operations: input.operations,
    };
}
