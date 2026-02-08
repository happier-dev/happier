export type WindowsRemoteSessionConsoleMode = 'hidden' | 'visible';

export function resolveWindowsRemoteSessionConsoleMode(params: {
  platform: string;
  requested?: WindowsRemoteSessionConsoleMode | null | undefined;
  env: NodeJS.ProcessEnv;
}): WindowsRemoteSessionConsoleMode {
  if (params.platform !== 'win32') return 'hidden';

  if (params.requested === 'hidden' || params.requested === 'visible') {
    return params.requested;
  }

  const raw = params.env.HAPPIER_WINDOWS_REMOTE_SESSION_CONSOLE;
  if (raw === 'visible') return 'visible';
  return 'hidden';
}

