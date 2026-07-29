export type PluginInstallationReviewHostAccess = Readonly<{
  id: string;
  capability: string;
  reason: string;
  authorizationClass: 'cooperativeDisclosure' | 'hostResourceSelection' | 'presentIntentOrOs';
  normalizedScope: Readonly<Record<string, unknown>>;
}>;

export type PluginInstallationReviewFacts = Readonly<{
  pluginId: string;
  displayName: string;
  version: string;
  packageIdentity: Readonly<{ name: string | null; version: string }>;
  publisherIdentity:
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'unverified'; id: string; displayName: string }>;
  source: Readonly<{
    kind: 'path' | 'archive' | 'npm';
    locator: string;
    integrity?: string;
  }>;
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
  integrity: Readonly<{
    packageDigest: string;
    manifestDigest: string;
    uiArtifactDigest: string;
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
  uiArtifacts: Readonly<{
    status: 'verified' | 'none' | 'unavailable';
    contributionIds: readonly string[];
  }>;
  requiredHostAccess: readonly PluginInstallationReviewHostAccess[];
  optionalHostAccess: readonly (PluginInstallationReviewHostAccess & Readonly<{
    authorizationClass: 'hostResourceSelection';
  }>)[];
  compatibility: Readonly<{ happier: string; runtimeApiVersion: 1 }>;
  updatePolicy: 'automatic' | 'manual' | 'pinned';
}>;

export declare function readPluginInstallReviewRequiredEnvelope(envelope: unknown): Readonly<{
  pendingChangeId: string;
  review: PluginInstallationReviewFacts;
}>;
