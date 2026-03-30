import { describe, expect, it } from 'vitest';

import { createSystemTasksCapability, systemTasksCapability } from './toolSystemTasks';

describe('systemTasksCapability', () => {
  it('detects the supported methods and kinds', async () => {
    await expect(systemTasksCapability.detect({
      request: { id: 'tool.systemTasks' },
      context: { cliSnapshot: null },
    })).resolves.toEqual({
      available: true,
      kinds: [
        'remote.ssh.bootstrapMachine.v1',
        'relay.runtime.installOrUpdate.v1',
        'relay.runtime.start.v1',
        'relay.runtime.status.v1',
        'relay.runtime.stop.v1',
      ],
      methods: ['start', 'poll', 'respond'],
    });
  });

  it('delegates start, poll, and respond through the stateful runner', async () => {
    const calls: Array<Readonly<{ method: string; params: Record<string, unknown> }>> = [];
    const capability = createSystemTasksCapability({
      start: async (params) => {
        calls.push({ method: 'start', params: params as Record<string, unknown> });
        return { taskId: 'task-1' };
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
    });

    await expect(capability.invoke?.({
      method: 'start',
      params: {
        spec: {
          protocolVersion: 1,
          kind: 'relay.runtime.status.v1',
          params: {},
        },
      },
    })).resolves.toEqual({
      ok: true,
      result: { taskId: 'task-1' },
    });

    await expect(capability.invoke?.({
      method: 'poll',
      params: {
        taskId: 'task-1',
        cursor: 0,
      },
    })).resolves.toEqual({
      ok: true,
      result: {
        events: [],
        nextCursor: 0,
        pendingPrompt: null,
        result: null,
      },
    });

    await expect(capability.invoke?.({
      method: 'respond',
      params: {
        taskId: 'task-1',
        answer: { approved: true },
      },
    })).resolves.toEqual({
      ok: true,
      result: { ok: true },
    });

    expect(calls).toEqual([
      {
        method: 'start',
        params: {
          spec: {
            protocolVersion: 1,
            kind: 'relay.runtime.status.v1',
            params: {},
          },
        },
      },
      {
        method: 'poll',
        params: {
          taskId: 'task-1',
          cursor: 0,
        },
      },
      {
        method: 'respond',
        params: {
          taskId: 'task-1',
          answer: { approved: true },
        },
      },
    ]);
  });
});
