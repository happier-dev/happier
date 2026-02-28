import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceRegistryEntry = Readonly<{
  serviceId: ConnectedServiceId;
  displayName: string;
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
  tokenKind?: 'api-key' | 'setup-token';
}>;

export const CONNECTED_SERVICES_REGISTRY: readonly ConnectedServiceRegistryEntry[] = Object.freeze([
  {
    serviceId: 'claude-subscription',
    displayName: 'Claude subscription',
    connectCommand: 'happier connect claude',
    supportsOauth: true,
    oauthAddActionModes: ['paste'],
    supportsToken: true,
    tokenKind: 'setup-token',
  },
  {
    serviceId: 'openai-codex',
    displayName: 'OpenAI Codex',
    connectCommand: 'happier connect codex',
    supportsOauth: true,
    oauthAddActionModes: ['device', 'paste'],
  },
  {
    serviceId: 'anthropic',
    displayName: 'Anthropic API key',
    connectCommand: 'happier connect claude --api-key',
    supportsOauth: false,
    supportsToken: true,
    tokenKind: 'api-key',
  },
  {
    serviceId: 'gemini',
    displayName: 'Google Gemini',
    connectCommand: 'happier connect gemini',
    supportsOauth: true,
    oauthAddActionModes: ['paste'],
  },
]);

export function getConnectedServiceRegistryEntry(serviceId: ConnectedServiceId): ConnectedServiceRegistryEntry {
  const entry = CONNECTED_SERVICES_REGISTRY.find((s) => s.serviceId === serviceId);
  if (entry) return entry;
  return {
    serviceId,
    displayName: serviceId,
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: false,
    oauthAddActionModes: [],
    supportsToken: false,
  };
}
