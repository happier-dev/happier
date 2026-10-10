import { USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS, parseUsageSourceActionResult, type UsageSourceActionId, type UsageSourceActionInputById,
  type UsageSourceActionOutputById } from '../../usage/usageSources.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import type { ActionExecutorContext, ActionExecuteFailure } from './types.js';

export type UsageSourceActionRequest = { [K in UsageSourceActionId]: Readonly<{
  actionId: K; input: UsageSourceActionInputById[K];
}> }[UsageSourceActionId];
export type UsageSourceActionPort = (request: UsageSourceActionRequest, context: ActionExecutorContext) =>
  Promise<UsageSourceActionOutputById[UsageSourceActionId] | ActionExecuteFailure>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
export const usageSourceMutationAcknowledgedScopeRetired = (): ActionExecuteFailure => ({
  ...failure('usage_source_mutation_acknowledged_scope_retired'), details: { mutationStatus: 'applied' },
});

/** Transport only. Consent, cursor and root lifecycle belong to the Machine collector. */
export function createUsageSourceActionPort(host: Readonly<{
  serverId: string;
  assertCurrent(context: ActionExecutorContext): void | Promise<void>;
  rpc(request: Exclude<UsageSourceActionRequest, { actionId: 'usage.sources.dismiss' }>, context: ActionExecutorContext): Promise<unknown>;
  dismiss?: (input: UsageSourceActionInputById['usage.sources.dismiss'], context: ActionExecutorContext) => Promise<unknown>;
}>): UsageSourceActionPort {
  return async (request, context) => {
    await host.assertCurrent(context);
    if (host.serverId !== request.input.serverId || (context.serverId && context.serverId !== host.serverId)) return failure('server_target_mismatch');
    if (request.actionId === 'usage.sources.dismiss') {
      if (!host.dismiss) return { status: 'unavailable' };
      const result = USAGE_SOURCE_ACTION_OUTPUT_SCHEMAS[request.actionId].parse(await host.dismiss(request.input, context));
      await host.assertCurrent(context);
      return result;
    }
    const read = request.actionId === 'usage.sources.discover' || request.actionId === 'usage.sources.get';
    let raw: unknown;
    try { raw = await host.rpc(request, context); }
    catch {
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
}
