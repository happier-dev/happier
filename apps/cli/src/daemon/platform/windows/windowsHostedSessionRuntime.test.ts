import { describe, expect, it } from 'vitest';

import {
  buildWindowsHostedTerminalArgs,
  buildWindowsHostedTerminalAttachment,
  buildWindowsTerminalWindowIdentity,
  normalizeWindowsTerminalWindowName,
  resolveWindowsTerminalWindowName,
} from './windowsHostedSessionRuntime';

describe('windowsHostedSessionRuntime', () => {
  it('uses one shared Windows Terminal window id and a per-session tab title', () => {
    expect(buildWindowsTerminalWindowIdentity({
      existingSessionId: 'sess_123',
      agentCommand: 'codex',
      windowName: 'happier',
      now: () => 123,
      randomHex: () => 'abcd1234',
    })).toEqual({
      windowId: 'happier',
      title: 'Happier codex sess_123',
    });
  });

  it('keeps generated spawn ids in the tab title without changing the shared window id', () => {
    expect(buildWindowsTerminalWindowIdentity({
      agentCommand: 'claude',
      windowName: 'happier',
      now: () => 42,
      randomHex: () => 'beefcafe',
    })).toEqual({
      windowId: 'happier',
      title: 'Happier claude spawn-42-beefcafe',
    });
  });

  it('normalizes configured Windows Terminal window names', () => {
    expect(normalizeWindowsTerminalWindowName('  happier qa  ')).toBe('happier qa');
    expect(normalizeWindowsTerminalWindowName('')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('last')).toBe('happier');
    expect(normalizeWindowsTerminalWindowName('-1')).toBe('happier');
  });

  it('lets the daemon environment override the requested Windows Terminal window name', () => {
    expect(resolveWindowsTerminalWindowName({
      requested: 'from-ui',
      env: {
        HAPPIER_WINDOWS_TERMINAL_WINDOW_NAME: 'from-env',
      },
    })).toBe('from-env');
    expect(resolveWindowsTerminalWindowName({
      requested: 'from-ui',
      env: {
        HAPPIER_WINDOWS_TERMINAL_WINDOW_ID: 'from-legacy-env',
      },
    })).toBe('from-legacy-env');
  });

  it('adds Windows Terminal runtime flags to the base args', () => {
    expect(buildWindowsHostedTerminalArgs({
      baseArgs: ['codex', '--happy-starting-mode', 'remote'],
      actualMode: 'windows_terminal',
      requestedMode: 'windows_terminal',
      windowId: 'happy-codex-sess_123',
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
    ]);
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
        pid: 8888,
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
