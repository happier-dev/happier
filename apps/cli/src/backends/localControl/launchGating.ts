export type LocalControlStartingMode = 'local' | 'remote';

export type LocalControlSupportDecision<Reason extends string = string> =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: Reason }>;

export type LocalControlLaunchGatingResult<Reason extends string = string> = Readonly<{
  mode: LocalControlStartingMode;
  fallback?: Readonly<{ reason: Reason }>;
}>;

export function applyLocalControlLaunchGating<Reason extends string>(
  opts: Readonly<{
    startingMode: LocalControlStartingMode;
    support: LocalControlSupportDecision<Reason>;
  }>
): LocalControlLaunchGatingResult<Reason> {
  if (opts.startingMode === 'remote') return { mode: 'remote' };
  if (opts.support.ok) return { mode: 'local' };
  return { mode: 'remote', fallback: { reason: opts.support.reason } };
}

