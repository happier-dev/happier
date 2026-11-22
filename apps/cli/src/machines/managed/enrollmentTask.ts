import type { InteractiveSystemTaskEventInput, InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import { projectManagedMachineBootstrapPrompt, SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineControllerError } from './controllerErrors';
import { createManagedEnrollmentResponseValidation } from './enrollmentPairing';

/** One admitted task owns managed bootstrap questions and their cancellation lifetime. */
export function createManagedBootstrapTaskRunner(input: Readonly<{
  signal?: AbortSignal;
  onEvent?(event: InteractiveSystemTaskEventInput): void;
  onTask?(task: Readonly<{ taskId: string; kind: 'remote.ssh.bootstrapMachine.v1' }>): void | Promise<void>;
  onPrompt?(prompt: ManagedMachineBootstrapPromptV1 | null): void;
  readResponseOwner?(): Parameters<typeof createManagedEnrollmentResponseValidation>[0] | undefined;
}>) {
  let liveTaskId: string | undefined;
  return {
    readTaskId: () => liveTaskId,
    run: async (kind: InteractiveSystemTaskKind) => {
      const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
      const owner = getLiveSystemTasksRunnerAdapter();
      let taskFailure: unknown;
      const task = await owner.startAdmitted({ run: async ctx => {
        try {
          return await kind.run({ ...ctx, emit: event => { ctx.emit(event); input.onEvent?.(event); }, prompt: async prompt => {
            input.onPrompt?.(projectManagedMachineBootstrapPrompt(prompt));
            const data = prompt.data;
            const promptId = data && typeof data === 'object' && !Array.isArray(data) && 'promptId' in data
              && typeof data.promptId === 'string' ? data.promptId : undefined;
            const responseOwner = input.readResponseOwner?.();
            try { return await ctx.prompt({ ...prompt, ...(responseOwner ? {
              validateResponse: createManagedEnrollmentResponseValidation(responseOwner, { kind: prompt.kind, promptId }),
            } : {}) }); } finally { input.onPrompt?.(null); }
          } });
        } catch (error) {
          taskFailure = error;
          if (error instanceof ManagedMachineControllerError) throw new SystemTaskExecutionError(error.code, error.code);
          throw error;
        }
      } });
      liveTaskId = task.taskId;
      const cancel = () => { void owner.cancel(task); };
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted) cancel();
      try {
        await input.onTask?.({ ...task, kind: 'remote.ssh.bootstrapMachine.v1' });
        const result = await owner.wait(task);
        if (!result.ok) {
          if ((taskFailure instanceof ManagedMachineControllerError || taskFailure instanceof SystemTaskExecutionError)
            && result.error?.code === taskFailure.code) throw taskFailure;
          const failure = new SystemTaskExecutionError(result.error?.code ?? 'system_task_failed',
            result.error?.message ?? 'Managed guest setup failed.');
          // This waiter owns the in-process task. Recover the original closed facts without changing the task result schema.
          throw Object.assign(failure, { failureCause: projectActionFailureCauseV1(taskFailure, 'machine.bootstrap') });
        }
        input.signal?.throwIfAborted();
        return result.data;
      } catch (error) {
        await owner.cancel(task);
        await owner.wait(task);
        throw error;
      } finally { input.signal?.removeEventListener('abort', cancel); }
    },
  };
}
