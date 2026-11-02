import { RPC_METHODS } from '../rpc/methods.js';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '../actions/operations/methodsV1.js';

/** Existing finite byte/observation phases only; this never authorizes generic filesystem work. */
export function readDeploymentArchiveRpcEffectV1(method: string):
    'daemon.filesystem.download' | 'daemon.filesystem.copy' | 'action.operations.get' | null {
    if (method === RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD) return 'daemon.filesystem.download';
    if (method === RPC_METHODS.DAEMON_FILESYSTEM_COPY) return 'daemon.filesystem.copy';
    if (method === ACTION_OPERATION_RPC_METHODS_V2.get) return 'action.operations.get';
    return null;
}
