import {
  resolveLocalPathPluginSource,
  type ResolvedLocalPathPluginSourceSuccess,
} from '@/plugins/discovery/sources/localPath';
import {
  createPluginRegistryStateStore,
  PluginRegistryCandidateConflictError,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import {
  prepareOwnedImmutablePluginGeneration,
  prepareOwnedPluginDevelopmentGeneration,
  prepareOwnedPluginDevelopmentGenerationFromEdit,
  readCurrentCommittedPluginGenerations,
  type CurrentCommittedPluginGeneration,
  type OwnedPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { PLUGIN_MANIFEST_RELATIVE_PATH, resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
  pluginDistributionIdentitiesEqual,
  type PluginDistributionIdentity,
} from '@/plugins/store/install/trustIdentity';
import { copyFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { PluginStateRecord } from '@/plugins/store/state';
import { serializeCanonicalPluginManifest } from '@/plugins/manifest/serialize';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import type { PreparedPluginActivationGraph } from '@/plugins/runtime/types';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { resolveLocalPluginSourceManifestAuthority } from '@/plugins/manifest/bundledFirstPartyAuthority';
import { readPluginManifest } from '@/plugins/manifest/read';
import {
  evaluateOwnedPluginAuthorGeneration,
  projectEvaluatedPluginDevelopmentSource,
  resolvePluginAuthoringSource,
} from '@/plugins/authoring/sourceModule';
import { isPluginDevelopmentDependencyInputPath } from '@/plugins/authoring/developmentDependencyInputs';
import {
  runPluginUiArtifactBuild,
  type PluginUiArtifactBuildResult,
} from '@/plugins/authoring/toolchain';
import { prefixPluginDiagnosticSourceLocation } from '@/plugins/validation/diagnostics/sourceLocation';

import type {
  PluginChangeRequest,
  PreparedDaemonPluginChange,
} from './changeContract';
import { DaemonPluginChangePreparationError } from './changeService';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
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

type RunPluginUiArtifactBuildBoundary = (params: Readonly<{
  projectRoot: string;
  signal?: AbortSignal;
}>) => Promise<PluginUiArtifactBuildResult>;

async function buildOwnedPluginDevelopmentUiArtifacts(params: Readonly<{
  projectRoot: string;
  runPluginUiArtifactBuild?: RunPluginUiArtifactBuildBoundary;
}>): Promise<void> {
  const build = await (params.runPluginUiArtifactBuild ?? runPluginUiArtifactBuild)({
    projectRoot: params.projectRoot,
  });
  if (build.ok) return;
  // The change contract carries one failure string, not structured
  // diagnostics, so the author's file and line lead the text instead.
  throw new DaemonPluginChangePreparationError(
    'plugin_dev_ui_build_failed',
    prefixPluginDiagnosticSourceLocation(
      build.diagnostics.find((diagnostic) => diagnostic.source)?.source,
      build.diagnostics.map((diagnostic) => diagnostic.message).join('\n') || 'Plugin UI build failed',
    ),
  );
}

/**
 * The path change preparer is the only caller that decides whether a captured
 * development batch needs a fresh dependency closure. Both code-defined and
 * manifest-defined development sources delegate the actual isolated install
 * to this same candidate materializer.
 */
async function materializeDaemonOwnedPluginDevelopmentCandidate(params: Readonly<{
  happyHomeDir: string;
  sourceRootPath: string;
  sdkRegistryOrigin?: string;
  destinationRootPath?: string;
  runManagedPluginPnpm?: RunManagedPluginPnpmBoundary;
}>): Promise<Awaited<ReturnType<typeof materializePluginDevelopmentCandidate>>> {
  try {
    return await materializePluginDevelopmentCandidate({
      happyHomeDir: params.happyHomeDir,
      sourceRootPath: params.sourceRootPath,
      ...(params.sdkRegistryOrigin ? { sdkRegistryOrigin: params.sdkRegistryOrigin } : {}),
      ...(params.destinationRootPath ? { destinationRootPath: params.destinationRootPath } : {}),
    }, {
      ...(params.runManagedPluginPnpm ? { runManagedPluginPnpm: params.runManagedPluginPnpm } : {}),
    });
  } catch (error) {
    throw new DaemonPluginChangePreparationError(
      'plugin_dev_dependency_preparation_failed',
      projectPluginFailureText(error),
    );
  }
}

function isSourceOnlyDevelopmentBatch(params: Readonly<{
  expectedPluginId: string | null | undefined;
  changedPaths: readonly string[] | undefined;
}>): params is Readonly<{
  expectedPluginId: string;
  changedPaths: readonly string[];
}> {
  return typeof params.expectedPluginId === 'string'
    && params.changedPaths !== undefined
    && params.changedPaths.length > 0
    && params.changedPaths.every((path) => !isPluginDevelopmentDependencyInputPath(path));
}

async function readReusableCurrentDevelopmentGeneration(params: Readonly<{
  happyHomeDir: string;
  paths: ReturnType<typeof resolvePluginStorePaths>;
  pluginId: string;
  distribution: PluginDistributionIdentity;
}>): Promise<CurrentCommittedPluginGeneration | undefined> {
  const [catalog, committed] = await Promise.all([
    createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read(),
    readCurrentCommittedPluginGenerations(params.paths),
  ]);
  const catalogRecord = catalog.plugins[params.pluginId];
  const generation = committed?.generations.get(params.pluginId);
  if (
    catalogRecord?.source.kind !== 'path'
    || catalogRecord.source.devWatch !== true
    || !generation?.installation
    || !pluginDistributionIdentitiesEqual(
      generation.installation.source.distribution,
      params.distribution,
    )
  ) {
    return undefined;
  }
  return generation;
}

type ResolvedDaemonDevelopmentSource = ResolvedLocalPathPluginSourceSuccess & Readonly<{
  sourceLocator: string;
  manifestRelativePath: string;
  sourceKind: 'singleFile' | 'packageRoot';
  /**
   * Exact current generation whose bytes a source-only candidate cloned. This
   * travels to the registry transaction so a same-plugin successor cannot be
   * overwritten by a candidate derived from an older source snapshot.
   */
  developmentBaseGenerationId?: string;
  preparedActivationGraph?: PreparedPluginActivationGraph;
  preparedGeneration?: OwnedPreparedImmutablePluginGeneration;
}>;

const SOURCE_ROOT_APPROVED = Symbol('pluginDevelopmentSourceRootApproved');
type InternalPluginChangeRequest = PluginChangeRequest & Readonly<{
  [SOURCE_ROOT_APPROVED]?: Readonly<{
    distribution: Awaited<ReturnType<typeof createLocalPathPluginDistributionIdentity>>;
    actorEvidence: import('./changeContract').AuthenticatedUserInteraction;
  }>;
}>;

async function resolveDaemonDevelopmentSource(
  locator: string,
): Promise<ResolvedDaemonDevelopmentSource> {
  const resolution = await resolvePluginAuthoringSource(locator);
  if (!resolution.ok) {
    throw new Error(
      resolution.diagnostics.map((entry) => entry.message).join('\n')
        || 'Invalid plugin development source',
    );
  }
  if (resolution.kind === 'manifest') {
    const source = resolution.source;
    return Object.freeze({
      ...source,
      sourceLocator: source.sourceSpec.locator,
      manifestRelativePath: relative(source.pluginRootPath, source.manifestPath).split('\\').join('/'),
      sourceKind: 'packageRoot',
    });
  }

  throw new Error('Executable development code must be evaluated from an owned immutable generation');
}

export function createDaemonPathPluginChangePreparer(params: Readonly<{
  happyHomeDir: string;
  runtimeLifecycle: PluginRegistryRuntimeLifecycle;
  onRegistryApplied?: (record: PluginRegistryCommitRecord) => void;
  runManagedPluginPnpm?: RunManagedPluginPnpmBoundary;
  runPluginUiArtifactBuild?: RunPluginUiArtifactBuildBoundary;
}>): (request: PluginChangeRequest) => Promise<PreparedDaemonPluginChange> {
  const prepare = async (
    request: InternalPluginChangeRequest,
  ): Promise<PreparedDaemonPluginChange> => {
    let trustedDevelopmentPluginId: string | null = null;
    let developmentAuthoringSource: Awaited<ReturnType<typeof resolvePluginAuthoringSource>> | null = null;
    const developmentSourceRootPath = request.kind === 'development'
      ? request.sourceRootPath
      : request.kind === 'installPath' && request.development
        ? request.locator
        : null;
    if (developmentSourceRootPath) {
      const sourceResolution = await resolvePluginAuthoringSource(developmentSourceRootPath);
      developmentAuthoringSource = sourceResolution;
      if (sourceResolution.ok && sourceResolution.kind === 'code') {
        const distribution = await createLocalPathPluginDistributionIdentity(
          sourceResolution.entry.locator,
        );
        if (distribution.kind !== 'localPath') {
          throw new Error('Plugin development source did not resolve to a local path identity');
        }
        const currentCatalog = await createPluginRegistryStateStore({
          happyHomeDir: params.happyHomeDir,
        }).read();
        const trustedMatches = Object.entries(currentCatalog.plugins).filter(
          ([pluginId, record]) => (
            record.source.kind === 'path'
            && record.source.devWatch === true
            && isPluginTrustRecordAuthorized(record.install.trust, {
              pluginId,
              distribution,
              realm: 'daemon',
            })
          ),
        );
        if (trustedMatches.length > 1) {
          throw new Error(
            `Plugin development source is trusted by more than one installed plugin identity: ${distribution.canonicalPath}`,
          );
        }
        trustedDevelopmentPluginId = trustedMatches[0]?.[0] ?? null;
        const approvedSourceRoot = request[SOURCE_ROOT_APPROVED];
        if (
          approvedSourceRoot
          && !pluginDistributionIdentitiesEqual(
            approvedSourceRoot.distribution,
            distribution,
          )
        ) {
          throw new Error('Approved plugin development source root was substituted before evaluation');
        }
        if (!trustedDevelopmentPluginId && !approvedSourceRoot) {
          return Object.freeze({
            kind: 'sourceRootApprovalRequired' as const,
            pendingKey: distribution.canonicalPath,
            review: Object.freeze({
              source: Object.freeze({
                kind: 'path' as const,
                locator: distribution.canonicalPath,
              }),
            }),
            continueAfterSourceRootApproval: async (actorEvidence) => {
              if (
                actorEvidence.kind !== 'authenticatedLocalUser'
                || !actorEvidence.interactionId.trim()
              ) {
                throw new Error('Plugin development source approval requires authenticated actor evidence');
              }
              const approvedSource = await resolvePluginAuthoringSource(developmentSourceRootPath);
              if (!approvedSource.ok || approvedSource.kind !== 'code') {
                throw new Error('Approved plugin development source identity changed before evaluation');
              }
              const currentDistribution = await createLocalPathPluginDistributionIdentity(
                approvedSource.entry.locator,
              );
              if (!pluginDistributionIdentitiesEqual(distribution, currentDistribution)) {
                throw new Error('Approved plugin development source root was substituted before evaluation');
              }
              const continued = await prepare(Object.assign(
                { ...request },
                {
                  [SOURCE_ROOT_APPROVED]: Object.freeze({
                    distribution,
                    actorEvidence,
                  }),
                },
              ));
              if ('kind' in continued) {
                throw new Error('Approved plugin development source unexpectedly requested source-root review again');
              }
              return continued;
            },
            cleanup: async () => undefined,
          });
        }
      }
    }
    const expectedDevelopmentPluginId = developmentSourceRootPath
      ? (request.kind === 'development' ? request.pluginId : undefined)
        ?? trustedDevelopmentPluginId
        ?? undefined
      : null;
    const developmentChangedPaths = request.kind === 'development'
      ? request.changedPaths
      : undefined;
    const developmentSourceBatch = {
      expectedPluginId: expectedDevelopmentPluginId,
      changedPaths: developmentChangedPaths,
    };
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
      const allowsAlreadyAbsent = stateRequest.kind === 'uninstall'
        && stateRequest.allowAlreadyAbsent === true
        && !existing;
      if (!existing && !allowsAlreadyAbsent) throw new Error(`Unknown plugin id: ${stateRequest.pluginId}`);
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
            onApplied: (record) => {
              control?.onApplied();
              params.onRegistryApplied?.(record);
            },
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
            transaction = existing
              ? (await store.uninstallWithResult(stateRequest.pluginId))?.transaction ?? null
              : null;
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
    let resolved = request.development
      && developmentAuthoringSource?.ok
      && developmentAuthoringSource.kind === 'code'
      ? await (async (): Promise<ResolvedDaemonDevelopmentSource> => {
          const entry = developmentAuthoringSource.entry;
          const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
          const distribution = await createLocalPathPluginDistributionIdentity(entry.locator);
          let priorGeneration: CurrentCommittedPluginGeneration | undefined;
          let sourceOnlyChangedPaths: readonly string[] | undefined;
          if (entry.kind === 'packageRoot' && isSourceOnlyDevelopmentBatch(developmentSourceBatch)) {
            sourceOnlyChangedPaths = developmentSourceBatch.changedPaths;
            priorGeneration = await readReusableCurrentDevelopmentGeneration({
              happyHomeDir: params.happyHomeDir,
              paths,
              pluginId: developmentSourceBatch.expectedPluginId,
              distribution,
            });
          }
          const draft = priorGeneration && sourceOnlyChangedPaths
            ? await prepareOwnedPluginDevelopmentGenerationFromEdit({
                paths,
                sourceRootPath: entry.packageRoot,
                changedPaths: sourceOnlyChangedPaths,
                priorReference: { immutableGenerationId: priorGeneration.immutableGenerationId },
                generatedManifestRelativePath: PLUGIN_MANIFEST_RELATIVE_PATH,
              })
            : await prepareOwnedPluginDevelopmentGeneration({
                paths,
                populate: async (rootPath) => {
                  if (entry.kind === 'singleFile') {
                    await copyFile(entry.entryPath, join(rootPath, basename(entry.entryPath)));
                    return;
                  }
                  await materializeDaemonOwnedPluginDevelopmentCandidate({
                    happyHomeDir: params.happyHomeDir,
                    sourceRootPath: entry.packageRoot,
                    destinationRootPath: rootPath,
                    ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
                    ...(params.runManagedPluginPnpm
                      ? { runManagedPluginPnpm: params.runManagedPluginPnpm }
                      : {}),
                  });
                },
              });
          try {
            if (entry.kind === 'packageRoot') {
              await buildOwnedPluginDevelopmentUiArtifacts({
                projectRoot: draft.rootPath,
                ...(params.runPluginUiArtifactBuild
                  ? { runPluginUiArtifactBuild: params.runPluginUiArtifactBuild }
                  : {}),
              });
            }
            const ownedEvaluation = await draft.runWithIntegrityFence(async () => (
              await evaluateOwnedPluginAuthorGeneration({
                locator: entry.kind === 'singleFile'
                  ? join(draft.rootPath, basename(entry.entryPath))
                  : draft.rootPath,
                immutableGenerationId: draft.immutableGenerationId,
                rootPath: draft.rootPath,
              })
            ));
            const projected = projectEvaluatedPluginDevelopmentSource(
              ownedEvaluation.evaluated,
            );
            const preparedGeneration = await draft.finalize({
              pluginId: projected.manifest.id,
              manifestRelativePath: PLUGIN_MANIFEST_RELATIVE_PATH,
              generatedManifestContents: projected.canonicalManifestJson,
              distribution,
              updatePolicy: 'manual',
              createdAtMs: Date.now(),
            });
            const manifestAuthority = await resolveLocalPluginSourceManifestAuthority({
              pluginRootPath: entry.packageRoot,
            });
            const preparedManifest = await readPluginManifest({
              manifestPath: join(
                preparedGeneration.rootPath,
                ...PLUGIN_MANIFEST_RELATIVE_PATH.split('/'),
              ),
              manifestAuthority,
            });
            if (!preparedManifest.ok) {
              throw new Error('Owned plugin development candidate manifest is unavailable');
            }
            return Object.freeze({
              ok: true,
              pluginRootPath: entry.packageRoot,
              manifestPath: preparedManifest.manifestPath,
              manifestAuthority,
              manifest: preparedManifest.manifest,
              sourceSpec: {
                kind: 'path' as const,
                locator: entry.locator,
                trustPolicy: 'prompt' as const,
                installPolicy: 'link' as const,
                resolvedVersion: preparedManifest.manifest.version,
              },
              sourceLocator: entry.locator,
              manifestRelativePath: PLUGIN_MANIFEST_RELATIVE_PATH,
              sourceKind: entry.kind,
              ...(priorGeneration && sourceOnlyChangedPaths
                ? { developmentBaseGenerationId: priorGeneration.immutableGenerationId }
                : {}),
              preparedActivationGraph: ownedEvaluation.graph,
              preparedGeneration,
            });
          } catch (error) {
            await draft.cleanup();
            throw error;
          }
        })()
      : request.development
      ? await resolveDaemonDevelopmentSource(request.locator)
      : await (async (): Promise<ResolvedDaemonDevelopmentSource> => {
          const source = await resolveLocalPathPluginSource({ locator: request.locator });
          if (!source.ok) {
            throw new Error(source.diagnostics.map((entry) => entry.message).join('\n') || 'Invalid plugin path source');
          }
          return Object.freeze({
            ...source,
            sourceLocator: source.sourceSpec.locator,
            manifestRelativePath: relative(source.pluginRootPath, source.manifestPath).split('\\').join('/'),
            sourceKind: 'packageRoot',
          });
        })();
    if (expectedDevelopmentPluginId && resolved.manifest.id !== expectedDevelopmentPluginId) {
      return Object.freeze({
        pluginId: expectedDevelopmentPluginId,
        requiresReview: false,
        apply: async () => ({
          kind: 'conflict' as const,
          pluginId: expectedDevelopmentPluginId,
        }),
        cleanup: resolved.preparedGeneration?.cleanup
          ?? (async () => undefined),
      });
    }
    const distribution = await createLocalPathPluginDistributionIdentity(resolved.sourceLocator);
    if (
      request.development
      && resolved.sourceKind === 'packageRoot'
      && !resolved.preparedGeneration
      && isSourceOnlyDevelopmentBatch(developmentSourceBatch)
    ) {
      const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
      const priorGeneration = await readReusableCurrentDevelopmentGeneration({
        happyHomeDir: params.happyHomeDir,
        paths,
        pluginId: developmentSourceBatch.expectedPluginId,
        distribution,
      });
      if (priorGeneration) {
        const draft = await prepareOwnedPluginDevelopmentGenerationFromEdit({
          paths,
          sourceRootPath: resolved.pluginRootPath,
          changedPaths: developmentSourceBatch.changedPaths,
          priorReference: { immutableGenerationId: priorGeneration.immutableGenerationId },
          generatedManifestRelativePath: resolved.manifestRelativePath,
        });
        try {
          await buildOwnedPluginDevelopmentUiArtifacts({
            projectRoot: draft.rootPath,
            ...(params.runPluginUiArtifactBuild
              ? { runPluginUiArtifactBuild: params.runPluginUiArtifactBuild }
              : {}),
          });
          const preparedGeneration = await draft.finalize({
            pluginId: resolved.manifest.id,
            manifestRelativePath: resolved.manifestRelativePath,
            generatedManifestContents: serializeCanonicalPluginManifest(resolved.manifest),
            distribution,
            updatePolicy: 'manual',
            createdAtMs: Date.now(),
          });
          resolved = Object.freeze({
            ...resolved,
            developmentBaseGenerationId: priorGeneration.immutableGenerationId,
            preparedGeneration,
          });
        } catch (error) {
          await draft.cleanup();
          throw error;
        }
      }
    }
    const developmentCandidate = request.development
      && resolved.sourceKind === 'packageRoot'
      && !resolved.preparedGeneration
      ? await (async () => {
          const candidate = await materializeDaemonOwnedPluginDevelopmentCandidate({
            happyHomeDir: params.happyHomeDir,
            sourceRootPath: resolved.pluginRootPath,
            ...(request.sdkRegistryOrigin ? { sdkRegistryOrigin: request.sdkRegistryOrigin } : {}),
            ...(params.runManagedPluginPnpm ? { runManagedPluginPnpm: params.runManagedPluginPnpm } : {}),
          });
          try {
            await buildOwnedPluginDevelopmentUiArtifacts({
              projectRoot: candidate.rootPath,
              ...(params.runPluginUiArtifactBuild
                ? { runPluginUiArtifactBuild: params.runPluginUiArtifactBuild }
                : {}),
            });
            return candidate;
          } catch (error) {
            await candidate.cleanup();
            throw error;
          }
        })()
      : null;
    const preparedGeneration = await (async (): Promise<OwnedPreparedImmutablePluginGeneration> => {
      try {
        return resolved.preparedGeneration ?? await prepareOwnedImmutablePluginGeneration({
          paths: resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }),
          pluginId: resolved.manifest.id,
          sourceRootPath: developmentCandidate?.rootPath ?? resolved.pluginRootPath,
          manifestRelativePath: resolved.manifestRelativePath,
          distribution,
          updatePolicy: 'manual',
          createdAtMs: Date.now(),
        });
      } catch (error) {
        await developmentCandidate?.cleanup();
        throw error;
      }
    })();
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        let cleanupError: unknown;
        try {
          await preparedGeneration.cleanup();
        } catch (error) {
          cleanupError = error;
        }
        try {
          await developmentCandidate?.cleanup();
        } catch (error) {
          cleanupError ??= error;
        }
        if (cleanupError) throw cleanupError;
      })();
      return cleanupPromise;
    };
    const candidateManifest = await readPluginManifest({
      manifestPath: join(
        preparedGeneration.rootPath,
        ...preparedGeneration.record.manifestRelativePath.split('/'),
      ),
      manifestAuthority: resolved.manifestAuthority,
    });
    if (!candidateManifest.ok) {
      await cleanup();
      throw new Error('Prepared plugin candidate manifest is unavailable');
    }
    if (
      candidateManifest.manifest.id !== preparedGeneration.record.pluginId
      || candidateManifest.manifest.id !== resolved.manifest.id
    ) {
      await cleanup();
      throw new PluginRegistryCandidateConflictError(
        'Plugin source identity changed while its immutable candidate was being prepared',
      );
    }
    const manifest = candidateManifest.manifest;
    if (expectedDevelopmentPluginId && manifest.id !== expectedDevelopmentPluginId) {
      return Object.freeze({
        pluginId: expectedDevelopmentPluginId,
        requiresReview: false,
        apply: async () => ({
          kind: 'conflict' as const,
          pluginId: expectedDevelopmentPluginId,
        }),
        cleanup,
      });
    }
    const currentCatalog = await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read();
    const existingAtPreparation = currentCatalog.plugins[manifest.id];
    let preservedOptionalSelections:
      ReturnType<typeof preserveValidPluginOptionalSelections> = null;
    if (
      request.development
      && existingAtPreparation
      && isPluginTrustRecordAuthorized(existingAtPreparation.install.trust, {
        pluginId: manifest.id,
        distribution,
        realm: hasDaemonExecution(manifest) ? 'daemon' : 'declarative',
      })
    ) {
      const previous = await readPluginManifest({
        manifestPath: existingAtPreparation.source.manifestPath,
        manifestAuthority: resolved.manifestAuthority,
      });
      if (
        previous.ok
        && previous.manifest.id === manifest.id
        && !hasReviewSensitivePluginUpdate(previous.manifest, manifest)
      ) {
        preservedOptionalSelections = preserveValidPluginOptionalSelections(
          manifest.id,
          manifest,
          existingAtPreparation.install.optionalAccess ?? [],
        );
      }
    }
    const isCodeDevelopmentSource = request.development
      && developmentAuthoringSource?.ok
      && developmentAuthoringSource.kind === 'code';
    const requiresReview = preservedOptionalSelections === null;
    const preservesApprovedDevelopmentReview = request.development
      && developmentChangedPaths !== undefined
      && !requiresReview;
    let review: ReturnType<typeof projectPluginInstallationReview> | undefined;
    let installReviewPrincipal: ReturnType<typeof derivePluginInstallReviewPrincipal> | undefined;
    try {
      if (!preservesApprovedDevelopmentReview) {
        review = projectPluginInstallationReview({
          manifest,
          source: {
            kind: 'path',
            locator: resolved.sourceLocator,
            development: request.development,
            packageName: null,
            publisher: { status: 'unavailable' },
            signature: { status: 'notProvided' },
            provenance: { status: 'notProvided' },
            curation: { status: 'notApplicable' },
            updatePolicy: 'manual',
          },
          uiArtifacts: { verification: 'unavailable', contributionIds: [] },
        });
        installReviewPrincipal = derivePluginInstallReviewPrincipal(review);
      }
    } catch (error) {
      await cleanup();
      throw error;
    }

    return Object.freeze({
      pluginId: manifest.id,
      ...(review ? { review } : {}),
      requiresReview,
      async apply(decision, control) {
        const existingAtApply = (
          await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
        ).plugins[manifest.id];
        if (JSON.stringify(existingAtApply) !== JSON.stringify(existingAtPreparation)) {
          return { kind: 'conflict' as const, pluginId: manifest.id };
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
                pluginId: manifest.id,
                distribution,
                approvedAtMs,
              })
            : existingAtApply?.install.trust;
          if (!trust || !isPluginTrustRecordAuthorized(trust, {
            pluginId: manifest.id,
            distribution,
            realm: hasDaemonExecution(manifest) ? 'daemon' : 'declarative',
          })) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          const optionalAccess = decision
            ? createSelectedPluginOptionalAccess({
                pluginId: manifest.id,
                declarations: manifest.hostAccess.optional,
                decisions: decision.optionalSelections,
                selectedAtMs: decision.actorEvidence.occurredAtMs,
              })
            : preservedOptionalSelections
              ?? (isCodeDevelopmentSource && manifest.hostAccess.optional.length === 0
                ? Object.freeze([])
                : null);
          if (!optionalAccess) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          const source = {
            ...resolved.sourceSpec,
            kind: 'path' as const,
            locator: resolved.sourceLocator,
            trustPolicy: 'prompt' as const,
            installPolicy: 'link' as const,
            resolvedPath: preparedGeneration.rootPath,
            manifestPath: candidateManifest.manifestPath,
            resolvedVersion: manifest.version,
            installedAt: existingAtApply?.source.installedAt ?? approvedAtMs,
            ...(request.development ? { devWatch: true } : {}),
          };
          const catalogRecord: PluginStateRecord = {
            source,
            compatibility: { status: 'compatible', diagnostics: [] },
            install: {
              mode: 'link',
              manifestVersion: manifest.version,
              installedPath: null,
            },
            state: { enabled: true, lastLoadedAtMs: Date.now(), lastError: null },
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
            pluginId: manifest.id,
            catalogRecord,
            trust,
            updatePolicy: existingAtApply?.install.updatePolicy ?? 'manual',
            optionalAccess,
            preparedGeneration,
            ...(installReviewPrincipal
              ? {
                  installReviewPrincipalDigest: installReviewPrincipal.digest,
                  installReviewPrincipalPresentation: installReviewPrincipal.presentation,
                }
              : {}),
            ...(preservesApprovedDevelopmentReview && developmentChangedPaths !== undefined
              ? { developmentChangedPaths }
              : {}),
            ...(resolved.developmentBaseGenerationId
              ? { developmentBaseGenerationId: resolved.developmentBaseGenerationId }
              : {}),
            ...(resolved.preparedActivationGraph
              ? { preparedActivationGraph: resolved.preparedActivationGraph }
              : {}),
          });
          if (transaction.status !== 'committed' && transaction.status !== 'outcomeUnknown') {
            throw new Error(`Path installation ended without a committed registry transaction (${transaction.status})`);
          }
          const generation = transaction.record.pluginGenerations[
            manifest.id
          ]?.immutableGenerationId ?? null;
          return projectPluginTransactionChangeResult({
            pluginId: manifest.id,
            desiredGeneration: generation,
            transaction,
          });
        } catch (error) {
          return error instanceof PluginRegistryCandidateConflictError
            ? { kind: 'conflict' as const, pluginId: manifest.id }
            : {
                kind: 'failed' as const,
                code: 'plugin_install_failed',
                message: projectPluginFailureText(error),
              };
        }
      },
      cleanup,
    });
  };
  return prepare;
}
