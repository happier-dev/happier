import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { registerReadFileHandler } from './readFileHandler';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers } from './pathMutationHandlers';
import { registerBulkTransferRpcHandlers } from '@/transfers/rpc/registerBulkTransferRpcHandlers';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

function normalizeAllowedDirectories(getDirectories?: () => ReadonlyArray<string>): string[] {
  const value = getDirectories?.() ?? [];
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function registerFileSystemHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  workingDirectory: string,
  opts?: Readonly<{
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  }>,
): void {
  const getAdditionalAllowedReadDirs = opts?.getAdditionalAllowedReadDirs;
  const getAdditionalAllowedWriteDirs = opts?.getAdditionalAllowedWriteDirs;
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry({
    onReadDirsChange: () => {},
    onWriteDirsChange: () => {},
  });

  registerReadFileHandler(rpcHandlerManager, {
    workingDirectory,
    getAdditionalAllowedReadDirs: () => normalizeAllowedDirectories(getAdditionalAllowedReadDirs),
  });
  registerWriteFileHandler(rpcHandlerManager, { workingDirectory });
  registerDirectoryHandlers(rpcHandlerManager, {
    workingDirectory,
    getAdditionalAllowedReadDirs: () => normalizeAllowedDirectories(getAdditionalAllowedReadDirs),
  });
  registerPathMutationHandlers(rpcHandlerManager, { workingDirectory });
  registerBulkTransferRpcHandlers(rpcHandlerManager, {
    workingDirectory,
    getAdditionalAllowedReadDirs,
    getAdditionalAllowedWriteDirs,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
    attachmentUpload: {
      pathAllowanceRegistry,
    },
  });
}
