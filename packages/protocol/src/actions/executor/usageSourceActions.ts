import { buildUsageSourceDismissalsKvKey, isDismissibleUsageSource, parseUsageSourceActionResult, UsageSourceDismissalsV1Schema,
  type UsageSourceActionId, type UsageSourceActionInputById,
  type UsageSourceActionOutputById } from '../../usage/usageSources.js';
import { parseActionExecuteFailure } from '../actionExecutionResult.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import type { ActionExecutorContext, ActionExecuteFailure } from './types.js';
import { canRetainUsageReadFailure } from '../../usage/resolveUsagePageAggregation.js';
import { readRpcErrorCode } from '../../rpc/errors.js';

export type UsageSourceActionRequest = { [K in UsageSourceActionId]: Readonly<{
  actionId: K; input: UsageSourceActionInputById[K];
}> }[UsageSourceActionId];
export type UsageSourceActionPort = (request: UsageSourceActionRequest, context: ActionExecutorContext) =>
  Promise<UsageSourceActionOutputById[UsageSourceActionId] | ActionExecuteFailure>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
export const usageSourceMutationAcknowledgedScopeRetired = (): ActionExecuteFailure => ({
  ...failure('usage_source_mutation_acknowledged_scope_retired'), details: { mutationStatus: 'applied' },
});

type MachineRequest = Exclude<UsageSourceActionRequest, { actionId: 'usage.sources.dismiss' }>;
type UsageSourceDismissalTransport = Readonly<{
  read(): Promise<Readonly<{ value: unknown; version: number }>>;
  compareAndSet(value: unknown, version: number): Promise<Readonly<{ success: boolean }>>;
}>;
function readDismissalState(value: unknown) {
  const state = UsageSourceDismissalsV1Schema.safeParse(value ?? { v: 1, sourceIds: [] });
  if (!state.success) throw Object.assign(new Error('Invalid Usage source dismissal record'), { code: 'invalid_response' });
  return state.data;
}

function dismissalFailure(error: unknown, fallback: string): ActionExecuteFailure {
  return parseActionExecuteFailure(error) ?? parseActionExecuteFailure(error instanceof Error ? error.cause : undefined)
    ?? failure(readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' ? error.code : fallback));
}

/** Account KV owns visibility of found sources. Consent, cursor and root lifecycle stay with the Machine collector. */
export function createUsageSourceActionPort(host: Readonly<{
  serverId: string;
  assertCurrent(context: ActionExecutorContext): void | Promise<void>;
  rpc(request: MachineRequest, context: ActionExecutorContext): Promise<unknown>;
  dismissalTransport?(key: string, context: ActionExecutorContext): UsageSourceDismissalTransport | Promise<UsageSourceDismissalTransport>;
}>): UsageSourceActionPort {
  const machine: (request: MachineRequest, context: ActionExecutorContext) => ReturnType<UsageSourceActionPort> = async (request, context) => {
    const read = request.actionId === 'usage.sources.discover' || request.actionId === 'usage.sources.get';
    let raw: unknown;
    try { raw = await host.rpc(request, context); }
    catch (error) {
      // Preserve an explicit authority withdrawal across the Machine boundary;
      // an ordinary read outage still uses the incumbent unavailable marker.
      const code = readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' ? error.code : undefined);
      if (read && code && !canRetainUsageReadFailure(code)) return failure(code);
      return failure(read ? 'usage_source_unavailable' : 'usage_source_mutation_outcome_unknown');
    }
    const refused = readActionFailureEnvelope(raw);
    if (refused) return refused;
    const result = parseUsageSourceActionResult(request.actionId, request.input, raw);
    if (!result) return failure(read ? 'usage_source_response_invalid' : 'usage_source_mutation_outcome_unknown');
    try { await host.assertCurrent(context); }
    catch (error) {
      if (read) throw error;
      // The acknowledged effect remains applied; only its private result is withheld.
      return usageSourceMutationAcknowledgedScopeRetired();
    }
    return result;
  };

  return async (request, context) => {
    await host.assertCurrent(context);
    // Core admitted the caller's Home; this port only binds the exact captured transport target.
    if (host.serverId !== request.input.serverId) return failure('server_target_mismatch');
    const key = buildUsageSourceDismissalsKvKey(request.input.machineId);
    if (request.actionId === 'usage.sources.dismiss') {
      if (!host.dismissalTransport) return { status: 'unavailable' };
      const { dismissed = true, ...target } = request.input;
      if (dismissed) {
        const source = await machine({ actionId: 'usage.sources.get', input: target }, context);
        if ('ok' in source) return source;
        if (!('sources' in source) || !source.sources.some(isDismissibleUsageSource)) return { status: 'unavailable' };
      }

      let writeIssued = false;
      try {
        const transport = await host.dismissalTransport(key, context);
        const row = await transport.read();
        const state = readDismissalState(row.value);
        await host.assertCurrent(context);
        if (state.sourceIds.includes(target.sourceId) !== dismissed) {
          const sourceIds = dismissed ? [...state.sourceIds, target.sourceId] : state.sourceIds.filter(id => id !== target.sourceId);
          writeIssued = true;
          const stored = await transport.compareAndSet({ ...state, sourceIds }, row.version);
          if (!stored.success) return failure('version_mismatch');
        }
      } catch (error) {
        return dismissalFailure(error, writeIssued ? 'usage_source_mutation_outcome_unknown' : 'account_kv_unavailable');
      }
      try { await host.assertCurrent(context); }
      catch { return usageSourceMutationAcknowledgedScopeRetired(); }
      return { status: dismissed ? 'dismissed' : 'restored' };
    }

    const result = await machine(request, context);
    if (!('sources' in result) || 'sourceId' in request.input && request.input.sourceId !== undefined
      || !host.dismissalTransport || !result.sources.some(isDismissibleUsageSource)) return result;
    try {
      const transport = await host.dismissalTransport(key, context);
      const dismissed = new Set(readDismissalState((await transport.read()).value).sourceIds);
      await host.assertCurrent(context);
      if (!dismissed.size) return result;
      const sources: typeof result.sources = [];
      const dismissedSources: typeof result.sources = [];
      for (const source of result.sources) {
        (dismissed.has(source.sourceId) && isDismissibleUsageSource(source) ? dismissedSources : sources).push(source);
      }
      return dismissedSources.length ? { sources, dismissedSources } : result;
    } catch (error) {
      await host.assertCurrent(context);
      return dismissalFailure(error, 'account_kv_unavailable');
    }
  };
}
