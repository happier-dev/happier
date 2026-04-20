import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceDisplayNameKey =
  | 'connectedServices.serviceNames.claudeSubscription'
  | 'connectedServices.serviceNames.openaiCodex'
  | 'connectedServices.serviceNames.openai'
  | 'connectedServices.serviceNames.anthropic'
  | 'connectedServices.serviceNames.gemini'
  | 'connectedServices.fallbackName';

export type ConnectedServiceOauthPasteCopyKeyPrefix =
  | 'connectedServices.oauthPaste'
  | 'connectedServices.oauthPaste.providerOverrides.claudeSubscription';

export type ConnectedServiceRegistryEntry = Readonly<{
  serviceId: ConnectedServiceId;
  connectCommand: string;
  displayNameKey?: ConnectedServiceDisplayNameKey;
  oauthPasteCopyKeyPrefix?: ConnectedServiceOauthPasteCopyKeyPrefix;
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
    connectCommand: 'happier connect claude',
    displayNameKey: 'connectedServices.serviceNames.claudeSubscription',
    oauthPasteCopyKeyPrefix: 'connectedServices.oauthPaste.providerOverrides.claudeSubscription',
    supportsOauth: true,
    oauthAddActionModes: ['paste', 'browser'],
    supportsToken: true,
    tokenKind: 'setup-token',
  },
  {
    serviceId: 'openai-codex',
    connectCommand: 'happier connect codex',
    displayNameKey: 'connectedServices.serviceNames.openaiCodex',
    supportsOauth: true,
    oauthAddActionModes: ['device', 'paste', 'browser'],
  },
  {
    serviceId: 'openai',
    connectCommand: 'happier connect codex --api-key',
    displayNameKey: 'connectedServices.serviceNames.openai',
    supportsOauth: false,
    supportsToken: true,
    tokenKind: 'api-key',
  },
  {
    serviceId: 'anthropic',
    connectCommand: 'happier connect claude --api-key',
    displayNameKey: 'connectedServices.serviceNames.anthropic',
    supportsOauth: false,
    supportsToken: true,
    tokenKind: 'api-key',
  },
  {
    serviceId: 'gemini',
    connectCommand: 'happier connect gemini',
    displayNameKey: 'connectedServices.serviceNames.gemini',
    supportsOauth: true,
    oauthAddActionModes: ['paste', 'browser'],
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
