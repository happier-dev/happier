import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';

import { registerReadFileHandler } from './readFileHandler';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers } from './pathMutationHandlers';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import {
  OS_USER_FILESYSTEM_ACCESS_POLICY,
  type FilesystemAccessPolicy,
} from './accessPolicy/filesystemAccessPolicy';

function normalizeAllowedDirectories(getDirectories?: () => ReadonlyArray<string>): string[] {
  const value = getDirectories?.() ?? [];
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function mergeAllowedDirectories(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flatMap((group) => group.filter((entry) => entry.trim().length > 0)))];
}

export function registerFileSystemHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  workingDirectory: string,
  opts?: Readonly<{
    accessPolicy?: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  }>,
): Readonly<{
  transferSessionStore: TransferSessionStore;
}> {
  const getAdditionalAllowedReadDirs = opts?.getAdditionalAllowedReadDirs;
  const getAdditionalAllowedWriteDirs = opts?.getAdditionalAllowedWriteDirs;
  const accessPolicy = opts?.accessPolicy ?? OS_USER_FILESYSTEM_ACCESS_POLICY;
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry();
  const resolveReadDirs = (): string[] => mergeAllowedDirectories(
    normalizeAllowedDirectories(getAdditionalAllowedReadDirs),
    [...pathAllowanceRegistry.getAdditionalAllowedReadDirs()],
  );
  const resolveWriteDirs = (): string[] => mergeAllowedDirectories(
    normalizeAllowedDirectories(getAdditionalAllowedWriteDirs),
    [...pathAllowanceRegistry.getAdditionalAllowedWriteDirs()],
  );

  registerReadFileHandler(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
  });
  registerWriteFileHandler(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
  });
  registerDirectoryHandlers(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
  });
  registerPathMutationHandlers(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
  });
  const transferSessionStore = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });

  registerTransferUploadRpcHandlers(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    store: transferSessionStore,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
    attachmentUpload: {
      pathAllowanceRegistry,
    },
  });
  registerTransferDownloadRpcHandlers(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    store: transferSessionStore,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
  });

  return {
    transferSessionStore,
  };
}
