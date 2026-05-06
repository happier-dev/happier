import type { RpcHandlerRegistrar } from '@/api/rpc/types'

import { resolveMachineFileBrowserConfig } from './machineFileBrowserConfig'
import { listMachineBrowseDirectory } from './listMachineBrowseDirectory'
import { listMachineBrowseRoots } from './listMachineBrowseRoots'
import { resolveMachineBrowseRoots } from './resolveMachineBrowseRoots'
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy'
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers'
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter'
import { MACHINE_FILE_BROWSER_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration'

type RegisterMachineFileBrowserHandlersParams = Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar
  workingDirectory: string
  accessPolicy?: FilesystemAccessPolicy
  deps?: Readonly<{
    resolveRoots?: typeof resolveMachineBrowseRoots
    maxEntries?: number
    statConcurrency?: number
    platform?: NodeJS.Platform
  }>
  actionExecutor?: RpcActionExecutor
}>

export function registerMachineFileBrowserHandlers(params: RegisterMachineFileBrowserHandlersParams): void {
  const config = resolveMachineFileBrowserConfig()
  const resolveRoots = params.deps?.resolveRoots ?? resolveMachineBrowseRoots
  const maxEntries = params.deps?.maxEntries ?? config.maxEntries
  const statConcurrency = params.deps?.statConcurrency ?? config.statConcurrency
  const platform = params.deps?.platform ?? process.platform
  const workingDirectory = params.workingDirectory
  const accessPolicy = params.accessPolicy
  const actionExecutor = params.actionExecutor ?? {
    execute: async (actionId, input) => {
      if (actionId === 'daemon.filesystem.listRoots') {
        return {
          ok: true,
          result: await listMachineBrowseRoots({
            resolveRoots: async () => await resolveRoots({ platform, workingDirectory, accessPolicy }),
          }),
        }
      }
      if (actionId === 'daemon.filesystem.browseDirectory') {
        const roots = await resolveRoots({ platform, workingDirectory, accessPolicy })
        return {
          ok: true,
          result: await listMachineBrowseDirectory({
            raw: input,
            roots,
            platform,
            maxEntries,
            statConcurrency,
          }),
        }
      }
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${actionId}`,
      }
    },
  } satisfies RpcActionExecutor

  registerActionSpecRpcHandlers({
    rpcHandlerManager: params.rpcHandlerManager,
    actionExecutor,
    scopes: MACHINE_FILE_BROWSER_RPC_SCOPES,
  })
}
