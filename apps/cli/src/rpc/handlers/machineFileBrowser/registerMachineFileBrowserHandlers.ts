import type { RpcHandlerRegistrar } from '@/api/rpc/types'
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily'

import { resolveMachineFileBrowserConfig } from './machineFileBrowserConfig'
import { listMachineBrowseDirectory } from './listMachineBrowseDirectory'
import { listMachineBrowseRoots } from './listMachineBrowseRoots'
import { resolveMachineBrowseRoots } from './resolveMachineBrowseRoots'
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy'
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers'
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter'
import { MACHINE_FILE_BROWSER_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration'
import { addressesManagedBrowseDirectory, assertFilesystemEffectCurrent, createFilesystemEffectRpcRegistrar, type FilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission'
import type { ProjectOpenRuntime } from '@/workspaces/activation/openProject'
import { browseManagedWorkspaceDirectory } from './browseManagedWorkspaceDirectory'

type RegisterMachineFileBrowserHandlersParams = Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar
  workingDirectory: string
  accessPolicy?: FilesystemAccessPolicy
  startAtUserDirectories?: boolean
  deps?: Readonly<{
    resolveRoots?: typeof resolveMachineBrowseRoots
    maxEntries?: number
    statConcurrency?: number
    platform?: NodeJS.Platform
    openManagedProjectWorkspace?: ProjectOpenRuntime['openManagedProjectWorkspace']
  }>
  actionExecutor?: RpcActionExecutor
  effectAdmission?: FilesystemEffectAdmission
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
    execute: async (actionId, input, context) => {
      try {
      await assertFilesystemEffectCurrent(context)
      if (actionId === 'daemon.filesystem.listRoots') {
        const result = await listMachineBrowseRoots({ resolveRoots: async () => await resolveRoots({ platform, workingDirectory, accessPolicy,
          startAtUserDirectories: params.startAtUserDirectories }) })
        await assertFilesystemEffectCurrent(context)
        return {
          ok: true,
          result,
        }
      }
      if (actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory) {
        if (addressesManagedBrowseDirectory(input)) {
          const result = await browseManagedWorkspaceDirectory({ raw: input, context,
            openTarget: params.deps?.openManagedProjectWorkspace, limits: { maxEntries, statConcurrency } })
          return { ok: true, result }
        }
        const roots = await resolveRoots({ platform, workingDirectory, accessPolicy })
        await assertFilesystemEffectCurrent(context)
        const result = await listMachineBrowseDirectory({ raw: input, roots, platform, maxEntries, statConcurrency })
        await assertFilesystemEffectCurrent(context)
        return {
          ok: true,
          result,
        }
      }
      return {
        ok: false,
        errorCode: 'unsupported_action',
        error: `unsupported_action:${actionId}`,
      }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'filesystem_identity_custody_unavailable')) throw error
        return { ok: false, errorCode: error.code, error: error.message }
      }
    },
  } satisfies RpcActionExecutor

  registerActionSpecRpcHandlers({
    rpcHandlerManager: params.effectAdmission
      ? createFilesystemEffectRpcRegistrar(params.rpcHandlerManager, params.effectAdmission, failure => ({ ok: false, ...failure }))
      : params.rpcHandlerManager,
    actionExecutor,
    scopes: MACHINE_FILE_BROWSER_RPC_SCOPES,
  })
}
