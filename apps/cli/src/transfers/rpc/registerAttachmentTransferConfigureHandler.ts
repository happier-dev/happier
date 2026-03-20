import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { TransferPathAllowanceRegistry } from '../targets/createTransferPathAllowanceRegistry';
import {
  DEFAULT_ATTACHMENT_TRANSFER_CONFIG,
  normalizeAttachmentUploadLocation,
  normalizeAttachmentVcsIgnoreStrategy,
  normalizeAttachmentWorkspaceRelativeDir,
  resolveConfiguredAttachmentTransferTarget,
  type AttachmentTransferConfig,
  type AttachmentUploadLocation,
  type AttachmentVcsIgnoreStrategy,
} from '../targets/resolveAttachmentTransferTarget';
import { ensureAttachmentIgnoreRule } from '../targets/ensureAttachmentIgnoreRule';

type ConfigureRequest = Readonly<{
  uploadLocation?: AttachmentUploadLocation;
  workspaceRelativeDir?: string;
  vcsIgnoreStrategy?: AttachmentVcsIgnoreStrategy;
  vcsIgnoreWritesEnabled?: boolean;
}>;

type ConfigureResponse =
  | Readonly<{ success: true; uploadLocation: AttachmentUploadLocation; uploadBasePath: string }>
  | Readonly<{ success: false; error: string }>;

export function registerAttachmentTransferConfigureHandler(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
  }>,
): void {
  const tempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());
  let config: AttachmentTransferConfig = DEFAULT_ATTACHMENT_TRANSFER_CONFIG;

  rpcHandlerManager.registerHandler<ConfigureRequest, ConfigureResponse>(RPC_METHODS.ATTACHMENTS_CONFIGURE, async (data) => {
    const nextLocation = normalizeAttachmentUploadLocation(data?.uploadLocation) ?? config.uploadLocation;
    const nextDir = normalizeAttachmentWorkspaceRelativeDir(data?.workspaceRelativeDir) ?? config.workspaceRelativeDir;
    const nextStrategy = normalizeAttachmentVcsIgnoreStrategy(data?.vcsIgnoreStrategy) ?? config.vcsIgnoreStrategy;
    const nextWritesEnabled =
      typeof data?.vcsIgnoreWritesEnabled === 'boolean' ? data.vcsIgnoreWritesEnabled : config.vcsIgnoreWritesEnabled;

    config = {
      uploadLocation: nextLocation,
      workspaceRelativeDir: nextDir,
      vcsIgnoreStrategy: nextStrategy,
      vcsIgnoreWritesEnabled: nextWritesEnabled,
    };
    const resolvedTarget = resolveConfiguredAttachmentTransferTarget({
      config,
      tempUploadRoot,
      workingDirectory: deps.workingDirectory,
    });

    try {
      deps.pathAllowanceRegistry.setAdditionalAllowedReadDirs(resolvedTarget.target.additionalAllowedReadDirs);
      deps.pathAllowanceRegistry.setAdditionalAllowedWriteDirs(resolvedTarget.target.additionalAllowedWriteDirs);
    } catch {
      deps.pathAllowanceRegistry.setAdditionalAllowedReadDirs([]);
      deps.pathAllowanceRegistry.setAdditionalAllowedWriteDirs([]);
    }

    try {
      await ensureAttachmentIgnoreRule({
        workingDirectory: deps.workingDirectory,
        config,
      });
    } catch {
      // Best effort.
    }

    if (!resolvedTarget.success) {
      return { success: false, error: resolvedTarget.error };
    }

    return {
      success: true,
      uploadLocation: config.uploadLocation,
      uploadBasePath: resolvedTarget.uploadBasePath,
    };
  });
}
