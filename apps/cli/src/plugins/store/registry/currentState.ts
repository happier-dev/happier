import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

import {
  normalizePluginReleaseFactsV1,
  type PluginAvailabilityReleasePublishActionInputV1,
  PluginInstallReviewPrincipalDigestSchema,
  PluginInstallReviewPrincipalPresentationV1Schema,
  type PluginMachineMaterializationV1,
  type PluginInstallReviewPrincipalDigest,
  type PluginInstallReviewPrincipalPresentationV1,
} from '@happier-dev/protocol';
import { PluginUiArtifactsManifestV1Schema } from '@happier-dev/protocol/plugins/ui';
import { pluginInstallReviewPrincipalPresentationMatchesDigest } from '../../daemon/installReviewPrincipal';
import { resolvePluginUiArtifactAvailabilityPlatform } from '../../availability/releaseFacts';

import type { PluginAccessSelection } from '../install/accessScopeRegistry';
import { projectPluginFailureText } from '../../runtime/lifecycle/utils';
import type { PreparedPluginActivationGraph } from '../../runtime/types';
import {
  AlgorithmQualifiedIntegritySchema,
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
  PluginRegistryCommitRecordInvalidError,
  PluginRegistryCommitRecordSchema,
  pluginRegistryCommitRecordsEqual,
  quarantineInvalidPluginRegistryCommitRecord,
  type PluginRegistryCommitRecord,
} from './commitRecord';
import {
  createDefaultPluginInstallationAvailabilityProjection,
  persistInstallationStateRevision,
  readPreparedImmutablePluginGeneration,
  readCurrentCommittedPluginGenerations,
  readInstallationStateRevision,
  readPluginRegistryCommitInstallationAuthority,
  type OwnedPreparedImmutablePluginGeneration,
  type BundledImmutablePluginArtifact,
  type PluginInstallationAvailabilityProjection,
  type PluginInstallationStateRevision,
  PluginInstallationAvailabilityProjectionSchema,
} from './generationStore';
import {
  reconcilePluginGenerationCustodyRetirement,
  type PluginGenerationCustodyRetirementRemoteDependencies,
} from './generationCustodyRetirement';
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

function createPluginMaterializationId(): string {
  return `materialization-${randomUUID()}`;
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
    return [pluginId, {
      ...installation,
      materializationId: installation.materializationId ?? createPluginMaterializationId(),
      availability: installation.availability
        ?? createDefaultPluginInstallationAvailabilityProjection(installation.source.distribution),
      enabled: record.state.enabled,
    }];
  }));
  return {
    t: 'happier_plugin_installations_v1',
    schemaVersion: 1,
    revisionId: params.revisionId,
    createdAtMs: params.createdAtMs,
    plugins,
    rollbackRetention: prior?.rollbackRetention ?? [],
    ...(prior?.hardRevocationRevisions
      ? { hardRevocationRevisions: prior.hardRevocationRevisions }
      : {}),
    runtimeCatalog,
    retainedRuntimeCatalog: prior?.retainedRuntimeCatalog ?? {},
  };
}

export type CommitPluginRegistryInstallationInput = Readonly<{
  pluginId: string;
  catalogRecord: PluginStateRecord;
  trust: PluginTrustRecord;
  updatePolicy: PluginUpdatePolicy;
  optionalAccess: readonly PluginAccessSelection[];
  /**
   * Immutable acquisition facts retained with the installation, not an
   * Availability snapshot or a generation identity.
   */
  availability?: PluginInstallationAvailabilityProjection;
  /**
   * Verified external acquisition SRI. Local development/path sources must
   * omit this and use immutable generation custody identity instead.
   */
  admittedIntegrity?: string;
  installReviewPrincipalDigest?: PluginInstallReviewPrincipalDigest;
  installReviewPrincipalPresentation?: PluginInstallReviewPrincipalPresentationV1;
  developmentChangedPaths?: readonly string[];
  /**
   * Exact current immutable generation whose bytes a source-only development
   * candidate cloned. This is transient candidate currentness, never a new
   * persisted registry field.
   */
  developmentBaseGenerationId?: string;
  preparedActivationGraph?: PreparedPluginActivationGraph;
  /**
   * The sole daemon-custodied immutable candidate reviewed before installation.
   * Its creator owns cleanup; this store adopts it only once the non-conflict
   * registry outcome can reference it durably.
   */
  preparedGeneration: OwnedPreparedImmutablePluginGeneration;
}>;

export class PluginRegistryCandidateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginRegistryCandidateConflictError';
  }
}

export type PluginRunningSessionDisposition =
  | 'retainRunningSessions'
  | 'revokeRunningSessions';

export type PluginRunningSessionRevocationScope = Readonly<{
  kind: 'immutableGeneration';
  pluginId: string;
  immutableGenerationId: string;
}>;

export type PluginRegistryRuntimeCandidate = Readonly<{
  mutationKind: 'state' | 'install' | 'rollback' | 'uninstall';
  runningSessionDisposition: PluginRunningSessionDisposition;
  runningSessionRevocationScope?: PluginRunningSessionRevocationScope;
  changedPluginIds: readonly string[];
  runtimeCatalog: PluginStateFileV1;
  installationState: PluginInstallationStateRevision;
  pluginGenerations: PluginRegistryCommitRecord['pluginGenerations'];
  preparedActivationGraphsByPluginId?: ReadonlyMap<string, PreparedPluginActivationGraph>;
}>;

export type PreparedPluginRegistryRuntime = Readonly<{
  abort: () => Promise<void>;
  notifyDurableRunningSessionDisposition?: (
    record: PluginRegistryCommitRecord,
  ) => void;
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

/**
 * The install registry's complete persisted facts for one outbound
 * Availability report. It deliberately has no Machine or server identity:
 * the daemon boundary supplies those live transport facts without becoming a
 * second install-state owner.
 */
export type PluginRegistryAvailabilityInventory = Readonly<{
  revision: number;
  releasePublications: readonly PluginAvailabilityReleasePublishActionInputV1[];
  materializations: readonly Omit<
    PluginMachineMaterializationV1,
    'serverIdentityId' | 'machineId'
  >[];
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
  retainedCurrentHostGenerationIds?: readonly string[];
  bundledArtifacts?: readonly BundledImmutablePluginArtifact[];
  resolveBundledPackageEntry?: (
    packageName: string,
    packageEntryRelativePath: string,
  ) => Promise<string>;
  runtimeLifecycle?: PluginRegistryRuntimeLifecycle;
  /**
   * Explicit operator recovery start. An unreadable durable current record is
   * moved aside instead of failing the process, so the documented repair
   * affordance covers the one failure that persists across every start.
   */
  pluginRecovery?: boolean;
  onCommitRecordQuarantined?: (info: Readonly<{
    filePath: string;
    quarantinePath: string;
    issues: readonly string[];
  }>) => void;
  onApplied?: (record: PluginRegistryCommitRecord) => void;
  onReconciliationPending?: (diagnostic: Readonly<{
    operation: string;
    pendingSurfaces: readonly string[];
    message?: string;
  }>) => void;
  runHardRevocationCurrentnessChange?: (
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
    /** Exact persisted installation epoch for each current plugin in this commit. */
    materializationIdsByPluginId: Readonly<Record<string, string>>;
    rollbackAvailabilityByPluginId: Readonly<Record<string, 'available' | 'unavailable'>>;
    admittedIntegrityByPluginId: Readonly<Record<string, string>>;
    installReviewPrincipalDigestsByPluginId: Readonly<
      Record<string, PluginInstallReviewPrincipalDigest>
    >;
    installReviewPrincipalPresentationsByPluginId: Readonly<
      Record<string, PluginInstallReviewPrincipalPresentationV1>
    >;
  }>>;
  readAvailabilityInventory: () => Promise<PluginRegistryAvailabilityInventory>;
  readAvailabilityInventoryForCommit: (
    record: PluginRegistryCommitRecord,
  ) => Promise<PluginRegistryAvailabilityInventory>;
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
  ) => Promise<PluginRegistryStateMutationResult | null>;
  hardRevokeRunningSessionsForGenerationIntegrityFailure: (
    input: Readonly<{
      pluginId: string;
      immutableGenerationId: string;
    }>,
  ) => Promise<void>;
}> {
  const paths = resolvePluginStorePaths({ happyHomeDir: params?.happyHomeDir });
  const nowMs = params?.nowMs ?? Date.now;
  const owner = params?.owner ?? {
    pid: process.pid,
    instanceId: `plugin-registry-${process.pid}-${randomUUID()}`,
  };
  const runtimeLifecycle = params?.runtimeLifecycle;
  const onApplied = params?.onApplied;
  const onReconciliationPending = params?.onReconciliationPending;
  const runHardRevocationCurrentnessChange = params?.runHardRevocationCurrentnessChange;
  const coordinator = createPluginRegistryCommitCoordinator({ paths, owner, nowMs });
  const pluginRecovery = params?.pluginRecovery === true;
  const onCommitRecordQuarantined = params?.onCommitRecordQuarantined;
  /**
   * The durable current record is the one startup input whose rejection recurs
   * forever. A normal start still fails closed rather than discarding plugin
   * state, and only an explicitly requested recovery start moves it aside.
   */
  async function readCurrentCommit(): Promise<PluginRegistryCommitRecord | null> {
    try {
      return await coordinator.readCurrent();
    } catch (error) {
      if (!pluginRecovery || !(error instanceof PluginRegistryCommitRecordInvalidError)) throw error;
      const quarantinePath = await quarantineInvalidPluginRegistryCommitRecord({ paths, nowMs });
      onCommitRecordQuarantined?.({
        filePath: error.filePath,
        quarantinePath,
        issues: error.issues,
      });
      return null;
    }
  }
  async function readVerifiedRollbackGeneration(
    retention: PluginInstallationStateRevision['rollbackRetention'][number],
  ): Promise<Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>>> {
    const prepared = await readPreparedImmutablePluginGeneration({
      paths,
      immutableGenerationId: retention.immutableGenerationId,
    });
    if (
      prepared.record.pluginId !== retention.pluginId
      || prepared.record.immutableGenerationId !== retention.immutableGenerationId
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
    readState: async (commit) => {
      const state = await readPluginRegistryCommitInstallationAuthority(paths, commit);
      if (!state) throw new Error('Plugin registry reconciliation cannot consume an empty installation authority');
      return state;
    },
    surfaces: [
      ...(params?.reconciliationSurfaces ?? []),
      {
        name: 'generationCleanup',
        apply: async ({ commit, isCurrent }) => {
          const cleanup = await reconcilePluginGenerationCustodyRetirement({
            paths,
            commit,
            retainedCurrentHostGenerationIds:
              params?.retainedCurrentHostGenerationIds,
            isCommitCurrent: isCurrent,
            ...params?.generationCustodyRetirement,
          });
          if (cleanup.status === 'authentication-unavailable') {
            throw new Error('Authenticated immutable generation custody retirement is pending');
          }
          if (cleanup.failures.length > 0) {
            throw new Error(`Immutable generation cleanup remains pending: ${cleanup.failures
              .map((failure) => failure.generationId
                ? `${failure.generationId}: ${failure.message}`
                : failure.message)
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
    try {
      const reconciliation = await reconciler.reconcile();
      if (
        reconciliation.status === 'reconciled'
        && pluginRegistryCommitRecordsEqual(reconciliation.commit, record)
      ) {
        return { status: 'reconciled' };
      }
      const failed = Object.entries(reconciliation.surfaces)
        .filter(([, surface]) => surface.status !== 'applied')
        .map(([name, surface]) => `${name}: ${surface.message ?? surface.status}`);
      return {
        status: 'retryable',
        message: projectPluginFailureText(new Error(
          failed.join('; ') || 'Registry reconciliation did not reach the committed revision',
        )),
      };
    } catch (error) {
      return {
        status: 'retryable',
        message: projectPluginFailureText(error),
      };
    }
  }

  function reportPendingReconciliation(
    operation: string,
    pendingSurfaces: readonly string[],
    message?: string,
  ): void {
    if (!pendingSurfaces.includes('reconciliation')) return;
    // `reconcileRecord` is the sole state-store boundary that projects its
    // failure text; the daemon sink receives that bounded result unchanged.
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
      ?? await readInstallationStateRevision({
        paths,
        reference: commit.installationState,
        commit,
      });
    if (!revision.runtimeCatalog) {
      throw new Error('Current plugin registry revision has no canonical runtime catalog');
    }
    return { commit, revision, catalog: revision.runtimeCatalog };
  }

  async function bootstrap(): Promise<PluginRegistryCommitRecord> {
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    while (true) {
      const existing = await readCurrentCommit();
      if (existing) return existing;
      const transactionId = `cutover-${randomUUID()}`;
      const result = await coordinator.commit({
        transactionId,
        baseRevision: null,
        expectedCurrent: null,
        buildNext: async () => {
          const createdAtMs = nowMs();
          const revision: PluginInstallationStateRevision = {
            t: 'happier_plugin_installations_v1',
            schemaVersion: 1,
            revisionId: `state-${randomUUID()}`,
            createdAtMs,
            plugins: {},
            rollbackRetention: [],
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
        const reconciliation = await reconcileRecord(result.record);
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
    const commit = await readCurrentCommit() ?? await bootstrap();
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
    const commit = await readCurrentCommit();
    if (!commit) return null;
    return await readCommittedState(commit);
  }

  async function projectBundledAvailabilityMaterializations(): Promise<readonly Omit<
    PluginMachineMaterializationV1,
    'serverIdentityId' | 'machineId'
  >[]> {
    const bundledArtifacts = params?.bundledArtifacts ?? [];
    if (bundledArtifacts.length === 0) return Object.freeze([]);
    const admitted = await readCurrentCommittedPluginGenerations(paths, {
      bundledArtifacts,
      isolateInvalidInstalledGenerations: true,
      ...(params?.resolveBundledPackageEntry
        ? { resolveBundledPackageEntry: params.resolveBundledPackageEntry }
        : {}),
    });
    if (!admitted) return Object.freeze([]);
    const materializations = await Promise.all(bundledArtifacts.map(async (artifact) => {
      const generation = admitted.generations.get(artifact.record.pluginId);
      if (
        !generation
        || generation.immutableGenerationId !== artifact.record.immutableGenerationId
      ) {
        const rejected = admitted.rejectedGenerations.get(artifact.record.pluginId);
        throw new Error(
          rejected?.message
            ?? `Bundled plugin '${artifact.record.pluginId}' was not admitted for Availability`,
        );
      }
      const packageMetadata = JSON.parse(
        await readFile(join(generation.rootPath, 'package.json'), 'utf8'),
      ) as unknown;
      if (
        typeof packageMetadata !== 'object'
        || packageMetadata === null
        || Array.isArray(packageMetadata)
        || !('name' in packageMetadata)
        || packageMetadata.name !== artifact.packageName
        || !('version' in packageMetadata)
        || typeof packageMetadata.version !== 'string'
      ) {
        throw new Error(
          `Bundled plugin '${artifact.record.pluginId}' has invalid admitted package metadata`,
        );
      }
      const uiManifestRelativePath = 'dist/happier-plugin-ui/ui-artifacts.json';
      const uiArtifacts = artifact.record.files.some(
        (file) => file.relativePath === uiManifestRelativePath,
      )
        ? PluginUiArtifactsManifestV1Schema.parse(JSON.parse(
            await readFile(join(generation.rootPath, uiManifestRelativePath), 'utf8'),
          ) as unknown).entries.map((entry) => Object.freeze({
            contributionId: entry.contributionId,
            tier: entry.tier,
            platform: resolvePluginUiArtifactAvailabilityPlatform(entry),
            artifactDigest: entry.digest,
          }))
        : [];
      return Object.freeze({
        // The exact accepted custody occurrence is also the machine
        // materialization occurrence. A replacement generation must never
        // retain the predecessor's executable coordinate merely because the
        // package name stayed stable.
        materializationId: `bundled-first-party:${artifact.record.immutableGenerationId}`,
        pluginId: artifact.record.pluginId,
        version: packageMetadata.version,
        sourceClass: 'bundledFirstParty' as const,
        portableRelease: false,
        uiArtifacts: Object.freeze(uiArtifacts),
        enabled: true,
        trustState: 'trusted' as const,
        observedAt: nowMs(),
      });
    }));
    return Object.freeze(materializations);
  }

  async function projectAvailabilityInventory(
    current: Awaited<ReturnType<typeof readCommittedState>>,
  ): Promise<PluginRegistryAvailabilityInventory> {
    const releasePublications: PluginAvailabilityReleasePublishActionInputV1[] = [];
    const installedMaterializations = Object.entries(current.revision.plugins).map(([
      pluginId,
      installation,
    ]) => {
      const catalogRecord = current.catalog.plugins[pluginId];
      if (!catalogRecord) {
        throw new Error(
          `Plugin '${pluginId}' availability projection has no canonical catalog record`,
        );
      }
      if (!installation.materializationId || !installation.availability) {
        throw new Error(
          `Plugin '${pluginId}' availability projection requires migrated installation facts`,
        );
      }
      const availability = installation.availability;
      const release = availability.release
        ? normalizePluginReleaseFactsV1(availability.release)
        : undefined;
      if (release) {
        if (availability.sourceClass === 'localPath') {
          throw new Error(
            `Plugin '${pluginId}' local-path installation cannot publish portable release facts`,
          );
        }
        releasePublications.push(Object.freeze({
          facts: release,
          sourceClass: availability.sourceClass,
        }));
      }
      const uiArtifacts = Object.freeze((release?.uiSlots ?? []).map((slot) => (
        Object.freeze({
          contributionId: slot.contributionId,
          tier: slot.tier,
          platform: slot.platform,
          artifactDigest: slot.artifactDigest,
        })
      )));
      const trustState = isPluginTrustRecordAuthorized(installation.trust, {
        pluginId,
        distribution: installation.source.distribution,
      })
        ? 'trusted' as const
        : catalogRecord.source.trustPolicy === 'untrusted'
          ? 'revoked' as const
          : 'untrusted' as const;
      return Object.freeze({
        materializationId: installation.materializationId,
        pluginId,
        version: catalogRecord.install.manifestVersion,
        sourceClass: availability.sourceClass,
        portableRelease: availability.portableRelease,
        ...(release
          ? { archiveDigestSha256: release.archiveDigestSha256 }
          : {}),
        uiArtifacts,
        enabled: installation.enabled,
        trustState,
        observedAt: current.revision.createdAtMs,
      });
    });
    return Object.freeze({
      revision: current.commit.revision,
      releasePublications: Object.freeze([...releasePublications].sort((left, right) => (
        `${left.facts.ref.pluginId}\u0000${left.facts.ref.version}`.localeCompare(
          `${right.facts.ref.pluginId}\u0000${right.facts.ref.version}`,
        )
      ))),
      materializations: Object.freeze([
        ...installedMaterializations,
        ...await projectBundledAvailabilityMaterializations(),
      ].sort((left, right) => (
        left.materializationId.localeCompare(right.materializationId)
      ))),
    });
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
        expectedCurrent: current.commit,
        prepare: async () => ({ revision, installationState }),
        validateAndActivate: async () => await lifecycle.prepare({
          mutationKind: 'state',
          runningSessionDisposition: 'retainRunningSessions',
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
          runtime.notifyDurableRunningSessionDisposition?.(record);
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

  async function initialize(): Promise<PluginStateFileV1> {
    while (true) {
      const current = await readCurrent();
      const requiresAvailabilityMigration = Object.values(current.revision.plugins).some((installation) => (
        !installation.materializationId || !installation.availability
      ));
      if (!requiresAvailabilityMigration) return current.catalog;
      if (!runtimeLifecycle) {
        // Read-only callers must not manufacture runtime adoption just to add
        // outbound-report facts. The daemon lifecycle performs this migration
        // before it asks for an Availability inventory.
        return current.catalog;
      }

      // This is a persistence-only normalization: its catalog and immutable
      // generations are unchanged. Routing it through updateWithResult would
      // adopt a registry with no changed plugin ids before the daemon's cold
      // lifecycle can activate and bootstrap its external contributions.
      const transactionId = `availability-${randomUUID()}`;
      const createdAtMs = nowMs();
      const revision = createRevision({
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        runtimeCatalog: current.catalog,
        prior: current.revision,
      });
      const installationState = await persistInstallationStateRevision({ paths, state: revision });
      const result = await coordinator.commit({
        transactionId,
        baseRevision: current.commit.revision,
        expectedCurrent: current.commit,
        buildNext: async () => PluginRegistryCommitRecordSchema.parse({
          ...current.commit,
          revision: current.commit.revision + 1,
          transactionId,
          baseRevision: current.commit.revision,
          installationState,
          createdAtMs,
          creator: owner,
        }),
      });
      if (result.status === 'conflict') continue;
      if (result.status === 'aborted') {
        throw new Error('Plugin registry availability migration was aborted');
      }
      if (result.status === 'committed') {
        const reconciliation = await reconcileRecord(result.record);
        if (reconciliation.status === 'retryable') {
          reportPendingReconciliation(
            'startup',
            Object.freeze(['reconciliation']),
            reconciliation.message,
          );
        }
      }
      return current.catalog;
    }
  }

  async function commitRevision(params: Readonly<{
    current: Awaited<ReturnType<typeof readCurrent>>;
    revision: PluginInstallationStateRevision;
    pluginGenerations: PluginRegistryCommitRecord['pluginGenerations'];
    transactionId: string;
    createdAtMs: number;
    mutationKind: PluginRegistryRuntimeCandidate['mutationKind'];
    runningSessionDisposition: PluginRunningSessionDisposition;
    runningSessionRevocationScope?: PluginRunningSessionRevocationScope;
    changedPluginIds: readonly string[];
    onApplied?: () => void;
    retryRuntime?: PreparedPluginRegistryRuntime;
    retainRuntimeOnConflict?: boolean;
    preparedActivationGraphsByPluginId?: ReadonlyMap<string, PreparedPluginActivationGraph>;
  }>): Promise<
    | PluginRegistryTransactionResult
    | (Extract<PluginRegistryTransactionResult, { status: 'conflict' }> & Readonly<{
        retryRuntime: PreparedPluginRegistryRuntime;
      }>)
  > {
    const lifecycle = requireRuntimeLifecycle();
    if (
      params.runningSessionRevocationScope
      && (
        params.runningSessionDisposition !== 'revokeRunningSessions'
        || !params.changedPluginIds.includes(
          params.runningSessionRevocationScope.pluginId,
        )
      )
    ) {
      throw new Error(
        'Immutable-generation running Session revocation scope must belong to the changed plugin',
      );
    }
    const hardRevocationRevisions = {
      ...(params.current.revision.hardRevocationRevisions ?? {}),
    };
    for (const [pluginId, revision] of Object.entries(
      params.revision.hardRevocationRevisions ?? {},
    )) {
      hardRevocationRevisions[pluginId] = Math.max(
        hardRevocationRevisions[pluginId] ?? 0,
        revision,
      );
    }
    if (params.runningSessionDisposition === 'revokeRunningSessions') {
      const nextRevision = params.current.commit.revision + 1;
      for (const pluginId of params.changedPluginIds) {
        hardRevocationRevisions[pluginId] = nextRevision;
      }
    }
    const revision: PluginInstallationStateRevision = {
      ...params.revision,
      ...(Object.keys(hardRevocationRevisions).length > 0
        ? { hardRevocationRevisions }
        : {}),
    };
    const installationState = await persistInstallationStateRevision({ paths, state: revision });
    const result = await transactionService.execute({
      transactionId: params.transactionId,
      baseRevision: params.current.commit.revision,
      expectedCurrent: params.current.commit,
      prepare: async () => ({ installationState }),
      validateAndActivate: async () => {
        const candidate = {
          mutationKind: params.mutationKind,
          runningSessionDisposition: params.runningSessionDisposition,
          ...(params.runningSessionRevocationScope
            ? {
                runningSessionRevocationScope:
                  params.runningSessionRevocationScope,
              }
            : {}),
          changedPluginIds: params.changedPluginIds,
          runtimeCatalog: revision.runtimeCatalog ?? emptyState(),
          installationState: revision,
          pluginGenerations: params.pluginGenerations,
          ...(params.preparedActivationGraphsByPluginId
            ? { preparedActivationGraphsByPluginId: params.preparedActivationGraphsByPluginId }
            : {}),
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
        runtime.notifyDurableRunningSessionDisposition?.(record);
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

  async function hardRevokeRunningSessionsForGenerationIntegrityFailure(
    input: Readonly<{
      pluginId: string;
      immutableGenerationId: string;
    }>,
  ): Promise<void> {
    if (!runHardRevocationCurrentnessChange) {
      throw new Error(
        'Runner Agent generation integrity currentness requires the daemon plugin-change owner',
      );
    }
    await runHardRevocationCurrentnessChange(input.pluginId, async (control) => {
      while (true) {
        const current = await readCurrent();
        const installation = current.revision.plugins[input.pluginId];
        const catalogRecord = current.catalog.plugins[input.pluginId];
        if (Boolean(installation) !== Boolean(catalogRecord)) {
          throw new Error(
            'Runner Agent generation integrity currentness has mismatched installation and catalog authority',
          );
        }
        const currentReference =
          current.commit.pluginGenerations[input.pluginId];
        const isCurrentGeneration =
          currentReference?.immutableGenerationId
            === input.immutableGenerationId;
        if (isCurrentGeneration && (!installation || !catalogRecord)) {
          throw new Error(
            'Runner Agent generation integrity currentness has a current generation without installation authority',
          );
        }
        const createdAtMs = nowMs();
        const runtimeCatalog = isCurrentGeneration
          ? PluginStateFileV1Schema.parse({
              ...current.catalog,
              plugins: {
                ...current.catalog.plugins,
                [input.pluginId]: {
                  ...catalogRecord!,
                  state: {
                    ...catalogRecord.state,
                    enabled: false,
                  },
                },
              },
            })
          : current.catalog;
        const revision: PluginInstallationStateRevision = {
          ...current.revision,
          revisionId: `integrity-${randomUUID()}`,
          createdAtMs,
          plugins: isCurrentGeneration
            ? {
                ...current.revision.plugins,
                [input.pluginId]: {
                  ...installation!,
                  enabled: false,
                },
              }
            : current.revision.plugins,
          rollbackRetention: current.revision.rollbackRetention.map((entry) => (
            entry.pluginId === input.pluginId
              && entry.immutableGenerationId
                === input.immutableGenerationId
              ? {
                  ...entry,
                  byteAvailability: 'corrupt' as const,
                }
              : entry
          )),
          runtimeCatalog,
        };
        const committed = await commitRevision({
          current,
          revision,
          pluginGenerations: current.commit.pluginGenerations,
          transactionId: `integrity-${randomUUID()}`,
          createdAtMs,
          mutationKind: 'state',
          runningSessionDisposition: 'revokeRunningSessions',
          runningSessionRevocationScope: Object.freeze({
            kind: 'immutableGeneration',
            pluginId: input.pluginId,
            immutableGenerationId: input.immutableGenerationId,
          }),
          changedPluginIds: Object.freeze([input.pluginId]),
          onApplied: control.onApplied,
        });
        if (committed.status === 'conflict') continue;
        if (
          committed.status === 'aborted'
          || committed.status === 'precommit_failed'
        ) {
          throwPrecommitFailure(committed);
        }
        if (committed.status === 'committed') {
          reportPendingReconciliation(
            'runner_generation_integrity_failure',
            committed.pendingSurfaces,
            committed.message,
          );
        }
        return;
      }
    });
  }

  async function readExactPreparedCandidate(
    input: CommitPluginRegistryInstallationInput,
  ): Promise<Awaited<ReturnType<typeof readPreparedImmutablePluginGeneration>>> {
    const preparedGeneration = input.preparedGeneration;
    const verifiedGeneration = await readPreparedImmutablePluginGeneration({
      paths,
      immutableGenerationId: preparedGeneration.reference.immutableGenerationId,
    });
    if (
      verifiedGeneration.rootPath !== preparedGeneration.rootPath
      || JSON.stringify(verifiedGeneration.record) !== JSON.stringify(preparedGeneration.record)
      || JSON.stringify(verifiedGeneration.reference) !== JSON.stringify(preparedGeneration.reference)
      || verifiedGeneration.record.pluginId !== input.pluginId
    ) {
      throw new PluginRegistryCandidateConflictError(
        `Plugin '${input.pluginId}' prepared immutable generation identity changed before installation`,
      );
    }
    return verifiedGeneration;
  }

  async function install(input: CommitPluginRegistryInstallationInput): Promise<PluginRegistryTransactionResult> {
    requireRuntimeLifecycle();
    const catalogRecordInput = PluginStateRecordSchema.parse(input.catalogRecord);
    if (
      input.updatePolicy === 'automatic'
      && (input.trust.distribution.kind !== 'npm' || !catalogRecordInput.install.curatedUpdateSource)
    ) {
      throw new Error('Automatic plugin updates require a reviewed curated npm source binding');
    }
    if (input.updatePolicy !== 'automatic' && catalogRecordInput.install.curatedUpdateSource !== undefined) {
      throw new Error('Only automatic plugin updates may retain a curated source binding');
    }
    const suppliedAvailability = input.availability === undefined
      ? undefined
      : PluginInstallationAvailabilityProjectionSchema.parse(input.availability);
    const expectedAvailabilitySourceClass = createDefaultPluginInstallationAvailabilityProjection(
      input.trust.distribution,
    ).sourceClass;
    if (
      suppliedAvailability
      && suppliedAvailability.sourceClass !== expectedAvailabilitySourceClass
    ) {
      throw new Error('Plugin installation availability source class differs from its reviewed distribution');
    }
    if (
      suppliedAvailability?.release
      && (
        suppliedAvailability.release.ref.pluginId !== input.pluginId
        || suppliedAvailability.release.ref.version !== catalogRecordInput.install.manifestVersion
      )
    ) {
      throw new Error('Plugin installation availability release differs from its canonical plugin or version');
    }
    const admittedIntegrity = input.admittedIntegrity === undefined
      ? undefined
      : AlgorithmQualifiedIntegritySchema.parse(input.admittedIntegrity);
    if (admittedIntegrity && input.trust.distribution.kind === 'localPath') {
      throw new Error('Local path plugin installations cannot declare acquisition integrity');
    }
    const reviewedPrincipal = input.installReviewPrincipalDigest === undefined
      ? undefined
      : PluginInstallReviewPrincipalDigestSchema.parse(input.installReviewPrincipalDigest);
    const reviewedPrincipalPresentation = input.installReviewPrincipalPresentation === undefined
      ? undefined
      : PluginInstallReviewPrincipalPresentationV1Schema.parse(
          input.installReviewPrincipalPresentation,
        );
    if (reviewedPrincipalPresentation && !reviewedPrincipal) {
      throw new Error('Plugin install-review principal presentation requires its digest');
    }
    if (
      reviewedPrincipalPresentation
      && reviewedPrincipal
      && !pluginInstallReviewPrincipalPresentationMatchesDigest(
        reviewedPrincipal,
        reviewedPrincipalPresentation,
      )
    ) {
      throw new Error('Plugin install-review principal presentation digest mismatch');
    }
    if (input.trust.pluginId !== input.pluginId) throw new Error('Plugin installation trust identity mismatch');
    if (catalogRecordInput.install.trust && JSON.stringify(catalogRecordInput.install.trust) !== JSON.stringify(input.trust)) {
      throw new Error('Plugin installation catalog trust differs from the reviewed trust identity');
    }
    await ensurePluginStoreDirectories({ happyHomeDir: paths.happyHomeDir });
    const preparedGeneration = input.preparedGeneration;
    const immutableGenerationId = preparedGeneration.reference.immutableGenerationId;
    const verifiedGeneration = await readExactPreparedCandidate(input);
    const generationRecord = verifiedGeneration.record;
    if (input.preparedActivationGraph) {
      const [verifiedRootPath, graphRootPath, graphEntryPath] = await Promise.all([
        realpath(verifiedGeneration.rootPath),
        realpath(input.preparedActivationGraph.rootPath),
        realpath(input.preparedActivationGraph.entryPath),
      ]);
      const entryRelativePath = relative(verifiedRootPath, graphEntryPath);
      const portableEntryPath = entryRelativePath.split(sep).join('/');
      if (
        input.preparedActivationGraph.immutableGenerationId !== immutableGenerationId
        || graphRootPath !== verifiedRootPath
        || graphEntryPath === verifiedRootPath
        || !isCanonicalAbsolutePathInsideRoot(verifiedRootPath, graphEntryPath)
        || !generationRecord.files.some((file) => file.relativePath === portableEntryPath)
      ) {
        throw new PluginRegistryCandidateConflictError(
          `Plugin '${input.pluginId}' prepared activation graph is not bound to its exact immutable generation`,
        );
      }
    }
    // A source-only candidate must name the generation it cloned before the
    // candidate was built. Reading a base only at apply time would allow a
    // concurrent successor to become the apparent base while this candidate's
    // untouched files still derive from an older generation.
    const developmentBaseGenerationId = input.developmentBaseGenerationId
      ?? (input.developmentChangedPaths
        ? (await readPersistedCurrent())?.commit.pluginGenerations[input.pluginId]?.immutableGenerationId
        : undefined);
    if (
      (input.developmentChangedPaths || input.developmentBaseGenerationId !== undefined)
      && !developmentBaseGenerationId
    ) {
      throw new PluginRegistryCandidateConflictError(
        `Plugin '${input.pluginId}' has no current immutable generation for a development edit`,
      );
    }
    let retryRuntime: PreparedPluginRegistryRuntime | undefined;
    try {
      while (true) {
        const current = await readCurrent();
        if (
          developmentBaseGenerationId
          && current.commit.pluginGenerations[input.pluginId]?.immutableGenerationId
            !== developmentBaseGenerationId
        ) {
          throw new PluginRegistryCandidateConflictError(
            `Plugin '${input.pluginId}' current generation changed during development preparation`,
          );
        }
        const createdAtMs = nowMs();
        const priorInstallation = current.revision.plugins[input.pluginId];
        const availability = suppliedAvailability
          ?? (input.developmentChangedPaths ? priorInstallation?.availability : undefined)
          ?? createDefaultPluginInstallationAvailabilityProjection(input.trust.distribution);
        const installReviewPrincipalDigest = reviewedPrincipal
          ?? (input.developmentChangedPaths
            ? priorInstallation?.installReviewPrincipalDigest
            : undefined);
        const installReviewPrincipalPresentation = reviewedPrincipalPresentation
          ?? (input.developmentChangedPaths
            ? priorInstallation?.installReviewPrincipalPresentation
            : undefined);
        const priorCatalogRecord = current.catalog.plugins[input.pluginId];
        const catalogRecord = PluginStateRecordSchema.parse({
        ...catalogRecordInput,
        source: {
          ...catalogRecordInput.source,
          resolvedPath: verifiedGeneration.rootPath,
          manifestPath: join(verifiedGeneration.rootPath, ...generationRecord.manifestRelativePath.split('/')),
        },
        install: {
          ...catalogRecordInput.install,
          mode: 'managed_install',
          installedPath: verifiedGeneration.rootPath,
          trust: input.trust,
          updatePolicy: input.updatePolicy,
          optionalAccess: input.optionalAccess,
        },
        state: {
          ...catalogRecordInput.state,
          enabled: priorInstallation && priorCatalogRecord?.install.trust
            ? priorInstallation.enabled
            : catalogRecordInput.state.enabled,
        },
        });
        const priorReference = current.commit.pluginGenerations[input.pluginId];
        const retainsPriorLineage = priorInstallation !== undefined
          && pluginDistributionRollbackLineagesEqual(priorInstallation.source.distribution, input.trust.distribution);
        const retainedForOtherPlugins = current.revision.rollbackRetention.filter((entry) => entry.pluginId !== input.pluginId);
        const retainedCatalogForOtherPlugins = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
          .filter(([generationId]) => retainedForOtherPlugins.some((entry) => entry.immutableGenerationId === generationId)));
        const rollbackRetention = [...retainedForOtherPlugins];
        const retainedRuntimeCatalog: Record<string, PluginStateRecord> = { ...retainedCatalogForOtherPlugins };
        if (priorReference && retainsPriorLineage) {
        await readPreparedImmutablePluginGeneration({
          paths,
          immutableGenerationId: priorReference.immutableGenerationId,
        });
        const priorCatalog = current.catalog.plugins[input.pluginId];
        if (!priorCatalog) throw new Error(`Current plugin '${input.pluginId}' has incomplete rollback state`);
        rollbackRetention.push({
          pluginId: input.pluginId,
          immutableGenerationId: priorReference.immutableGenerationId,
          retainedAtMs: createdAtMs,
          byteAvailability: 'available',
          pluginVersion: priorCatalog.install.manifestVersion,
          distribution: priorInstallation.source.distribution,
          ...(priorInstallation.availability
            ? { availability: priorInstallation.availability }
            : {}),
          ...(priorInstallation.source.admittedIntegrity
            ? { admittedIntegrity: priorInstallation.source.admittedIntegrity }
            : {}),
          ...(priorInstallation.installReviewPrincipalDigest
            ? { installReviewPrincipalDigest: priorInstallation.installReviewPrincipalDigest }
            : {}),
          ...(priorInstallation.installReviewPrincipalPresentation
            ? { installReviewPrincipalPresentation: priorInstallation.installReviewPrincipalPresentation }
            : {}),
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
            materializationId: priorInstallation?.materializationId ?? createPluginMaterializationId(),
            trust: input.trust,
            source: {
              distribution: input.trust.distribution,
              ...(admittedIntegrity ? { admittedIntegrity } : {}),
            },
            updatePolicy: input.updatePolicy,
            optionalAccess: [...input.optionalAccess],
            availability,
            ...(installReviewPrincipalDigest
              ? { installReviewPrincipalDigest }
              : {}),
            ...(installReviewPrincipalPresentation
              ? { installReviewPrincipalPresentation }
              : {}),
          },
        },
        rollbackRetention,
        runtimeCatalog,
        retainedRuntimeCatalog,
        };
        const pluginGenerations = {
        ...current.commit.pluginGenerations,
        [input.pluginId]: verifiedGeneration.reference,
        };
        await readExactPreparedCandidate(input);
        const committed = await commitRevision({
        current,
        revision,
        pluginGenerations,
        transactionId: `install-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'install',
        runningSessionDisposition: 'retainRunningSessions',
        changedPluginIds: Object.freeze([input.pluginId]),
        ...(retryRuntime ? { retryRuntime } : {}),
        retainRuntimeOnConflict: true,
        ...(input.preparedActivationGraph
          ? {
              preparedActivationGraphsByPluginId: new Map([
                [input.pluginId, input.preparedActivationGraph],
              ]),
            }
          : {}),
        });
        retryRuntime = undefined;
        if (committed.status === 'conflict') {
        retryRuntime = 'retryRuntime' in committed ? committed.retryRuntime : undefined;
          continue;
        }
        if (committed.status === 'aborted' || committed.status === 'precommit_failed') {
        throwPrecommitFailure(committed);
        }
      // `outcomeUnknown` can mean the durable commit was written but its
      // acknowledgement failed. Preserve the candidate in either non-conflict
      // outcome because the committed record may already reference it.
        preparedGeneration.adopt();
        return committed;
      }
    } finally {
      await retryRuntime?.abort().catch(() => undefined);
    }
  }

  async function rollbackWithResult(pluginId: string): Promise<PluginRegistryStateMutationResult> {
    requireRuntimeLifecycle();
    while (true) {
      const current = await readCurrent();
      const currentReference = current.commit.pluginGenerations[pluginId];
      const currentCatalog = current.catalog.plugins[pluginId];
      const installation = current.revision.plugins[pluginId];
      const targetRetention = current.revision.rollbackRetention.find((entry) => (
        entry.pluginId === pluginId && entry.byteAvailability === 'available'
      ));
      if (!currentReference || !currentCatalog || !installation || !targetRetention) {
        throw new Error(`Plugin '${pluginId}' has no available rollback generation`);
      }
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
        retainedAtMs: createdAtMs,
        byteAvailability: 'available' as const,
        pluginVersion: currentCatalog.install.manifestVersion,
        distribution: installation.source.distribution,
        ...(installation.availability
          ? { availability: installation.availability }
          : {}),
        ...(installation.source.admittedIntegrity
          ? { admittedIntegrity: installation.source.admittedIntegrity }
          : {}),
        ...(installation.installReviewPrincipalDigest
          ? { installReviewPrincipalDigest: installation.installReviewPrincipalDigest }
          : {}),
        ...(installation.installReviewPrincipalPresentation
          ? { installReviewPrincipalPresentation: installation.installReviewPrincipalPresentation }
          : {}),
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
      const {
        installReviewPrincipalDigest: _currentInstallReviewPrincipalDigest,
        installReviewPrincipalPresentation: _currentInstallReviewPrincipalPresentation,
        ...installationWithoutInstallReviewPrincipalDigest
      } = installation;
      const runtimeCatalog = PluginStateFileV1Schema.parse({
        ...current.catalog,
        plugins: { ...current.catalog.plugins, [pluginId]: rolledBackCatalog },
      });
      const retainedRuntimeCatalog = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
        .filter(([generationId]) => generationId !== targetRetention.immutableGenerationId));
      retainedRuntimeCatalog[priorGeneration.record.immutableGenerationId] = currentCatalog;
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins: {
          ...current.revision.plugins,
          [pluginId]: {
            ...installationWithoutInstallReviewPrincipalDigest,
            enabled: rolledBackCatalog.state.enabled,
            trust: targetTrust,
            source: {
              distribution: targetRetention.distribution,
              ...(targetRetention.admittedIntegrity
                ? { admittedIntegrity: targetRetention.admittedIntegrity }
                : {}),
            },
            availability: targetRetention.availability
              ?? createDefaultPluginInstallationAvailabilityProjection(targetRetention.distribution),
            ...(targetRetention.installReviewPrincipalDigest
              ? { installReviewPrincipalDigest: targetRetention.installReviewPrincipalDigest }
              : {}),
            ...(targetRetention.installReviewPrincipalPresentation
              ? { installReviewPrincipalPresentation: targetRetention.installReviewPrincipalPresentation }
              : {}),
          },
        },
        rollbackRetention,
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
        runningSessionDisposition: 'retainRunningSessions',
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
      const current = await readCurrent();
      const reference = current.commit.pluginGenerations[pluginId];
      const catalogRecord = current.catalog.plugins[pluginId];
      const installation = current.revision.plugins[pluginId];
      if (!reference || !catalogRecord || !installation) {
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
        runtimeCatalog,
      };
      const committed = await commitRevision({
        current,
        revision,
        pluginGenerations: current.commit.pluginGenerations,
        transactionId: `state-${randomUUID()}`,
        createdAtMs,
        mutationKind: 'state',
        runningSessionDisposition: enabled
          ? 'retainRunningSessions'
          : 'revokeRunningSessions',
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
        runningSessionDisposition: 'revokeRunningSessions',
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
  ): Promise<PluginRegistryStateMutationResult | null> {
    requireRuntimeLifecycle();
    while (true) {
      const current = await readCurrent();
      if (!current.revision.plugins[pluginId]) {
        throw new Error(`Unknown plugin id: ${pluginId}`);
      }
      const { [pluginId]: _catalog, ...catalogPlugins } = current.catalog.plugins;
      const { [pluginId]: _installation, ...plugins } = current.revision.plugins;
      const { [pluginId]: _generation, ...pluginGenerations } = current.commit.pluginGenerations;
      const rollbackRetention = current.revision.rollbackRetention.filter((entry) => entry.pluginId !== pluginId);
      const retainedIds = new Set(rollbackRetention.map((entry) => entry.immutableGenerationId));
      const retainedRuntimeCatalog = Object.fromEntries(Object.entries(current.revision.retainedRuntimeCatalog ?? {})
        .filter(([generationId]) => retainedIds.has(generationId)));
      const runtimeCatalog = PluginStateFileV1Schema.parse({ ...current.catalog, plugins: catalogPlugins });
      const createdAtMs = nowMs();
      const revision: PluginInstallationStateRevision = {
        ...current.revision,
        revisionId: `state-${randomUUID()}`,
        createdAtMs,
        plugins,
        rollbackRetention,
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
        runningSessionDisposition: 'revokeRunningSessions',
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
      const retainedCatalog = current.revision.retainedRuntimeCatalog?.[retention.immutableGenerationId];
      const retainedTrust = retainedCatalog?.install.trust;
      if (
        !installation
        || !retainedCatalog
        || !retainedTrust
        || retainedTrust.pluginId !== retention.pluginId
        || !pluginDistributionIdentitiesEqual(retainedTrust.distribution, retention.distribution)
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
    initialize,
    read: async () => (await readPersistedCurrent())?.catalog ?? emptyState(),
    readAvailabilityInventory: async () => {
      const current = await readPersistedCurrent();
      return current
        ? await projectAvailabilityInventory(current)
        : Object.freeze({
            revision: 0,
            releasePublications: Object.freeze([]),
            materializations: await projectBundledAvailabilityMaterializations(),
          });
    },
    readAvailabilityInventoryForCommit: async (record) => (
      await projectAvailabilityInventory(await readCommittedState(record))
    ),
    readSnapshot: async () => {
      const current = await readPersistedCurrent();
      if (!current) {
        return Object.freeze({
          revision: -1,
          state: emptyState(),
          pluginGenerations: Object.freeze({}),
          materializationIdsByPluginId: Object.freeze({}),
          rollbackAvailabilityByPluginId: Object.freeze({}),
          admittedIntegrityByPluginId: Object.freeze({}),
          installReviewPrincipalDigestsByPluginId: Object.freeze({}),
          installReviewPrincipalPresentationsByPluginId: Object.freeze({}),
        });
      }
      return Object.freeze({
        revision: current.commit.revision,
        state: current.catalog,
        pluginGenerations: current.commit.pluginGenerations,
        materializationIdsByPluginId: Object.freeze(Object.fromEntries(
          Object.entries(current.revision.plugins).flatMap(([pluginId, installation]) => (
            installation.materializationId
              ? [[pluginId, installation.materializationId] as const]
              : []
          )),
        )),
        rollbackAvailabilityByPluginId: await inspectRollbackAvailability(current),
        admittedIntegrityByPluginId: Object.freeze(Object.fromEntries(
          Object.entries(current.revision.plugins).flatMap(([pluginId, installation]) => (
            installation.source.distribution.kind !== 'localPath'
              && installation.source.admittedIntegrity
              ? [[pluginId, installation.source.admittedIntegrity] as const]
              : []
          )),
        )),
        installReviewPrincipalDigestsByPluginId: Object.freeze(Object.fromEntries(
          Object.entries(current.revision.plugins).flatMap(([pluginId, installation]) => (
            installation.installReviewPrincipalDigest
              ? [[pluginId, installation.installReviewPrincipalDigest] as const]
              : []
          )),
        )),
        installReviewPrincipalPresentationsByPluginId: Object.freeze(Object.fromEntries(
          Object.entries(current.revision.plugins).flatMap(([pluginId, installation]) => (
            installation.installReviewPrincipalPresentation
              ? [[pluginId, installation.installReviewPrincipalPresentation] as const]
              : []
          )),
        )),
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
    hardRevokeRunningSessionsForGenerationIntegrityFailure,
  });
}
