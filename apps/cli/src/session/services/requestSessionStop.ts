import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { stopDaemonSession } from '@/daemon/controlClient';
import { listSessionMarkers, removeSessionMarker } from '@/daemon/sessionRegistry';
import { createStopSession } from '@/daemon/sessions/stopSession';
import { SessionStopCleanupIncompleteReasonSchema, SessionStopOutcomeSchema } from '@happier-dev/protocol/sessions/control/contract';
import { StopSessionResultSchema } from '@happier-dev/protocol/sessionStop';
import type { SessionStopOutcome, SessionStopResult as SessionStopCommandResult } from '@happier-dev/protocol';
import type {
  StopSessionResult,
} from '@/daemon/sessions/stopSessionContract';
import { waitForTrackedRunnerProcessesExit } from '@/daemon/sessions/waitForTrackedRunnerProcessesExit';
import { retireExactTerminalControlServiceability } from '@/daemon/sessions/retireTerminalControlServiceability';
import { buildTrackedSessionFromMarker } from '@/daemon/sessions/trackedSessionFromMarker';
import type { TrackedSession } from '@/daemon/types';
import { buildSpawnSessionOptionsFromRespawnDescriptorV1 } from '@/daemon/processSupervision/sessionRunnerRespawnDescriptor';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { logger } from '@/ui/logger';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveSessionOwningMachineId } from './resolveSessionOwningMachine';
import { callMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import {
  resolveSessionControlStopPollIntervalMs,
  resolveSessionControlStopTimeoutMs,
} from '@/session/transport/shared/sessionTimeouts';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

type StopSessionAttemptResult = StopSessionResult | Readonly<{
  status: 'incomplete';
  reason: 'transport_ambiguous' | 'marker_fallback_failed' | 'target_daemon_unavailable';
}>;

/**
 * The single liveness observation this owner makes: is the canonical Session
 * row INACTIVE? `null` means the row could not be read at all, which is not a
 * liveness answer.
 *
 * The post-stop wait and the confirmed-absent classification below both read
 * THIS fact, so "is it running" has exactly one definition here and no caller
 * forms a second one.
 */
async function readSessionInactive(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<boolean | null> {
  const session = await fetchSessionByIdCompat({
    token: params.token,
    sessionId: params.sessionId,
  }).catch(() => null);
  return session ? session.active === false : null;
}

async function stopOutcomeFromAttemptResult(params: Readonly<{
  result: Exclude<StopSessionAttemptResult, { status: 'stopped' }>;
  token: string;
  sessionId: string;
  targetKind?: 'caller_local' | 'owning_machine';
}>): Promise<SessionStopOutcome> {
  const { result } = params;
  if (result.status === 'incomplete') {
    const cleanupReason = SessionStopCleanupIncompleteReasonSchema.safeParse(result.reason);
    if (cleanupReason.success) {
      return SessionStopOutcomeSchema.parse({
        status: 'stopped_cleanup_incomplete',
        reason: cleanupReason.data,
      });
    }
    return SessionStopOutcomeSchema.parse({ status: 'physical_stop_unconfirmed', reason: result.reason });
  }
  if (result.status === 'not_found') {
    // Nothing was found to stop. That is either PROOF that no runtime exists or
    // a failure to determine it, and the fact that separates them is the one
    // this owner already accepts as a confirmed stop after signalling a runtime:
    // the canonical Session row reporting inactive. A Session the addressed
    // daemon does not track AND the server reports inactive is stopped — a cold
    // Session cannot otherwise satisfy any consumer that requires a confirmed
    // stop, because there is nothing left to signal.
    const inactive = await readSessionInactive({ token: params.token, sessionId: params.sessionId });
    if (inactive === true) {
      return SessionStopOutcomeSchema.parse({
        status: 'already_stopped',
        reason: 'no_runtime_session_inactive',
      });
    }
    return SessionStopOutcomeSchema.parse({
      status: 'physical_stop_unconfirmed',
      reason: params.targetKind === 'owning_machine'
        ? 'target_session_not_found'
        : 'local_session_not_found',
    });
  }
  return SessionStopOutcomeSchema.parse({
    status: 'physical_stop_unconfirmed',
    reason: 'daemon_stop_requested',
  });
}


async function stopSessionOnOwningMachine(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  machineId: string;
}>): Promise<StopSessionAttemptResult> {
  try {
    const result = StopSessionResultSchema.safeParse(await callMachineRpc({
      credentials: params.credentials,
      machineId: params.machineId,
      method: RPC_METHODS.STOP_SESSION,
      // Graceful/forced exit and retirement may exceed the generic client cutoff.
      // The relay's finite forwarding deadline and disconnect still own acknowledgement expiry.
      timeoutMs: null,
      request: { sessionId: params.sessionId },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: params.sessionId,
      },
    }));
    return result.success
      ? result.data
      : { status: 'incomplete', reason: 'target_daemon_unavailable' };
  } catch (error) {
    const rpcErrorCode = readRpcErrorCode(error);
    const disposition = readMachineRpcRequestDisposition(error);
    const transportErrorCode = error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
    logger.infoFile('[SESSION STOP] Owning-machine acknowledgement failed', {
      sessionId: params.sessionId,
      machineId: params.machineId,
      disposition,
      rpcErrorCode: Object.values(RPC_ERROR_CODES).some((code) => code === rpcErrorCode)
        ? rpcErrorCode
        : undefined,
      transportErrorCode: transportErrorCode === 'MACHINE_RPC_TIMEOUT' ? transportErrorCode : undefined,
    });
    if (Object.values(RPC_ERROR_CODES).some((code) => code === rpcErrorCode)) {
      return { status: 'incomplete', reason: 'target_daemon_unavailable' };
    }
    if (disposition === 'outcomeUnknown') {
      return { status: 'incomplete', reason: 'transport_ambiguous' };
    }
    return { status: 'incomplete', reason: 'target_daemon_unavailable' };
  }
}

async function waitForSessionStopResult(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<boolean> {
  const deadlineMs = Date.now() + resolveSessionControlStopTimeoutMs();
  const events = openSessionEventSource(params);
  try {
    while (true) {
      const revision = events.currentRevision();
      if (await readSessionInactive(params) === true) return true;
      if (!(await events.waitForChange(revision, { deadlineMs }))) return false;
    }
  } finally {
    await events.close();
  }
}

async function stopSessionViaMarkersBestEffort(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  expectedTerminalAttachmentId?: string;
}>): Promise<StopSessionResult> {
  const { sessionId } = params;
  const markers = (await listSessionMarkers()).filter((marker) => marker.happySessionId === sessionId);
  if (markers.length === 0) {
    return { status: 'not_found' };
  }
  const deviceLocalSecretStorage = await readOrCreateDeviceLocalSecretStorage({
    path: configuration.deviceLocalSecretKeyFile,
  }).catch(() => null);

  const pidToTrackedSession = new Map<number, TrackedSession>(
    markers.map((marker) => {
      let spawnOptions: ReturnType<typeof buildSpawnSessionOptionsFromRespawnDescriptorV1> | undefined;
      if (marker.respawn) {
        try {
          spawnOptions = buildSpawnSessionOptionsFromRespawnDescriptorV1(marker.respawn, {
            ...(params.credentials.encryption
              ? { encryptionMaterial: params.credentials.encryption }
              : {}),
            ...(deviceLocalSecretStorage ? { deviceLocalSecretStorage } : {}),
          });
        } catch {
          spawnOptions = undefined;
        }
      }
      return [
        marker.pid,
        buildTrackedSessionFromMarker({
          marker,
          startedByFallback: 'terminal',
          ...(spawnOptions ? { spawnOptions } : {}),
        }),
      ];
    }),
  );
  let terminalHostAdapterInventoryPromise: ReturnType<typeof createDefaultTerminalHostAdapterInventory> | null = null;

  return await createStopSession({
    pidToTrackedSession,
    requireTerminalTopologyProof: true,
    ...(params.expectedTerminalAttachmentId
      ? { expectedTerminalAttachmentId: params.expectedTerminalAttachmentId }
      : {}),
    logPidReuseRefusal: (message) => logger.debug(message),
    logWarning: (message, ...args) => logger.debug(message, ...args),
    loadTerminalHostAdapters: async () => {
      terminalHostAdapterInventoryPromise ??= createDefaultTerminalHostAdapterInventory({
        happyHomeDir: configuration.happyHomeDir,
        preference: process.platform === 'win32' ? 'zellij' : 'auto',
      });
      return (await terminalHostAdapterInventoryPromise).adapters;
    },
    areTrackedRunnersExited: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
      runners: trackedPids.map((pid) => ({ pid })),
      timeoutMs: 0,
      pollIntervalMs: 0,
    }),
    waitForTrackedRunnersExit: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
      runners: trackedPids.map((pid) => ({ pid })),
      timeoutMs: resolveSessionControlStopTimeoutMs(),
      pollIntervalMs: resolveSessionControlStopPollIntervalMs(),
    }),
    retireExactTerminalControlServiceability: async ({ attachmentInfo, terminalMode }) => {
      return await retireExactTerminalControlServiceability({
        credentials: params.credentials,
        sessionId,
        attachmentId: attachmentInfo.attachmentId,
        terminalMode,
      });
    },
  })(sessionId);
}

async function readExactTerminalAttachmentId(sessionId: string): Promise<string | null> {
  const state = await readTerminalHostAttachmentState({
    happyHomeDir: configuration.happyHomeDir,
    sessionId,
  }).catch(() => ({ status: 'unreadable' as const, reason: 'io_error' as const }));
  return state.status === 'present' && state.info.version !== 1
    ? state.info.attachmentId
    : null;
}

async function cleanupStoppedSessionMarkersBestEffort(sessionId: string): Promise<void> {
  const markers = await listSessionMarkers();
  await Promise.all(
    markers
      .filter((marker) => marker.happySessionId === sessionId)
      .map((marker) => removeSessionMarker(marker.pid).catch(() => undefined)),
  );
}

export async function requestSessionStop(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<
  | (Readonly<{ ok: true }> & SessionStopCommandResult)
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] }>
> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  try {
    const rawSession = resolved.rawSession ?? await fetchSessionByIdCompat({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
    });
    if (!rawSession) {
      return {
        ok: true,
        sessionId: resolved.sessionId,
        stopped: false,
        stopOutcome: {
          status: 'physical_stop_unconfirmed',
          reason: 'target_daemon_unavailable',
        },
      };
    }
    const owningMachine = resolveSessionOwningMachineId({
      credentials: params.credentials,
      rawSession,
    });
    if (!owningMachine.ok) {
      return {
        ok: true,
        sessionId: resolved.sessionId,
        stopped: false,
        stopOutcome: {
          status: 'physical_stop_unconfirmed',
          reason: 'target_daemon_unavailable',
        },
      };
    }
    if (owningMachine.machineId) {
      const physicalStopResult = await stopSessionOnOwningMachine({
        credentials: params.credentials,
        sessionId: resolved.sessionId,
        machineId: owningMachine.machineId,
      });
      if (physicalStopResult.status !== 'stopped') {
        return {
          ok: true,
          sessionId: resolved.sessionId,
          stopped: false,
          stopOutcome: await stopOutcomeFromAttemptResult({
            result: physicalStopResult,
            token: params.credentials.token,
            sessionId: resolved.sessionId,
            targetKind: 'owning_machine',
          }),
        };
      }
      const stopped = await waitForSessionStopResult({
        token: params.credentials.token,
        sessionId: resolved.sessionId,
      });
      return stopped
        ? { ok: true, sessionId: resolved.sessionId, stopped: true }
        : {
            ok: true,
            sessionId: resolved.sessionId,
            stopped: false,
            stopOutcome: {
              status: 'stopped_projection_unconfirmed',
              reason: 'relay_inactive_not_observed',
            },
          };
    }

    const exactAttachmentIdBeforeDaemonStop = await readExactTerminalAttachmentId(resolved.sessionId);
    let physicalStopResult: StopSessionAttemptResult;
    try {
      physicalStopResult = await stopDaemonSession(resolved.sessionId);
    } catch {
      physicalStopResult = { status: 'incomplete', reason: 'transport_ambiguous' };
    }
    // A transport failure may mean the daemon accepted Stop but the response was lost. Retry only
    // when a v2 attachment supplies immutable host identity; plain/legacy/unreadable paths retain
    // the single-actor fail-closed behavior.
    const mayRunExactAmbiguousFallback = physicalStopResult.status === 'incomplete'
      && physicalStopResult.reason === 'transport_ambiguous'
      && exactAttachmentIdBeforeDaemonStop !== null;
    if (physicalStopResult.status === 'not_found' || mayRunExactAmbiguousFallback) {
      physicalStopResult = await stopSessionViaMarkersBestEffort({
        credentials: params.credentials,
        sessionId: resolved.sessionId,
        ...(mayRunExactAmbiguousFallback && exactAttachmentIdBeforeDaemonStop
          ? { expectedTerminalAttachmentId: exactAttachmentIdBeforeDaemonStop }
          : {}),
      }).catch(
        (): StopSessionAttemptResult => ({ status: 'incomplete', reason: 'marker_fallback_failed' }),
      );
    }
    if (physicalStopResult.status !== 'stopped') {
      return {
        ok: true,
        sessionId: resolved.sessionId,
        stopped: false,
        stopOutcome: await stopOutcomeFromAttemptResult({
          result: physicalStopResult,
          token: params.credentials.token,
          sessionId: resolved.sessionId,
        }),
      };
    }
    const stopped = await waitForSessionStopResult({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
    });
    if (stopped) {
      await cleanupStoppedSessionMarkersBestEffort(resolved.sessionId).catch(() => undefined);
      return {
        ok: true,
        sessionId: resolved.sessionId,
        stopped: true,
      };
    }
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped: false,
      stopOutcome: {
        status: 'stopped_projection_unconfirmed',
        reason: 'relay_inactive_not_observed',
      },
    };
  } catch {
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped: false,
      stopOutcome: {
        status: 'physical_stop_unconfirmed',
        reason: 'unexpected_error',
      },
    };
  }
}
