import {
  normalizeSpawnSessionNonceResolution,
  resolveLinkedExternalSessionAuthorityV1,
  SPAWN_SESSION_ERROR_CODES,
  SpawnSessionExecutionAuthorizationSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { StoredCredentials } from '@/persistence';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { awaitSpawnedSessionId } from './awaitSpawnedSessionId';

/**
 * `unsupported` is a statement about CAPABILITY — this Session cannot be resumed
 * this way, or the machine's daemon does not carry the operation at all — and it
 * shapes the recovery a caller offers. A machine that ACCEPTED the request and
 * then failed at it is a different fact, and collapsing the two reported a
 * transient `ENOTEMPTY` from the machine's own resume work as a permanent
 * incapability. `resume_failed` is that attempt failing; retrying it is sound.
 */
export type InactiveSessionResumeResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: 'session_archived' | 'takeover_required' | 'unsupported' | 'resume_failed' | 'timeout';
      message: string;
    }>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function buildMachineResumeRequest(
  options: SpawnSessionOptions,
  sessionId: string,
  spawnNonce?: string,
) {
  return {
    type: 'resume-session' as const,
    sessionId,
    directory: options.directory,
    ...(options.agentTarget ? { agentTarget: options.agentTarget } : {}),
    ...(options.backendTarget ? { backendTarget: options.backendTarget } : {}),
    ...(spawnNonce ? { spawnNonce } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.runtimeDescriptorV1 ? { runtimeDescriptorV1: options.runtimeDescriptorV1 } : {}),
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

/**
 * The only thrown failure that is a capability statement is a daemon that does
 * not carry the spawn method at all. A timeout is its own outcome; everything
 * else is transport or machine work that failed after the request went out.
 */
function resolveThrownResumeFailureCode(
  error: unknown,
  code: unknown,
): 'unsupported' | 'resume_failed' | 'timeout' {
  if (code === 'MACHINE_RPC_TIMEOUT') return 'timeout';
  if (isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error)) return 'unsupported';
  return 'resume_failed';
}

/** Explicit user-action seam; persisted recovery owners never call this service. */
export async function requestInactiveSessionResume(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  localId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  waitForReady?: boolean;
}>): Promise<InactiveSessionResumeResult> {
  const archivedAt = (params.rawSession as { archivedAt?: unknown }).archivedAt;
  if (archivedAt !== null && archivedAt !== undefined) {
    return {
      ok: false,
      code: 'session_archived',
      message: 'Archived sessions must be unarchived before resume',
    };
  }
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

  // A linked External Session's hosted runtime is owned by the takeover
  // operation, not by automatic resume. The single link authority decides:
  // `direct` means still linked, and an unresolved link must refuse before an
  // effect rather than fall through to "hosted here". Unlinked sessions keep
  // the canonical auto-resume behavior.
  const linkAuthority = resolveLinkedExternalSessionAuthorityV1(params.metadata);
  if (!linkAuthority.ok || linkAuthority.transcriptStorage === 'direct') {
    return {
      ok: false,
      code: 'takeover_required',
      message: 'This session is linked to an external agent; complete External Sessions takeover before resuming it',
    };
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
  if (!options || options.machineId !== machineId || (!options.agentTarget && !options.backendTarget)) {
    return { ok: false, code: 'unsupported', message: 'Inactive session resume identity is incomplete; pending custody was retained' };
  }

  const startedAtMs = Date.now();
  const readinessSpawnNonce = params.waitForReady === true
    ? createStableSpawnNonce('inactive-session.resume', {
        sessionId: params.sessionId,
        requestId: params.localId,
      })
    : undefined;

  try {
    const response = await callMachineRpc({
      credentials: params.credentials,
      machineId,
      method: options.modelSelection?.ref.providerConnectionId != null
        ? RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE
        : RPC_METHODS.SPAWN_HAPPY_SESSION,
      request: buildMachineResumeRequest(options, params.sessionId, readinessSpawnNonce),
      ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const responseSessionId = response && typeof response === 'object'
      ? readNonEmptyString((response as { sessionId?: unknown }).sessionId)
      : null;
    if (responseSessionId !== null && responseSessionId !== params.sessionId) {
      return {
        ok: false,
        code: 'unsupported',
        message: 'Inactive session resume answered for a different session; pending custody was retained',
      };
    }
    if (
      !response
      || typeof response !== 'object'
      || (response as { type?: unknown }).type !== 'success'
    ) {
      // The machine received the request and answered that it did not start the
      // Session. Whatever it names — a filesystem error, a busy resource, a
      // spawn that died — is this attempt failing, never a capability this
      // Session lacks.
      const message = response && typeof response === 'object' && typeof (response as { errorMessage?: unknown }).errorMessage === 'string'
        ? (response as { errorMessage: string }).errorMessage
        : 'Inactive session resume was rejected; pending custody was retained';
      return { ok: false, code: 'resume_failed', message };
    }
    if (!readinessSpawnNonce) {
      return { ok: true };
    }

    const remainingTimeoutMs = typeof params.timeoutMs === 'number'
      ? Math.max(0, params.timeoutMs - (Date.now() - startedAtMs))
      : undefined;
    if (remainingTimeoutMs === 0) {
      return {
        ok: false,
        code: 'timeout',
        message: 'Timed out waiting for the inactive session to become ready',
      };
    }
    const ready = await awaitSpawnedSessionId({
      result: {
        type: 'success',
        spawnNonce: readinessSpawnNonce,
        sessionIdStatus: 'pending',
      },
      spawnNonce: readinessSpawnNonce,
      resolveSpawnSessionByNonce: async (spawnNonce, resolverTimeoutMs) => (
        normalizeSpawnSessionNonceResolution(await callMachineRpc({
          credentials: params.credentials,
          machineId,
          method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE,
          request: { spawnNonce },
          ...(typeof resolverTimeoutMs === 'number' ? { timeoutMs: resolverTimeoutMs } : {}),
          ...(params.signal ? { signal: params.signal } : {}),
        }))
      ),
      ...(typeof remainingTimeoutMs === 'number' ? { timeoutMs: remainingTimeoutMs } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (ready.type !== 'success' || ready.sessionId !== params.sessionId) {
      return {
        ok: false,
        code: ready.type === 'error'
          && ready.errorCode === SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT
          ? 'timeout'
          // Readiness is resolved only after the machine accepted the spawn, so
          // anything short of it is the started attempt failing.
          : 'resume_failed',
        message: ready.type === 'error'
          ? ready.errorMessage
          : 'Inactive session readiness resolved to a different session',
      };
    }
    return { ok: true };
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
    return {
      ok: false,
      code: resolveThrownResumeFailureCode(error, code),
      message: error instanceof Error ? error.message : 'Inactive session resume failed; pending custody was retained',
    };
  }
}
