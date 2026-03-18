import type { RpcHandlerRegistrar } from '@/api/rpc/types'
import { RPC_METHODS } from '@happier-dev/protocol/rpc'

import { resolveMachineFileBrowserConfig } from './machineFileBrowserConfig'
import { listMachineBrowseDirectory } from './listMachineBrowseDirectory'
import { listMachineBrowseRoots } from './listMachineBrowseRoots'
import { resolveMachineBrowseRoots } from './resolveMachineBrowseRoots'

type RegisterMachineFileBrowserHandlersParams = Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar
  deps?: Readonly<{
    resolveRoots?: typeof resolveMachineBrowseRoots
    maxEntries?: number
    statConcurrency?: number
    platform?: NodeJS.Platform
  }>
}>

export function registerMachineFileBrowserHandlers(params: RegisterMachineFileBrowserHandlersParams): void {
  const config = resolveMachineFileBrowserConfig()
  const resolveRoots = params.deps?.resolveRoots ?? resolveMachineBrowseRoots
  const maxEntries = params.deps?.maxEntries ?? config.maxEntries
  const statConcurrency = params.deps?.statConcurrency ?? config.statConcurrency
  const platform = params.deps?.platform ?? process.platform

  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS,
    async () => await listMachineBrowseRoots({
      resolveRoots: async () => await resolveRoots({ platform }),
    }),
  )

  params.rpcHandlerManager.registerHandler(
    RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY,
    async (raw) => {
      const roots = await resolveRoots({ platform })
      return await listMachineBrowseDirectory({
        raw,
        roots,
        platform,
        maxEntries,
        statConcurrency,
      })
    },
  )
}
