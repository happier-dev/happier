import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { readRecord } from '../inputs/inputRecords.js';
import { createProviderErrorV1, ProviderErrorV1Schema, providerErrorFromRpcFailure } from './errors.js';
import { PROVIDER_ACTION_OUTPUT_SCHEMAS_V1, type ProviderActionRequestV1 } from './providerActionsV1.js';
import type { ProviderActionIdV1 } from './providerActionIdsV1.js';
import type { ProviderDefaultModelSelectionMutationV1 } from './selection/v1.js';

type RpcActionId = Exclude<ProviderActionIdV1, 'providers.defaults.set'>;
function rpcRoute(actionId: RpcActionId): Readonly<{ method: string; mutation: boolean }> {
  switch (actionId) {
    case 'providers.connections.describe': return { method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, mutation: false };
    case 'providers.models.list': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODELS, mutation: false };
    case 'providers.models.projection':
    case 'providers.models.refresh': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, mutation: false };
    case 'providers.probe': return { method: RPC_METHODS.DAEMON_PROVIDERS_PROBE, mutation: false };
    case 'providers.binding.status': return { method: RPC_METHODS.DAEMON_PROVIDERS_BINDING_STATUS, mutation: false };
    case 'providers.legacy.prepare': return { method: RPC_METHODS.DAEMON_PROVIDERS_PROFILE_MIGRATION_PREPARE_SOURCE, mutation: true };
    case 'providers.models.load':
    case 'providers.models.cancel_load': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_LOAD, mutation: true };
    case 'providers.models.manual.add':
    case 'providers.models.manual.remove':
    case 'providers.models.visibility.set':
    case 'providers.models.visibility.reset':
    case 'providers.models.visibility.bulk':
    case 'providers.models.experimental.confirm': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_SETTINGS_MUTATE, mutation: true };
    case 'providers.connections.create_contribution':
    case 'providers.connections.create_custom':
    case 'providers.connections.enable_detected':
    case 'providers.connections.start_local':
    case 'providers.connections.update':
    case 'providers.connections.endpoint.set':
    case 'providers.connections.duplicate':
    case 'providers.connections.delete':
    case 'providers.connections.enabled.set':
    case 'providers.connections.secrets.bind': return { method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, mutation: true };
  }
}

/** Transport adapter only: the daemon remains the Provider domain mutation owner. */
export function createProviderActionExecuteV1(host: Readonly<{
  assertCurrent(context: ActionExecutorContext): void;
  rpc(input: Readonly<{ machineId: string; method: string; request: ProviderActionRequestV1; context: ActionExecutorContext }>): Promise<unknown>;
  setDefault(input: ProviderDefaultModelSelectionMutationV1, context: ActionExecutorContext): Promise<void>;
}>): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  return async (request, context): Promise<ActionExecuteResult> => {
    host.assertCurrent(context);
    if (request.actionId === 'providers.defaults.set') {
      await host.setDefault(request.input, context);
      return { ok: true, result: { status: 'updated' } };
    }
    const { method, mutation } = rpcRoute(request.actionId);
    const schema = PROVIDER_ACTION_OUTPUT_SCHEMAS_V1[request.actionId];
    const input = readRecord(request.input);
    const errorContext = { machineId: request.input.machineId,
      ...(typeof input.connectionId === 'string' ? { connectionId: input.connectionId } : {}),
      ...(typeof input.sourceProfileId === 'string' ? { sourceProfileId: input.sourceProfileId } : {}) };
    let result: unknown;
    try {
      result = await host.rpc({ machineId: request.input.machineId, method, request, context });
    } catch (caught) {
      // Admission/currentness refusals happen before transport and are not uncertain mutations.
      if (caught && typeof caught === 'object' && 'code' in caught &&
        ['action_account_scope_changed', 'scope-retired', 'server_scope_mismatch', 'not_authenticated'].includes(String(caught.code))) throw caught;
      const typed = ProviderErrorV1Schema.safeParse(caught);
      const error = typed.success ? typed.data : mutation
        ? createProviderErrorV1('provider_rpc_mutation_outcome_unknown', errorContext)
        : providerErrorFromRpcFailure(caught, errorContext);
      return { ok: false, errorCode: error.code, error: error.code, details: error };
    }
    const parsed = schema.safeParse(result);
    // A different successful operation is not an acknowledgement of this request.
    const output = parsed.success ? readRecord(parsed.data) : {};
    if (!parsed.success || output.status === 'success' && typeof output.action === 'string' && output.action !== input.action) {
      const error = createProviderErrorV1(mutation ? 'provider_rpc_mutation_outcome_unknown' : 'provider_rpc_response_invalid', errorContext);
      return { ok: false, errorCode: error.code, error: error.code, details: error };
    }
    // Mutation ACKs survive post-commit Account retirement; reads never disclose stale content.
    if (!mutation) host.assertCurrent(context);
    return { ok: true, result: parsed.data };
  };
}
