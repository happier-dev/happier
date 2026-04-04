import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { registerReadFileHandler } from './readFileHandler';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers } from './pathMutationHandlers';
import { registerBulkTransferRpcHandlers } from '@/transfers/rpc/registerBulkTransferRpcHandlers';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import type { TransferSessionStore } from '@/transfers/core/transferSessionStore';

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
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
  }>,
): Readonly<{
  bulkTransferStore: TransferSessionStore;
}> {
  const getAdditionalAllowedReadDirs = opts?.getAdditionalAllowedReadDirs;
  const getAdditionalAllowedWriteDirs = opts?.getAdditionalAllowedWriteDirs;
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
    getAdditionalAllowedReadDirs: resolveReadDirs,
  });
  registerWriteFileHandler(rpcHandlerManager, { workingDirectory });
  registerDirectoryHandlers(rpcHandlerManager, {
    workingDirectory,
    getAdditionalAllowedReadDirs: resolveReadDirs,
  });
  registerPathMutationHandlers(rpcHandlerManager, { workingDirectory });
  const bulkTransferStore = registerBulkTransferRpcHandlers(rpcHandlerManager, {
    workingDirectory,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
    attachmentUpload: {
      pathAllowanceRegistry,
    },
  });

  return {
    bulkTransferStore,
  };
}
