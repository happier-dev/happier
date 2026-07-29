import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginAccessSelection } from '../install/accessScopeRegistry';
import type { SupervisedPluginActivationAttempt } from '../../runtime/lifecycle/manager';
import { ingestCanonicalPluginManifest } from '../../manifest/ingest';
import {
  pluginDistributionIdentitiesEqual,
  pluginDistributionRollbackLineagesEqual,
  isPluginTrustRecordAuthorized,
  type PluginTrustRecord,
  type PluginUpdatePolicy,
} from '../install/trustIdentity';
import type { PluginStateFileV1, PluginStateRecord } from '../state';
import { PluginStateFileV1Schema, PluginStateRecordSchema } from '../state';
import { ensurePluginStoreDirectories, resolvePluginStorePaths, type PluginStorePaths } from '../paths';
import { createPluginRegistryCommitCoordinator } from './commitCoordinator';
import {
  PluginRegistryCommitRecordSchema,
  type PluginRegistryCommitRecord,
} from './commitRecord';
import {
  createImmutablePluginGenerationRecordFromSource,
  persistInstallationStateRevision,
  prepareImmutablePluginGeneration,
  readPreparedImmutablePluginGeneration,
  readInstallationStateRevision,
  readPluginRegistryCommitInstallationAuthority,
  retainProcessLocalPreparedPluginGeneration,
  type PluginInstallationStateRevision,
} from './generationStore';
import {
  reconcilePluginGenerationCustodyRetirement,
  type PluginGenerationCustodyRetirementRemoteDependencies,
} from './generationCustodyRetirement';
import {
  PLUGIN_GENERATION_HEALTH_POLICY_V1,
  beginGenerationHealthObservation,
  classifyFatalGenerationAttempt,
  completeGenerationHealthObservation,
  consumeGenerationTryOnce,
  createPendingGenerationHealthRecord,
  createQuarantinedGenerationHealthRecord,
  markGenerationHealthyAfterStaticReconciliation,
  recordGenerationAttemptResult,
  resolveAutomaticGenerationRecovery,
  resolveFailedGenerationTrial,
} from './healthPolicy';
import {
  createPluginRegistryReconciler,
  type PluginRegistryReconcileSurface,
} from './reconcile';
import {
  createPluginRegistryTransactionService,
  type PluginRegistryTransactionResult,
} from './service';

type StateTransform = (current: PluginStateFileV1) => PluginStateFileV1 | Promise<PluginStateFileV1>;

function emptyState(): PluginStateFileV1 {
  return PluginStateFileV1Schema.parse({
    t: 'happier_plugin_state_v1',
    schemaVersion: 1,
    plugins: {},
  });
}

function createRevision(params: Readonly<{
  revisionId: string;
  createdAtMs: number;
  runtimeCatalog: PluginStateFileV1;
  prior?: PluginInstallationStateRevision;
}>): PluginInstallationStateRevision {
  const runtimeCatalog = PluginStateFileV1Schema.parse(params.runtimeCatalog);
  const prior = params.prior;
  const priorPlugins = prior?.plugins ?? {};
  const plugins = Object.fromEntries(Object.entries(runtimeCatalog.plugins).map(([pluginId, record]) => {
    const installation = priorPlugins[pluginId];
    if (!installation) {
      throw new Error(`Plugin '${pluginId}' must be installed through the immutable generation transaction`);
    }
    return [pluginId, { ...installation, enabled: record.state.enabled }];
  }));
  return {
    t: 'happier_plugin_installations_v1',
    schemaVersion: 1,
    revisionId: params.revisionId,
    createdAtMs: params.createdAtMs,
    plugins,
    health: prior?.health ?? {},
    rollbackRetention: prior?.rollbackRetention ?? [],
    healthTombstones: prior?.healthTombstones ?? [],
    runtimeCatalog,
    retainedRuntimeCatalog: prior?.retainedRuntimeCatalog ?? {},
  };
}

export type CommitPluginRegistryInstallationInput = Readonly<{
  pluginId: string;
  sourceRootPath: string;
  manifestRelativePath: string;
  catalogRecord: PluginStateRecord;
  trust: PluginTrustRecord;
  updatePolicy: PluginUpdatePolicy;
  optionalAccess: readonly PluginAccessSelection[];
  reviewedPackageDigest?: string;
}>;

export class PluginRegistryCandidateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRegistryCandidateConflictError';
  }
}

export type PluginRegistryRuntimeCandidate = Readonly<{
  mutationKind: 'state' | 'install' | 'rollback' | 'uninstall';
  changedPluginIds: readonly string[];
  runtimeCatalog: PluginStateFileV1;
  installationState: PluginInstallationStateRevision;
  pluginGenerations: PluginRegistryCommitRecord['pluginGenerations'];
}>;

export type PreparedPluginRegistryRuntime = Readonly<{
  abort: () => Promise<void>;
  adopt: (
    record: PluginRegistryCommitRecord,
  ) => Promise<Readonly<Record<string, string | null>> | void>;
  rebase?: (candidate: PluginRegistryRuntimeCandidate) => Promise<PreparedPluginRegistryRuntime>;
}>;

export type PluginRegistryRuntimeLifecycle = Readonly<{
  prepare: (candidate: PluginRegistryRuntimeCandidate) => Promise<PreparedPluginRegistryRuntime>;
}>;

export type PluginRegistryStateMutationResult = Readonly<{
  catalog: PluginStateFileV1;
  transaction:
    | Extract<PluginRegistryTransactionResult, { status: 'committed' }>
    | Extract<PluginRegistryTransactionResult, { status: 'outcomeUnknown' }>;
}>;

type PluginGenerationHealthSupervisor = Readonly<{
  daemonInstanceId: string;
  daemonUptimeMs: () => number;
  schedule: (delayMs: number, task: () => Promise<void>) => void;
}>;

function resolveChangedPluginIds(
  current: PluginStateFileV1,
  next: PluginStateFileV1,
): readonly string[] {
  const pluginIds = new Set([...Object.keys(current.plugins), ...Object.keys(next.plugins)]);
  return Object.freeze([...pluginIds]
    .filter((pluginId) => JSON.stringify(current.plugins[pluginId]) !== JSON.stringify(next.plugins[pluginId]))
    .sort());
}

export function createPluginRegistryStateStore(params?: Readonly<{
  happyHomeDir?: string;
  owner?: Readonly<{ pid: number; instanceId: string }>;
  nowMs?: () => number;
  reconciliationSurfaces?: readonly PluginRegistryReconcileSurface[];
  generationCustodyRetirement?: PluginGenerationCustodyRetirementRemoteDependencies;
  runtimeLifecycle?: PluginRegistryRuntimeLifecycle;
  prepareGeneration?: typeof prepareImmutablePluginGeneration;
  healthSupervisor?: PluginGenerationHealthSupervisor;
  onApplied?: (record: PluginRegistryCommitRecord) => void;
  onReconciliationPending?: (diagnostic: Readonly<{
    operation: string;
    pendingSurfaces: readonly string[];
    message?: string;
  }>) => void;
  runAutomaticCurrentnessChange?: (
    pluginId: string,
    change: (control: Readonly<{ onApplied: () => void }>) => Promise<void>,
  ) => Promise<void>;
}>): Readonly<{
  paths: PluginStorePaths;
  initialize: () => Promise<PluginStateFileV1>;
  read: () => Promise<PluginStateFileV1>;
  readSnapshot: () => Promise<Readonly<{
    revision: number;
    state: PluginStateFileV1;
    pluginGenerations: PluginRegistryCommitRecord['pluginGenerations'];
    rollbackAvailabilityByPluginId: Readonly<Record<string, 'available' | 'unavailable'>>;
  }>>;
  write: (next: PluginStateFileV1) => Promise<void>;
  update: (transform: StateTransform) => Promise<PluginStateFileV1>;
  updateWithResult: (transform: StateTransform) => Promise<PluginRegistryStateMutationResult>;
  install: (input: CommitPluginRegistryInstallationInput) => Promise<PluginRegistryTransactionResult>;
  rollback: (pluginId: string) => Promise<PluginStateFileV1>;
  rollbackWithResult: (pluginId: string) => Promise<PluginRegistryStateMutationResult>;
  setEnabled: (pluginId: string, enabled: boolean) => Promise<PluginStateFileV1>;
  setEnabledWithResult: (pluginId: string, enabled: boolean) => Promise<PluginRegistryStateMutationResult | null>;
  forgetTrustWithResult: (pluginId: string) => Promise<PluginRegistryStateMutationResult | null>;
  uninstall: (pluginId: string) => Promise<PluginStateFileV1>;
  uninstallWithResult: (
    pluginId: string,
    options?: Readonly<{ clearHealthHistory?: boolean }>,
  ) => Promise<PluginRegistryStateMutationResult | null>;
  evictQuarantinedTryOnceBytesForStoragePressure: () => Promise<Readonly<{
    evictedGenerationIds: readonly string[];
  }>>;
  settleCurrentNonExecutableHealthAfterRuntimePublication: () => Promise<void>;
  observeActivationAttempt: (attempt: SupervisedPluginActivationAttempt) => Promise<void>;
}> {
  const paths = resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir });
  const nowMs = params?.nowMs ?? Date.now;
  const owner = params?.owner ?? {
    pid: process.pid,
    instanceId: `plugin-registry-${process.pid}-${randomUUID()}`,
  };
  const runtimeLifecycle = params?.runtimeLifecycle;
  const prepareGeneration = params?.prepareGeneration ?? prepareImmutablePluginGeneration;
  const healthSupervisor = params?.healthSupervisor;
  const onApplied = params?.onApplied;
  const onReconciliationPending = params?.onReconciliationPending;
  const runAutomaticCurrentnessChange = params?.runAutomaticCurrentnessChange;
  const coordinator = createPluginRegistryCommitCoordinator({ paths, owner, nowMs });
  async function readVerifiedRollbackGeneration(
    retention: PluginInstallationStateRevision['rollbackRetention'][number],
  ): Promise<Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>>> {
    const prepared = await readPreparedImmutablePluginGeneration({
      paths,
      immutableGenerationId: retention.immutableGenerationId,
    });
    if (
      prepared.record.pluginId !== retention.pluginId
      || prepared.record.packageDigest !== retention.packageDigest
      || prepared.record.installedArtifactRecord.digest !== retention.artifactDigest
    ) {
      throw new Error(
        `Plugin '${retention.pluginId}' retained identity does not match immutable generation `
        + `'${retention.immutableGenerationId}'`,
      );
    }
    return prepared;
  }
  const reconciler = createPluginRegistryReconciler({
    paths,
    readState: async (commit) => await readInstallationStateRevision({
      paths,
      reference: commit.installationState,
    }),
    surfaces: [
      ...(params?.reconciliationSurfaces ?? []),
      {
        name: 'generationCleanup',
        apply: async ({ commit, isCurrent }) => {
          const cleanup = await reconcilePluginGenerationCustodyRetirement({
            paths,
            commit,
            isCommitCurrent: isCurrent,
            ...params?.generationCustodyRetirement,
          });
          if (cleanup.status === 'authentication-unavailable') {
            throw new Error('Authenticated immutable generation custody retirement is pending');
          }
          if (cleanup.failures.length > 0) {
            throw new Error(`Immutable generation cleanup remains pending: ${cleanup.failures
              .map((failure) => `${failure.generationId}: ${failure.message}`)
              .join('; ')}`);
          }
        },
      },
    ],
  });
  const transactionService = createPluginRegistryTransactionService({ coordinator });

  async function reconcileRecord(record: PluginRegistryCommitRecord): Promise<Readonly<{
    status: 'reconciled' | 'retryable';
    message?: string;
  }>> {
    const reconciliation = await reconciler.reconcile();
    if (reconciliation.status === 'reconciled' && reconciliation.revision === record.revision) {
      return { status: 'reconciled' };
    }
    const failed = Object.entries(reconciliation.surfaces)
      .filter(([, surface]) => surface.status !== 'applied')
      .map(([name, surface]) => `${name}: ${surface.message ?? surface.status}`);
    return {
      status: 'retryable',
      message: failed.join('; ') || 'Registry reconciliation did not reach the committed revision',
    };
  }

  function reportPendingReconciliation(
    operation: string,
    pendingSurfaces: readonly string[],
    message?: string,
  ): void {
    if (!pendingSurfaces.includes('reconciliation')) return;
    onReconciliationPending?.({
      operation,
      pendingSurfaces,
      ...(message ? { message } : {}),
    });
  }

  async function readCommittedState(commit: PluginRegistryCommitRecord): Promise<Readonly<{
    commit: PluginRegistryCommitRecord;
    revision: PluginInstallationStateRevision;
    catalog: PluginStateFileV1;
  }>> {
    const revision = await readPluginRegistryCommitInstallationAuthority(paths, commit)
      ?? await readInstallationStateRevision({ paths, reference: commit.installationState });
    if (!revision.runtimeCatalog) {
      throw new Error('Current plugin registry revision has no canonical runtime catalog');
    }
    return { commit, revision, catalog: revision.runtimeCatalog };
  }

  async function bootstrap(): Promise<PluginRegistryCommitRecord> {
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    while (true) {
      const existing = await coordinator.readCurrent();
      if (existing) return existing;
      const transactionId = `cutover-${randomUUID()}`;
      const result = await coordinator.commit({
        transactionId,
        baseRevision: null,
        buildNext: async () => {
          const createdAtMs = nowMs();
          const revision: PluginInstallationStateRevision = {
            t: 'happier_plugin_installations_v1',
            schemaVersion: 1,
            revisionId: `state-${randomUUID()}`,
            createdAtMs,
            plugins: {},
            health: {},
            rollbackRetention: [],
            healthTombstones: [],
            runtimeCatalog: emptyState(),
            retainedRuntimeCatalog: {},
          };
          const installationState = await persistInstallationStateRevision({ paths, state: revision });
          return PluginRegistryCommitRecordSchema.parse({
            t: 'happier_plugin_registry_commit_v1',
            schemaVersion: 1,
            revision: 0,
            transactionId,
            baseRevision: null,
            installationState,
            pluginGenerations: {},
            createdAtMs,
            creator: owner,
          });
        },
      });
      if (result.status === 'committed') {
        // The durable record is authoritative even when a derived surface is
        // temporarily unavailable; startup will retry reconciliation.
        const reconciliation = await reconcileRecord(result.record).catch((error: unknown) => ({
          status: 'retryable' as const,
          message: error instanceof Error ? error.message : String(error),
        }));
        if (reconciliation.status === 'retryable') {
          reportPendingReconciliation('startup', Object.freeze(['reconciliation']), reconciliation.message);
        }
        return result.record;
      }
      if (result.status === 'committed_durability_pending') return result.record;
      if (result.status === 'conflict') continue;
      throw new Error('Plugin registry initialization was aborted');
    }
  }

  async function readCurrent(): Promise<Readonly<{
    commit: PluginRegistryCommitRecord;
    revision: PluginInstallationStateRevision;
    catalog: PluginStateFileV1;
  }>> {
    const commit = await coordinator.readCurrent() ?? await bootstrap();
    const current = await readCommittedState(commit);
    // Derived surfaces never decide currentness. A retryable reconciliation
    // leaves the durable commit authoritative and is retried by the next
    // startup/current-state read.
    const reconciliation = await reconcileRecord(commit);
    if (reconciliation.status === 'retryable') {
      reportPendingReconciliation('startup', Object.freeze(['reconciliation']), reconciliation.message);
    }
    return current;
  }

  async function readPersistedCurrent(): Promise<Readonly<{
    commit: PluginRegistryCommitRecord;
    revision: PluginInstallationStateRevision;
    catalog: PluginStateFileV1;
  }> | null> {
    const commit = await coordinator.readCurrent();
    if (!commit) return null;
    return await readCommittedState(commit);
  }

  function throwPrecommitFailure(result: Exclude<
    PluginRegistryTransactionResult,
    { status: 'committed' | 'outcomeUnknown' | 'conflict' }
  >): never {
    if (result.status === 'aborted') {
      throw new Error(result.abortMessage ?? 'Plugin registry transaction was aborted before promotion');
    }
    throw new Error(result.message, {
      cause: result.abortMessage ? new Error(result.abortMessage) : undefined,
    });
  }

  function requireRuntimeLifecycle(): PluginRegistryRuntimeLifecycle {
    if (!runtimeLifecycle) {
      throw new Error('Plugin registry mutation requires a runtime lifecycle');
    }
    return runtimeLifecycle;
  }

  async function updateWithResult(transform: StateTransform): Promise<PluginRegistryStateMutationResult> {
    const lifecycle = requireRuntimeLifecycle();
    while (true) {
      const current = await readCurrent();
      const nextCatalog = PluginStateFileV1Schema.parse(await transform(current.catalog));
      const transactionId = `state-${randomUUID()}`;
      const createdAtMs = nowMs();
      const revision = createRevision({
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        runtimeCatalog: nextCatalog,
        prior: current.revision,
      });
      const installationState = await persistInstallationStateRevision({ paths, state: revision });
      const result = await transactionService.execute({
        transactionId,
        baseRevision: current.commit.revision,
        prepare: async () => ({ revision, installationState }),
        validateAndActivate: async () => await lifecycle.prepare({
          mutationKind: 'state',
          changedPluginIds: resolveChangedPluginIds(current.catalog, nextCatalog),
          runtimeCatalog: nextCatalog,
          installationState: revision,
          pluginGenerations: current.commit.pluginGenerations,
        }),
        persist: async () => PluginRegistryCommitRecordSchema.parse({
            ...current.commit,
            revision: current.commit.revision + 1,
            transactionId,
            baseRevision: current.commit.revision,
            installationState,
            createdAtMs,
            creator: owner,
          }),
        abortPrepared: async (_prepared, runtime) => await runtime?.abort(),
        adopt: async (record, runtime) => {
          const appliedGenerationsByPluginId = await runtime.adopt(record);
          onApplied?.(record);
          return appliedGenerationsByPluginId;
        },
        reconcile: reconcileRecord,
        retirePrevious: async () => undefined,
        cleanup: async () => undefined,
      });
      if (result.status === 'committed' || result.status === 'outcomeUnknown') {
        return Object.freeze({ catalog: nextCatalog, transaction: result });
      }
      if (result.status === 'conflict') continue;
      throwPrecommitFailure(result);
    }
  }

  async function update(transform: StateTransform): Promise<PluginStateFileV1> {
    return (await updateWithResult(transform)).catalog;
  }

  async function commitRevision(params: Readonly<{
    current: Awaited<ReturnType<typeof readCurrent>>;
    revision: PluginInstallationStateRevision;
    pluginGenerations: PluginRegistryCommitRecord['pluginGenerations'];
    transactionId: string;
    createdAtMs: number;
    mutationKind: PluginRegistryRuntimeCandidate['mutationKind'];
    changedPluginIds: readonly string[];
    onApplied?: () => void;
    retryRuntime?: PreparedPluginRegistryRuntime;
    retainRuntimeOnConflict?: boolean;
  }>): Promise<
    | PluginRegistryTransactionResult
    | (Extract<PluginRegistryTransactionResult, { status: 'conflict' }> & Readonly<{
        retryRuntime: PreparedPluginRegistryRuntime;
      }>)
  > {
    const lifecycle = requireRuntimeLifecycle();
    const installationState = await persistInstallationStateRevision({ paths, state: params.revision });
    const result = await transactionService.execute({
      transactionId: params.transactionId,
      baseRevision: params.current.commit.revision,
      prepare: async () => ({ installationState }),
      validateAndActivate: async () => {
        const candidate = {
          mutationKind: params.mutationKind,
          changedPluginIds: params.changedPluginIds,
          runtimeCatalog: params.revision.runtimeCatalog ?? emptyState(),
          installationState: params.revision,
          pluginGenerations: params.pluginGenerations,
        } satisfies PluginRegistryRuntimeCandidate;
        if (!params.retryRuntime) return await lifecycle.prepare(candidate);
        if (!params.retryRuntime.rebase) {
          await params.retryRuntime.abort();
          return await lifecycle.prepare(candidate);
        }
        try {
          return await params.retryRuntime.rebase(candidate);
        } catch (error) {
          await params.retryRuntime.abort().catch(() => undefined);
          throw error;
        }
      },
      persist: async () => PluginRegistryCommitRecordSchema.parse({
          ...params.current.commit,
          revision: params.current.commit.revision + 1,
          transactionId: params.transactionId,
          baseRevision: params.current.commit.revision,
          installationState,
          pluginGenerations: params.pluginGenerations,
          createdAtMs: params.createdAtMs,
          creator: owner,
        }),
      abortPrepared: async (_prepared, runtime) => await runtime?.abort(),
      adopt: async (record, runtime) => {
        const appliedGenerationsByPluginId = await runtime.adopt(record);
        onApplied?.(record);
        params.onApplied?.();
        return appliedGenerationsByPluginId;
      },
      reconcile: reconcileRecord,
      retirePrevious: async () => undefined,
      cleanup: async () => undefined,
      retainActivatedOnConflict: params.retainRuntimeOnConflict === true,
    });
    if (result.status === 'conflict' && 'retryActivation' in result) {
      return Object.freeze({
        status: 'conflict',
        expectedRevision: result.expectedRevision,
        actualRevision: result.actualRevision,
        retryRuntime: result.retryActivation,
      });
    }
    return result;
  }

  async function commitHealthMetadata(params: Readonly<{
    current: Awaited<ReturnType<typeof readCommittedState>>;
    revision: PluginInstallationStateRevision;
    transactionId: string;
    createdAtMs: number;
  }>): Promise<
    | Extract<PluginRegistryTransactionResult, { status: 'committed' }>
    | Extract<PluginRegistryTransactionResult, { status: 'outcomeUnknown' }>
    | Extract<PluginRegistryTransactionResult, { status: 'conflict' }>
    | Extract<PluginRegistryTransactionResult, { status: 'aborted' }>
  > {
    const installationState = await persistInstallationStateRevision({ paths, state: params.revision });
    const result = await coordinator.commit({
      transactionId: params.transactionId,
      baseRevision: params.current.commit.revision,
      buildNext: async () => PluginRegistryCommitRecordSchema.parse({
        ...params.current.commit,
        revision: params.current.commit.revision + 1,
        transactionId: params.transactionId,
        baseRevision: params.current.commit.revision,
        installationState,
        createdAtMs: params.createdAtMs,
        creator: owner,
      }),
    });
    if (result.status === 'conflict' || result.status === 'aborted') return result;
    if (result.status === 'committed_durability_pending') {
      return {
        status: 'outcomeUnknown',
        record: result.record,
        phase: 'durability',
        message: result.message,
      };
    }
    try {
      const reconciliation = await reconcileRecord(result.record);
      if (reconciliation.status !== 'reconciled') {
        return {
          status: 'committed',
          record: result.record,
          applied: true,
          pendingSurfaces: Object.freeze(['reconciliation']),
          ...(reconciliation.message ? { message: reconciliation.message } : {}),
        };
      }
    } catch (error) {
      return {
        status: 'committed',
        record: result.record,
        applied: true,
        pendingSurfaces: Object.freeze(['reconciliation']),
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      status: 'committed',
      record: result.record,
      applied: true,
      pendingSurfaces: Object.freeze([]),
    };
  }

  function upsertHealthTombstone(
    revision: PluginInstallationStateRevision,
    record: PluginInstallationStateRevision['health'][string],
    recordedAtMs: number,
  ): PluginInstallationStateRevision['healthTombstones'] {
    return [
      ...revision.healthTombstones.filter((entry) => (
        entry.pluginId !== record.pluginId || entry.fingerprint !== record.fingerprint
      )),
      {
        pluginId: record.pluginId,
        fingerprint: record.fingerprint,
        state: record.tryOnce === 'consumed' ? 'consumed' as const : 'quarantined' as const,
        recordedAtMs,
      },
    ];
  }

  async function persistTryOnceConsumption(params: Readonly<{
    current: Awaited<ReturnType<typeof readCurrent>>;
    pluginId: string;
    immutableGenerationId: string;
  }>): Promise<Awaited<ReturnType<typeof readCommittedState>> | null> {
    const health = params.current.revision.health[params.immutableGenerationId];
    if (!health || health.pluginId !== params.pluginId) {
      throw new Error(`Plugin '${params.pluginId}' Try once health state is unavailable`);
    }
    const consumed = consumeGenerationTryOnce(health);
    const createdAtMs = nowMs();
    const revision: PluginInstallationStateRevision = {
      ...params.current.revision,
      revisionId: `health-try-once-${randomUUID()}`,
      createdAtMs,
      health: {
        ...params.current.revision.health,
        [params.immutableGenerationId]: consumed,
      },
      healthTombstones: upsertHealthTombstone(params.current.revision, consumed, createdAtMs),
    };
    const committed = await commitHealthMetadata({
      current: params.current,
      revision,
      transactionId: `health-try-once-${randomUUID()}`,
      createdAtMs,
    });
    if (committed.status === 'conflict') return null;
    if (committed.status === 'aborted') throwPrecommitFailure(committed);
    if (committed.status === 'outcomeUnknown') {
      throw new Error(
        `Plugin '${params.pluginId}' Try once consumption durability is unknown; quarantined bytes were not executed`,
      );
    }
    return await readCommittedState(committed.record);
  }

  async function completeHealthObservation(
    pluginId: string,
    immutableGenerationId: string,
  ): Promise<void> {
    if (!healthSupervisor) return;
    while (true) {
      const current = await readPersistedCurrent();
      const reference = current?.commit.pluginGenerations[pluginId];
      const health = current?.revision.health[immutableGenerationId];
      if (!current || reference?.immutableGenerationId !== immutableGenerationId || !health) return;
      const transition = completeGenerationHealthObservation({
        record: health,
        daemonInstanceId: healthSupervisor.daemonInstanceId,
        daemonUptimeMs: healthSupervisor.daemonUptimeMs(),
      });
      if (transition.decision === 'restart_required') return;
      if (transition.decision === 'monitoring') {
        const elapsed = health.observation
          ? Math.max(0, healthSupervisor.daemonUptimeMs() - health.observation.startedAtUptimeMs)
          : 0;
        healthSupervisor.schedule(
          Math.max(1, PLUGIN_GENERATION_HEALTH_POLICY_V1.continuousHealthWindowMs - elapsed),
          async () => await completeHealthObservation(pluginId, immutableGenerationId),
        );
        return;
      }
      const createdAtMs = nowMs();
      const rollbackRetention = current.revision.rollbackRetention.map((entry) => (
        entry.pluginId === pluginId && entry.role === 'lastKnownGood'
          ? { ...entry, role: 'userRollback' as const, automaticRecoveryEligible: false }
          : entry
      ));
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `health-${randomUUID()}`,
        createdAtMs,
        health: { ...current.revision.health, [immutableGenerationId]: transition.record },
        rollbackRetention,
      };
      const committed = await commitHealthMetadata({
        current,
        revision,
        transactionId: `health-${randomUUID()}`,
        createdAtMs,
      });
      if (committed.status === 'committed') {
        reportPendingReconciliation(
          'health_observation_completion',
          committed.pendingSurfaces,
          committed.message,
        );
        return;
      }
      if (committed.status === 'outcomeUnknown') {
        reportPendingReconciliation(
          'health_observation_completion',
          Object.freeze(['reconciliation']),
          committed.message,
        );
        return;
      }
    }
  }

  async function observeActivationAttemptWithCurrentnessControl(
    attempt: SupervisedPluginActivationAttempt,
    currentnessControl?: Readonly<{ onApplied: () => void }>,
  ): Promise<void> {
    while (true) {
      const current = await readPersistedCurrent();
      const reference = current?.commit.pluginGenerations[attempt.pluginId];
      const health = current?.revision.health[attempt.immutableGenerationId];
      if (!current || reference?.immutableGenerationId !== attempt.immutableGenerationId || !health) return;

      if (attempt.outcome === 'nonfatal') {
        if (!healthSupervisor || health.state === 'healthy' || health.state === 'quarantined') return;
        if (health.observation?.daemonInstanceId === healthSupervisor.daemonInstanceId) return;
        const observed = beginGenerationHealthObservation({
          record: health,
          daemonInstanceId: healthSupervisor.daemonInstanceId,
          daemonUptimeMs: healthSupervisor.daemonUptimeMs(),
        });
        const createdAtMs = nowMs();
        const revision: PluginInstallationStateRevision = {
          ...current.revision,
          revisionId: `health-${randomUUID()}`,
          createdAtMs,
          health: { ...current.revision.health, [attempt.immutableGenerationId]: observed },
        };
        const committed = await commitHealthMetadata({
          current,
          revision,
          transactionId: `health-${randomUUID()}`,
          createdAtMs,
        });
        if (committed.status === 'conflict') continue;
        if (committed.status === 'committed') {
          reportPendingReconciliation(
            'health_observation_start',
            committed.pendingSurfaces,
            committed.message,
          );
        }
        if (committed.status === 'outcomeUnknown') {
          reportPendingReconciliation(
            'health_observation_start',
            Object.freeze(['reconciliation']),
            committed.message,
          );
          return;
        }
        healthSupervisor.schedule(
          PLUGIN_GENERATION_HEALTH_POLICY_V1.continuousHealthWindowMs,
          async () => await completeHealthObservation(attempt.pluginId, attempt.immutableGenerationId),
        );
        return;
      }

      if (health.state === 'quarantined') return;
      const classification = classifyFatalGenerationAttempt({
        pluginId: attempt.pluginId,
        attemptId: attempt.attemptId,
        generationId: attempt.immutableGenerationId,
        committed: true,
        kind: attempt.phase,
        outcome: 'fatal',
        attributed: true,
      });
      const recorded = recordGenerationAttemptResult({
        record: health,
        classification,
        nowMs: attempt.completedAtMs,
      });
      if (recorded.decision === 'excluded' || recorded.decision === 'duplicate') return;
      const createdAtMs = nowMs();
      if (recorded.decision === 'recorded') {
        const revision: PluginInstallationStateRevision = {
          ...current.revision,
          revisionId: `health-${randomUUID()}`,
          createdAtMs,
          health: { ...current.revision.health, [attempt.immutableGenerationId]: recorded.record },
        };
        const committed = await commitHealthMetadata({
          current,
          revision,
          transactionId: `health-${randomUUID()}`,
          createdAtMs,
        });
        if (committed.status === 'committed') {
          reportPendingReconciliation(
            'health_failure_record',
            committed.pendingSurfaces,
            committed.message,
          );
          return;
        }
        if (committed.status === 'outcomeUnknown') {
          reportPendingReconciliation(
            'health_failure_record',
            Object.freeze(['reconciliation']),
            committed.message,
          );
          return;
        }
        continue;
      }

      if (!currentnessControl) {
        if (!runAutomaticCurrentnessChange) {
          throw new Error('Automatic plugin currentness recovery requires the daemon plugin-change owner');
        }
        await runAutomaticCurrentnessChange(attempt.pluginId, async (control) => {
          await observeActivationAttemptWithCurrentnessControl(attempt, control);
        });
        return;
      }

      const lastKnownGood = current.revision.rollbackRetention.find((entry) => (
        entry.pluginId === attempt.pluginId
        && entry.role === 'lastKnownGood'
        && entry.automaticRecoveryEligible
        && entry.byteAvailability === 'available'
      ));
      const recovery = recorded.record.state === 'trial'
        ? resolveFailedGenerationTrial({
            record: recorded.record,
            lastKnownGood: lastKnownGood ? { available: true, automaticRecoveryEligible: true } : null,
          })
        : resolveAutomaticGenerationRecovery({
            record: recorded.record,
            lastKnownGood: lastKnownGood ? { available: true, automaticRecoveryEligible: true } : null,
          });
      const failedCatalog = current.catalog.plugins[attempt.pluginId];
      const installation = current.revision.plugins[attempt.pluginId];
      if (!failedCatalog || !installation) return;
      const nextHealth = { ...current.revision.health, [attempt.immutableGenerationId]: recovery.record };
      const healthTombstones = upsertHealthTombstone(current.revision, recovery.record, createdAtMs);

      let revision: PluginInstallationStateRevision;
      let pluginGenerations = current.commit.pluginGenerations;
      let mutationKind: PluginRegistryRuntimeCandidate['mutationKind'] = 'state';
      let retainedCatalog = recovery.action === 'rollback_to_lkg' && lastKnownGood
        ? current.revision.retainedRuntimeCatalog?.[lastKnownGood.immutableGenerationId]
        : undefined;
      let targetGeneration: Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>> | undefined;
      let retainedLkgUnavailable: 'missing' | 'corrupt' | 'sourceIneligible' | null = (
        recovery.action === 'rollback_to_lkg' && lastKnownGood !== undefined && !retainedCatalog
      ) ? 'sourceIneligible' : null;
      let failedGenerationUnavailable: 'missing' | 'corrupt' | null = null;
      let failedGeneration: Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>> | undefined;
      try {
        failedGeneration = await readPreparedImmutablePluginGeneration({
          paths,
          immutableGenerationId: attempt.immutableGenerationId,
        });
      } catch (error) {
        failedGenerationUnavailable = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
          ? 'missing'
          : 'corrupt';
        nextHealth[attempt.immutableGenerationId] = {
          ...recovery.record,
          tryOnce: 'unavailable',
        };
      }
      const createDisabledRecoveryRevision = (
        lkgActivationFailed: boolean,
      ): PluginInstallationStateRevision => {
        const disabledCatalog = PluginStateFileV1Schema.parse({
          ...current.catalog,
          plugins: {
            ...current.catalog.plugins,
            [attempt.pluginId]: {
              ...failedCatalog,
              state: { ...failedCatalog.state, enabled: false },
            },
          },
        });
        return {
          ...current.revision,
          revisionId: `health-${randomUUID()}`,
          createdAtMs,
          plugins: {
            ...current.revision.plugins,
            [attempt.pluginId]: { ...installation, enabled: false },
          },
          health: nextHealth,
          rollbackRetention: (retainedLkgUnavailable || lkgActivationFailed) && lastKnownGood
            ? current.revision.rollbackRetention.map((entry) => (
                entry.immutableGenerationId === lastKnownGood.immutableGenerationId
                  ? {
                      ...entry,
                      role: 'userRollback' as const,
                      automaticRecoveryEligible: false,
                      byteAvailability: retainedLkgUnavailable ?? entry.byteAvailability,
                    }
                  : entry
              ))
            : current.revision.rollbackRetention,
          healthTombstones,
          runtimeCatalog: disabledCatalog,
        };
      };
      if (retainedCatalog && lastKnownGood) {
        try {
          targetGeneration = await readVerifiedRollbackGeneration(lastKnownGood);
        } catch (error) {
          retainedCatalog = undefined;
          retainedLkgUnavailable = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
            ? 'missing'
            : 'corrupt';
        }
      }
      if (retainedCatalog && targetGeneration && lastKnownGood) {
        const failedReference = current.commit.pluginGenerations[attempt.pluginId]!;
        const rollbackRetention = current.revision.rollbackRetention
          .filter((entry) => entry.pluginId !== attempt.pluginId)
          .concat({
            pluginId: attempt.pluginId,
            immutableGenerationId: attempt.immutableGenerationId,
            healthGenerationId: attempt.immutableGenerationId,
            role: 'quarantined' as const,
            automaticRecoveryEligible: false,
            retainedAtMs: createdAtMs,
            byteAvailability: failedGenerationUnavailable ?? 'available',
            packageDigest: failedGeneration?.record.packageDigest ?? installation.source.admittedIntegrity,
            artifactDigest: failedGeneration?.record.installedArtifactRecord.digest
              ?? failedReference.installedArtifactRecord.digest,
            pluginVersion: failedCatalog.install.manifestVersion,
            distribution: installation.source.distribution,
          });
        const retainedRuntimeCatalog = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
          .filter(([generationId]) => generationId !== lastKnownGood.immutableGenerationId));
        retainedRuntimeCatalog[attempt.immutableGenerationId] = failedCatalog;
        const runtimeCatalog = PluginStateFileV1Schema.parse({
          ...current.catalog,
          plugins: { ...current.catalog.plugins, [attempt.pluginId]: retainedCatalog },
        });
        revision = {
          ...current.revision,
          revisionId: `health-${randomUUID()}`,
          createdAtMs,
          plugins: {
            ...current.revision.plugins,
            [attempt.pluginId]: {
              ...installation,
              enabled: retainedCatalog.state.enabled,
              source: { ...installation.source, admittedIntegrity: targetGeneration.record.packageDigest },
            },
          },
          health: nextHealth,
          rollbackRetention,
          healthTombstones,
          runtimeCatalog,
          retainedRuntimeCatalog,
        };
        pluginGenerations = { ...current.commit.pluginGenerations, [attempt.pluginId]: targetGeneration.reference };
        mutationKind = 'rollback';
      } else {
        revision = createDisabledRecoveryRevision(false);
        if (failedGenerationUnavailable) {
          const { [attempt.pluginId]: _invalid, ...remainingGenerations } = current.commit.pluginGenerations;
          pluginGenerations = remainingGenerations;
        }
      }
      let committed = await commitRevision({
        current,
        revision,
        pluginGenerations,
        transactionId: `health-recovery-${randomUUID()}`,
        createdAtMs,
        mutationKind,
        changedPluginIds: Object.freeze([attempt.pluginId]),
        onApplied: currentnessControl.onApplied,
      });
      if (
        mutationKind === 'rollback'
        && committed.status === 'precommit_failed'
        && committed.phase === 'validateAndActivate'
      ) {
        const recoveryFailure = committed;
        committed = await commitRevision({
          current,
          revision: createDisabledRecoveryRevision(true),
          pluginGenerations: current.commit.pluginGenerations,
          transactionId: `health-recovery-disable-${randomUUID()}`,
          createdAtMs,
          mutationKind: 'state',
          changedPluginIds: Object.freeze([attempt.pluginId]),
          onApplied: currentnessControl.onApplied,
        });
        if (committed.status === 'conflict') continue;
        if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
          throwPrecommitFailure(committed);
        }
        throwPrecommitFailure(recoveryFailure);
      }
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted' || committed.status === 'precommit_failed') throwPrecommitFailure(committed);
      if (committed.status === 'committed') {
        reportPendingReconciliation(
          'health_recovery',
          committed.pendingSurfaces,
          committed.message,
        );
      }
      return;
    }
  }

  async function observeActivationAttempt(attempt: SupervisedPluginActivationAttempt): Promise<void> {
    await observeActivationAttemptWithCurrentnessControl(attempt);
  }

  async function manifestHasExecutableDaemonEntrypoint(manifestPath: string): Promise<boolean> {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
      const ingested = ingestCanonicalPluginManifest(manifest, { enforceEngineCompatibility: false });
      if (!ingested.ok) return true;
      return Boolean(ingested.manifest.entrypoints?.daemon || ingested.manifest.entrypoints?.development);
    } catch {
      return true;
    }
  }

  async function hasExecutableDaemonEntrypoint(input: CommitPluginRegistryInstallationInput): Promise<boolean> {
    return await manifestHasExecutableDaemonEntrypoint(
      join(input.sourceRootPath, ...input.manifestRelativePath.split('/')),
    );
  }

  async function settleReconciledNonExecutableGenerationHealth(
    current: Awaited<ReturnType<typeof readCommittedState>>,
  ): Promise<void> {
    for (const [pluginId, reference] of Object.entries(current.commit.pluginGenerations)) {
      const health = current.revision.health[reference.immutableGenerationId];
      const manifestPath = current.catalog.plugins[pluginId]?.source.manifestPath;
      if (health?.state !== 'pending' || !manifestPath) continue;
      if (await manifestHasExecutableDaemonEntrypoint(manifestPath)) continue;
      await markNonExecutableGenerationHealthy(pluginId, reference.immutableGenerationId);
    }
  }

  async function settleCurrentNonExecutableHealthAfterRuntimePublication(): Promise<void> {
    const current = await readCurrent();
    const reconciliation = await reconcileRecord(current.commit);
    if (reconciliation.status === 'retryable') {
      reportPendingReconciliation(
        'static_health_reconciliation',
        Object.freeze(['reconciliation']),
        reconciliation.message,
      );
      return;
    }
    await settleReconciledNonExecutableGenerationHealth(current);
  }

  async function markNonExecutableGenerationHealthy(
    pluginId: string,
    immutableGenerationId: string,
  ): Promise<
    | Extract<PluginRegistryTransactionResult, { status: 'committed' }>
    | Extract<PluginRegistryTransactionResult, { status: 'outcomeUnknown' }>
    | null
  > {
    while (true) {
      const current = await readPersistedCurrent();
      const reference = current?.commit.pluginGenerations[pluginId];
      const health = current?.revision.health[immutableGenerationId];
      if (!current || reference?.immutableGenerationId !== immutableGenerationId || !health) return null;
      if (health.state === 'healthy' || health.state === 'quarantined') return null;
      const nextHealth = markGenerationHealthyAfterStaticReconciliation(health);
      const createdAtMs = nowMs();
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `health-${randomUUID()}`,
        createdAtMs,
        health: { ...current.revision.health, [immutableGenerationId]: nextHealth },
        rollbackRetention: current.revision.rollbackRetention.map((entry) => (
          entry.pluginId === pluginId && entry.role === 'lastKnownGood'
            ? { ...entry, role: 'userRollback' as const, automaticRecoveryEligible: false }
            : entry
        )),
      };
      const committed = await commitHealthMetadata({
        current,
        revision,
        transactionId: `health-static-${randomUUID()}`,
        createdAtMs,
      });
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted') {
        throwPrecommitFailure(committed);
      }
      return committed;
    }
  }

  async function evictQuarantinedTryOnceBytesForStoragePressure(): Promise<Readonly<{
    evictedGenerationIds: readonly string[];
  }>> {
    while (true) {
      const current = await readPersistedCurrent();
      if (!current) return Object.freeze({ evictedGenerationIds: Object.freeze([]) });
      const evictedGenerationIds = current.revision.rollbackRetention
        .filter((entry) => {
          const health = current.revision.health[entry.healthGenerationId];
          return entry.role === 'quarantined'
            && entry.byteAvailability === 'available'
            && health?.state === 'quarantined'
            && health.tryOnce === 'available';
        })
        .map((entry) => entry.immutableGenerationId)
        .sort();
      if (evictedGenerationIds.length === 0) {
        return Object.freeze({ evictedGenerationIds: Object.freeze([]) });
      }
      const evicted = new Set(evictedGenerationIds);
      const createdAtMs = nowMs();
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `health-storage-pressure-${randomUUID()}`,
        createdAtMs,
        rollbackRetention: current.revision.rollbackRetention.map((entry) => (
          evicted.has(entry.immutableGenerationId)
            ? {
                ...entry,
                automaticRecoveryEligible: false,
                byteAvailability: 'evicted' as const,
              }
            : entry
        )),
      };
      const committed = await commitHealthMetadata({
        current,
        revision,
        transactionId: `health-storage-pressure-${randomUUID()}`,
        createdAtMs,
      });
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted') {
        throwPrecommitFailure(committed);
      }
      if (committed.status === 'outcomeUnknown') {
        throw new Error(
          `Storage-pressure quarantine eviction durability is unknown; quarantined bytes were not removed`
          + (committed.message ? `: ${committed.message}` : ''),
        );
      }
      if (committed.pendingSurfaces.length > 0) {
        throw new Error(
          `Storage-pressure quarantine eviction cleanup remains pending: ${committed.pendingSurfaces.join(', ')}`
          + (committed.message ? `: ${committed.message}` : ''),
        );
      }
      return Object.freeze({
        evictedGenerationIds: Object.freeze(evictedGenerationIds),
      });
    }
  }

  async function install(input: CommitPluginRegistryInstallationInput): Promise<PluginRegistryTransactionResult> {
    requireRuntimeLifecycle();
    const catalogRecordInput = PluginStateRecordSchema.parse(input.catalogRecord);
    if (input.trust.pluginId !== input.pluginId) throw new Error('Plugin installation trust identity mismatch');
    if (catalogRecordInput.install.trust && JSON.stringify(catalogRecordInput.install.trust) !== JSON.stringify(input.trust)) {
      throw new Error('Plugin installation catalog trust differs from the reviewed trust identity');
    }
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    const executableDaemonEntrypoint = await hasExecutableDaemonEntrypoint(input);
    const generationCreatedAtMs = nowMs();
    const generationRecord = await createImmutablePluginGenerationRecordFromSource({
      pluginId: input.pluginId,
      sourceRootPath: input.sourceRootPath,
      manifestRelativePath: input.manifestRelativePath,
      distribution: input.trust.distribution,
      updatePolicy: input.updatePolicy,
      createdAtMs: generationCreatedAtMs,
    });
    if (input.reviewedPackageDigest && generationRecord.packageDigest !== input.reviewedPackageDigest) {
      throw new PluginRegistryCandidateConflictError(
        `Plugin '${input.pluginId}' source bytes changed after installation review`,
      );
    }
    const generationCustody = retainProcessLocalPreparedPluginGeneration(
      paths,
      generationRecord.immutableGenerationId,
    );
    let retryRuntime: PreparedPluginRegistryRuntime | undefined;
    try {
      let prepared: Awaited<ReturnType<typeof prepareImmutablePluginGeneration>>;
      while (true) {
        try {
          prepared = await prepareGeneration({
            paths,
            sourceRootPath: input.sourceRootPath,
            record: generationRecord,
          });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          if (code !== 'ENOSPC' && code !== 'EDQUOT') throw error;
          const eviction = await evictQuarantinedTryOnceBytesForStoragePressure();
          if (eviction.evictedGenerationIds.length === 0) throw error;
        }
      }
      while (true) {
        const current = await readCurrent();
        const createdAtMs = nowMs();
      const priorInstallation = current.revision.plugins[input.pluginId];
      const priorCatalogRecord = current.catalog.plugins[input.pluginId];
      const healthTombstone = [...current.revision.healthTombstones].reverse().find((entry) => (
        entry.pluginId === input.pluginId && entry.fingerprint === generationRecord.fingerprint
      ));
      const catalogRecord = PluginStateRecordSchema.parse({
        ...catalogRecordInput,
        source: {
          ...catalogRecordInput.source,
          resolvedPath: prepared.rootPath,
          manifestPath: join(prepared.rootPath, ...input.manifestRelativePath.split('/')),
          resolvedDigest: generationRecord.manifestDigest,
        },
        install: {
          ...catalogRecordInput.install,
          mode: 'managed_install',
          manifestDigest: generationRecord.manifestDigest,
          installedPath: prepared.rootPath,
          trust: input.trust,
          updatePolicy: input.updatePolicy,
          optionalAccess: input.optionalAccess,
        },
        state: {
          ...catalogRecordInput.state,
          enabled: healthTombstone
            ? false
            : priorInstallation && priorCatalogRecord?.install.trust
              ? priorInstallation.enabled
              : catalogRecordInput.state.enabled,
        },
      });
      const priorReference = current.commit.pluginGenerations[input.pluginId];
      const retainsPriorLineage = priorInstallation !== undefined
        && pluginDistributionRollbackLineagesEqual(priorInstallation.source.distribution, input.trust.distribution);
      const retainsPriorDistribution = priorInstallation !== undefined
        && pluginDistributionIdentitiesEqual(priorInstallation.source.distribution, input.trust.distribution);
      const retainedForOtherPlugins = current.revision.rollbackRetention.filter((entry) => entry.pluginId !== input.pluginId);
      const retainedCatalogForOtherPlugins = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
        .filter(([generationId]) => retainedForOtherPlugins.some((entry) => entry.immutableGenerationId === generationId)));
      const healthForOtherPlugins = Object.fromEntries(Object.entries(current.revision.health)
        .filter(([, health]) => health.pluginId !== input.pluginId));
      const rollbackRetention = [...retainedForOtherPlugins];
      const retainedRuntimeCatalog: Record<string, PluginStateRecord> = { ...retainedCatalogForOtherPlugins };
      if (priorReference && retainsPriorLineage) {
        const priorGeneration = await readPreparedImmutablePluginGeneration({
          paths,
          immutableGenerationId: priorReference.immutableGenerationId,
        });
        const priorHealth = current.revision.health[priorReference.immutableGenerationId];
        const priorCatalog = current.catalog.plugins[input.pluginId];
        if (!priorHealth || !priorCatalog) throw new Error(`Current plugin '${input.pluginId}' has incomplete rollback state`);
        healthForOtherPlugins[priorReference.immutableGenerationId] = priorHealth;
        rollbackRetention.push({
          pluginId: input.pluginId,
          immutableGenerationId: priorReference.immutableGenerationId,
          healthGenerationId: priorReference.immutableGenerationId,
          role: priorHealth.state === 'healthy' && retainsPriorDistribution
            ? 'lastKnownGood'
            : priorHealth.state === 'quarantined' || priorHealth.state === 'trial'
              ? 'quarantined'
              : 'userRollback',
          automaticRecoveryEligible: priorHealth.state === 'healthy' && retainsPriorDistribution,
          retainedAtMs: createdAtMs,
          byteAvailability: 'available',
          packageDigest: priorGeneration.record.packageDigest,
          artifactDigest: priorGeneration.record.installedArtifactRecord.digest,
          pluginVersion: priorCatalog.install.manifestVersion,
          distribution: priorInstallation.source.distribution,
        });
        retainedRuntimeCatalog[priorReference.immutableGenerationId] = priorCatalog;
      }
      const runtimeCatalog = PluginStateFileV1Schema.parse({
        ...current.catalog,
        plugins: { ...current.catalog.plugins, [input.pluginId]: catalogRecord },
      });
      const revision: PluginInstallationStateRevision = {
        t: 'happier_plugin_installations_v1',
        schemaVersion: 1,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins: {
          ...current.revision.plugins,
          [input.pluginId]: {
            enabled: catalogRecord.state.enabled,
            trust: input.trust,
            source: { distribution: input.trust.distribution, admittedIntegrity: generationRecord.packageDigest },
            updatePolicy: input.updatePolicy,
            optionalAccess: [...input.optionalAccess],
          },
        },
        health: {
          ...healthForOtherPlugins,
          [generationRecord.immutableGenerationId]: healthTombstone
            ? createQuarantinedGenerationHealthRecord({
                pluginId: input.pluginId,
                immutableGenerationId: generationRecord.immutableGenerationId,
                fingerprint: generationRecord.fingerprint,
                tombstoneState: healthTombstone.state,
              })
            : createPendingGenerationHealthRecord({
                pluginId: input.pluginId,
                immutableGenerationId: generationRecord.immutableGenerationId,
                fingerprint: generationRecord.fingerprint,
              }),
        },
        rollbackRetention,
        healthTombstones: current.revision.healthTombstones,
        runtimeCatalog,
        retainedRuntimeCatalog,
      };
      const pluginGenerations = { ...current.commit.pluginGenerations, [input.pluginId]: prepared.reference };
      const committed = await commitRevision({
        current,
        revision,
        pluginGenerations,
        transactionId: `install-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'install',
        changedPluginIds: Object.freeze([input.pluginId]),
        ...(retryRuntime ? { retryRuntime } : {}),
        retainRuntimeOnConflict: true,
      });
      retryRuntime = undefined;
      if (committed.status === 'conflict') {
        retryRuntime = 'retryRuntime' in committed ? committed.retryRuntime : undefined;
        continue;
      }
      if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
        throwPrecommitFailure(committed);
      }
      if (
        !executableDaemonEntrypoint
        && committed.status === 'committed'
        && committed.applied
        && committed.pendingSurfaces.length === 0
      ) {
        return await markNonExecutableGenerationHealthy(
          input.pluginId,
          generationRecord.immutableGenerationId,
        ) ?? committed;
      }
        return committed;
      }
    } finally {
      await retryRuntime?.abort().catch(() => undefined);
      generationCustody.release();
    }
  }

  async function rollbackWithResult(pluginId: string): Promise<PluginRegistryStateMutationResult> {
    requireRuntimeLifecycle();
    while (true) {
      let current = await readCurrent();
      let currentReference = current.commit.pluginGenerations[pluginId];
      let currentCatalog = current.catalog.plugins[pluginId];
      let installation = current.revision.plugins[pluginId];
      let targetRetention = current.revision.rollbackRetention.find((entry) => (
        entry.pluginId === pluginId && entry.byteAvailability === 'available'
      ));
      if (!currentReference || !currentCatalog || !installation || !targetRetention) {
        throw new Error(`Plugin '${pluginId}' has no available rollback generation`);
      }
      let currentHealth = current.revision.health[currentReference.immutableGenerationId];
      let targetHealth = current.revision.health[targetRetention.healthGenerationId];
      if (!currentHealth || !targetHealth) {
        throw new Error(`Plugin '${pluginId}' rollback health state is unavailable`);
      }

      if (targetRetention.role === 'quarantined') {
        // A Try-once attempt begins only after the retained immutable identity
        // and bytes are usable. Runtime preparation still happens after the
        // consumption commit so a crash cannot silently re-arm executable bytes.
        await readVerifiedRollbackGeneration(targetRetention);
        const consumedCurrent = await persistTryOnceConsumption({
          current,
          pluginId,
          immutableGenerationId: targetRetention.healthGenerationId,
        });
        if (!consumedCurrent) continue;
        current = consumedCurrent;
        const refreshedCurrentReference = current.commit.pluginGenerations[pluginId];
        const refreshedCurrentCatalog = current.catalog.plugins[pluginId];
        const refreshedInstallation = current.revision.plugins[pluginId];
        const refreshedTargetRetention = current.revision.rollbackRetention.find((entry) => (
          entry.pluginId === pluginId && entry.byteAvailability === 'available'
        ));
        const refreshedCurrentHealth = refreshedCurrentReference
          ? current.revision.health[refreshedCurrentReference.immutableGenerationId]
          : undefined;
        const refreshedTargetHealth = refreshedTargetRetention
          ? current.revision.health[refreshedTargetRetention.healthGenerationId]
          : undefined;
        if (
          !refreshedCurrentReference
          || !refreshedCurrentCatalog
          || !refreshedInstallation
          || !refreshedTargetRetention
        ) {
          throw new Error(`Plugin '${pluginId}' has no available rollback generation`);
        }
        if (!refreshedCurrentHealth || !refreshedTargetHealth) {
          throw new Error(`Plugin '${pluginId}' rollback health state is unavailable`);
        }
        currentReference = refreshedCurrentReference;
        currentCatalog = refreshedCurrentCatalog;
        installation = refreshedInstallation;
        targetRetention = refreshedTargetRetention;
        currentHealth = refreshedCurrentHealth;
        targetHealth = refreshedTargetHealth;
      }
      const nextTargetHealth = targetHealth;
      const retainedCatalog = current.revision.retainedRuntimeCatalog?.[targetRetention.immutableGenerationId];
      if (!retainedCatalog) throw new Error(`Plugin '${pluginId}' rollback catalog is unavailable`);
      const targetTrust = retainedCatalog.install.trust;
      if (
        !targetTrust
        || targetTrust.pluginId !== pluginId
        || !pluginDistributionIdentitiesEqual(targetTrust.distribution, targetRetention.distribution)
      ) {
        throw new Error(`Plugin '${pluginId}' rollback trust state is unavailable`);
      }
      const [targetGeneration, priorGeneration] = await Promise.all([
        readVerifiedRollbackGeneration(targetRetention),
        readPreparedImmutablePluginGeneration({ paths, immutableGenerationId: currentReference.immutableGenerationId }),
      ]);
      const createdAtMs = nowMs();
      const retainedForOtherPlugins = current.revision.rollbackRetention.filter((entry) => entry.pluginId !== pluginId);
      const rollbackRetention = retainedForOtherPlugins.concat({
        pluginId,
        immutableGenerationId: priorGeneration.record.immutableGenerationId,
        healthGenerationId: priorGeneration.record.immutableGenerationId,
        role: currentHealth.state === 'quarantined' || currentHealth.state === 'trial'
          ? 'quarantined' as const
          : 'userRollback' as const,
        automaticRecoveryEligible: false,
        retainedAtMs: createdAtMs,
        byteAvailability: 'available' as const,
        packageDigest: priorGeneration.record.packageDigest,
        artifactDigest: priorGeneration.record.installedArtifactRecord.digest,
        pluginVersion: currentCatalog.install.manifestVersion,
        distribution: installation.source.distribution,
      });
      const rolledBackCatalog = PluginStateRecordSchema.parse({
        ...retainedCatalog,
        install: {
          ...retainedCatalog.install,
          trust: targetTrust,
          updatePolicy: installation.updatePolicy,
          optionalAccess: installation.optionalAccess,
        },
      });
      const runtimeCatalog = PluginStateFileV1Schema.parse({
        ...current.catalog,
        plugins: { ...current.catalog.plugins, [pluginId]: rolledBackCatalog },
      });
      const retainedRuntimeCatalog = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
        .filter(([generationId]) => generationId !== targetRetention.immutableGenerationId));
      retainedRuntimeCatalog[priorGeneration.record.immutableGenerationId] = currentCatalog;
      const liveHealthIds = new Set([
        ...Object.values(current.commit.pluginGenerations)
          .filter((reference) => reference.immutableGenerationId !== currentReference.immutableGenerationId)
          .map((reference) => reference.immutableGenerationId),
        targetGeneration.record.immutableGenerationId,
        ...rollbackRetention.map((entry) => entry.immutableGenerationId),
      ]);
      const health = Object.fromEntries(Object.entries(current.revision.health)
        .filter(([generationId]) => liveHealthIds.has(generationId)));
      health[targetRetention.healthGenerationId] = nextTargetHealth;
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins: {
          ...current.revision.plugins,
          [pluginId]: {
            ...installation,
            enabled: rolledBackCatalog.state.enabled,
            trust: targetTrust,
            source: {
              distribution: targetRetention.distribution,
              admittedIntegrity: targetGeneration.record.packageDigest,
            },
          },
        },
        health,
        rollbackRetention,
        healthTombstones: current.revision.healthTombstones,
        runtimeCatalog,
        retainedRuntimeCatalog,
      };
      const pluginGenerations = { ...current.commit.pluginGenerations, [pluginId]: targetGeneration.reference };
      const committed = await commitRevision({
        current,
        revision,
        pluginGenerations,
        transactionId: `rollback-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'rollback',
        changedPluginIds: Object.freeze([pluginId]),
      });
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
        throwPrecommitFailure(committed);
      }
      return Object.freeze({ catalog: runtimeCatalog, transaction: committed });
    }
  }

  async function rollback(pluginId: string): Promise<PluginStateFileV1> {
    return (await rollbackWithResult(pluginId)).catalog;
  }

  async function setEnabledWithResult(
    pluginId: string,
    enabled: boolean,
  ): Promise<PluginRegistryStateMutationResult | null> {
    requireRuntimeLifecycle();
    while (true) {
      let current = await readCurrent();
      let reference = current.commit.pluginGenerations[pluginId];
      let catalogRecord = current.catalog.plugins[pluginId];
      let installation = current.revision.plugins[pluginId];
      let generationHealth = reference
        ? current.revision.health[reference.immutableGenerationId]
        : undefined;
      if (!reference || !catalogRecord || !installation || !generationHealth) {
        throw new Error(`Unknown plugin id: ${pluginId}`);
      }
      if (
        enabled
        && (
          !isPluginTrustRecordAuthorized(installation.trust, {
            pluginId,
            distribution: installation.source.distribution,
          })
          || JSON.stringify(catalogRecord.install.trust) !== JSON.stringify(installation.trust)
        )
      ) {
        throw new Error(`Plugin '${pluginId}' requires installation review before it can be enabled`);
      }
      if (catalogRecord.state.enabled === enabled) return null;

      if (enabled && generationHealth.state === 'quarantined') {
        const consumedCurrent = await persistTryOnceConsumption({
          current,
          pluginId,
          immutableGenerationId: reference.immutableGenerationId,
        });
        if (!consumedCurrent) continue;
        current = consumedCurrent;
        reference = current.commit.pluginGenerations[pluginId];
        catalogRecord = current.catalog.plugins[pluginId];
        installation = current.revision.plugins[pluginId];
        generationHealth = reference
          ? current.revision.health[reference.immutableGenerationId]
          : undefined;
        if (!reference || !catalogRecord || !installation || !generationHealth) {
          throw new Error(`Unknown plugin id: ${pluginId}`);
        }
      } else if (enabled && generationHealth.tryOnce === 'consumed') {
        throw new Error('Generation Try once is unavailable or already consumed');
      }

      const runtimeCatalog = PluginStateFileV1Schema.parse({
        ...current.catalog,
        plugins: {
          ...current.catalog.plugins,
          [pluginId]: {
            ...catalogRecord,
            state: { ...catalogRecord.state, enabled },
          },
        },
      });
      const createdAtMs = nowMs();
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins: {
          ...current.revision.plugins,
          [pluginId]: { ...installation, enabled },
        },
        health: {
          ...current.revision.health,
          [reference.immutableGenerationId]: generationHealth,
        },
        healthTombstones: current.revision.healthTombstones,
        runtimeCatalog,
      };
      const committed = await commitRevision({
        current,
        revision,
        pluginGenerations: current.commit.pluginGenerations,
        transactionId: `state-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'state',
        changedPluginIds: Object.freeze([pluginId]),
      });
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
        throwPrecommitFailure(committed);
      }
      return Object.freeze({ catalog: runtimeCatalog, transaction: committed });
    }
  }

  async function setEnabled(pluginId: string, enabled: boolean): Promise<PluginStateFileV1> {
    return (await setEnabledWithResult(pluginId, enabled))?.catalog ?? (await readCurrent()).catalog;
  }

  async function forgetTrustWithResult(
    pluginId: string,
  ): Promise<PluginRegistryStateMutationResult | null> {
    requireRuntimeLifecycle();
    while (true) {
      const current = await readCurrent();
      const reference = current.commit.pluginGenerations[pluginId];
      const catalogRecord = current.catalog.plugins[pluginId];
      const installation = current.revision.plugins[pluginId];
      if (!reference || !catalogRecord || !installation) {
        throw new Error(`Unknown plugin id: ${pluginId}`);
      }
      if (
        !installation.trust
        && !catalogRecord.install.trust
        && !catalogRecord.state.enabled
        && catalogRecord.source.trustPolicy === 'untrusted'
      ) {
        return null;
      }

      const { trust: _catalogTrust, ...catalogInstall } = catalogRecord.install;
      const runtimeCatalog = PluginStateFileV1Schema.parse({
        ...current.catalog,
        plugins: {
          ...current.catalog.plugins,
          [pluginId]: {
            ...catalogRecord,
            source: { ...catalogRecord.source, trustPolicy: 'untrusted' as const },
            install: catalogInstall,
            state: { ...catalogRecord.state, enabled: false },
          },
        },
      });
      const { trust: _installationTrust, ...installationWithoutTrust } = installation;
      const revokedRollbackGenerationIds = new Set(current.revision.rollbackRetention
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => entry.immutableGenerationId));
      const rollbackRetention = current.revision.rollbackRetention
        .filter((entry) => entry.pluginId !== pluginId);
      const retainedRuntimeCatalog = Object.fromEntries(
        Object.entries(current.revision.retainedRuntimeCatalog ?? {})
          .filter(([generationId]) => !revokedRollbackGenerationIds.has(generationId)),
      );
      const health = Object.fromEntries(Object.entries(current.revision.health)
        .filter(([generationId, record]) => (
          record.pluginId !== pluginId || generationId === reference.immutableGenerationId
        )));
      const createdAtMs = nowMs();
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins: {
          ...current.revision.plugins,
          [pluginId]: {
            ...installationWithoutTrust,
            enabled: false,
          },
        },
        health,
        rollbackRetention,
        runtimeCatalog,
        retainedRuntimeCatalog,
      };
      const committed = await commitRevision({
        current,
        revision,
        pluginGenerations: current.commit.pluginGenerations,
        transactionId: `forget-trust-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'state',
        changedPluginIds: Object.freeze([pluginId]),
      });
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
        throwPrecommitFailure(committed);
      }
      return Object.freeze({ catalog: runtimeCatalog, transaction: committed });
    }
  }

  async function uninstallWithResult(
    pluginId: string,
    options?: Readonly<{ clearHealthHistory?: boolean }>,
  ): Promise<PluginRegistryStateMutationResult | null> {
    requireRuntimeLifecycle();
    while (true) {
      const current = await readCurrent();
      if (!current.revision.plugins[pluginId]) {
        if (options?.clearHealthHistory !== true) throw new Error(`Unknown plugin id: ${pluginId}`);
        const healthTombstones = current.revision.healthTombstones.filter((entry) => entry.pluginId !== pluginId);
        if (healthTombstones.length === current.revision.healthTombstones.length) return null;
        const createdAtMs = nowMs();
        const revision: PluginInstallationStateRevision = {
          ...current.revision,
          revisionId: `state-${randomUUID()}`,
          createdAtMs,
          healthTombstones,
        };
        const committed = await commitHealthMetadata({
          current,
          revision,
          transactionId: `clear-health-${randomUUID()}`,
          createdAtMs,
        });
        if (committed.status === 'conflict') continue;
        if (committed.status === 'aborted') {
          throwPrecommitFailure(committed);
        }
        return Object.freeze({ catalog: current.catalog, transaction: committed });
      }
      const { [pluginId]: _catalog, ...catalogPlugins } = current.catalog.plugins;
      const { [pluginId]: _installation, ...plugins } = current.revision.plugins;
      const { [pluginId]: _generation, ...pluginGenerations } = current.commit.pluginGenerations;
      const rollbackRetention = current.revision.rollbackRetention.filter((entry) => entry.pluginId !== pluginId);
      const retainedIds = new Set(rollbackRetention.map((entry) => entry.immutableGenerationId));
      const health = Object.fromEntries(Object.entries(current.revision.health)
        .filter(([, record]) => record.pluginId !== pluginId));
      const retainedRuntimeCatalog = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
        .filter(([generationId]) => retainedIds.has(generationId)));
      const runtimeCatalog = PluginStateFileV1Schema.parse({ ...current.catalog, plugins: catalogPlugins });
      const createdAtMs = nowMs();
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins,
        health,
        rollbackRetention,
        healthTombstones: options?.clearHealthHistory === true
          ? current.revision.healthTombstones.filter((entry) => entry.pluginId !== pluginId)
          : current.revision.healthTombstones,
        runtimeCatalog,
        retainedRuntimeCatalog,
      };
      const committed = await commitRevision({
        current,
        revision,
        pluginGenerations,
        transactionId: `uninstall-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'uninstall',
        changedPluginIds: Object.freeze([pluginId]),
      });
      if (committed.status === 'conflict') continue;
      if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
        throwPrecommitFailure(committed);
      }
      return Object.freeze({ catalog: runtimeCatalog, transaction: committed });
    }
  }

  async function uninstall(pluginId: string): Promise<PluginStateFileV1> {
    const result = await uninstallWithResult(pluginId);
    if (!result) throw new Error(`Unknown plugin id: ${pluginId}`);
    return result.catalog;
  }

  async function inspectRollbackAvailability(
    current: Awaited<ReturnType<typeof readCommittedState>>,
  ): Promise<Readonly<Record<string, 'available' | 'unavailable'>>> {
    const availability: Record<string, 'available' | 'unavailable'> = Object.fromEntries(
      Object.keys(current.catalog.plugins).map((pluginId) => [pluginId, 'unavailable' as const]),
    );
    await Promise.all(current.revision.rollbackRetention.map(async (retention) => {
      if (retention.byteAvailability !== 'available') return;
      const installation = current.revision.plugins[retention.pluginId];
      const health = current.revision.health[retention.healthGenerationId];
      const retainedCatalog = current.revision.retainedRuntimeCatalog?.[retention.immutableGenerationId];
      const retainedTrust = retainedCatalog?.install.trust;
      if (
        !installation
        || !health
        || !retainedCatalog
        || !retainedTrust
        || retainedTrust.pluginId !== retention.pluginId
        || !pluginDistributionIdentitiesEqual(retainedTrust.distribution, retention.distribution)
        || (retention.role === 'quarantined' && health.tryOnce !== 'available')
      ) {
        return;
      }
      try {
        await readVerifiedRollbackGeneration(retention);
        availability[retention.pluginId] = 'available';
      } catch {
        // Catalog discovery is read-only and fails closed. The action path
        // repeats verification before executing retained bytes.
      }
    }));
    return Object.freeze(availability);
  }

  return Object.freeze({
    paths,
    initialize: async () => (await readCurrent()).catalog,
    read: async () => (await readPersistedCurrent())?.catalog ?? emptyState(),
    readSnapshot: async () => {
      const current = await readPersistedCurrent();
      if (!current) {
        return Object.freeze({
          revision: -1,
          state: emptyState(),
          pluginGenerations: Object.freeze({}),
          rollbackAvailabilityByPluginId: Object.freeze({}),
        });
      }
      return Object.freeze({
        revision: current.commit.revision,
        state: current.catalog,
        pluginGenerations: current.commit.pluginGenerations,
        rollbackAvailabilityByPluginId: await inspectRollbackAvailability(current),
      });
    },
    write: async (next) => { await update(() => next); },
    update,
    updateWithResult,
    install,
    rollback,
    rollbackWithResult,
    setEnabled,
    setEnabledWithResult,
    forgetTrustWithResult,
    uninstall,
    uninstallWithResult,
    evictQuarantinedTryOnceBytesForStoragePressure,
    settleCurrentNonExecutableHealthAfterRuntimePublication,
    observeActivationAttempt,
  });
}
