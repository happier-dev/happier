import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { configuration } from '@/configuration';

import { TransferSessionStore } from '../core/transferSessionStore';
import type { TransferPathAllowanceRegistry } from '../targets/createTransferPathAllowanceRegistry';
import { registerSessionAttachmentUploadRpcHandlers } from './registerSessionAttachmentUploadRpcHandlers';
import { registerSessionFileDownloadTransferRpcHandlers } from './registerSessionFileDownloadTransferRpcHandlers';
import { registerSessionFileUploadTransferRpcHandlers } from './registerSessionFileUploadTransferRpcHandlers';

type DirectorySupplier = () => ReadonlyArray<string>;

function normalizeTransferDirectories(getDirectories?: DirectorySupplier): string[] {
  const value = getDirectories?.() ?? [];
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

export function registerSessionTransferRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    getAdditionalAllowedReadDirs?: DirectorySupplier;
    getAdditionalAllowedWriteDirs?: DirectorySupplier;
    sessionRpcTransferMaxBytes?: number | null;
    store?: TransferSessionStore;
    attachmentUpload?: Readonly<{
      pathAllowanceRegistry: TransferPathAllowanceRegistry;
    }>;
  }>,
): void {
  const store = deps.store ?? new TransferSessionStore({ ttlMs: configuration.filesTransferSessionTtlMs });

  registerSessionFileUploadTransferRpcHandlers(rpcHandlerManager, {
    workingDirectory: deps.workingDirectory,
    store,
    getAdditionalAllowedWriteDirs: () => normalizeTransferDirectories(deps.getAdditionalAllowedWriteDirs),
    sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
  });

  registerSessionFileDownloadTransferRpcHandlers(rpcHandlerManager, {
    workingDirectory: deps.workingDirectory,
    store,
    getAdditionalAllowedReadDirs: () => normalizeTransferDirectories(deps.getAdditionalAllowedReadDirs),
    sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
  });

  if (deps.attachmentUpload) {
    registerSessionAttachmentUploadRpcHandlers(rpcHandlerManager, {
      workingDirectory: deps.workingDirectory,
      store,
      pathAllowanceRegistry: deps.attachmentUpload.pathAllowanceRegistry,
      sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
    });
  }
}
