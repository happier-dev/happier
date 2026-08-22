import { describe, expect, it, vi } from 'vitest';

import { bindVoiceClientToolsToAttempt } from './attemptVoiceClientTools';

describe('bindVoiceClientToolsToAttempt', () => {
  it('rejects a tool whose attempt aborts before its handler settles', async () => {
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

  it('retains a known tool result when its attempt aborts immediately after handler settlement', async () => {
    const controller = new AbortController();
    const execute = vi.fn(() => {
      const settled = Promise.resolve({ ok: true });
      void settled.then(() => controller.abort());
      return settled;
    });
    const tools = bindVoiceClientToolsToAttempt([{
      name: 'mutateSession',
      description: 'Mutate session state',
      parameters: {},
      execute,
    }], controller.signal);

    await expect(tools[0]!.execute({})).resolves.toEqual({ ok: true });
    await expect(tools[0]!.execute({})).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
