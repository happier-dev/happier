import { describe, expect, it } from 'vitest';

import { applyDaemonAutostartEnvForInvocation, shouldAutoStartDaemonAfterAuth, shouldEnsureDaemonForInvocation } from './ensureDaemon';

describe('shouldEnsureDaemonForInvocation', () => {
  it('returns true for agent subcommands that start sessions', () => {
    expect(shouldEnsureDaemonForInvocation({ args: ['codex'] })).toBe(true);
    expect(shouldEnsureDaemonForInvocation({ args: ['opencode'] })).toBe(true);
    expect(shouldEnsureDaemonForInvocation({ args: ['qwen'] })).toBe(true);
    expect(shouldEnsureDaemonForInvocation({ args: ['gemini'] })).toBe(true);
    expect(shouldEnsureDaemonForInvocation({ args: ['claude'] })).toBe(true);
  });

  it('returns true for default invocation (no explicit subcommand)', () => {
    expect(shouldEnsureDaemonForInvocation({ args: [] })).toBe(true);
  });

  it('returns false for non-session commands', () => {
    expect(shouldEnsureDaemonForInvocation({ args: ['auth'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['doctor'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['daemon'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['notify'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['connect'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['logout'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['attach'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['capabilities'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['self'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['server'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['session'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['sessions'] })).toBe(false);
  });

  it('returns false for help/version invocations', () => {
    expect(shouldEnsureDaemonForInvocation({ args: ['codex', '--help'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['codex', '--version'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['--help'] })).toBe(false);
  });

});

describe('shouldAutoStartDaemonAfterAuth', () => {
  it('starts only when flagged and not in daemon process', () => {
    expect(
      shouldAutoStartDaemonAfterAuth({
        env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' },
        isDaemonProcess: false,
        startedBy: 'terminal',
      }),
    ).toBe(true);
    expect(
      shouldAutoStartDaemonAfterAuth({
        env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '0' },
        isDaemonProcess: false,
        startedBy: 'terminal',
      }),
    ).toBe(false);
    expect(
      shouldAutoStartDaemonAfterAuth({
        env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' },
        isDaemonProcess: true,
        startedBy: 'terminal',
      }),
    ).toBe(false);
  });

  it('does not auto-start for daemon-started child sessions', () => {
    expect(
      shouldAutoStartDaemonAfterAuth({
        env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' },
        isDaemonProcess: false,
        startedBy: 'daemon',
      }),
    ).toBe(false);
  });

  it('does not auto-start when guided setup owns the post-auth service reconciliation', () => {
    expect(
      shouldAutoStartDaemonAfterAuth({
        env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' },
        isDaemonProcess: false,
        startedBy: 'terminal',
        callerIntent: 'setup-managed',
      }),
    ).toBe(false);
  });
});

describe('applyDaemonAutostartEnvForInvocation', () => {
  it.each([['codex'], ['--profile', 'codex']])('applies the selected backend terminal policy before generic defaults (%j)', (...args) => {
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      const env: NodeJS.ProcessEnv = {};
      applyDaemonAutostartEnvForInvocation({ args, env, autostartInInteractiveTerminal: false });
      expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
      const explicit: NodeJS.ProcessEnv = { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' };
      applyDaemonAutostartEnvForInvocation({ args, env: explicit, autostartInInteractiveTerminal: false });
      expect(explicit.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('1');
      const daemon: NodeJS.ProcessEnv = {};
      applyDaemonAutostartEnvForInvocation({ args: [...args, '--started-by', 'daemon'], env: daemon, autostartInInteractiveTerminal: false });
      expect(daemon.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
  });
  it('sets HAPPIER_SESSION_AUTOSTART_DAEMON=1 for session commands when unset', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDaemonAutostartEnvForInvocation({ args: ['codex'], env });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('1');
  });

  it('does not set HAPPIER_SESSION_AUTOSTART_DAEMON for daemon-started session commands', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDaemonAutostartEnvForInvocation({ args: ['claude', '--started-by', 'daemon'], env });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
  });

  it('does not override an explicit HAPPIER_SESSION_AUTOSTART_DAEMON=0', () => {
    const env: NodeJS.ProcessEnv = { HAPPIER_SESSION_AUTOSTART_DAEMON: '0' };
    applyDaemonAutostartEnvForInvocation({ args: ['codex'], env });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBe('0');
  });

  it('does not set HAPPIER_SESSION_AUTOSTART_DAEMON for non-session commands', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDaemonAutostartEnvForInvocation({ args: ['capabilities', '--json'], env });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
  });

  it('does not set HAPPIER_SESSION_AUTOSTART_DAEMON for the plural sessions command alias', () => {
    const env: NodeJS.ProcessEnv = {};
    applyDaemonAutostartEnvForInvocation({ args: ['sessions', 'list', '--json'], env });
    expect(env.HAPPIER_SESSION_AUTOSTART_DAEMON).toBeUndefined();
  });
});
