import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { Query } from './query';

describe('Claude SDK Query (onMessageReceived)', () => {
  it('forwards the provider tool-use id with a can_use_tool control request', async () => {
    const stdout = new PassThrough();
    const canCallTool = vi.fn(async () => ({ behavior: 'allow' as const, updatedInput: {} }));
    const q = new Query(
      null,
      stdout,
      Promise.resolve(),
      canCallTool,
    ) as any;
    const signal = new AbortController().signal;

    await expect(q.processControlRequest({
      type: 'control_request',
      request_id: 'permission-request-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'git status' },
        tool_use_id: 'toolu_1',
      },
    }, signal)).resolves.toEqual({ behavior: 'allow', updatedInput: {} });

    expect(canCallTool).toHaveBeenCalledWith('Bash', { command: 'git status' }, {
      signal,
      toolUseId: 'toolu_1',
    });

    stdout.end();
  });

  it('fires onMessageReceived as soon as a message is read from stdout (even when the iterator is not consumed)', async () => {
    const stdout = new PassThrough();

    const q = new Query(
      null,
      stdout,
      Promise.resolve(),
      undefined,
    ) as any;

    const onMessageReceived = vi.fn();
    q.onMessageReceived = onMessageReceived;

    stdout.write(
      `${JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      })}\n`,
    );

    // Allow the readline loop to process the line.
    await Promise.resolve();
    await Promise.resolve();

    expect(onMessageReceived).toHaveBeenCalledTimes(1);
    expect(onMessageReceived.mock.calls[0]?.[0]).toMatchObject({ type: 'assistant' });

    stdout.end();
  });
});
