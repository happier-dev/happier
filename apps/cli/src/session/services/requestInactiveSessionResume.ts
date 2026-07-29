import {
  SpawnSessionExecutionAuthorizationSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { Credentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';

export type InactiveSessionResumeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: 'unsupported' | 'timeout'; message: string }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function buildMachineResumeRequest(options: SpawnSessionOptions, sessionId: string) {
  return {
    type: 'resume-session' as const,
    sessionId,
    directory: options.directory,
    backendTarget: options.backendTarget,
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.runtimeDescriptorV1 ? { runtimeDescriptorV1: options.runtimeDescriptorV1 } : {}),
    ...(options.backendMode ? { backendMode: options.backendMode } : {}),
    ...(options.codexBackendMode ? { codexBackendMode: options.codexBackendMode } : {}),
    ...(options.environmentVariables ? { environmentVariables: options.environmentVariables } : {}),
    ...(options.profileId ? { profileId: options.profileId } : {}),
    ...(options.terminal ? { terminal: options.terminal } : {}),
    ...(options.connectedServices ? { connectedServices: options.connectedServices } : {}),
    ...(typeof options.connectedServicesUpdatedAt === 'number'
      ? { connectedServicesUpdatedAt: options.connectedServicesUpdatedAt }
      : {}),
    ...(options.transcriptStorage ? { transcriptStorage: options.transcriptStorage } : {}),
    ...(options.attachMetadataIdentityPolicy
      ? { attachMetadataIdentityPolicy: options.attachMetadataIdentityPolicy }
      : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(typeof options.permissionModeUpdatedAt === 'number'
      ? { permissionModeUpdatedAt: options.permissionModeUpdatedAt }
      : {}),
    ...(options.agentModeId ? { agentModeId: options.agentModeId } : {}),
    ...(typeof options.agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: options.agentModeUpdatedAt } : {}),
    ...(options.modelSelection ? { modelSelection: options.modelSelection } : {}),
    ...(typeof options.accountSettingsVersionHint === 'number'
      ? { accountSettingsVersionHint: options.accountSettingsVersionHint }
      : {}),
    ...(options.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: options.sessionConfigOptionOverrides }
      : {}),
    ...(options.mcpSelection ? { mcpSelection: options.mcpSelection } : {}),
    ...(options.windowsRemoteSessionLaunchMode
      ? { windowsRemoteSessionLaunchMode: options.windowsRemoteSessionLaunchMode }
      : {}),
    ...(options.windowsRemoteSessionConsole
      ? { windowsRemoteSessionConsole: options.windowsRemoteSessionConsole }
      : {}),
    ...(options.windowsTerminalWindowName
      ? { windowsTerminalWindowName: options.windowsTerminalWindowName }
      : {}),
    ...(typeof options.initialTranscriptAfterSeq === 'number'
      ? { initialTranscriptAfterSeq: options.initialTranscriptAfterSeq }
      : {}),
    ...(options.executionAuthorization ? { executionAuthorization: options.executionAuthorization } : {}),
  };
}

/** Explicit user-action seam; persisted recovery owners never call this service. */
export async function requestInactiveSessionResume(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  localId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  timeoutMs?: number;
}>): Promise<InactiveSessionResumeResult> {
  const rawSessionId = readNonEmptyString(params.rawSession.id);
  if (!rawSessionId || rawSessionId !== params.sessionId) {
    return { ok: false, code: 'unsupported', message: 'Inactive session identity is inconsistent; pending custody was retained' };
  }
  const rawMachineId = readNonEmptyString(params.rawSession.machineId);
  const metadataMachineId = readNonEmptyString(params.metadata.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) {
    return { ok: false, code: 'unsupported', message: 'Inactive session machine identity is inconsistent; pending custody was retained' };
  }
  const machineId = rawMachineId ?? metadataMachineId;
  if (!machineId) {
    return { ok: false, code: 'unsupported', message: 'Inactive session has no recorded machine target; pending custody was retained' };
  }

  const executionAuthorization = SpawnSessionExecutionAuthorizationSchema.parse({
    provenance: 'user_request',
    requestId: params.localId,
  });
  const options = buildInactiveSessionResumeSpawnOptions({
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata: params.metadata,
    ...(typeof params.rawSession.seq === 'number' ? { initialTranscriptAfterSeq: params.rawSession.seq } : {}),
    executionAuthorization,
  });
  if (!options || options.machineId !== machineId || !options.backendTarget) {
    return { ok: false, code: 'unsupported', message: 'Inactive session resume identity is incomplete; pending custody was retained' };
  }

  try {
    const response = await callMachineRpc({
      credentials: params.credentials,
      machineId,
      method: options.modelSelection?.ref.providerConnectionId != null
        ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
        : RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: buildMachineResumeRequest(options, params.sessionId),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    });
    const responseSessionId = response && typeof response === 'object'
      ? readNonEmptyString((response as { sessionId?: unknown }).sessionId)
      : null;
    if (
      !response
      || typeof response !== 'object'
      || (response as { type?: unknown }).type !== 'success'
      || (responseSessionId !== null && responseSessionId !== params.sessionId)
    ) {
      const message = response && typeof response === 'object' && typeof (response as { errorMessage?: unknown }).errorMessage === 'string'
        ? (response as { errorMessage: string }).errorMessage
        : 'Inactive session resume was rejected; pending custody was retained';
      return { ok: false, code: 'unsupported', message };
    }
    return { ok: true };
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    return {
      ok: false,
      code: code === 'MACHINE_RPC_TIMEOUT' ? 'timeout' : 'unsupported',
      message: error instanceof Error ? error.message : 'Inactive session resume failed; pending custody was retained',
    };
  }
}
