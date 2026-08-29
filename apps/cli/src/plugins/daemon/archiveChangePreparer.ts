import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginSourceSpecV1 } from '@happier-dev/protocol';

import {
  cleanupStagedNpmCompatiblePluginArchive,
  DEFAULT_PORTABLE_ARCHIVE_LIMITS,
  stageNpmCompatiblePluginArchive,
  type StagedNpmCompatiblePluginArchive,
} from '@/plugins/distribution/archive';
import {
  downloadRemoteFileWithLimits,
  resolvePluginRemoteArchiveMaxBytes,
} from '@/plugins/discovery/remote/fetch';
import {
  createArchivePluginDistributionIdentity,
  createPluginTrustRecord,
  type PluginDistributionIdentity,
} from '@/plugins/store/install/trustIdentity';
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
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { createVerifiedPortablePluginInstallationAvailability } from '@/plugins/availability/releaseFacts';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';

import type {
  PluginChangeRequest,
  PreparedDaemonPluginChangeCandidate,
} from './changeContract';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
import { projectPluginInstallationReview } from './installationReview';
import { projectPluginTransactionChangeResult } from './transactionChangeResult';
import { createSelectedPluginOptionalAccess } from './optionalAccessSelections';
import { createDaemonPluginCandidateOperationRoot } from './candidateStorage';

const PACKAGE_MANIFEST_PATH = '.happier-plugin/plugin.json';

function readRemoteArchiveUrl(locator: string): string | null {
  try {
    const value = locator.trim();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function hashArchive(path: string): Promise<Readonly<{
  byteLength: number;
  integrity: string;
  archiveDigestSha256: `sha256:${string}`;
}>> {
  const hash = createHash('sha256');
  let byteLength = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += bytes.byteLength;
    hash.update(bytes);
  }
  const digest = hash.digest();
  return Object.freeze({
    byteLength,
    integrity: `sha256-${digest.toString('base64')}`,
    archiveDigestSha256: `sha256:${digest.toString('hex')}`,
  });
}

async function materializeArchive(params: Readonly<{
  locator: string;
  destinationPath: string;
}>): Promise<Readonly<{
  distributionSource:
    | Readonly<{ kind: 'localFile'; path: string }>
    | Readonly<{ kind: 'remoteUrl'; url: string }>;
  byteLength: number;
  integrity: string;
  archiveDigestSha256: `sha256:${string}`;
}>> {
  const maximumBytes = Math.min(
    resolvePluginRemoteArchiveMaxBytes(),
    DEFAULT_PORTABLE_ARCHIVE_LIMITS.maxExpandedBytes,
  );
  const remoteUrl = readRemoteArchiveUrl(params.locator);
  if (remoteUrl) {
    await downloadRemoteFileWithLimits({
      url: remoteUrl,
      destinationPath: params.destinationPath,
      maxBytes: maximumBytes,
      errorLabel: 'Remote plugin archive',
    });
    const facts = await hashArchive(params.destinationPath);
    return Object.freeze({
      distributionSource: Object.freeze({
        kind: 'remoteUrl',
        url: remoteUrl,
      }),
      ...facts,
    });
  }

  const sourcePath = expandHomeDirPath(params.locator.trim());
  const sourceStat = await lstat(sourcePath);
  if ((!sourceStat.isFile() && !sourceStat.isSymbolicLink()) || sourceStat.size > maximumBytes) {
    throw new Error(`Local plugin archive exceeds the configured size limit (${maximumBytes} bytes) or is not a file`);
  }
  await copyFile(sourcePath, params.destinationPath);
  const copiedStat = await lstat(params.destinationPath);
  if (!copiedStat.isFile() || copiedStat.isSymbolicLink() || copiedStat.size > maximumBytes) {
    throw new Error('Local plugin archive could not be copied into daemon-owned temporary storage');
  }
  const facts = await hashArchive(params.destinationPath);
  return Object.freeze({
    distributionSource: Object.freeze({ kind: 'localFile', path: sourcePath }),
    ...facts,
  });
}

function archiveLocator(distribution: PluginDistributionIdentity): string {
  if (distribution.kind !== 'archive') throw new Error('Expected archive distribution identity');
  return distribution.source.kind === 'localFile'
    ? distribution.source.canonicalPath
    : distribution.source.canonicalUrl;
}

async function cleanupOwnedCandidate(params: Readonly<{
  operationRootPath: string;
  candidate?: StagedNpmCompatiblePluginArchive;
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
      await cleanupStagedNpmCompatiblePluginArchive(params.candidate);
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

export function createDaemonArchivePluginChangePreparer(params: Readonly<{
  happyHomeDir: string;
  runtimeLifecycle: PluginRegistryRuntimeLifecycle;
  onRegistryApplied?: (record: PluginRegistryCommitRecord) => void;
  nowMs?: () => number;
}>): (request: PluginChangeRequest) => Promise<PreparedDaemonPluginChangeCandidate> {
  const nowMs = params.nowMs ?? Date.now;

  return async (request) => {
    if (request.kind !== 'installArchive') {
      throw new Error(`Plugin change '${request.kind}' is not implemented by the archive candidate adapter`);
    }

    const operationRootPath = await createDaemonPluginCandidateOperationRoot({
      happyHomeDir: params.happyHomeDir,
      kind: 'archive',
    });
    let stagedCandidate: StagedNpmCompatiblePluginArchive | undefined;
    let preparedGeneration: OwnedPreparedImmutablePluginGeneration | undefined;
    try {
      const materialized = await materializeArchive({
        locator: request.locator,
        destinationPath: join(operationRootPath, 'candidate.tgz'),
      });
      if (request.expectedIntegrity && request.expectedIntegrity !== materialized.integrity) {
        throw new Error('Archive plugin candidate integrity does not match the caller-supplied SHA-256 pin');
      }
      const distribution = await createArchivePluginDistributionIdentity({
        source: materialized.distributionSource,
        integrity: materialized.integrity,
      });
      const staged = await stageNpmCompatiblePluginArchive({
        archivePath: join(operationRootPath, 'candidate.tgz'),
        byteLength: materialized.byteLength,
        integrity: materialized.integrity,
        archiveDigestSha256: materialized.archiveDigestSha256,
        stagingParentPath: join(operationRootPath, 'staging'),
      });
      if (!staged.ok) {
        throw new Error(`Archive plugin candidate rejected (${staged.rejection.code}): ${staged.rejection.message}`);
      }
      stagedCandidate = staged.candidate;
      const availability = createVerifiedPortablePluginInstallationAvailability({
        sourceClass: 'versionedArchive',
        archiveDigestSha256: staged.candidate.archiveDigestSha256,
        manifest: staged.candidate.manifest.value,
        generatedUiArtifacts: staged.candidate.generatedUiArtifacts.manifest,
        packageAssetArchive: staged.candidate.packageAssetArchive.descriptor,
      });
      const candidateGeneration = await prepareOwnedImmutablePluginGeneration({
        paths: resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }),
        pluginId: staged.candidate.manifest.id,
        sourceRootPath: staged.candidate.rootPath,
        manifestRelativePath: PACKAGE_MANIFEST_PATH,
        distribution,
        updatePolicy: 'manual',
        createdAtMs: nowMs(),
      });
      preparedGeneration = candidateGeneration;

      const canonicalLocator = archiveLocator(distribution);
      const review = projectPluginInstallationReview({
        manifest: staged.candidate.manifest.value,
        source: {
          kind: 'archive',
          locator: canonicalLocator,
          integrity: materialized.integrity,
          integrityBasis: request.expectedIntegrity ? 'expected' : 'observed',
          packageName: staged.candidate.package.name,
          publisher: { status: 'unavailable' },
          signature: { status: 'notProvided' },
          provenance: { status: 'notProvided' },
          curation: { status: 'notApplicable' },
          updatePolicy: 'manual',
        },
        uiArtifacts: {
          verification: 'verified',
          contributionIds: staged.candidate.generatedUiArtifacts.contributionIds,
        },
      });
      const installReviewPrincipal = derivePluginInstallReviewPrincipal(review);
      const existingAtPreparation = (
        await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
      ).plugins[staged.candidate.manifest.id];
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
        requiresReview: true,
        async apply(decision, control) {
          if (!decision) return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          try {
            const existingAtApply = (
              await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
            ).plugins[staged.candidate.manifest.id];
            if (JSON.stringify(existingAtApply) !== JSON.stringify(existingAtPreparation)) {
              return { kind: 'conflict' as const, pluginId: staged.candidate.manifest.id };
            }
            const optionalAccess = createSelectedPluginOptionalAccess({
              pluginId: staged.candidate.manifest.id,
              declarations: staged.candidate.manifest.value.hostAccess.optional,
              decisions: decision.optionalSelections,
              selectedAtMs: decision.actorEvidence.occurredAtMs,
            });
            const approvedAtMs = decision.actorEvidence.occurredAtMs;
            const trust = createPluginTrustRecord({
              pluginId: staged.candidate.manifest.id,
              distribution,
              approvedAtMs,
            });
            const source: PluginSourceSpecV1 = {
              kind: 'archive',
              locator: canonicalLocator,
              trustPolicy: 'prompt',
              installPolicy: 'managed_install',
              resolvedVersion: staged.candidate.manifest.version,
              installedAt: approvedAtMs,
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
              updatePolicy: 'manual',
              optionalAccess,
              availability,
              admittedIntegrity: materialized.integrity,
              preparedGeneration: candidateGeneration,
              installReviewPrincipalDigest: installReviewPrincipal.digest,
              installReviewPrincipalPresentation: installReviewPrincipal.presentation,
            });
            if (transaction.status !== 'committed' && transaction.status !== 'outcomeUnknown') {
              throw new Error(`Archive installation ended without a committed registry transaction (${transaction.status})`);
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
        throw new AggregateError([error, cleanupError], 'Archive candidate preparation and cleanup both failed');
      }
      throw error;
    }
  };
}
