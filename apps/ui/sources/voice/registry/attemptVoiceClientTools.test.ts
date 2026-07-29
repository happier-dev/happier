import { describe, expect, it, vi } from 'vitest';

import { bindVoiceClientToolsToAttempt } from './attemptVoiceClientTools';

describe('bindVoiceClientToolsToAttempt', () => {
  it('fences execution before and after attempt cancellation', async () => {
    const controller = new AbortController();
    let resolveExecution!: (value: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      resolveExecution = resolve;
    });
    const execute = vi.fn(async () => await pending);
    const tools = bindVoiceClientToolsToAttempt([{
      name: 'readSession',
      description: 'Read session state',
      parameters: {},
      execute,
    }], controller.signal);

    const running = tools[0]!.execute({});
    controller.abort();
    resolveExecution({ ok: true });

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(tools[0]!.execute({})).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
