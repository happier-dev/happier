import { resolveLocalPathPluginSource } from '@/plugins/discovery/sources/localPath';
import {
  createPluginRegistryStateStore,
  PluginRegistryCandidateConflictError,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import {
  createImmutablePluginGenerationRecordFromSource,
  readCurrentCommittedPluginGenerations,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
} from '@/plugins/store/install/trustIdentity';
import { relative } from 'node:path';
import type { PluginStateRecord } from '@/plugins/store/state';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { readPluginManifest } from '@/plugins/manifest/read';

import type {
  PluginChangeRequest,
  PreparedDaemonPluginChange,
} from './changeContract';
import { projectPluginInstallationReview } from './installationReview';
import { projectPluginTransactionChangeResult } from './transactionChangeResult';
import {
  materializePluginDevelopmentCandidate,
  type RunManagedPluginPnpmBoundary,
} from './developmentCandidateMaterializer';
import { createSelectedPluginOptionalAccess } from './optionalAccessSelections';
import {
  hasReviewSensitivePluginUpdate,
  preserveValidPluginOptionalSelections,
} from './updateReviewPolicy';

function hasDaemonExecution(manifest: CanonicalPluginManifest): boolean {
  return Boolean(manifest.entrypoints?.daemon || manifest.entrypoints?.development);
}

export function createDaemonPathPluginChangePreparer(params: Readonly<{
  happyHomeDir: string;
  runtimeLifecycle: PluginRegistryRuntimeLifecycle;
  runManagedPluginPnpm?: RunManagedPluginPnpmBoundary;
}>): (request: PluginChangeRequest) => Promise<PreparedDaemonPluginChange> {
  return async (request) => {
    const expectedDevelopmentPluginId = request.kind === 'development'
      ? request.pluginId
      : null;
    if (request.kind === 'development') {
      request = Object.freeze({
        kind: 'installPath',
        locator: request.sourceRootPath,
        development: true,
        ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
      });
    }
    if (
      request.kind === 'enable'
      || request.kind === 'disable'
      || request.kind === 'rollback'
      || request.kind === 'uninstall'
      || request.kind === 'forgetTrust'
    ) {
      const stateRequest = request;
      const store = createPluginRegistryStateStore({
        happyHomeDir: params.happyHomeDir,
        runtimeLifecycle: params.runtimeLifecycle,
      });
      const existing = (await store.read()).plugins[stateRequest.pluginId];
      const clearsAbsentHealthHistory = stateRequest.kind === 'uninstall'
        && stateRequest.clearHealthHistory === true
        && !existing;
      if (!existing && !clearsAbsentHealthHistory) throw new Error(`Unknown plugin id: ${stateRequest.pluginId}`);
      if (stateRequest.kind === 'uninstall' && existing?.source.kind === 'bundled') {
        throw new Error(`Bundled first-party plugin '${stateRequest.pluginId}' cannot be uninstalled`);
      }

      return Object.freeze({
        pluginId: stateRequest.pluginId,
        requiresReview: false,
        async apply(_decision, control) {
          const store = createPluginRegistryStateStore({
            happyHomeDir: params.happyHomeDir,
            runtimeLifecycle: params.runtimeLifecycle,
            onApplied: control?.onApplied,
          });
          const generationBeforeMutation = (
            await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({
              happyHomeDir: params.happyHomeDir,
            }))
          )?.generations.get(stateRequest.pluginId)?.immutableGenerationId ?? null;
          let transaction: Awaited<ReturnType<typeof store.updateWithResult>>['transaction'] | null = null;
          if (stateRequest.kind === 'enable' || stateRequest.kind === 'disable') {
            const enabled = stateRequest.kind === 'enable';
            transaction = (await store.setEnabledWithResult(stateRequest.pluginId, enabled))?.transaction ?? null;
          } else if (stateRequest.kind === 'rollback') {
            transaction = (await store.rollbackWithResult(stateRequest.pluginId)).transaction;
          } else if (stateRequest.kind === 'uninstall') {
            transaction = (await store.uninstallWithResult(stateRequest.pluginId, {
              clearHealthHistory: stateRequest.clearHealthHistory === true,
            }))?.transaction ?? null;
          } else {
            transaction = (await store.forgetTrustWithResult(stateRequest.pluginId))?.transaction ?? null;
          }
          const generation = transaction
            ? transaction.record.pluginGenerations[stateRequest.pluginId]?.immutableGenerationId ?? null
            : generationBeforeMutation;
          return projectPluginTransactionChangeResult({
            pluginId: stateRequest.pluginId,
            desiredGeneration: generation,
            transaction,
          });
        },
        cleanup: async () => undefined,
      });
    }
    if (request.kind !== 'installPath') {
      throw new Error(`Plugin change '${request.kind}' is not implemented by the path candidate adapter`);
    }
    const resolved = await resolveLocalPathPluginSource({ locator: request.locator });
    if (!resolved.ok) {
      throw new Error(resolved.diagnostics.map((diagnostic) => diagnostic.message).join('\n') || 'Invalid plugin path source');
    }
    if (expectedDevelopmentPluginId && resolved.manifest.id !== expectedDevelopmentPluginId) {
      return Object.freeze({
        pluginId: expectedDevelopmentPluginId,
        requiresReview: false,
        apply: async () => ({
          kind: 'conflict' as const,
          pluginId: expectedDevelopmentPluginId,
        }),
        cleanup: async () => undefined,
      });
    }
    const distribution = await createLocalPathPluginDistributionIdentity(resolved.pluginRootPath);
    const currentCatalog = await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read();
    const existingAtPreparation = currentCatalog.plugins[resolved.manifest.id];
    let preservedOptionalSelections:
      ReturnType<typeof preserveValidPluginOptionalSelections> = null;
    if (
      request.development
      && existingAtPreparation
      && isPluginTrustRecordAuthorized(existingAtPreparation.install.trust, {
        pluginId: resolved.manifest.id,
        distribution,
        realm: hasDaemonExecution(resolved.manifest) ? 'daemon' : 'declarative',
      })
    ) {
      const previous = await readPluginManifest({
        manifestPath: existingAtPreparation.source.manifestPath,
      });
      if (
        previous.ok
        && previous.manifestDigest === existingAtPreparation.install.manifestDigest
        && previous.manifest.id === resolved.manifest.id
        && !hasReviewSensitivePluginUpdate(previous.manifest, resolved.manifest)
      ) {
        preservedOptionalSelections = preserveValidPluginOptionalSelections(
          resolved.manifest.id,
          resolved.manifest,
          existingAtPreparation.install.optionalAccess ?? [],
        );
      }
    }
    const requiresReview = preservedOptionalSelections === null;
    const developmentCandidate = request.development
      ? await materializePluginDevelopmentCandidate({
          happyHomeDir: params.happyHomeDir,
          sourceRootPath: resolved.pluginRootPath,
          sdkRegistryOrigin: request.sdkRegistryOrigin,
        }, {
          ...(params.runManagedPluginPnpm ? { runManagedPluginPnpm: params.runManagedPluginPnpm } : {}),
        })
      : null;
    const installationSourceRootPath = developmentCandidate?.rootPath ?? resolved.pluginRootPath;
    let reviewedGeneration: Awaited<ReturnType<typeof createImmutablePluginGenerationRecordFromSource>>;
    try {
      reviewedGeneration = await createImmutablePluginGenerationRecordFromSource({
          pluginId: resolved.manifest.id,
          sourceRootPath: installationSourceRootPath,
          manifestRelativePath: relative(resolved.pluginRootPath, resolved.manifestPath).split('\\').join('/'),
          distribution,
          updatePolicy: 'manual',
          createdAtMs: 0,
          immutableGenerationId: 'reviewed-source-fingerprint',
        });
      if (reviewedGeneration.manifestDigest !== resolved.manifestDigest) {
        throw new Error('Path candidate manifest changed during static preparation');
      }
    } catch (error) {
      await developmentCandidate?.cleanup();
      throw error;
    }
    const reviewedPackageDigest = reviewedGeneration.packageDigest;
    const review = projectPluginInstallationReview({
      manifest: resolved.manifest,
      source: {
        kind: 'path',
        locator: resolved.pluginRootPath,
        development: request.development,
        packageName: null,
        publisher: { status: 'unavailable' },
        signature: { status: 'notProvided' },
        provenance: { status: 'notProvided' },
        curation: { status: 'notApplicable' },
        updatePolicy: 'manual',
      },
      integrity: reviewedGeneration,
      uiArtifacts: { verification: 'unavailable', contributionIds: [] },
    });

    return Object.freeze({
      pluginId: resolved.manifest.id,
      review,
      requiresReview,
      async apply(decision, control) {
        if (!request.development) {
          const currentPackageDigest = (await createImmutablePluginGenerationRecordFromSource({
            pluginId: resolved.manifest.id,
            sourceRootPath: resolved.pluginRootPath,
            manifestRelativePath: relative(resolved.pluginRootPath, resolved.manifestPath).split('\\').join('/'),
            distribution,
            updatePolicy: 'manual',
            createdAtMs: 0,
            immutableGenerationId: 'approval-source-fingerprint',
          })).packageDigest;
          if (currentPackageDigest !== reviewedPackageDigest) {
            return { kind: 'conflict' as const, pluginId: resolved.manifest.id };
          }
        }
        const existingAtApply = (
          await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
        ).plugins[resolved.manifest.id];
        if (JSON.stringify(existingAtApply) !== JSON.stringify(existingAtPreparation)) {
          return { kind: 'conflict' as const, pluginId: resolved.manifest.id };
        }
        if (requiresReview && !decision) {
          return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
        }
        try {
          const approvedAtMs = decision?.actorEvidence.occurredAtMs
            ?? existingAtApply?.install.trust?.approvedAtMs
            ?? Date.now();
          const trust = decision
            ? createPluginTrustRecord({
                pluginId: resolved.manifest.id,
                distribution,
                approvedAtMs,
              })
            : existingAtApply?.install.trust;
          if (!trust || !isPluginTrustRecordAuthorized(trust, {
            pluginId: resolved.manifest.id,
            distribution,
            realm: hasDaemonExecution(resolved.manifest) ? 'daemon' : 'declarative',
          })) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          const optionalAccess = decision
            ? createSelectedPluginOptionalAccess({
                pluginId: resolved.manifest.id,
                declarations: resolved.manifest.hostAccess.optional,
                decisions: decision.optionalSelections,
                selectedAtMs: approvedAtMs,
              })
            : preservedOptionalSelections;
          if (!optionalAccess) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          const source = {
            ...resolved.sourceSpec,
            kind: 'path' as const,
            locator: resolved.pluginRootPath,
            trustPolicy: 'prompt' as const,
            installPolicy: 'link' as const,
            resolvedPath: resolved.pluginRootPath,
            manifestPath: resolved.manifestPath,
            resolvedVersion: resolved.manifest.version,
            resolvedDigest: resolved.manifestDigest,
            installedAt: existingAtApply?.source.installedAt ?? approvedAtMs,
            ...(request.development ? { devWatch: true } : {}),
          };
          const catalogRecord: PluginStateRecord = {
            source,
            compatibility: { status: 'compatible', diagnostics: [] },
            install: {
              mode: 'link',
              manifestVersion: resolved.manifest.version,
              manifestDigest: resolved.manifestDigest,
              installedPath: null,
            },
            state: { enabled: true, lastLoadedAtMs: Date.now(), lastError: null },
          };
          const store = createPluginRegistryStateStore({
            happyHomeDir: params.happyHomeDir,
            runtimeLifecycle: params.runtimeLifecycle,
            onApplied: control?.onApplied,
          });
          const transaction = await store.install({
            pluginId: resolved.manifest.id,
            sourceRootPath: installationSourceRootPath,
            manifestRelativePath: relative(resolved.pluginRootPath, resolved.manifestPath).split('\\').join('/'),
            catalogRecord,
            trust,
            updatePolicy: existingAtApply?.install.updatePolicy ?? 'manual',
            optionalAccess,
            reviewedPackageDigest,
          });
          if (transaction.status !== 'committed' && transaction.status !== 'outcomeUnknown') {
            throw new Error(`Path installation ended without a committed registry transaction (${transaction.status})`);
          }
          const generation = transaction.record.pluginGenerations[
            resolved.manifest.id
          ]?.immutableGenerationId ?? null;
          return projectPluginTransactionChangeResult({
            pluginId: resolved.manifest.id,
            desiredGeneration: generation,
            transaction,
          });
        } catch (error) {
          return error instanceof PluginRegistryCandidateConflictError
            ? { kind: 'conflict' as const, pluginId: resolved.manifest.id }
            : {
                kind: 'failed' as const,
                code: 'plugin_install_failed',
                message: error instanceof Error ? error.message : String(error),
              };
        }
      },
      cleanup: developmentCandidate?.cleanup ?? (async () => undefined),
    });
  };
}
