import {
  ScmDiffSummaryResultListResponseSchema, ScmDiffSummaryResultClearInputSchema,
  ScmDiffSummaryResultClearResponseSchema,
  type ScmDiffSummaryResultListResponse, type ScmDiffSummaryResultClearInput,
  type ScmDiffSummaryResultClearResponse, type ScmDiffSummaryResultFailure,
} from '@happier-dev/protocol/scm';
import { invokeUiScmAction, type UiScmActionExecutor, type UiScmActionFailure } from '@/sync/ops/scm/scmActionInvocation';
import { getCurrentAuth } from '@/auth/context/currentAuth';

/** Captured Home/Account/Machine lifetime; caller owns the destructive confirmation dialog. */
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
    async list(): Promise<ScmDiffSummaryResultListResponse> {
      if (!current()) return unavailable(null);
      try {
        let executor = params.actionExecutor;
        if (!executor && params.sessionId) {
          const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
          // The separately admitted Session adapter retains its transport proof;
          // machine inventory alone cannot broaden into private Session results.
          executor = createDefaultActionExecutor({ scmActionExecute: async ({ input, context }) => {
            const { runMachineScmRpcWithFallback } = await import('@/sync/ops/scm/machineScm');
            return runMachineScmRpcWithFallback(params.machineId, 'scm.diffSummary.result.list', input as Readonly<object>, {
              serverId: context.serverId, accountId: context.runtimeAccountId, signal: context.signal,
              authorization: { kind: 'session.write', sessionId: params.sessionId! },
            });
          } });
        }
        const raw = await invokeUiScmAction({ actionId: 'scm.diffSummary.result.list', input: {},
          schema: ScmDiffSummaryResultListResponseSchema, executor, shouldContinue: current,
          context: { externalActionTarget: { kind: 'machine', machineId: params.machineId },
            ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}) } });
        if (!current()) return unavailable(null);
        const parsed = ScmDiffSummaryResultListResponseSchema.safeParse(raw);
        return parsed.success ? parsed.data : unavailable(new Error('The saved-result inventory could not be validated.'));
      } catch (error) { return unavailable(error); }
    },
    async clear(input: ScmDiffSummaryResultClearInput): Promise<ScmDiffSummaryResultClearResponse | UiScmActionFailure> {
      if (!current()) return unavailable(null);
      // The generic API-token Action remains machine-only. This combined Settings
      // workflow requires the same captured Account host used by the UI terminal.
      if (getCurrentAuth()?.credentialAuthorityKind === 'api_token') return unavailable(new Error('Personal reviewed marks are unavailable through API-token execution.'));
      try {
        const validated = ScmDiffSummaryResultClearInputSchema.parse(input);
        return await invokeUiScmAction({ actionId: 'scm.diffSummary.result.clear', input: validated,
          schema: ScmDiffSummaryResultClearResponseSchema, executor: params.actionExecutor,
          shouldContinue: () => current() && getCurrentAuth()?.credentialAuthorityKind !== 'api_token',
          context: { externalActionTarget: { kind: 'machine', machineId: params.machineId },
            ...(params.serverId ? { serverId: params.serverId } : {}), ...(params.accountId ? { expectedAccountId: params.accountId } : {}),
            ...(params.signal ? { signal: params.signal } : {}) } });
      } catch (error) { return unavailable(error); }
    },
  };
}
