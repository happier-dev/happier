import {
  PLUGIN_CONTRIBUTION_CATALOG_V2,
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2,
  type PluginHostAccessRequestV2,
} from '@happier-dev/protocol';

import type { NpmArtifactCompatibilitySelection } from '@/plugins/distribution/npm/types';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';

import {
  MAX_PLUGIN_INSTALLATION_REVIEW_STRING_LENGTH,
  projectPluginInstallationReviewRequestInterceptor,
  type PluginInstallationReview,
} from './changeContract';

type ReviewPublisherIdentity = PluginInstallationReview['publisherIdentity'];
type ReviewSignature = PluginInstallationReview['signature'];
type ReviewProvenance = PluginInstallationReview['provenance'];
type ReviewCuration = PluginInstallationReview['curation'];
type ReviewBlockedNewerVersions = NonNullable<
  PluginInstallationReview['compatibility']['blockedNewerVersions']
>;
type ReviewRawCredentialAccess = PluginInstallationReview['rawCredentialAccess'];

export type PluginInstallationReviewSourceFacts =
  | Readonly<{
      kind: 'path';
      locator: string;
      development: boolean;
      packageName: null;
      publisher: Readonly<{ status: 'unavailable' }>;
      signature: Readonly<{ status: 'notProvided' }>;
      provenance: Readonly<{ status: 'notProvided' }>;
      curation: Readonly<{ status: 'notApplicable' }>;
      updatePolicy: 'manual';
    }>
  | Readonly<{
      kind: 'archive';
      locator: string;
      integrity: string;
      integrityBasis: 'observed' | 'expected';
      packageName: string;
      publisher: Readonly<{ status: 'unavailable' }>;
      signature: Readonly<{ status: 'notProvided' }>;
      provenance: Readonly<{ status: 'notProvided' }>;
      curation: Readonly<{ status: 'notApplicable' }>;
      updatePolicy: 'manual';
    }>
  | Readonly<{
      kind: 'npm';
      locator: string;
      integrity: string;
      integrityBasis: 'expected';
      packageName: string;
      registryOrigin: string;
      registryProfileId?: string;
      publisher: ReviewPublisherIdentity;
      signature: ReviewSignature;
      provenance: ReviewProvenance;
      curation: ReviewCuration;
      blockedNewerVersions?: NpmArtifactCompatibilitySelection['blockedNewerVersions'];
      marketplaceSource?: Readonly<{
        id: string;
        kind: 'curated' | 'community-npm';
        sourceUrl: string;
      }>;
      updatePolicy: 'automatic' | 'manual' | 'pinned';
    }>;

const hostAccessAuthorizationClassByCapability = new Map(
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => [
    entry.capability,
    entry.authorizationClass,
  ] as const),
);

const accessScopeRegistry = createDefaultPluginAccessScopeRegistry();
const MAX_REVIEW_BLOCKED_NEWER_VERSIONS = 32;
const MAX_REVIEW_BLOCKED_NEWER_DIAGNOSTICS = 4;
const LONG_HAPPIER_ENGINE_REVIEW_DECLARATION = 'Declared compatible Happier CLI range';

function localizedText(value: string | Readonly<{ fallback: string }>): string {
  return typeof value === 'string' ? value : value.fallback;
}

/**
 * One normalized, review-safe projection for every surface that presents
 * manifest HostAccess to a human before installation or selection.
 */
export function projectPluginInstallationReviewHostAccess(params: Readonly<{
  pluginId: string;
  requests: readonly PluginHostAccessRequestV2[];
}>): PluginInstallationReview['requiredHostAccess'] {
  const { pluginId, requests } = params;
  return Object.freeze(requests.map((request) => {
    const authorizationClass = hostAccessAuthorizationClassByCapability.get(request.capability);
    if (!authorizationClass) {
      throw new Error(`Unknown plugin host-access capability '${request.capability}'`);
    }
    const selection = accessScopeRegistry.createSelection({
      pluginId,
      accessId: request.id,
      capability: request.capability,
      scope: request.scope,
      selectedAtMs: 0,
    });
    return Object.freeze({
      id: request.id,
      capability: request.capability,
      reason: localizedText(request.reason),
      authorizationClass,
      normalizedScope: selection.normalizedScope,
    });
  }));
}

function projectOptionalHostAccess(
  pluginId: string,
  requests: CanonicalPluginManifest['hostAccess']['optional'],
): PluginInstallationReview['optionalHostAccess'] {
  const projected = projectPluginInstallationReviewHostAccess({ pluginId, requests });
  for (const request of projected) {
    if (request.authorizationClass !== 'hostResourceSelection') {
      throw new Error(`Optional plugin host access '${request.id}' is not a host-owned resource selection`);
    }
  }
  return projected as PluginInstallationReview['optionalHostAccess'];
}

function projectExecutableRealms(
  manifest: CanonicalPluginManifest,
): PluginInstallationReview['executableRealms'] {
  const realms: Array<'daemon' | 'reactNative'> = [];
  if (manifest.entrypoints?.daemon || manifest.entrypoints?.development) realms.push('daemon');
  if (manifest.contributes.ui.renderers.some((renderer) => renderer.kind === 'reactNative')) {
    realms.push('reactNative');
  }
  return Object.freeze(realms);
}

function projectContributions(
  manifest: CanonicalPluginManifest,
): PluginInstallationReview['contributions'] {
  return Object.freeze(PLUGIN_CONTRIBUTION_CATALOG_V2.flatMap((entry) => {
    const count = entry.readEntries(manifest.contributes).length;
    return count > 0 ? [Object.freeze({ family: entry.manifestKey, count })] : [];
  }));
}

function projectRequestInterceptors(
  manifest: CanonicalPluginManifest,
): PluginInstallationReview['requestInterceptors'] {
  return Object.freeze(manifest.contributes.requestInterceptors.map((contribution) => (
    projectPluginInstallationReviewRequestInterceptor(contribution)
  )));
}

function projectDeclaredUiArtifactIds(
  manifest: CanonicalPluginManifest,
): readonly string[] {
  return Object.freeze([...new Set(PLUGIN_CONTRIBUTION_CATALOG_V2.flatMap((entry) => (
    entry.readEntries(manifest.contributes).flatMap((value) => (
      value && typeof value === 'object'
        ? entry.extractReferences(value as Readonly<Record<string, unknown>>)
          .flatMap((reference) => (
            reference.targetFamily === 'generated.uiArtifacts' && typeof reference.reference === 'string'
              ? [reference.reference]
              : []
          ))
        : []
    ))
  )))].sort());
}

function projectUpdateChannel(
  source: PluginInstallationReviewSourceFacts,
): PluginInstallationReview['updateChannel'] {
  if (source.kind === 'path') {
    return Object.freeze({
      kind: 'path',
      locator: source.locator,
      development: source.development,
    });
  }
  if (source.kind === 'archive') {
    return Object.freeze({ kind: 'archive', locator: source.locator });
  }
  return Object.freeze({
    kind: 'npm',
    packageName: source.packageName,
    registryOrigin: source.registryOrigin,
    ...(source.registryProfileId ? { registryProfileId: source.registryProfileId } : {}),
    ...(source.marketplaceSource ? { marketplaceSource: Object.freeze({ ...source.marketplaceSource }) } : {}),
  });
}

function projectInstallationReviewSource(
  source: PluginInstallationReviewSourceFacts,
): PluginInstallationReview['source'] {
  if (source.kind === 'path') {
    return Object.freeze({
      kind: 'path',
      locator: source.locator,
    });
  }
  if (source.kind === 'archive') {
    return Object.freeze({
      kind: 'archive',
      locator: source.locator,
      integrity: source.integrity,
      integrityBasis: source.integrityBasis,
    });
  }
  return Object.freeze({
    kind: 'npm',
    locator: source.locator,
    integrity: source.integrity,
    integrityBasis: source.integrityBasis,
  });
}

function projectBlockedNewerVersions(
  blockedNewerVersions: NpmArtifactCompatibilitySelection['blockedNewerVersions'] | undefined,
): ReviewBlockedNewerVersions | undefined {
  if (!blockedNewerVersions || blockedNewerVersions.length === 0) return undefined;
  return Object.freeze(blockedNewerVersions
    .slice(0, MAX_REVIEW_BLOCKED_NEWER_VERSIONS)
    .map((blocked) => Object.freeze({
      version: blocked.version,
      diagnostics: Object.freeze(blocked.diagnostics
        .slice(0, MAX_REVIEW_BLOCKED_NEWER_DIAGNOSTICS)
        .map((diagnostic) => Object.freeze({ ...diagnostic }))),
    })));
}

function projectHappierEngineForReview(
  happierEngine: string | undefined,
): string | undefined {
  if (!happierEngine) return undefined;
  return happierEngine.length <= MAX_PLUGIN_INSTALLATION_REVIEW_STRING_LENGTH
    ? happierEngine
    : LONG_HAPPIER_ENGINE_REVIEW_DECLARATION;
}

function projectRawCredentialRequest(
  request: ReviewRawCredentialAccess[number]['request'],
): ReviewRawCredentialAccess[number]['request'] {
  if (request.kind === 'httpHeaders') {
    return Object.freeze({
      kind: 'httpHeaders',
      origin: request.origin,
      headerNames: Object.freeze([...request.headerNames]),
    });
  }
  if (request.kind === 'environment') {
    return Object.freeze({
      kind: 'environment',
      keys: Object.freeze([...request.keys]),
    });
  }
  return Object.freeze({
    kind: 'files',
    fileIds: Object.freeze([...request.fileIds]),
  });
}

function projectRawVoiceCredentialAccess(
  manifest: CanonicalPluginManifest,
): ReviewRawCredentialAccess {
  return Object.freeze(manifest.contributes.voiceProviders.flatMap((contribution) => {
    const credentials = contribution.credentials;
    if (!credentials) return [];
    return credentials.sources.flatMap((source) => (
      (source.rawGrants ?? []).map((grant) => {
        const sourceClass = source.kind === 'savedSecret'
          ? Object.freeze({
              kind: 'savedSecret' as const,
              secretKinds: Object.freeze([...source.secretKinds]),
            })
          : Object.freeze({
              kind: 'connectedAccount' as const,
              service: Object.freeze(
                typeof source.service === 'string'
                  ? { pluginId: manifest.id, localId: source.service }
                  : { pluginId: source.service.pluginId, localId: source.service.localId },
              ),
            });
        return Object.freeze({
          accessMode: 'raw' as const,
          contribution: Object.freeze({ pluginId: manifest.id, localId: contribution.id }),
          credentialSlot: Object.freeze({
            id: credentials.slot.id,
            title: localizedText(credentials.slot.title),
            purpose: credentials.slot.purpose,
          }),
          sourceClass,
          realm: grant.realm,
          phase: grant.phase,
          request: projectRawCredentialRequest(grant.request),
        });
      })
    ));
  }));
}

export function projectPluginInstallationReview(params: Readonly<{
  manifest: CanonicalPluginManifest;
  source: PluginInstallationReviewSourceFacts;
  uiArtifacts: Readonly<{
    verification: 'verified' | 'unavailable';
    contributionIds: readonly string[];
  }>;
}>): PluginInstallationReview {
  const declaredUiArtifactIds = projectDeclaredUiArtifactIds(params.manifest);
  const providedUiArtifactIds = Object.freeze([...new Set(params.uiArtifacts.contributionIds)].sort());
  const blockedNewerVersions = params.source.kind === 'npm'
    ? projectBlockedNewerVersions(params.source.blockedNewerVersions)
    : undefined;
  if (
    params.uiArtifacts.verification === 'verified'
    && (
      declaredUiArtifactIds.length !== providedUiArtifactIds.length
      || declaredUiArtifactIds.some((id, index) => id !== providedUiArtifactIds[index])
    )
  ) {
    throw new Error('Verified plugin UI artifact identities do not match the manifest declarations');
  }
  const contributionIds = params.uiArtifacts.verification === 'verified'
    ? providedUiArtifactIds
    : declaredUiArtifactIds;
  const happierEngine = projectHappierEngineForReview(params.manifest.engines?.happier);
  const rawCredentialAccess = projectRawVoiceCredentialAccess(params.manifest);
  return Object.freeze({
    pluginId: params.manifest.id,
    displayName: localizedText(params.manifest.displayName),
    version: params.manifest.version,
    packageIdentity: Object.freeze({
      name: params.source.packageName,
      version: params.manifest.version,
    }),
    publisherIdentity: Object.freeze({ ...params.source.publisher }),
    source: projectInstallationReviewSource(params.source),
    updateChannel: projectUpdateChannel(params.source),
    signature: Object.freeze({ ...params.source.signature }),
    provenance: Object.freeze({ ...params.source.provenance }),
    curation: Object.freeze({ ...params.source.curation }),
    executableRealms: projectExecutableRealms(params.manifest),
    contributions: projectContributions(params.manifest),
    requestInterceptors: projectRequestInterceptors(params.manifest),
    uiArtifacts: Object.freeze({
      status: contributionIds.length === 0
        ? 'none'
        : params.uiArtifacts.verification,
      contributionIds,
    }),
    requiredHostAccess: projectPluginInstallationReviewHostAccess({
      pluginId: params.manifest.id,
      requests: params.manifest.hostAccess.required,
    }),
    optionalHostAccess: projectOptionalHostAccess(params.manifest.id, params.manifest.hostAccess.optional),
    rawCredentialAccess,
    compatibility: Object.freeze({
      ...(happierEngine ? { happier: happierEngine } : {}),
      runtimeApiVersion: params.manifest.runtime.apiVersion,
      ...(blockedNewerVersions ? { blockedNewerVersions } : {}),
    }),
    updatePolicy: params.source.updatePolicy,
  });
}
