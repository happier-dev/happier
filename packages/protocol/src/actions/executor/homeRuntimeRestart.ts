import type { HomeRuntimeRestartInputV1, HomeRuntimeRestartOutputV1 } from '../../home/runtime/actionsV1.js';
import { SystemTaskResultSchema } from '../../system/tasks/spec.js';
import type { ActionExecuteResult } from '../actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One connected-Machine restart lifecycle, carried by each host's existing capability RPC. */
export async function executeHomeRuntimeRestart(
  input: HomeRuntimeRestartInputV1,
  context: ActionExecutorContext,
  rpc: NonNullable<ActionExecutorDeps['homeRuntimeTaskRpc']>,
): Promise<ActionExecuteResult> {
  const complete = (result: HomeRuntimeRestartOutputV1): ActionExecuteResult => ({ ok: true, result });
  let taskId: string | undefined;
  let startIssued = false;
  try {
    context.signal?.throwIfAborted();
    const detected = record(await rpc({ machineId: input.machineId, method: 'detect',
      request: { requests: [{ id: 'tool.systemTasks' }] }, context }));
    const capability = record(record(detected.results)['tool.systemTasks']);
    const data = record(capability.data);
    if (detected.protocolVersion !== 1 || capability.ok !== true || data.available !== true
      || !Array.isArray(data.methods) || !data.methods.includes('start') || !data.methods.includes('wait')
      || !Array.isArray(data.kinds) || !data.kinds.includes('relay.runtime.restart.v1')) {
      return complete({ status: 'unavailable', reason: 'system_tasks_unavailable' });
    }
    context.signal?.throwIfAborted();
    startIssued = true;
    const started = record(await rpc({ machineId: input.machineId, method: 'invoke', context,
      request: { id: 'tool.systemTasks', method: 'start', params: { spec: {
        protocolVersion: 1, kind: 'relay.runtime.restart.v1', params: {
          target: { kind: 'local' }, ...(input.channel ? { channel: input.channel } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
        },
      } } },
    }));
    if (started.ok === false) {
      if (typeof started.errorCode === 'string') return { ok: false, errorCode: started.errorCode,
        error: typeof started.error === 'string' ? started.error : started.errorCode };
      const error = record(started.error);
      return { ok: false, errorCode: typeof error.code === 'string' ? error.code : 'system_task_start_failed',
        error: typeof error.message === 'string' ? error.message : 'system_task_start_failed' };
    }
    const admitted = record(started.result);
    if (started.ok !== true || typeof admitted.taskId !== 'string' || !admitted.taskId.trim()) {
      return complete({ status: 'outcome_unknown' });
    }
    taskId = admitted.taskId;
    context.operationAcceptance?.accept({ taskId });
    const waited = record(await rpc({ machineId: input.machineId, method: 'invoke', context,
      request: { id: 'tool.systemTasks', method: 'wait', params: { taskId } } }));
    const terminal = SystemTaskResultSchema.safeParse(waited.result);
    if (waited.ok !== true || !terminal.success || terminal.data.taskId !== taskId) {
      return complete({ status: 'outcome_unknown', taskId });
    }
    return complete({ status: 'completed', taskId, result: terminal.data });
  } catch {
    if (startIssued) return complete({ status: 'outcome_unknown', ...(taskId ? { taskId } : {}) });
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    return complete({ status: 'unavailable', reason: 'system_tasks_unavailable' });
  }
}
