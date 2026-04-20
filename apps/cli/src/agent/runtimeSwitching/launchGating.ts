export type TerminalRemoteStartingMode = 'local' | 'remote';

export type TerminalRemoteSupportDecision<Reason extends string = string> =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: Reason }>;

export type TerminalRemoteLaunchGatingResult<Reason extends string = string> = Readonly<{
  mode: TerminalRemoteStartingMode;
  fallback?: Readonly<{ reason: Reason }>;
}>;

export function applyTerminalRemoteLaunchGating<Reason extends string>(
  opts: Readonly<{
    startingMode: TerminalRemoteStartingMode;
    support: TerminalRemoteSupportDecision<Reason>;
  }>
): TerminalRemoteLaunchGatingResult<Reason> {
  if (opts.startingMode === 'remote') return { mode: 'remote' };
  if (opts.support.ok) return { mode: 'local' };
  return { mode: 'remote', fallback: { reason: opts.support.reason } };
}
