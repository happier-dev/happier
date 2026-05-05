import type { TerminalRemoteSessionMode } from '../runTerminalRemoteSessionModeLoop';

export type RemoteOnlyTerminalDisplayLineParams = Readonly<{
  backendDisplayName: string;
  requestedMode: TerminalRemoteSessionMode;
}>;

function normalizeBackendDisplayName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'this backend';
}

export function buildRemoteOnlyTerminalTitle(params: Pick<RemoteOnlyTerminalDisplayLineParams, 'backendDisplayName'>): string {
  return `${normalizeBackendDisplayName(params.backendDisplayName)} remote session`;
}

export function buildRemoteOnlyTerminalFooterLines(params: RemoteOnlyTerminalDisplayLineParams): string[] {
  const backendName = normalizeBackendDisplayName(params.backendDisplayName);
  const lines = [
    'Remote-only session: interactive terminal mode is not available for this backend.',
    'Logs only: this terminal cannot send prompts.',
    `Use the Happier app/web to continue the ${backendName} session.`,
    'Press Ctrl-C twice to exit this session.',
  ];

  if (params.requestedMode !== 'terminal') {
    return lines;
  }

  return [
    'Terminal mode was requested, but this backend only supports remote mode.',
    ...lines,
  ];
}
