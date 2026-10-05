import {
  ScmDiffSummaryResultListResponseSchema, ScmDiffSummaryResultClearInputSchema,
  ScmDiffSummaryResultClearResponseSchema,
  type ScmDiffSummaryResultListResponse, type ScmDiffSummaryResultClearInput,
  type ScmDiffSummaryResultClearResponse, type ScmDiffSummaryResultFailure,
} from '@happier-dev/protocol/scm';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { randomUUID } from '@/platform/randomUUID';

/** Captured Home/Account/Machine lifetime; caller owns the destructive confirmation dialog. */
export function createScmDiffSummarySavedResultOperations(params: Readonly<{
  machineId: string; serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
  shouldContinue: () => boolean;
  rpc?: (method: string, input: object) => Promise<unknown>;
}>) {
  const current = () => !params.signal?.aborted && params.shouldContinue();
  const unavailable = (error: unknown): ScmDiffSummaryResultFailure => ({ success: false, errorCode: 'result_unavailable',
    error: error instanceof Error ? error.message : 'The captured Account or owning machine is unavailable.' });
  return {
    async list(): Promise<ScmDiffSummaryResultListResponse> {
      if (!current()) return unavailable(null);
      try {
        const rpc = params.rpc ?? (async (method: string, payload: object) => {
          const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
          return machineRpcWithServerScope<unknown, object>({ machineId: params.machineId, method, payload,
            ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { accountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}) });
        });
        const raw = await rpc(RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST, {});
        if (!current()) return unavailable(null);
        const parsed = ScmDiffSummaryResultListResponseSchema.safeParse(raw);
        return parsed.success ? parsed.data : unavailable(new Error('The saved-result inventory could not be validated.'));
      } catch (error) { return unavailable(error); }
    },
    async clear(input: ScmDiffSummaryResultClearInput): Promise<ScmDiffSummaryResultClearResponse> {
      if (!current()) return unavailable(null);
      // The generic API-token Action remains machine-only. This combined Settings
      // workflow requires the same captured Account host used by the UI terminal.
      if (getCurrentAuth()?.credentialAuthorityKind === 'api_token') return unavailable(new Error('Personal reviewed marks are unavailable through API-token execution.'));
      try {
        const validated = ScmDiffSummaryResultClearInputSchema.parse(input);
        const executor = (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const prepared = await executor.prepare('scm.diffSummary.result.clear', validated, { surface: 'ui', actionRequestId: randomUUID(),
          externalActionTarget: { kind: 'machine', machineId: params.machineId },
          ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
          ...(params.signal ? { signal: params.signal } : {}) });
        if (!current() || getCurrentAuth()?.credentialAuthorityKind === 'api_token') return unavailable(null);
        const response = prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
        if (!current()) return unavailable(null);
        if (!response.ok) return unavailable(new Error(response.error));
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response.result);
        if (approval.success) return unavailable(new Error('The Clear Action awaits approval.'));
        const parsed = ScmDiffSummaryResultClearResponseSchema.safeParse(response.result);
        if (!parsed.success) return unavailable(new Error('The saved-result Clear response could not be validated.'));
        return parsed.data;
      } catch (error) { return unavailable(error); }
    },
  };
}
