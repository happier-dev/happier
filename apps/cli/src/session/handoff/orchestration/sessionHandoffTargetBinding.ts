import { projectCurrentAgentSessionView } from '@happier-dev/agents';
import type { Credentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type { SessionHandoffCoordinatorInput } from './sessionHandoffCoordinator';
import type {
  SessionHandoffPrepareTargetResultGetResponse,
  SessionHandoffStartResponse,
} from '@happier-dev/protocol';

export async function bindSessionHandoffTarget(params: Readonly<{
  credentials: Credentials;
  request: SessionHandoffCoordinatorInput;
  started: SessionHandoffStartResponse;
  prepared: SessionHandoffPrepareTargetResultGetResponse;
  completedAtMs: number;
}>): Promise<void> {
  const rawSession = await fetchSessionById({
    token: params.credentials.token,
    sessionId: params.request.sessionId,
    reason: 'legacy-compat-proof',
  });
  if (!rawSession) throw new Error('Session is unavailable while binding handoff target');

  await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: params.request.sessionId,
    rawSession,
    updater: (metadata) => buildSessionHandoffTargetMetadata({ ...params, metadata }),
  });
}

export function buildSessionHandoffTargetMetadata(params: Readonly<{
  metadata: Record<string, unknown>;
  request: SessionHandoffCoordinatorInput;
  started: SessionHandoffStartResponse;
  prepared: SessionHandoffPrepareTargetResultGetResponse;
  completedAtMs: number;
}>): Record<string, unknown> {
  const providerId = params.prepared.resume.agent;
  const targetStorage = params.request.targetSessionStorageMode ?? params.request.sessionStorageMode;
  const next = projectCurrentAgentSessionView({
    metadata: {
      ...params.metadata,
      machineId: params.request.targetMachineId,
      path: params.prepared.resume.directory,
    },
    target: { agentId: providerId, updatedAtMs: params.completedAtMs },
    nativeResumeId: params.prepared.remoteSessionId,
    agentScopedCurrentState: 'carry',
  }) as Record<string, unknown>;

  if (targetStorage === 'direct') {
    delete next.externalHistoryImportV1;
    next.directSessionV1 = {
      v: 1,
      providerId,
      machineId: params.request.targetMachineId,
      remoteSessionId: params.prepared.remoteSessionId,
      source: params.prepared.directSource,
      linkedAtMs: params.completedAtMs,
      ...(params.prepared.agentRuntimeDescriptorV1
        ? { agentRuntimeDescriptorV1: params.prepared.agentRuntimeDescriptorV1 }
        : {}),
    };
  } else {
    delete next.directSessionV1;
    next.externalHistoryImportV1 = {
      v: 1,
      providerId,
      remoteSessionId: params.prepared.remoteSessionId,
      importedAtMs: params.completedAtMs,
      source: params.prepared.directSource,
    };
  }
  if (params.prepared.agentRuntimeDescriptorV1) {
    next.agentRuntimeDescriptorV1 = params.prepared.agentRuntimeDescriptorV1;
  }
  next.handoffV1 = {
    v: 1,
    sourceMachineId: params.request.sourceMachineId,
    targetMachineId: params.request.targetMachineId,
    providerId,
    sessionStorageBefore: params.request.sessionStorageMode,
    sessionStorageAfter: targetStorage,
    transportStrategy: params.started.status.transportStrategy ?? 'server_routed_stream',
    completedAtMs: params.completedAtMs,
    sourceWorkspaceRootPath: params.started.handoffMetadataV2?.workspaceReplicationSourceRootPath ?? params.started.targetPath,
    targetWorkspaceRootPath: params.prepared.resume.directory,
  };
  return next;
}
