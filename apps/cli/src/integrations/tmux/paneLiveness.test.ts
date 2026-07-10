import { describe, expect, it } from 'vitest';

import { evaluateTmuxPaneLiveness, type TmuxPaneLivenessExecutor } from './paneLiveness';

describe('evaluateTmuxPaneLiveness', () => {
  it('parses live pane metadata from tmux display-message output', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => {
      expect(args).toEqual(['display-message', '-p', '-t', 'happy:claude.1', '#{pane_dead}\t#{pane_pid}\t#{pane_current_command}']);
      return {
        returncode: 0,
        stdout: '0\t12345\tclaude\n',
        stderr: '',
        command: [],
      };
    };

    await expect(evaluateTmuxPaneLiveness({
      executor,
      target: 'happy:claude.1',
      observedAt: 42,
    })).resolves.toEqual({
      paneAlive: true,
      paneDead: false,
      panePid: 12345,
      paneCurrentCommand: 'claude',
      observedAt: 42,
    });
  });

  it('redacts sensitive pane command metadata', async () => {
    const executor: TmuxPaneLivenessExecutor = async () => ({
      returncode: 0,
      stdout: '0\t12345\tclaude ANTHROPIC_API_KEY=sk-ant-secret-value Authorization: Bearer provider-bearer-secret\n',
      stderr: '',
      command: [],
    });

    const liveness = await evaluateTmuxPaneLiveness({
      executor,
      target: 'happy:claude.1',
      observedAt: 43,
    });

    expect(liveness.paneCurrentCommand).toContain('ANTHROPIC_API_KEY=[redacted-token]');
    expect(liveness.paneCurrentCommand).not.toContain('sk-ant-secret-value');
    expect(liveness.paneCurrentCommand).not.toContain('provider-bearer-secret');
  });

  it('treats failed liveness probes as inconclusive', async () => {
    await expect(evaluateTmuxPaneLiveness({
      executor: async () => null,
      target: 'missing',
      observedAt: 99,
    })).resolves.toEqual({
      paneAlive: false,
      probeInconclusive: true,
      observedAt: 99,
    });

    await expect(evaluateTmuxPaneLiveness({
      executor: async () => ({
        returncode: 1,
        stdout: '',
        stderr: 'no such pane',
        command: [],
      }),
      target: 'missing',
      observedAt: 100,
    })).resolves.toEqual({
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: 'no such pane',
      observedAt: 100,
    });

    await expect(evaluateTmuxPaneLiveness({
      executor: async () => ({
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
        timedOut: true,
      }),
      target: 'slow',
      observedAt: 101,
    })).resolves.toEqual({
      paneAlive: false,
      probeInconclusive: true,
      observedAt: 101,
    });
  });
});
