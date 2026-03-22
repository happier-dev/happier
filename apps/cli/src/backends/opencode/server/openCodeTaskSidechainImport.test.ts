import { afterEach, describe, expect, it, vi } from 'vitest';

import { importOpenCodeTaskSidechainBestEffort } from './openCodeTaskSidechainImport';

describe('importOpenCodeTaskSidechainBestEffort', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('retries listing messages until sidechain transcript becomes available', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_WAIT_MS', '80');
    vi.stubEnv('HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_RETRY_BASE_DELAY_MS', '10');
    vi.stubEnv('HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_RETRY_MAX_DELAY_MS', '20');

    const rawMessages = [
      {
        info: { id: 'm1', role: 'assistant', time: { created: 10 } },
        parts: [{ type: 'text', text: 'SUBTASK_OK' }],
      },
    ];

    const sessionMessagesList = vi
      .fn<() => Promise<unknown[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rawMessages as unknown[]);

    const client = {
      sessionMessagesList: (_params: { sessionId: string }) => sessionMessagesList(),
    } as any;

    const committed: Array<{ kind: 'agent' | 'user'; text: string; meta: any }> = [];
    const session = {
      sendUserTextMessageCommitted: async (text: string, opts: { localId: string; meta: any }) => {
        committed.push({ kind: 'user', text, meta: opts.meta });
      },
      sendAgentMessageCommitted: async (_provider: string, msg: { type: 'message'; message: string }, opts: { localId: string; meta: any }) => {
        committed.push({ kind: 'agent', text: msg.message, meta: opts.meta });
      },
    } as any;

    const promise = importOpenCodeTaskSidechainBestEffort({
      client,
      session,
      provider: 'opencode' as any,
      remoteSessionId: 'remote-1',
      sidechainId: 'call-1',
    });

    await vi.runAllTimersAsync();
    const ok = await promise;

    expect(ok).toBe(true);
    expect(sessionMessagesList).toHaveBeenCalledTimes(3);
    expect(committed.some((c) => c.kind === 'agent' && c.text.includes('SUBTASK_OK'))).toBe(true);
    expect(committed.some((c) => c.meta?.importedFrom === 'acp-sidechain' && c.meta?.sidechainId === 'call-1')).toBe(true);
  });

  it('times out when retryBaseDelayMs=0 and the sidechain transcript never appears', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_WAIT_MS', '5');
    vi.stubEnv('HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_RETRY_BASE_DELAY_MS', '0');
    vi.stubEnv('HAPPIER_OPENCODE_TASK_SIDECHAIN_IMPORT_RETRY_MAX_DELAY_MS', '0');

    let callCount = 0;
    const sessionMessagesList = vi.fn((): Promise<unknown[]> => {
      callCount += 1;
      if (callCount > 20) {
        return new Promise<unknown[]>(() => {});
      }
      return new Promise<unknown[]>((resolve) => setTimeout(() => resolve([]), 1));
    });

    const client = {
      sessionMessagesList: (_params: { sessionId: string }) => sessionMessagesList(),
    } as any;

    const session = {
      sendUserTextMessageCommitted: async () => {},
      sendAgentMessageCommitted: async () => {},
    } as any;

    let finished = false;
    let result: boolean | undefined;
    const promise = importOpenCodeTaskSidechainBestEffort({
      client,
      session,
      provider: 'opencode' as any,
      remoteSessionId: 'remote-1',
      sidechainId: 'call-1',
    });
    promise.then((value) => {
      finished = true;
      result = value;
    });

    await vi.advanceTimersByTimeAsync(50);
    await Promise.resolve();

    expect(finished).toBe(true);
    expect(result).toBe(false);
  });
});
