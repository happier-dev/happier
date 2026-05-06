import {
  requireConnectedAccountDescriptor,
  type ConnectedAccountDescriptor,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

type EnvLike = Readonly<Record<string, string | undefined>>;

export type ResolvedConnectedAccountOauthConfig = Readonly<{
  descriptor: ConnectedAccountDescriptor;
  clientId: string;
  tokenUrl: string;
  refreshBody: 'form' | 'json';
  confidentialClientValue: string | null;
}>;

function resolveNonEmptyEnv(raw: string | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return trimmed ? trimmed : fallback;
}

export function resolveConnectedAccountOauthConfig(params: Readonly<{
  serviceId: ConnectedServiceId;
  env: EnvLike;
  resolveConfidentialClientValue?: (resolverKey: string, envKey: string, env: EnvLike) => string;
}>): ResolvedConnectedAccountOauthConfig {
  const descriptor = requireConnectedAccountDescriptor(params.serviceId);
  if (!descriptor.oauth) {
    throw new Error(`Connected account does not support OAuth refresh: ${params.serviceId}`);
  }

  const confidentialClient = descriptor.oauth.confidentialClient
    ? params.resolveConfidentialClientValue?.(
        descriptor.oauth.confidentialClient.hostDefaultResolverKey,
        descriptor.oauth.confidentialClient.envKey,
        params.env,
      ) ?? null
    : null;

  return {
    descriptor,
    clientId: resolveNonEmptyEnv(
      params.env[descriptor.oauth.publicClientId.envKey],
      descriptor.oauth.publicClientId.defaultValue,
    ),
    tokenUrl: resolveNonEmptyEnv(params.env[descriptor.oauth.tokenUrl.envKey], descriptor.oauth.tokenUrl.defaultValue),
    refreshBody: descriptor.oauth.refresh.body,
    confidentialClientValue: confidentialClient,
  };
}
