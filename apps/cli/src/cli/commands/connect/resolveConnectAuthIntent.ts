import type { ConnectParsedOptions } from './parseConnectArgs';

export type ConnectAuthIntent =
  | Readonly<{ kind: 'backend' }>
  | Readonly<{ kind: 'oauth' }>
  | Readonly<{ kind: 'setup-token' }>;

export function resolveConnectAuthIntent(params: Readonly<{
  targetId: string;
  options: ConnectParsedOptions;
}>): ConnectAuthIntent {
  if (params.targetId !== 'claude') {
    if (params.options.setupToken) {
      throw new Error('--setup-token is only supported for claude');
    }
    if (params.options.oauth) {
      throw new Error('--oauth is only supported for claude');
    }
    return { kind: 'backend' };
  }

  if (params.options.setupToken && params.options.oauth) {
    throw new Error('Cannot use both --setup-token and --oauth');
  }

  if (params.options.oauth) return { kind: 'oauth' };
  return { kind: 'setup-token' };
}
