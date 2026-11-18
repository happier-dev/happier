import type { ResolveTerminalHostParams, TerminalHostResolution } from './_types';

/**
 * Windows ARM64 is the one platform the bundled tool archive has no zellij
 * build for (`scripts/unpack-tools.cjs` ships `x64-win32` only), so both the
 * forced and the automatic path refuse it with the same fact.
 */
const WINDOWS_ARM64_UNSUPPORTED: TerminalHostResolution = {
  status: 'disabled',
  reason: 'windows_arm64_unsupported',
  message: 'Bundled zellij has no supported Windows ARM64 binary; use WSL2 or a non-terminal runtime.',
};

export function resolveTerminalHost(params: ResolveTerminalHostParams): TerminalHostResolution {
  const { adapters, platform, preference } = params;

  if (preference === 'herdr') {
    if (platform.os === 'win32') {
      return {
        status: 'disabled',
        reason: 'herdr_attach_unsupported_on_windows',
        message: 'Herdr direct terminal attach is unavailable on native Windows; use WSL2.',
      };
    }
    if (!adapters.herdr) {
      return {
        status: 'disabled',
        reason: 'herdr_unavailable',
        message: 'A supported Herdr installation is required.',
      };
    }
    return { status: 'resolved', adapter: adapters.herdr, reason: 'herdr_forced' };
  }

  if (preference === 'tmux') {
    if (platform.os === 'win32') {
      return {
        status: 'disabled',
        reason: 'tmux_unsupported_on_windows',
        message: 'tmux is not supported on native Windows; use auto, zellij, or WSL2.',
      };
    }
    if (!params.tmuxAvailable || !adapters.tmux) {
      return {
        status: 'disabled',
        reason: 'tmux_unavailable',
        message: 'tmux is required for the selected terminal host.',
      };
    }
    return { status: 'resolved', adapter: adapters.tmux, reason: 'tmux_forced' };
  }

  if (preference === 'zellij') {
    // Windows x64 ships a real `zellij.exe`, so it falls through to the normal
    // availability check below; only ARM64 has nothing to run.
    if (platform.os === 'win32' && platform.arch === 'arm64') {
      return WINDOWS_ARM64_UNSUPPORTED;
    }
    if (!params.zellijAvailable || !adapters.zellij) {
      if (params.tmuxAvailable && adapters.tmux) {
        return { status: 'resolved', adapter: adapters.tmux, reason: 'zellij_unavailable_tmux_fallback' };
      }
      return {
        status: 'disabled',
        reason: 'zellij_unavailable',
        message: 'zellij is required for the selected terminal host.',
      };
    }
    return { status: 'resolved', adapter: adapters.zellij, reason: 'zellij_forced' };
  }

  if (preference === 'windows_console') {
    if (!adapters.pty) {
      return {
        status: 'disabled',
        reason: 'windows_console_unavailable',
        message: 'Windows console terminal host is unavailable.',
      };
    }
    return { status: 'resolved', adapter: adapters.pty, reason: 'windows_console_forced' };
  }

  if (platform.os === 'win32') {
    if (adapters.pty) {
      return { status: 'resolved', adapter: adapters.pty, reason: 'windows_console_available' };
    }
    // No console host: ARM64 has no bundled zellij build either, so there is
    // nothing left to try. x64 falls through to the shared zellij tail below
    // (tmux never exists on native Windows).
    if (platform.arch === 'arm64') {
      return WINDOWS_ARM64_UNSUPPORTED;
    }
  }

  if (params.tmuxAvailable && adapters.tmux) {
    return { status: 'resolved', adapter: adapters.tmux, reason: 'tmux_available' };
  }

  if (params.zellijAvailable && adapters.zellij) {
    return { status: 'resolved', adapter: adapters.zellij, reason: 'tmux_unavailable' };
  }

  return {
    status: 'disabled',
    reason: 'no_host_available',
    message: 'No supported terminal host is available.',
  };
}
