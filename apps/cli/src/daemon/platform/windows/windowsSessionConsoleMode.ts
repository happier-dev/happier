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
