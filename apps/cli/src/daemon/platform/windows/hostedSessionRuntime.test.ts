import { describe, expect, it } from 'vitest';

import {
  buildWindowsHostedTerminalArgs,
  buildWindowsHostedTerminalAttachment,
  buildWindowsTerminalWindowIdentity,
  normalizeWindowsTerminalWindowName,
  resolveWindowsTerminalWindowName,
} from './windowsHostedSessionRuntime';

describe('windowsHostedSessionRuntime', () => {
  it('uses the shared Windows Terminal window name while keeping per-session tab titles', () => {
    expect(buildWindowsTerminalWindowIdentity({
      existingSessionId: 'sess_123',
      agentCommand: 'codex',
      windowName: 'happier',
      now: () => 123,
      randomHex: () => 'ab'.repeat(16),
    })).toEqual({
      windowId: 'happier',
      title:
        `Happier codex sess_123 [${'ab'.repeat(16)}]`,
      launchCorrelation: 'ab'.repeat(16),
    });
  });

  it('keeps generated spawn titles without changing the shared window id', () => {
    expect(buildWindowsTerminalWindowIdentity({
      agentCommand: 'claude',
      windowName: 'happier',
      now: () => 42,
      randomHex: () => 'be'.repeat(16),
    })).toEqual({
      windowId: 'happier',
      title:
        `Happier claude spawn-42 [${'be'.repeat(16)}]`,
      launchCorrelation: 'be'.repeat(16),
    });
  });

  it('normalizes Windows Terminal window names', () => {
    expect(normalizeWindowsTerminalWindowName('  happier qa  ')).toBe('happier qa');
    expect(normalizeWindowsTerminalWindowName('')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName(' NEW ')).toBe('new');
    expect(normalizeWindowsTerminalWindowName('last')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('-1')).toBe('happier');
  });

  it('lets environment override the requested Windows Terminal window name', () => {
    expect(resolveWindowsTerminalWindowName({
      requested: 'from-settings',
      env: { HAPPIER_WINDOWS_TERMINAL_WINDOW_NAME: 'from-env' },
    })).toBe('from-env');

    expect(resolveWindowsTerminalWindowName({
      requested: 'from-settings',
      env: {},
    })).toBe('from-settings');

    expect(resolveWindowsTerminalWindowName({
      requested: ' new ',
      env: {},
    })).toBe('new');

    expect(resolveWindowsTerminalWindowName({
      requested: 'from-settings',
      env: { HAPPIER_WINDOWS_TERMINAL_WINDOW_NAME: 'NEW' },
    })).toBe('new');
  });

  it('adds Windows Terminal runtime flags to the base args', () => {
    expect(buildWindowsHostedTerminalArgs({
      baseArgs: ['codex', '--happy-starting-mode', 'remote'],
      actualMode: 'windows_terminal',
      requestedMode: 'windows_terminal',
      windowId: 'happy-codex-sess_123',
      title: 'Happier codex sess_123',
      launchCorrelation: 'ab'.repeat(16),
    })).toEqual([
      'codex',
      '--happy-starting-mode',
      'remote',
      '--happy-terminal-mode',
      'windows_terminal',
      '--happy-terminal-requested',
      'windows_terminal',
      '--happy-terminal-window-id',
      'happy-codex-sess_123',
      '--happy-terminal-title',
      'Happier codex sess_123',
      '--happy-terminal-launch-correlation',
      'abababababababababababababababab',
    ]);
  });

  it('creates a fresh 128-bit launch correlation in argv and the readable tab-title suffix', () => {
    const first = buildWindowsTerminalWindowIdentity({
      existingSessionId: 'sess_123',
      agentCommand: 'codex',
      windowName: 'happier',
      randomHex: () => '11'.repeat(16),
    });
    const second = buildWindowsTerminalWindowIdentity({
      existingSessionId: 'sess_123',
      agentCommand: 'codex',
      windowName: 'happier',
      randomHex: () => '22'.repeat(16),
    });

    expect(first).toEqual({
      windowId: 'happier',
      title:
        `Happier codex sess_123 [${'11'.repeat(16)}]`,
      launchCorrelation: '11'.repeat(16),
    });
    expect(second.title).toBe(
      `Happier codex sess_123 [${'22'.repeat(16)}]`,
    );
    expect(second.title).not.toBe(first.title);
    expect(second.launchCorrelation).toBe('22'.repeat(16));
    expect(second.launchCorrelation).not.toBe(first.launchCorrelation);
  });

  it('adds console fallback flags when Windows Terminal falls back to console', () => {
    expect(buildWindowsHostedTerminalArgs({
      baseArgs: ['codex'],
      actualMode: 'windows_console',
      requestedMode: 'windows_terminal',
      fallbackReason: 'wt.exe not installed',
    })).toEqual([
      'codex',
      '--happy-terminal-mode',
      'windows_console',
      '--happy-terminal-requested',
      'windows_terminal',
      '--happy-terminal-fallback-reason',
      'wt.exe not installed',
    ]);
  });

  it('builds Windows Terminal attachment metadata', () => {
    expect(buildWindowsHostedTerminalAttachment({
      actualMode: 'windows_terminal',
      requestedMode: 'windows_terminal',
      pid: 8888,
      windowId: 'happy-codex-sess_123',
      title: 'Happier codex sess_123',
    })).toEqual({
      mode: 'windows_terminal',
      requested: 'windows_terminal',
      windows: {
        host: 'windows_terminal',
        windowId: 'happy-codex-sess_123',
        title: 'Happier codex sess_123',
      },
    });
  });

  it('builds console attachment metadata with fallback reason', () => {
    expect(buildWindowsHostedTerminalAttachment({
      actualMode: 'windows_console',
      requestedMode: 'windows_terminal',
      pid: 7777,
      fallbackReason: 'wt.exe not installed',
    })).toEqual({
      mode: 'windows_console',
      requested: 'windows_terminal',
      fallbackReason: 'wt.exe not installed',
      windows: {
        host: 'console',
        pid: 7777,
      },
    });
  });
});
