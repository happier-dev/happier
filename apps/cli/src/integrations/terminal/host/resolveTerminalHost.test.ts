import { describe, expect, it } from 'vitest';

import { resolveTerminalHost } from './resolveTerminalHost';
import type { TerminalHostAdapter, TerminalHostResolverPlatform } from './_types';

function adapter(kind: 'tmux' | 'zellij' | 'herdr' | 'pty'): TerminalHostAdapter {
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
  it('selects an explicitly requested Herdr host when it is available', () => {
    const herdrAdapter = adapter('herdr');
    const result = resolveTerminalHost({
      preference: 'herdr',
      platform: { os: 'linux', arch: 'arm64' },
      adapters: { herdr: herdrAdapter },
      tmuxAvailable: false,
      zellijAvailable: false,
    });
    expect(result).toMatchObject({ status: 'resolved', adapter: herdrAdapter, reason: 'herdr_forced' });
  });

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
      adapters: { pty: adapter('pty'), zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'pty' },
      reason: 'windows_console_available',
    });
  });

  it('uses the Windows console host on Windows arm64 auto when available', () => {
    const result = resolveTerminalHost({
      preference: 'auto',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { pty: adapter('pty'), zellij: adapter('zellij') },
      tmuxAvailable: false,
      zellijAvailable: true,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'pty' },
      reason: 'windows_console_available',
    });
  });

  it('uses the forced Windows console host on Windows arm64 when available', () => {
    const result = resolveTerminalHost({
      preference: 'windows_console',
      platform: { os: 'win32', arch: 'arm64' },
      adapters: { pty: adapter('pty') },
      tmuxAvailable: false,
      zellijAvailable: false,
    });

    expect(result).toMatchObject({
      status: 'resolved',
      adapter: { kind: 'pty' },
      reason: 'windows_console_forced',
    });
  });

  it('uses the bundled zellij on native Windows x64 and refuses only the architecture with no binary', () => {
    // A Windows x64 `zellij.exe` ships in the bundled tool archive, so nothing
    // but the missing ARM64 build stops the zellij host on native Windows.
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

    expect(windowsX64).toMatchObject({ status: 'resolved', adapter: { kind: 'zellij' }, reason: 'tmux_unavailable' });
    expect(windowsArm64).toMatchObject({ status: 'disabled', reason: 'windows_arm64_unsupported' });
    expect(forcedWindowsZellij).toMatchObject({ status: 'resolved', adapter: { kind: 'zellij' }, reason: 'zellij_forced' });
  });

  it('reports zellij as unavailable on native Windows x64 when the bundled binary is missing', () => {
    // tmux never exists on native Windows, so there is nothing to fall back to
    // and the refusal must name the missing binary, not the platform.
    expect(
      resolveTerminalHost({
        preference: 'zellij',
        platform: { os: 'win32', arch: 'x64' },
        adapters: {},
        tmuxAvailable: false,
        zellijAvailable: false,
      }),
    ).toMatchObject({ status: 'disabled', reason: 'zellij_unavailable' });
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
