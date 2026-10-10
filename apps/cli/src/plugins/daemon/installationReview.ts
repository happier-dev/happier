import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2 } from '@happier-dev/protocol/plugins/manifest/v2';
import type { PluginHostAccessRequestV2, PluginUpdatePolicyV1 } from '@happier-dev/protocol';
import type { PluginInstallationReview } from '@happier-dev/protocol/marketplace/internal';

import type { NpmArtifactCompatibilitySelection } from '@/plugins/distribution/npm/types';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { createDefaultPluginAccessScopeRegistry } from '@/plugins/store/install/accessScopeRegistry';

import { projectPluginInstallationReviewRequestInterceptor } from './changeContract';

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
      updatePolicy: 'allowed';
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
      updatePolicy: 'allowed';
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
        kind: 'curated' | 'community-npm' | 'user';
        sourceUrl: string;
      }>;
      updatePolicy: PluginUpdatePolicyV1;
    }>;

const hostAccessAuthorizationClassByCapability = new Map(
  PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2.map((entry) => [
    entry.capability,
    entry.authorizationClass,
  ] as const),
);

const accessScopeRegistry = createDefaultPluginAccessScopeRegistry();

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

/**
 * The one executable-realm projection. It is both the realm set a human
 * reviews before installing and the set an automatic `allowed`
 * update may only contract, so the review dialog and the update-review policy
 * read the same realms from one owner.
 */
export function projectPluginInstallationReviewExecutableRealms(
  manifest: CanonicalPluginManifest,
): PluginInstallationReview['executableRealms'] {
  const realms: Array<'daemon' | 'reactNative' | 'hostedWeb'> = [];
  if (manifest.entrypoints?.daemon || manifest.entrypoints?.development) realms.push('daemon');
  if (manifest.contributes.ui.renderers.some((renderer) => renderer.kind === 'reactNative')) {
    realms.push('reactNative');
  }
  if (manifest.contributes.ui.renderers.some((renderer) => renderer.kind === 'hostedWeb' || renderer.kind === 'hostedHtml')) {
    realms.push('hostedWeb');
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
    .map((blocked) => Object.freeze({
      version: blocked.version,
      diagnostics: Object.freeze(blocked.diagnostics
        .map((diagnostic) => Object.freeze({ ...diagnostic }))),
    })));
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

/**
 * The one raw-credential disclosure projection. It is both what a human
 * reviews before installing and the fact set an automatic
 * `allowed` update must not expand, so the review dialog and
 * the update-review policy read the same facts from one owner.
 */
export function projectPluginInstallationReviewRawCredentialAccess(
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
  const happierEngine = params.manifest.engines?.happier;
  const rawCredentialAccess = projectPluginInstallationReviewRawCredentialAccess(params.manifest);
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
    executableRealms: projectPluginInstallationReviewExecutableRealms(params.manifest),
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
