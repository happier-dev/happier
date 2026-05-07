import type { ConnectedServiceId } from '@happier-dev/protocol';

import { buildGithubPersonalAccessTokenUrl } from './github/buildGithubPersonalAccessTokenUrl';

export type ConnectedServiceRegistryEntry = Readonly<{
  serviceId: ConnectedServiceId;
  connectCommand: string;
  supportsOauth: boolean;
  /**
   * Optional list of OAuth "add profile" surface modes this service wants to expose
   * explicitly in the service detail Actions group.
   *
   * When omitted or length <= 1, the UI uses the generic "Add OAuth profile" action.
   */
  oauthAddActionModes?: ReadonlyArray<'device' | 'paste' | 'browser'>;
  supportsToken?: boolean;
  tokenKind?: 'access-token' | 'api-key' | 'setup-token';
  tokenSetupUrl?: string;
}>;

export const CONNECTED_SERVICES_REGISTRY: readonly ConnectedServiceRegistryEntry[] = Object.freeze([
  {
    serviceId: 'claude-subscription',
    connectCommand: 'happier connect claude',
    supportsOauth: true,
    oauthAddActionModes: ['paste', 'browser'],
    supportsToken: true,
    tokenKind: 'setup-token',
  },
  {
    serviceId: 'openai-codex',
    connectCommand: 'happier connect codex',
    supportsOauth: true,
    oauthAddActionModes: ['device', 'paste', 'browser'],
  },
  {
    serviceId: 'openai',
    connectCommand: 'happier connect codex --api-key',
    supportsOauth: false,
    supportsToken: true,
    tokenKind: 'api-key',
  },
  {
    serviceId: 'anthropic',
    connectCommand: 'happier connect claude --api-key',
    supportsOauth: false,
    supportsToken: true,
    tokenKind: 'api-key',
  },
  {
    serviceId: 'gemini',
    connectCommand: 'happier connect gemini',
    supportsOauth: true,
    oauthAddActionModes: ['paste', 'browser'],
  },
  {
    serviceId: 'github',
    connectCommand: 'happier connect github --token',
    supportsOauth: false,
    supportsToken: true,
    tokenKind: 'access-token',
    tokenSetupUrl: buildGithubPersonalAccessTokenUrl(),
  },
]);

export function getConnectedServiceRegistryEntry(serviceId: ConnectedServiceId): ConnectedServiceRegistryEntry {
  const entry = CONNECTED_SERVICES_REGISTRY.find((s) => s.serviceId === serviceId);
  if (entry) return entry;
  return {
    serviceId,
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: false,
    oauthAddActionModes: [],
    supportsToken: false,
  };
}
