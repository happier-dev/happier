import { describe, expect, it, vi } from 'vitest';

import { pasteTextViaTmuxBuffer, typeTextViaSendKeys, type TmuxCommandExecutor } from './typeText';

describe('typeTextViaSendKeys', () => {
  it('reports no duplicate risk when tmux fails before writing prompt bytes', async () => {
    const executor: TmuxCommandExecutor = async () => ({
      returncode: 1,
      stdout: '',
      stderr: 'tmux unavailable',
      command: [],
    });

    await expect(typeTextViaSendKeys({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      chunkSize: 256,
    })).resolves.toEqual({
      success: false,
      reason: 'type_failed',
      phase: 'during_write',
      duplicateRisk: 'none',
      progress: {
        textMayHaveReachedPane: false,
        newlineMayHaveReachedPane: false,
        submitMayHaveReachedPane: false,
      },
    });
  });

  it('submits after a complete write even when the write deadline is exhausted', async () => {
    const calls: readonly string[][] = [];
    const executor: TmuxCommandExecutor = async (args) => {
      (calls as string[][]).push([...args]);
      return {
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      };
    };

    await expect(typeTextViaSendKeys({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      chunkSize: 256,
      submitDelayMs: 101,
      timeoutMs: 100,
      wait: async () => undefined,
    })).resolves.toEqual({ success: true });
    expect(calls).toEqual([
      ['send-keys', '-t', 'happy:claude.1', '-l', '--', 'queued prompt'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
  });

  it('reports likely duplicate risk when the submit key may have reached the pane', async () => {
    let commandIndex = 0;
    const executor: TmuxCommandExecutor = async () => {
      commandIndex += 1;
      return {
        returncode: commandIndex === 1 ? 0 : 1,
        stdout: '',
        stderr: '',
        command: [],
        ...(commandIndex === 2 ? { timedOut: true } : {}),
      };
    };

    await expect(typeTextViaSendKeys({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      chunkSize: 256,
    })).resolves.toEqual({
      success: false,
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      progress: {
        textMayHaveReachedPane: true,
        newlineMayHaveReachedPane: false,
        submitMayHaveReachedPane: true,
      },
    });
  });
});

describe('pasteTextViaTmuxBuffer', () => {
  it('loads prompt text through stdin, pastes with raw bracketed mode, and submits separately', async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string | undefined }> = [];
    const executor: TmuxCommandExecutor = async (args, options) => {
      calls.push({ args: [...args], ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}) });
      return {
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      };
    };

    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'alpha\r\nbeta\rgamma',
      bufferName: 'happier-test-buffer',
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual([
      {
        args: ['load-buffer', '-b', 'happier-test-buffer', '-'],
        stdin: 'alpha\nbeta\ngamma',
      },
      {
        args: ['paste-buffer', '-p', '-r', '-d', '-b', 'happier-test-buffer', '-t', 'happy:claude.1'],
      },
      {
        args: ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      },
    ]);
  });

  it('re-sends Enter once when post-submit evidence still shows the current collapsed paste marker', async () => {
    const calls: readonly string[][] = [];
    let verifyCount = 0;
    const executor: TmuxCommandExecutor = async (args) => {
      (calls as string[][]).push([...args]);
      return { returncode: 0, stdout: '', stderr: '', command: [] };
    };

    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'line one\nline two',
      bufferName: 'happier-test-buffer',
      wait: async () => undefined,
      verifyAfterSubmit: async () => {
        verifyCount += 1;
        return verifyCount === 1;
      },
    })).resolves.toEqual({ success: true });

    expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
  });

  it('polls pre-submit verification until a delayed collapsed paste marker appears before pressing Enter', async () => {
    const calls: string[][] = [];
    const waits: number[] = [];
    const executor: TmuxCommandExecutor = async (args) => {
      calls.push([...args]);
      return { returncode: 0, stdout: '', stderr: '', command: [] };
    };
    const verifyBeforeSubmit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: Array.from({ length: 3_663 }, (_, index) => `line ${index}`).join('\n'),
      bufferName: 'happier-test-buffer',
      verifyBeforeSubmit,
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    })).resolves.toEqual({ success: true });

    expect(verifyBeforeSubmit).toHaveBeenCalledTimes(3);
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
  });
});
