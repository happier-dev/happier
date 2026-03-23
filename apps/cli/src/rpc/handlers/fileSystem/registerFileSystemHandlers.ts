import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { registerReadFileHandler } from './readFileHandler';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers } from './pathMutationHandlers';
import { registerSessionTransferRpcHandlers } from '@/transfers/rpc/registerSessionTransferRpcHandlers';
import { resolveSessionRpcTransferMaxBytes } from '@/transfers/policy/sessionRpcTransferPolicy';

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
  registerSessionTransferRpcHandlers(rpcHandlerManager, {
    workingDirectory,
    getAdditionalAllowedReadDirs,
    getAdditionalAllowedWriteDirs,
    sessionRpcTransferMaxBytes: resolveSessionRpcTransferMaxBytes(),
  });
}
