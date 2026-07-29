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

  it.each([
    'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    'no server running on /private/tmp/tmux-501/default',
    "can't find session: missing",
    "can't find window: missing",
    "can't find pane: missing",
  ])('treats an exact tmux absence response as confirmed dead: %s', async (stderr) => {
    await expect(evaluateTmuxPaneLiveness({
      executor: async () => ({
        returncode: 1,
        stdout: '',
        stderr,
        command: [],
      }),
      target: 'missing',
      observedAt: 100,
    })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      observedAt: 100,
    });
  });

  it('checks the exact target when display-message succeeds with no pane fields', async () => {
    await expect(evaluateTmuxPaneLiveness({
      executor: async (args) => args[0] === 'display-message'
        ? {
            returncode: 0,
            stdout: '\t\t\n',
            stderr: '',
            command: [...args],
          }
        : {
            returncode: 1,
            stdout: '',
            stderr: "can't find session: missing",
            command: [...args],
          },
      target: 'missing:window',
      observedAt: 101,
    })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      observedAt: 101,
    });
  });

  it('keeps malformed successful output inconclusive when the exact-target follow-up is not authoritative', async () => {
    await expect(evaluateTmuxPaneLiveness({
      executor: async (args) => args[0] === 'display-message'
        ? { returncode: 0, stdout: '\t\t\n', stderr: '', command: [...args] }
        : { returncode: 1, stdout: '', stderr: 'permission denied', command: [...args] },
      target: 'unknown:window',
      observedAt: 102,
    })).resolves.toMatchObject({
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: 'permission denied',
      observedAt: 102,
    });
  });

  it.each([
    null,
    {
      returncode: 1,
      stdout: '',
      stderr: 'permission denied',
      command: [],
    },
    {
      returncode: 1,
      stdout: '',
      stderr: 'tmux command failed unexpectedly',
      command: [],
    },
    {
      returncode: 1,
      stdout: '',
      stderr: "can't find pane",
      command: [],
    },
    {
      returncode: 0,
      stdout: '',
      stderr: '',
      command: [],
      timedOut: true,
    },
  ])('keeps an unknown or timed-out tmux failure inconclusive', async (result) => {
    await expect(evaluateTmuxPaneLiveness({
      executor: async () => result,
      target: 'slow',
      observedAt: 102,
    })).resolves.toMatchObject({
      paneAlive: false,
      probeInconclusive: true,
      observedAt: 102,
    });
  });
});
