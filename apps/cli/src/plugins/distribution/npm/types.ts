import type { PluginCompatibilityProjectionV1 } from '@happier-dev/protocol';

import type { PluginCompatibilityDiagnostic } from '@/plugins/validation/diagnostics/types';

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

/** Metadata-only selection evidence; it is never a persisted candidate ledger. */
export type NpmArtifactCompatibilitySelection = Readonly<{
  automaticEligible: boolean;
  /** Strict generated projection from the selected full-version metadata, if present and valid. */
  projection?: PluginCompatibilityProjectionV1;
  /** Why the selected fallback is ineligible for automatic acquisition. */
  diagnostics: readonly PluginCompatibilityDiagnostic[];
  /** Newer candidate versions rejected before archive acquisition, with owner diagnostics. */
  blockedNewerVersions: readonly Readonly<{
    version: string;
    diagnostics: readonly PluginCompatibilityDiagnostic[];
  }>[];
}>;

export type ResolvedNpmArtifact = Readonly<{
  registryOrigin: string;
  packageName: string;
  version: string;
  /**
   * The exact selected version object from the verified packument. Consumers
   * must validate any package-specific metadata before using it.
   */
  versionMetadata: Readonly<Record<string, unknown>>;
  integrity: string;
  tarballUrl: string;
  signatures: readonly NpmRegistrySignature[];
  provenance?: NpmProvenanceDeclaration;
  compatibility?: NpmArtifactCompatibilitySelection;
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
  /**
   * SHA-256 of the exact tarball stream after the registry SRI verifier has
   * accepted it. This is acquisition evidence, not an extracted-tree digest.
   */
  archiveDigestSha256: `sha256:${string}`;
  registrySignature:
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'verified'; keyid: string }>
    | Readonly<{ status: 'unsupported'; keyid: string }>;
  provenance: NpmProvenanceSignal;
  compatibility?: NpmArtifactCompatibilitySelection;
}>;
