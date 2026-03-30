import {
  type SystemTaskJsonValue,
} from '@happier-dev/protocol';

import { type InteractiveSystemTaskKind, buildPromptEventData } from './interactiveTaskKinds.js';
import { SystemTaskExecutionError, type SystemTaskExecutionRunner } from './runSystemTask.js';

type QueueItem =
  | Readonly<{ type: 'event'; value: unknown }>
  | Readonly<{ type: 'return'; value: unknown }>
  | Readonly<{ type: 'error'; error: unknown }>;

class AsyncQueue<T> {
  private items: T[] = [];

  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }
    this.items.push(value);
  }

  async shift(): Promise<T> {
    const next = this.items.shift();
    if (typeof next !== 'undefined') {
      return next;
    }
    return await new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

export function createExecutionRunnerFromKind(
  kind: InteractiveSystemTaskKind,
): SystemTaskExecutionRunner {
  return async function* runKind(params, context) {
    const queue = new AsyncQueue<QueueItem>();

    void kind.run({
      params: params as SystemTaskJsonValue,
      signal: context.signal,
      emit(event) {
        queue.push({
          type: 'event',
          value: event,
        });
      },
      async prompt(prompt) {
        queue.push({
          type: 'event',
          value: {
            type: 'prompt',
            ...(prompt.stepId ? { stepId: prompt.stepId } : {}),
            message: prompt.message,
            data: buildPromptEventData(prompt),
          },
        });
        throw new SystemTaskExecutionError('prompt_required', prompt.message);
      },
    }).then(
      (value) => {
        queue.push({
          type: 'return',
          value,
        });
      },
      (error) => {
        queue.push({
          type: 'error',
          error,
        });
      },
    );

    while (true) {
      const item = await queue.shift();
      if (item.type === 'event') {
        yield item.value;
        continue;
      }
      if (item.type === 'error') {
        throw item.error;
      }
      return item.value;
    }
  };
}
