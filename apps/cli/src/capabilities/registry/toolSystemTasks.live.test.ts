import { describe, expect, it } from 'vitest';

import { createProtocolSystemTasksRunnerAdapter } from './toolSystemTasks';

describe('createProtocolSystemTasksRunnerAdapter', () => {
  it('translates protocol start requests into stateful runner tasks', async () => {
    const calls: Array<Readonly<{ method: string; params: Record<string, unknown> }>> = [];
    const adapter = createProtocolSystemTasksRunnerAdapter(
      {
        start: async (params) => {
          calls.push({ method: 'start', params: params as Record<string, unknown> });
          return { taskId: 'relay-task-1' };
        },
        poll: async (params) => {
          calls.push({ method: 'poll', params: params as Record<string, unknown> });
          return {
            events: [],
            nextCursor: 0,
            pendingPrompt: null,
            result: null,
          };
        },
        respond: async (params) => {
          calls.push({ method: 'respond', params: params as Record<string, unknown> });
        },
      },
      {
        createTaskId: () => 'relay-task-1',
      },
    );

    await expect(adapter.start({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.status.v1',
        params: {
          mode: 'user',
        },
      },
    })).resolves.toEqual({ taskId: 'relay-task-1' });

    await adapter.poll({ taskId: 'relay-task-1', cursor: 0 });
    await adapter.respond({ taskId: 'relay-task-1', answer: { approved: true } });

    expect(calls).toEqual([
      {
        method: 'start',
        params: {
          taskId: 'relay-task-1',
          kind: 'relay.runtime.status.v1',
          params: {
            mode: 'user',
          },
        },
      },
      {
        method: 'poll',
        params: {
          taskId: 'relay-task-1',
          cursor: 0,
        },
      },
      {
        method: 'respond',
        params: {
          taskId: 'relay-task-1',
          answer: { approved: true },
        },
      },
    ]);
  });
});
