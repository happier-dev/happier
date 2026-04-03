import { readServerEnabledBit } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';

const GUARDED_MACHINE_RPC_METHOD_PREFIXES = [
    'daemon.bulkTransfer.',
] as const;

const GUARDED_MACHINE_RPC_METHODS = new Set<string>([
    // Legacy filesystem methods (currently used by session-scoped FS ops).
    RPC_METHODS.CREATE_DIRECTORY,
    RPC_METHODS.LIST_DIRECTORY,
    RPC_METHODS.GET_DIRECTORY_TREE,
    RPC_METHODS.STAT_FILE,
    RPC_METHODS.RENAME_PATH,
    RPC_METHODS.DELETE_PATH,
    RPC_METHODS.WRITE_FILE,
    // Daemon filesystem browser methods (used outside sessions).
    RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
    RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
    // Prompt assets / registries bulk transfers and management.
    RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DISCOVER,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_ADAPTERS,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_LIST_SOURCES,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_INSTALL,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
]);

export function isGuardedMachineRpcMethod(method: string): boolean {
    if (GUARDED_MACHINE_RPC_METHODS.has(method)) return true;
    return GUARDED_MACHINE_RPC_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export async function resolveTransferPolicyAllowsMachineRpcDirect(params: Readonly<{
    serverId: string | undefined;
}>): Promise<boolean> {
    try {
        const serverFeatures = await getReadyServerFeatures({
            timeoutMs: 500,
            serverId: params.serverId,
        });

        // Fail closed: if we cannot evaluate policy, do not attempt `machine_rpc_direct`.
        if (!serverFeatures) return false;

        // Fail closed: treat missing/malformed enabled bits as disabled.
        return readServerEnabledBit(serverFeatures, 'machines.transfer') === true;
    } catch {
        return false;
    }
}
