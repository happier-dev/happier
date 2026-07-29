import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type PluginSourceSpecV1,
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
  createNpmPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
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
import {
  createImmutablePluginGenerationRecordFromSource,
} from '@/plugins/store/registry/generationStore';
import type { PluginStateRecord } from '@/plugins/store/state';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE } from '@/plugins/store/marketplace/service';
import { createMarketplaceSourceRegistryStore } from '@/plugins/store/marketplace/sources/store';

import type {
  PluginChangeRequest,
  PreparedDaemonPluginChange,
} from './changeContract';
import {
  projectPluginInstallationReview,
  type PluginInstallationReviewSourceFacts,
} from './installationReview';
import { projectPluginTransactionChangeResult } from './transactionChangeResult';
import { createSelectedPluginOptionalAccess } from './optionalAccessSelections';
import { createDaemonPluginCandidateOperationRoot } from './candidateStorage';

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
  approvedUpdateBasis: boolean;
}>): Promise<boolean> {
  const existing = params.existing;
  if (
    !existing
    || !params.approvedUpdateBasis
    || params.updatePolicy !== 'automatic'
    || existing.install.updatePolicy !== 'automatic'
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
    || previous.manifestDigest !== existing.install.manifestDigest
    || previous.manifest.id !== params.candidate.id
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
  const source = (await createMarketplaceSourceRegistryStore({ happyHomeDir }).read()).sources.find(
    (entry) => entry.id === expected.source.id,
  ) ?? null;
  if (
    !source
    || !source.enabled
    || source.origin !== 'curated'
    || source.sourceUrl !== expected.source.sourceUrl
    || (source.registryProfileId ?? undefined) !== expected.registryProfileId
  ) {
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
}>): Promise<void> {
  let cleanupError: unknown;
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
  npmRegistryProfiles?: NpmRegistryProfileArtifactService;
  createClient?: CreateNpmRegistryClient;
  nowMs?: () => number;
}>): (
  request: PluginChangeRequest,
  context?: DaemonNpmPluginChangePreparationContext,
) => Promise<PreparedDaemonPluginChange> {
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

    const operationRootPath = await createDaemonPluginCandidateOperationRoot({
      happyHomeDir: params.happyHomeDir,
      kind: 'npm',
    });
    let stagedCandidate: StagedNpmArtifactCandidate | undefined;
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

      const expectedMarketplaceListing = request.expectedMarketplaceListing;
      const existingAtPreparation = (
        await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
      ).plugins[staged.candidate.manifest.id];
      const installedUpdate = context?.installedUpdate;
      const updatePolicy = installedUpdate?.updatePolicy
        ?? expectedMarketplaceListing?.updatePolicy
        ?? 'manual';

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
      const reviewedGeneration = await createImmutablePluginGenerationRecordFromSource({
        pluginId: staged.candidate.manifest.id,
        sourceRootPath: staged.candidate.rootPath,
        manifestRelativePath: PACKAGE_MANIFEST_PATH,
        distribution,
        updatePolicy,
        createdAtMs: 0,
        immutableGenerationId: 'reviewed-npm-candidate',
      });
      if (reviewedGeneration.manifestDigest !== staged.candidate.manifest.digest) {
        throw new Error('Npm candidate manifest digest differs between staging and immutable-generation validation');
      }
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
          updatePolicy,
        },
        integrity: reviewedGeneration,
        uiArtifacts: {
          verification: 'verified',
          contributionIds: staged.candidate.generatedUiArtifacts.contributionIds,
        },
      });
      const requiresReview = !(await canApplyAutomaticNpmUpdate({
        existing: existingAtPreparation,
        candidate: staged.candidate.manifest.value,
        distribution,
        updatePolicy,
        approvedUpdateBasis: Boolean(installedUpdate)
          || expectedMarketplaceListing?.review.status === 'approved',
      }));
      let cleanupPromise: Promise<void> | undefined;
      const cleanup = () => {
        cleanupPromise ??= cleanupOwnedCandidate({ operationRootPath, candidate: staged.candidate });
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
              resolvedDigest: staged.candidate.source.integrity,
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
                manifestDigest: staged.candidate.manifest.digest,
                installedPath: null,
              },
              state: { enabled: true, lastLoadedAtMs: nowMs(), lastError: null },
            };
            const store = createPluginRegistryStateStore({
              happyHomeDir: params.happyHomeDir,
              runtimeLifecycle: params.runtimeLifecycle,
              onApplied: control?.onApplied,
            });
            const transaction = await store.install({
              pluginId: staged.candidate.manifest.id,
              sourceRootPath: staged.candidate.rootPath,
              manifestRelativePath: PACKAGE_MANIFEST_PATH,
              catalogRecord,
              trust,
              updatePolicy,
              optionalAccess,
              reviewedPackageDigest: reviewedGeneration.packageDigest,
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
                  message: error instanceof Error ? error.message : String(error),
                };
          }
        },
        cleanup,
      });
    } catch (error) {
      try {
        await cleanupOwnedCandidate({ operationRootPath, ...(stagedCandidate ? { candidate: stagedCandidate } : {}) });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Npm candidate preparation and cleanup both failed');
      }
      throw error;
    }
  };
}
