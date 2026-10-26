import { describe, expect, it } from 'vitest';

import { evaluateTmuxPaneLiveness, type TmuxPaneLivenessExecutor } from './paneLiveness';

describe('evaluateTmuxPaneLiveness', () => {
  it('returns live pane metadata from tmux display-message output', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => {
      if (args[0] === 'has-session') return { returncode: 0, stdout: '', stderr: '', command: [...args] };
      expect(args).toEqual([
        'display-message',
        '-p',
        '-t',
        'happy:claude.1',
        '#{pane_dead}|#{pane_pid}|#{pane_current_command}',
      ]);
      return { returncode: 0, stdout: '0|12345|claude\n', stderr: '', command: [...args] };
    };

    await expect(evaluateTmuxPaneLiveness({ executor, target: 'happy:claude.1', observedAt: 42 })).resolves.toEqual({
      paneAlive: true,
      paneDead: false,
      panePid: 12345,
      paneCurrentCommand: 'claude',
      observedAt: 42,
    });
  });

  it.each([
    '0\t12345\tclaude\n',
    '0_12345_claude\n',
  ])('accepts legacy tmux liveness output after resolving the exact target: %s', async (stdout) => {
    const executor: TmuxPaneLivenessExecutor = async (args) => {
      if (args[0] === 'has-session') return { returncode: 0, stdout: '', stderr: '', command: [...args] };
      expect(args[0]).toBe('display-message');
      return { returncode: 0, stdout, stderr: '', command: [...args] };
    };

    await expect(evaluateTmuxPaneLiveness({ executor, target: 'happy:claude.1', observedAt: 44 })).resolves.toEqual({
      paneAlive: true,
      paneDead: false,
      panePid: 12345,
      paneCurrentCommand: 'claude',
      observedAt: 44,
    });
  });

  it('redacts sensitive pane command diagnostics', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 0,
      stdout: '0|12345|claude ANTHROPIC_API_KEY=sk-ant-secret-value\n',
      stderr: '',
      command: [...args],
    });

    const liveness = await evaluateTmuxPaneLiveness({ executor, target: 'happy:claude.1', observedAt: 43 });

    expect(liveness.paneCurrentCommand).toContain('ANTHROPIC_API_KEY: [REDACTED]');
    expect(liveness.paneCurrentCommand).not.toContain('sk-ant-secret-value');
  });

  it('returns not alive for panes that tmux reports as dead', async () => {
    const deadExecutor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 0,
      stdout: '1|12345|zsh\n',
      stderr: '',
      command: [...args],
    });

    await expect(evaluateTmuxPaneLiveness({ executor: deadExecutor, target: 'dead', observedAt: 100 })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      panePid: 12345,
    });
  });

  it.each([
    'error connecting to /private/tmp/tmux-501/default (No such file or directory)',
    'no server running on /private/tmp/tmux-501/default',
    "can't find session: missing",
    "can't find window: missing",
    "can't find pane: missing",
  ])('treats an exact tmux absence response as confirmed dead: %s', async (stderr) => {
    const executor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 1,
      stdout: '',
      stderr,
      command: [...args],
    });

    await expect(evaluateTmuxPaneLiveness({ executor, target: 'missing', observedAt: 101 })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      observedAt: 101,
    });
  });

  it('rejects a missing target even when display-message falls back to a different live pane', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => args[0] === 'has-session'
      ? { returncode: 1, stdout: '', stderr: "can't find window: @7", command: [...args] }
      : { returncode: 0, stdout: '0|999|claude\\n', stderr: '', command: [...args] };

    await expect(evaluateTmuxPaneLiveness({
      executor, target: '=owner:@7', observedAt: 102,
    })).resolves.toMatchObject({ paneAlive: false, paneDead: true });
  });

  it('checks the exact target when display-message succeeds with no pane fields', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => {
      if (args[0] === 'display-message') {
        return {
          returncode: 0,
          stdout: '\t\t\n',
          stderr: '',
          command: [...args],
        };
      }
      expect(args).toEqual(['has-session', '-t', 'missing:window']);
      return {
        returncode: 1,
        stdout: '',
        stderr: "can't find session: missing",
        command: [...args],
      };
    };

    await expect(evaluateTmuxPaneLiveness({
      executor,
      target: 'missing:window',
      observedAt: 102,
    })).resolves.toMatchObject({
      paneAlive: false,
      paneDead: true,
      observedAt: 102,
    });
  });

  it('keeps malformed successful output inconclusive when the exact-target follow-up is not authoritative', async () => {
    const executor: TmuxPaneLivenessExecutor = async (args) => args[0] === 'display-message'
      ? { returncode: 0, stdout: '\t\t\n', stderr: '', command: [...args] }
      : { returncode: 1, stdout: '', stderr: 'permission denied', command: [...args] };

    await expect(evaluateTmuxPaneLiveness({
      executor,
      target: 'unknown:window',
      observedAt: 102,
    })).resolves.toEqual({
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: 'permission denied',
      observedAt: 102,
    });
  });

  it.each([
    'permission denied',
    'tmux command failed unexpectedly',
    "can't find pane",
  ])('keeps an unknown tmux failure inconclusive: %s', async (stderr) => {
    const failedProbeExecutor: TmuxPaneLivenessExecutor = async (args) => ({
      returncode: 1,
      stdout: '',
      stderr,
      command: [...args],
    });

    await expect(evaluateTmuxPaneLiveness({ executor: failedProbeExecutor, target: 'missing', observedAt: 103 })).resolves.toEqual({
      paneAlive: false,
      probeInconclusive: true,
      paneScreenDumpError: stderr,
      observedAt: 103,
    });
  });
});
