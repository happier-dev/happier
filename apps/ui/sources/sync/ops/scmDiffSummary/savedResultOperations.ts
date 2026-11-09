import {
  ScmDiffSummaryResultListResponseSchema, ScmDiffSummaryResultClearInputSchema,
  ScmDiffSummaryResultClearResponseSchema,
  ScmDiffSummaryResultFailureSchema,
  ScmDiffSummaryMarksCleanupFailureSchema, ScmReviewedMarkResponseSchema,
  type ScmDiffSummaryResultListResponse, type ScmDiffSummaryResultClearInput,
  type ScmDiffSummaryResultListInput,
  type ScmDiffSummaryResultClearResponse, type ScmDiffSummaryResultFailure,
  type ScmDiffSummaryMarksCleanupFailure, type ScmReviewedMarkResponse,
} from '@happier-dev/protocol/scm';
import { invokeUiScmAction, type UiScmActionExecutor, type UiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Captured Home/Account/Machine lifetime; shared Action admission owns Clear confirmation. */
export function createScmDiffSummarySavedResultOperations(params: Readonly<{
  machineId: string; serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
  /** Independently verified transport proof, supplied only by an actual Session adapter. */
  sessionId?: string;
  shouldContinue: () => boolean;
  actionExecutor?: UiScmActionExecutor;
}>) {
  const current = () => !params.signal?.aborted && params.shouldContinue();
  const unavailable = (error: unknown): ScmDiffSummaryResultFailure => ({ success: false, errorCode: 'result_unavailable',
    error: error instanceof Error ? error.message : 'The captured Account or owning machine is unavailable.' });
  return {
    async list(input: ScmDiffSummaryResultListInput = {}): Promise<ScmDiffSummaryResultListResponse> {
      if (!current()) return unavailable(null);
      try {
        let executor = params.actionExecutor;
        if (!executor && params.sessionId) {
          const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
          // The separately admitted Session adapter retains its transport proof;
          // machine inventory alone cannot broaden into private Session results.
          executor = createFrontDoorActionExecute(createDefaultActionExecutor({ scmActionExecute: async ({ input, context }) => {
            const { runMachineScmRpcWithFallback } = await import('@/sync/ops/scm/machineScm');
            return runMachineScmRpcWithFallback(params.machineId, 'scm.diffSummary.result.list', input as Readonly<object>, {
              serverId: context.serverId, accountId: context.runtimeAccountId, signal: context.signal,
              authorization: { kind: 'session.write', sessionId: params.sessionId! },
            });
          } }));
        }
        const raw = await invokeUiScmAction({ actionId: 'scm.diffSummary.result.list', input,
          schema: ScmDiffSummaryResultListResponseSchema, executor, shouldContinue: current,
          context: { externalActionTarget: { kind: 'machine', machineId: params.machineId },
            ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}) } });
        if (!current()) return unavailable(null);
        if (raw.success) return raw;
        const failure = ScmDiffSummaryResultFailureSchema.safeParse(raw);
        return failure.success ? failure.data : unavailable(new Error(raw.error));
      } catch (error) { return unavailable(error); }
    },
    async clear(input: ScmDiffSummaryResultClearInput): Promise<ScmDiffSummaryResultClearResponse | UiScmActionFailure> {
      if (!current()) return unavailable(null);
      try {
        const validated = ScmDiffSummaryResultClearInputSchema.parse(input);
        return await invokeUiScmAction({ actionId: 'scm.diffSummary.result.clear', input: validated,
          schema: ScmDiffSummaryResultClearResponseSchema, executor: params.actionExecutor,
          shouldContinue: current,
          context: { externalActionTarget: { kind: 'machine', machineId: params.machineId },
            ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}) } });
      } catch (error) { return unavailable(error); }
    },
    async retryMarksCleanup(failure: ScmDiffSummaryMarksCleanupFailure): Promise<ScmReviewedMarkResponse | UiScmActionFailure> {
      if (!current()) return unavailable(null);
      try {
        const { retry } = ScmDiffSummaryMarksCleanupFailureSchema.parse(failure);
        // Re-enter the existing Reset Action: host capture authority is revalidated,
        // but deletion is never retried or reconstructed from an empty inventory.
        return await invokeUiScmAction({ actionId: retry.actionId, input: retry.input,
          schema: ScmReviewedMarkResponseSchema, executor: params.actionExecutor, shouldContinue: current,
          context: { externalActionTarget: { kind: 'machine', machineId: params.machineId },
            ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}) } });
      } catch (error) { return unavailable(error); }
    },
  };
}
