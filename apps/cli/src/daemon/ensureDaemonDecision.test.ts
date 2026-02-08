import { describe, expect, it } from 'vitest';

import { shouldAutoStartDaemonAfterAuth, shouldEnsureDaemonForInvocation } from './ensureDaemon';

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
    expect(shouldEnsureDaemonForInvocation({ args: ['self'] })).toBe(false);
  });

  it('returns false for help/version invocations', () => {
    expect(shouldEnsureDaemonForInvocation({ args: ['codex', '--help'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['codex', '--version'] })).toBe(false);
    expect(shouldEnsureDaemonForInvocation({ args: ['--help'] })).toBe(false);
  });

});

describe('shouldAutoStartDaemonAfterAuth', () => {
  it('starts only when flagged and not in daemon process', () => {
    expect(shouldAutoStartDaemonAfterAuth({ env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' }, isDaemonProcess: false })).toBe(true);
    expect(shouldAutoStartDaemonAfterAuth({ env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '0' }, isDaemonProcess: false })).toBe(false);
    expect(shouldAutoStartDaemonAfterAuth({ env: { HAPPIER_SESSION_AUTOSTART_DAEMON: '1' }, isDaemonProcess: true })).toBe(false);
  });
});
