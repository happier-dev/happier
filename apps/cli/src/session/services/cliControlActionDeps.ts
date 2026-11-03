import type { ResolvedSessionTransport } from '../actions/cliActionDeps/types';
import type { CliActionDepsParams } from '../actions/cliActionDeps/types';
import type { autonomousExchangePath, readAutonomousExchangeStatus, mutateAutonomousExchangeControl } from '@/api/sessionAutonomousExchangeTransport';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { ActionExecutorDeps, ActionExecutorContext } from '@happier-dev/protocol';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { requestSessionStop } from '@/session/services/requestSessionStop';
import type { setSessionMode } from '@/session/services/setSessionMode';
import { buildSessionRunnerRuntimeRefreshRequestV1, RestartSessionRunnerResultV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import type { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { CliMachineActionCall } from '@/session/actions/cliActionDeps/machineTransport';
type FamilyActionDeps = Pick<ActionExecutorDeps, 'sessionExchangePrepare' | 'sessionExchangeControl' | 'sessionTurnCancel' | 'sessionCompact' | 'sessionRuntimeRefresh' | 'sessionStop' | 'sessionControlSwitch' | 'sessionModeSet'>;

export function createCliControlActionDeps(
  params: CliActionDepsParams,
  { callMachineAction, readServerFeaturesSnapshot, resolveServerRequestHeaders, resolveTransportForSession, withProjectHome }: Readonly<{

    callMachineAction: CliMachineActionCall;
    readServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined>;
    resolveServerRequestHeaders: (context: ActionExecutorContext | undefined, effectActionId: string, request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    resolveTransportForSession: (idOrPrefix: string, signal?: AbortSignal, caller?: Readonly<{ context: ActionExecutorContext; actionId: ActionId }>, expectedSessionAddress?: ActionExecutorContext['expectedSessionAddress']) => Promise<ResolvedSessionTransport | Readonly<{
    ok: false;
    code: string;
    candidates?: string[];
  }>>;
    withProjectHome: <T>(operation: () => Promise<T>) => Promise<T>;
  }>,
): FamilyActionDeps {
  return {

    sessionExchangePrepare: async ({ sessionId, originInputLocalId, context, serverId, signal }) => {
      const homeServerId = params.serverId ?? configuration.activeServerId;
      const [{ isServerProfileHomeIdentity }, { autonomousExchangePath, readAutonomousExchangeStatus }] = await Promise.all([import("@/server/serverProfiles"), import("@/api/sessionAutonomousExchangeTransport")]);
      if ((serverId && !await isServerProfileHomeIdentity(homeServerId, serverId))
        || (context.serverId && !await isServerProfileHomeIdentity(homeServerId, context.serverId))) return null;
      const path = autonomousExchangePath(sessionId, originInputLocalId);
      const headers = resolveServerRequestHeaders(context, 'session.exchange.control', { method: 'GET', path });
      if (!headers) return null;
      const status = await readAutonomousExchangeStatus({
        serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), path, headers,
        ...(signal ? { signal } : {}),
      });
      return status?.observedRevision ?? null;
    },

    sessionExchangeControl: async ({ sessionId, originInputLocalId, request, context, serverId, signal }) => {
      const homeServerId = params.serverId ?? configuration.activeServerId;
      const [{ isServerProfileHomeIdentity }, { autonomousExchangePath, mutateAutonomousExchangeControl }] = await Promise.all([import("@/server/serverProfiles"), import("@/api/sessionAutonomousExchangeTransport")]);
      if ((serverId && !await isServerProfileHomeIdentity(homeServerId, serverId))
        || (context.serverId && !await isServerProfileHomeIdentity(homeServerId, context.serverId))) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const path = autonomousExchangePath(sessionId, originInputLocalId);
      const headers = resolveServerRequestHeaders(context, 'session.exchange.control', {
        method: 'POST', path, body: request,
      });
      if (!headers) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const response = await mutateAutonomousExchangeControl({
        serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), path, headers, request,
        ...(signal ? { signal } : {}),
      });
      if (response.status < 200 || response.status >= 300) {
        const code = response.status === 409 ? 'exchange_revision_conflict'
          : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not_found' : 'exchange_unavailable';
        return { ok: false, errorCode: code, error: code };
      }
      return response.result
        ? response.result
        : { ok: false, errorCode: 'exchange_unavailable', error: 'exchange_unavailable' };
    },

    sessionCompact: async ({ sessionId, serverId, instructions, context, signal: callerSignal }) => withProjectHome(async () => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const signal = callerSignal ?? context.signal;
      const homeServerId = params.serverId ?? configuration.activeServerId;
      const { isServerProfileHomeIdentity } = await import('@/server/serverProfiles');
      if ((serverId && !await isServerProfileHomeIdentity(homeServerId, serverId))
        || (context.serverId && !await isServerProfileHomeIdentity(homeServerId, context.serverId))) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const externalRequest = context.externalActionCredential !== undefined
        || context.externalActionExecutionAuthorization !== undefined;
      if (externalRequest && (!params.externalActionMachineRequestPrivateKey
        || !params.externalActionMachineInstallationId
        || !resolveServerRequestHeaders(context, 'session.compact', { method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const transport = await resolveTransportForSession(sessionId, signal,
        externalRequest ? { context, actionId: 'session.compact' } : undefined);
      if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code,
        ...(transport.candidates ? { candidates: transport.candidates } : {}) };
      try {
        const { callSessionRpc } = await import('@/session/transport/rpc/sessionRpc');
        return await callSessionRpc({ ...transport, token: params.credentials.token, sessionId: transport.sessionId,
          method: `${transport.sessionId}:${SESSION_RPC_METHODS.SESSION_COMPACT}`,
          request: { ...(instructions !== undefined ? { instructions } : {}) },
          ...(context.authority !== 'present_user' ? { authorityCeiling: 'account_automation' as const } : {}),
          ...((context.externalActionCredential || context.externalActionExecutionAuthorization)
            && params.externalActionMachineRequestPrivateKey && params.externalActionMachineInstallationId
            ? { externalAction: { context, effectActionId: 'session.compact',
              installationId: params.externalActionMachineInstallationId, privateKey: params.externalActionMachineRequestPrivateKey } } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        const errorCode = readRpcErrorCode(error) ?? 'session_rpc_failed';
        return { ok: false, errorCode, error: errorCode };
      }
    }),

    sessionTurnCancel: async ({ sessionId, serverId, context, signal: callerSignal }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const credentials = params.credentials;
      const signal = callerSignal ?? context.signal;
      signal?.throwIfAborted();
      const homeServerId = params.serverId ?? configuration.activeServerId;
      const homeServerHttpBaseUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const { isServerProfileHomeIdentity } = await import("@/server/serverProfiles");
      if ((serverId && !await isServerProfileHomeIdentity(homeServerId, serverId))
        || (context.serverId && !await isServerProfileHomeIdentity(homeServerId, context.serverId))) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      const externalRequest = context.externalActionCredential !== undefined
        || context.externalActionExecutionAuthorization !== undefined;
      const resolveAuthorizationHeaders = externalRequest
        ? (request: Readonly<{ method: string; path: string; body?: unknown }>) =>
            resolveServerRequestHeaders(context, 'session.turn.cancel', request)
        : undefined;
      if (externalRequest && (!params.externalActionMachineRequestPrivateKey
        || !params.externalActionMachineInstallationId
        || !resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' }))) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      return await runWithServerHttpBaseUrl(homeServerHttpBaseUrl, async () => {
        const serverFeaturesSnapshot = await readServerFeaturesSnapshot();
        const { resolveSessionTransportContext } = await import("@/session/services/resolveSessionTransportContext");
        const transport = await resolveSessionTransportContext({
          reason: 'session-action',
          credentials, idOrPrefix: sessionId,
          ...(resolveAuthorizationHeaders ? { resolveAuthorizationHeaders } : {}),
          ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
          ...(signal ? { signal } : {}),
        });
        if (!transport.ok) {
          return { ok: false, errorCode: transport.code, error: transport.code,
            ...(transport.candidates ? { candidates: transport.candidates } : {}) };
        }
        try {
          const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
          const result = await callSessionRpc({
            ...transport, token: credentials.token, sessionId: transport.sessionId,
            method: `${transport.sessionId}:abort`,
            request: { reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.` },
            ...(context.authority !== 'present_user' ? { authorityCeiling: 'account_automation' as const } : {}),
            ...(externalRequest && params.externalActionMachineRequestPrivateKey
              && params.externalActionMachineInstallationId ? { externalAction: {
                context, effectActionId: 'session.turn.cancel',
                installationId: params.externalActionMachineInstallationId,
                privateKey: params.externalActionMachineRequestPrivateKey,
              } } : {}),
            ...(signal ? { signal } : {}),
          });
          // The host's abort callback acknowledges delivery without a result.
          // Project that receipt at the Action boundary, including encrypted RPC.
          return result ?? { requested: true };
        } catch (error) {
          const errorCode = readRpcErrorCode(error) ?? 'session_rpc_failed';
          return { ok: false, errorCode, error: errorCode,
            errorMessage: error instanceof Error ? error.message : errorCode, sessionId: transport.sessionId };
        }
      });
    },

    sessionRuntimeRefresh: async ({ sessionId, machineId, serverId, context, signal }) => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const target = { machineId, serverId: serverId ?? context.serverId ?? params.serverId,
        context, effectActionId: 'session.runtime.refresh', exactMachine: true as const,
        ...(context.authority ? { authority: context.authority } : {}), ...(signal ? { signal } : {}) };
      const rawState = await callMachineAction({ ...target,
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET, request: { sessionId } });
      const state = SessionRunnerRuntimeStateV1Schema.safeParse(rawState);
      if (!state.success || state.data.sessionId !== sessionId || state.data.machineId !== machineId) {
        return { ok: false, status: 'unsupported_daemon', sessionId, reasonCode: 'unsupported_daemon_version' };
      }
      const request = buildSessionRunnerRuntimeRefreshRequestV1(state.data);
      if ('ok' in request) return request;
      // The daemon's existing planned-restart lifecycle owns completion and deferral.
      const result = RestartSessionRunnerResultV1Schema.safeParse(await callMachineAction({ ...target,
        method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, request, timeoutMs: null,
        authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId },
      }));
      return result.success && result.data.sessionId === sessionId ? result.data
        : { ok: false, status: 'partial_failure', sessionId, diagnostics: { errorCode: 'invalid_response' } };
    },

    sessionStop: async ({ sessionId, stopIntent, context, signal }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      const { requestSessionStop } = await import("@/session/services/requestSessionStop");
      return await requestSessionStop({ credentials: params.credentials, idOrPrefix: sessionId, stopIntent,
        invokeMachineRpc: request => callMachineAction({ machineId: request.machineId, method: request.method,
          request: request.request, requestId: request.requestId, timeoutMs: request.timeoutMs,
          ...(request.authorization ? { authorization: request.authorization } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          ...(context ? { context, authority: context.authority, serverId: context.serverId ?? undefined } : {}),
          effectActionId: 'session.stop',
        }),
        ...(signal ? { signal } : {}),
        ...(context ? { actionContext: context } : {}),
        resolveAuthorizationHeaders: request => resolveServerRequestHeaders(context, 'session.stop', request),
        ...(context?.externalActionExecutionAuthorization && params.externalActionMachineRequestPrivateKey
          && params.externalActionMachineInstallationId ? { externalAction: { context, effectActionId: 'session.stop',
            privateKey: params.externalActionMachineRequestPrivateKey, installationId: params.externalActionMachineInstallationId } } : {}),
      });
    },
    sessionControlSwitch: async ({ sessionId, to, context, signal }) => withProjectHome(async () => {
      if (!params.credentials) return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      const transport = await resolveTransportForSession(sessionId, signal, { context, actionId: 'session.control.switch' });
      if (!transport.ok) return { ok: false, errorCode: transport.code, error: transport.code };
      try {
        const { callSessionRpc } = await import("@/session/transport/rpc/sessionRpc");
        const switched = await callSessionRpc({ ...transport, token: params.credentials.token,
          sessionId: transport.sessionId, method: `${transport.sessionId}:switch`, request: { to },
          ...(context.authority !== 'present_user' ? { authorityCeiling: 'account_automation' as const } : {}),
          ...(context.externalActionExecutionAuthorization && params.externalActionMachineRequestPrivateKey
            && params.externalActionMachineInstallationId ? { externalAction: {
              context, effectActionId: 'session.control.switch', installationId: params.externalActionMachineInstallationId,
              privateKey: params.externalActionMachineRequestPrivateKey,
            } } : {}),
          ...(signal ? { signal } : {}),
        });
        if (switched === true) return { switched: true };
        if (switched && typeof switched === 'object' && 'ok' in switched && switched.ok === false) return switched;
        return { ok: false, errorCode: 'session_control_unavailable', error: 'session_control_unavailable' };
      } catch (error) {
        const errorCode = readRpcErrorCode(error) ?? 'session_control_unavailable';
        return { ok: false, errorCode, error: errorCode };
      }
    }),

    sessionModeSet: async ({ sessionId, modeId }) => {
      if (!params.credentials) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }

      const normalizedModeId = String(modeId ?? '').trim();
      const updatedAt = Date.now();
      const { setSessionMode } = await import("@/session/services/setSessionMode");
      const res = await setSessionMode({
        credentials: params.credentials,
        idOrPrefix: sessionId,
        modeId: normalizedModeId,
        updatedAt,
      });
      if (!res.ok) {
        return { ok: false, errorCode: res.code, error: res.code, ...(res.candidates ? { candidates: res.candidates } : {}) };
      }
      return { ok: true, sessionId: res.sessionId, modeId: normalizedModeId, updatedAt };
    },
  };
}
