import { isReservedHappierPluginId } from '@happier-dev/protocol/plugins/plugin-id';
import type { ManagedResourceDependencyV1, ManagedResourceDispositionV1 } from '@happier-dev/protocol';
import { runPluginAuthorPhase } from '@/plugins/authoring/phaseLog';

import {
  resolveLocalPathPluginSource,
  type ResolvedLocalPathPluginSourceSuccess,
} from '@/plugins/discovery/sources/localPath';
import {
  createPluginRegistryStateStore,
  PluginRegistryCandidateConflictError,
  resolvePluginUpdatePolicyChangeRejection,
  type PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import type { PluginRegistryCommitRecord } from '@/plugins/store/registry/commitRecord';
import type { PluginGenerationCustodyRetirementRemoteDependencies } from '@/plugins/store/registry/generationCustodyRetirement';
import {
  prepareOwnedImmutablePluginGeneration,
  readCurrentCommittedPluginGenerations,
  readPreparedImmutablePluginGeneration,
  type OwnedPreparedImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  createLocalPathPluginDistributionIdentity,
  createPluginTrustRecord,
  isPluginTrustRecordAuthorized,
} from '@/plugins/store/install/trustIdentity';
import { join, relative } from 'node:path';
import type { PluginStateRecord } from '@/plugins/store/state';
import { projectPluginFailureText } from '@/plugins/runtime/lifecycle/utils';
import { readPluginManifest } from '@/plugins/manifest/read';
import {
  evaluateManifestPluginDevelopmentCandidate,
  evaluatePluginDevelopmentCandidate,
  projectEvaluatedPluginDevelopmentSource,
  resolvePluginAuthoringSource,
} from '@/plugins/authoring/sourceModule';
import { bindPluginRuntimeSourceAuthority } from '@/plugins/runtime/sourceAuthority';
import { isPluginDevelopmentDependencyInputPath } from '@/plugins/authoring/developmentDependencyInputs';
import {
  runPluginUiArtifactBuild,
  type PluginUiArtifactBuildResult,
} from '@/plugins/authoring/toolchain';
import { prefixPluginDiagnosticSourceLocation } from '@/plugins/validation/diagnostics/sourceLocation';
import { preparePluginStorageDataRemoval } from '@/plugins/runtime/context/storage';
import { preparePluginSecretsDataRemoval } from '@/plugins/runtime/context/secrets';

import type {
  PluginDataRemovalStep,
  PluginChangeRequest,
  PreparedDaemonPluginChange,
  PreparedDaemonPluginChangeCandidate,
  PreparedPluginDevelopmentCandidate,
} from './changeContract';
import { DaemonPluginChangePreparationError } from './changeService';
import { derivePluginInstallReviewPrincipal } from './installReviewPrincipal';
import { projectPluginInstallationReview } from './installationReview';
import { projectPluginTransactionChangeResult } from './transactionChangeResult';
import {
  preparePluginDevelopmentRoot,
  type RunManagedPluginPnpmBoundary,
} from './developmentCandidateMaterializer';
import { updateSelectedPluginOptionalAccess } from './optionalAccessSelections';
import {
  evaluatePluginAuthorityReview,
  listInitialPluginAuthorityExpansions,
  type PluginAuthorityReviewEvaluation,
} from './updateReviewPolicy';

export type DaemonPathPluginChangePreparationContext = Readonly<{
  installedUpdate: Readonly<{ pluginId: string }>;
}>;

type RunPluginUiArtifactBuildBoundary = (params: Readonly<{
  projectRoot: string;
  manifest?: Parameters<typeof runPluginUiArtifactBuild>[0]['manifest'];
  signal?: AbortSignal;
}>) => Promise<PluginUiArtifactBuildResult>;

async function buildOwnedPluginDevelopmentUiArtifacts(params: Readonly<{
  projectRoot: string;
  manifest?: Parameters<typeof runPluginUiArtifactBuild>[0]['manifest'];
  runPluginUiArtifactBuild?: RunPluginUiArtifactBuildBoundary;
}>): Promise<void> {
  const build = await (params.runPluginUiArtifactBuild ?? runPluginUiArtifactBuild)({
    projectRoot: params.projectRoot,
    ...(params.manifest ? { manifest: params.manifest } : {}),
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

type ResolvedDaemonLocalPathSource = ResolvedLocalPathPluginSourceSuccess & Readonly<{
  sourceLocator: string;
  manifestRelativePath: string;
}>;

export function createDaemonPathPluginChangePreparer(params: Readonly<{
  happyHomeDir: string;
  runtimeLifecycle: PluginRegistryRuntimeLifecycle;
  onRegistryApplied?: (record: PluginRegistryCommitRecord) => void;
  runManagedPluginPnpm?: RunManagedPluginPnpmBoundary;
  runPluginUiArtifactBuild?: RunPluginUiArtifactBuildBoundary;
  removePluginDataDirectory?: (directoryPath: string) => Promise<void>;
  generationCustodyRetirement?: PluginGenerationCustodyRetirementRemoteDependencies;
  readManagedResources?: (pluginId: string, dispositions?: readonly ManagedResourceDispositionV1[]) =>
    Promise<Readonly<{ resources: readonly ManagedResourceDependencyV1[]; reviewed: boolean }>>;
}>): (
  request: PluginChangeRequest,
  context?: DaemonPathPluginChangePreparationContext,
) => Promise<PreparedDaemonPluginChange> {
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

  const prepare = async (
    request: PluginChangeRequest,
    context?: DaemonPathPluginChangePreparationContext,
  ): Promise<PreparedDaemonPluginChange> => {
    let trustedDevelopmentPluginId: string | null = null;
    let developmentAuthoringSource: Awaited<ReturnType<typeof resolvePluginAuthoringSource>> | null = null;
    const developmentSourceRootPath = request.kind === 'development'
      ? request.sourceRootPath
      : null;
    const developmentCatalog = developmentSourceRootPath
      ? await createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir }).read()
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
        const trustedMatches = Object.entries(developmentCatalog!.plugins).filter(
          ([pluginId, record]) => (
            record.source.kind === 'path'
            && record.source.devWatch === true
            && isPluginTrustRecordAuthorized(record.install.trust, {
              pluginId,
              distribution,
            })
          ),
        );
        if (trustedMatches.length > 1) {
          throw new Error(
            `Plugin development source is trusted by more than one installed plugin identity: ${distribution.canonicalPath}`,
          );
        }
        trustedDevelopmentPluginId = trustedMatches[0]?.[0] ?? null;
      }
    }
    if (developmentSourceRootPath && developmentAuthoringSource?.ok) {
      const authoringSource = developmentAuthoringSource;
      const savedPluginId = (request.kind === 'development' ? request.pluginId : undefined)
        ?? trustedDevelopmentPluginId
        ?? (authoringSource.kind === 'manifest' ? authoringSource.source.manifest.id : undefined);
      if (savedPluginId && developmentCatalog?.plugins[savedPluginId]?.state.enabled === false) {
        throw new DaemonPluginChangePreparationError(
          'plugin_disabled',
          `Plugin '${savedPluginId}' is disabled`,
        );
      }
      const expectedPluginId = request.kind === 'development'
        ? request.pluginId
        : trustedDevelopmentPluginId ?? undefined;
      const entry = authoringSource.kind === 'code'
        ? authoringSource.entry
        : null;
      const canonicalRoot = authoringSource.kind === 'code'
        ? authoringSource.entry.locator
        : authoringSource.source.pluginRootPath;
      const sourceRootPath = authoringSource.kind === 'code'
        ? authoringSource.entry.packageRoot
        : authoringSource.source.pluginRootPath;
      const distribution = await createLocalPathPluginDistributionIdentity(canonicalRoot);
      if (distribution.kind !== 'localPath') {
        throw new Error('Plugin development source did not resolve to a local path identity');
      }
      const changedPaths = request.kind === 'development' ? request.changedPaths : undefined;
      const prepareDependencies = (entry?.kind ?? 'packageRoot') === 'packageRoot'
        && !isSourceOnlyDevelopmentBatch({ expectedPluginId, changedPaths });
      const preparedRoot = await preparePluginDevelopmentRoot({
        sourceRootPath,
        prepareDependencies,
        ...(request.kind === 'development' && request.sdkRegistryOrigin
          ? { sdkRegistryOrigin: request.sdkRegistryOrigin }
          : {}),
      }, {
        ...(params.runManagedPluginPnpm ? { runManagedPluginPnpm: params.runManagedPluginPnpm } : {}),
      }).catch((error: unknown) => {
        throw new DaemonPluginChangePreparationError(
          'plugin_dev_dependency_preparation_failed',
          projectPluginFailureText(error),
          { cause: error },
        );
      });
      try {
        const sourceAuthority = bindPluginRuntimeSourceAuthority({
          custody: { kind: 'development', registeredRootId: distribution.canonicalPath },
          resolvedRoot: preparedRoot.rootPath,
          observedRevision: request.kind === 'development' ? request.observedRevision ?? 0 : 0,
        });
        if (sourceAuthority.kind !== 'development') {
          throw new Error('Development source authority resolved to the wrong source class');
        }
        const evaluated = await runPluginAuthorPhase({
          phase: 'evaluate',
          projectRoot: sourceRootPath,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
        }, async () => developmentAuthoringSource.kind === 'code'
          ? await evaluatePluginDevelopmentCandidate({
              locator: entry!.locator,
              sourceAuthority,
            })
          : await evaluateManifestPluginDevelopmentCandidate({
              source: developmentAuthoringSource.source,
              sourceAuthority,
            }));
        const projected = developmentAuthoringSource.kind === 'code'
          ? projectEvaluatedPluginDevelopmentSource(evaluated.evaluated)
          : evaluated.evaluated;
        if (expectedPluginId && projected.manifest.id !== expectedPluginId) {
          throw new PluginRegistryCandidateConflictError(
            `Plugin development source identity changed from '${expectedPluginId}' to '${projected.manifest.id}'`,
          );
        }
        if ((entry?.kind ?? 'packageRoot') === 'packageRoot') {
          await buildOwnedPluginDevelopmentUiArtifacts({
            projectRoot: preparedRoot.rootPath,
            ...(developmentAuthoringSource.kind === 'code' ? { manifest: projected.manifest } : {}),
            ...(params.runPluginUiArtifactBuild
              ? { runPluginUiArtifactBuild: params.runPluginUiArtifactBuild }
              : {}),
          });
        }
        const registryStateStore = createPluginRegistryStateStore({
          happyHomeDir: params.happyHomeDir,
          runtimeLifecycle: params.runtimeLifecycle,
        });
        await registryStateStore.initialize();
        const registrySnapshot = await registryStateStore.readSnapshot();
        const existing = registrySnapshot.state.plugins[projected.manifest.id];
        const alreadyTrusted = existing?.source.kind === 'path'
          && existing.source.devWatch === true
          && isPluginTrustRecordAuthorized(existing.install.trust, {
            pluginId: projected.manifest.id,
            distribution,
          });
        let incumbentAuthorityManifest = registrySnapshot.approvedAuthorityManifestsByPluginId[projected.manifest.id];
        if (!incumbentAuthorityManifest && existing) {
          const generationReference = registrySnapshot.pluginOccurrenceIds[projected.manifest.id];
          if (generationReference) {
            const incumbentGeneration = await readPreparedImmutablePluginGeneration({
              paths: resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }),
              immutableGenerationId: generationReference.immutableGenerationId,
            });
            const incumbent = await readPluginManifest({
              manifestPath: join(
                incumbentGeneration.rootPath,
                ...incumbentGeneration.record.manifestRelativePath.split('/'),
              ),
              sourceProvenance: incumbentGeneration.record.sourceProvenance,
            });
            if (incumbent.ok && incumbent.manifest.id === projected.manifest.id) {
              incumbentAuthorityManifest = incumbent.manifest;
            }
          }
        }
        const incumbentAuthorityEvaluation = alreadyTrusted && incumbentAuthorityManifest
          ? evaluatePluginAuthorityReview({
              previous: incumbentAuthorityManifest,
              candidate: projected.manifest,
              selectedOptionalAccess: existing.install.optionalAccess ?? [],
              development: true,
            })
          : null;
        const authorityExpansion = incumbentAuthorityEvaluation?.authorityExpansion
          ?? listInitialPluginAuthorityExpansions(projected.manifest);
        const requiresReview = !alreadyTrusted
            || !incumbentAuthorityManifest
            || incumbentAuthorityEvaluation?.requiresReview === true;
        const review = projectPluginInstallationReview({
          manifest: projected.manifest,
          source: {
            kind: 'path',
            locator: distribution.canonicalPath,
            development: true,
            packageName: null,
            publisher: { status: 'unavailable' },
            signature: { status: 'notProvided' },
            provenance: { status: 'notProvided' },
            curation: { status: 'notApplicable' },
            updatePolicy: 'allowed',
          },
          uiArtifacts: { verification: 'unavailable', contributionIds: [] },
        });
        const installReviewPrincipal = derivePluginInstallReviewPrincipal(review);
        const priorPrincipalDigest = registrySnapshot.installReviewPrincipalDigestsByPluginId[projected.manifest.id];
        const priorPrincipalPresentation = registrySnapshot.installReviewPrincipalPresentationsByPluginId[projected.manifest.id];
        const approvedAtMs = Date.now();
        const trust = alreadyTrusted
          ? existing!.install.trust!
          : createPluginTrustRecord({
              pluginId: projected.manifest.id,
              distribution,
              approvedAtMs,
            });
        const catalogRecord: PluginStateRecord = {
          source: {
            kind: 'path',
            locator: distribution.canonicalPath,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: preparedRoot.rootPath,
            manifestPath: authoringSource.kind === 'manifest'
              ? authoringSource.source.manifestPath
              : entry!.entryPath,
            resolvedVersion: projected.manifest.version,
            installedAt: existing?.source.installedAt ?? approvedAtMs,
            devWatch: true,
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'link',
            manifestVersion: projected.manifest.version,
            installedPath: null,
          },
          state: {
            enabled: existing?.state.enabled ?? true,
            lastLoadedAtMs: approvedAtMs,
            lastError: null,
          },
        };
        const candidate: PreparedPluginDevelopmentCandidate = Object.freeze({
          kind: 'preparedDevelopmentCandidate' as const,
          pluginId: projected.manifest.id,
          sourceAuthority,
          manifest: projected.manifest,
          preparedActivationGraph: evaluated.graph,
          registryRevision: registrySnapshot.revision,
          priorOptionalAccess: existing?.install.optionalAccess ?? [],
          preservedOptionalAccess: incumbentAuthorityEvaluation?.preservedOptionalAccess ?? null,
          installReviewPrincipal,
          ...(priorPrincipalDigest && priorPrincipalPresentation
            ? { priorInstallReviewPrincipal: { digest: priorPrincipalDigest, presentation: priorPrincipalPresentation } }
            : {}),
          catalogRecord,
          trust,
          updatePolicy: existing?.install.updatePolicy ?? 'allowed',
          reviewReason: existing
            ? 'authorityExpansion'
            : 'firstInstall',
          ...(existing ? { currentVersion: existing.install.manifestVersion } : {}),
          authorityExpansion,
          requiresReview,
          ...(requiresReview ? { review } : {}),
          cleanup: preparedRoot.cleanup,
        });
        return candidate;
      } catch (error) {
        await preparedRoot.cleanup();
        throw error;
      }
    }
    if (developmentSourceRootPath) {
      const diagnostics = developmentAuthoringSource && !developmentAuthoringSource.ok
        ? developmentAuthoringSource.diagnostics.map((entry) => entry.message).join('\n')
        : '';
      throw new Error(diagnostics || 'Invalid plugin development source');
    }
    if (
      request.kind === 'enable'
      || request.kind === 'disable'
      || request.kind === 'rollback'
      || request.kind === 'uninstall'
      || request.kind === 'uninstallAndDeleteData'
      || request.kind === 'forgetTrust'
      || request.kind === 'setUpdatePolicy'
    ) {
      const stateRequest = request;
      const store = createMutationStore();
      const existing = (await store.read()).plugins[stateRequest.pluginId];
      const allowsAlreadyAbsent = stateRequest.kind === 'uninstallAndDeleteData' && !existing;
      if (!existing && !allowsAlreadyAbsent) throw new Error(`Unknown plugin id: ${stateRequest.pluginId}`);
      if (stateRequest.kind === 'setUpdatePolicy') {
        const rejection = resolvePluginUpdatePolicyChangeRejection(existing, stateRequest.policy);
        if (rejection) {
          throw new DaemonPluginChangePreparationError(rejection.code, rejection.message);
        }
      }
      if (
        (stateRequest.kind === 'uninstall' || stateRequest.kind === 'uninstallAndDeleteData')
        && existing?.source.kind === 'bundled'
      ) {
        throw new Error(`Bundled first-party plugin '${stateRequest.pluginId}' cannot be uninstalled`);
      }
      if (
        stateRequest.kind === 'uninstallAndDeleteData'
        && !existing
        && isReservedHappierPluginId(stateRequest.pluginId)
      ) {
        throw new DaemonPluginChangePreparationError(
          'plugin_data_removal_ownership_unsupported',
          'Destructive data removal is unavailable for an unowned Happier plugin namespace',
        );
      }

      const dataRemoval = stateRequest.kind === 'uninstallAndDeleteData'
        ? await (async () => {
            const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
            try {
              const storage = await preparePluginStorageDataRemoval({
                pluginId: stateRequest.pluginId,
                paths,
                ...(params.removePluginDataDirectory
                  ? { removeDirectory: params.removePluginDataDirectory }
                  : {}),
              });
              const secrets = await preparePluginSecretsDataRemoval({
                pluginId: stateRequest.pluginId,
                paths,
                ...(params.removePluginDataDirectory
                  ? { removeDirectory: params.removePluginDataDirectory }
                  : {}),
              });
              return Object.freeze({ storage, secrets });
            } catch (error) {
              throw new DaemonPluginChangePreparationError(
                'plugin_data_removal_preflight_failed',
                projectPluginFailureText(error),
              );
            }
          })()
        : null;

      return Object.freeze({
        pluginId: stateRequest.pluginId,
        requiresReview: false,
        async apply(_decision, control) {
          if (stateRequest.kind === 'disable' || stateRequest.kind === 'uninstall' || stateRequest.kind === 'uninstallAndDeleteData') {
            let dependencies: Readonly<{ resources: readonly ManagedResourceDependencyV1[]; reviewed: boolean }>;
            try {
              if (!params.readManagedResources) throw new Error('plugin_managed_resource_preflight_unavailable');
              dependencies = await params.readManagedResources(
                stateRequest.pluginId, stateRequest.managedResourceDispositions,
              );
            } catch {
              return { kind: 'unavailable' as const, code: 'plugin_managed_resource_preflight_unavailable' };
            }
            if (!dependencies.reviewed) return { kind: 'managedResourcesReviewRequired' as const,
              pluginId: stateRequest.pluginId, resources: dependencies.resources };
          }
          const store = createMutationStore((record) => {
            // Ordinary registry changes may release after the serving swap.
            // Destructive uninstall keeps exclusion through both owned-directory steps.
            if (stateRequest.kind !== 'uninstallAndDeleteData') control?.onApplied();
            params.onRegistryApplied?.(record);
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
          } else if (
            stateRequest.kind === 'uninstall'
            || stateRequest.kind === 'uninstallAndDeleteData'
          ) {
            transaction = existing
              ? (await store.uninstallWithResult(stateRequest.pluginId))?.transaction ?? null
              : null;
          } else if (stateRequest.kind === 'forgetTrust') {
            transaction = (await store.forgetTrustWithResult(stateRequest.pluginId))?.transaction ?? null;
          } else if (stateRequest.kind === 'setUpdatePolicy') {
            transaction = (await store.setUpdatePolicyWithResult(
              stateRequest.pluginId,
              stateRequest.policy,
            ))?.transaction ?? null;
          }
          const generation = transaction
            ? transaction.record.pluginOccurrenceIds[stateRequest.pluginId]?.immutableGenerationId ?? null
            : generationBeforeMutation;
          const registryResult = projectPluginTransactionChangeResult({
            pluginId: stateRequest.pluginId,
            desiredGeneration: generation,
            transaction,
          });
          if (!dataRemoval || registryResult.kind !== 'committed') return registryResult;

          const completed: PluginDataRemovalStep[] = ['uninstall'];
          const steps = [
            { id: 'daemonStorage' as const, run: dataRemoval.storage.removeDaemon },
            { id: 'secrets' as const, run: dataRemoval.secrets.remove },
          ];
          for (const [index, step] of steps.entries()) {
            try {
              await step.run();
              completed.push(step.id);
            } catch (error) {
              const descriptor = error && typeof error === 'object'
                ? Object.getOwnPropertyDescriptor(error, 'code')
                : undefined;
              const causeCode = descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
                ? descriptor.value
                : 'plugin_data_removal_step_failed';
              return Object.freeze({
                kind: 'dataRemovalPartial' as const,
                pluginId: stateRequest.pluginId,
                completed: Object.freeze([...completed]),
                pending: Object.freeze(steps.slice(index).map(({ id }) => id)),
                causeCode,
              });
            }
          }
          return Object.freeze({
            ...registryResult,
            dataRemoval: Object.freeze({
              alreadyUninstalled: !existing,
              removedData: Object.freeze({
                daemonStorage: dataRemoval.storage.hadDaemonData,
                secrets: dataRemoval.secrets.hadSecrets,
              }),
            }),
          });
        },
        cleanup: async () => undefined,
      });
    }
    if (request.kind !== 'installPath') {
      throw new Error(`Plugin change '${request.kind}' is not implemented by the path candidate adapter`);
    }
    const source = await resolveLocalPathPluginSource({ locator: request.locator });
    if (!source.ok) {
      throw new Error(source.diagnostics.map((entry) => entry.message).join('\n') || 'Invalid plugin path source');
    }
    const resolved: ResolvedDaemonLocalPathSource = Object.freeze({
      ...source,
      sourceLocator: source.sourceSpec.locator,
      manifestRelativePath: relative(source.pluginRootPath, source.manifestPath).split('\\').join('/'),
    });
    const distribution = await createLocalPathPluginDistributionIdentity(resolved.sourceLocator);
    const preparedGeneration: OwnedPreparedImmutablePluginGeneration = await prepareOwnedImmutablePluginGeneration({
      paths: resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir }),
      pluginId: resolved.manifest.id,
      sourceRootPath: resolved.pluginRootPath,
      manifestRelativePath: resolved.manifestRelativePath,
      distribution,
      updatePolicy: 'allowed',
      createdAtMs: Date.now(),
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => {
      cleanupPromise ??= (async () => {
        let cleanupError: unknown;
        try {
          await preparedGeneration.cleanup();
        } catch (error) {
          cleanupError = error;
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
      sourceProvenance: preparedGeneration.record.sourceProvenance,
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
    const registryStateStore = createPluginRegistryStateStore({ happyHomeDir: params.happyHomeDir });
    const preparationSnapshot = await registryStateStore.readSnapshot();
    const existingAtPreparation = preparationSnapshot.state.plugins[manifest.id];
    const priorPrincipalDigest = preparationSnapshot.installReviewPrincipalDigestsByPluginId[manifest.id];
    const priorPrincipalPresentation = preparationSnapshot.installReviewPrincipalPresentationsByPluginId[manifest.id];
    const approvedAuthorityManifest = preparationSnapshot.approvedAuthorityManifestsByPluginId[manifest.id];
    let requiresReview = true;
    let authorityExpansion: PluginAuthorityReviewEvaluation['authorityExpansion'] = [];
    let preservedOptionalAccess: PluginAuthorityReviewEvaluation['preservedOptionalAccess'] = null;
    let review: ReturnType<typeof projectPluginInstallationReview> | undefined;
    let installReviewPrincipal: ReturnType<typeof derivePluginInstallReviewPrincipal> | undefined;
    try {
      review = projectPluginInstallationReview({
          manifest,
          source: {
            kind: 'path',
            locator: resolved.sourceLocator,
            development: false,
            packageName: null,
            publisher: { status: 'unavailable' },
            signature: { status: 'notProvided' },
            provenance: { status: 'notProvided' },
            curation: { status: 'notApplicable' },
            updatePolicy: 'allowed',
          },
          uiArtifacts: { verification: 'unavailable', contributionIds: [] },
      });
      installReviewPrincipal = derivePluginInstallReviewPrincipal(review);
      if (context?.installedUpdate) {
        if (
          context.installedUpdate.pluginId !== manifest.id
          || !existingAtPreparation
          || !priorPrincipalDigest
          || !priorPrincipalPresentation
          || !isPluginTrustRecordAuthorized(existingAtPreparation.install.trust, {
            pluginId: manifest.id,
            distribution,
          })
        ) {
          throw new DaemonPluginChangePreparationError(
            'plugin_update_trust_unavailable',
            `Plugin '${context.installedUpdate.pluginId}' has no current reviewed update authority`,
          );
        }
        if (!approvedAuthorityManifest) {
          throw new DaemonPluginChangePreparationError(
            'plugin_update_trust_unavailable',
            `Plugin '${context.installedUpdate.pluginId}' has no approved authority baseline`,
          );
        }
        const authorityEvaluation = evaluatePluginAuthorityReview({
          previous: approvedAuthorityManifest,
          candidate: manifest,
          selectedOptionalAccess: existingAtPreparation.install.optionalAccess ?? [],
        });
        authorityExpansion = authorityEvaluation.authorityExpansion;
        requiresReview = authorityEvaluation.requiresReview;
        preservedOptionalAccess = authorityEvaluation.preservedOptionalAccess;
      }
    } catch (error) {
      await cleanup();
      throw error;
    }

    const candidate: PreparedDaemonPluginChangeCandidate = Object.freeze({
      pluginId: manifest.id,
      ...(review ? { review } : {}),
      reviewReason: context?.installedUpdate ? 'authorityExpansion' : 'firstInstall',
      ...(context?.installedUpdate && existingAtPreparation
        ? { currentVersion: existingAtPreparation.install.manifestVersion }
        : {}),
      authorityExpansion,
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
          const approvedAtMs = decision
            ? Date.now()
            : existingAtApply?.install.trust?.approvedAtMs ?? Date.now();
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
          })) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          const optionalAccess = decision
            ? updateSelectedPluginOptionalAccess({
                pluginId: manifest.id,
                manifest,
                existing: existingAtApply?.install.optionalAccess ?? [],
                decisions: decision.optionalSelections,
                selectedAtMs: approvedAtMs,
              })
            : preservedOptionalAccess;
          if (!optionalAccess) {
            return { kind: 'failed' as const, code: 'plugin_install_trust_required' };
          }
          const committedInstallReviewPrincipal = decision
            ? installReviewPrincipal
            : priorPrincipalDigest && priorPrincipalPresentation
              ? { digest: priorPrincipalDigest, presentation: priorPrincipalPresentation }
              : undefined;
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
          const store = createMutationStore((record) => {
            control?.onApplied();
            params.onRegistryApplied?.(record);
          });
          const transaction = await store.install({
            pluginId: manifest.id,
            catalogRecord,
            trust,
            updatePolicy: existingAtApply?.install.updatePolicy ?? 'allowed',
            optionalAccess,
            approvedAuthorityManifest: manifest,
            preparedGeneration,
            ...(committedInstallReviewPrincipal
              ? {
                  installReviewPrincipalDigest: committedInstallReviewPrincipal.digest,
                  installReviewPrincipalPresentation: committedInstallReviewPrincipal.presentation,
                }
              : {}),
          });
          if (transaction.status !== 'committed' && transaction.status !== 'outcomeUnknown') {
            throw new Error(`Path installation ended without a committed registry transaction (${transaction.status})`);
          }
          const generation = transaction.record.pluginOccurrenceIds[
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
    return candidate;
  };
  return prepare;
}
