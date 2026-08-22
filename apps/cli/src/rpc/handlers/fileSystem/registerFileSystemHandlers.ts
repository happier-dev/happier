import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';

import { registerReadFileHandler } from './readFileHandler';
import type { ExactAllowedReadFile } from './accessPolicy/exactAllowedReadFile';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers } from './pathMutationHandlers';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import type { ComposerMediaStageUploadTargetDeps } from '@/transfers/targets/resolveComposerMediaStageUploadTarget';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { registerComposerMediaStageLifecycleRpcHandlers } from '@/transfers/rpc/registerComposerMediaStageLifecycleRpcHandlers';
import {
  OS_USER_FILESYSTEM_ACCESS_POLICY,
  type FilesystemAccessPolicy,
} from './accessPolicy/filesystemAccessPolicy';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';

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
    getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
    composerMediaStage?: ComposerMediaStageUploadTargetDeps;
    actionExecutor?: RpcActionExecutor;
    directoryLimits?: Readonly<{
      listMaxEntries?: number;
      treeMaxDepth?: number;
      treeMaxNodes?: number;
    }>;
  }>,
): Readonly<{
  transferSessionStore: TransferSessionStore;
  dispose: () => Promise<void>;
}> {
  const getAdditionalAllowedReadDirs = opts?.getAdditionalAllowedReadDirs;
  const getAdditionalAllowedReadFiles = opts?.getAdditionalAllowedReadFiles;
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
    ...(getAdditionalAllowedReadFiles ? { getAdditionalAllowedReadFiles } : {}),
    actionExecutor: opts?.actionExecutor,
  });
  registerWriteFileHandler(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    actionExecutor: opts?.actionExecutor,
  });
  registerDirectoryHandlers(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    actionExecutor: opts?.actionExecutor,
    limits: {
      listMaxEntries: opts?.directoryLimits?.listMaxEntries ?? configuration.filesDirectoryListMaxEntries,
      treeMaxDepth: opts?.directoryLimits?.treeMaxDepth ?? configuration.filesDirectoryTreeMaxDepth,
      treeMaxNodes: opts?.directoryLimits?.treeMaxNodes ?? configuration.filesDirectoryTreeMaxNodes,
    },
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
    ...(opts?.composerMediaStage ? { composerMediaStage: opts.composerMediaStage } : {}),
  });
  registerTransferDownloadRpcHandlers(rpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    ...(getAdditionalAllowedReadFiles ? { getAdditionalAllowedReadFiles } : {}),
    store: transferSessionStore,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
    ...(opts?.composerMediaStage ? { composerMediaStage: { store: opts.composerMediaStage.store } } : {}),
  });
  if (opts?.composerMediaStage) {
    registerComposerMediaStageLifecycleRpcHandlers(rpcHandlerManager, {
      store: opts.composerMediaStage.store,
    });
  }

  return {
    transferSessionStore,
    dispose: () => transferSessionStore.dispose(),
  };
}
