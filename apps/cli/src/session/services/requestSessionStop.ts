import type { StoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { stopDaemonSession } from '@/daemon/controlClient';
import { listSessionMarkers, removeSessionMarkerIfOwned } from '@/daemon/sessionRegistry';
import { createStopSession } from '@/daemon/sessions/stopSession';
import { SessionStopCleanupIncompleteReasonSchema, SessionStopOutcomeSchema, SessionStopResultSchema } from '@happier-dev/protocol/sessions/control/contract';
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
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
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
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import { recordSessionExplicitStopIntent, resolveSessionExplicitControlIntent } from './sessionExplicitStopIntent';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';

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
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionByIdCompat>[0]['resolveAuthorizationHeaders'];
}>): Promise<boolean | null> {
  const session = await fetchSessionByIdCompat({
    reason: 'session-control',
    token: params.token,
    sessionId: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
  }).catch(() => null);
  return session ? session.active === false : null;
}

async function stopOutcomeFromAttemptResult(params: Readonly<{
  result: Exclude<StopSessionAttemptResult, { status: 'stopped' }>;
  token: string;
  sessionId: string;
  targetKind?: 'caller_local' | 'owning_machine';
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionByIdCompat>[0]['resolveAuthorizationHeaders'];
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
    const inactive = await readSessionInactive(params);
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
  requestId: string;
  signal?: AbortSignal;
  externalAction?: Parameters<typeof callMachineRpc>[0]['externalAction'];
  invokeMachineRpc?: typeof callMachineRpc;
}>): Promise<StopSessionAttemptResult | Readonly<{ status: 'command_result'; result: SessionStopCommandResult }> | ActionExecuteFailure> {
  try {
    const response = await (params.invokeMachineRpc ?? callMachineRpc)({
      credentials: params.credentials,
      machineId: params.machineId,
      requestId: params.requestId,
      method: RPC_METHODS.STOP_SESSION,
      // Graceful/forced exit and retirement may exceed the generic client cutoff.
      // Preserve this caller lifetime through the relay; disconnect still makes the effect uncertain.
      timeoutMs: null,
      request: { sessionId: params.sessionId },
      ...(params.externalAction ? { externalAction: params.externalAction } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: params.sessionId,
      },
    });
    const refusal = ActionExecuteFailureSchema.safeParse(response);
    if (refusal.success) {
      const details = refusal.data.details;
      if (refusal.data.errorCode === 'outcome_unknown' || refusal.data.errorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN
        || details !== null && typeof details === 'object' && 'kind' in details && details.kind === 'outcomeUnknown') {
        logger.infoFile('[SESSION STOP] Owning-machine acknowledgement failed', {
          sessionId: params.sessionId,
          machineId: params.machineId,
          disposition: 'outcomeUnknown',
          source: 'receiver_action',
        });
        return { status: 'incomplete', reason: 'transport_ambiguous' };
      }
      return refusal.data;
    }
    // A requester-account receiver executes the public Action with its own
    // custody. Its result already includes physical/projection confirmation;
    // it is not the raw daemon Stop result returned by a custodian receiver.
    const command = SessionStopResultSchema.safeParse(response);
    if (command.success) {
      return command.data.sessionId === params.sessionId
        ? { status: 'command_result', result: command.data }
        : { status: 'incomplete', reason: 'target_daemon_unavailable' };
    }
    const result = StopSessionResultSchema.safeParse(response);
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
      source: 'transport_error',
      disposition,
      rpcErrorCode: Object.values(RPC_ERROR_CODES).some((code) => code === rpcErrorCode)
        ? rpcErrorCode
        : undefined,
      transportErrorCode: transportErrorCode === 'MACHINE_RPC_TIMEOUT' ? transportErrorCode : undefined,
    });
    if (disposition === 'outcomeUnknown' || rpcErrorCode === RPC_ERROR_CODES.OUTCOME_UNKNOWN) {
      return { status: 'incomplete', reason: 'transport_ambiguous' };
    }
    if (rpcErrorCode === RPC_ERROR_CODES.FORBIDDEN
      || rpcErrorCode === RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED
      || rpcErrorCode === RPC_ERROR_CODES.TEAM_AUTHENTICATION_UNAVAILABLE
      || rpcErrorCode === RPC_ERROR_CODES.UPDATE_REQUIRED) {
      return { ok: false, errorCode: rpcErrorCode, error: rpcErrorCode };
    }
    if (Object.values(RPC_ERROR_CODES).some((code) => code === rpcErrorCode)) {
      return { status: 'incomplete', reason: 'target_daemon_unavailable' };
    }
    return { status: 'incomplete', reason: 'target_daemon_unavailable' };
  }
}

async function waitForSessionStopResult(params: Readonly<{
  token: string;
  sessionId: string;
  signal?: AbortSignal;
  resolveAuthorizationHeaders?: Parameters<typeof fetchSessionByIdCompat>[0]['resolveAuthorizationHeaders'];
}>): Promise<boolean> {
  const deadlineMs = Date.now() + resolveSessionControlStopTimeoutMs();
  // A fresh inactive row already satisfies this owner's predicate. Open the
  // event transport only when a later observation is actually necessary.
  if (await readSessionInactive(params) === true) return true;
  const events = openSessionEventSource(params);
  try {
    while (true) {
      const revision = events.currentRevision();
      if (await readSessionInactive(params) === true) return true;
      if (!(await events.waitForChange(revision, { deadlineMs, ...(params.signal ? { signal: params.signal } : {}) }))) return false;
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
    retireAbsentTerminalControlServiceability: async ({ trackedSession, stoppedAt }) =>
      await retireExactTerminalControlServiceability({
        credentials: params.credentials, sessionId, terminalMode: 'plain', stoppedAt,
        expectedRunner: { pid: trackedSession.sessionRunnerPid ?? trackedSession.pid,
          startTimeMs: trackedSession.runnerProcessIdentity?.processStartTimeMs ?? trackedSession.processStartTimeMs },
      }),
    retireExactTerminalControlServiceability: async ({ attachmentInfo, terminalMode, stoppedAt }) => {
      return await retireExactTerminalControlServiceability({
        credentials: params.credentials,
        sessionId,
        attachmentId: attachmentInfo.attachmentId,
        terminalMode,
        stoppedAt,
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
      .map((marker) => removeSessionMarkerIfOwned({ pid: marker.pid, happySessionId: marker.happySessionId,
        processStartTimeMs: marker.processStartTimeMs, processCommandHash: marker.processCommandHash,
      }).catch(() => undefined)),
  );
}

export async function requestSessionStop(params: Readonly<{
  /** Cleanup, handoff, and recovery stop the process without creating a person Stop hold. */
  stopIntent?: 'explicit_stop' | 'lifecycle_control';
  actionContext?: ActionExecutorContext;
  signal?: AbortSignal;
  credentials: StoredCredentials;
  idOrPrefix: string;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
  externalAction?: Parameters<typeof callMachineRpc>[0]['externalAction'];
  /** The Action host supplies its existing exact-Machine dispatch owner. */
  invokeMachineRpc?: typeof callMachineRpc;
  resolveAuthorizationHeaders?: Parameters<typeof recordSessionExplicitStopIntent>[0]['resolveAuthorizationHeaders'];
}>): Promise<
  | (Readonly<{ ok: true }> & SessionStopCommandResult)
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported'; candidates?: string[] }>
  | (ActionExecuteFailure & Readonly<{ code: string; candidates?: string[] }>)
> {
  const actionId = params.externalAction?.effectActionId ?? 'session.stop';
  const rootRequestId = params.externalAction?.context.actionRequestId;
  const stopRequestId = rootRequestId ?? randomUUID();
  // Ordinary root Actions carry their diagnostic context without a signed effect.
  // Correlate their phases without changing the Stop mutation/transport identity.
  const traceRequestId = rootRequestId ?? params.actionContext?.actionRequestId;
  const signal = params.signal ?? params.actionContext?.signal ?? params.externalAction?.context.signal;
  const resolved = await runTracedExternalActionStage(actionId, traceRequestId, 'stop.resolve_session', () => resolveSessionIdOrPrefix({
    reason: 'session-control',
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    ...(signal ? { signal } : {}),
    ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
  }));
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  let phase = 'read_session';
  try {
    const rawSession = resolved.rawSession ?? await fetchSessionByIdCompat({
      reason: 'session-control',
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      ...(signal ? { signal } : {}),
      ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
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
    phase = 'read_account_currentness';
    const currentnessHeaders = rawSession.metadataLayoutVersion === 1
      ? params.resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' })
      : undefined;
    if (rawSession.metadataLayoutVersion === 1 && params.resolveAuthorizationHeaders && !currentnessHeaders) {
      throw new Error('External Action authorization unavailable');
    }
    const accountCurrentness = rawSession.metadataLayoutVersion === 1
      ? await fetchAccountEncryptionCurrentness({
          token: params.credentials.token,
          ...(currentnessHeaders ? { authorizationHeaders: currentnessHeaders } : {}),
          ...(signal ? { signal } : {}),
        })
      : null;
    phase = 'resolve_owning_machine';
    const owningMachine = resolveSessionOwningMachineId({
      credentials: params.credentials,
      rawSession,
      ...(accountCurrentness ? { accountEncryptionMode: accountCurrentness.mode } : {}),
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
    const machineId = owningMachine.machineId;
    const controlIntent = resolveSessionExplicitControlIntent({ rawSession,
      actionContext: params.actionContext ?? params.externalAction?.context,
    });
    if (controlIntent === 'self_stop_forbidden') {
      return { ok: false, errorCode: 'unsupported_action', error: controlIntent, code: 'unsupported_action' };
    }
    if (controlIntent === 'unauthorized') {
      return { ok: false, errorCode: 'unsupported_action', error: 'target_outside_led_subtree', code: 'unsupported_action' };
    }
    if (params.stopIntent !== 'lifecycle_control' && controlIntent !== 'automatic') {
      phase = 'write_stop_intent';
      await recordSessionExplicitStopIntent({
        credentials: params.credentials,
        sessionId: resolved.sessionId,
        rawSession,
        requestId: stopRequestId,
        actionContext: params.actionContext ?? params.externalAction?.context,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        ...(accountCurrentness ? { accountEncryptionCurrentness: accountCurrentness } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    if (machineId) {
      phase = 'stop_owning_machine';
      const physicalStopResult = await runTracedExternalActionStage(actionId, traceRequestId, 'stop.owner_rpc', () => stopSessionOnOwningMachine({
        credentials: params.credentials,
        sessionId: resolved.sessionId,
        machineId,
        requestId: stopRequestId,
        ...(params.invokeMachineRpc ? { invokeMachineRpc: params.invokeMachineRpc } : {}),
        ...(signal ? { signal } : {}),
        ...(params.externalAction ? { externalAction: params.externalAction } : {}),
      }));
      if ('ok' in physicalStopResult) return { ...physicalStopResult, code: physicalStopResult.errorCode };
      if (physicalStopResult.status === 'command_result') {
        const result = physicalStopResult.result;
        return result.stopped
          ? { ok: true, sessionId: result.sessionId, stopped: true }
          : { ok: true, sessionId: result.sessionId, stopped: false,
              ...(result.stopOutcome ? { stopOutcome: result.stopOutcome } : {}) };
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
            targetKind: 'owning_machine',
            ...(signal ? { signal } : {}),
            ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
          }),
        };
      }
      phase = 'observe_inactive';
      const stopped = await runTracedExternalActionStage(actionId, traceRequestId, 'stop.inactive_projection', () => waitForSessionStopResult({
        token: params.credentials.token,
        sessionId: resolved.sessionId,
        ...(signal ? { signal } : {}),
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      }));
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

    if (params.externalAction) {
      return { ok: true, sessionId: resolved.sessionId, stopped: false,
        stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'target_daemon_unavailable' } };
    }
    phase = 'read_local_attachment';
    const exactAttachmentIdBeforeDaemonStop = await readExactTerminalAttachmentId(resolved.sessionId);
    signal?.throwIfAborted();
    let physicalStopResult: StopSessionAttemptResult;
    phase = 'stop_local_daemon';
    try {
      physicalStopResult = signal
        ? await stopDaemonSession(resolved.sessionId, { signal })
        : await stopDaemonSession(resolved.sessionId);
    } catch {
      physicalStopResult = { status: 'incomplete', reason: 'transport_ambiguous' };
    }
    // A transport failure may mean the daemon accepted Stop but the response was lost. Retry only
    // when a v2 attachment supplies immutable host identity; plain/legacy/unreadable paths retain
    // the single-actor fail-closed behavior.
    const mayRunExactAmbiguousFallback = physicalStopResult.status === 'incomplete'
      && physicalStopResult.reason === 'transport_ambiguous'
      && exactAttachmentIdBeforeDaemonStop !== null;
    if (!signal?.aborted && (physicalStopResult.status === 'not_found' || mayRunExactAmbiguousFallback)) {
      phase = 'stop_local_markers';
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
          ...(signal ? { signal } : {}),
        }),
      };
    }
    phase = 'observe_inactive';
    const stopped = await waitForSessionStopResult({
      token: params.credentials.token,
      sessionId: resolved.sessionId,
      ...(signal ? { signal } : {}),
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
  } catch (error) {
    // Keep exception messages, request payloads and credentials out of this diagnostic.
    logger.infoFile('[SESSION STOP] Stop request failed', {
      sessionId: resolved.sessionId,
      phase,
      classification: classifyServerEndpointError(error),
    });
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
