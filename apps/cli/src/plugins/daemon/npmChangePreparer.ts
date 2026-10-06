import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginSourceSpecV1, PluginUpdatePolicyV1 } from '@happier-dev/protocol';
import { pluginCompatibilityProjectionEqualV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { readMarketplaceRegistryProfileRequirementV1 } from '@happier-dev/protocol/marketplace/marketplaceIndexV1';

import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
} from '@/plugins/distribution/archive';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { resolveAndDownloadNpmArtifact } from '@/plugins/distribution/npm/adapter';
import {
  createNpmRegistryHttpsClient,
  type NpmRegistryHttpsClient,
} from '@/plugins/distribution/npm/httpsClient';
import {
  normalizeNpmPackageName,
  normalizeNpmRegistryOrigin,
} from '@/plugins/distribution/npm/normalize';
import {
  createNpmRegistryProfileService,
  NpmRegistryProfileOperationError,
} from '@/plugins/distribution/npm/profiles/service';
import {
  cleanupStagedNpmArtifactCandidate,
  stageDownloadedNpmArtifactCandidate,
  type StagedNpmArtifactCandidate,
} from '@/plugins/distribution/npm/stage';
import {
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
} from '@/plugins/store/install/trustIdentity';
import {
  evaluatePluginAuthorityReview,
  type PluginAuthorityReviewEvaluation,
} from './updateReviewPolicy';
import {
  createPluginRegistryStateStore,
  PluginRegistryCandidateConflictError,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import type { PluginGenerationCustodyRetirementRemoteDependencies } from '@/plugins/store/registry/generationCustodyRetirement';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import {
  prepareOwnedImmutablePluginGeneration,
  type OwnedPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { PluginStateRecord } from '@/plugins/store/state';
import {
  createMarketplaceIndexService,
  resolveExactMarketplaceSourceBinding,
  resolveMarketplaceArtifactAccess,
} from '@/plugins/store/marketplace/service';
import {
  marketplaceListingMatchesExpected,
  resolveExactMarketplaceListingForInstall,
} from '@/plugins/store/marketplace/exactInstall';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';

import {
  PluginRegistryProfileRequiredError,
  type PluginChangeRequest,
  type PreparedDaemonPluginChangeCandidate,
} from './changeContract';
import { DaemonPluginChangePreparationError } from './changeService';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
import {
  projectPluginInstallationReview,
  type PluginInstallationReviewSourceFacts,
} from './installationReview';
import { projectPluginTransactionChangeResult } from './transactionChangeResult';
import { updateSelectedPluginOptionalAccess } from './optionalAccessSelections';
import { createDaemonPluginCandidateOperationRoot } from './candidateStorage';
import { createVerifiedPortablePluginInstallationAvailability } from '@/plugins/availability/releaseFacts';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

const PACKAGE_MANIFEST_PATH = '.happier-plugin/plugin.json';

type NpmRegistryProfileArtifactService = Pick<
  ReturnType<typeof createNpmRegistryProfileService>,
  'runArtifactRequest' | 'snapshot'
>;

type CreateNpmRegistryClient = (options: Readonly<{
  registryOrigin: string;
  authorizationHeader?: string;
  allowPrivateNetwork?: boolean;
}>) => NpmRegistryHttpsClient;

export type DaemonNpmPluginChangePreparationContext = Readonly<{
  installedUpdate: Readonly<{
    pluginId: string;
    updatePolicy: Exclude<PluginUpdatePolicyV1, 'pinned'>;
  }>;
}>;

/**
 * Decides whether a prepared npm candidate may be admitted without a new
 * present-user review. Only an explicit update of an installed record
 * qualifies — the canonical `installedUpdate` context `runtimeOwner` derives
 * from {@link resolveInstalledPluginUpdate} — and only when that record is
 * eligible for updates and every trusted channel fact is preserved: the exact
 * npm origin/package/profile trust
 * record still authorizes this candidate, the persisted approved authority
 * baseline is present, and no declared authority expanded
 * (executable realm expansion, host access, Connected Account purpose access,
 * declared integrations, request interceptors, raw credential disclosure).
 * Everything else reopens review — a first install, a pinned or changed
 * eligibility fact, and every exact marketplace or direct npm install, including one
 * naming a plugin already installed on this same trusted channel. Curation
 * is not an input: withdrawing a marketplace listing affects discovery and
 * recommendation only and never disables installed code.
 */
async function evaluateNpmUpdateAuthority(params: Readonly<{
  installedUpdate: DaemonNpmPluginChangePreparationContext['installedUpdate'] | undefined;
  existing: PluginStateRecord | undefined;
  hasReviewedPrincipal: boolean;
  approvedAuthorityManifest: CanonicalPluginManifest | undefined;
  candidate: CanonicalPluginManifest;
  distribution: ReturnType<typeof createNpmPluginDistributionIdentity>;
  updatePolicy: PluginUpdatePolicyV1;
}>): Promise<Readonly<{
  canApplyWithoutReview: boolean;
  authorityExpansion: PluginAuthorityReviewEvaluation['authorityExpansion'];
  preservedOptionalAccess: PluginAuthorityReviewEvaluation['preservedOptionalAccess'];
}>> {
  const existing = params.existing;
  if (!params.installedUpdate) {
    return { canApplyWithoutReview: false, authorityExpansion: [], preservedOptionalAccess: null };
  }
  if (
    !existing
    || !params.hasReviewedPrincipal
    || params.updatePolicy !== 'allowed'
    || existing.install.updatePolicy !== 'allowed'
    || !isPluginTrustRecordAuthorized(existing.install.trust, {
      pluginId: params.candidate.id,
      distribution: params.distribution,
    })
  ) {
    throw new DaemonPluginChangePreparationError(
      'plugin_update_trust_unavailable',
      `Plugin '${params.installedUpdate.pluginId}' has no current reviewed update authority`,
    );
  }
  const selectedOptionalAccess = existing.install.optionalAccess ?? [];
  if (!params.approvedAuthorityManifest) {
    throw new DaemonPluginChangePreparationError(
      'plugin_update_trust_unavailable',
      `Plugin '${params.installedUpdate.pluginId}' has no approved authority baseline`,
    );
  }
  const evaluation = evaluatePluginAuthorityReview({
    previous: params.approvedAuthorityManifest,
    candidate: params.candidate,
    selectedOptionalAccess,
  });
  return {
    canApplyWithoutReview: !evaluation.requiresReview,
    authorityExpansion: evaluation.authorityExpansion,
    preservedOptionalAccess: evaluation.preservedOptionalAccess,
  };
}

function assertMarketplaceRequestMatchesListing(
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
): void {
  const expected = request.expectedMarketplaceListing;
  if (!expected) return;
  if (
    normalizeNpmPackageName(request.packageName) !== expected.packageName
    || request.selector !== expected.version
    || !request.registryOrigin
    || normalizeNpmRegistryOrigin(request.registryOrigin) !== expected.registryOrigin
    || request.registryProfileId !== expected.registryProfileId
  ) {
    throw new Error('Exact marketplace listing does not match the requested npm artifact');
  }
}

/**
 * Source targeting before acquisition. The listing the user acted on names a
 * source; that binding is resolved from persisted state before any registry
 * access, so a removed, disabled, or rebound source refuses the change without
 * fetching anything. The full listing is revalidated again at apply, because
 * the source can still move while a human reviews the change.
 */
async function assertMarketplaceSourceBindingCurrent(
  happyHomeDir: string,
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
  npmRegistryProfiles: NpmRegistryProfileArtifactService,
): Promise<void> {
  const expected = request.expectedMarketplaceListing;
  if (!expected) return;
  const binding = await resolveExactMarketplaceSourceBinding({ happyHomeDir, sourceId: expected.source.id });
  if (!binding.ok
    || binding.source.origin !== expected.source.kind
    || binding.source.sourceUrl !== expected.source.sourceUrl
    || (binding.source.registryProfileId ?? undefined) !== expected.registryProfileId) {
    throw new NpmRegistryProfileOperationError('source_changed');
  }
  // The listing's artifact must be reachable through this Home's own source
  // binding. When it needs a registry profile that binding does not provide,
  // the change stops here — before any registry is contacted — naming the
  // registry to select, rather than failing after the user has reviewed it.
  const { profiles } = await npmRegistryProfiles.snapshot();
  const distribution = { packageName: expected.packageName, registryOrigin: expected.registryOrigin };
  const artifactAccess = resolveMarketplaceArtifactAccess(distribution, profiles, binding.source);
  const requirement = artifactAccess
    ? readMarketplaceRegistryProfileRequirementV1({ artifactAccess, ...distribution, profiles })
    : null;
  if (requirement) throw new PluginRegistryProfileRequiredError(requirement);
}

/**
 * A registry that refused this Home's request — anonymously, or with a
 * profile that must be signed in again — is a registry selection the user
 * still owes, not a failed install.
 */
function registryProfileRequiredFrom(
  error: unknown,
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
): PluginRegistryProfileRequiredError | null {
  if (
    !(error instanceof NpmRegistryProfileOperationError)
    || (error.code !== 'authentication_required' && error.code !== 'authentication_failed')
    || !error.registry
  ) {
    return null;
  }
  return new PluginRegistryProfileRequiredError({
    registryOrigin: error.registry.origin,
    packageName: normalizeNpmPackageName(request.packageName),
    registryProfileId: error.registry.profileId,
  });
}

async function assertMarketplaceListingCurrent(
  happyHomeDir: string,
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
  service?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'queryExactListing'>,
): Promise<void> {
  const expected = request.expectedMarketplaceListing;
  if (!expected) return;
  // The expected listing carries the untrusted exact distribution facts the
  // user acted on. They target the source before acquisition — the resolver
  // asks that one source for that one package — and are revalidated here
  // against the freshly resolved listing before any artifact is admitted.
  const result = await resolveExactMarketplaceListingForInstall({
    happyHomeDir,
    sourceId: expected.source.id,
    pluginId: expected.pluginId,
    packageName: expected.packageName,
  }, service);
  if (!result.ok || !marketplaceListingMatchesExpected(expected, result.resolution.listing)) {
    throw new NpmRegistryProfileOperationError('source_changed');
  }
}

function assertStagedCandidateMatchesMarketplaceListing(
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
  candidate: StagedNpmArtifactCandidate,
): void {
  const expected = request.expectedMarketplaceListing;
  if (!expected) return;
  if (
    candidate.manifest.id !== expected.pluginId
    || candidate.source.packageName !== expected.packageName
    || candidate.source.registryOrigin !== expected.registryOrigin
    || candidate.source.version !== expected.version
    || candidate.source.integrity !== expected.integrity
    || candidate.manifest.digest !== expected.manifestDigest
  ) {
    throw new Error('Staged npm candidate does not match the exact marketplace listing');
  }
}

function npmArtifactRequestFor(
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
): Readonly<{
  packageName: string;
  selector?: string;
  registryOrigin?: string;
  curatedExactOrigin?: string;
  explicitProfileId?: string;
}> {
  const expected = request.expectedMarketplaceListing;
  return {
    packageName: request.packageName,
    ...(request.selector ? { selector: request.selector } : {}),
    ...(expected?.source.kind === 'curated'
      ? { curatedExactOrigin: expected.registryOrigin }
      : request.registryOrigin ? { registryOrigin: request.registryOrigin } : {}),
    ...(request.registryProfileId ? { explicitProfileId: request.registryProfileId } : {}),
  };
}

function projectNpmSignature(
  candidate: StagedNpmArtifactCandidate,
): Extract<PluginInstallationReviewSourceFacts, { kind: 'npm' }>['signature'] {
  if (candidate.registrySignature.status === 'absent') return { status: 'notProvided' };
  return {
    status: candidate.registrySignature.status,
    keyId: candidate.registrySignature.keyid,
  };
}

function projectNpmProvenance(
  candidate: StagedNpmArtifactCandidate,
): Extract<PluginInstallationReviewSourceFacts, { kind: 'npm' }>['provenance'] {
  if (candidate.provenance.status === 'absent') return { status: 'notProvided' };
  if (candidate.provenance.status === 'declared') {
    return { status: 'declaredUnverified', predicateType: candidate.provenance.predicateType };
  }
  if (candidate.provenance.status === 'retrieved') {
    return {
      status: 'retrievedUnverified',
      predicateTypes: Object.freeze([...candidate.provenance.predicateTypes]),
    };
  }
  return { status: 'unavailable', code: candidate.provenance.code };
}

async function cleanupOwnedCandidate(params: Readonly<{
  operationRootPath: string;
  candidate?: StagedNpmArtifactCandidate;
  preparedGeneration?: OwnedPreparedImmutablePluginGeneration;
}>): Promise<void> {
  let cleanupError: unknown;
  if (params.preparedGeneration) {
    try {
      await params.preparedGeneration.cleanup();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (params.candidate) {
    try {
      await cleanupStagedNpmArtifactCandidate(params.candidate);
    } catch (error) {
      cleanupError = error;
    }
  }
  try {
    await rm(params.operationRootPath, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

export function createDaemonNpmPluginChangePreparer(params: Readonly<{
  happyHomeDir: string;
  runtimeLifecycle: PluginRegistryRuntimeLifecycle;
  onRegistryApplied?: (record: PluginRegistryCommitRecord) => void;
  npmRegistryProfiles?: NpmRegistryProfileArtifactService;
  createClient?: CreateNpmRegistryClient;
  marketplaceIndexService?: Pick<ReturnType<typeof createMarketplaceIndexService>, 'queryExactListing'>;
  nowMs?: () => number;
  generationCustodyRetirement?: PluginGenerationCustodyRetirementRemoteDependencies;
}>): (
  request: PluginChangeRequest,
  context?: DaemonNpmPluginChangePreparationContext,
) => Promise<PreparedDaemonPluginChangeCandidate> {
  const npmRegistryProfiles = params.npmRegistryProfiles
    ?? createNpmRegistryProfileService({ happyHomeDir: params.happyHomeDir });
  const createClient = params.createClient ?? createNpmRegistryHttpsClient;
  const nowMs = params.nowMs ?? Date.now;
  const createMutationStore = (
    onApplied?: (record: PluginRegistryCommitRecord) => void,
  ) => createPluginRegistryStateStore({
    happyHomeDir: params.happyHomeDir,
    runtimeLifecycle: params.runtimeLifecycle,
    ...(params.generationCustodyRetirement
      ? { generationCustodyRetirement: params.generationCustodyRetirement }
      : {}),
    ...(onApplied ? { onApplied } : {}),
  });

  return async (request, context) => {
    if (request.kind !== 'installNpm') {
      throw new Error(`Plugin change '${request.kind}' is not implemented by the npm candidate adapter`);
    }
    assertMarketplaceRequestMatchesListing(request);
    await assertMarketplaceSourceBindingCurrent(params.happyHomeDir, request, npmRegistryProfiles);
    const installedUpdate = context?.installedUpdate;
    const requestedUpdatePolicy = installedUpdate?.updatePolicy
      ?? request.expectedMarketplaceListing?.updatePolicy
      ?? 'allowed';
    const registryStateStore = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
    const admissionSnapshot = installedUpdate
      ? await registryStateStore.readSnapshot()
      : undefined;
    const existingAtAdmission = installedUpdate
      ? admissionSnapshot?.state.plugins[installedUpdate.pluginId]
      : undefined;
    // A review-free update is only ever an explicit update of an installed
    // record whose update eligibility and trusted npm channel checks pass
    // below. An exact marketplace or
    // direct install is never one, however closely its coordinates match the
    // installed channel. Curation is not an input either: withdrawal or source
    // removal never blocks an update and never disables installed code.
    const authorityNeutralUpdateCandidate = installedUpdate !== undefined
      && requestedUpdatePolicy === 'allowed'
      && existingAtAdmission?.install.updatePolicy === 'allowed';

    const operationRootPath = await createDaemonPluginCandidateOperationRoot({
      happyHomeDir: params.happyHomeDir,
      kind: 'npm',
    });
    let stagedCandidate: StagedNpmArtifactCandidate | undefined;
    let preparedGeneration: OwnedPreparedImmutablePluginGeneration | undefined;
    try {
      let resolvedRegistryProfileId: string | undefined;
      const downloaded = await npmRegistryProfiles.runArtifactRequest(npmArtifactRequestFor(request), async (access) => {
        resolvedRegistryProfileId = access.request.selection.profileId;
        const client = createClient({
          registryOrigin: access.request.registryOrigin,
          allowPrivateNetwork: access.allowPrivateNetwork,
          ...(access.authorizationHeader ? { authorizationHeader: access.authorizationHeader } : {}),
        });
        return await resolveAndDownloadNpmArtifact({
          input: {
            registryOrigin: access.request.registryOrigin,
            packageName: access.request.packageName,
            selector: access.request.selector.value,
          },
          destinationPath: join(operationRootPath, 'candidate.tgz'),
          artifactMaxBytes: DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxExpandedBytes,
          ...(authorityNeutralUpdateCandidate ? { requireCompatibleProjection: true } : {}),
          client,
        });
      });
      const staged = await stageDownloadedNpmArtifactCandidate({
        candidate: downloaded,
        stagingParentPath: join(operationRootPath, 'staging'),
      });
      if (!staged.ok) {
        throw new Error(`Npm plugin candidate rejected (${staged.rejection.code}): ${staged.rejection.message}`);
      }
      stagedCandidate = staged.candidate;
      assertStagedCandidateMatchesMarketplaceListing(request, staged.candidate);
      if (
        downloaded.compatibility?.projection
        && !pluginCompatibilityProjectionEqualV1(
          downloaded.compatibility.projection,
          staged.candidate.compatibilityProjection,
        )
      ) {
        throw new Error('Npm compatibility projection does not match staged archive facts');
      }
      const availability = createVerifiedPortablePluginInstallationAvailability({
        sourceClass: 'registryPackage',
        archiveDigestSha256: staged.candidate.archiveDigestSha256,
        manifest: staged.candidate.manifest.value,
        generatedUiArtifacts: staged.candidate.generatedUiArtifacts.manifest,
        packageAssetArchive: staged.candidate.packageAssetArchive.descriptor,
      });

      const expectedMarketplaceListing = request.expectedMarketplaceListing;
      const preparationSnapshot = await registryStateStore.readSnapshot();
      const existingAtPreparation = preparationSnapshot.state.plugins[staged.candidate.manifest.id];
      const priorPrincipalDigest = preparationSnapshot
        .installReviewPrincipalDigestsByPluginId[staged.candidate.manifest.id];
      const priorPrincipalPresentation = preparationSnapshot
        .installReviewPrincipalPresentationsByPluginId[staged.candidate.manifest.id];
      const approvedAuthorityManifest = preparationSnapshot
        .approvedAuthorityManifestsByPluginId[staged.candidate.manifest.id];
      const priorInstallReviewPrincipal = priorPrincipalDigest && priorPrincipalPresentation
        ? Object.freeze({
            digest: priorPrincipalDigest,
            presentation: priorPrincipalPresentation,
          })
        : undefined;
      const updatePolicy = requestedUpdatePolicy;

      const distribution = createNpmPluginDistributionIdentity({
        registryOrigin: staged.candidate.source.registryOrigin,
        ...(resolvedRegistryProfileId ? { registryProfileId: resolvedRegistryProfileId } : {}),
        packageName: staged.candidate.source.packageName,
      });
      if (installedUpdate && (
        installedUpdate.pluginId !== staged.candidate.manifest.id
        || existingAtPreparation?.install.updatePolicy !== installedUpdate.updatePolicy
        || !isPluginTrustRecordAuthorized(existingAtPreparation?.install.trust, {
          pluginId: installedUpdate.pluginId,
          distribution,
        })
      )) {
        throw new PluginRegistryCandidateConflictError(
          `Installed npm update channel changed while preparing '${installedUpdate.pluginId}'`,
        );
      }
      const candidateGeneration = await prepareOwnedImmutablePluginGeneration({
        paths: resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }),
        pluginId: staged.candidate.manifest.id,
        sourceRootPath: staged.candidate.rootPath,
        manifestRelativePath: PACKAGE_MANIFEST_PATH,
        distribution,
        updatePolicy,
        createdAtMs: nowMs(),
      });
      preparedGeneration = candidateGeneration;
      const review = projectPluginInstallationReview({
        manifest: staged.candidate.manifest.value,
        source: {
          kind: 'npm',
          locator: `${staged.candidate.source.packageName}@${staged.candidate.source.version}`,
          integrity: staged.candidate.source.integrity,
          integrityBasis: 'expected',
          packageName: staged.candidate.source.packageName,
          registryOrigin: staged.candidate.source.registryOrigin,
          ...(resolvedRegistryProfileId ? { registryProfileId: resolvedRegistryProfileId } : {}),
          publisher: expectedMarketplaceListing
            ? {
                status: 'unverified',
                id: expectedMarketplaceListing.publisher.id,
                displayName: expectedMarketplaceListing.publisher.displayName,
              }
            : { status: 'unavailable' },
          signature: projectNpmSignature(staged.candidate),
          provenance: projectNpmProvenance(staged.candidate),
          curation: expectedMarketplaceListing?.review.status === 'approved'
            ? {
                status: 'approved',
                sourceId: expectedMarketplaceListing.source.id,
                reviewedAt: expectedMarketplaceListing.review.reviewedAt,
                ...(expectedMarketplaceListing.review.reason !== undefined
                  ? { reason: expectedMarketplaceListing.review.reason }
                  : {}),
              }
            : expectedMarketplaceListing
              ? { status: 'unreviewed', sourceId: expectedMarketplaceListing.source.id }
              : { status: 'notApplicable' },
          ...(expectedMarketplaceListing
            ? { marketplaceSource: expectedMarketplaceListing.source }
            : {}),
          ...(downloaded.compatibility?.blockedNewerVersions.length
            ? { blockedNewerVersions: downloaded.compatibility.blockedNewerVersions }
            : {}),
          updatePolicy,
        },
        uiArtifacts: {
          verification: 'verified',
          contributionIds: staged.candidate.generatedUiArtifacts.artifactIds,
        },
      });
      const installReviewPrincipal = derivePluginInstallReviewPrincipal(review);
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => {
        cleanupPromise ??= cleanupOwnedCandidate({
          operationRootPath,
          candidate: staged.candidate,
          preparedGeneration: candidateGeneration,
        });
        return cleanupPromise;
      };

      const authorityEvaluation = await evaluateNpmUpdateAuthority({
        installedUpdate,
        existing: existingAtPreparation,
        hasReviewedPrincipal: priorInstallReviewPrincipal !== undefined,
        approvedAuthorityManifest,
        candidate: staged.candidate.manifest.value,
        distribution,
        updatePolicy,
      });
      const requiresReview = !authorityEvaluation.canApplyWithoutReview;

      return Object.freeze({
        pluginId: staged.candidate.manifest.id,
        review,
        reviewReason: installedUpdate ? 'authorityExpansion' : 'firstInstall',
        ...(existingAtPreparation ? { currentVersion: existingAtPreparation.install.manifestVersion } : {}),
        authorityExpansion: authorityEvaluation.authorityExpansion,
        requiresReview,
        async apply(decision, control) {
          const approval = decision;
          if (requiresReview && !approval) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          try {
            await assertMarketplaceListingCurrent(params.happyHomeDir, request, params.marketplaceIndexService);
            const applySnapshot = await registryStateStore.readSnapshot();
            const existingAtApply = applySnapshot.state.plugins[staged.candidate.manifest.id];
            if (
              JSON.stringify(existingAtApply) !== JSON.stringify(existingAtPreparation)
              || applySnapshot.installReviewPrincipalDigestsByPluginId[staged.candidate.manifest.id]
                !== priorPrincipalDigest
              || JSON.stringify(
                applySnapshot.installReviewPrincipalPresentationsByPluginId[staged.candidate.manifest.id],
              ) !== JSON.stringify(priorPrincipalPresentation)
            ) {
              return { kind: 'conflict' as const, pluginId: staged.candidate.manifest.id };
            }
            await npmRegistryProfiles.runArtifactRequest(npmArtifactRequestFor(request), async (access) => {
              if (
                access.request.registryOrigin !== staged.candidate.source.registryOrigin
                || access.request.packageName !== staged.candidate.source.packageName
                || access.request.selection.profileId !== resolvedRegistryProfileId
              ) {
                throw new PluginRegistryCandidateConflictError(
                  `Npm source changed after installation review for '${staged.candidate.manifest.id}'`,
                );
              }
            });
            const approvedAtMs = approval
              ? nowMs()
              : existingAtApply?.install.trust?.approvedAtMs ?? nowMs();
            const optionalAccess = approval
              ? updateSelectedPluginOptionalAccess({
                  pluginId: staged.candidate.manifest.id,
                  manifest: staged.candidate.manifest.value,
                  existing: existingAtApply?.install.optionalAccess ?? [],
                  decisions: approval.optionalSelections,
                  selectedAtMs: approvedAtMs,
                })
              : authorityEvaluation.preservedOptionalAccess;
            const trust = approval
              ? createPluginTrustRecord({
                  pluginId: staged.candidate.manifest.id,
                  distribution,
                  approvedAtMs,
                })
              : existingAtApply?.install.trust;
            if (
              !optionalAccess
              || !trust
              || !isPluginTrustRecordAuthorized(trust, {
                pluginId: staged.candidate.manifest.id,
                distribution,
              })
            ) {
              return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
            }
            const committedInstallReviewPrincipal = approval
              ? installReviewPrincipal
              : priorInstallReviewPrincipal;
            if (!committedInstallReviewPrincipal) {
              return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
            }
            const source: PluginSourceSpecV1 = {
              kind: 'package',
              locator: staged.candidate.source.packageName,
              trustPolicy: 'prompt',
              installPolicy: 'managed_install',
              resolvedVersion: staged.candidate.source.version,
              installedAt: existingAtApply?.source.installedAt ?? approvedAtMs,
            };
            const catalogRecord: PluginStateRecord = {
              source: {
                ...source,
                resolvedPath: staged.candidate.rootPath,
                manifestPath: join(staged.candidate.rootPath, ...PACKAGE_MANIFEST_PATH.split('/')),
              },
              compatibility: { status: 'compatible', diagnostics: [] },
              install: {
                mode: 'managed_install',
                manifestVersion: staged.candidate.manifest.version,
                installedPath: null,
              },
              state: { enabled: true, lastLoadedAtMs: nowMs(), lastError: null },
            };
            const store = createMutationStore((record) => {
              control?.onApplied();
              params.onRegistryApplied?.(record);
            });
            const transaction = await store.install({
              pluginId: staged.candidate.manifest.id,
              catalogRecord,
              trust,
              updatePolicy,
              optionalAccess,
              approvedAuthorityManifest: staged.candidate.manifest.value,
              availability,
              admittedIntegrity: staged.candidate.source.integrity,
              preparedGeneration: candidateGeneration,
              installReviewPrincipalDigest: committedInstallReviewPrincipal.digest,
              installReviewPrincipalPresentation: committedInstallReviewPrincipal.presentation,
            });
            if (transaction.status !== 'committed' && transaction.status !== 'outcomeUnknown') {
              throw new Error(`Npm installation ended without a committed registry transaction (${transaction.status})`);
            }
            const generation = transaction.record.pluginOccurrenceIds[
              staged.candidate.manifest.id
            ]?.immutableGenerationId ?? null;
            return projectPluginTransactionChangeResult({
              pluginId: staged.candidate.manifest.id,
              desiredGeneration: generation,
              transaction,
            });
          } catch (error) {
            return error instanceof PluginRegistryCandidateConflictError
              || (error instanceof NpmRegistryProfileOperationError && error.code === 'source_changed')
              ? { kind: 'conflict' as const, pluginId: staged.candidate.manifest.id }
              : {
                  kind: 'failed' as const,
                  code: 'plugin_install_failed',
                  message: projectPluginFailureText(error),
                };
          }
        },
        cleanup,
      });
    } catch (error) {
      try {
        await cleanupOwnedCandidate({
          operationRootPath,
          ...(stagedCandidate ? { candidate: stagedCandidate } : {}),
          ...(preparedGeneration ? { preparedGeneration } : {}),
        });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Npm candidate preparation and cleanup both failed');
      }
      throw registryProfileRequiredFrom(error, request) ?? error;
    }
  };
}
