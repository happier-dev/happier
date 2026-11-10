import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET_ACTION_ID, EXTERNAL_SESSION_STATUS_GET_ACTION_ID, EXTERNAL_SESSION_TAKEOVER_START_ACTION_ID } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { resolveExternalActionMachineTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { executeBackgroundFollowTransport } from './backgroundFollowTransport';
import { loadPersistedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readNonAuthoritativeLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol/sessions/external/linked-metadata';
import { captureExternalSessionTakeoverStartInputV1, ExternalSessionTakeoverActionInputV1Schema, projectExternalSessionOperationActionResultV1 } from '@happier-dev/protocol/sessions/external/operationActionSchemasV1';

/** Domain continuation after the canonical executor's policy/approval admission, never an MCP bypass. */
export function createHostExternalSessionActionTransport(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  resolveSessionMachineId: (sessionId: string, signal?: AbortSignal) => Promise<string | null>;
}>): NonNullable<ActionExecutorDeps['hostExternalSessionAction']> {
  return async ({ actionId, input, context, signal }) => {
    // Restricted external callers need the daemon's proof-carrying local owner;
    // never replace their credential with this ordinary Account transport.
    if (context.externalActionCredential || context.externalActionExecutionAuthorization) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    if (context.serverId && !await isServerProfileHomeIdentity(params.serverId, context.serverId)) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    if (actionId === EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET_ACTION_ID) {
      return await executeBackgroundFollowTransport({ credentials: params.credentials, input, context,
        serverHttpBaseUrl: params.serverHttpBaseUrl, ...(signal ? { signal } : {}) });
    }
    const spec = getActionSpec(actionId);
    const semantic = spec.inputSchema.parse(input);
    // This family has either explicit Machine selectors or a canonical linked
    // Session reference. Only parsed declared fields participate in routing.
    const request = semantic && typeof semantic === 'object' && 'request' in semantic ? semantic.request : undefined;
    const nestedSessionId = request && typeof request === 'object' && 'sessionId' in request ? request.sessionId : undefined;
    const directSessionId = semantic && typeof semantic === 'object' && 'sessionId' in semantic ? semantic.sessionId : undefined;
    const sessionId = typeof nestedSessionId === 'string' ? nestedSessionId
      : typeof directSessionId === 'string' ? directSessionId : null;
    let transportValue: unknown = semantic;
    let ownerMachineId: string | null | undefined;
    if (sessionId && (actionId === EXTERNAL_SESSION_STATUS_GET_ACTION_ID || actionId === EXTERNAL_SESSION_TAKEOVER_START_ACTION_ID)) {
      const linked = await loadPersistedLinkedExternalSession({ credentials: params.credentials, sessionId,
        ...(signal ? { signal } : {}) });
      if (!linked.ok) return { ok: false, errorCode: linked.errorCode, error: linked.error };
      ownerMachineId = linked.session.machineId;
      if (actionId === EXTERNAL_SESSION_STATUS_GET_ACTION_ID) {
        transportValue = { sessionId, machineId: linked.session.machineId, agentId: linked.session.agentId,
          remoteSessionId: linked.session.remoteSessionId, source: linked.session.source };
      } else {
        transportValue = captureExternalSessionTakeoverStartInputV1(
          ExternalSessionTakeoverActionInputV1Schema.parse(semantic),
          readNonAuthoritativeLinkedExternalSessionV1FromMetadata(linked.session.metadata),
        );
        if (!transportValue) return { ok: true, result: { ok: false,
          error: { code: 'source_unavailable', message: 'Linked session source is unavailable' } } };
      }
    } else {
      ownerMachineId = sessionId ? await params.resolveSessionMachineId(sessionId, signal) : undefined;
    }
    if (sessionId && !ownerMachineId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    const target = resolveExternalActionMachineTarget({
      actionId, rawInput: semantic, target: context.externalActionTarget,
      ownerMachineId, fallbackMachineId: context.defaultSessionMachineId,
    });
    if (target.kind === 'rejected') return target.execution;
    const method = spec.bindings?.rpcMethod;
    if (!method) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    const binding = spec.surfaceBindings?.rpc;
    const transportInput = binding?.inputSchema.safeParse(transportValue);
    if (transportInput && !transportInput.success) {
      return { ok: false, errorCode: 'invalid_action_transport_input', error: 'invalid_action_transport_input' };
    }
    const response = await callExactMachineRpc({
      credentials: params.credentials, serverUrl: params.serverHttpBaseUrl,
      machineId: target.machineId, method, request: transportInput?.data ?? transportValue,
      requireCurrentMachine: true, timeoutMs: null, ...(signal ? { signal } : {}),
    });
    // The existing family projection owns RPC progress -> public reference,
    // including failures. Never expose the private transport progress shape.
    const projectOutput = spec.surfaceBindings?.plugin?.projectOutput;
    const result = actionId === EXTERNAL_SESSION_TAKEOVER_START_ACTION_ID && sessionId
      ? projectExternalSessionOperationActionResultV1(response, sessionId)
      : projectOutput ? await projectOutput(response, {
      actionId, surface: 'rpc', caller: { kind: 'host' }, input: semantic,
      ...(signal ? { signal } : {}),
    }) : response;
    return { ok: true, result };
  };
}
