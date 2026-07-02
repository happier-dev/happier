import { describe, expect, it } from 'vitest';

import { typeTextViaSendKeys, type TmuxCommandExecutor } from './typeText';

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

  it('reports possible duplicate risk after writing prompt bytes but timing out before submit', async () => {
    let callCount = 0;
    const executor: TmuxCommandExecutor = async () => {
      callCount += 1;
      return {
        returncode: callCount === 1 ? 0 : 1,
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
    })).resolves.toEqual({
      success: false,
      reason: 'timeout',
      phase: 'after_write_before_enter',
      duplicateRisk: 'possible',
      progress: {
        textMayHaveReachedPane: true,
        newlineMayHaveReachedPane: false,
        submitMayHaveReachedPane: false,
      },
    });
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
