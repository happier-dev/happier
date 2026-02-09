export type LocalRemoteSwitchTarget = 'local' | 'remote';

export function resolveSwitchRequestTarget(params: unknown): LocalRemoteSwitchTarget | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const to = (params as { to?: unknown }).to;
  if (to === 'local' || to === 'remote') return to;
  return undefined;
}
