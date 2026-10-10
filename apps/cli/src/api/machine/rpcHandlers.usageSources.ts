import { USAGE_SOURCE_ACTION_IDS, USAGE_SOURCE_ACTION_INPUT_SCHEMAS, parseUsageSourceActionResult,
  type UsageSourceV1, type UsageSourceDateRangeV1 } from '@happier-dev/protocol/usage/usageSources';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import { usageSourceMutationAcknowledgedScopeRetired } from '@happier-dev/protocol/actions/executor/usageSourceActions';

/** Structural collector dependency: there is no second consent/source owner here. */
export type NativeUsageSourceService = Readonly<{
  discover(signal?: AbortSignal): Promise<readonly UsageSourceV1[]>;
  get(sourceId?: string, signal?: AbortSignal): Promise<readonly UsageSourceV1[]>;
  setConsent(sourceId: string, enabled: boolean, signal?: AbortSignal): Promise<UsageSourceV1>;
  stop(sourceId: string, signal?: AbortSignal): Promise<UsageSourceV1>;
  setRoot(sourceId: string, root: string | null, signal?: AbortSignal): Promise<UsageSourceV1>;
  deleteHistory(sourceId: string, dateRange?: UsageSourceDateRangeV1, signal?: AbortSignal): Promise<{ success: true; deletedEventCount: number }>;
}>;
export type NativeUsageSourceRpcOwner = Readonly<{
  serverId: string; machineId: string; installationId: string; custodianAccountId: string;
  service: NativeUsageSourceService;
}>;

export function registerMachineUsageSourceRpcHandlers(params: NativeUsageSourceRpcOwner & Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
}>): void {
  const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
  const current = async (context?: RpcHandlerContext): Promise<boolean> => {
    const admission = context?.machineAdmission;
    if (!context || !admission || context.signal.aborted || !context.verifyMachineAdmissionCurrent
      || admission.machineId !== params.machineId || admission.installationId !== params.installationId
      || admission.custodianAccountId !== params.custodianAccountId
      // Source history belongs to the captured Account, even on a shared Machine.
      || admission.actorAccountId !== params.custodianAccountId) return false;
    try { return await context.verifyMachineAdmissionCurrent() && !context.signal.aborted; }
    catch { return false; }
  };
  for (const actionId of USAGE_SOURCE_ACTION_IDS) {
    if (actionId === 'usage.sources.dismiss') continue;
    params.rpcHandlerManager.registerHandler(actionId, async (raw: unknown, context) => {
      const parsed = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[actionId].safeParse(raw);
      if (!parsed.success) return failure('invalid_parameters');
      const input = parsed.data;
      if (input.serverId !== params.serverId || input.machineId !== params.machineId || !await current(context) || !context) return failure('access_denied');
      try {
        let result: unknown;
        switch (actionId) {
          case 'usage.sources.discover': result = { sources: await params.service.discover(context.signal) }; break;
          case 'usage.sources.get': {
            const request = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[actionId].parse(input);
            result = { sources: await params.service.get(request.sourceId, context.signal) }; break;
          }
          case 'usage.sources.consent.set': {
            const request = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[actionId].parse(input);
            result = { source: await params.service.setConsent(request.sourceId, request.enabled, context.signal) }; break;
          }
          case 'usage.sources.stop': {
            const request = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[actionId].parse(input);
            result = { source: await params.service.stop(request.sourceId, context.signal) }; break;
          }
          case 'usage.sources.root.set': {
            const request = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[actionId].parse(input);
            result = { source: await params.service.setRoot(request.sourceId, request.root, context.signal) }; break;
          }
          case 'usage.sources.history.delete': {
            const request = USAGE_SOURCE_ACTION_INPUT_SCHEMAS[actionId].parse(input);
            result = await params.service.deleteHistory(request.sourceId, request.dateRange, context.signal); break;
          }
        }
        const read = actionId === 'usage.sources.discover' || actionId === 'usage.sources.get';
        const admitted = parseUsageSourceActionResult(actionId, input, result);
        if (!admitted) return failure(read ? 'usage_source_response_invalid' : 'usage_source_mutation_outcome_unknown');
        // Retirement cannot undo an admitted effect, but it must prevent late private-card disclosure.
        if (!await current(context)) return read ? failure('access_denied') : usageSourceMutationAcknowledgedScopeRetired();
        return admitted;
      } catch {
        return failure(context.signal.aborted ? 'cancelled' : 'usage_source_operation_failed');
      }
    });
  }
}
