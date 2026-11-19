import type { Duplex } from 'node:stream';

import { DaemonFilesystemListDirectoryRequestSchema } from '@happier-dev/protocol/machines/fileBrowser';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { readFilesystemEffectRequesterAccountId, type FilesystemEffectSessionContext } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { attachSessionHolderWorkspaceChannel } from '@/subprocess/supervision/sessionHolder';
import type { ProjectOpenRuntime } from '@/workspaces/activation/openProject';
import { mapHolderWorkspacePath } from '@/workspaces/source/holderWorkspaceCommand';
import { createHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { runWithWorkspaceSource } from '@/workspaces/source/workspaceSource';

import { listMachineDirectoryAt } from './listMachineBrowseDirectory';
import { resolveMachineFileBrowserConfig } from './machineFileBrowserConfig';

/** One finite directory page in an attached workspace before a Project row exists. */
export async function browseManagedWorkspaceDirectory(input: Readonly<{
  raw: unknown;
  context?: FilesystemEffectSessionContext;
  openTarget?: ProjectOpenRuntime['openManagedProjectWorkspace'];
  limits?: ReturnType<typeof resolveMachineFileBrowserConfig>;
}>) {
  const result = DaemonFilesystemListDirectoryRequestSchema.safeParse(input.raw);
  if (!result.success || typeof result.data.path === 'string') {
    return { ok: false as const, errorCode: 'invalid_request', error: 'Invalid managed directory request' };
  }
  const requesterAccountId = readFilesystemEffectRequesterAccountId(input.context);
  const { workspace, directory } = result.data.path;
  if (!requesterAccountId || !input.openTarget) {
    return { ok: false as const, errorCode: 'workspace_target_unavailable', error: 'The managed workspace is unavailable' };
  }
  const lifetime = new AbortController();
  const signal = input.context?.signal ? AbortSignal.any([input.context.signal, lifetime.signal]) : lifetime.signal;
  let channel: Duplex | undefined;
  try {
    signal.throwIfAborted();
    const path = mapHolderWorkspacePath(workspace.rootPath, workspace.rootPath, directory);
    const target = await input.openTarget({ workspace, requesterAccountId, lifetime: signal });
    channel = target.openChannel([target.holderPath, 'workspace', '--root', workspace.rootPath], target.lifetime);
    const holder = await attachSessionHolderWorkspaceChannel(channel);
    const source = createHolderWorkspaceSource({ id: workspace.managedId, rootPath: workspace.rootPath, helperPath: target.helperPath, holder });
    const response = await runWithWorkspaceSource(source, () => listMachineDirectoryAt(path, result.data,
      input.limits ?? resolveMachineFileBrowserConfig()));
    return response;
  } catch (error) {
    const errorCode = readRpcErrorCode(error) ?? 'workspace_target_unavailable';
    return { ok: false as const, errorCode, error: errorCode };
  } finally {
    if (channel && !channel.destroyed) {
      channel.once('close', () => lifetime.abort());
      channel.end();
    } else lifetime.abort();
  }
}
