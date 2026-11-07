import { ExecutionRunGetResponseSchema, ExecutionRunStopResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { WorkflowInvocationRecoveryObservation } from './recovery';
import { observeWorkflowDetachedExecutionRunInput, resolveWorkflowDetachedExecutionRunInputTurn, stopWorkflowPendingExecutionRunInput } from './stepExecution';

type RunActionExecutor = Readonly<{
  execute: (
    actionId: 'execution.run.get' | 'execution.run.stop',
    request: Readonly<{ sessionId: null; runId: string; includeStructured?: false }>,
    context: Readonly<{ surface: 'agent'; authority: 'account_automation'; executionRunTargetMachineId: string; signal?: AbortSignal }>,
  ) => Promise<Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; errorCode: string }>>;
}>;

/** Observe and retire exact detached-input custody through its existing Run owner. */
export async function observeWorkflowDetachedRunRecovery(params: Readonly<{
  machineId: string;
  actionExecutor: RunActionExecutor;
  nativeActionRuns?: Readonly<{
    get: (runId: string, signal?: AbortSignal) => Promise<unknown>;
    stop: (runId: string, signal?: AbortSignal) => Promise<unknown>;
  }>;
  observeRun?: typeof observeWorkflowDetachedExecutionRunInput;
}>, input: Readonly<{
  execution: Extract<NonNullable<WorkflowProgressEnvelopeV1['execution']>, { kind: 'detached_run' }>;
  terminalParent: boolean;
  cancellationRequested: boolean;
  observationOnly?: boolean;
  signal?: AbortSignal;
}>): Promise<WorkflowInvocationRecoveryObservation> {
  const { execution } = input;
  const observeRun = params.observeRun ?? observeWorkflowDetachedExecutionRunInput;
  const execute: RunActionExecutor['execute'] = async (actionId, request, context) => {
    if (!params.nativeActionRuns) return await params.actionExecutor.execute(actionId, request, context);
    // Installed recovery already has exact Run custody. Reuse the same native
    // port as Action completion rather than attempting a fresh Home admission.
    const result = actionId === 'execution.run.get'
      ? await params.nativeActionRuns.get(request.runId, context.signal)
      : ExecutionRunStopResponseSchema.parse(await params.nativeActionRuns.stop(request.runId, context.signal));
    return { ok: true, result };
  };
  let actionFailure: string | null = null;
  let retainedRun: ReturnType<typeof ExecutionRunGetResponseSchema.parse>['run'] | undefined;
  const stoppedCustody = () => {
    if (!input.terminalParent || input.observationOnly || !retainedRun
      || (retainedRun.status !== 'failed' && retainedRun.status !== 'succeeded' && retainedRun.status !== 'cancelled')
      || retainedRun.inputTurns?.current?.state === 'active'
      || resolveWorkflowDetachedExecutionRunInputTurn(retainedRun, execution.runId, execution.localInputId)) return null;
    // Inactivity does not prove this historical input's outcome. Never copy a
    // different turn's result or failure into its invocation row.
    return { kind: 'stopped' as const, code: 'execution_run_input_not_observed' };
  };
  const actionContext = {
    surface: 'agent' as const,
    authority: 'account_automation' as const,
    executionRunTargetMachineId: params.machineId,
    ...(input.signal ? { signal: input.signal } : {}),
  };
  let observed: Awaited<ReturnType<typeof observeRun>>;
  try {
    observed = await observeRun({
      runId: execution.runId,
      localInputId: execution.localInputId,
      get: async request => {
        const result = await execute('execution.run.get', { sessionId: null, ...request }, actionContext);
        if (!result.ok) {
          actionFailure = result.errorCode;
          return null;
        }
        const parsed = ExecutionRunGetResponseSchema.safeParse(result.result);
        retainedRun = parsed.success && parsed.data.run.runId === execution.runId ? parsed.data.run : undefined;
        return result.result;
      },
    });
  } catch {
    return { kind: 'unresolved', code: actionFailure ?? 'execution_run_result_read_failed' };
  }
  if (actionFailure) return { kind: 'unresolved', code: actionFailure };
  if (observed.kind === 'outcome_uncertain' && observed.code === 'execution_run_input_not_observed') {
    return stoppedCustody() ?? observed;
  }
  if (observed.kind !== 'pending') return observed;
  if (input.observationOnly || (!input.terminalParent && !input.cancellationRequested)) {
    return { kind: 'unresolved', code: 'execution_run_input_pending' };
  }
  const { signal: _signal, ...stopContext } = actionContext;
  const stopped = await stopWorkflowPendingExecutionRunInput({
    runId: execution.runId,
    localInputId: execution.localInputId,
    stop: async () => {
      try {
        return await execute('execution.run.stop', { sessionId: null, runId: execution.runId }, stopContext);
      } catch {
        return { ok: false, errorCode: 'execution_run_stop_unavailable' };
      }
    },
    get: async request => {
      retainedRun = undefined;
      const result = await execute('execution.run.get', { sessionId: null, ...request }, stopContext);
      if (result.ok) {
        const parsed = ExecutionRunGetResponseSchema.safeParse(result.result);
        retainedRun = parsed.success && parsed.data.run.runId === execution.runId ? parsed.data.run : undefined;
      }
      return result.ok ? result.result : null;
    },
    observe: observeRun,
  });
  return stopped.kind === 'unresolved' ? stoppedCustody() ?? stopped : stopped;
}
