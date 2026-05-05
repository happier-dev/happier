import type { TerminalRemoteSessionMode } from './runTerminalRemoteSessionModeLoop';

export type ResolvedStartingMode =
  | Readonly<{ kind: 'switching'; startingMode: TerminalRemoteSessionMode }>
  | Readonly<{ kind: 'remote-only'; requestedMode: TerminalRemoteSessionMode }>;

export type ResolveStartingModeParams = Readonly<{
  terminalCapable: boolean;
  userIntent?: unknown;
  providerHint?: unknown;
}>;

export function normalizeStartingMode(value: unknown): TerminalRemoteSessionMode | null {
  if (value === 'remote') return 'remote';
  if (value === 'terminal' || value === 'local') return 'terminal';
  return null;
}

export function resolveStartingMode(params: ResolveStartingModeParams): ResolvedStartingMode {
  const explicitIntent = normalizeStartingMode(params.userIntent);

  if (!params.terminalCapable) {
    return {
      kind: 'remote-only',
      requestedMode: explicitIntent ?? normalizeStartingMode(params.providerHint) ?? 'remote',
    };
  }

  return {
    kind: 'switching',
    startingMode: explicitIntent ?? normalizeStartingMode(params.providerHint) ?? 'terminal',
  };
}
