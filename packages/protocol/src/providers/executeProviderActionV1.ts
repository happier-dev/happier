import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { createRpcCallError } from '../rpc/errors.js';
import { readRecord } from '../inputs/inputRecords.js';
import { createProviderErrorV1, ProviderErrorV1Schema, providerErrorFromRpcFailure } from './errors.js';
import { PROVIDER_ACTION_OUTPUT_SCHEMAS_V1, resolveProviderActionOwnerV1, type ProviderActionRequestV1 } from './providerActionsV1.js';
import type { ProviderActionIdV1 } from './providerActionIdsV1.js';
import type { ProviderDefaultModelSelectionMutationV1 } from './selection/v1.js';
import type { AccountSettingsMutationResult } from '../account/settings/accountSettingMutationV1.js';
import { DaemonProviderBindingStatusRequestV1Schema, DaemonProviderBindingStatusResponseV1Schema } from '../rpc/providers.js';
import { readSessionProviderBindingMetadataStateV1, type SessionProviderBindingSecurityChangeConfirmationV1 } from './sessions/bindingMetadataV1.js';
import { readSessionModelSelectionIntentSourceV1 } from './selection/v1.js';

type AccountActionId = 'providers.defaults.set' | 'providers.models.source_visibility.set' | 'providers.gateways.choose';
type RpcActionId = Exclude<ProviderActionIdV1, AccountActionId>;
type RpcRequest = Exclude<ProviderActionRequestV1, { actionId: AccountActionId }>;

function rpcErrorContext(request: RpcRequest) {
  let connectionId: string | undefined;
  switch (request.actionId) {
    case 'providers.binding.status':
      connectionId = 'launchBinding' in request.input ? request.input.launchBinding.connectionId : undefined;
      break;
    case 'providers.models.projection':
    case 'providers.models.refresh':
      connectionId = request.input.currentSelection?.providerConnectionId ?? undefined;
      break;
    case 'providers.models.visibility.set':
      connectionId = request.input.ref.providerConnectionId ?? undefined;
      break;
    case 'providers.models.visibility.reset':
      connectionId = request.input.scope.kind === 'connection' ? request.input.scope.connectionId : undefined;
      break;
    case 'providers.models.visibility.bulk': {
      const first = request.input.changes[0]?.ref.providerConnectionId;
      connectionId = first && request.input.changes.every(change => change.ref.providerConnectionId === first) ? first : undefined;
      break;
    }
    default:
      connectionId = 'connectionId' in request.input ? request.input.connectionId : undefined;
  }
  const input = readRecord(request.input);
  return { machineId: request.input.machineId,
    ...(connectionId ? { connectionId } : {}),
    ...(typeof input.sourceProfileId === 'string' ? { sourceProfileId: input.sourceProfileId } : {}),
  };
}

type ProviderActionRpcRouteV1 = Readonly<{ method: string; mutation: boolean }>;
export function resolveProviderActionRpcRouteV1(actionId: RpcActionId): ProviderActionRpcRouteV1;
export function resolveProviderActionRpcRouteV1(actionId: ProviderActionIdV1): ProviderActionRpcRouteV1 | null;
/** The execution and Machine admission owners consume the same native route. */
export function resolveProviderActionRpcRouteV1(actionId: ProviderActionIdV1): ProviderActionRpcRouteV1 | null {
  switch (actionId) {
    case 'providers.defaults.set':
    case 'providers.gateways.choose':
    case 'providers.models.source_visibility.set': return null;
    case 'providers.connections.describe': return { method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, mutation: false };
    case 'providers.models.list': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODELS, mutation: false };
    case 'providers.models.projection':
    case 'providers.models.refresh': return { method: RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, mutation: false };
    case 'providers.probe': return { method: RPC_METHODS.DAEMON_PROVIDERS_PROBE, mutation: false };
    case 'providers.usage.refresh': return { method: RPC_METHODS.DAEMON_PROVIDERS_USAGE_REFRESH, mutation: false };
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

/** One dispatch owner: Account catalog semantics and exact-machine runtime effects. */
export function createProviderActionExecuteV1(host: Readonly<{
  assertCurrent(context: ActionExecutorContext): void;
  /** Authenticated owner-only snapshot; no Provider decision is made by the host. */
  readSessionMetadata?(input: Readonly<{ machineId: string; sessionId: string }>, context: ActionExecutorContext): Promise<Readonly<Record<string, unknown>> | null>;
  rpc(input: Readonly<{ machineId: string; method: string; request: ProviderActionRequestV1; context: ActionExecutorContext;
    operationTimeoutMs?: null }>): Promise<unknown>;
  setDefault(input: ProviderDefaultModelSelectionMutationV1, context: ActionExecutorContext): Promise<Pick<AccountSettingsMutationResult, 'status'>>;
  account?(request: ProviderActionRequestV1, context: ActionExecutorContext): Promise<ActionExecuteResult>;
}>): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  return async (request, context): Promise<ActionExecuteResult> => {
    host.assertCurrent(context);
    if (resolveProviderActionOwnerV1(request) === 'accountCatalog' && host.account) {
      return host.account(request, context);
    }
    if (request.actionId === 'providers.models.source_visibility.set' || request.actionId === 'providers.gateways.choose') {
      return { ok: false, errorCode: 'provider_account_action_unavailable', error: 'provider_account_action_unavailable' };
    }
    if (request.actionId === 'providers.defaults.set') {
      const outcome = await host.setDefault(request.input, context);
      if (outcome.status === 'applied' || outcome.status === 'satisfied' || outcome.status === 'unchanged') {
        return { ok: true, result: { status: 'updated' } };
      }
      const errorCode = outcome.status === 'outcomeUnknown'
        ? 'account_settings_mutation_outcome_unknown'
        : `account_settings_mutation_${outcome.status}`;
      return { ok: false, errorCode, error: errorCode, details: outcome };
    }
    if (resolveProviderActionOwnerV1(request) !== 'machine') {
      return { ok: false, errorCode: 'provider_account_action_unavailable', error: 'provider_account_action_unavailable' };
    }
    let bindingConfirmation: Omit<SessionProviderBindingSecurityChangeConfirmationV1, 'nextBindingSecurityFingerprint'> | undefined;
    if (request.actionId === 'providers.binding.status' && 'sessionId' in request.input) {
      const { sessionId, machineId } = request.input;
      const metadata = await host.readSessionMetadata?.({ sessionId, machineId }, context);
      if (!metadata || metadata.machineId !== machineId) {
        return { ok: false, errorCode: 'session_target_unavailable', error: 'session_target_unavailable' };
      }
      const binding = readSessionProviderBindingMetadataStateV1(metadata);
      const intent = readSessionModelSelectionIntentSourceV1({ canonical: metadata.modelSelectionIntentV1, legacy: undefined });
      const selection = intent.status === 'canonical' ? intent.intent.selection : null;
      const prepared = DaemonProviderBindingStatusRequestV1Schema.safeParse({ machineId,
        agentTargetKey: selection?.agentTargetKey,
        selection: intent.status === 'canonical' ? { v: 1, updatedAt: intent.intent.updatedAt, ref: selection } : null,
        launchBinding: binding.kind === 'valid' ? binding.binding : null });
      if (!prepared.success) {
        const error = createProviderErrorV1('provider_binding_changed', { machineId });
        return { ok: false, errorCode: error.code, error: error.code, details: error };
      }
      bindingConfirmation = { v: 1, sessionId, connectionId: prepared.data.launchBinding.connectionId,
        previousBindingSecurityFingerprint: prepared.data.launchBinding.bindingSecurityFingerprint };
      request = { actionId: request.actionId, input: prepared.data };
    }
    const { method, mutation } = resolveProviderActionRpcRouteV1(request.actionId);
    const schema = request.actionId === 'providers.binding.status'
      ? DaemonProviderBindingStatusResponseV1Schema : PROVIDER_ACTION_OUTPUT_SCHEMAS_V1[request.actionId];
    const input = readRecord(request.input);
    const errorContext = rpcErrorContext(request);
    let result: unknown;
    try {
      if (!request.input.machineId) return { ok: false, errorCode: 'provider_machine_required', error: 'provider_machine_required' };
      result = await host.rpc({ machineId: request.input.machineId, method, request, context,
        // The projection owns its end-to-end Provider budget and source-scoped
        // refusals. A shorter acknowledgement timer would discard those results.
        ...(method === RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION ? { operationTimeoutMs: null } : {}),
      });
      // A successful Home ACK can carry the daemon manager's transport refusal.
      // Decode it before validating this Action's Provider-domain response.
      const reply = readRecord(result);
      if (typeof reply.error === 'string' && typeof reply.errorCode === 'string') {
        throw createRpcCallError({ error: reply.error, errorCode: reply.errorCode });
      }
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
    if (bindingConfirmation && parsed.data.status === 'changed' && 'nextBindingSecurityFingerprint' in parsed.data) {
      return { ok: true, result: { ...parsed.data, providerBindingSecurityChangeConfirmationV1: {
        ...bindingConfirmation, nextBindingSecurityFingerprint: parsed.data.nextBindingSecurityFingerprint,
      } } };
    }
    return { ok: true, result: parsed.data };
  };
}
