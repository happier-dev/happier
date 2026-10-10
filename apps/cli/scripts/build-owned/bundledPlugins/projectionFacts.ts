/** Input facts shared by the single bundled-plugin publisher and its pure renderers. */
export type PluginManifestSerializerModule = typeof import(
  '../../../src/plugins/manifest/serialize.ts'
);

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = Readonly<{ [key: string]: JsonValue }>;

export type BundledPluginManifestJson = Parameters<
  PluginManifestSerializerModule['serializeCanonicalPluginManifest']
>[0] & Readonly<{ id: string }>;

export type PluginManifestJson = BundledPluginManifestJson;

export type BundledPluginPackage = Readonly<{
  pluginPackageId: string;
  pluginId: string;
  packageName: string;
  packageVersion: string;
  manifest: PluginManifestJson;
  agentId?: string;
  agentDefinition?: JsonValue;
  agentNativeHomeEnvironmentKeys?: readonly string[];
  agentUiDescriptor?: AgentUiDescriptor;
  agentPredecessorMessageMetaWriter?: AgentPredecessorMessageMetaWriterImportSource;
  releasedFlatSessionMetadataRuntimeDescriptorReader?: ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor;
  promptAssetContributions?: PromptAssetContributionSource;
  builtInLegacyConnectedAccountCompatibility?:
    readonly BuiltInLegacyConnectedAccountCompatibilitySource[];
}>;

export type BuiltInLegacyConnectedAccountCompatibilitySource = Readonly<{
  legacyServiceId: string;
  serviceLocalId: string;
  peerOperations: BuiltInLegacyConnectedAccountPeerOperations;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
  unsupportedAuthenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
}>;

export const BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS = Object.freeze([
  'account_list',
  'credential_read',
  'credential_write',
  'credential_delete',
  'credential_health',
  'refresh_lease',
  'oauth_refresh',
  'one_shot_materialization',
  'request_auth',
  'quota_read',
  'quota_refresh',
  'quota_poll',
  'recovery_credit_consume',
  'provider_account_usage_write',
] as const);

export type BuiltInLegacyConnectedAccountOperation =
  typeof BUILT_IN_LEGACY_CONNECTED_ACCOUNT_OPERATION_IDS[number];

export type BuiltInLegacyConnectedAccountPeerOperations = Readonly<{
  exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];
  revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];
}>;

export type BuiltInLegacyConnectedAccountCompatibilityProjection = Readonly<{
  legacyServiceId: string;
  service: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  peerOperations: BuiltInLegacyConnectedAccountPeerOperations;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
  unsupportedAuthenticationModeByCredentialKind: Readonly<
    Partial<Record<'oauth' | 'token', string>>
  >;
}>;

export type AgentUiDescriptor = Readonly<{
  kind: 'plugin.ui.v1';
  pluginId: string;
  agentId: string;
  version: number;
  display: Readonly<{
    nameKey: string;
    subtitleKey: string;
    permissionModeI18nPrefix: string;
    availability: Readonly<{ experimental: boolean }>;
    connectedService: Readonly<{
      serviceId: string | null;
      labelKey: string;
      connectRoute: string | null;
    }>;
    flavorAliases: readonly string[];
    permissions: Readonly<{
      modeGroup: string;
      promptProtocol: string;
    }>;
    sessionModes?: Readonly<{
      staticOptions?: readonly AgentUiSessionModeOption[];
    }>;
    runtimeInput?: Readonly<{
      inFlightSteerSupported: boolean;
    }>;
    resume: Readonly<{
      uiVendorResumeIdLabelKey: string | null;
      uiVendorResumeIdCopiedKey: string | null;
    }>;
    localControl?: boolean;
    toolRendering: Readonly<{ hideUnknownToolsByDefault: boolean }>;
    picker: Readonly<{
      iconName: string;
      iconScale?: number;
      cliGlyph: string;
      cliGlyphScale: number;
      profileCompatibilityGlyphScale: number;
    }>;
    avatarOverlay: Readonly<{
      circleScale: number;
      iconScaleRatio: number;
    }>;
    icon?: Readonly<{ assetId: string | null }>;
  }>;
  identityColor?: Readonly<{ light: string; dark: string }>;
  behavior?: JsonObject;
  session?: JsonObject;
  message?: JsonObject;
  components?: JsonObject;
  assets?: JsonObject;
}>;

export type ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerSessionId';
  agentId: string;
  runtimeHandle: 'providerSessionId';
}>;

export type ProviderRuntimeDescriptorReaderContributionDescriptor = Readonly<{
  kind: 'providerRuntimeDescriptorReader';
  agentId: string;
  source?: string;
  exportName?: string;
  generatedReader: JsonObject;
}>;

export type RuntimeDescriptorReaderContributionDescriptor =
  | ProviderSessionIdRuntimeDescriptorReaderContributionDescriptor
  | ProviderRuntimeDescriptorReaderContributionDescriptor;

export type ReleasedFlatSessionMetadataRuntimeDescriptorReaderContributionDescriptor =
  RuntimeDescriptorReaderContributionDescriptor;

export type ExternalSessionSchemaFieldDescriptor = Readonly<{
  name: string;
  kind: 'literal' | 'string' | 'enum' | 'unknown';
  value?: string;
  values?: readonly string[];
  min?: number;
  max?: number;
  optional?: boolean;
  nullish?: boolean;
}>;

export type ExternalSessionSchemaRefinementDescriptor =
  | Readonly<{
    kind: 'requiresWhenEquals';
    field: string;
    when: Readonly<{ field: string; equals: string }>;
  }>
  | Readonly<{
    kind: 'forbidsWhenEquals';
    fields: readonly string[];
    when: Readonly<{ field: string; equals: string }>;
  }>;

export type ExternalSessionKeySegmentDescriptor =
  | Readonly<{ kind: 'literal'; value: string }>
  | Readonly<{ kind: 'field'; field: string }>
  | Readonly<{ kind: 'homeMode'; field: string }>
  | Readonly<{ kind: 'conditionalField'; field: string; when: Readonly<{ field: string; equals: string }> }>
  | Readonly<{
    kind: 'connectedServiceScope';
    groupField: string;
    profileField: string;
    when: Readonly<{ field: string; equals: string }>;
  }>;

export type ExternalSessionInstanceConstantDescriptor = string | number | boolean | null;

export type ExternalSessionInstanceDescriptor =
  | Readonly<{
    kind: 'default';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>
  | Readonly<{
    kind: 'connectedServiceProfiles';
    serviceId: string;
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
    fields: Readonly<{ serviceId: string; profileId: string }>;
  }>
  | Readonly<{
    kind: 'agentSetting';
    settingId: string;
    byServerIdSettingId?: string;
    field: string;
    normalization: 'httpOrigin';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>
  | Readonly<{
    kind: 'agentSettingOverride';
    settingId: string;
    byServerIdSettingId?: string;
    field: string;
    // Whether a configured source REPLACES the paired default is independent of
    // how its raw setting value is normalized, exactly as the protocol
    // declaration schema admits both.
    normalization: 'httpOrigin' | 'configuredPath';
    constants: Readonly<Record<string, ExternalSessionInstanceConstantDescriptor>>;
  }>;

export type ExternalSessionSourceDeclaration = Readonly<{
  agentId: string;
  sourceKind: string;
  schema: Readonly<{
    fields: readonly ExternalSessionSchemaFieldDescriptor[];
    refinements?: readonly ExternalSessionSchemaRefinementDescriptor[];
  }>;
  key: Readonly<{
    segments: readonly ExternalSessionKeySegmentDescriptor[];
  }>;
  instances?: readonly ExternalSessionInstanceDescriptor[];
}>;

export type ProtocolExternalSessionSourceProjectionDescriptor = Readonly<{
  agentId: string;
  declaration: ExternalSessionSourceDeclaration;
}>;

export type AgentUiSessionModeOption = Readonly<{
  id: string;
  nameKey: string;
  descriptionKey?: string;
}>;

export type GeneratedAgentUiProjectionSource = Readonly<{
  agentId: string;
  coreConst: string;
  uiConst: string;
  renderLines: () => readonly string[];
}>;

export type DescriptorAgentUiProjectionSource = Readonly<{
  agentId: string;
  coreConst: string;
  uiConst: string;
  descriptor: AgentUiDescriptor;
  providerOwnedEnvironmentKeys: readonly string[];
  permissionModeMapping?: JsonObject;
  svgIcon?: DescriptorGeneratedSvgIconSource;
}>;

export type DescriptorGeneratedSvgIconPathSource = Readonly<{
  d: string;
  fillToken?: string;
  fillOpacity?: number;
  fillRule?: 'evenodd' | 'nonzero';
  clipRule?: 'evenodd' | 'nonzero';
}>;

export type DescriptorGeneratedSvgIconSource = Readonly<{
  constName: string;
  viewBox: string;
  paths: readonly DescriptorGeneratedSvgIconPathSource[];
}>;

export type AgentUiBehaviorDescriptorSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
  predecessorMessageMetaWriter?: AgentPredecessorMessageMetaWriterImportSource;
}>;

export type AgentPredecessorMessageMetaWriterImportSource = Readonly<{
  importName: string;
  importPath: string;
  defaults: JsonObject;
}>;

export type AgentSessionBehaviorSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;

export type SessionSubagentVisibleMessageResolverSource = Readonly<{
  agentId: string;
  descriptor: JsonObject;
}>;

export type PromptAssetContributionSource = Readonly<{
  pluginPackageId: string;
  descriptors: readonly JsonObject[];
}>;

export type BundledFirstPartyVoiceProjectionSource = Readonly<{
  manifest: PluginManifestJson;
  packageName: string;
  packageVersion: string;
  pluginId: string;
  pluginPackageId: BundledFirstPartyVoicePackageId;
  hasConversationProvider: boolean;
  conversationPlatforms: readonly BundledVoiceRuntimePlatform[];
  conversationClient: Readonly<{
    artifactId: string;
    exportName: string;
  }> | null;
  presentations: readonly JsonObject[];
}>;

export type BundledFirstPartyVoicePackageId = 'codex' | 'elevenlabs' | 'google' | 'openai' | 'openai-compat' | 'xai';

export type BundledVoiceRuntimePlatform = 'web' | 'ios' | 'android';

export type BundledFirstPartyAgentRegistrationIdentity = Readonly<{
  pluginId: string;
  localId: string;
  implementationOwnerId: string;
  registrationFamily: string;
}>;
