import os from 'node:os';

import {
  type SessionHandoffPrepareTargetRequest,
  type SessionHandoffStatus,
} from '@happier-dev/protocol';

import {
  createSessionHandoffPrepareTargetJobStore,
  type SessionHandoffPrepareTargetJobRecordV2,
} from '../../../session/handoff/prepare/sessionHandoffPrepareTargetJobStore';
import { createSessionHandoffSourceExportStore } from '../../../session/handoff/state/sessionHandoffSourceExportStore';
import {
  createSessionHandoffWorkspaceReplicationAdapter,
} from '../../../session/handoff/workspaceReplication/workspaceReplicationAdapter/adapter';

import {
  buildPrepareJobId,
  buildPrepareJobRecord,
  buildPreparePendingStatus,
  isTerminalHandoffStatus,
  readPersistedPrepareJob,
} from './prepareTargetState';
import { runSessionHandoffPrepareTargetJob } from './prepareTargetRunJob';
import {
  resolvePrepareTargetResponseAfterFastPath,
  type SessionHandoffPrepareTargetResponse,
} from './prepareTargetResponse';
import type { SessionHandoffRuntimeConfig } from './runtimeConfig';

type SessionHandoffPrepareTargetJobStore = ReturnType<typeof createSessionHandoffPrepareTargetJobStore>;
type SessionHandoffSourceExportStore = ReturnType<typeof createSessionHandoffSourceExportStore>;
type SessionHandoffWorkspaceReplicationAdapter = ReturnType<typeof createSessionHandoffWorkspaceReplicationAdapter>;
type SessionHandoffWorkspaceReplicationTransfers = ReturnType<SessionHandoffWorkspaceReplicationAdapter['createReplicationTransfers']>;
type SessionHandoffPrepareTargetJobInput = Parameters<typeof runSessionHandoffPrepareTargetJob>[0];

type SessionHandoffPrepareTargetBootstrapResponse = Readonly<{
  kind: 'response';
  response: SessionHandoffPrepareTargetResponse;
}>;

type SessionHandoffPrepareTargetBootstrapRun = Readonly<{
  kind: 'bootstrap';
  jobId: string;
  pendingStatus: SessionHandoffStatus;
  runJob: Promise<void>;
}>;

export type SessionHandoffPrepareTargetBootstrapResult =
  | SessionHandoffPrepareTargetBootstrapResponse
  | SessionHandoffPrepareTargetBootstrapRun;

export type ResolvePrepareTargetBootstrapInput = Readonly<{
  request: SessionHandoffPrepareTargetRequest;
  acceptedResumeJobId?: string;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
  sourceExportStore: SessionHandoffSourceExportStore;
  activePrepareJobs: Map<string, Promise<void>>;
  prepareTargetJobLeaseOwnerId: string;
  prepareTargetJobLeaseTtlMs: number;
  runtimeConfig: SessionHandoffRuntimeConfig;
  machineTransferChannel: SessionHandoffPrepareTargetJobInput['machineTransferChannel'];
  directPeerTransfer: SessionHandoffPrepareTargetJobInput['directPeerTransfer'];
  workspaceReplicationAdapter: SessionHandoffWorkspaceReplicationAdapter;
  workspaceReplicationTransfers: SessionHandoffWorkspaceReplicationTransfers;
  importSessionBundle: SessionHandoffPrepareTargetJobInput['importSessionBundle'];
  savePreparedTargetLocalMetadata?: SessionHandoffPrepareTargetJobInput['savePreparedTargetLocalMetadata'];
  getTransferRouteCache: SessionHandoffPrepareTargetJobInput['getTransferRouteCache'];
  invalidateDirectPeerRouteCacheForHandoffMachines: SessionHandoffPrepareTargetJobInput['invalidateDirectPeerRouteCacheForHandoffMachines'];
}>;

export async function resolvePrepareTargetResponseAfterBootstrap(input: Readonly<{
  handoffId: string;
  bootstrap: SessionHandoffPrepareTargetBootstrapResult;
  prepareJobStore: SessionHandoffPrepareTargetJobStore;
}>): Promise<SessionHandoffPrepareTargetResponse> {
  if (input.bootstrap.kind === 'response') {
    return input.bootstrap.response;
  }

  return resolvePrepareTargetResponseAfterFastPath({
    handoffId: input.handoffId,
    jobId: input.bootstrap.jobId,
    pendingStatus: input.bootstrap.pendingStatus,
    prepareJobStore: input.prepareJobStore,
    runJob: input.bootstrap.runJob,
  });
}

export async function resolvePrepareTargetBootstrap(
  input: ResolvePrepareTargetBootstrapInput,
): Promise<SessionHandoffPrepareTargetBootstrapResult> {
  const persistedJob = await readPersistedPrepareJob({
    handoffId: input.request.handoffId,
    jobStore: input.prepareJobStore,
  });

  if (persistedJob?.prepareTargetResult) {
    return {
      kind: 'response',
      response: persistedJob.prepareTargetResult,
    };
  }

  if (persistedJob && isTerminalHandoffStatus(persistedJob.status)) {
    return {
      kind: 'response',
      response: {
        handoffId: input.request.handoffId,
        status: persistedJob.status,
      },
    };
  }

  if (persistedJob && !isTerminalHandoffStatus(persistedJob.status)) {
    if (input.activePrepareJobs.has(persistedJob.jobId)) {
      return {
        kind: 'response',
        response: {
          handoffId: input.request.handoffId,
          status: persistedJob.status,
        },
      };
    }
    const isAcceptedExplicitResume =
      input.acceptedResumeJobId === persistedJob.jobId
      && persistedJob.schemaVersion === 2
      && persistedJob.prepareRecovery.status === 'attempted';
    if (!isAcceptedExplicitResume && persistedJob.jobId.startsWith('prepare_')) {
      const interrupted = await input.prepareJobStore.hydrateInterrupted(
        persistedJob.jobId,
        Date.now(),
      );
      return {
        kind: 'response',
        response: {
          handoffId: input.request.handoffId,
          status: interrupted?.status ?? persistedJob.status,
        },
      };
    }
  }

  const jobId = persistedJob?.jobId ?? buildPrepareJobId(input.request.handoffId);
  const pendingUpdatedAtMs = Date.now();
  const createdAtMs = persistedJob?.createdAtMs ?? pendingUpdatedAtMs;
  const isRestartingPersistedJob = Boolean(
    persistedJob
    && !isTerminalHandoffStatus(persistedJob.status)
    && !input.activePrepareJobs.has(persistedJob.jobId),
  );
  const pendingStatus = buildPreparePendingStatus({
    handoffId: input.request.handoffId,
    jobId,
    transportStrategy: input.request.negotiatedTransportStrategy,
    recoveryActions: [],
    phaseDetail: isRestartingPersistedJob ? 'resuming_after_restart' : 'transferring_session',
    ...(input.request.handoffMetadataV2?.agentBundleTransferPublication
      ? {
        sessionTransfer: {
          currentBytes: 0,
          totalBytes: input.request.handoffMetadataV2.agentBundleTransferPublication.sizeBytes,
        },
      }
      : {}),
  });

  await input.prepareJobStore.write(buildPrepareJobRecord({
    jobId,
    handoffId: input.request.handoffId,
    createdAtMs,
    updatedAtMs: pendingUpdatedAtMs,
    status: pendingStatus,
  }));

  const existingActiveJob = input.activePrepareJobs.get(jobId);
  let runJob = existingActiveJob;
  if (!runJob) {
    runJob = runSessionHandoffPrepareTargetJob({
      activeServerDir: input.runtimeConfig.activeServerDir,
      homeDir: os.homedir(),
      runtimeConfig: input.runtimeConfig,
      jobId,
      handoffId: input.request.handoffId,
      createdAtMs,
      request: input.request,
      actualTransportStrategy: input.request.negotiatedTransportStrategy,
      pendingStatus,
      prepareTargetRequest: persistedJob?.prepareTargetRequest,
      workspaceReplicationJobId: persistedJob?.workspaceReplicationJobId,
      prepareJobStore: input.prepareJobStore,
      sourceExportStore: input.sourceExportStore,
      prepareTargetJobLeaseOwnerId: input.prepareTargetJobLeaseOwnerId,
      prepareTargetJobLeaseTtlMs: input.prepareTargetJobLeaseTtlMs,
      machineTransferChannel: input.machineTransferChannel,
      directPeerTransfer: input.directPeerTransfer,
      workspaceReplicationAdapter: input.workspaceReplicationAdapter,
      workspaceReplicationTransfers: input.workspaceReplicationTransfers,
      importSessionBundle: input.importSessionBundle,
      savePreparedTargetLocalMetadata: input.savePreparedTargetLocalMetadata,
      getTransferRouteCache: input.getTransferRouteCache,
      invalidateDirectPeerRouteCacheForHandoffMachines: input.invalidateDirectPeerRouteCacheForHandoffMachines,
    }).finally(() => {
      if (input.activePrepareJobs.get(jobId) === runJob) {
        input.activePrepareJobs.delete(jobId);
      }
    });
  }

  input.activePrepareJobs.set(jobId, runJob);

  return {
    kind: 'bootstrap',
    jobId,
    pendingStatus,
    runJob,
  };
}

export async function resumePersistedPrepareTarget(
  input: Omit<ResolvePrepareTargetBootstrapInput, 'request'> & Readonly<{
    record: SessionHandoffPrepareTargetJobRecordV2;
  }>,
): Promise<void> {
  if (!input.record.prepareTargetRequest) {
    throw new Error('Interrupted prepare-target job has no persisted request');
  }
  if (input.record.prepareTargetRequest.handoffId !== input.record.handoffId) {
    throw new Error('Interrupted prepare-target job identity disagrees with its persisted request');
  }
  await resolvePrepareTargetBootstrap({
    ...input,
    request: input.record.prepareTargetRequest,
    acceptedResumeJobId: input.record.jobId,
  });
}
