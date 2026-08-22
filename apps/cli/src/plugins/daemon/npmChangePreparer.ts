import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type PluginSourceSpecV1,
  pluginCompatibilityProjectionEqualV1,
} from '@happier-dev/protocol';

import {
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
} from '@/plugins/distribution/archive';
import { readPluginManifest } from '@/plugins/manifest/read';
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
  createPluginCuratedUpdateSourceBinding,
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
  type PluginCuratedUpdateSourceBinding,
  type PluginUpdatePolicy,
} from '@/plugins/store/install/trustIdentity';
import {
  hasReviewSensitivePluginUpdate,
  preserveValidPluginOptionalSelections,
} from './updateReviewPolicy';
import {
  createPluginRegistryStateStore,
  PluginRegistryCandidateConflictError,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import {
  prepareOwnedImmutablePluginGeneration,
  type OwnedPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { PluginStateRecord } from '@/plugins/store/state';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE } from '@/plugins/store/marketplace/service';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';

import type {
  PluginChangeRequest,
  PreparedDaemonPluginChangeCandidate,
} from './changeContract';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
import {
  projectPluginInstallationReview,
  type PluginInstallationReviewSourceFacts,
} from './installationReview';
import { projectPluginTransactionChangeResult } from './transactionChangeResult';
import { createSelectedPluginOptionalAccess } from './optionalAccessSelections';
import { createDaemonPluginCandidateOperationRoot } from './candidateStorage';
import { createVerifiedPortablePluginInstallationAvailability } from '@/plugins/availability/releaseFacts';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { DaemonPluginChangePreparationError } from './changeService';

const PACKAGE_MANIFEST_PATH = '.happier-plugin/plugin.json';

type NpmRegistryProfileArtifactService = Pick<
  ReturnType<typeof createNpmRegistryProfileService>,
  'runArtifactRequest'
>;

type CreateNpmRegistryClient = (options: Readonly<{
  registryOrigin: string;
  authorizationHeader?: string;
  allowPrivateNetwork?: boolean;
}>) => NpmRegistryHttpsClient;

export type DaemonNpmPluginChangePreparationContext = Readonly<{
  installedUpdate: Readonly<{
    pluginId: string;
    updatePolicy: Exclude<PluginUpdatePolicy, 'pinned'>;
  }>;
}>;

async function canApplyAutomaticNpmUpdate(params: Readonly<{
  existing: PluginStateRecord | undefined;
  candidate: CanonicalPluginManifest;
  distribution: ReturnType<typeof createNpmPluginDistributionIdentity>;
  updatePolicy: 'automatic' | 'manual' | 'pinned';
  automaticUpdateAuthorized: boolean;
  curatedUpdateSource: PluginCuratedUpdateSourceBinding | undefined;
}>): Promise<boolean> {
  const existing = params.existing;
  if (
    !existing
    || !params.automaticUpdateAuthorized
    || params.updatePolicy !== 'automatic'
    || existing.install.updatePolicy !== 'automatic'
    || !params.curatedUpdateSource
    || !existing.install.curatedUpdateSource
    || !curatedUpdateSourceBindingsEqual(
      existing.install.curatedUpdateSource,
      params.curatedUpdateSource,
    )
    || !isPluginTrustRecordAuthorized(existing.install.trust, {
      pluginId: params.candidate.id,
      distribution: params.distribution,
    })
  ) {
    return false;
  }
  const previous = await readPluginManifest({ manifestPath: existing.source.manifestPath });
  if (
    !previous.ok
    || previous.manifest.id !== params.candidate.id
    || previous.manifest.version !== existing.install.manifestVersion
    || hasReviewSensitivePluginUpdate(previous.manifest, params.candidate)
  ) {
    return false;
  }
  return preserveValidPluginOptionalSelections(
    params.candidate.id,
    params.candidate,
    existing.install.optionalAccess ?? [],
  ) !== null;
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

async function assertCuratedUpdateSourceBindingCurrent(
  happyHomeDir: string,
  binding: PluginCuratedUpdateSourceBinding,
): Promise<void> {
  const source = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources.find(
    (entry) => entry.id === binding.id,
  ) ?? null;
  if (
    !source
    || !source.enabled
    || source.origin !== 'curated'
    || source.sourceUrl !== binding.sourceUrl
    || (source.registryProfileId ?? undefined) !== binding.registryProfileId
  ) {
    throw new NpmRegistryProfileOperationError('source_changed');
  }
}

async function assertMarketplaceSourceBindingCurrent(
  happyHomeDir: string,
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
): Promise<void> {
  const expected = request.expectedMarketplaceListing;
  if (!expected) return;
  if (expected.source.kind === 'community-npm') {
    if (
      expected.source.id !== COMMUNITY_NPM_MARKETPLACE_SOURCE.id
      || expected.source.sourceUrl !== COMMUNITY_NPM_MARKETPLACE_SOURCE.sourceUrl
      || expected.registryProfileId !== undefined
    ) {
      throw new NpmRegistryProfileOperationError('source_changed');
    }
    return;
  }
  await assertCuratedUpdateSourceBindingCurrent(
    happyHomeDir,
    createPluginCuratedUpdateSourceBinding({
      id: expected.source.id,
      sourceUrl: expected.source.sourceUrl,
      ...(expected.registryProfileId ? { registryProfileId: expected.registryProfileId } : {}),
    }),
  );
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

function curatedUpdateSourceFromMarketplaceListing(
  request: Extract<PluginChangeRequest, { kind: 'installNpm' }>,
): PluginCuratedUpdateSourceBinding | undefined {
  const expected = request.expectedMarketplaceListing;
  if (!expected || expected.source.kind !== 'curated' || expected.updatePolicy !== 'automatic') {
    return undefined;
  }
  return createPluginCuratedUpdateSourceBinding({
    id: expected.source.id,
    sourceUrl: expected.source.sourceUrl,
    ...(expected.registryProfileId ? { registryProfileId: expected.registryProfileId } : {}),
  });
}

function curatedUpdateSourceBindingsEqual(
  left: PluginCuratedUpdateSourceBinding,
  right: PluginCuratedUpdateSourceBinding,
): boolean {
  return left.id === right.id
    && left.sourceUrl === right.sourceUrl
    && left.registryProfileId === right.registryProfileId;
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
  nowMs?: () => number;
}>): (
  request: PluginChangeRequest,
  context?: DaemonNpmPluginChangePreparationContext,
) => Promise<PreparedDaemonPluginChangeCandidate> {
  const npmRegistryProfiles = params.npmRegistryProfiles
    ?? createNpmRegistryProfileService({ happyHomeDir: params.happyHomeDir });
  const createClient = params.createClient ?? createNpmRegistryHttpsClient;
  const nowMs = params.nowMs ?? Date.now;

  return async (request, context) => {
    if (request.kind !== 'installNpm') {
      throw new Error(`Plugin change '${request.kind}' is not implemented by the npm candidate adapter`);
    }
    assertMarketplaceRequestMatchesListing(request);
    await assertMarketplaceSourceBindingCurrent(params.happyHomeDir, request);
    const installedUpdate = context?.installedUpdate;
    const automaticInstalledUpdate = installedUpdate?.updatePolicy === 'automatic';
    const requestedUpdatePolicy = installedUpdate?.updatePolicy
      ?? request.expectedMarketplaceListing?.updatePolicy
      ?? 'manual';
    const marketplaceCuratedUpdateSource = curatedUpdateSourceFromMarketplaceListing(request);
    const updateTargetPluginId = installedUpdate?.pluginId
      ?? request.expectedMarketplaceListing?.pluginId;
    const existingAtAdmission = updateTargetPluginId
      ? (await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read())
        .plugins[updateTargetPluginId]
      : undefined;
    const persistedCuratedUpdateSource = existingAtAdmission?.install.updatePolicy === 'automatic'
      ? existingAtAdmission.install.curatedUpdateSource
      : undefined;
    const automaticUpdateAuthorized = requestedUpdatePolicy === 'automatic'
      && persistedCuratedUpdateSource !== undefined
      && (
        automaticInstalledUpdate
        || (
          marketplaceCuratedUpdateSource !== undefined
          && curatedUpdateSourceBindingsEqual(
            persistedCuratedUpdateSource,
            marketplaceCuratedUpdateSource,
          )
        )
      );
    if (installedUpdate?.updatePolicy === 'automatic' && !automaticUpdateAuthorized) {
      throw new DaemonPluginChangePreparationError(
        'plugin_update_trust_unavailable',
        `Plugin '${installedUpdate.pluginId}' has no reviewed curated source binding for automatic updates`,
      );
    }
    if (automaticUpdateAuthorized && persistedCuratedUpdateSource) {
      await assertCuratedUpdateSourceBindingCurrent(params.happyHomeDir, persistedCuratedUpdateSource);
    }

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
          ...(automaticUpdateAuthorized ? { requireCompatibleProjection: true } : {}),
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
      const existingAtPreparation = (
        await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
      ).plugins[staged.candidate.manifest.id];
      const updatePolicy = requestedUpdatePolicy;
      const curatedUpdateSource = automaticInstalledUpdate
        ? persistedCuratedUpdateSource
        : updatePolicy === 'automatic'
          ? curatedUpdateSourceFromMarketplaceListing(request)
          : undefined;
      if (updatePolicy === 'automatic' && !curatedUpdateSource) {
        throw new DaemonPluginChangePreparationError(
          'plugin_update_trust_unavailable',
          `Plugin '${staged.candidate.manifest.id}' has no reviewed curated source binding for automatic updates`,
        );
      }

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
          contributionIds: staged.candidate.generatedUiArtifacts.contributionIds,
        },
      });
      const installReviewPrincipal = derivePluginInstallReviewPrincipal(review);
      const requiresReview = !(await canApplyAutomaticNpmUpdate({
        existing: existingAtPreparation,
        candidate: staged.candidate.manifest.value,
        distribution,
        updatePolicy,
        automaticUpdateAuthorized,
        curatedUpdateSource,
      }));
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => {
        cleanupPromise ??= cleanupOwnedCandidate({
          operationRootPath,
          candidate: staged.candidate,
          preparedGeneration: candidateGeneration,
        });
        return cleanupPromise;
      };

      return Object.freeze({
        pluginId: staged.candidate.manifest.id,
        review,
        requiresReview,
        async apply(decision, control) {
          const approval = decision;
          if (requiresReview && !approval) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          try {
            await assertMarketplaceSourceBindingCurrent(params.happyHomeDir, request);
            if (curatedUpdateSource) {
              await assertCuratedUpdateSourceBindingCurrent(
                params.happyHomeDir,
                curatedUpdateSource,
              );
            }
            const existingAtApply = (
              await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
            ).plugins[staged.candidate.manifest.id];
            if (JSON.stringify(existingAtApply) !== JSON.stringify(existingAtPreparation)) {
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
            const approvedAtMs = approval?.actorEvidence.occurredAtMs
              ?? existingAtApply?.install.trust?.approvedAtMs
              ?? nowMs();
            const optionalAccess = approval
              ? createSelectedPluginOptionalAccess({
                  pluginId: staged.candidate.manifest.id,
                  declarations: staged.candidate.manifest.value.hostAccess.optional,
                  decisions: approval.optionalSelections,
                  selectedAtMs: approvedAtMs,
                })
              : preserveValidPluginOptionalSelections(
                  staged.candidate.manifest.id,
                  staged.candidate.manifest.value,
                  existingAtApply?.install.optionalAccess ?? [],
                );
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
                ...(curatedUpdateSource ? { curatedUpdateSource } : {}),
              },
              state: { enabled: true, lastLoadedAtMs: nowMs(), lastError: null },
            };
            const store = createPluginRegistryStateStore({
              happyHomeDir: params.happyHomeDir,
              runtimeLifecycle: params.runtimeLifecycle,
              onApplied: (record) => {
                control?.onApplied();
                params.onRegistryApplied?.(record);
              },
            });
            const transaction = await store.install({
              pluginId: staged.candidate.manifest.id,
              catalogRecord,
              trust,
              updatePolicy,
              optionalAccess,
              availability,
              admittedIntegrity: staged.candidate.source.integrity,
              preparedGeneration: candidateGeneration,
              installReviewPrincipalDigest: installReviewPrincipal.digest,
              installReviewPrincipalPresentation: installReviewPrincipal.presentation,
            });
            if (transaction.status !== 'committed' && transaction.status !== 'outcomeUnknown') {
              throw new Error(`Npm installation ended without a committed registry transaction (${transaction.status})`);
            }
            const generation = transaction.record.pluginGenerations[
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
      throw error;
    }
  };
}
