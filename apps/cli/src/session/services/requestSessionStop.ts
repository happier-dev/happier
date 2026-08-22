import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { stopDaemonSession } from '@/daemon/controlClient';
import { listSessionMarkers, removeSessionMarker } from '@/daemon/sessionRegistry';
import { createStopSession } from '@/daemon/sessions/stopSession';
import {
  SessionStopCleanupIncompleteReasonSchema,
  SessionStopOutcomeSchema,
  StopSessionResultSchema,
  type SessionStopOutcome,
  type SessionStopResult as SessionStopCommandResult,
} from '@happier-dev/protocol';
import type {
  StopSessionResult,
} from '@/daemon/sessions/stopSessionContract';
import { waitForTrackedRunnerProcessesExit } from '@/daemon/sessions/waitForTrackedRunnerProcessesExit';
import { retireExactTerminalControlServiceability } from '@/daemon/sessions/retireTerminalControlServiceability';
import { buildTrackedSessionFromMarker } from '@/daemon/sessions/trackedSessionFromMarker';
import type { TrackedSession } from '@/daemon/types';
import { buildSpawnSessionOptionsFromRespawnDescriptorV1 } from '@/daemon/processSupervision/sessionRunnerRespawnDescriptor';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/terminal/attachment/catalogHooks';
import { logger } from '@/ui/logger';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import {
  resolveSessionControlStopPollIntervalMs,
  resolveSessionControlStopTimeoutMs,
} from '@/session/transport/shared/sessionTimeouts';
import { delay } from '@/utils/time';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { readOrCreateDeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import { RPC_METHODS, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';

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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveOwningMachineId(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>;
}>): { ok: true; machineId: string | null } | { ok: false } {
  const rawMachineId = readNonEmptyString(params.rawSession.machineId);
  const metadata = tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: params.rawSession,
  });
  const metadataMachineId = readNonEmptyString(metadata?.machineId);
  if (rawMachineId && metadataMachineId && rawMachineId !== metadataMachineId) {
    return { ok: false };
  }
  return { ok: true, machineId: rawMachineId ?? metadataMachineId };
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
      request: { sessionId: params.sessionId },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: params.sessionId,
      },
    }));
    return result.success
      ? result.data
      : { status: 'incomplete', reason: 'target_daemon_unavailable' };
  } catch {
    return { status: 'incomplete', reason: 'target_daemon_unavailable' };
  }
}

async function waitForSessionStopResult(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<boolean> {
  const deadlineMs = Date.now() + resolveSessionControlStopTimeoutMs();

  while (Date.now() <= deadlineMs) {
    if (await readSessionInactive({ token: params.token, sessionId: params.sessionId }) === true) {
      return true;
    }

    if (Date.now() >= deadlineMs) {
      break;
    }

    await delay(resolveSessionControlStopPollIntervalMs());
  }

  return false;
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
    onExactTerminalAttachmentRetired: notifyTerminalAttachmentRetiredThroughCatalog,
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
  return state.status === 'present' && state.info.version === 2
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
}>): Promise<
  | (Readonly<{ ok: true }> & SessionStopCommandResult)
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] }>
> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
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
    const owningMachine = resolveOwningMachineId({
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
