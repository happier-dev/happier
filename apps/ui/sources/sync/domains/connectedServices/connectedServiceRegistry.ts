import type { ConnectedServiceId } from '@happier-dev/protocol';

export type ConnectedServiceRegistryEntry = Readonly<{
  serviceId: ConnectedServiceId;
  displayName: string;
  connectCommand: string;
  supportsOauth: boolean;
  supportsSetupToken?: boolean;
}>;

export const CONNECTED_SERVICES_REGISTRY: readonly ConnectedServiceRegistryEntry[] = Object.freeze([
  {
    serviceId: 'openai-codex',
    displayName: 'OpenAI Codex',
    connectCommand: 'happier connect codex',
    supportsOauth: true,
  },
  {
    serviceId: 'anthropic',
    displayName: 'Anthropic Claude',
    connectCommand: 'happier connect claude',
    supportsOauth: true,
    supportsSetupToken: true,
  },
  {
    serviceId: 'gemini',
    displayName: 'Google Gemini',
    connectCommand: 'happier connect gemini',
    supportsOauth: true,
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
  };
}

