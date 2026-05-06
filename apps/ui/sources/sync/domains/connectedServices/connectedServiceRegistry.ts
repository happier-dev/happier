import {
  CONNECTED_ACCOUNT_DESCRIPTORS,
  getConnectedAccountDescriptor,
  type ConnectedAccountOauthAddActionMode,
  type ConnectedAccountTokenKind,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceDisplayNameKey =
  | 'connectedServices.serviceNames.claudeSubscription'
  | 'connectedServices.serviceNames.openaiCodex'
  | 'connectedServices.serviceNames.openai'
  | 'connectedServices.serviceNames.anthropic'
  | 'connectedServices.serviceNames.gemini'
  | 'connectedServices.serviceNames.github'
  | 'connectedServices.serviceNames.bitbucket'
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
  oauthAddActionModes?: ReadonlyArray<ConnectedAccountOauthAddActionMode>;
  supportsToken?: boolean;
  tokenKind?: ConnectedAccountTokenKind;
  tokenSetupUrl?: string;
  tokenPromptLabelKey?: string;
  tokenMissingValueErrorKey?: string;
  tokenIdentityPromptLabelKey?: string;
  tokenIdentityMissingValueErrorKey?: string;
}>;

export const CONNECTED_SERVICES_REGISTRY: readonly ConnectedServiceRegistryEntry[] = Object.freeze(
  CONNECTED_ACCOUNT_DESCRIPTORS.map((descriptor) => ({
    serviceId: descriptor.id,
    connectCommand: descriptor.ui.connectCommand,
    displayNameKey: descriptor.displayKey as ConnectedServiceDisplayNameKey,
    oauthPasteCopyKeyPrefix: descriptor.ui.oauthPasteCopyKeyPrefix as ConnectedServiceOauthPasteCopyKeyPrefix | undefined,
    supportsOauth: descriptor.credentialKinds.includes('oauth'),
    oauthAddActionModes: descriptor.ui.oauthAddActionModes,
    supportsToken: descriptor.credentialKinds.includes('token'),
    tokenKind: descriptor.tokenSetup?.tokenKind,
    tokenSetupUrl: descriptor.tokenSetup?.setupUrl,
    tokenPromptLabelKey: descriptor.tokenSetup?.promptLabelKey,
    tokenMissingValueErrorKey: descriptor.tokenSetup?.missingValueErrorKey,
    tokenIdentityPromptLabelKey: descriptor.tokenSetup?.identity?.promptLabelKey,
    tokenIdentityMissingValueErrorKey: descriptor.tokenSetup?.identity?.missingValueErrorKey,
  })),
);

export function getConnectedServiceRegistryEntry(serviceId: ConnectedServiceId): ConnectedServiceRegistryEntry {
  const descriptor = getConnectedAccountDescriptor(serviceId);
  const entry = descriptor ? CONNECTED_SERVICES_REGISTRY.find((s) => s.serviceId === descriptor.id) : null;
  if (entry) return entry;
  return {
    serviceId,
    connectCommand: `happier connect ${serviceId}`,
    supportsOauth: false,
    oauthAddActionModes: [],
    supportsToken: false,
  };
}
