import { describe, expect, it } from 'vitest';

import { resolveTerminalHost } from './resolveTerminalHost';
import type { TerminalHostAdapter, TerminalHostResolverPlatform } from './_types';

function adapter(kind: 'tmux' | 'zellij' | 'windows_console'): TerminalHostAdapter {
  return {
    kind,
    createOrAttachHost: async () => {
      throw new Error('not used');
    },
    injectUserPrompt: async () => {
      throw new Error('not used');
    },
    interruptTurn: async () => {
      throw new Error('not used');
    },
    evaluateLiveness: async () => ({ paneAlive: true, observedAt: 0 }),
    dispose: async () => {},
  };
}

describe('resolveTerminalHost', () => {
  it('prefers tmux on POSIX auto when tmux is available', () => {
    expect(
      resolveTerminalHost({
        preference: 'auto',
        platform: { os: 'darwin', arch: 'arm64' },
        adapters: { tmux: adapter('tmux'), zellij: adapter('zellij') },
        tmuxAvailable: true,
        zellijAvailable: true,
      }),
    ).toMatchObject({ status: 'resolved', adapter: { kind: 'tmux' }, reason: 'tmux_available' });
  });

  it('falls back to zellij on POSIX auto when tmux is unavailable', () => {
    expect(
      resolveTerminalHost({
        preference: 'auto',
        platform: { os: 'linux', arch: 'x64' },
        adapters: { zellij: adapter('zellij') },
        tmuxAvailable: false,
        zellijAvailable: true,
      }),
    ).toMatchObject({ status: 'resolved', adapter: { kind: 'zellij' }, reason: 'tmux_unavailable' });
  });

  it('prefers a Windows console host for native Windows auto without enabling zellij', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'x64' },
      adapters: { windows_console: adapter('windows_console'), zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'windows_console' },
      reason: 'windows_console_available',
    });
  });

  it('uses the Windows console host on Windows arm64 auto when available', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { windows_console: adapter('windows_console'), zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'windows_console' },
      reason: 'windows_console_available',
    });
  });

  it('uses the forced Windows console host on Windows arm64 when available', () => {
    const result = resolveTerminalHost({
      preference: 'windows_console',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { windows_console: adapter('windows_console') },
      tmuxAvailable: false,
      zellijAvailable: false,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'windows_console' },
      reason: 'windows_console_forced',
    });
  });

  it('fails closed for native Windows zellij until background TUI use is validated', () => {
    const windowsX64 = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'x64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });
    const windowsArm64 = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });
    const forcedWindowsZellij = resolveTerminalHost({
      preference: 'zellij',
      platform: { os: 'win32', arch: 'x64' },
      adapters: { zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(windowsX64).toMatchObject({ status: 'disabled', reason: 'windows_zellij_unvalidated' });
    expect(windowsArm64).toMatchObject({ status: 'disabled', reason: 'windows_arm64_unsupported' });
    expect(forcedWindowsZellij).toMatchObject({ status: 'disabled', reason: 'windows_zellij_unvalidated' });
  });

  it('rejects forced tmux on native Windows', () => {
    const platform: TerminalHostResolverPlatform = { os: 'win32', arch: 'x64' };

    expect(
      resolveTerminalHost({
        preference: 'tmux',
        platform,
        adapters: { tmux: adapter('tmux'), zellij: adapter('zellij') },
        tmuxAvailable: true,
        zellijAvailable: true,
      }),
    ).toMatchObject({ status: 'disabled', reason: 'tmux_unsupported_on_windows' });
  });

  it('rejects forced tmux when tmux is unavailable on POSIX', () => {
    expect(
      resolveTerminalHost({
        preference: 'tmux',
        platform: { os: 'linux', arch: 'x64' },
        adapters: { zellij: adapter('zellij') },
        tmuxAvailable: false,
        zellijAvailable: true,
      }),
    ).toMatchObject({ status: 'disabled', reason: 'tmux_unavailable' });
  });

  it('falls back to tmux on POSIX when forced zellij is unavailable', () => {
    expect(
      resolveTerminalHost({
        preference: 'zellij',
        platform: { os: 'darwin', arch: 'arm64' },
        adapters: { tmux: adapter('tmux') },
        tmuxAvailable: true,
        zellijAvailable: false,
      }),
    ).toMatchObject({ status: 'resolved', adapter: { kind: 'tmux' }, reason: 'zellij_unavailable_tmux_fallback' });
  });

  it('disables auto resolution when no supported host is available', () => {
    expect(
      resolveTerminalHost({
        preference: 'auto',
        platform: { os: 'linux', arch: 'x64' },
        adapters: {},
        tmuxAvailable: false,
        zellijAvailable: false,
      }),
    ).toMatchObject({ status: 'disabled', reason: 'no_host_available' });
  });
});
