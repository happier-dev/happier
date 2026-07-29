import {
  createMergedContributionRegistry,
  getResolvedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  projectLoadedPluginContributes,
} from '@/plugins/projection/registry/resolvePluginContributions';
import { BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS } from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { loadPluginsFromState } from '@/plugins/discovery/load/installed';
import {
  readCurrentCommittedPluginGenerations,
  readPreparedImmutablePluginGeneration,
  type CurrentCommittedPluginGeneration,
} from '@/plugins/store/registry/generationStore';
import type {
  PluginRegistryRuntimeCandidate,
  PluginRegistryRuntimeLifecycle,
} from '@/plugins/store/registry/currentState';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
  resolveExecutablePluginRuntimeRegistry,
  type PluginRuntimeActivationRegistryLease,
  type PluginRuntimeGenerationAuthority,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { SupervisedPluginActivationAttempt } from '@/plugins/runtime/lifecycle/manager';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type {
  QualifiedConnectedAccountEstablishedRuntimeOwner,
} from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { logger } from '@/ui/logger';

import {
  hasBlockingPluginReloadDiagnostic,
  type PluginRuntimeRegistryBeforePublish,
  type PluginReloadController,
} from './controller';

async function createCandidateGenerationAuthority(params: Readonly<{
  happyHomeDir: string;
  candidate: PluginRegistryRuntimeCandidate;
  isValid: () => boolean;
}>): Promise<PluginRuntimeGenerationAuthority> {
  const paths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
  const bundled = await readCurrentCommittedPluginGenerations(paths, {
    bundledArtifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
    isolateInvalidInstalledGenerations: true,
  });
  const generations = new Map<string, CurrentCommittedPluginGeneration>();
  const unavailableBundledPackageNames = new Set(bundled?.unavailableBundledPackageNames ?? []);
  for (const [pluginId, generation] of bundled?.generations ?? []) {
    if (!generation.installation) generations.set(pluginId, generation);
  }
  for (const [pluginId, reference] of Object.entries(params.candidate.pluginGenerations)) {
    const installation = params.candidate.installationState.plugins[pluginId];
    if (!installation) {
      throw new Error(`Prepared plugin generation is missing installation authority for '${pluginId}'`);
    }
    if (
      !installation.enabled
      || params.candidate.runtimeCatalog.plugins[pluginId]?.state.enabled === false
    ) continue;
    const prepared = await readPreparedImmutablePluginGeneration({
      paths,
      immutableGenerationId: reference.immutableGenerationId,
    });
    if (JSON.stringify(prepared.reference) !== JSON.stringify(reference)) {
      throw new Error(`Prepared plugin generation reference changed for '${pluginId}'`);
    }
    const catalogTrust = params.candidate.runtimeCatalog.plugins[pluginId]?.install.trust;
    if (!installation.trust || !catalogTrust) continue;
    if (JSON.stringify(installation.trust) !== JSON.stringify(catalogTrust)) {
      throw new Error(`Prepared plugin generation catalog trust identity mismatch for '${pluginId}'`);
    }
    generations.set(pluginId, Object.freeze({
      pluginId,
      immutableGenerationId: prepared.record.immutableGenerationId,
      rootPath: prepared.rootPath,
      record: prepared.record,
      installation,
    }));
  }
  return Object.freeze({
    commit: null,
    generations,
    rejectedGenerations: new Map(),
    unavailableBundledPackageNames,
    isCurrent: async () => params.isValid(),
  });
}

async function resolveCandidateContributes(candidate: PluginRegistryRuntimeCandidate) {
  const builtIn = getResolvedContributionRegistry();
  const loadResult = await loadPluginsFromState(candidate.runtimeCatalog);
  const plugin = projectLoadedPluginContributes({
    loadResult,
    provenance: 'external',
    existingAgentIds: new Set(builtIn.agents.map((agent) => agent.id)),
  });
  return createMergedContributionRegistry(plugin);
}

function assertCandidateRuntimeValid(params: Readonly<{
  candidate: PluginRegistryRuntimeCandidate;
  registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
}>): void {
  const executableChangedPluginIds = params.candidate.changedPluginIds.filter((pluginId) => (
    params.candidate.runtimeCatalog.plugins[pluginId]?.state.enabled === true
  ));
  if (!hasBlockingPluginReloadDiagnostic(params.registry, executableChangedPluginIds)) return;
  const diagnostic = executableChangedPluginIds
    .flatMap((pluginId) => params.registry.pluginDiagnosticsByPluginId[pluginId] ?? [])
    .at(0);
  throw new Error(diagnostic?.message ?? 'Prepared plugin runtime registration graph is invalid');
}

export function createDaemonPluginRegistryRuntimeLifecycle(params: Readonly<{
  happyHomeDir: string;
  reloadController: PluginReloadController;
  onActivationAttempt?: (attempt: SupervisedPluginActivationAttempt) => void | Promise<void>;
  connectedAccounts?: StablePluginConnectedAccountsOwner;
  qualifiedConnectedAccountEstablishedRuntimeOwner?:
    Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'invoke'>;
  beforePublish?: PluginRuntimeRegistryBeforePublish;
}>): PluginRegistryRuntimeLifecycle {
  type PreparedActivationCustody = Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    lease: PluginRuntimeActivationRegistryLease;
  }>;
  // A committed candidate remains desired while its short publication is in
  // flight. Keep only its already-prepared per-plugin component so a newer
  // desired graph can retain that exact activation instead of executing it
  // again; durable currentness remains owned by the registry commit.
  const committedPreparedActivationCustodyByPluginId =
    new Map<string, PreparedActivationCustody>();

  async function prepareCandidate(
    candidate: PluginRegistryRuntimeCandidate,
    preparedActivationRegistryLeases: readonly PluginRuntimeActivationRegistryLease[] = Object.freeze([]),
  ): Promise<Awaited<ReturnType<PluginRegistryRuntimeLifecycle['prepare']>>> {
      let valid = true;
      let disposed = false;
      let adopted = false;
      let appliedGenerationsByPluginId:
        Readonly<Record<string, string | null>> | undefined;
      const pendingActivationAttempts: SupervisedPluginActivationAttempt[] = [];
      const publishActivationAttempt = (attempt: SupervisedPluginActivationAttempt): void => {
        if (!params.onActivationAttempt) return;
        try {
          void Promise.resolve(params.onActivationAttempt(attempt)).catch((error) => {
            logger.warn('[PLUGIN RUNTIME] Adopted plugin activation health observer failed', {
              pluginId: attempt.pluginId,
              immutableGenerationId: attempt.immutableGenerationId,
              attemptId: attempt.attemptId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } catch (error) {
          logger.warn('[PLUGIN RUNTIME] Adopted plugin activation health observer failed', {
            pluginId: attempt.pluginId,
            immutableGenerationId: attempt.immutableGenerationId,
            attemptId: attempt.attemptId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      const observeActivationAttempt = (attempt: SupervisedPluginActivationAttempt): void => {
        if (!adopted) {
          pendingActivationAttempts.push(attempt);
          return;
        }
        publishActivationAttempt(attempt);
      };
      const generationAuthority = await createCandidateGenerationAuthority({
        happyHomeDir: params.happyHomeDir,
        candidate,
        isValid: () => valid,
      });
      const activeRegistry = params.reloadController.getState().activeRegistry;
      const activePluginIds = activeRegistry?.activatedPluginIds ?? new Set<string>();
      const changedPluginIds = new Set(candidate.changedPluginIds);
      const retainedPreparedPeerActivationLeases: PluginRuntimeActivationRegistryLease[] = [];
      const retainedPreparedPeerPluginIds = new Set<string>();
      for (const [pluginId, reference] of Object.entries(candidate.pluginGenerations)) {
        if (changedPluginIds.has(pluginId)) continue;
        const custody = committedPreparedActivationCustodyByPluginId.get(pluginId);
        if (
          !custody
          || custody.immutableGenerationId !== reference.immutableGenerationId
          || candidate.installationState.plugins[pluginId]?.enabled !== true
          || candidate.runtimeCatalog.plugins[pluginId]?.state.enabled !== true
        ) {
          continue;
        }
        retainedPreparedPeerActivationLeases.push(custody.lease.retain());
        retainedPreparedPeerPluginIds.add(pluginId);
      }
      const replacedPluginIds = new Set([
        ...changedPluginIds,
        ...retainedPreparedPeerPluginIds,
      ]);
      const unchangedActivePluginIds = new Set(
        [...activePluginIds].filter((pluginId) => !replacedPluginIds.has(pluginId)),
      );
      const activeActivationRegistryLeases = [
        ...(activeRegistry?.retainActivationRegistryComponentsExcluding?.(replacedPluginIds) ?? []),
      ];
      const retainedActivePluginIds = new Set(
        activeActivationRegistryLeases.flatMap((lease) => [...lease.pluginIds]),
      );
      const canReuseActiveRegistry = Boolean(
        activeRegistry
        && [...unchangedActivePluginIds].every((pluginId) => retainedActivePluginIds.has(pluginId)),
      );
      if (!canReuseActiveRegistry) {
        await Promise.all(activeActivationRegistryLeases.map((lease) => lease.release()));
        activeActivationRegistryLeases.length = 0;
      }
      const canPrepareOnlyChangedPlugins = Boolean(
        preparedActivationRegistryLeases.length > 0
        || retainedPreparedPeerActivationLeases.length > 0
        || canReuseActiveRegistry
        || (
          !activeRegistry
          && Object.keys(candidate.pluginGenerations).every((pluginId) => candidate.changedPluginIds.includes(pluginId))
        )
      );
      const activationGeneration = canReuseActiveRegistry && typeof activeRegistry?.generation === 'number'
        ? activeRegistry.generation
        : params.reloadController.getState().generation + 1;
      const retainedActivationRegistryLeases = [
        ...activeActivationRegistryLeases,
        ...retainedPreparedPeerActivationLeases,
        ...preparedActivationRegistryLeases,
      ];
      let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>>;
      try {
        const contributes = await resolveCandidateContributes(candidate);
        registry = await resolveExecutablePluginRuntimeRegistry({
          happyHomeDir: params.happyHomeDir,
          contributes,
          generation: activationGeneration,
          generationAuthority,
          ...(canPrepareOnlyChangedPlugins ? {
            pluginIds: preparedActivationRegistryLeases.length > 0
              ? Object.freeze([])
              : candidate.changedPluginIds,
          } : {}),
          ...(retainedActivationRegistryLeases.length > 0
            ? {
                retainedActivationRegistryLeases:
                  Object.freeze(retainedActivationRegistryLeases),
              }
            : {}),
          ...(preparedActivationRegistryLeases.length > 0
            ? { preparedActivationRegistryLeases }
            : {}),
          ...(params.connectedAccounts ? { connectedAccounts: params.connectedAccounts } : {}),
          ...(params.qualifiedConnectedAccountEstablishedRuntimeOwner
            ? {
                qualifiedConnectedAccountEstablishedRuntimeOwner:
                  params.qualifiedConnectedAccountEstablishedRuntimeOwner,
              }
            : {}),
          ...(params.onActivationAttempt ? { onActivationAttempt: observeActivationAttempt } : {}),
        });
      } catch (error) {
        const cleanup = await Promise.allSettled(
          retainedActivationRegistryLeases.map(async (lease) => await lease.release()),
        );
        const cleanupFailures = cleanup.flatMap((result) => (
          result.status === 'rejected' ? [result.reason] : []
        ));
        if (cleanupFailures.length > 0) {
          throw new AggregateError(
            [error, ...cleanupFailures],
            'Plugin runtime candidate construction and retained component cleanup failed',
          );
        }
        throw error;
      }
      const disposeOnce = async () => {
        if (disposed) return;
        disposed = true;
        valid = false;
        await registry.dispose();
      };
      try {
        if (!registry.activatePluginsForValidation) {
          throw new Error('Prepared plugin runtime registry cannot activate changed plugins for validation');
        }
        await registry.activatePluginsForValidation(candidate.changedPluginIds);
        assertCandidateRuntimeValid({ candidate, registry });
      } catch (error) {
        await disposeOnce();
        throw error;
      }

      return Object.freeze({
        abort: disposeOnce,
        async rebase(nextCandidate) {
          const retainedPreparedActivations = registry.retainPreparedActivationRegistryComponents?.() ?? [];
          if (retainedPreparedActivations.length === 0) {
            throw new Error('Prepared plugin activation cannot be retained across a registry base retry');
          }
          try {
            const rebased = await prepareCandidate(nextCandidate, retainedPreparedActivations);
            await disposeOnce();
            return rebased;
          } catch (error) {
            await Promise.all(retainedPreparedActivations.map((lease) => (
              lease.release().catch(() => undefined)
            )));
            throw error;
          }
        },
        async adopt(record) {
          if (adopted) return appliedGenerationsByPluginId;
          if (JSON.stringify(record.pluginGenerations) !== JSON.stringify(candidate.pluginGenerations)) {
            await disposeOnce();
            throw new Error('Committed plugin generations differ from the prepared runtime candidate');
          }
          const custodyEntries: PreparedActivationCustody[] = [];
          const releasePreparedCustody = async (): Promise<void> => {
            for (const custody of custodyEntries) {
              if (committedPreparedActivationCustodyByPluginId.get(custody.pluginId) === custody) {
                committedPreparedActivationCustodyByPluginId.delete(custody.pluginId);
              }
            }
            await Promise.all(custodyEntries.map(async (custody) => await custody.lease.release()));
          };
          try {
            for (const lease of registry.retainPreparedActivationRegistryComponents?.() ?? []) {
              const pluginIds = [...lease.pluginIds];
              const pluginId = pluginIds.length === 1 ? pluginIds[0] : undefined;
              const immutableGenerationId = pluginId
                ? candidate.pluginGenerations[pluginId]?.immutableGenerationId
                : undefined;
              if (
                !pluginId
                || !immutableGenerationId
                || !changedPluginIds.has(pluginId)
              ) {
                await lease.release();
                continue;
              }
              if (committedPreparedActivationCustodyByPluginId.has(pluginId)) {
                await lease.release();
                throw new Error(
                  `Committed plugin activation custody already exists for '${pluginId}'`,
                );
              }
              const custody = Object.freeze({
                pluginId,
                immutableGenerationId,
                lease,
              });
              committedPreparedActivationCustodyByPluginId.set(pluginId, custody);
              custodyEntries.push(custody);
            }
            const adoption = await params.reloadController.adoptPreparedRuntimeRegistry({
              registry,
              changedPluginIds: candidate.changedPluginIds,
              durableRevision: record.revision,
              ...(params.beforePublish ? { beforePublish: params.beforePublish } : {}),
            });
            if (!adoption.ok || !adoption.registry) {
              throw new Error('Prepared plugin runtime registry adoption did not publish');
            }
            adopted = true;
            await releasePreparedCustody().catch((error) => {
              logger.warn('[PLUGIN RUNTIME] Adopted plugin activation custody release failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
            for (const attempt of pendingActivationAttempts.splice(0)) publishActivationAttempt(attempt);
            appliedGenerationsByPluginId = Object.freeze(
              Object.fromEntries(candidate.changedPluginIds.map((pluginId) => {
                const current = adoption.registry
                  .pluginFinalPolicyCurrentGenerationsById
                  ?.get(pluginId);
                return [
                  pluginId,
                  current?.applied === true ? current.immutableGenerationId : null,
                ];
              })),
            );
            return appliedGenerationsByPluginId;
          } catch (error) {
            await releasePreparedCustody().catch(() => undefined);
            await disposeOnce();
            throw error;
          }
        },
      });
  }

  return Object.freeze({ prepare: prepareCandidate });
}
