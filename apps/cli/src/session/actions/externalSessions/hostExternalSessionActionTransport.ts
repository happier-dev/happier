import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { resolveExternalActionMachineTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';

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
    if (context.serverId && context.serverId !== params.serverId) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
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
    const ownerMachineId = sessionId ? await params.resolveSessionMachineId(sessionId, signal) : undefined;
    if (sessionId && !ownerMachineId) return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' };
    const target = resolveExternalActionMachineTarget({
      actionId, rawInput: semantic, target: context.externalActionTarget,
      ownerMachineId, fallbackMachineId: context.defaultSessionMachineId,
    });
    if (target.kind === 'rejected') return target.execution;
    const method = spec.bindings?.rpcMethod;
    if (!method) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
    const binding = spec.surfaceBindings?.rpc;
    const transportInput = binding?.inputSchema.safeParse(semantic);
    if (transportInput && !transportInput.success) {
      return { ok: false, errorCode: 'invalid_action_transport_input', error: 'invalid_action_transport_input' };
    }
    const response = await callExactMachineRpc({
      credentials: params.credentials, serverUrl: params.serverHttpBaseUrl,
      machineId: target.machineId, method, request: transportInput?.data ?? semantic,
      requireCurrentMachine: true, timeoutMs: null, ...(signal ? { signal } : {}),
    });
    // The existing family projection owns RPC progress -> public reference,
    // including failures. Never expose the private transport progress shape.
    const projectOutput = spec.surfaceBindings?.plugin?.projectOutput;
    const result = projectOutput ? await projectOutput(response, {
      actionId, surface: 'rpc', caller: { kind: 'host' }, input: semantic,
      ...(signal ? { signal } : {}),
    }) : response;
    return { ok: true, result };
  };
}
