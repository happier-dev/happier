import {
  CONNECTED_ACCOUNT_DESCRIPTORS,
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
  /** Short brand-only name for compact surfaces; fall back to the localized display name when absent. */
  shortName?: string;
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

const CONNECTED_SERVICE_FALLBACK_REGISTRY: readonly ConnectedServiceRegistryEntry[] = Object.freeze([
  {
    serviceId: 'bitbucket',
    connectCommand: 'happier connect bitbucket --token',
    displayNameKey: 'connectedServices.serviceNames.bitbucket',
    supportsOauth: false,
    oauthAddActionModes: [],
    supportsToken: true,
    tokenKind: 'api-token',
    tokenSetupUrl: 'https://bitbucket.org/account/settings/app-passwords/',
    tokenPromptLabelKey: 'connectedServices.tokenPrompts.bitbucketApiToken',
    tokenMissingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingApiToken',
    tokenIdentityPromptLabelKey: 'connectedServices.tokenPrompts.bitbucketEmailOrUsername',
    tokenIdentityMissingValueErrorKey: 'connectedServices.tokenPrompts.errors.missingBitbucketEmailOrUsername',
  },
]);

export const CONNECTED_SERVICES_REGISTRY: readonly ConnectedServiceRegistryEntry[] = Object.freeze(
  [
    ...CONNECTED_ACCOUNT_DESCRIPTORS.map((descriptor) => ({
      serviceId: descriptor.id,
      connectCommand: descriptor.ui.connectCommand,
      displayNameKey: descriptor.displayKey as ConnectedServiceDisplayNameKey,
      shortName: descriptor.ui.shortName,
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
    ...CONNECTED_SERVICE_FALLBACK_REGISTRY.filter((fallback) =>
      !CONNECTED_ACCOUNT_DESCRIPTORS.some((descriptor) => descriptor.id === fallback.serviceId),
    ),
  ],
);

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
