import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ActionId } from '@happier-dev/protocol';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { registerActionSpecRpcHandlers } from '../registerActionSpecRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { writeFileForRpc, type WriteFileRequest, type WriteFileHandlerDeps } from './writeFileForRpc';
export { writeFileForRpc, type WriteFileRequest, type WriteFileResponse, type WriteFileHandlerDeps } from './writeFileForRpc';

function createWriteFileRpcActionExecutor(deps: WriteFileHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown) {
      if (actionId !== 'daemon.filesystem.writeFile') {
        return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
      }
      const result = await writeFileForRpc(input as WriteFileRequest | undefined, deps);
      return {
        ok: true,
        result: result.success ? result : { success: false, error: result.error },
      };
    },
  };
}

export function registerWriteFileHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedWriteDirs: () => ReadonlyArray<string>;
    actionExecutor?: RpcActionExecutor;
  }>,
): void {
  registerActionSpecRpcHandlers({
    rpcHandlerManager,
    actionExecutor: deps.actionExecutor ?? createWriteFileRpcActionExecutor(deps),
    actionIds: ['daemon.filesystem.writeFile'],
  });
}
