import {
  type SystemTaskJsonValue,
} from '@happier-dev/protocol';

import { type InteractiveSystemTaskKind, buildPromptEventData } from './interactiveTaskKinds.js';
import { SystemTaskExecutionError, type SystemTaskExecutionRunner } from './runSystemTask.js';
import { createAsyncGeneratorFromEventProducer } from './createAsyncGeneratorFromEventProducer.js';

export function createExecutionRunnerFromKind(
  kind: InteractiveSystemTaskKind,
): SystemTaskExecutionRunner {
  return function runKind(params, context) {
    return createAsyncGeneratorFromEventProducer((emit) => kind.run({
      taskId: context.taskId,
      params: params as SystemTaskJsonValue,
      signal: context.signal,
      emit,
      async prompt(prompt) {
        emit({
          type: 'prompt',
          ...(prompt.stepId ? { stepId: prompt.stepId } : {}),
          message: prompt.message,
          data: buildPromptEventData(prompt),
        });
        if (context.readPromptAnswer) return await context.readPromptAnswer();
        throw new SystemTaskExecutionError('prompt_required', prompt.message);
      },
    }));
  };
}
