import { z } from 'zod/mini';
import { FILESYSTEM_MUTATION_ACTION_IDS } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createReadFileRpcActionExecutor } from './readFileHandler';
import { createWriteFileRpcActionExecutor } from './writeFileHandler';
import { createDirectoryRpcActionExecutor } from './directoryHandlers';
import { executeFilesystemMutationAction, registerPathMutationHandlers } from './pathMutationHandlers';
import { isFilesystemPathAbsolute, type FilesystemAccessPolicy } from './accessPolicy/filesystemAccessPolicy';
import { registerWorkspaceFileSearchHandler } from '../workspaceFileSearch';
import { registerWorkspaceFileListHandler } from '../workspaceFileList';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { registerMachineFileBrowserHandlers } from '../machineFileBrowser/registerMachineFileBrowserHandlers';
import { AgentSessionFactoryObservationsSchema } from '@/agent/catalog/runtimeEntry';

const absolutePath = z.string().check(z.refine(value => isFilesystemPathAbsolute(value)));
export const FilesystemEffectConfigurationSchema = z.strictObject({
  machineId: z.optional(z.string()),
  requesterAccountId: z.optional(z.string()),
  callerAuthority: z.optional(z.enum(['present_user', 'account_automation'])),
  capabilitySessionFactories: z.optional(AgentSessionFactoryObservationsSchema),
  workingDirectory: absolutePath,
  accessPolicy: z.union([z.strictObject({ kind: z.literal('osUser') }),
    z.strictObject({ kind: z.literal('restrictedRoots'), roots: z.array(absolutePath) })]),
  additionalAllowedReadDirs: z.optional(z.array(absolutePath)),
  additionalAllowedWriteDirs: z.optional(z.array(absolutePath)),
  additionalAllowedReadFiles: z.optional(z.array(z.union([absolutePath,
    z.strictObject({ path: absolutePath, realPath: absolutePath })]))),
  sessionRpcTransferMaxBytes: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
});
export type FilesystemEffectConfiguration = Omit<z.infer<typeof FilesystemEffectConfigurationSchema>, 'accessPolicy'>
  & Readonly<{ accessPolicy: FilesystemAccessPolicy }>;

const actionSchema = z.strictObject({
  actionId: z.enum(['daemon.filesystem.readFile', 'daemon.filesystem.writeFile',
    'daemon.filesystem.listDirectory', 'daemon.filesystem.getDirectoryTree',
    ...FILESYSTEM_MUTATION_ACTION_IDS, 'workspace.files.search', 'daemon.filesystem.listRoots', 'daemon.filesystem.browseDirectory',
    RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST, RPC_METHODS.STAT_FILE]),
  input: z.unknown(),
});

/** Native dispatch only: the parent admits this process and fixes its UID and
 * configuration. Existing file/path owners retain their validation and effects.
 * No Account bootstrap, identity selection, or Home read occurs in this child. */
export async function executeFilesystemEffectOperation(request: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalidOperation();
  const { actionId, input, ...configurationInput } = request as Record<string, unknown>;
  const operation = actionSchema.safeParse({ actionId, input });
  const parsedConfiguration = FilesystemEffectConfigurationSchema.safeParse(configurationInput);
  if (!operation.success || !parsedConfiguration.success) throw invalidOperation();
  return executeConfiguredFilesystemEffect(parsedConfiguration.data, operation.data, signal);
}

export function invalidOperation(): Error & Readonly<{ code: string }> {
  return Object.assign(new Error('filesystem_effect_operation_invalid'), { code: 'filesystem_effect_operation_invalid' });
}

export async function executeConfiguredFilesystemEffect(configurationInput: FilesystemEffectConfiguration,
  request: unknown, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  const operation = actionSchema.parse(request);
  const assertCurrentAuthority = async () => { signal?.throwIfAborted(); };
  const deps = { workingDirectory: configurationInput.workingDirectory, accessPolicy: configurationInput.accessPolicy,
    getAdditionalAllowedReadDirs: () => configurationInput.additionalAllowedReadDirs ?? [],
    getAdditionalAllowedWriteDirs: () => configurationInput.additionalAllowedWriteDirs ?? [],
    getAdditionalAllowedReadFiles: () => configurationInput.additionalAllowedReadFiles ?? [], assertCurrentAuthority };
  if (operation.actionId === 'daemon.filesystem.listRoots' || operation.actionId === 'daemon.filesystem.browseDirectory') {
    const method = operation.actionId === 'daemon.filesystem.listRoots'
      ? RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS : RPC_METHODS.DAEMON_FILESYSTEM_LIST_DIRECTORY;
    let browse: RpcHandler<unknown, unknown> | undefined;
    const registrar: RpcHandlerRegistrar = { registerHandler(name, handler) {
      if (name === method) browse = handler as RpcHandler<unknown, unknown>;
    } };
    registerMachineFileBrowserHandlers({ rpcHandlerManager: registrar, workingDirectory: configurationInput.workingDirectory,
      accessPolicy: configurationInput.accessPolicy });
    if (!browse) throw invalidOperation();
    const result = await browse(operation.input, { signal: signal ?? new AbortController().signal });
    signal?.throwIfAborted();
    return result;
  }
  if (operation.actionId === RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST || operation.actionId === RPC_METHODS.STAT_FILE) {
    let read: RpcHandler<unknown, unknown> | undefined;
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
      if (method === operation.actionId) read = handler as RpcHandler<unknown, unknown>;
    } };
    if (operation.actionId === RPC_METHODS.STAT_FILE) registerPathMutationHandlers(registrar, deps);
    else registerWorkspaceFileListHandler(registrar, configurationInput.workingDirectory, { accessPolicy: configurationInput.accessPolicy });
    if (!read) throw invalidOperation();
    const result = await read(operation.input, { signal: signal ?? new AbortController().signal });
    signal?.throwIfAborted();
    return result;
  }
  if (operation.actionId === 'workspace.files.search') {
    let search: RpcHandler<unknown, unknown> | undefined;
    registerWorkspaceFileSearchHandler({ registerHandler(_method, handler) {
      search = handler as RpcHandler<unknown, unknown>;
    } }, configurationInput.workingDirectory, { accessPolicy: configurationInput.accessPolicy });
    if (!search) throw invalidOperation();
    const result = await search(operation.input, { signal: signal ?? new AbortController().signal });
    signal?.throwIfAborted();
    return result;
  }
  const executor = operation.actionId === 'daemon.filesystem.readFile' ? createReadFileRpcActionExecutor(deps)
    : operation.actionId === 'daemon.filesystem.writeFile' ? createWriteFileRpcActionExecutor(deps)
      : operation.actionId === 'daemon.filesystem.listDirectory' || operation.actionId === 'daemon.filesystem.getDirectoryTree'
        ? createDirectoryRpcActionExecutor({ ...deps, limits: {
          listMaxEntries: configuration.filesDirectoryListMaxEntries,
          treeMaxDepth: configuration.filesDirectoryTreeMaxDepth,
          treeMaxNodes: configuration.filesDirectoryTreeMaxNodes,
        } }) : null;
  if (executor) {
    const outcome = await executor.execute(operation.actionId, operation.input, { signal });
    signal?.throwIfAborted();
    return outcome.ok ? outcome.result : outcome;
  }
  const actionId = FILESYSTEM_MUTATION_ACTION_IDS.find(id => id === operation.actionId);
  if (!actionId) throw invalidOperation();
  const raw = operation.input && typeof operation.input === 'object' && !Array.isArray(operation.input)
    ? operation.input : null;
  const result = await executeFilesystemMutationAction({ ...deps, actionId, input: operation.input, signal,
    ...(raw && !Object.hasOwn(raw, 'rootPath') && actionId !== 'daemon.filesystem.copy' ? { incumbentPolicyScope: true } : {}) });
  signal?.throwIfAborted();
  return result;
}
