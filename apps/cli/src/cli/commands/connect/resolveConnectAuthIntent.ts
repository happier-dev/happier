import type { ConnectParsedOptions } from './parseConnectArgs';
import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectAuthIntent =
  | Readonly<{ kind: 'oauth'; serviceId: ConnectedServiceId }>
  | Readonly<{ kind: 'token'; serviceId: ConnectedServiceId; tokenKind: 'setup-token' | 'api-key' | 'access-token' }>;

export function resolveConnectAuthIntent(params: Readonly<{
  targetId: string;
  options: ConnectParsedOptions;
}>): ConnectAuthIntent {
  if (params.options.device && params.targetId !== 'codex') {
    throw new Error('--device is only supported for Codex');
  }

  if (params.targetId === 'github') {
    if (params.options.oauth || params.options.apiKey || params.options.setupToken) {
      throw new Error('GitHub supports token credentials in this build. Use --token.');
    }
    return { kind: 'token', serviceId: 'github', tokenKind: 'access-token' };
  }

  if (params.options.token) {
    throw new Error('--token is only supported for GitHub in this build.');
  }

  if (params.targetId === 'codex') {
    if (params.options.setupToken) {
      throw new Error('--setup-token is only supported for Claude.');
    }
    if (params.options.oauth && params.options.apiKey) {
      throw new Error('Use only one of: --oauth, --api-key');
    }
    if (params.options.apiKey) {
      return { kind: 'token', serviceId: 'openai', tokenKind: 'api-key' };
    }
    return { kind: 'oauth', serviceId: 'openai-codex' };
  }

  if (params.targetId === 'gemini') {
    if (params.options.setupToken || params.options.apiKey) {
      throw new Error('--setup-token/--api-key is not supported for Gemini. Use the provider OAuth flow instead.');
    }
    return { kind: 'oauth', serviceId: 'gemini' };
  }

  if (params.targetId !== 'claude') {
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
