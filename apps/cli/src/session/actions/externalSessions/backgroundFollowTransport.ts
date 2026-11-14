import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol/actions';
import { ExternalSessionBackgroundFollowActionInputV1Schema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { isRpcMethodNotFoundError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import type { StoredCredentials } from '@/persistence';
import { loadPersistedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveExternalActionMachineTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';

/** Semantic follow intent resolves only through the current persisted link. */
export async function executeBackgroundFollowTransport(params: Readonly<{
  credentials: StoredCredentials;
  input: unknown;
  context: ActionExecutorContext;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}>): Promise<ActionExecuteResult> {
  const input = ExternalSessionBackgroundFollowActionInputV1Schema.parse(params.input);
  const linked = await loadPersistedLinkedExternalSession({ credentials: params.credentials,
    sessionId: input.sessionId, ...(params.signal ? { signal: params.signal } : {}) });
  if (!linked.ok) return { ok: true, result: { ok: false, errorCode: linked.errorCode, error: linked.error } };
  const target = resolveExternalActionMachineTarget({ actionId: 'sessions.external.backgroundFollow.set', rawInput: input,
    target: params.context.externalActionTarget, ownerMachineId: linked.session.machineId, context: params.context });
  if (target.kind === 'rejected') return target.execution;
  const dispatch = (method: string, raw: unknown) => callExactMachineRpc({ credentials: params.credentials,
    serverUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), machineId: target.machineId,
    method, request: raw, requireCurrentMachine: true, timeoutMs: null,
    ...(params.signal ? { signal: params.signal } : {}) });
  try {
    let response: unknown;
    try {
      response = await dispatch(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET, input);
    } catch (error) {
      if (!isRpcMethodNotFoundError(error)) throw error;
      // The predecessor's enable path emits the retired raw-delta data plane.
      // Disabling remains safe through its released provider-named adapter.
      if (input.enabled) return { ok: true, result: { ok: false,
        errorCode: 'agent_unavailable', error: 'background_follow_not_supported' } };
      response = await dispatch(RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY,
        { ...input, machineId: linked.session.machineId, providerId: linked.session.agentId,
          remoteSessionId: linked.session.remoteSessionId, source: linked.session.source });
      if (response && typeof response === 'object' && 'errorCode' in response && response.errorCode === 'provider_unavailable') {
        response = { ...response, errorCode: 'agent_unavailable' };
      }
    }
    const spec = getActionSpec('sessions.external.backgroundFollow.set');
    const result = await spec.surfaceBindings!.plugin!.projectOutput!(response, {
      actionId: 'sessions.external.backgroundFollow.set', surface: 'rpc', caller: { kind: 'host' }, input,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    const code = readRpcErrorCode(error)
      ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null)
      ?? 'external_session_action_failed';
    return { ok: false, errorCode: code, error: code };
  }
}
