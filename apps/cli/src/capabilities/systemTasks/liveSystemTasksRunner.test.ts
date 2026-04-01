import { SYSTEM_TASK_PROTOCOL_VERSION } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { getLiveSystemTasksRunnerAdapter } from './liveSystemTasksRunner';

describe('getLiveSystemTasksRunnerAdapter', () => {
  it('supports system.ping.v1', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.ping.v1',
        params: { message: 'hello', n: 1 },
      },
    });

    const taskId = String((started as { taskId?: unknown }).taskId ?? '').trim();
    expect(taskId).toMatch(/^system-task:/u);

    const { events, result } = await waitForResult(adapter, taskId);
    expect(events.some((event) => event.type === 'progress' && event.stepId === 'ping')).toBe(true);
    expect(result?.ok).toBe(true);
    expect((result as { data?: unknown }).data).toEqual({
      acknowledged: true,
      kind: 'system.ping.v1',
      paramDigest: expect.any(String),
    });
  });

  it('supports system.noop.v1', async () => {
    const adapter = getLiveSystemTasksRunnerAdapter();
    const started = await adapter.start({
      spec: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        kind: 'system.noop.v1',
        params: { delayMs: 1, source: 'test' },
      },
    });

    const taskId = String((started as { taskId?: unknown }).taskId ?? '').trim();
    expect(taskId).toMatch(/^system-task:/u);

    const { events, result } = await waitForResult(adapter, taskId);
    expect(events.some((event) => event.type === 'progress' && event.stepId === 'noop')).toBe(true);
    expect(result?.ok).toBe(true);
    expect((result as { data?: unknown }).data).toEqual({
      kind: 'system.noop.v1',
      status: 'completed',
    });
  });
});

async function waitForResult(
  adapter: Readonly<{
    poll: (params: Record<string, unknown>) => Promise<unknown>;
  }>,
  taskId: string,
): Promise<Readonly<{ events: Array<{ type: string; stepId?: string }>; result: { ok: boolean } | null }>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const polled = await adapter.poll({ taskId, cursor: 0 });
    const events = (polled as { events?: unknown }).events;
    const result = (polled as { result?: unknown }).result;
    if (result && typeof result === 'object') {
      return {
        events: Array.isArray(events) ? (events as Array<{ type: string; stepId?: string }>) : [],
        result: result as { ok: boolean },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for system task result: ${taskId}`);
}
