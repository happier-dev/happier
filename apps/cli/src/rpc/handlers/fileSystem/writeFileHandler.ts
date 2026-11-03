import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import type { ActionId } from '@happier-dev/protocol';
import type { FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { registerRootedFilesystemRpcHandlers } from './registerRootedFilesystemRpcHandlers';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { writeFileForRpc, type WriteFileRequest, type WriteFileHandlerDeps } from './writeFileForRpc';
import type { FilesystemMutationActionIngress } from './pathMutationHandlers';
import { assertFilesystemEffectCurrent } from './accessPolicy/filesystemEffectAdmission';
export { writeFileForRpc, type WriteFileRequest, type WriteFileResponse, type WriteFileHandlerDeps } from './writeFileForRpc';

export function createWriteFileRpcActionExecutor(deps: WriteFileHandlerDeps): RpcActionExecutor {
  return {
    async execute(actionId: ActionId, input: unknown, context) {
      if (actionId !== 'daemon.filesystem.writeFile') {
        return { ok: false, errorCode: 'unsupported_action', error: `Unsupported action: ${actionId}` };
      }
      const result = await writeFileForRpc(input as WriteFileRequest | undefined, { ...deps,
        assertCurrentAuthority: async () => { await deps.assertCurrentAuthority?.(); await assertFilesystemEffectCurrent(context); } });
      return {
        ok: true,
        result,
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
  }> & FilesystemMutationActionIngress,
): void {
  registerRootedFilesystemRpcHandlers({
    rpcHandlerManager,
    workingDirectory: deps.workingDirectory,
    actionExecutor: deps.actionExecutor,
    incumbentExecutor: createWriteFileRpcActionExecutor(deps),
    mutationIngress: deps,
    actionIds: ['daemon.filesystem.writeFile'],
  });
}
