import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import { SessionCreationCorrespondenceV1ReadSchema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import type { SessionHandoffMetadataV2, SessionHandoffStartRequest, SessionHandoffStatus, TransferEndpointCandidate } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { createWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { buildSessionHandoffWorkspaceSeedTransferId } from '@/session/handoff/agentBundle/transferPublication';

import {
  createFileTransferPayloadSource,
  disposeTransferPayloadSource,
  type TransferPayloadSource,
} from '../../../machines/transfer/transferPayloadSource';
import type { SessionHandoffAgentBundle } from '../../../session/handoff/types';
import type { SessionHandoffAgentBundleTransferPublication } from '../../../session/handoff/agentBundle/transferPublication';
import type { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';

import type { SessionHandoffDirectPeerTransferHandle } from './prepareTransport';
import type { DeferredDirectPeerPreExportedAgentBundle } from './startDeferredDirectPeer';

export type PrepareStartedStateCallInput = Readonly<{
  handoffId: string;
  request: SessionHandoffStartRequest;
  metadata: Record<string, unknown>;
  sourceStopState: 'stopped' | 'already_inactive';
  onProgress?: (progress: Readonly<{ currentBytes: number; totalBytes: number }>) => void;
  preExportedAgentBundle?: DeferredDirectPeerPreExportedAgentBundle;
}>;

export type StoredHandoffState = Readonly<{
  status: SessionHandoffStatus;
  sourceMachineId?: string;
  targetMachineId?: string;
  agentBundlePayloadSource?: TransferPayloadSource;
  directPeerPayloadSources?: readonly Readonly<{
    transferId: string;
    payloadSource: TransferPayloadSource;
  }>[];
  handoffMetadataV2?: SessionHandoffMetadataV2;
}>;

export type PrepareStartedStateResult = Readonly<{
  targetPath: string;
  endpointCandidates: readonly TransferEndpointCandidate[];
  nextState: StoredHandoffState;
  agentBundlePayloadSource?: TransferPayloadSource;
}>;

export async function prepareStartedState(input: Readonly<{
  activeServerDir?: string;
  callInput: PrepareStartedStateCallInput;
  exportSessionBundle: (
    metadata: Record<string, unknown>,
  ) => Promise<Readonly<{ agentBundle: SessionHandoffAgentBundle; targetPath: string }>>;
  sourceExportStore: ReturnType<typeof createSessionHandoffSourceExportStore>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
  buildStartPendingStatus: (input: Readonly<{
    handoffId: string;
    sourceStopState: 'stopped' | 'already_inactive';
  }>) => SessionHandoffStatus;
}>): Promise<PrepareStartedStateResult> {
  const { callInput } = input;
  if (callInput.request.stateTransfer === 'existing') {
    const targetPath = typeof callInput.request.targetPath === 'string'
      ? callInput.request.targetPath
      : typeof callInput.metadata.path === 'string' ? callInput.metadata.path.trim() : '';
    if (!targetPath) throw new Error('Session path is unavailable for handoff');
    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      stateTransfer: 'existing',
      exportedAtMs: Date.now(),
    });
    return { targetPath, endpointCandidates: [], nextState: {
      status: input.buildStartPendingStatus({ handoffId: callInput.handoffId, sourceStopState: callInput.sourceStopState }),
      sourceMachineId: callInput.request.sourceMachineId, targetMachineId: callInput.request.targetMachineId,
    } };
  }
  let agentBundlePayloadSource: TransferPayloadSource | null =
    callInput.preExportedAgentBundle?.agentBundlePayloadSource ?? null;
  let agentBundleTransferPublication: SessionHandoffAgentBundleTransferPublication | null =
    callInput.preExportedAgentBundle?.agentBundleTransferPublication ?? null;
  let workspaceSeed: Awaited<ReturnType<typeof input.sourceExportStore.writeWorkspaceSeedFiles>> | undefined;
  let managedSeedStarted = false;

  try {
    if (callInput.request.targetDirectory?.kind === 'managed') {
      const activeServerDir = input.activeServerDir ?? configuration.activeServerDir;
      const path = typeof callInput.metadata.path === 'string' ? callInput.metadata.path : '';
      const correspondence = SessionCreationCorrespondenceV1ReadSchema.safeParse(callInput.metadata.sessionCreationCorrespondenceV1);
      const source = readSessionDirectoryKind(callInput.metadata) === 'managed'
        ? await createManagedSessionDirectories({ activeServerDir }).resolveForSession({
            sessionId: callInput.request.sessionId, path,
            sessionCreationTag: correspondence.success ? correspondence.data.sessionCreationTag : undefined,
          })
        : { ok: false as const, errorCode: 'SESSION_DIRECTORY_MISSING' as const };
      if (!source.ok) throw Object.assign(new Error('Managed handoff source directory is unavailable'), { code: source.errorCode });
      managedSeedStarted = true;
      const transferId = buildSessionHandoffWorkspaceSeedTransferId(callInput.handoffId);
      const seed = await createWorkspaceSyncSeedExport({ operationId: transferId, activeServerDir, sourcePath: source.directory,
        workspaceTransfer: resolveWorkspaceSyncSeedTransfer({ selection: 'all_files', extraIgnorePatterns: [], extraIncludePatterns: [] }),
      });
      workspaceSeed = await input.sourceExportStore.writeWorkspaceSeedFiles({ handoffId: callInput.handoffId, transferId, seed });
      if (callInput.request.negotiatedTransportStrategy === 'direct_peer' && input.directPeerTransfer) {
        const manifest = workspaceSeed.files[transferId]!;
        const files = workspaceSeed.files;
        const endpointCandidates = await input.directPeerTransfer.publishTransfer({ transferId, payload: {},
          payloadSource: createFileTransferPayloadSource(manifest),
          onDemandScope: { allowTransferId: (id) => id !== transferId && Object.hasOwn(files, id),
            maxResolvedTransfers: Object.keys(files).length - 1,
            resolvePayloadSourceOnOpen: async ({ transferId: id }) => {
              const file = Object.hasOwn(files, id) ? files[id] : undefined;
              if (!file) throw new Error('Managed handoff seed blob is not authorized');
              return createFileTransferPayloadSource(file);
            },
          },
        });
        workspaceSeed = { ...workspaceSeed, endpointCandidates };
      }
    }
    const exported = callInput.preExportedAgentBundle
      ? {
          agentBundle: callInput.preExportedAgentBundle.agentBundle,
          targetPath: callInput.preExportedAgentBundle.targetPath,
        }
      : await input.exportSessionBundle(callInput.metadata);

    const persistedAgentBundle = await input.sourceExportStore.writeAgentBundleFile({
      handoffId: callInput.handoffId,
      agentBundle: exported.agentBundle,
      ...(callInput.onProgress ? { onProgress: callInput.onProgress } : {}),
    });

    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      exportedAtMs: Date.now(),
      agentBundle: {
        ...persistedAgentBundle,
        ...(callInput.preExportedAgentBundle?.agentBundleTransferPublication?.endpointCandidates?.length
          ? { endpointCandidates: [...callInput.preExportedAgentBundle.agentBundleTransferPublication.endpointCandidates] }
          : {}),
      },
      ...(workspaceSeed ? { workspaceSeed } : {}),
    });

    agentBundlePayloadSource =
      agentBundlePayloadSource ?? createFileTransferPayloadSource({
        filePath: persistedAgentBundle.filePath,
        sizeBytes: persistedAgentBundle.sizeBytes,
        manifestHash: persistedAgentBundle.manifestHash,
      });

    const agentBundleEndpointCandidates: TransferEndpointCandidate[] =
      callInput.request.negotiatedTransportStrategy === 'direct_peer' && input.directPeerTransfer
        ? (
            agentBundleTransferPublication?.endpointCandidates?.length
              ? [...agentBundleTransferPublication.endpointCandidates]
              : [...await input.directPeerTransfer.publishTransfer({
                  transferId: persistedAgentBundle.transferId,
                  payload: {},
                  payloadSource: agentBundlePayloadSource,
                })]
          )
        : [];

    agentBundleTransferPublication = {
      transferId: persistedAgentBundle.transferId,
      sizeBytes: persistedAgentBundle.sizeBytes,
      manifestHash: persistedAgentBundle.manifestHash,
      ...(agentBundleEndpointCandidates.length > 0
        ? { endpointCandidates: agentBundleEndpointCandidates }
        : {}),
    };

    await input.sourceExportStore.save({
      handoffId: callInput.handoffId,
      sessionId: callInput.request.sessionId,
      sourceMachineId: callInput.request.sourceMachineId,
      targetMachineId: callInput.request.targetMachineId,
      exportedAtMs: Date.now(),
      agentBundle: {
        ...persistedAgentBundle,
        ...(agentBundleTransferPublication.endpointCandidates?.length
          ? { endpointCandidates: [...agentBundleTransferPublication.endpointCandidates] }
          : {}),
      },
      ...(workspaceSeed ? { workspaceSeed } : {}),
    });

    const handoffMetadataV2: SessionHandoffMetadataV2 | undefined =
      agentBundleTransferPublication
        ? {
            ...(agentBundleTransferPublication ? { agentBundleTransferPublication } : {}),
            ...(workspaceSeed ? { workspaceSeedTransferPublication: {
              transferId: workspaceSeed.transferId,
              sizeBytes: workspaceSeed.files[workspaceSeed.transferId]!.sizeBytes,
              manifestHash: workspaceSeed.files[workspaceSeed.transferId]!.manifestHash,
              ...(workspaceSeed.endpointCandidates ? { endpointCandidates: workspaceSeed.endpointCandidates } : {}),
            } } : {}),
          }
        : undefined;

    const status = input.buildStartPendingStatus({
      handoffId: callInput.handoffId,
      sourceStopState: callInput.sourceStopState,
    });

    return {
      targetPath: exported.targetPath,
      endpointCandidates: agentBundleEndpointCandidates,
      ...(agentBundlePayloadSource ? { agentBundlePayloadSource } : {}),
      nextState: {
        status,
        sourceMachineId: callInput.request.sourceMachineId,
        targetMachineId: callInput.request.targetMachineId,
        ...(handoffMetadataV2 ? { handoffMetadataV2 } : {}),
        ...(agentBundlePayloadSource ? { agentBundlePayloadSource } : {}),
      },
    };
  } catch (error) {
    if (workspaceSeed) input.directPeerTransfer?.clearPublishedTransfer(workspaceSeed.transferId);
    if (managedSeedStarted) await input.sourceExportStore.releaseTransferFiles(callInput.handoffId);
    if (agentBundleTransferPublication?.endpointCandidates?.length) {
      input.directPeerTransfer?.clearPublishedTransfer(agentBundleTransferPublication.transferId);
    }
    await disposeTransferPayloadSource(agentBundlePayloadSource);
    throw error;
  }
}
