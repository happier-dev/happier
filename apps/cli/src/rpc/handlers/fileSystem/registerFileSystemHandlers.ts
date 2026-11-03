import type { RpcHandlerInvoker, RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';

import { registerReadFileHandler } from './readFileHandler';
import type { ExactAllowedReadFile } from './accessPolicy/exactAllowedReadFile';
import { registerWriteFileHandler } from './writeFileHandler';
import { registerDirectoryHandlers } from './directoryHandlers';
import { registerPathMutationHandlers, type FilesystemMutationActionIngress } from './pathMutationHandlers';
import { resolveServerRoutedTransferMaxBytes } from '@/transfers/policy/serverRoutedTransferPolicy';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import type { ComposerMediaStageUploadTargetDeps } from '@/transfers/targets/resolveComposerMediaStageUploadTarget';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import { registerTransferDownloadRpcHandlers } from '@/transfers/rpc/registerTransferDownloadRpcHandlers';
import { registerTransferUploadRpcHandlers } from '@/transfers/rpc/registerTransferUploadRpcHandlers';
import { registerComposerMediaStageLifecycleRpcHandlers } from '@/transfers/rpc/registerComposerMediaStageLifecycleRpcHandlers';
import {
  OS_USER_FILESYSTEM_ACCESS_POLICY,
  type FilesystemAccessPolicy,
} from './accessPolicy/filesystemAccessPolicy';
import type { RpcActionExecutor } from '../_actionDispatchAdapter';
import { createFilesystemEffectAdmission, createFilesystemEffectRpcRegistrar, type FilesystemEffectAdmission } from './accessPolicy/filesystemEffectAdmission';
import type { PrepareNativeFilesystemTransfer } from '@/transfers/rpc/nativeTransferRpcRegistrar';

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
    effectAdmission?: FilesystemEffectAdmission;
    prepareNativeTransfer?: PrepareNativeFilesystemTransfer;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
    getAdditionalAllowedWriteDirs?: () => ReadonlyArray<string>;
    composerMediaStage?: ComposerMediaStageUploadTargetDeps;
    resolveSessionWorkingDirectory?: (sessionId: string) => Promise<string | null>;
    actionExecutor?: RpcActionExecutor;
    resolveMutationActionExecutor?: FilesystemMutationActionIngress['resolveMutationActionExecutor'];
    mutationMachineId?: string;
    directoryLimits?: Readonly<{
      listMaxEntries?: number;
      treeMaxDepth?: number;
      treeMaxNodes?: number;
    }>;
  }>,
): Readonly<{
  transferSessionStore: TransferSessionStore;
  localUploadRpc: RpcHandlerInvoker;
  dispose: () => Promise<void>;
}> {
  const getAdditionalAllowedReadDirs = opts?.getAdditionalAllowedReadDirs;
  const getAdditionalAllowedReadFiles = opts?.getAdditionalAllowedReadFiles;
  const getAdditionalAllowedWriteDirs = opts?.getAdditionalAllowedWriteDirs;
  const accessPolicy = opts?.accessPolicy ?? OS_USER_FILESYSTEM_ACCESS_POLICY;
  const effectAdmission = opts?.effectAdmission ?? createFilesystemEffectAdmission();
  const filesystemRpcHandlerManager = createFilesystemEffectRpcRegistrar(rpcHandlerManager, effectAdmission);
  const pathAllowanceRegistry = createTransferPathAllowanceRegistry();
  const resolveReadDirs = (): string[] => mergeAllowedDirectories(
    normalizeAllowedDirectories(getAdditionalAllowedReadDirs),
    [...pathAllowanceRegistry.getAdditionalAllowedReadDirs()],
  );
  const resolveWriteDirs = (): string[] => mergeAllowedDirectories(
    normalizeAllowedDirectories(getAdditionalAllowedWriteDirs),
    [...pathAllowanceRegistry.getAdditionalAllowedWriteDirs()],
  );

  registerReadFileHandler(filesystemRpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    ...(getAdditionalAllowedReadFiles ? { getAdditionalAllowedReadFiles } : {}),
    actionExecutor: opts?.actionExecutor,
  });
  registerWriteFileHandler(filesystemRpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    actionExecutor: opts?.actionExecutor,
    resolveMutationActionExecutor: opts?.resolveMutationActionExecutor,
    mutationMachineId: opts?.mutationMachineId,
  });
  registerDirectoryHandlers(filesystemRpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    actionExecutor: opts?.actionExecutor,
    resolveMutationActionExecutor: opts?.resolveMutationActionExecutor,
    mutationMachineId: opts?.mutationMachineId,
    limits: {
      listMaxEntries: opts?.directoryLimits?.listMaxEntries ?? configuration.filesDirectoryListMaxEntries,
      treeMaxDepth: opts?.directoryLimits?.treeMaxDepth ?? configuration.filesDirectoryTreeMaxDepth,
      treeMaxNodes: opts?.directoryLimits?.treeMaxNodes ?? configuration.filesDirectoryTreeMaxNodes,
    },
  });
  registerPathMutationHandlers(filesystemRpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    getAdditionalAllowedReadDirs: resolveReadDirs,
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    actionExecutor: opts?.actionExecutor,
    resolveMutationActionExecutor: opts?.resolveMutationActionExecutor,
    mutationMachineId: opts?.mutationMachineId,
  });
  const transferSessionStore = new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs,
    ...(opts?.prepareNativeTransfer ? { expiryTrigger: 'self' as const } : {}) });

  const transferRpcHandlerManager = opts?.prepareNativeTransfer ? rpcHandlerManager : filesystemRpcHandlerManager;
  const localUploadRpc = registerTransferUploadRpcHandlers(transferRpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    ...(opts?.prepareNativeTransfer ? { prepareNativeTransfer: opts.prepareNativeTransfer, effectAdmission } : {}),
    getAdditionalAllowedWriteDirs: resolveWriteDirs,
    store: transferSessionStore,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
    attachmentUpload: {
      pathAllowanceRegistry,
      resolveSessionWorkingDirectory: opts?.resolveSessionWorkingDirectory ?? (async () => null),
    },
    ...(opts?.composerMediaStage ? { composerMediaStage: opts.composerMediaStage } : {}),
  });
  registerTransferDownloadRpcHandlers(transferRpcHandlerManager, {
    workingDirectory,
    accessPolicy,
    ...(opts?.prepareNativeTransfer ? { prepareNativeTransfer: opts.prepareNativeTransfer, effectAdmission } : {}),
    getAdditionalAllowedReadDirs: resolveReadDirs,
    ...(getAdditionalAllowedReadFiles ? { getAdditionalAllowedReadFiles } : {}),
    store: transferSessionStore,
    sessionRpcTransferMaxBytes: resolveServerRoutedTransferMaxBytes(),
    ...(opts?.composerMediaStage ? { composerMediaStage: { store: opts.composerMediaStage.store } } : {}),
  });
  if (opts?.composerMediaStage) {
    registerComposerMediaStageLifecycleRpcHandlers(filesystemRpcHandlerManager, {
      store: opts.composerMediaStage.store,
    });
  }

  return {
    transferSessionStore,
    localUploadRpc,
    dispose: () => transferSessionStore.dispose(),
  };
}
