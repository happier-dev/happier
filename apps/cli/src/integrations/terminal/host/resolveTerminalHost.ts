import type { ResolveTerminalHostParams, TerminalHostResolution } from './_types';

export function resolveTerminalHost(params: ResolveTerminalHostParams): TerminalHostResolution {
  const { adapters, platform, preference } = params;

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
    if (platform.os === 'win32') {
      if (platform.arch === 'arm64') {
        return {
          status: 'disabled',
          reason: 'windows_arm64_unsupported',
          message: 'Bundled zellij has no supported Windows ARM64 binary; use WSL2 or a non-terminal runtime.',
        };
      }
      return {
        status: 'disabled',
        reason: 'windows_zellij_unvalidated',
        message: 'Native Windows zellij background TUI hosting is not enabled until validated; use WSL2 or a non-terminal runtime.',
      };
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
    if (!adapters.windows_console) {
      return {
        status: 'disabled',
        reason: 'windows_console_unavailable',
        message: 'Windows console terminal host is unavailable.',
      };
    }
    return { status: 'resolved', adapter: adapters.windows_console, reason: 'windows_console_forced' };
  }

  if (platform.os === 'win32') {
    if (adapters.windows_console) {
      return { status: 'resolved', adapter: adapters.windows_console, reason: 'windows_console_available' };
    }
    if (platform.arch === 'arm64') {
      return {
        status: 'disabled',
        reason: 'windows_arm64_unsupported',
        message: 'Bundled zellij has no supported Windows ARM64 binary; use WSL2 or a non-terminal runtime.',
      };
    }
    return {
      status: 'disabled',
      reason: 'windows_zellij_unvalidated',
      message: 'Native Windows zellij background TUI hosting is not enabled until validated; use WSL2 or a non-terminal runtime.',
    };
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
