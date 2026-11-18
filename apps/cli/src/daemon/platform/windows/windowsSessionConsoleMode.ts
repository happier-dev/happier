export type WindowsRemoteSessionLaunchMode = 'hidden' | 'windows_terminal' | 'console';

function normalizeWindowsRemoteSessionLaunchMode(value: unknown): WindowsRemoteSessionLaunchMode | null {
  if (value === 'hidden' || value === 'windows_terminal' || value === 'console') return value;
  if (value === 'visible') return 'console';
  return null;
}

export function resolveWindowsRemoteSessionLaunchMode(params: {
  platform: string;
  requested?: WindowsRemoteSessionLaunchMode | 'visible' | null | undefined;
  env: NodeJS.ProcessEnv;
}): WindowsRemoteSessionLaunchMode {
  if (params.platform !== 'win32') return 'hidden';

  const requested = normalizeWindowsRemoteSessionLaunchMode(params.requested);
  if (requested) return requested;

  const envLaunchMode = normalizeWindowsRemoteSessionLaunchMode(params.env.HAPPIER_WINDOWS_REMOTE_SESSION_LAUNCH_MODE);
  if (envLaunchMode) return envLaunchMode;

  const legacyEnvMode = normalizeWindowsRemoteSessionLaunchMode(params.env.HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE);
  if (legacyEnvMode) return legacyEnvMode;

  return 'hidden';
}

export const resolveWindowsRemoteSessionConsoleMode = resolveWindowsRemoteSessionLaunchMode;

/**
 * The terminal host a fresh spawn's presentation is resolved for. A Windows hidden Session (no
 * visible window, no multiplexer request) runs on the PTY terminal host, whose Agent the Session
 * holder keeps in a ConPTY (HOLDER-PTY A2). Visible console and Windows Terminal windows keep
 * their TUI in that window; every explicit request is kept.
 */
export function resolveSpawnTerminalPresentationHost(params: Readonly<{
  requested: 'plain' | 'tmux' | 'zellij' | 'herdr' | null;
  platform: string;
  windowsLaunchMode?: WindowsRemoteSessionLaunchMode | 'visible' | null;
  env: NodeJS.ProcessEnv;
}>): 'plain' | 'tmux' | 'zellij' | 'herdr' | 'windows_console' {
  if (params.requested) return params.requested;
  return resolveWindowsRemoteSessionLaunchMode({ platform: params.platform, requested: params.windowsLaunchMode, env: params.env })
    === 'hidden' && params.platform === 'win32' ? 'windows_console' : 'plain';
}
