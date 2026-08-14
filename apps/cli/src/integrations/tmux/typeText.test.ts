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
  it('gives staging and Enter their own bounded phase after a slow successful paste', async () => {
    let nowMs = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const calls: string[] = [];
    const executor: TmuxCommandExecutor = async (args) => {
      calls.push(args[0] ?? '');
      if (args[0] === 'paste-buffer') nowMs += 100;
      return {
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      };
    };

    try {
      await expect(pasteTextViaTmuxBuffer({
        executor,
        target: 'happy:claude.1',
        text: 'queued prompt',
        bufferName: 'happier-test-buffer',
        timeoutMs: 100,
        verifyStagedBeforeSubmit: async ({ remainingTimeoutMs }) => {
          expect(remainingTimeoutMs).toBeGreaterThan(0);
          return true;
        },
      })).resolves.toEqual({ success: true });
    } finally {
      nowSpy.mockRestore();
    }

    expect(calls).toContain('send-keys');
  });

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
      text: 'alpha\nbeta',
      bufferName: 'happier-test-buffer',
    })).resolves.toEqual({ success: true });

    expect(calls).toEqual([
      {
        args: ['load-buffer', '-b', 'happier-test-buffer', '-'],
        stdin: 'alpha\nbeta',
      },
      {
        args: ['paste-buffer', '-p', '-r', '-d', '-b', 'happier-test-buffer', '-t', 'happy:claude.1'],
      },
      {
        args: ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      },
    ]);
  });

  it('normalizes CR and CRLF to LF before loading the tmux buffer', async () => {
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
    await pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'alpha\r\nbeta\rgamma',
      bufferName: 'happier-test-buffer',
    });

    expect(calls[0]).toEqual({
      args: ['load-buffer', '-b', 'happier-test-buffer', '-'],
      stdin: 'alpha\nbeta\ngamma',
    });
  });

  it('reports load-buffer failure as pre-write with no duplicate risk', async () => {
    const calls: readonly string[][] = [];
    const executor: TmuxCommandExecutor = async (args) => {
      (calls as string[][]).push([...args]);
      return {
        returncode: 1,
        stdout: '',
        stderr: 'load failed',
        command: [],
      };
    };
    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      bufferName: 'happier-test-buffer',
    })).resolves.toEqual({
      success: false,
      reason: 'load_failed',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress: {
        bufferLoaded: false,
        pasteMayHaveReachedPane: false,
        submitMayHaveReachedPane: false,
        cleanupAttempted: false,
      },
    });
    expect(calls).toEqual([
      ['load-buffer', '-b', 'happier-test-buffer', '-'],
    ]);
  });

  it('cleans up a loaded buffer when paste-buffer fails before submit', async () => {
    const calls: readonly string[][] = [];
    const executor: TmuxCommandExecutor = async (args) => {
      (calls as string[][]).push([...args]);
      return {
        returncode: args[0] === 'paste-buffer' ? 1 : 0,
        stdout: '',
        stderr: args[0] === 'paste-buffer' ? 'paste failed' : '',
        command: [],
      };
    };
    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      bufferName: 'happier-test-buffer',
    })).resolves.toEqual({
      success: false,
      reason: 'paste_failed',
      phase: 'during_write',
      duplicateRisk: 'none',
      progress: {
        bufferLoaded: true,
        pasteMayHaveReachedPane: false,
        submitMayHaveReachedPane: false,
        cleanupAttempted: true,
        cleanupSucceeded: true,
      },
    });
    expect(calls).toEqual([
      ['load-buffer', '-b', 'happier-test-buffer', '-'],
      ['paste-buffer', '-p', '-r', '-d', '-b', 'happier-test-buffer', '-t', 'happy:claude.1'],
      ['delete-buffer', '-b', 'happier-test-buffer'],
    ]);
  });

  it('treats paste-buffer timeout as ambiguous during-write delivery', async () => {
    const executor: TmuxCommandExecutor = async (args) => ({
      returncode: args[0] === 'paste-buffer' ? 1 : 0,
      stdout: '',
      stderr: '',
      command: [],
      ...(args[0] === 'paste-buffer' ? { timedOut: true } : {}),
    });
    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      bufferName: 'happier-test-buffer',
    })).resolves.toEqual({
      success: false,
      reason: 'timeout',
      phase: 'during_write',
      duplicateRisk: 'possible',
      progress: {
        bufferLoaded: true,
        pasteMayHaveReachedPane: true,
        submitMayHaveReachedPane: false,
        cleanupAttempted: true,
        cleanupSucceeded: true,
      },
    });
  });

  it('reports likely duplicate risk when submit times out after paste succeeds', async () => {
    const executor: TmuxCommandExecutor = async (args) => ({
      returncode: args[0] === 'send-keys' ? 1 : 0,
      stdout: '',
      stderr: '',
      command: [],
      ...(args[0] === 'send-keys' ? { timedOut: true } : {}),
    });
    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: 'queued prompt',
      bufferName: 'happier-test-buffer',
    })).resolves.toEqual({
      success: false,
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      progress: {
        bufferLoaded: true,
        pasteMayHaveReachedPane: true,
        submitMayHaveReachedPane: true,
        cleanupAttempted: false,
      },
    });
  });

  it('re-sends Enter once when post-submit evidence still shows the current collapsed paste marker', async () => {
    const calls: string[][] = [];
    const executor: TmuxCommandExecutor = async (args) => {
      calls.push([...args]);
      return {
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
      };
    };
    const verifyAfterSubmit = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n'),
      bufferName: 'happier-test-buffer',
      submitRetryDelayMs: 0,
      verifyAfterSubmit,
    })).resolves.toEqual({ success: true });

    expect(calls.filter((args) => args[0] === 'send-keys')).toEqual([
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
      ['send-keys', '-t', 'happy:claude.1', 'C-m'],
    ]);
    expect(verifyAfterSubmit).toHaveBeenCalledTimes(3);
  });

  it('reports ambiguous failure when the collapsed paste marker remains after the bounded Enter retry', async () => {
    const executor: TmuxCommandExecutor = async (args) => ({
      returncode: 0,
      stdout: '',
      stderr: '',
      command: [...args],
    });

    await expect(pasteTextViaTmuxBuffer({
      executor,
      target: 'happy:claude.1',
      text: Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n'),
      bufferName: 'happier-test-buffer',
      submitRetryDelayMs: 0,
      verifyAfterSubmit: async () => true,
    })).resolves.toEqual({
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      progress: {
        bufferLoaded: true,
        pasteMayHaveReachedPane: true,
        submitMayHaveReachedPane: true,
        cleanupAttempted: false,
      },
    });
  });
});
