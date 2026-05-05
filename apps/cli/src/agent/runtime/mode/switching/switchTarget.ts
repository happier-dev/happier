export type TerminalRemoteSwitchTarget = 'local' | 'remote';

export function resolveTerminalRemoteSwitchRequestTarget(params: unknown): TerminalRemoteSwitchTarget | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const to = (params as { to?: unknown }).to;
  if (to === 'local' || to === 'remote') return to;
  return undefined;
}
