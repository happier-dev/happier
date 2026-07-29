export type NpmArtifactSelector = Readonly<{
  kind: 'exact' | 'range' | 'tag';
  value: string;
}>;

export type NpmRegistryProfile = Readonly<{
  version: 1;
  id: string;
  displayName: string;
  origin: string;
  scopes: readonly string[];
  useAsDefault: boolean;
  credentialSecretRef?: string;
  trustedCaProfileId?: string;
  proxyProfileId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}>;

export type NpmRegistrySelection = Readonly<{ packageName: string; origin: string }> & (
  | Readonly<{ reason: 'curatedExact'; profileId?: string }>
  | Readonly<{ reason: 'explicitProfile' | 'originMapping' | 'scopeMapping' | 'configuredDefault'; profileId: string }>
  | Readonly<{ reason: 'publicDefault'; profileId?: never }>
);

export type NormalizeNpmArtifactRequestInput = Readonly<{
  registryOrigin?: string;
  packageName: string;
  selector?: string;
  profiles?: readonly NpmRegistryProfile[];
  explicitProfileId?: string;
  curatedExactOrigin?: string;
}>;

export type NormalizedNpmArtifactRequest = Readonly<{
  registryOrigin: string;
  packageName: string;
  selector: NpmArtifactSelector;
  selection: NpmRegistrySelection;
  credentialSecretRef?: string;
}>;

export type NpmRegistrySignature = Readonly<{ keyid: string; sig: string }>;

export type ResolvedNpmArtifact = Readonly<{
  registryOrigin: string;
  packageName: string;
  version: string;
  integrity: string;
  tarballUrl: string;
  signatures: readonly NpmRegistrySignature[];
  provenance?: NpmProvenanceDeclaration;
}>;

export type NpmRegistrySigningKey = Readonly<{
  expires: string | null;
  keyid: string;
  keytype: string;
  scheme: string;
  key: string;
}>;

export type NpmProvenanceDeclaration =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'declared'; url: string; predicateType: string }>
  | Readonly<{ status: 'unavailable'; code: 'declaration_invalid' }>;

export type NpmProvenanceSignal =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'declared'; url: string; predicateType: string; verified: false }>
  | Readonly<{ status: 'retrieved'; predicateTypes: readonly string[]; verified: false }>
  | Readonly<{ status: 'unavailable'; code: 'declaration_invalid' | 'attestation_unavailable'; verified: false }>;

export type DownloadedNpmArtifactCandidate = Readonly<{
  source: Readonly<{
    kind: 'npm';
    registryOrigin: string;
    packageName: string;
    version: string;
    integrity: string;
    tarballUrl: string;
  }>;
  artifactPath: string;
  byteLength: number;
  registrySignature:
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'verified'; keyid: string }>
    | Readonly<{ status: 'unsupported'; keyid: string }>;
  provenance: NpmProvenanceSignal;
}>;
