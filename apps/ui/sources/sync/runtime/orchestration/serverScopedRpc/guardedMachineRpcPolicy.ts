import { readServerEnabledBit } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';

const GUARDED_MACHINE_RPC_METHOD_PREFIXES = [
    // Canonical transfer chunk/init/finalize control-plane methods must follow transfer policy.
    'daemon.transfer.',
] as const;

const GUARDED_MACHINE_RPC_METHODS = new Set<string>([
    // Workspace file writes (inline base64) still count as uploads.
    RPC_METHODS.WRITE_FILE,
    // Direct import/export prepare methods negotiate transfer endpoints and should follow transfer policy.
    RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
    RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT,
    RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
    // Canonical bulk transfer control-plane methods must follow transfer policy.
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
    // Prompt assets bulk transfers.
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_ABORT,
    // Prompt registry bulk transfers.
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_CHUNK,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_FINALIZE,
    RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_ABORT,
    // Installed plugin UI artifact bytes.
    RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
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
