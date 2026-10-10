import {
  assertMutagenEngineArtifactPayload,
  ensureInstalledFirstPartyComponent,
  MUTAGEN_ENGINE_VERSION,
  resolveInstalledFirstPartyComponentPaths,
  resolveMutagenEngineArtifactPaths,
  resolveMutagenEngineArtifactTarget,
  resolveMutagenEngineDataLayout,
  type MutagenEngineArtifactTarget,
} from '@happier-dev/cli-common/firstPartyRuntime';
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';
import type { WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncRuntimeReadinessV1, WorkspaceSyncStatusV1 } from '@happier-dev/protocol';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  getActiveProjectAccountRowsSnapshot,
  subscribeActiveProjectAccountRowsSnapshot,
  type ActiveProjectAccountRowsSnapshot,
  type ProjectAccountRowsSnapshotListener,
} from '@/workspaces/projectAccountRows';
import {
  WorkspaceSyncController,
  type WorkspaceSyncControllerOptions,
  type WorkspaceSyncLocalAgentStreamOpen,
  type WorkspaceSyncConflictResolutionAuthorizationAssert,
  type WorkspaceSyncOwnedLocalAgent,
  type WorkspaceSyncResolvedRef,
  type WorkspaceSyncTargetFileRead,
  type WorkspaceSyncTargetEntryObserve,
} from '@/workspaces/sync/workspaceSyncController';
import type { WorkspaceSyncMachineTunnelOpen } from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import {
  createWorkspaceSyncHandoffAdapter,
  type PrepareWorkspaceSyncHandoffInput,
  type WorkspaceSyncHandoffAdapter,
  type WorkspaceSyncHandoffAdapterDeps,
} from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import { createWorkspaceSyncMutagenAdapter } from '@/workspaces/sync/workspaceSyncMutagenAdapter';
import {
  ensureProtectedLocalStateDirectory,
  type WindowsProtectedLocalStateAclBoundary,
} from '@/utils/fs/protectedLocalState';
import type {
  WorkspaceRootOwnershipHandle,
  WorkspaceRootOwnershipManager,
} from '@/workspaces/sync/workspaceSyncRootOwnership';
import {
  WorkspaceSyncSidecarLifecycle,
  type SpawnWorkspaceSyncSidecar,
  type WorkspaceSyncSidecarLifecycleDependencies,
} from '@/workspaces/sync/workspaceSyncSidecarLifecycle';
import type { ManagedWorkspaceSync, WorkspaceSyncRelationshipPreparation } from '@/workspaces/sync/workspaceSyncTypes';
import type { WorkspaceSyncRelationshipOwner } from '@/workspaces/sync/workspaceSyncRelationshipOwner';
import type { Duplex } from 'node:stream';

type InstalledPaths = Readonly<{ currentPath: string; resolvedCurrentPath: string | null }>;
type ArtifactPaths = Readonly<{ managerPath: string; agentPath: string }>;
type ArtifactManifest = Readonly<{ engineVersion: string; protocolEpoch: string }>;
type DataLayout = Readonly<{ rootDir: string; dataDir: string; brokerDir: string }>;

export type LaunchWorkspaceSyncLocalAgent = (input: Readonly<{
  executablePath: string;
  args: readonly string[];
  /** The same private Mutagen state root used by this daemon's sidecar. */
  dataDirectory: string;
  signal?: AbortSignal;
  environment?: never;
}>) => Promise<WorkspaceSyncOwnedLocalAgent>;

export type DaemonWorkspaceSyncRuntimeDependencies = Readonly<{
  daemonDataRoot: string;
  localServerId: string;
  localMachineId: string;
  releaseChannel: PublicReleaseRingId;
  resolveWorkspaceRef(id: string, copyOperationId?: string): WorkspaceSyncResolvedRef | null | Promise<WorkspaceSyncResolvedRef | null>;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  prepareRelationshipTarget(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal, preparation?: WorkspaceSyncRelationshipPreparation): Promise<Readonly<{
    ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
  }> | void>;
  recoverCopyOnceTarget?(operation: WorkspaceSyncCopyOnceV1): Promise<Readonly<{
    release(reason: 'abort' | 'commit'): Promise<void>;
  }>>;
  borrowLinkedSourceRoot?: WorkspaceSyncControllerOptions['borrowLinkedSourceRoot'];
  bootstrap: WorkspaceSyncHandoffAdapterDeps['bootstrap'];
  createBroker: WorkspaceSyncSidecarLifecycleDependencies['createBroker'];
  spawnSidecar: SpawnWorkspaceSyncSidecar;
  launchLocalAgent: LaunchWorkspaceSyncLocalAgent;
  stopRetainedNativeProcesses?: () => Promise<void>;
  openMachineCarrierTunnel?: WorkspaceSyncMachineTunnelOpen;
  handoffRelationshipController?: Pick<ManagedWorkspaceSync, 'flush'>;
  handoffPrepareBetween?: WorkspaceSyncHandoffAdapterDeps['prepareBetween'];
  resolveHandoffExecutionInput?: WorkspaceSyncHandoffAdapterDeps['resolveExecutionInput'];
  relationshipOwner?: Pick<WorkspaceSyncRelationshipOwner, 'materializeEndpoints' | 'prepareCreate'>;
  stageConflictResolutionAtTarget?: NonNullable<WorkspaceSyncControllerOptions['stageConflictResolutionAtTarget']>;
  applyStagedConflictResolutionAtTarget?: NonNullable<WorkspaceSyncControllerOptions['applyStagedConflictResolutionAtTarget']>;
  discardStagedConflictResolutionAtTarget?: NonNullable<WorkspaceSyncControllerOptions['discardStagedConflictResolutionAtTarget']>;
  releaseConflictResolutionCaptureAtSource?: NonNullable<WorkspaceSyncControllerOptions['releaseConflictResolutionCaptureAtSource']>;
  recoverConflictResolutionAtTarget?: NonNullable<WorkspaceSyncControllerOptions['recoverConflictResolutionAtTarget']>;
  readFileAtTarget?: WorkspaceSyncTargetFileRead;
  observeEntryAtTarget?: WorkspaceSyncTargetEntryObserve;
  assertConflictResolutionAuthorized?: WorkspaceSyncConflictResolutionAuthorizationAssert;
  getProjectSnapshot?: () => ActiveProjectAccountRowsSnapshot | null;
  subscribeProjectSnapshot?: (listener: ProjectAccountRowsSnapshotListener) => () => void;
  resolveInstalledComponentPaths?: (input: Readonly<{ componentId: 'mutagen-engine'; channel: PublicReleaseRingId }>) => InstalledPaths;
  ensureInstalledComponent?: typeof ensureInstalledFirstPartyComponent;
  resolveArtifactPaths?: (payloadRoot: string, targetTriple: MutagenEngineArtifactTarget) => ArtifactPaths;
  assertArtifactPayload?: (input: Readonly<{ payloadRoot: string; targetTriple: MutagenEngineArtifactTarget; engineVersion?: string }>) => ArtifactManifest | Promise<ArtifactManifest>;
  resolveArtifactTarget?: () => MutagenEngineArtifactTarget;
  resolveDataLayout?: (input: Readonly<{ daemonDataRoot: string; stackDevTargetMutagenDataDir?: string | null }>) => DataLayout;
  platform?: NodeJS.Platform;
  windowsAclBoundary?: WindowsProtectedLocalStateAclBoundary;
  ensurePrivateDirectory?: (path: string) => Promise<void>;
  randomBytes?: (length: number) => Uint8Array;
  randomId?: () => string;
  /**
   * Retired legacy-state availability assertion derived by the production
   * composition from its one startup inspection; enforced by the controller
   * before every state-touching entry point.
   */
  assertLegacyStateAvailable?: () => void;
  onStatusPublished?: (status: WorkspaceSyncStatusV1) => void;
  onEngineReadinessPublished?: (readiness: WorkspaceSyncRuntimeReadinessV1['engine']) => void;
}>;

export type DaemonWorkspaceSyncRuntime = Readonly<{
  handoffAdapter: WorkspaceSyncHandoffAdapter;
  managedWorkspaceSync: ManagedWorkspaceSync;
  openExternalStream(input: Readonly<{ endpointId: string; signal?: AbortSignal }>): Promise<Duplex>;
  openRootedAgent: WorkspaceSyncLocalAgentStreamOpen;
  start(): Promise<void>;
  stop(): Promise<void>;
  whenProjectsSettled(target?: Readonly<{
    graphRevision: number | 'absent';
    scopeKey?: string;
    signal?: AbortSignal;
  }>): Promise<void>;
}>;

/**
 * Daemon composition root for the single workspace-sync manager, broker,
 * controller, and handoff adapter. Durable relationship authority remains in
 * Project rows and reconciliation remains in WorkspaceSyncController.
 */
export function createDaemonWorkspaceSyncRuntime(
  dependencies: DaemonWorkspaceSyncRuntimeDependencies,
): DaemonWorkspaceSyncRuntime {
  const platform = dependencies.platform ?? process.platform;
  const resolveInstalled = dependencies.resolveInstalledComponentPaths ?? resolveInstalledFirstPartyComponentPaths;
  const ensureInstalled = dependencies.ensureInstalledComponent ?? ensureInstalledFirstPartyComponent;
  const resolvePaths = dependencies.resolveArtifactPaths ?? resolveMutagenEngineArtifactPaths;
  const assertPayload = dependencies.assertArtifactPayload ?? assertMutagenEngineArtifactPayload;
  const resolveTarget = dependencies.resolveArtifactTarget ?? (() => resolveMutagenEngineArtifactTarget());
  const resolveLayout = dependencies.resolveDataLayout ?? resolveMutagenEngineDataLayout;
  const layout = resolveLayout({
    daemonDataRoot: dependencies.daemonDataRoot,
    stackDevTargetMutagenDataDir: process.env.MUTAGEN_DATA_DIRECTORY,
  });
  const getSnapshot = dependencies.getProjectSnapshot ?? getActiveProjectAccountRowsSnapshot;
  const subscribeSnapshot = dependencies.subscribeProjectSnapshot ?? subscribeActiveProjectAccountRowsSnapshot;
  let acceptedRelationships: readonly WorkspaceSyncRelationshipV1[] = [];

  let verifiedRuntime: Promise<Readonly<{
    managerPath: string;
    agentPath: string;
    dataDir: string;
    brokerDir: string;
    manifest: ArtifactManifest;
  }>> | null = null;
  const resolveRuntime = () => {
    if (verifiedRuntime) return verifiedRuntime;
    const pending = Promise.resolve().then(async () => {
      const targetTriple = resolveTarget();
      const validatePayload = (payloadRoot: string) => assertPayload({
        payloadRoot,
        targetTriple,
        engineVersion: MUTAGEN_ENGINE_VERSION,
      });
      let installed: InstalledPaths;
      let manifest: ArtifactManifest;
      try {
        installed = resolveInstalled({ componentId: 'mutagen-engine', channel: dependencies.releaseChannel });
        manifest = await validatePayload(installed.resolvedCurrentPath ?? installed.currentPath);
      } catch {
        installed = await ensureInstalled({
          componentId: 'mutagen-engine',
          channel: dependencies.releaseChannel,
          versionId: MUTAGEN_ENGINE_VERSION,
          validatePayload,
        });
        manifest = await validatePayload(installed.resolvedCurrentPath ?? installed.currentPath);
      }
      const payloadRoot = installed.resolvedCurrentPath ?? installed.currentPath;
      const paths = resolvePaths(payloadRoot, targetTriple);
      return { managerPath: paths.managerPath, agentPath: paths.agentPath, dataDir: layout.dataDir, brokerDir: layout.brokerDir, manifest };
    });
    verifiedRuntime = pending;
    void pending.finally(() => {
      if (verifiedRuntime === pending) verifiedRuntime = null;
    }).catch(() => undefined);
    return pending;
  };

  let controller!: WorkspaceSyncController;
  let reconcileAfterSidecarRestart: (() => Promise<void>) | null = null;
  const lifecycle = new WorkspaceSyncSidecarLifecycle({
    resolveRuntime,
    createBroker: dependencies.createBroker,
    openExternalStream: async (context) => await controller.openExternalStream({
      endpointId: context.endpointId,
      signal: context.signal,
    }),
    spawn: dependencies.spawnSidecar,
    ensurePrivateDirectory: dependencies.ensurePrivateDirectory
      ?? (async (path) => await ensureProtectedLocalStateDirectory(path, {
        platform,
        authority: 'owned',
        ...(dependencies.windowsAclBoundary ? { windowsAclBoundary: dependencies.windowsAclBoundary } : {}),
      })),
    randomBytes: dependencies.randomBytes ?? ((length) => randomBytes(length)),
    randomId: dependencies.randomId ?? randomUUID,
    onRestartReady: async () => {
      if (!reconcileAfterSidecarRestart) {
        throw new Error('Workspace sync restart reconciliation is unavailable');
      }
      await reconcileAfterSidecarRestart();
    },
    ...(dependencies.onEngineReadinessPublished
      ? { onReadinessChanged: dependencies.onEngineReadinessPublished }
      : {}),
  });
  const adapter = createWorkspaceSyncMutagenAdapter({
    send: async (command, signal) => await lifecycle.command(command, signal),
    resolveWorkspaceRef: dependencies.resolveWorkspaceRef,
  });
  const openRootedAgent: WorkspaceSyncLocalAgentStreamOpen = async (input) => {
    const runtime = await resolveRuntime();
    return await dependencies.launchLocalAgent({
      executablePath: runtime.agentPath,
      args: ['synchronizer', '--external', '--root', input.canonicalRoot],
      dataDirectory: runtime.dataDir,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  };
  controller = new WorkspaceSyncController({
    adapter,
    lifecycle,
    localServerId: dependencies.localServerId,
    localMachineId: dependencies.localMachineId,
    resolveWorkspaceRef: dependencies.resolveWorkspaceRef,
    rootOwnershipManager: dependencies.rootOwnershipManager,
    resolveRelationshipDefinition: (relationshipId) => {
      const matches = acceptedRelationships.filter((candidate) => (
        candidate.relationshipId === relationshipId
        && candidate.enabled
        && candidate.controllerMachineId === dependencies.localMachineId
      ));
      return matches.length === 1 ? matches[0]! : null;
    },
    prepareRelationshipTarget: dependencies.prepareRelationshipTarget,
    ...(dependencies.recoverCopyOnceTarget ? { recoverCopyOnceTarget: dependencies.recoverCopyOnceTarget } : {}),
    ...(dependencies.borrowLinkedSourceRoot ? { borrowLinkedSourceRoot: dependencies.borrowLinkedSourceRoot } : {}),
    ...(dependencies.openMachineCarrierTunnel ? { openMachineCarrierTunnel: dependencies.openMachineCarrierTunnel } : {}),
    openLocalWorkspaceAgentStream: openRootedAgent,
    ...(dependencies.stageConflictResolutionAtTarget ? { stageConflictResolutionAtTarget: dependencies.stageConflictResolutionAtTarget } : {}),
    ...(dependencies.applyStagedConflictResolutionAtTarget ? { applyStagedConflictResolutionAtTarget: dependencies.applyStagedConflictResolutionAtTarget } : {}),
    ...(dependencies.discardStagedConflictResolutionAtTarget ? { discardStagedConflictResolutionAtTarget: dependencies.discardStagedConflictResolutionAtTarget } : {}),
    ...(dependencies.releaseConflictResolutionCaptureAtSource ? { releaseConflictResolutionCaptureAtSource: dependencies.releaseConflictResolutionCaptureAtSource } : {}),
    ...(dependencies.recoverConflictResolutionAtTarget ? { recoverConflictResolutionAtTarget: dependencies.recoverConflictResolutionAtTarget } : {}),
    ...(dependencies.readFileAtTarget ? { readFileAtTarget: dependencies.readFileAtTarget } : {}),
    ...(dependencies.observeEntryAtTarget ? { observeEntryAtTarget: dependencies.observeEntryAtTarget } : {}),
    ...(dependencies.assertConflictResolutionAuthorized ? { assertConflictResolutionAuthorized: dependencies.assertConflictResolutionAuthorized } : {}),
    ...(dependencies.assertLegacyStateAvailable ? { assertLegacyStateAvailable: dependencies.assertLegacyStateAvailable } : {}),
    ...(dependencies.onStatusPublished ? { onStatusPublished: dependencies.onStatusPublished } : {}),
  });
  const handoffAdapter = createWorkspaceSyncHandoffAdapter({
    sync: controller,
    localMachineId: dependencies.localMachineId,
    ...(dependencies.handoffRelationshipController
      ? { relationshipController: dependencies.handoffRelationshipController }
      : {}),
    ...(dependencies.handoffPrepareBetween ? { prepareBetween: dependencies.handoffPrepareBetween } : {}),
    ...(dependencies.resolveHandoffExecutionInput ? { resolveExecutionInput: dependencies.resolveHandoffExecutionInput } : {}),
    ...(dependencies.relationshipOwner ? { relationshipOwner: dependencies.relationshipOwner } : {}),
    bootstrap: dependencies.bootstrap,
  });

  let unsubscribe: (() => void) | null = null;
  let projectTail: Promise<void> = Promise.resolve();
  let projectQueueRevision = 0;
  let reconciledSnapshot: ActiveProjectAccountRowsSnapshot | null = null;
  const projectQueueWaiters = new Set<() => void>();
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let started = false;
  let stopped = false;

  const readRelationships = (snapshot: ActiveProjectAccountRowsSnapshot | null): readonly WorkspaceSyncRelationshipV1[] => {
    if (!snapshot) {
      throw Object.assign(new Error('Project rows are unavailable'), { code: 'project_account_rows_unavailable' });
    }
    return snapshot.relationships;
  };

  const applySnapshot = (snapshot: ActiveProjectAccountRowsSnapshot | null): Promise<void> => {
    const next = projectTail.catch(() => undefined).then(async () => {
      const relationships = readRelationships(snapshot);
      acceptedRelationships = relationships;
      await lifecycle.runReconciliation(async () => {
        await controller.rehydrateFromSettings(relationships);
      });
      reconciledSnapshot = snapshot;
    });
    projectTail = next;
    projectQueueRevision += 1;
    for (const resolve of projectQueueWaiters) resolve();
    projectQueueWaiters.clear();
    void next.catch(() => undefined);
    return next;
  };
  reconcileAfterSidecarRestart = async () => await applySnapshot(getSnapshot());

  const start = (): Promise<void> => {
    if (started) return Promise.resolve();
    if (stopped) return Promise.reject(new Error('Daemon workspace sync runtime is stopped'));
    if (startPromise) return startPromise;
    const pending = (async () => {
      unsubscribe ??= subscribeSnapshot((_previous, next) => { void applySnapshot(next); });
      await applySnapshot(getSnapshot());
      started = true;
    })();
    startPromise = pending;
    void pending.finally(() => {
      if (startPromise === pending && !started) startPromise = null;
    }).catch(() => undefined);
    return pending;
  };

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    for (const resolve of projectQueueWaiters) resolve();
    projectQueueWaiters.clear();
    stopPromise = (async () => {
      await startPromise?.catch(() => undefined);
      unsubscribe?.();
      unsubscribe = null;
      await projectTail.catch(() => undefined);
      const cleanupResults = await Promise.allSettled([
        controller.shutdown(),
        dependencies.stopRetainedNativeProcesses?.() ?? Promise.resolve(),
      ]);
      const cleanupFailures = cleanupResults.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
      ));
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      if (cleanupFailures.length > 1) {
        throw new AggregateError(cleanupFailures, 'Daemon workspace sync runtime cleanup failed');
      }
      started = false;
    })().catch((error: unknown) => {
      stopPromise = null;
      throw error;
    });
    return stopPromise;
  };

  const matchesReconciliationTarget = (
    snapshot: ActiveProjectAccountRowsSnapshot | null,
    target: Readonly<{ graphRevision: number | 'absent'; scopeKey?: string }>,
  ): boolean => snapshot !== null
    && (target.graphRevision === 'absent'
      || (snapshot.graphRevision !== 'absent' && snapshot.graphRevision >= target.graphRevision))
    && (target.scopeKey === undefined || snapshot.scopeKey === target.scopeKey);

  const waitForProjectQueueAdvance = (revision: number, signal?: AbortSignal): Promise<void> => {
    if (projectQueueRevision > revision || stopped) return Promise.resolve();
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        projectQueueWaiters.delete(finish);
        reject(signal?.reason ?? Object.assign(new Error('Workspace sync Project wait cancelled'), {
          name: 'AbortError',
          code: 'cancelled',
        }));
      };
      projectQueueWaiters.add(finish);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (projectQueueRevision > revision || stopped) {
        projectQueueWaiters.delete(finish);
        finish();
      }
    });
  };

  const whenProjectsSettled = async (target?: Readonly<{
    graphRevision: number | 'absent';
    scopeKey?: string;
    signal?: AbortSignal;
  }>): Promise<void> => {
    if (!target) {
      await projectTail;
      readRelationships(getSnapshot());
      return;
    }
    readRelationships(getSnapshot());
    while (!matchesReconciliationTarget(reconciledSnapshot, target)) {
      target.signal?.throwIfAborted();
      if (stopped) throw new Error('Daemon workspace sync runtime is stopped');
      const observedRevision = projectQueueRevision;
      await projectTail;
      if (matchesReconciliationTarget(reconciledSnapshot, target)) return;
      if (projectQueueRevision > observedRevision) continue;
      const current = getSnapshot();
      if (matchesReconciliationTarget(current, target)) {
        await applySnapshot(current);
        continue;
      }
      await waitForProjectQueueAdvance(observedRevision, target.signal);
    }
    await projectTail;
  };

  return {
    handoffAdapter,
    managedWorkspaceSync: controller,
    openExternalStream: async (input) => await controller.openExternalStream(input),
    openRootedAgent,
    start,
    stop,
    whenProjectsSettled,
  };
}
