import type { ConnectedServiceId } from '@happier-dev/protocol';

import { resolveConnectedAccountOauthConfig } from '../descriptors/connectedAccountOauthConfig';

function resolveOauthConfigValue(serviceId: ConnectedServiceId, env: NodeJS.ProcessEnv): Readonly<{
  clientId: string;
  tokenUrl: string;
}> {
  return resolveConnectedAccountOauthConfig({
    serviceId,
    env,
    resolveConfidentialClientValue: resolveHostConfidentialClientValue,
  });
}

function resolveHostConfidentialClientValue(
  resolverKey: string,
  envKey: string,
  env: NodeJS.ProcessEnv,
): string {
  const raw = env[envKey];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  throw new Error(`Unsupported connected-service confidential OAuth resolver: ${resolverKey}`);
}

export function resolveOpenAiCodexOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveOauthConfigValue('openai-codex', env).clientId;
}

export function resolveOpenAiCodexOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveOauthConfigValue('openai-codex', env).tokenUrl;
}

export function resolveClaudeSubscriptionOauthClientId(env: NodeJS.ProcessEnv): string {
  return resolveOauthConfigValue('claude-subscription', env).clientId;
}

export function resolveClaudeSubscriptionOauthTokenUrl(env: NodeJS.ProcessEnv): string {
  return resolveOauthConfigValue('claude-subscription', env).tokenUrl;
}
