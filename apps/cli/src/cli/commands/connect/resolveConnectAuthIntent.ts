import type { ConnectParsedOptions } from './parseConnectArgs';
import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectAuthIntent =
  | Readonly<{ kind: 'oauth'; serviceId: ConnectedServiceId }>
  | Readonly<{ kind: 'token'; serviceId: ConnectedServiceId; tokenKind: 'setup-token' | 'api-key' }>;

export function resolveConnectAuthIntent(params: Readonly<{
  targetId: string;
  options: ConnectParsedOptions;
}>): ConnectAuthIntent {
  if (params.options.device && params.targetId !== 'codex') {
    throw new Error('--device is only supported for Codex');
  }

  if (params.targetId !== 'claude') {
    if (params.options.setupToken || params.options.apiKey) {
      throw new Error('--setup-token/--api-key is only supported for Claude. Use the provider OAuth flow instead.');
    }
    if (params.targetId === 'codex') return { kind: 'oauth', serviceId: 'openai-codex' };
    if (params.targetId === 'gemini') return { kind: 'oauth', serviceId: 'gemini' };
    throw new Error(`Unsupported connect target: ${params.targetId}`);
  }

  const requestedModes = [
    params.options.oauth ? 'oauth' : null,
    params.options.setupToken ? 'setup-token' : null,
    params.options.apiKey ? 'api-key' : null,
  ].filter(Boolean);
  if (requestedModes.length > 1) {
    throw new Error('Use only one of: --oauth, --setup-token, --api-key');
  }

  if (params.options.oauth) {
    return { kind: 'oauth', serviceId: 'claude-subscription' };
  }

  if (params.options.apiKey) {
    return { kind: 'token', serviceId: 'anthropic', tokenKind: 'api-key' };
  }

  return { kind: 'token', serviceId: 'claude-subscription', tokenKind: 'setup-token' };
}
