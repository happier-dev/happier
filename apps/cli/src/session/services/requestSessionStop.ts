import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/backends/catalog';
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
import type { TrackedSession } from '@/daemon/types';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import {
  resolveSessionControlStopPollIntervalMs,
  resolveSessionControlStopTimeoutMs,
} from '@/session/transport/shared/sessionTimeouts';
import { delay } from '@/utils/time';
import { readTerminalAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { createDefaultTerminalHostRegistry } from '@/integrations/terminalHost/defaultRegistry';
import { logger } from '@/ui/logger';
import {
  RPC_ERROR_CODES,
  RPC_METHODS,
  SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
} from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

type StopSessionAttemptResult = StopSessionResult | Readonly<{
  status: 'incomplete';
  reason:
    | 'transport_ambiguous'
    | 'marker_fallback_failed'
    | 'target_daemon_unavailable'
    | 'target_daemon_forbidden'
    | 'target_daemon_response_unsupported';
}>;

function stopOutcomeFromAttemptResult(
  result: Exclude<StopSessionAttemptResult, { status: 'stopped' }>,
  targetKind: 'caller_local' | 'owning_machine' = 'caller_local',
): SessionStopOutcome {
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
    return SessionStopOutcomeSchema.parse({
      status: 'physical_stop_unconfirmed',
      reason: targetKind === 'owning_machine' ? 'target_session_not_found' : 'local_session_not_found',
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
  credentials: Credentials;
  rawSession: Awaited<ReturnType<typeof fetchSessionByIdCompat>>;
}>): { ok: true; machineId: string | null } | { ok: false } {
  if (!params.rawSession) return { ok: false };
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
  credentials: Credentials;
  sessionId: string;
  machineId: string;
}>): Promise<StopSessionAttemptResult> {
  try {
    const rawResult = await callMachineRpc({
      credentials: params.credentials,
      machineId: params.machineId,
      method: RPC_METHODS.STOP_SESSION,
      request: { sessionId: params.sessionId },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: params.sessionId,
      },
    });
    const result = StopSessionResultSchema.safeParse(rawResult);
    if (!result.success) {
      const errorEnvelope = rawResult && typeof rawResult === 'object'
        ? rawResult as { error?: unknown; errorCode?: unknown }
        : null;
      if (
        errorEnvelope?.error === 'Forbidden'
        && errorEnvelope.errorCode === RPC_ERROR_CODES.FORBIDDEN
      ) {
        return { status: 'incomplete', reason: 'target_daemon_forbidden' };
      }
      return { status: 'incomplete', reason: 'target_daemon_response_unsupported' };
    }
    return result.data;
  } catch (error) {
    if (readRpcErrorCode(error) === RPC_ERROR_CODES.FORBIDDEN) {
      return { status: 'incomplete', reason: 'target_daemon_forbidden' };
    }
    return { status: 'incomplete', reason: 'target_daemon_unavailable' };
  }
}

async function waitForSessionStopResult(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<boolean> {
  const deadlineMs = Date.now() + resolveSessionControlStopTimeoutMs();

  while (Date.now() <= deadlineMs) {
    const session = await fetchSessionByIdCompat({
      token: params.token,
      sessionId: params.sessionId,
    }).catch(() => null);

    if (session?.active === false) {
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
  credentials: Credentials;
  sessionId: string;
  expectedTerminalAttachmentId?: string;
}>): Promise<StopSessionResult> {
  const { sessionId } = params;
  const markers = (await listSessionMarkers()).filter((marker) => marker.happySessionId === sessionId);
  if (markers.length === 0) {
    return { status: 'not_found' };
  }

  const pidToTrackedSession = new Map<number, TrackedSession>(
    markers.map((marker) => [
      marker.pid,
      {
        startedBy: marker.startedBy ?? 'terminal',
        happySessionId: marker.happySessionId,
        pid: marker.pid,
        ...(typeof marker.processCommandHash === 'string' ? { processCommandHash: marker.processCommandHash } : {}),
        ...(typeof marker.processInstanceFingerprint === 'string'
          ? { processInstanceFingerprint: marker.processInstanceFingerprint }
          : {}),
        ...(marker.respawn
          ? {
              spawnOptions: {
                directory: marker.respawn.directory,
                ...(marker.respawn.terminal ? { terminal: marker.respawn.terminal } : {}),
              },
            }
          : {}),
      },
    ]),
  );
  let terminalHostAdaptersPromise: ReturnType<typeof createDefaultTerminalHostRegistry> | null = null;

  return await createStopSession({
    pidToTrackedSession,
    loadTerminalHostAdapters: async () => await (
      terminalHostAdaptersPromise ??= createDefaultTerminalHostRegistry()
    ),
    logPidReuseRefusal: (message) => logger.debug(message),
    logWarning: (message, ...args) => logger.debug(message, ...args),
    ...(params.expectedTerminalAttachmentId
      ? { expectedTerminalAttachmentId: params.expectedTerminalAttachmentId }
      : {}),
    requireTerminalTopologyProof: true,
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
    retireExactTerminalControlServiceability: async ({ attachmentInfo }) => {
      return await retireExactTerminalControlServiceability({
        credentials: params.credentials,
        sessionId,
        attachmentId: attachmentInfo.attachmentId,
        terminalMode: attachmentInfo.terminal.mode ?? attachmentInfo.handle.kind,
      });
    },
  })(sessionId);
}

async function readExactTerminalAttachmentId(sessionId: string): Promise<string | null> {
  const state = await readTerminalAttachmentState({
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
  credentials: Credentials;
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
    const owningMachine = resolveOwningMachineId({
      credentials: params.credentials,
      rawSession: resolved.rawSession,
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
          stopOutcome: stopOutcomeFromAttemptResult(physicalStopResult, 'owning_machine'),
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
      // A fallback that ran BECAUSE the daemon transport was ambiguous cannot
      // prove that nothing was signalled: the daemon may have accepted and
      // executed Stop and lost only its answer — which is precisely why its
      // markers are then gone (`not_found`) or its tracked runner absent.
      // Reporting the fallback's own refusal reason would emit a
      // `physical_stop_unconfirmed` reason from the set consumers read as
      // pre-signal proof, and the Agent transition turns that into
      // `rejected('source_stop_failed')` — `sourceEffect: 'none'`, which the UI
      // offers as Keep editing in front of a runtime that may already be dead.
      // The ambiguity that caused the fallback is the honest answer.
      // Only the `physical_stop_unconfirmed` reasons carry that false pre-signal
      // claim. A `stopped_cleanup_incomplete` outcome already proves the host
      // WAS destroyed and names a strictly more informative residue, so it is
      // left exactly as the fallback reported it.
      if (
        mayRunExactAmbiguousFallback
        && physicalStopResult.status !== 'stopped'
        && stopOutcomeFromAttemptResult(physicalStopResult).status === 'physical_stop_unconfirmed'
      ) {
        physicalStopResult = { status: 'incomplete', reason: 'transport_ambiguous' };
      }
    }
    if (physicalStopResult.status !== 'stopped') {
      return {
        ok: true,
        sessionId: resolved.sessionId,
        stopped: false,
        stopOutcome: stopOutcomeFromAttemptResult(physicalStopResult),
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
