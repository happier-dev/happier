export type PluginInstallationReviewHostAccess = Readonly<{
  id: string;
  capability: string;
  reason: string;
  authorizationClass: 'cooperativeDisclosure' | 'hostResourceSelection' | 'presentIntentOrOs';
  normalizedScope: Readonly<Record<string, unknown>>;
}>;

export type PluginInstallationReviewRawCredentialAccess = Readonly<{
  accessMode: 'raw';
  contribution: Readonly<{ pluginId: string; localId: string }>;
  credentialSlot: Readonly<{ id: string; title: string; purpose: string }>;
  sourceClass:
    | Readonly<{
        kind: 'savedSecret';
        secretKinds: readonly ('apiKey' | 'token' | 'password' | 'other')[];
      }>
    | Readonly<{
        kind: 'connectedAccount';
        service: Readonly<{ pluginId: string; localId: string }>;
      }>;
  realm: 'web' | 'ios' | 'android' | 'daemon';
  phase: 'settings' | 'prepare' | 'connection' | 'speech';
  request:
    | Readonly<{
        kind: 'httpHeaders';
        origin: string;
        headerNames: readonly string[];
      }>
    | Readonly<{
        kind: 'environment';
        keys: readonly string[];
      }>
    | Readonly<{
        kind: 'files';
        fileIds: readonly string[];
      }>;
}>;

export type PluginInstallationReviewRequestInterceptor = Readonly<{
  id: string;
  origins: readonly string[];
  methods?: readonly ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS')[];
  priority: number;
}>;

export type PluginInstallationReviewFacts = Readonly<{
  pluginId: string;
  displayName: string;
  version: string;
  packageIdentity: Readonly<{ name: string | null; version: string }>;
  publisherIdentity:
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'unverified'; id: string; displayName: string }>;
  source:
    | Readonly<{ kind: 'path'; locator: string }>
    | Readonly<{ kind: 'archive' | 'npm'; locator: string; integrity?: string }>;
  updateChannel:
    | Readonly<{ kind: 'path'; locator: string; development: boolean }>
    | Readonly<{ kind: 'archive'; locator: string }>
    | Readonly<{
        kind: 'npm';
        packageName: string;
        registryOrigin: string;
        registryProfileId?: string;
        marketplaceSource?: Readonly<{
          id: string;
          kind: 'curated' | 'community-npm';
          sourceUrl: string;
        }>;
      }>;
  signature:
    | Readonly<{ status: 'notProvided' }>
    | Readonly<{ status: 'verified' | 'unsupported'; keyId: string }>;
  provenance:
    | Readonly<{ status: 'notProvided' }>
    | Readonly<{ status: 'declaredUnverified'; predicateType: string }>
    | Readonly<{ status: 'retrievedUnverified'; predicateTypes: readonly string[] }>
    | Readonly<{ status: 'unavailable'; code: string }>;
  curation:
    | Readonly<{ status: 'notApplicable' }>
    | Readonly<{ status: 'approved'; sourceId: string; reviewedAt: string; reason?: string | null }>
    | Readonly<{ status: 'unreviewed'; sourceId: string }>;
  executableRealms: readonly ('daemon' | 'reactNative')[];
  contributions: readonly Readonly<{ family: string; count: number }>[];
  requestInterceptors: readonly PluginInstallationReviewRequestInterceptor[];
  uiArtifacts: Readonly<{
    status: 'verified' | 'none' | 'unavailable';
    contributionIds: readonly string[];
  }>;
  requiredHostAccess: readonly PluginInstallationReviewHostAccess[];
  optionalHostAccess: readonly (PluginInstallationReviewHostAccess & Readonly<{
    authorizationClass: 'hostResourceSelection';
  }>)[];
  rawCredentialAccess: readonly PluginInstallationReviewRawCredentialAccess[];
  compatibility: Readonly<{
    happier?: string;
    runtimeApiVersion: 1;
    blockedNewerVersions?: readonly Readonly<{
      version: string;
      diagnostics: readonly Readonly<{ code: string; message: string }>[];
    }>[];
  }>;
  updatePolicy: 'automatic' | 'manual' | 'pinned';
}>;

export declare function readPluginInstallReviewRequiredEnvelope(envelope: unknown): Readonly<{
  pendingChangeId: string;
  review: PluginInstallationReviewFacts;
}>;
