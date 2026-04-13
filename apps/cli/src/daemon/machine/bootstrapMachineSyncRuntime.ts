import fs from 'fs/promises';
import os from 'os';
import { randomUUID } from 'node:crypto';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { Machine, MachineMetadata } from '@/api/types';
import type { SessionHandoffDirectPeerTransferHandle } from '@/api/machine/sessionHandoff/rpcHandlers.sessionHandoff';
import { createFileTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import type { DirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { resolvePromptAssetDownloadSource } from '@/transfers/targets/resolvePromptAssetDownloadSource';
import { resolvePromptRegistryItemDownloadSource } from '@/transfers/targets/resolvePromptRegistryItemDownloadSource';
import { resolveWorkspaceFileDownloadSource } from '@/transfers/targets/resolveWorkspaceFileDownloadSource';
import type { PromptAssetReadRequest, PromptRegistryFetchItemRequestV1 } from '@happier-dev/protocol';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import { createDaemonConnectivityCoordinator } from '../connection/createDaemonConnectivityCoordinator';
import type { ConnectedServiceQuotasLoopHandle } from '../connectedServices/quotas/startConnectedServiceQuotasLoop';
import { logger } from '@/ui/logger';
import type { PromptRegistryRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';

type ConnectedServiceRefreshLoopHandle = Readonly<{
  stop: () => void;
  pause: () => void;
  resume: () => void;
}>;

type SavePreparedTargetLocalMetadataInput = Readonly<{
  remoteSessionId: string;
  exportMetadataOverlay: Record<string, unknown>;
}>;

export type BootstrapMachineSyncRuntimeResult = Readonly<{
  apiMachine: ApiMachineClient | null;
  apiMachineForSessions: ApiMachineClient | null;
  automationWorker: AutomationWorkerHandle | null;
  memoryWorker: MemoryWorkerHandle | null;
  daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null;
  machineConnectionStateCleanup: (() => void) | null;
}>;

export type BootstrapMachineSyncRuntimeParams = Readonly<{
  cliVersion: string;
  machineId: string;
  machine: Machine;
  preferredHost: string;
  happyHomeDir: string;
  happyLibDir: string;
  takeoverRequested: boolean;
  isShuttingDown: () => boolean;
  createConnectedApiMachine: (machine: Machine) => ApiMachineClient | null;
  attachTransferRuntimeStatePublisher: (apiMachine: ApiMachineClient) => Promise<void>;
  startAutomationWorkerForMachine: (machineId: string) => AutomationWorkerHandle | null;
  startMemoryWorkerForMachine: (machineId: string) => Promise<MemoryWorkerHandle | null>;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  stopSession: (sessionId: string) => Promise<boolean>;
  isSessionAlreadyRunning: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadataForHandoff: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  savePreparedTargetLocalMetadata: (input: SavePreparedTargetLocalMetadataInput) => Promise<void>;
  beforeShutdown: () => Promise<void>;
  requestShutdown: (source: 'happier-app', errorMessage?: string) => void;
  directPeerServerLifecycle: DirectTransferServerLifecycle | null;
  directTransferPromptAssetAdapterRegistry: ReturnType<typeof createPromptAssetAdapterRegistry>;
  directTransferPromptRegistryRegistry: PromptRegistryRegistry;
  connectedServiceRefreshLoopHandle: ConnectedServiceRefreshLoopHandle | null;
  connectedServiceQuotasLoopHandle: ConnectedServiceQuotasLoopHandle | null;
}>;

export async function bootstrapMachineSyncRuntime(
  params: BootstrapMachineSyncRuntimeParams,
): Promise<BootstrapMachineSyncRuntimeResult> {
  if (params.isShuttingDown()) {
    return {
      apiMachine: null,
      apiMachineForSessions: null,
      automationWorker: null,
      memoryWorker: null,
      daemonConnectivityCoordinator: null,
      machineConnectionStateCleanup: null,
    };
  }

  const connectedApiMachine = params.createConnectedApiMachine(params.machine);
  if (connectedApiMachine) {
    await params.attachTransferRuntimeStatePublisher(connectedApiMachine);
  }

  let automationWorker: AutomationWorkerHandle | null = null;
  let memoryWorker: MemoryWorkerHandle | null = null;

  const directPeerServerLifecycle = params.directPeerServerLifecycle;
  const directPeerTransferHandlers: SessionHandoffDirectPeerTransferHandle | null = directPeerServerLifecycle
    ? {
        publishTransfer: async ({ transferId, payload: _payload, payloadSource, onDemandScope }) => {
          if (!payloadSource) {
            throw new Error('Direct peer handoff publish requires a file-backed payload source');
          }
          return (await directPeerServerLifecycle.publishTransferWhenReady({
            transferId,
            payloadSource,
            ...(onDemandScope ? { onDemandScope } : {}),
          })).endpointCandidates;
        },
        requestPayloadFile: async ({ transferId, endpointCandidates, destinationPath, openBody, timeoutMs }) =>
          await directPeerServerLifecycle.requestPayloadFile({
            transferId,
            endpointCandidates,
            destinationPath,
            ...(openBody !== undefined ? { openBody } : {}),
            ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
          }),
        clearPublishedTransfer: (transferId: string) => directPeerServerLifecycle.clearPublishedTransfer(transferId),
      }
    : null;

  const directTransferExportHandlers = directPeerServerLifecycle
    ? {
        prepareExportSession: async (
          input:
            | Readonly<{
                t: 'prompt_asset_download_v1';
                assetTypeId: string;
                scope: PromptAssetReadRequest['scope'];
                externalRef: PromptAssetReadRequest['externalRef'];
              }>
            | Readonly<{
                t: 'prompt_registry_download_v1';
                sourceId: string;
                itemId: string;
                configuredSources: PromptRegistryFetchItemRequestV1['configuredSources'];
              }>
            | Readonly<{
                t: 'workspace_file_download_v1';
                workingDirectory: string;
                path: string;
                asZip: boolean;
              }>,
        ) => {
          const resolvedSource =
            input.t === 'prompt_asset_download_v1'
              ? await resolvePromptAssetDownloadSource({
                  adapterRegistry: params.directTransferPromptAssetAdapterRegistry,
                  request: {
                    assetTypeId: input.assetTypeId,
                    scope: input.scope,
                    externalRef: input.externalRef,
                  },
                })
              : input.t === 'prompt_registry_download_v1'
                ? await resolvePromptRegistryItemDownloadSource({
                    registry: params.directTransferPromptRegistryRegistry,
                    request: {
                      sourceId: input.sourceId,
                      itemId: input.itemId,
                      configuredSources: input.configuredSources,
                    },
                  })
                : input.t === 'workspace_file_download_v1'
                  ? await resolveWorkspaceFileDownloadSource({
                      workingDirectory: input.workingDirectory,
                      path: input.path,
                      asZip: input.asZip,
                      sessionRpcTransferMaxBytes: null,
                    })
                  : { success: false as const, error: 'Unsupported direct transfer export request' };
          if (!resolvedSource.success) {
            throw new Error(resolvedSource.error);
          }
          const payloadSource = createFileTransferPayloadSource({
            filePath: resolvedSource.source.filePath,
            sizeBytes: resolvedSource.source.sizeBytes,
            name: resolvedSource.source.name,
            dispose: resolvedSource.source.deleteFileOnClose
              ? async () => {
                  await fs.rm(resolvedSource.source.filePath, { force: true }).catch(() => undefined);
                }
              : undefined,
          });

          const transferId = `${
            input.t === 'prompt_asset_download_v1'
              ? 'prompt-asset-download'
              : input.t === 'prompt_registry_download_v1'
                ? 'prompt-registry-download'
                : 'workspace-file-download'
          }:${randomUUID()}`;
          const published = await directPeerServerLifecycle.publishTransferWhenReady({
            transferId,
            payloadSource,
          });

          return {
            transferId: published.transferId,
            endpointCandidates: published.endpointCandidates,
            expiresAt: published.expiresAt,
            name: resolvedSource.source.name,
            sizeBytes: resolvedSource.source.sizeBytes,
          };
        },
      }
    : null;

  let daemonConnectivityCoordinator: ReturnType<typeof createDaemonConnectivityCoordinator> | null = null;
  let machineConnectionStateCleanup: (() => void) | null = null;

  if (connectedApiMachine) {
    automationWorker = params.startAutomationWorkerForMachine(params.machineId);
    const activeAutomationWorker = automationWorker;
    memoryWorker = await params.startMemoryWorkerForMachine(params.machineId);

    connectedApiMachine.setRPCHandlers(
      {
        spawnSession: params.spawnSession,
        stopSession: params.stopSession,
        isSessionActive: params.isSessionAlreadyRunning,
        loadLocalSessionMetadata: params.loadLocalSessionMetadataForHandoff,
        savePreparedTargetLocalMetadata: async ({ remoteSessionId, exportMetadataOverlay }) => {
          await params.savePreparedTargetLocalMetadata({
            remoteSessionId,
            exportMetadataOverlay,
          });
        },
        requestShutdown: () => {
          void params.beforeShutdown().finally(() => params.requestShutdown('happier-app'));
        },
        ...(memoryWorker ? { memory: memoryWorker } : {}),
        machineTransferChannel: {
          onEnvelope: (listener) => connectedApiMachine.onMachineTransferEnvelope(listener),
          sendEnvelope: (payload) => connectedApiMachine.sendMachineTransferEnvelope(payload),
        },
        transferRelayV2Channel: {
          machineId: params.machineId,
          onEnvelope: (listener) => connectedApiMachine.onTransferRelayV2Envelope(listener),
          sendEnvelope: (payload) => connectedApiMachine.sendTransferRelayV2Envelope(payload),
        },
        ...(directPeerTransferHandlers ? { directPeerTransfer: directPeerTransferHandlers } : {}),
        ...(directPeerServerLifecycle
          ? {
              directTransferImport: {
                prepareImportSession: directPeerServerLifecycle.prepareImportSession,
              },
            }
          : {}),
        ...(directTransferExportHandlers
          ? {
              directTransferExport: directTransferExportHandlers,
            }
          : {}),
      },
      {
        emitDirectSessionTranscriptUpdate: (payload) => connectedApiMachine.emitDirectSessionTranscriptUpdate(payload),
      },
    );

    connectedApiMachine.onUpdate((update) => {
      if (!activeAutomationWorker) return false;
      const t = (update?.body as any)?.t;
      if (t === 'automation-assignment-updated' || t === 'automation-run-updated') {
        const automationWorkerHandle = activeAutomationWorker;
        automationWorkerHandle.handleServerUpdate(update);
        return true;
      }
      return false;
    });

    const connectedServiceQuotasLoopHandle = params.connectedServiceQuotasLoopHandle;
    const connectedServiceRefreshLoopHandle = params.connectedServiceRefreshLoopHandle;

    daemonConnectivityCoordinator = createDaemonConnectivityCoordinator({
      resources: [
        ...(activeAutomationWorker
          ? [
              {
                name: 'automationWorker',
                pause: () => {
                  const automationWorkerHandle = activeAutomationWorker;
                  automationWorkerHandle.pause();
                },
                resume: () => {
                  const automationWorkerHandle = activeAutomationWorker;
                  automationWorkerHandle.resume();
                },
              },
            ]
          : []),
        ...(connectedServiceQuotasLoopHandle
          ? [
              {
                name: 'connectedServiceQuotasLoop',
                pause: () => connectedServiceQuotasLoopHandle.pause(),
                resume: () => connectedServiceQuotasLoopHandle.resume(),
              },
            ]
          : []),
        ...(connectedServiceRefreshLoopHandle
          ? [
              {
                name: 'connectedServiceRefreshLoop',
                pause: () => connectedServiceRefreshLoopHandle.pause(),
                resume: () => connectedServiceRefreshLoopHandle.resume(),
              },
            ]
          : []),
      ],
    });

    machineConnectionStateCleanup = connectedApiMachine.onConnectionStateChange((state) => {
      void daemonConnectivityCoordinator!.applyState(state).catch((error) => {
        logger.warn('[DAEMON RUN] Failed to apply daemon connectivity state', error);
      });
    });

    let didRefreshMachineMetadata = false;
    connectedApiMachine.connect({
      takeover: params.takeoverRequested,
      onConnect: async () => {
        if (params.isShuttingDown()) return;

        if (activeAutomationWorker) {
          const automationWorkerHandle = activeAutomationWorker;
          await automationWorkerHandle.refreshAssignments().catch((error) => {
            logger.warn('[DAEMON RUN] Failed to refresh automation assignments on machine reconnect', error);
          });
        }

        if (didRefreshMachineMetadata) return;
        didRefreshMachineMetadata = true;
        await connectedApiMachine
          .updateMachineMetadata((metadata) => {
            const base = (metadata ?? (params.machine.metadata as any) ?? {}) as any;
            const next: MachineMetadata = {
              ...base,
              host: params.preferredHost,
              platform: os.platform(),
              happyCliVersion: params.cliVersion,
              homeDir: os.homedir(),
              happyHomeDir: params.happyHomeDir,
              happyLibDir: params.happyLibDir,
            } as MachineMetadata;

            const current = base as Partial<MachineMetadata>;
            const isSame =
              current.host === next.host &&
              current.platform === next.platform &&
              current.happyCliVersion === next.happyCliVersion &&
              current.homeDir === next.homeDir &&
              current.happyHomeDir === next.happyHomeDir &&
              current.happyLibDir === next.happyLibDir;

            if (isSame) {
              return base as MachineMetadata;
            }

            return next;
          })
          .catch((error) => {
            didRefreshMachineMetadata = false;
            logger.warn('[DAEMON RUN] Failed to refresh machine metadata on reconnect', error);
          });
      },
      onOwnershipConflict: (conflict) => {
        logger.warn('[DAEMON RUN] Relay ownership conflict prevented machine connection', conflict);
        params.requestShutdown('happier-app', 'machine-owner-conflict');
      },
    });
  } else {
    logger.warn('[DAEMON RUN] Diagnostic gate enabled: machine sync disabled');
  }

  return {
    apiMachine: connectedApiMachine,
    apiMachineForSessions: connectedApiMachine,
    automationWorker,
    memoryWorker,
    daemonConnectivityCoordinator,
    machineConnectionStateCleanup,
  };
}
