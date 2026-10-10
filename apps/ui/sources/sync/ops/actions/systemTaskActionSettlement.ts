import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';
import { waitForSystemTaskResult } from '@/components/systemTasks';
import type { SystemTaskRunner } from '@/components/systemTasks/types';

type TaskStarted = Readonly<{ status: 'task_started'; taskId: string }>;
type Unavailable = Readonly<{ status: 'unavailable'; reason: string }>;
type ClientTaskOutcome = TaskStarted | Unavailable
    | Readonly<{ status: 'completed'; taskId: string; result: SystemTaskResult }>
    | Readonly<{ status: 'outcome_unknown'; taskId: string }>;

/** A reverse invocation observes its admitted task on the same client; UI keeps its live runner. */
export async function settleClientSystemTaskAction(
    runner: SystemTaskRunner,
    started: TaskStarted | Unavailable,
    context: Pick<ActionExecutorContext, 'surface' | 'signal'>,
    assertCurrent: () => void,
): Promise<ClientTaskOutcome> {
    if (started.status !== 'task_started' || context.surface === 'ui') return started;
    try {
        const result = await waitForSystemTaskResult(runner, started.taskId, { signal: context.signal });
        assertCurrent();
        return result.taskId === started.taskId
            ? { status: 'completed', taskId: started.taskId, result }
            : { status: 'outcome_unknown', taskId: started.taskId };
    } catch {
        // Admission happened. Losing this caller's observation cannot turn it into a known failure.
        return { status: 'outcome_unknown', taskId: started.taskId };
    }
}
