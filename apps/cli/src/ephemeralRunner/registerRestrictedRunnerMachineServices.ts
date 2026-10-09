import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { registerMachineDirectTransferExportRpcHandlers } from '@/api/machine/rpcHandlers.directTransferExports';
import { registerMachineDirectTransferImportRpcHandlers } from '@/api/machine/rpcHandlers.directTransferImports';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { createLocalServicesDaemonRuntime, type LocalServicesDaemonRuntime } from '@/daemon/local/services/runtime';
import { createLocalServicePublicPreviewServerRoutes, type LocalServicePublicPreviewRoutes } from '@/daemon/local/services/public/routes';
import { registerFileSystemHandlers } from '@/rpc/handlers/fileSystem';
import { OS_USER_FILESYSTEM_ACCESS_POLICY } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { registerMachineFileBrowserHandlers } from '@/rpc/handlers/machineFileBrowser/registerMachineFileBrowserHandlers';
import { registerDaemonLocalServicesMachineRpcHandlers } from '@/rpc/handlers/daemonLocalServices';
import {
  MACHINE_SESSION_STOP_RPC_SCOPES,
} from '@/rpc/handlers/actionSpecRpcRegistration';
import { registerSessionLifecycleRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createMachineSessionStopLifecycleActionExecutor } from '@/session/actions/lifecycle/createStopSessionLifecycleActionExecutor';
import type { SessionLifecycleMachineHandlers } from '@/session/actions/lifecycle/sessionLifecycleTypes';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import {
  createDirectTransferServerLifecycle,
  type DirectTransferServerLifecycle,
} from '@/machines/transfer/directTransferServerLifecycle';
import { createFileTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import {
  registerMachineTerminalRpcHandlers,
  type MachineTerminalRpcHandlerDeps,
} from '@/api/machine/rpcHandlers.terminal';

import { createRestrictedRunnerLocalServicesRoutes } from './restrictedRunnerLocalServices';

export function registerRestrictedRunnerMachineServices(input: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  workingDirectory: string;
  machineId: string;
  /** Account from the verified Session Runner principal, not RPC input. */
  accountId?: string;
  sessionId: string;
  runtimeOrigin: string;
  runtimeToken: string;
  stopSession: SessionLifecycleMachineHandlers['stopSession'];
  localServicesRuntime?: LocalServicesDaemonRuntime;
  publicPreviewRoutes?: LocalServicePublicPreviewRoutes;
  terminalDeps?: Omit<MachineTerminalRpcHandlerDeps, 'workingDirectory' | 'accessPolicy' | 'requiredSessionId'>;
  directTransferLifecycle?: DirectTransferServerLifecycle;
}>): Readonly<{ ensureDirectTransferListening(): Promise<number>; dispose(): Promise<void> }> {
  const filesystem = registerFileSystemHandlers(
    input.rpcHandlerManager,
    input.workingDirectory,
    { accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY },
  );
  registerMachineFileBrowserHandlers({
    rpcHandlerManager: input.rpcHandlerManager,
    workingDirectory: input.workingDirectory,
    accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY,
  });
  registerSessionLifecycleRpcHandlers({
    rpcHandlerManager: input.rpcHandlerManager,
    actionExecutor: createMachineSessionStopLifecycleActionExecutor({
      stopSession: input.stopSession,
    }),
    actionIds: ['session.stop'],
    scopes: MACHINE_SESSION_STOP_RPC_SCOPES,
  });
  const terminal = registerMachineTerminalRpcHandlers({
    rpcHandlerManager: input.rpcHandlerManager,
    deps: {
      ...input.terminalDeps,
      workingDirectory: input.workingDirectory,
      accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY,
      requiredSessionId: input.sessionId,
    },
  });

  const localServicesRuntime = input.localServicesRuntime ?? createLocalServicesDaemonRuntime({
    machineId: input.machineId,
    accountId: input.accountId,
    resolveServerFeaturesSnapshot: async () => await fetchServerFeaturesSnapshot({
      serverUrl: input.runtimeOrigin,
    }),
    // Runner-local annotations are process-local. The standalone endpoint must not share or
    // overwrite the ordinary Account daemon's Machine-wide label/forget store.
    inventoryAnnotations: { read: () => null, write: () => undefined },
    workspaceFacts: () => [{ id: input.sessionId, path: input.workingDirectory }],
    resolveSessionWorkspacePaths: (sessionId) => (
      sessionId === input.sessionId ? [input.workingDirectory] : []
    ),
  });
  const localServicesRoutes = createRestrictedRunnerLocalServicesRoutes({
    machineId: input.machineId,
    sessionId: input.sessionId,
    workingDirectory: input.workingDirectory,
    runtime: localServicesRuntime,
    publicPreviewRoutes: input.publicPreviewRoutes ?? createLocalServicePublicPreviewServerRoutes({
      token: input.runtimeToken,
      serverBaseUrl: input.runtimeOrigin,
    }),
  });
  registerDaemonLocalServicesMachineRpcHandlers(input.rpcHandlerManager, localServicesRoutes);

  const directTransferLifecycle = input.directTransferLifecycle ?? createDirectTransferServerLifecycle({
    bindPort: 0,
    bindHost: '127.0.0.1',
    listenerClasses: ['loopback_http'],
    advertisedHosts: ['127.0.0.1'],
    accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY,
  });
  registerMachineDirectTransferImportRpcHandlers({
    rpcHandlerManager: input.rpcHandlerManager,
    prepareImportSession: async (request) => {
      if (
        request.workingDirectory !== input.workingDirectory
        || (request.additionalAllowedWriteDirs?.length ?? 0) > 0
        || (request.t !== 'session_file_upload_v1' && request.t !== 'session_attachment_upload_v1')
        || (request.t === 'session_attachment_upload_v1'
          && request.workspaceRootPath !== undefined
          && request.workspaceRootPath !== input.workingDirectory)
      ) {
        throw new Error('Unsupported restricted Runner direct transfer import request');
      }
      return await directTransferLifecycle.prepareImportSession({
        ...request,
        workingDirectory: input.workingDirectory,
        additionalAllowedWriteDirs: [],
      });
    },
    abortImportSession: directTransferLifecycle.abortImportSession,
  });
  registerMachineDirectTransferExportRpcHandlers({
    rpcHandlerManager: input.rpcHandlerManager,
    prepareExportSession: async (request) => {
      if (request.t !== 'workspace_file_download_v1' || request.workingDirectory !== input.workingDirectory) {
        throw new Error('Unsupported restricted Runner direct transfer export request');
      }
      const resolved = await resolveWorkspaceFileDownloadSource({
        workingDirectory: input.workingDirectory,
        path: request.path,
        asZip: request.asZip,
        confinedToWorkingDirectory: request.confinedToWorkingDirectory,
        accessPolicy: OS_USER_FILESYSTEM_ACCESS_POLICY,
        sessionRpcTransferMaxBytes: null,
      });
      if (!resolved.success) throw new Error(resolved.error);
      const payloadSource = createFileTransferPayloadSource({
        filePath: resolved.source.filePath,
        sizeBytes: resolved.source.sizeBytes,
        name: resolved.source.name,
        ...(resolved.source.deleteFileOnClose
          ? { dispose: async () => await rm(resolved.source.filePath, { force: true }) }
          : {}),
      });
      const published = await directTransferLifecycle.publishTransferWhenReady({
        transferId: `workspace-file-download:${randomUUID()}`,
        payloadSource,
      });
      return {
        transferId: published.transferId,
        expiresAt: published.expiresAt,
        endpointCandidates: published.endpointCandidates,
        name: resolved.source.name,
        sizeBytes: resolved.source.sizeBytes,
      };
    },
    releaseExportSession: async (transferId) => directTransferLifecycle.clearPublishedTransfer(transferId),
  });

  return Object.freeze({
    ensureDirectTransferListening: directTransferLifecycle.ensureListening,
    dispose: async () => {
      try {
        await directTransferLifecycle.stop();
      } finally {
        try {
          await localServicesRuntime.stop();
        } finally {
          try {
            terminal.dispose();
          } finally {
            await filesystem.dispose();
          }
        }
      }
    },
  });
}
