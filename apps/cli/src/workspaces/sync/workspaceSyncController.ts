import { areWorkspaceSyncEntryExpectationsEqual, areWorkspaceSyncRelationshipDefinitionsEqual, ReadWorkspaceSyncFileV1Schema, WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES, WorkspaceSyncConflictInspectRpcRequestV1Schema, WorkspaceSyncConflictInspectRpcResultV1Schema, WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncConflictResolutionV1Schema, WorkspaceSyncCopyOnceV1Schema, WorkspaceSyncRelationshipsListRpcRequestV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncTopology } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { WorkspaceRefV1Schema, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncConflictInspectEndpointV1, WorkspaceSyncConflictInspectRpcRequestV1, WorkspaceSyncConflictInspectRpcResultV1, WorkspaceSyncConflictResolutionResultV1, WorkspaceSyncConflictResolutionV1, WorkspaceSyncConflictResolveActionInputV1, WorkspaceSyncEntryExpectationV1, WorkspaceSyncPathSelectionV1, WorkspaceSyncSelectionDiagnoseV1, WorkspaceSyncRelationshipsListRpcRequestV1, WorkspaceSyncRelationshipsListRpcResultV1 } from '@happier-dev/protocol';
import { machineCarrierUnavailableError } from '@/daemon/peer/iroh/machineCarrier';
import { deriveWorkspaceSyncConflictAsidePaths, deriveWorkspaceSyncConflictOperationId } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { validateWorkspaceSyncRelationship, validateWorkspaceSyncRelationships } from './workspaceSyncSettings';
import { deriveWorkspaceSyncEndpointId } from './transport/workspaceSyncBrokerProtocol';
import {
  connectWorkspaceSyncMachineTunnel,
  type WorkspaceSyncMachineTunnel,
  type WorkspaceSyncMachineTunnelOpenInput,
} from './workspaceSyncMachineCarrierStream';
import type { Duplex } from 'node:stream';
import { realpath } from 'node:fs/promises';
import type { WorkspaceRootOwnershipHandle, WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { resolveWorkspaceSyncRelationshipEndpointRoles } from './workspaceSyncRelationshipEndpoints';
import { probeScmExecutableAvailable } from '@/scm/runtime';
import type { ManagedWorkspaceSync, ReadWorkspaceSyncFileResultV1, ReadWorkspaceSyncFileV1, WorkspaceContentPolicyV1, WorkspaceSyncConflictPageRequestV1, WorkspaceSyncConflictPageV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipPreparation, WorkspaceSyncRelationshipV1, WorkspaceSyncSourceRootLoan, WorkspaceSyncStatusV1 } from './workspaceSyncTypes';
import { observeWorkspaceSyncEntryAtRoot, readWorkspaceSyncFileAtRoot } from './workspaceSyncFileRead';
import { assertWorkspaceSyncStatusClean, isWorkspaceSyncStatusClean } from './workspaceSyncPreparation';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';

export type WorkspaceSyncResolvedRef = Readonly<{
  serverId?: string;
  machineId: string;
  rootPath: string;
}>;
export type WorkspaceSyncConflictResolutionAuthorizationAssert = (
  actionReceiptId: string,
  actionInput: WorkspaceSyncConflictResolveActionInputV1,
) => Promise<void>;
export type WorkspaceSyncTargetFileRead = (input: Readonly<{
  relationshipId: string;
  targetMachineId: string;
  targetWorkspaceRefId: string;
  path: string;
  expectedDigest?: string;
  maxBytes: number;
  signal?: AbortSignal;
}>) => Promise<ReadWorkspaceSyncFileResultV1>;
/**
 * Authenticated observation of one confined entry on a linked endpoint. The
 * target authority resolves the workspace from current settings and retains
 * root custody; a caller-controlled root is never representable. Mirrors the
 * file-preview transport exactly, but returns the canonical full-state entry
 * expectation instead of bounded display bytes.
 */
export type WorkspaceSyncTargetEntryObserve = (input: Readonly<{
  relationshipId: string;
  targetMachineId: string;
  targetWorkspaceRefId: string;
  path: string;
  signal?: AbortSignal;
}>) => Promise<WorkspaceSyncEntryExpectationV1>;
export type WorkspaceSyncCopyOnceTargetRecovery = (operation: WorkspaceSyncCopyOnceV1) => Promise<Readonly<{
  release(reason: 'abort' | 'commit'): Promise<void>;
}>>;
/**
 * Composition supplies this through the verified Mutagen artifact plus the
 * managed-child/process-custody owner. It must launch the exact-build agent as
 * `happier-mutagen-agent synchronizer --external --root <canonicalRoot>` without a shell.
 * The Mutagen synchronizer command uses standard input/output implicitly.
 */
export type WorkspaceSyncOwnedLocalAgent = Readonly<{
  stream: Duplex;
  stop(): Promise<void>;
}>;
type ActiveWorkspaceSyncIngress = {
  stream: Duplex;
  stop: () => Promise<void>;
  cleanupAttempt: Promise<void> | null;
  cleanupFailure?: unknown;
};
type SharedWorkspaceSyncHubParticipation = Readonly<{
  key: string;
  hubWorkspaceRefId: string;
  controllerMachineId: string;
  canonicalRoot: string;
  acquisition: Promise<WorkspaceRootOwnershipHandle>;
  members: Set<string>;
}>;
export type WorkspaceSyncLocalAgentStreamOpen = (input: Readonly<{
  operationId: string;
  role: 'alpha' | 'beta';
  workspaceRefId: string;
  canonicalRoot: string;
  signal?: AbortSignal;
}>) => Promise<WorkspaceSyncOwnedLocalAgent>;
export interface WorkspaceSyncMutagenAdapter {
  discoverCopyOnceRecoveries(signal?: AbortSignal): Promise<readonly WorkspaceSyncCopyOnceV1[]>;
  rehydrate(
    definitions: readonly WorkspaceSyncRelationshipV1[],
    signal?: AbortSignal,
    holdPausedRelationshipIds?: ReadonlySet<string>,
  ): Promise<readonly WorkspaceSyncStatusV1[]>;
  ensure(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  copyOnce(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  get(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null>;
  list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]>;
  flush(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  pause(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  resume(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  terminate(relationshipId: string, signal?: AbortSignal): Promise<void>;
  listConflicts(request: WorkspaceSyncConflictPageRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictPageV1>;
  diagnoseSelection(request: WorkspaceSyncSelectionDiagnoseV1, signal?: AbortSignal): Promise<WorkspaceSyncPathSelectionV1>;
}
export type WorkspaceSyncControllerOptions = Readonly<{
  adapter: WorkspaceSyncMutagenAdapter;
  lifecycle: Readonly<{ start(): Promise<void>; stop(): Promise<void> }>;
  /** Stable Home/server placement of this daemon's registered Machine. */
  localServerId?: string;
  localMachineId: string;
  resolveWorkspaceRef(id: string, copyOperationId?: string): WorkspaceSyncResolvedRef | null | Promise<WorkspaceSyncResolvedRef | null>;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  resolveRelationshipDefinition?(relationshipId: string): WorkspaceSyncRelationshipV1 | null | Promise<WorkspaceSyncRelationshipV1 | null>;
  prepareRelationshipTarget?(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal, preparation?: WorkspaceSyncRelationshipPreparation): Promise<Readonly<{
    /** Borrowed custody; its bootstrap/target authority remains the release owner. */
    ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
  }> | void>;
  recoverCopyOnceTarget?: WorkspaceSyncCopyOnceTargetRecovery;
  borrowLinkedSourceRoot?: (operationId: string, workspaceRefId: string) => Promise<WorkspaceSyncSourceRootLoan | null>;
  openMachineCarrierTunnel?: (
    input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>,
  ) => Promise<WorkspaceSyncMachineTunnel>;
  openLocalWorkspaceAgentStream?: WorkspaceSyncLocalAgentStreamOpen;
  readFileAtTarget?: WorkspaceSyncTargetFileRead;
  observeEntryAtTarget?: WorkspaceSyncTargetEntryObserve;
  stageConflictResolutionAtTarget?: (request: Readonly<{
    actionReceiptId: string;
    actionInput: WorkspaceSyncConflictResolveActionInputV1;
    operationId: string;
    alternativeIndex: number | null;
    relationshipId: string;
    sourceRelationshipId: string;
    sourceMachineId: string;
    sourceWorkspaceRefId: string;
    sourceExpected: WorkspaceSyncEntryExpectationV1;
    targetMachineId: string;
    targetWorkspaceRefId: string;
    targetExpected: WorkspaceSyncEntryExpectationV1;
    path: string;
    signal?: AbortSignal;
  }>) => Promise<void>;
  applyStagedConflictResolutionAtTarget?: (request: Readonly<{
    actionReceiptId: string;
    actionInput: WorkspaceSyncConflictResolveActionInputV1;
    operationId: string;
    alternativeIndex: number | null;
    relationshipId: string;
    targetMachineId: string;
    targetWorkspaceRefId: string;
    path: string;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ status: 'installed' | 'restored' } | { status: 'recovery_needed'; recoveryPath: string }>>;
  discardStagedConflictResolutionAtTarget?: (request: Readonly<{
    actionReceiptId: string;
    actionInput: WorkspaceSyncConflictResolveActionInputV1;
    operationId: string;
    alternativeIndex: number | null;
    relationshipId: string;
    targetMachineId: string;
    targetWorkspaceRefId: string;
    path: string;
    signal?: AbortSignal;
  }>) => Promise<void>;
  releaseConflictResolutionCaptureAtSource?: (request: Readonly<{
    actionReceiptId: string;
    actionInput: WorkspaceSyncConflictResolveActionInputV1;
    operationId: string;
    sourceMachineId: string;
    sourceWorkspaceRefId: string;
  }>) => Promise<void>;
  recoverConflictResolutionAtTarget?: (request: Readonly<{
    relationshipId: string;
    targetMachineId: string;
    targetWorkspaceRefId: string;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ status: 'settled' } | { status: 'recovery_needed'; recoveryPath: string }>>;
  /**
   * Same-Account relationship inventory for cross-controller discovery. The
   * daemon resolves this from its current settings snapshot; the controller
   * never persists it. Absent in unit harnesses, where discovery is
   * explicitly unavailable rather than fabricated.
   */
  resolveAllRelationshipDefinitions?: () => readonly WorkspaceSyncRelationshipV1[] | null | Promise<readonly WorkspaceSyncRelationshipV1[] | null>;
  assertConflictResolutionAuthorized?: WorkspaceSyncConflictResolutionAuthorizationAssert;
  /**
   * Explicit runtime-dependency probe for the `git_worktree` content
   * selection, whose ignore decisions are owned by the persistent Git
   * check-ignore oracle at each endpoint. `all_files` never consults it.
   * Defaults to the canonical SCM command resolution owner.
   */
  probeGitRuntimeDependency?: (signal?: AbortSignal) => Promise<boolean>;
  /**
   * Derived once from the retired-state inspection at the daemon composition
   * boundary. Throws the exact typed legacy-state code when workspace sync
   * must stay disabled; called before any state mutation or engine process
   * action. Subscription registration stays passive and is not gated.
   */
  assertLegacyStateAvailable?: () => void;
  /** Publishes the controller's derived status through the daemon Machine runtime channel. */
  onStatusPublished?: (status: WorkspaceSyncStatusV1) => void;
}>;

function abortIfRequested(signal?: AbortSignal): void { if (signal?.aborted) throw Object.assign(new Error('Workspace sync operation cancelled'), { name: 'AbortError', code: 'cancelled' }); }

/** Endpoint states that lose their current authority mid-read disclose no bytes. */
function readErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

const INSPECT_UNREACHABLE_CODES = new Set([
  'peer_unavailable',
  'target_unavailable',
  'target_bootstrap_offline',
  'relationship_not_ready',
  'relationship_not_owned',
  'relationship_runtime_mismatch',
  'root_changed',
  'workspace_root_ownership_lost',
  'workspace_root_identity_unavailable',
  'controller_unavailable',
  'agent_unavailable',
  'engine_unavailable',
  'workspace_sync_unavailable',
  'workspace_machine_not_enrolled',
]);

/**
 * Maps a confined observation failure to its independent endpoint outcome.
 * Returns null for failures that must fail the request typed instead of
 * becoming endpoint text: malformed input, unknown error codes and
 * cancellation always propagate.
 */
function projectInspectEndpointOutcome(error: unknown): Exclude<WorkspaceSyncConflictInspectEndpointV1['outcome'], 'observed'> | null {
  const code = readErrorCode(error);
  if (code === 'conflict_changed') return 'changed';
  if (code === 'workspace_file_unsupported') return 'unsupported';
  if (code === 'approval_required' || code === 'not_authenticated') return 'revoked';
  if (code !== undefined && INSPECT_UNREACHABLE_CODES.has(code)) return 'unreachable';
  if (code === 'workspace_root_unsafe' && process.platform !== 'linux') {
    // R1's confined entry observer is Linux-only; other platforms cannot
    // verify an entry and must report unsupported rather than clean.
    // Revisit when the observer ships its native confinement elsewhere.
    return 'unsupported';
  }
  return null;
}

function relationshipContainsRef(definition: WorkspaceSyncRelationshipV1, workspaceRefId: string): boolean {
  return definition.alphaWorkspaceRefId === workspaceRefId || definition.betaWorkspaceRefId === workspaceRefId;
}

function isIndeterminate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'indeterminate';
}

function areCopyOnceDefinitionsEqual(left: WorkspaceSyncCopyOnceV1, right: WorkspaceSyncCopyOnceV1): boolean {
  return left.operationId === right.operationId
    && left.controllerMachineId === right.controllerMachineId
    && left.alphaWorkspaceRefId === right.alphaWorkspaceRefId
    && left.betaWorkspaceRefId === right.betaWorkspaceRefId
    && left.contentPolicy.policyDigest === right.contentPolicy.policyDigest;
}

function areContentPoliciesEqual(left: WorkspaceContentPolicyV1, right: WorkspaceContentPolicyV1): boolean {
  return left.v === right.v
    && left.selection === right.selection
    && left.policyDigest === right.policyDigest
    && left.extraIgnorePatterns.length === right.extraIgnorePatterns.length
    && left.extraIgnorePatterns.every((pattern, index) => pattern === right.extraIgnorePatterns[index])
    && left.extraIncludePatterns.length === right.extraIncludePatterns.length
    && left.extraIncludePatterns.every((pattern, index) => pattern === right.extraIncludePatterns[index]);
}

// The manager exposes status through bounded GET/LIST requests rather than a
// push stream. Keep active relationship subscriptions responsive without
// turning status projection into a continuous manager hot loop.
const WORKSPACE_SYNC_STATUS_OBSERVATION_INTERVAL_MS = 1_000;

function areWorkspaceSyncStatusesEqual(left: WorkspaceSyncStatusV1, right: WorkspaceSyncStatusV1): boolean {
  return left.relationshipId === right.relationshipId
    && left.controllerMachineId === right.controllerMachineId
    && left.state === right.state
    && left.alphaPath === right.alphaPath
    && left.betaPath === right.betaPath
    && left.mode === right.mode
    && left.endpointStates.alpha?.connected === right.endpointStates.alpha?.connected
    && left.endpointStates.alpha?.scanned === right.endpointStates.alpha?.scanned
    && left.endpointStates.alpha?.scanProblemCount === right.endpointStates.alpha?.scanProblemCount
    && left.endpointStates.alpha?.transitionProblemCount === right.endpointStates.alpha?.transitionProblemCount
    && left.endpointStates.beta?.connected === right.endpointStates.beta?.connected
    && left.endpointStates.beta?.scanned === right.endpointStates.beta?.scanned
    && left.endpointStates.beta?.scanProblemCount === right.endpointStates.beta?.scanProblemCount
    && left.endpointStates.beta?.transitionProblemCount === right.endpointStates.beta?.transitionProblemCount
    && left.conflictCount === right.conflictCount
    && left.lastCycleObservedAtMs === right.lastCycleObservedAtMs
    && left.errorCode === right.errorCode;
}

async function waitForStatusObservation(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, WORKSPACE_SYNC_STATUS_OBSERVATION_INTERVAL_MS);
    timer.unref?.();
    signal.addEventListener('abort', finish, { once: true });
  });
}

const requiredAdapterMethods = ['discoverCopyOnceRecoveries', 'rehydrate', 'ensure', 'copyOnce', 'get', 'list', 'flush', 'pause', 'resume', 'terminate', 'listConflicts', 'diagnoseSelection'] as const;

function assertCompleteAdapter(adapter: WorkspaceSyncMutagenAdapter): void {
  const record = adapter as unknown as Readonly<Record<string, unknown>>;
  const missing = requiredAdapterMethods.find((method) => typeof record[method] !== 'function');
  if (missing) throw Object.assign(new Error(`Workspace sync adapter does not implement ${missing}`), { code: 'workspace_sync_unavailable' });
}

export class WorkspaceSyncController implements ManagedWorkspaceSync {
  private readonly adapter: WorkspaceSyncMutagenAdapter;
  private readonly localServerId: string | null;
  private readonly localMachineId: string;
  private readonly resolveRef: WorkspaceSyncControllerOptions['resolveWorkspaceRef'];
  private readonly lifecycle: WorkspaceSyncControllerOptions['lifecycle'];
  private readonly rootOwnershipManager: WorkspaceRootOwnershipManager;
  private readonly resolveDefinition: NonNullable<WorkspaceSyncControllerOptions['resolveRelationshipDefinition']>;
  private readonly prepareTarget: NonNullable<WorkspaceSyncControllerOptions['prepareRelationshipTarget']>;
  private readonly recoverCopyTarget?: WorkspaceSyncCopyOnceTargetRecovery;
  private readonly borrowLinkedSourceRoot?: WorkspaceSyncControllerOptions['borrowLinkedSourceRoot'];
  private readonly openMachineCarrier?: WorkspaceSyncControllerOptions['openMachineCarrierTunnel'];
  private readonly openLocalAgent?: WorkspaceSyncLocalAgentStreamOpen;
  private readonly readAtTarget?: WorkspaceSyncTargetFileRead;
  private readonly observeEntryAtTarget?: WorkspaceSyncTargetEntryObserve;
  private readonly stageConflictResolutionAtTarget?: WorkspaceSyncControllerOptions['stageConflictResolutionAtTarget'];
  private readonly applyStagedConflictResolutionAtTarget?: WorkspaceSyncControllerOptions['applyStagedConflictResolutionAtTarget'];
  private readonly discardStagedConflictResolutionAtTarget?: WorkspaceSyncControllerOptions['discardStagedConflictResolutionAtTarget'];
  private readonly releaseConflictResolutionCaptureAtSource?: WorkspaceSyncControllerOptions['releaseConflictResolutionCaptureAtSource'];
  private readonly recoverConflictResolutionAtTarget?: WorkspaceSyncControllerOptions['recoverConflictResolutionAtTarget'];
  private readonly resolveAllDefinitions: () => readonly WorkspaceSyncRelationshipV1[] | null | Promise<readonly WorkspaceSyncRelationshipV1[] | null>;
  private readonly assertConflictResolutionAuthorized?: WorkspaceSyncConflictResolutionAuthorizationAssert;
  private readonly probeGit: NonNullable<WorkspaceSyncControllerOptions['probeGitRuntimeDependency']>;
  private readonly assertStateAvailable: () => void;
  private readonly onStatusPublished: (status: WorkspaceSyncStatusV1) => void;
  private readonly observePersistentStatus: boolean;
  private readonly definitions = new Map<string, WorkspaceSyncRelationshipV1>();
  /** Prepared Action relationships retained until their matching Settings record is published. */
  private readonly transientDefinitions = new Set<string>();
  private readonly copyOperations = new Map<string, WorkspaceSyncCopyOnceV1>();
  private readonly copyFences = new Map<string, readonly WorkspaceRootOwnershipHandle[]>();
  private readonly copyOwnedFences = new Map<string, readonly WorkspaceRootOwnershipHandle[]>();
  private readonly copyTargetReleases = new Map<string, (reason: 'abort' | 'commit') => Promise<void>>();
  private readonly copySourceReleases = new Map<string, () => Promise<void>>();
  private readonly copyTerminalPending = new Set<string>();
  private readonly pendingRootReleases = new Set<WorkspaceRootOwnershipHandle>();
  private readonly statuses = new Map<string, WorkspaceSyncStatusV1>();
  private readonly fences = new Map<string, Readonly<{
    handles: WorkspaceRootOwnershipHandle[];
    ownedHandles: WorkspaceRootOwnershipHandle[];
  }>>();
  private readonly sharedHubParticipations = new Map<string, SharedWorkspaceSyncHubParticipation>();
  private readonly participantHubKeys = new Map<string, Set<string>>();
  private readonly ownershipLost = new Set<string>();
  private readonly activeIngress = new Map<string, Set<ActiveWorkspaceSyncIngress>>();
  private readonly sourceSeedAuthorizations = new Map<string, Readonly<{
    operation: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1;
    ownershipHandles: readonly WorkspaceRootOwnershipHandle[];
    acceptedTargetWorkspace?: WorkspaceRefV1;
  }>>();
  private readonly queues = new Map<string, { task: Promise<unknown>; material: boolean }>();
  private readonly activityListeners = new Set<() => void>();
  private readonly listeners = new Map<string, Set<(status: WorkspaceSyncStatusV1) => void>>();
  private readonly statusObservations = new Map<string, Readonly<{
    abort: AbortController;
    task: Promise<void>;
  }>>();
  private shuttingDown = false;

  readonly activity: LiveWorkProducerV1 = Object.freeze({
    read: async (): Promise<Omit<LiveWorkInventoryV1, 'idleSince'>> => {
      this.assertStateAvailable();
      const saved = await this.resolveAllDefinitions();
      const ids = new Set([
        ...this.definitions.keys(), ...this.copyOperations.keys(), ...this.activeIngress.keys(),
        ...this.sourceSeedAuthorizations.keys(), ...this.copyTargetReleases.keys(), ...this.copySourceReleases.keys(),
        ...[...this.queues].filter(([, queued]) => queued.material).map(([id]) => id),
        ...(saved ?? []).filter(definition => definition.controllerMachineId === this.localMachineId)
          .map(definition => definition.relationshipId),
      ]);
      const items: LiveWorkItemV1[] = [...ids].map(id => {
        const queued = this.queues.get(id)?.material === true;
        const ingress = this.activeIngress.get(id);
        const retained = this.copyOperations.has(id) || this.sourceSeedAuthorizations.has(id)
          || this.copyTargetReleases.has(id) || this.copySourceReleases.has(id);
        const status = this.statuses.get(id);
        const observedSettled = status?.state === 'paused' || status?.state === 'stopped'
          || (status?.state === 'watching' && isWorkspaceSyncStatusClean(status));
        return {
          category: 'sync', ownerRef: id, attribution: { kind: 'unknown' },
          state: queued || retained || (ingress?.size ?? 0) > 0 ? 'active'
            : status?.state === 'starting' || status?.state === 'flushing' ? 'active'
              : observedSettled ? 'settled' : 'unknown',
        };
      });
      return { items, coverage: this.shuttingDown || saved === null || this.pendingRootReleases.size > 0 ? 'unknown' : 'complete' };
    },
    subscribe: (listener: () => void): (() => void) => {
      this.activityListeners.add(listener);
      return () => { this.activityListeners.delete(listener); };
    },
  });

  private notifyActivity(): void {
    for (const listener of this.activityListeners) {
      try { listener(); } catch { /* Observation cannot change Sync custody. */ }
    }
  }

  constructor(options: WorkspaceSyncControllerOptions) { assertCompleteAdapter(options.adapter); this.adapter = options.adapter; this.lifecycle = options.lifecycle; this.localServerId = options.localServerId?.trim() || null; this.localMachineId = options.localMachineId; this.resolveRef = options.resolveWorkspaceRef; this.rootOwnershipManager = options.rootOwnershipManager; this.resolveDefinition = options.resolveRelationshipDefinition ?? (() => null); this.prepareTarget = options.prepareRelationshipTarget ?? (async () => undefined); this.recoverCopyTarget = options.recoverCopyOnceTarget; this.borrowLinkedSourceRoot = options.borrowLinkedSourceRoot; this.openMachineCarrier = options.openMachineCarrierTunnel; this.openLocalAgent = options.openLocalWorkspaceAgentStream; this.readAtTarget = options.readFileAtTarget; this.observeEntryAtTarget = options.observeEntryAtTarget; this.stageConflictResolutionAtTarget = options.stageConflictResolutionAtTarget; this.applyStagedConflictResolutionAtTarget = options.applyStagedConflictResolutionAtTarget; this.discardStagedConflictResolutionAtTarget = options.discardStagedConflictResolutionAtTarget; this.releaseConflictResolutionCaptureAtSource = options.releaseConflictResolutionCaptureAtSource; this.recoverConflictResolutionAtTarget = options.recoverConflictResolutionAtTarget; this.resolveAllDefinitions = options.resolveAllRelationshipDefinitions ?? (async () => null); this.assertConflictResolutionAuthorized = options.assertConflictResolutionAuthorized; this.probeGit = options.probeGitRuntimeDependency ?? (async (signal) => await probeScmExecutableAvailable({ bin: 'git', ...(signal ? { signal } : {}) })); this.assertStateAvailable = options.assertLegacyStateAvailable ?? (() => undefined); this.observePersistentStatus = options.onStatusPublished !== undefined; this.onStatusPublished = options.onStatusPublished ?? (() => undefined); }

  private assertLocalSourcePlacement(ref: WorkspaceSyncResolvedRef | null): asserts ref is WorkspaceSyncResolvedRef {
    const serverMatches = this.localServerId === null || ref?.serverId?.trim() === this.localServerId;
    if (!ref || ref.machineId.trim() !== this.localMachineId.trim() || !serverMatches) {
      throw Object.assign(
        new Error('Workspace sync source machine is not enrolled in this Home'),
        { code: 'workspace_machine_not_enrolled' },
      );
    }
  }

  private async resolveLocalSourceAccess(
    definition: WorkspaceSyncRelationshipV1,
    endpointRole: 'alpha' | 'beta',
  ): Promise<Readonly<{ canonicalRoot: string; assertCurrentAuthority(): Promise<void> }> | null> {
    const [alpha, beta] = await Promise.all([
      this.resolveRef(definition.alphaWorkspaceRefId),
      this.resolveRef(definition.betaWorkspaceRefId),
    ]);
    if (!alpha || !beta) return null;
    const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: definition.mode,
      controllerMachineId: definition.controllerMachineId,
      alphaMachineId: alpha.machineId,
      betaMachineId: beta.machineId,
    });
    if (roles?.sourceEndpointRole !== endpointRole) return null;
    const source = endpointRole === 'alpha' ? alpha : beta;
    if (source.machineId.trim() !== this.localMachineId.trim()) return null;
    this.assertLocalSourcePlacement(source);
    const canonicalRoot = await realpath(source.rootPath).catch(() => source.rootPath);
    const custody = this.fences.get(definition.relationshipId);
    const sourceHandle = custody?.handles.find((handle) => (
      getPathRemainderWithinBase(handle.owner.canonicalRoot, canonicalRoot) === ''
      && getPathRemainderWithinBase(canonicalRoot, handle.owner.canonicalRoot) === ''
    ));
    if (!custody || !sourceHandle) {
      throw Object.assign(new Error('Workspace sync source root is not retained by the relationship'), {
        code: 'workspace_root_ownership_lost',
      });
    }
    return {
      canonicalRoot: sourceHandle.owner.canonicalRoot,
      assertCurrentAuthority: async () => {
        if (this.definitions.get(definition.relationshipId) !== definition
          || this.fences.get(definition.relationshipId) !== custody
          || this.ownershipLost.has(definition.relationshipId)) {
          throw Object.assign(new Error('Workspace root ownership was lost'), { code: 'workspace_root_ownership_lost' });
        }
        await this.assertRelationshipOwnershipCurrent(definition.relationshipId, sourceHandle);
      },
    };
  }
  async resolveLocalResolutionEndpoint(
    relationshipId: string,
    workspaceRefId: string,
  ): Promise<Readonly<{ relationship: WorkspaceSyncRelationshipV1; canonicalRoot: string; assertCurrentAuthority(): Promise<void> }> | null> {
    const definition = this.definitions.get(relationshipId);
    if (!definition || (workspaceRefId !== definition.alphaWorkspaceRefId && workspaceRefId !== definition.betaWorkspaceRefId)) {
      return null;
    }
    const ref = await this.resolveRef(workspaceRefId);
    if (!ref || ref.machineId.trim() !== this.localMachineId.trim()) return null;
    this.assertLocalSourcePlacement(ref);
    const canonicalRoot = await realpath(ref.rootPath).catch(() => ref.rootPath);
    const custody = this.fences.get(relationshipId);
    const handle = custody?.handles.find((candidate) => (
      getPathRemainderWithinBase(candidate.owner.canonicalRoot, canonicalRoot) === ''
      && getPathRemainderWithinBase(canonicalRoot, candidate.owner.canonicalRoot) === ''
    ));
    if (!custody || !handle) {
      throw Object.assign(new Error('Workspace sync resolution root is not retained by the relationship'), { code: 'workspace_root_ownership_lost' });
    }
    return {
      relationship: definition,
      canonicalRoot: handle.owner.canonicalRoot,
      assertCurrentAuthority: async () => {
        if (this.definitions.get(relationshipId) !== definition
          || this.fences.get(relationshipId) !== custody
          || this.ownershipLost.has(relationshipId)) {
          throw Object.assign(new Error('Workspace root ownership was lost'), { code: 'workspace_root_ownership_lost' });
        }
        await this.assertRelationshipOwnershipCurrent(relationshipId, handle);
      },
    };
  }

  /**
   * `git_worktree` selection is owned by Git's persistent check-ignore oracle,
   * so Git is an explicit runtime dependency of that mode. A missing or
   * unusable Git fails closed here, before the relationship or copy operation
   * is accepted and before any target, root custody, or engine work starts.
   */
  private async assertContentSelectionRuntimeDependencies(contentPolicy: WorkspaceContentPolicyV1, signal?: AbortSignal): Promise<void> {
    if (contentPolicy.selection !== 'git_worktree') return;
    if (await this.probeGit(signal)) return;
    throw Object.assign(new Error('Git is unavailable for the git_worktree workspace sync selection'), { code: 'git_selection_unavailable' });
  }

  private enqueue<T>(id: string, signal: AbortSignal | undefined, action: () => Promise<T>, material = true): Promise<T> {
    abortIfRequested(signal);
    const prior = this.queues.get(id);
    const run = (): Promise<T> => { abortIfRequested(signal); return action(); };
    const next = prior ? prior.task.catch(() => {}).then(() => {
      queued.material = material;
      this.notifyActivity();
      return run();
    }) : run();
    const queued = { task: next, material: material || prior?.material === true };
    this.queues.set(id, queued);
    this.notifyActivity();
    const settled = (): void => {
      if (this.queues.get(id) === queued) this.queues.delete(id);
      this.notifyActivity();
    };
    void next.then(settled, settled);
    return next;
  }
  private enqueueAll<T>(ids: readonly string[], action: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    const acquire = (index: number): Promise<T> => index >= ordered.length
      ? action()
      : this.enqueue(ordered[index]!, undefined, async () => await acquire(index + 1));
    return acquire(0);
  }
  private async deriveRuntimeTopology(relationships: readonly WorkspaceSyncRelationshipV1[]) {
    const refIds = [...new Set(relationships.flatMap((candidate) => [
      candidate.alphaWorkspaceRefId,
      candidate.betaWorkspaceRefId,
    ]))];
    const resolved = await Promise.all(refIds.map(async (id) => [id, await this.resolveRef(id)] as const));
    const workspaceRefs = resolved.flatMap(([id, ref]) => ref ? [{
      id,
      serverId: ref.serverId ?? this.localServerId ?? 'current-home',
      machineId: ref.machineId,
      rootPath: ref.rootPath,
      createdAtMs: 0,
    }] : []);
    return deriveWorkspaceSyncTopology({ workspaceRefs, relationships, serverId: this.localServerId ?? undefined });
  }
  private async assertRuntimeTopologyAdmission(definition: WorkspaceSyncRelationshipV1): Promise<void> {
    const savedDefinitions = await this.resolveAllDefinitions();
    const definitions = new Map((savedDefinitions ?? []).map((candidate) => [candidate.relationshipId, candidate] as const));
    for (const [id, active] of this.definitions) definitions.set(id, active);
    definitions.set(definition.relationshipId, definition);
    const topology = await this.deriveRuntimeTopology([...definitions.values()]);
    const issues = topology.issues.filter((issue) => issue.relationshipIds.includes(definition.relationshipId));
    if (issues.length > 0) {
      throw Object.assign(new Error('Workspace sync topology is unsupported'), {
        code: 'workspace_sync_topology_invalid',
        issues,
      });
    }
  }
  private publish(status: WorkspaceSyncStatusV1): WorkspaceSyncStatusV1 {
    this.statuses.set(status.relationshipId, status);
    this.notifyActivity();
    for (const listener of this.listeners.get(status.relationshipId) ?? []) listener(status);
    this.onStatusPublished(status);
    this.reconcileStatusObservation(status.relationshipId);
    return status;
  }

  private shouldObserveStatus(id: string): boolean {
    if (this.shuttingDown) return false;
    if ((this.listeners.get(id)?.size ?? 0) > 0) return true;
    const definition = this.definitions.get(id);
    return this.observePersistentStatus
      && definition?.enabled === true
      && !this.transientDefinitions.has(id);
  }

  private reconcileStatusObservation(id: string): void {
    const current = this.statusObservations.get(id);
    if (!this.shouldObserveStatus(id)) {
      current?.abort.abort();
      return;
    }
    if (current) return;
    const abort = new AbortController();
    const observation = {
      abort,
      task: this.observeStatus(id, abort.signal),
    };
    this.statusObservations.set(id, observation);
    void observation.task.finally(() => {
      if (this.statusObservations.get(id) !== observation) return;
      this.statusObservations.delete(id);
      this.reconcileStatusObservation(id);
    }).catch(() => undefined);
  }

  private async observeStatus(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.shouldObserveStatus(id)) {
      try {
        const observed = await this.enqueue(id, signal, async () => {
          if (!this.shouldObserveStatus(id)) return null;
          await this.lifecycle.start();
          return await this.adapter.get(id, signal);
        }, false);
        if (observed && !signal.aborted && this.shouldObserveStatus(id)) {
          const previous = this.statuses.get(id);
          if (!previous || !areWorkspaceSyncStatusesEqual(previous, observed)) this.publish(observed);
        }
      } catch (error) {
        if (signal.aborted || this.shuttingDown || (error instanceof Error && error.name === 'AbortError')) return;
        // Runtime readiness owns engine availability errors. Preserve the
        // last known relationship projection and retry while demand remains.
      }
      if (!signal.aborted && this.shouldObserveStatus(id)) await waitForStatusObservation(signal);
    }
  }

  private async stopAllStatusObservations(): Promise<void> {
    const observations = [...this.statusObservations.values()];
    for (const observation of observations) observation.abort.abort();
    await Promise.all(observations.map(async ({ task }) => await task));
  }
  private async acquireRoots(
    definition: WorkspaceSyncRelationshipV1,
    carriedHandles: readonly WorkspaceRootOwnershipHandle[] = [],
    roles: readonly ('alpha' | 'beta')[] = ['alpha', 'beta'],
    copyOperationId?: string,
  ): Promise<WorkspaceRootOwnershipHandle[]> {
    const candidates: { role: 'alpha' | 'beta'; canonicalRoot: string }[] = [];
    for (const role of roles) {
      const id = role === 'alpha' ? definition.alphaWorkspaceRefId : definition.betaWorkspaceRefId;
      const ref = await this.resolveRef(id, copyOperationId);
      if (!ref || ref.machineId !== this.localMachineId) continue;
      const canonicalRoot = await realpath(ref.rootPath).catch(() => ref.rootPath);
      if (carriedHandles.some((handle) => (
        getPathRemainderWithinBase(handle.owner.canonicalRoot, canonicalRoot) === ''
        && getPathRemainderWithinBase(canonicalRoot, handle.owner.canonicalRoot) === ''
      ))) continue;
      candidates.push({ role, canonicalRoot });
    }
    // Same-machine endpoints are fenced in one canonical order, so two
    // relationships naming the same pair in opposite roles still contend for
    // those roots in the same sequence.
    candidates.sort((left, right) => (
      left.canonicalRoot < right.canonicalRoot ? -1 : left.canonicalRoot > right.canonicalRoot ? 1 : 0
    ));
    const handles: WorkspaceRootOwnershipHandle[] = [];
    try {
      for (const { role, canonicalRoot } of candidates) {
        const result = await this.rootOwnershipManager.tryAcquire({ ownerId: definition.relationshipId, canonicalRoot, operation: 'sync' });
        if ('kind' in result) throw Object.assign(new Error('Workspace root is already in use'), { code: 'workspace_root_in_use', existing: result.existing, role });
        handles.push(result);
      }
      return handles;
    } catch (error) {
      await this.releaseRootHandles(handles);
      throw error;
    }
  }
  /**
   * Target preparation reads, packages and materializes the source workspace,
   * so the controller-local source root must already be fenced when it runs.
   * The handle is carried into the remaining acquisition instead of being taken
   * twice, because the root owner rejects an exact re-acquisition.
   */
  private async acquireSourceRoots(definition: WorkspaceSyncRelationshipV1): Promise<WorkspaceRootOwnershipHandle[]> {
    const [alpha, beta] = await Promise.all([
      this.resolveRef(definition.alphaWorkspaceRefId),
      this.resolveRef(definition.betaWorkspaceRefId),
    ]);
    if (!alpha || !beta) return [];
    const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: definition.mode,
      controllerMachineId: definition.controllerMachineId,
      alphaMachineId: alpha.machineId,
      betaMachineId: beta.machineId,
    });
    // An unresolvable direction is target preparation's typed error to raise.
    if (!roles) return [];
    const source = roles.sourceEndpointRole === 'alpha' ? alpha : beta;
    this.assertLocalSourcePlacement(source);
    const hubWorkspaceRefId = roles.sourceEndpointRole === 'alpha'
      ? definition.alphaWorkspaceRefId
      : definition.betaWorkspaceRefId;
    const canonicalRoot = await realpath(source.rootPath).catch(() => source.rootPath);
    const key = JSON.stringify([definition.controllerMachineId.trim(), hubWorkspaceRefId]);
    let participation = this.sharedHubParticipations.get(key);
    if (participation && participation.canonicalRoot !== canonicalRoot) {
      throw Object.assign(new Error('Workspace sync hub root changed after admission'), {
        code: 'workspace_root_ownership_lost',
      });
    }
    if (!participation) {
      const acquisition = this.rootOwnershipManager.tryAcquire({
        ownerId: hubWorkspaceRefId,
        canonicalRoot,
        operation: 'sync',
      }).then((result) => {
        if ('kind' in result) {
          throw Object.assign(new Error('Workspace root is already in use'), {
            code: 'workspace_root_in_use',
            existing: result.existing,
            role: roles.sourceEndpointRole,
          });
        }
        return result;
      });
      participation = {
        key,
        hubWorkspaceRefId,
        controllerMachineId: definition.controllerMachineId.trim(),
        canonicalRoot,
        acquisition,
        members: new Set(),
      };
      this.sharedHubParticipations.set(key, participation);
    }
    participation.members.add(definition.relationshipId);
    const participantKeys = this.participantHubKeys.get(definition.relationshipId) ?? new Set<string>();
    participantKeys.add(key);
    this.participantHubKeys.set(definition.relationshipId, participantKeys);
    let acquired = false;
    try {
      const handle = await participation.acquisition;
      acquired = true;
      if (handle.owner.canonicalRoot !== canonicalRoot) {
        throw Object.assign(new Error('Workspace sync hub physical root does not match its retained custody'), {
          code: 'workspace_root_ownership_lost',
        });
      }
      await handle.bindCurrentRootIdentity();
      return [handle];
    } catch (error) {
      if (acquired) {
        try {
          await this.releaseSharedHubParticipation(definition.relationshipId);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Workspace sync hub admission and custody cleanup failed');
        }
      } else {
        participation.members.delete(definition.relationshipId);
        participantKeys.delete(key);
        if (participantKeys.size === 0) this.participantHubKeys.delete(definition.relationshipId);
        if (participation.members.size === 0 && this.sharedHubParticipations.get(key) === participation) {
          this.sharedHubParticipations.delete(key);
        }
      }
      throw error;
    }
  }

  private async borrowSharedHubSource(
    participantId: string,
    hubWorkspaceRefId: string,
  ): Promise<WorkspaceRootOwnershipHandle[]> {
    const key = JSON.stringify([this.localMachineId.trim(), hubWorkspaceRefId]);
    const participation = this.sharedHubParticipations.get(key);
    if (!participation) return [];
    const ref = await this.resolveRef(hubWorkspaceRefId);
    this.assertLocalSourcePlacement(ref);
    const canonicalRoot = await realpath(ref.rootPath).catch(() => ref.rootPath);
    if (participation.canonicalRoot !== canonicalRoot) {
      throw Object.assign(new Error('Workspace sync hub root changed after admission'), {
        code: 'workspace_root_ownership_lost',
      });
    }
    participation.members.add(participantId);
    const participantKeys = this.participantHubKeys.get(participantId) ?? new Set<string>();
    participantKeys.add(key);
    this.participantHubKeys.set(participantId, participantKeys);
    try {
      const handle = await participation.acquisition;
      await handle.bindCurrentRootIdentity();
      return [handle];
    } catch (error) {
      participation.members.delete(participantId);
      participantKeys.delete(key);
      if (participantKeys.size === 0) this.participantHubKeys.delete(participantId);
      throw error;
    }
  }

  async borrowSourceRootForCopy(operationId: string, workspaceRefId: string): Promise<WorkspaceSyncSourceRootLoan | null> {
    this.assertStateAvailable();
    const shared = await this.borrowSharedHubSource(operationId, workspaceRefId);
    if (shared.length > 0) {
      return { handle: shared[0]!, release: async () => await this.releaseSharedHubParticipation(operationId) };
    }
    return await this.borrowLinkedSourceRoot?.(operationId, workspaceRefId) ?? null;
  }

  private async releaseSharedHubParticipation(participantId: string): Promise<void> {
    const keys = this.participantHubKeys.get(participantId);
    if (!keys) return;
    const failures: unknown[] = [];
    for (const key of [...keys]) {
      const participation = this.sharedHubParticipations.get(key);
      if (!participation) {
        keys.delete(key);
        continue;
      }
      participation.members.delete(participantId);
      if (participation.members.size > 0) {
        keys.delete(key);
        continue;
      }
      try {
        const handle = await participation.acquisition;
        await handle.release();
        if (this.sharedHubParticipations.get(key) === participation) {
          this.sharedHubParticipations.delete(key);
        }
        keys.delete(key);
      } catch (error) {
        // Retain the participant and map entry so a later lifecycle cleanup can
        // retry the same physical custody instead of forgetting a failed release.
        participation.members.add(participantId);
        failures.push(error);
      }
    }
    if (keys.size === 0) this.participantHubKeys.delete(participantId);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Workspace sync hub custody cleanup failed');
  }
  private async releaseRootHandles(handles: readonly WorkspaceRootOwnershipHandle[]): Promise<void> {
    const uniqueHandles = [...new Set(handles)];
    for (const handle of uniqueHandles) this.pendingRootReleases.add(handle);
    if (uniqueHandles.length > 0) this.notifyActivity();
    const results = await Promise.allSettled(uniqueHandles.map(async (handle) => {
      await handle.release();
      this.pendingRootReleases.delete(handle);
      this.notifyActivity();
    }));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Workspace root custody cleanup failed');
  }
  private async assertRelationshipOwnershipCurrent(
    id: string,
    finalHandle?: WorkspaceRootOwnershipHandle,
  ): Promise<void> {
    const custody = this.fences.get(id);
    const handles = custody?.handles ?? [];
    const retainedFinalHandle = finalHandle && handles.includes(finalHandle) ? finalHandle : undefined;
    for (const handle of [
      ...handles.filter((candidate) => candidate !== retainedFinalHandle),
      ...(retainedFinalHandle ? [retainedFinalHandle] : []),
    ]) {
      try {
        await handle.bindCurrentRootIdentity();
      } catch {
        const sharedHub = [...this.sharedHubParticipations.values()].find((participation) => (
          handle.owner.ownerId === participation.hubWorkspaceRefId
          && handle.owner.canonicalRoot === participation.canonicalRoot
        ));
        const affectedIds = sharedHub
          ? [...sharedHub.members].filter((memberId) => this.definitions.has(memberId))
          : [id];
        for (const affectedId of affectedIds) this.ownershipLost.add(affectedId);
        // All sessions sharing the lost physical object must stop before the
        // final participant releases its one fence. A surviving link must not
        // continue to reconcile against a replacement at the same path.
        for (const affectedId of affectedIds) {
          await this.closeActiveIngress(affectedId).catch(() => undefined);
          try {
            const paused = await this.adapter.pause(affectedId);
            this.publish({ ...paused, state: 'paused', errorCode: 'workspace_root_ownership_lost' });
          } catch {
            const previous = this.statuses.get(affectedId);
            if (previous) this.publish({ ...previous, state: 'error', errorCode: 'workspace_root_ownership_lost' });
          }
        }
        for (const affectedId of affectedIds) {
          const retained = this.fences.get(affectedId);
          if (retained) await this.releaseRelationshipOwnership(affectedId).catch(() => undefined);
        }
        throw Object.assign(new Error('Workspace root ownership was lost'), { code: 'workspace_root_ownership_lost' });
      }
    }
  }
  private async releaseRelationshipOwnership(id: string): Promise<void> {
    const custody = this.fences.get(id);
    await this.releaseRootHandles(custody?.ownedHandles ?? []);
    let expectedCustody = custody;
    if (custody && custody.ownedHandles.length > 0 && this.fences.get(id) === custody) {
      expectedCustody = { handles: custody.handles, ownedHandles: [] };
      this.fences.set(id, expectedCustody);
    }
    await this.releaseSharedHubParticipation(id);
    if (this.fences.get(id) === expectedCustody) this.fences.delete(id);
  }
  private async closeActiveIngress(id: string): Promise<void> {
    const entries = [...this.activeIngress.get(id) ?? []];
    for (const entry of entries) entry.stream.destroy();
    const results = await Promise.allSettled(entries.map(async (entry) => {
      await this.settleOwnedIngress(id, entry);
    }));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Workspace sync ingress cleanup failed');
  }
  private trackOwnedIngress(
    id: string,
    owned: WorkspaceSyncOwnedLocalAgent,
  ): Duplex {
    const entries = this.activeIngress.get(id) ?? new Set();
    const entry: ActiveWorkspaceSyncIngress = {
      stream: owned.stream,
      stop: owned.stop,
      cleanupAttempt: null,
    };
    entries.add(entry);
    this.activeIngress.set(id, entries);
    this.notifyActivity();
    owned.stream.once('close', () => {
      const cleanup = this.settleOwnedIngress(id, entry);
      void cleanup.then(undefined, (error: unknown) => {
        // The controller remains the owner after event-driven cleanup fails.
        // A concurrent terminate observes this same rejection, while a later
        // terminate/shutdown retries the retained entry.
        entry.cleanupFailure = error;
      });
    });
    return owned.stream;
  }
  private async settleOwnedIngress(
    id: string,
    entry: ActiveWorkspaceSyncIngress,
  ): Promise<void> {
    if (entry.cleanupAttempt) return await entry.cleanupAttempt;
    const attempt = entry.stop().then(() => {
      const entries = this.activeIngress.get(id);
      entries?.delete(entry);
      if (entries?.size === 0) this.activeIngress.delete(id);
      this.notifyActivity();
    });
    entry.cleanupAttempt = attempt;
    try {
      await attempt;
    } catch (error) {
      if (entry.cleanupAttempt === attempt) entry.cleanupAttempt = null;
      throw error;
    }
  }
  private async releaseCopyOperation(id: string): Promise<void> {
    const handles = this.copyOwnedFences.get(id) ?? [];
    await this.releaseRootHandles(handles);
    const releaseSource = this.copySourceReleases.get(id);
    if (releaseSource) {
      await releaseSource();
      this.copySourceReleases.delete(id);
    }
    this.copyOwnedFences.delete(id);
    this.copyFences.delete(id);
    this.copyOperations.delete(id);
    this.notifyActivity();
  }
  private async settleRecoveredCopyOperation(id: string, reason: 'abort' | 'commit'): Promise<void> {
    const releaseTarget = this.copyTargetReleases.get(id);
    if (releaseTarget) {
      await releaseTarget(reason);
      this.copyTargetReleases.delete(id);
    }
    await this.releaseCopyOperation(id);
  }
  private async recoverCopyOnce(operation: WorkspaceSyncCopyOnceV1): Promise<WorkspaceSyncStatusV1 | null> {
    const valid = WorkspaceSyncCopyOnceV1Schema.parse(operation);
    if (this.copyTerminalPending.has(valid.operationId)) {
      try {
        await this.settleRecoveredCopyOperation(valid.operationId, 'commit');
        this.copyTerminalPending.delete(valid.operationId);
        return null;
      } catch (cleanupError) {
        throw Object.assign(new Error('Workspace copy completed but terminal recovery cleanup is pending'), {
          code: 'indeterminate', cleanupError,
        });
      }
    }
    await this.assertContentSelectionRuntimeDependencies(valid.contentPolicy);
    const [alpha, beta] = await Promise.all([
      this.resolveRef(valid.alphaWorkspaceRefId, valid.operationId),
      this.resolveRef(valid.betaWorkspaceRefId, valid.operationId),
    ]);
    if (valid.controllerMachineId !== this.localMachineId || !alpha || !beta
      || alpha.machineId !== this.localMachineId) {
      await this.adapter.terminate(valid.operationId);
      return null;
    }
    const retained = this.copyOperations.get(valid.operationId);
    if (retained && !areCopyOnceDefinitionsEqual(retained, valid)) {
      await this.adapter.terminate(valid.operationId);
      return null;
    }
    if (!retained) {
      const sourceLoan = await this.borrowSourceRootForCopy(valid.operationId, valid.alphaWorkspaceRefId);
      const borrowed = sourceLoan ? [sourceLoan.handle] : [];
      if (sourceLoan) this.copySourceReleases.set(valid.operationId, sourceLoan.release);
      let acquired: WorkspaceRootOwnershipHandle[];
      try {
        acquired = await this.acquireRoots({
        v: 1, relationshipId: valid.operationId, controllerMachineId: valid.controllerMachineId,
        alphaWorkspaceRefId: valid.alphaWorkspaceRefId, betaWorkspaceRefId: valid.betaWorkspaceRefId,
        mode: 'keep_synced', contentPolicy: valid.contentPolicy, enabled: true, createdAtMs: 0, updatedAtMs: 0,
        }, borrowed, ['alpha', 'beta'], valid.operationId);
      } catch (error) {
        if (sourceLoan) {
          await sourceLoan.release();
          this.copySourceReleases.delete(valid.operationId);
        }
        throw error;
      }
      this.copyOperations.set(valid.operationId, valid);
      this.copyFences.set(valid.operationId, [...borrowed, ...acquired]);
      this.copyOwnedFences.set(valid.operationId, acquired);
      try {
        if (beta.machineId !== this.localMachineId) {
          if (!this.recoverCopyTarget) throw Object.assign(new Error('Workspace copy target recovery is unavailable'), { code: 'peer_unavailable' });
          const target = await this.recoverCopyTarget(valid);
          this.copyTargetReleases.set(valid.operationId, target.release);
        }
      } catch (error) {
        try {
          await this.adapter.terminate(valid.operationId);
          await this.settleRecoveredCopyOperation(valid.operationId, 'abort');
        } catch (cleanupError) {
          throw Object.assign(new Error('Workspace copy recovery cleanup is pending'), { code: 'indeterminate', cause: error, cleanupError });
        }
        return null;
      }
    }
    try {
      await Promise.all((this.copyFences.get(valid.operationId) ?? []).map((handle) => handle.bindCurrentRootIdentity()));
      const result = assertWorkspaceSyncStatusClean(this.publish(await this.adapter.copyOnce(valid)));
      this.copyTerminalPending.add(valid.operationId);
      try {
        await this.settleRecoveredCopyOperation(valid.operationId, 'commit');
        this.copyTerminalPending.delete(valid.operationId);
      } catch (cleanupError) {
        throw Object.assign(new Error('Workspace copy completed but terminal recovery cleanup is pending'), {
          code: 'indeterminate', cleanupError,
        });
      }
      return result;
    } catch (error) {
      if (!isIndeterminate(error)) {
        try {
          await this.settleRecoveredCopyOperation(valid.operationId, 'abort');
        } catch (cleanupError) {
          throw Object.assign(new Error('Workspace copy failed but terminal recovery cleanup is pending'), {
            code: 'indeterminate', cause: error, cleanupError,
          });
        }
      }
      throw error;
    }
  }
  private async ensureWithinQueue(
    valid: WorkspaceSyncRelationshipV1,
    signal?: AbortSignal,
    preparation?: WorkspaceSyncRelationshipPreparation,
  ): Promise<WorkspaceSyncStatusV1> {
    if (valid.controllerMachineId !== this.localMachineId) {
      throw Object.assign(new Error('Workspace sync controller machine is unavailable'), { code: 'controller_unavailable' });
    }
    await this.assertRuntimeTopologyAdmission(valid);
    const previous = this.definitions.get(valid.relationshipId);
    const recoveringOwnership = previous !== undefined && this.ownershipLost.has(valid.relationshipId);
    const needsOwnership = !previous || recoveringOwnership || !this.fences.has(valid.relationshipId);
    if (previous && !areWorkspaceSyncRelationshipDefinitionsEqual(previous, valid)) {
      throw Object.assign(new Error('Workspace sync relationship definition conflicts with active relationship'), { code: 'relationship_definition_conflict' });
    }
    await this.assertContentSelectionRuntimeDependencies(valid.contentPolicy, signal);
    let acquiredHandles: WorkspaceRootOwnershipHandle[] | undefined;
    let sourceHandles: WorkspaceRootOwnershipHandle[] = [];
    try {
      if (needsOwnership) {
        sourceHandles = await this.acquireSourceRoots(valid);
      }
      const targetPreparation = await this.withSourceSeedAuthorization(valid, sourceHandles, async () => (
        await this.prepareTarget(valid, signal, preparation)
      ));
      const carriedHandles = [...sourceHandles, ...(targetPreparation?.ownershipHandles ?? [])];
      if (needsOwnership) {
        acquiredHandles = await this.acquireRoots(valid, carriedHandles);
        this.fences.set(valid.relationshipId, {
          handles: [...carriedHandles, ...acquiredHandles],
          ownedHandles: [...acquiredHandles],
        });
      }
      if (!previous) this.definitions.set(valid.relationshipId, valid);
      await this.assertRelationshipOwnershipCurrent(valid.relationshipId);
      await this.recoverConflictResolutionForRelationship(valid, signal);
      await this.lifecycle.start();
      const runtimeDefinition = !valid.enabled && preparation?.transient ? { ...valid, enabled: true } : valid;
      const status = await this.adapter.ensure(runtimeDefinition, signal);
      // A cold staged row may already occupy definitions. After successful
      // transient engine admission, retain its live definition, not that
      // disabled restart intent, for the existing reconciliation owner.
      this.definitions.set(valid.relationshipId, runtimeDefinition);
      if (preparation?.transient) this.transientDefinitions.add(valid.relationshipId);
      else this.transientDefinitions.delete(valid.relationshipId);
      this.ownershipLost.delete(valid.relationshipId);
      return this.publish(status);
    } catch (error) {
      if (needsOwnership) {
        if (!previous) this.definitions.delete(valid.relationshipId);
        if (!previous) this.transientDefinitions.delete(valid.relationshipId);
        await this.releaseRootHandles(acquiredHandles ?? []);
        await this.releaseSharedHubParticipation(valid.relationshipId);
        this.fences.delete(valid.relationshipId);
      }
      throw error;
    }
  }
  private async recoverConflictResolutionForRelationship(
    definition: WorkspaceSyncRelationshipV1,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.recoverConflictResolutionAtTarget) return;
    for (const workspaceRefId of [definition.alphaWorkspaceRefId, definition.betaWorkspaceRefId]) {
      const ref = await this.resolveRef(workspaceRefId);
      if (!ref) throw Object.assign(new Error('Workspace conflict recovery endpoint is unavailable'), { code: 'peer_unavailable' });
      const result = await this.recoverConflictResolutionAtTarget({
        relationshipId: definition.relationshipId,
        targetMachineId: ref.machineId,
        targetWorkspaceRefId: workspaceRefId,
        ...(signal ? { signal } : {}),
      });
      if (result.status === 'recovery_needed') {
        throw Object.assign(new Error('Workspace conflict recovery must settle before synchronization resumes'), {
          code: 'workspace_sync_recovery_needed', recoveryPath: result.recoveryPath,
        });
      }
    }
  }
  async get(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1 | null> { this.assertStateAvailable(); abortIfRequested(signal); await this.lifecycle.start(); return await this.adapter.get(id, signal); }
  async list(signal?: AbortSignal): Promise<readonly WorkspaceSyncStatusV1[]> { this.assertStateAvailable(); abortIfRequested(signal); await this.lifecycle.start(); return await this.adapter.list(signal); }
  async ensure(definition: WorkspaceSyncRelationshipV1, signal?: AbortSignal, preparation?: WorkspaceSyncRelationshipPreparation): Promise<WorkspaceSyncStatusV1> {
    this.assertStateAvailable();
    const valid = validateWorkspaceSyncRelationship(definition);
    return this.enqueueAll([
      valid.relationshipId,
      `workspace-ref:${valid.alphaWorkspaceRefId}`,
      `workspace-ref:${valid.betaWorkspaceRefId}`,
    ], async () => {
      abortIfRequested(signal);
      return await this.ensureWithinQueue(valid, signal, preparation);
    });
  }
  async copyOnce(input: WorkspaceSyncCopyOnceV1, signal?: AbortSignal, ownershipHandles?: readonly WorkspaceRootOwnershipHandle[]): Promise<WorkspaceSyncStatusV1> {
    this.assertStateAvailable();
    const valid = WorkspaceSyncCopyOnceV1Schema.parse(input);
    return this.enqueue(valid.operationId, signal, async () => {
      if (valid.controllerMachineId !== this.localMachineId) {
        throw Object.assign(new Error('Workspace sync controller machine is unavailable'), { code: 'controller_unavailable' });
      }
      const retained = this.copyOperations.get(valid.operationId);
      if (retained && !areCopyOnceDefinitionsEqual(retained, valid)) {
        throw Object.assign(new Error('Workspace copy operation definition conflicts with active operation'), { code: 'relationship_definition_conflict' });
      }
      await this.assertContentSelectionRuntimeDependencies(valid.contentPolicy, signal);
      const source = await this.resolveRef(valid.alphaWorkspaceRefId, valid.operationId);
      this.assertLocalSourcePlacement(source);
      const sourceLoan = retained || ownershipHandles?.length
        ? null
        : await this.borrowSourceRootForCopy(valid.operationId, valid.alphaWorkspaceRefId);
      const borrowedHubHandles = sourceLoan ? [sourceLoan.handle] : [];
      if (sourceLoan) this.copySourceReleases.set(valid.operationId, sourceLoan.release);
      const carriedOwnershipHandles = [...(ownershipHandles ?? []), ...borrowedHubHandles];
      let acquiredHandles: WorkspaceRootOwnershipHandle[];
      try {
        acquiredHandles = retained ? [] : await this.acquireRoots({
            v: 1, relationshipId: valid.operationId, controllerMachineId: valid.controllerMachineId,
            alphaWorkspaceRefId: valid.alphaWorkspaceRefId, betaWorkspaceRefId: valid.betaWorkspaceRefId,
            mode: 'keep_synced', contentPolicy: valid.contentPolicy, enabled: true, createdAtMs: 0, updatedAtMs: 0,
          }, carriedOwnershipHandles, ['alpha', 'beta'], valid.operationId);
      } catch (error) {
        try {
          if (sourceLoan) {
            await sourceLoan.release();
            this.copySourceReleases.delete(valid.operationId);
          }
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Workspace copy admission and hub custody cleanup failed');
        }
        throw error;
      }
      const handles = retained
        ? this.copyFences.get(valid.operationId) ?? []
        : [...carriedOwnershipHandles, ...acquiredHandles];
      if (!retained) {
        this.copyOperations.set(valid.operationId, valid);
        this.copyFences.set(valid.operationId, handles);
        this.copyOwnedFences.set(valid.operationId, acquiredHandles);
      }
      try {
        await this.lifecycle.start();
        try {
          await Promise.all(handles.map((handle) => handle.bindCurrentRootIdentity()));
        } catch {
          await this.closeActiveIngress(valid.operationId);
          if (retained) {
            try {
              await this.adapter.terminate(valid.operationId, signal);
            } catch (cleanupError) {
              throw Object.assign(new Error('Workspace copy ownership was lost and terminal cleanup is pending'), {
                code: 'indeterminate', cleanupError,
              });
            }
          }
          await this.releaseCopyOperation(valid.operationId);
          throw Object.assign(new Error('Workspace root ownership was lost'), { code: 'workspace_root_ownership_lost' });
        }
        const result = assertWorkspaceSyncStatusClean(this.publish(await this.adapter.copyOnce(valid, signal)));
        await this.releaseCopyOperation(valid.operationId);
        return result;
      } catch (error) {
        if (!isIndeterminate(error)) await this.releaseCopyOperation(valid.operationId);
        throw error;
      }
    });
  }
  async flush(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(id, signal, async () => {
    this.assertStateAvailable();
    if (this.ownershipLost.has(id)) throw Object.assign(new Error('Workspace root ownership was lost'), { code: 'workspace_root_ownership_lost' });
    if (!this.definitions.has(id)) {
      const definition = await this.resolveDefinition(id);
      if (!definition) throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
      await this.ensureWithinQueue(validateWorkspaceSyncRelationship(definition), signal);
    }
    const definition = this.definitions.get(id);
    if (definition) await this.recoverConflictResolutionForRelationship(definition, signal);
    await this.lifecycle.start();
    await this.assertRelationshipOwnershipCurrent(id);
    return this.publish(await this.adapter.flush(id, signal));
  }); }
  async pause(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(id, signal, async () => { this.assertStateAvailable(); await this.lifecycle.start(); return this.publish(await this.adapter.pause(id, signal)); }); }
  async resume(id: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1> { return this.enqueue(id, signal, async () => {
    this.assertStateAvailable();
    if (this.ownershipLost.has(id)) {
      const definition = this.definitions.get(id) ?? await this.resolveDefinition(id);
      if (!definition) throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
      return await this.ensureWithinQueue(validateWorkspaceSyncRelationship(definition), signal);
    }
    const definition = this.definitions.get(id);
    if (definition) await this.recoverConflictResolutionForRelationship(definition, signal);
    await this.lifecycle.start();
    await this.assertRelationshipOwnershipCurrent(id);
    return this.publish(await this.adapter.resume(id, signal));
  }); }
  async terminate(id: string, signal?: AbortSignal): Promise<void> { return this.enqueue(id, signal, async () => {
    this.assertStateAvailable();
    await this.lifecycle.start();
    const previousStatus = this.statuses.get(id) ?? await this.adapter.get(id, signal);
    await this.adapter.terminate(id, signal);
    await this.closeActiveIngress(id);
    if (this.copyOperations.has(id)) {
      if (this.copyTargetReleases.has(id)) await this.settleRecoveredCopyOperation(id, 'abort');
      else await this.releaseCopyOperation(id);
      this.copyTerminalPending.delete(id);
    } else {
      await this.releaseRelationshipOwnership(id);
      this.ownershipLost.delete(id);
      this.definitions.delete(id);
      this.transientDefinitions.delete(id);
      this.statuses.delete(id);
    }
    if (previousStatus) this.publish({ ...previousStatus, state: 'stopped' });
  }); }
  async listConflicts(request: WorkspaceSyncConflictPageRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictPageV1> { this.assertStateAvailable(); abortIfRequested(signal); await this.lifecycle.start(); return await this.adapter.listConflicts(request, signal); }
  async listRelationships(request: WorkspaceSyncRelationshipsListRpcRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncRelationshipsListRpcResultV1> {
    this.assertStateAvailable();
    abortIfRequested(signal);
    const valid = WorkspaceSyncRelationshipsListRpcRequestV1Schema.parse(request);
    await this.lifecycle.start();
    // Membership and authority rederive from the current definitions on every
    // call; a stale caller filter yields found:false, never another scope.
    const local = [...this.definitions.values()];
    const statuses = await this.adapter.list(signal);
    const statusById = new Map(statuses.map((status) => [status.relationshipId, status] as const));
    const topology = await this.deriveRuntimeTopology(local);
    const matchingSets = valid.workspaceRefId === undefined
      ? [...topology.sets]
      : topology.sets.filter((set) => set.relationships.some((relationship) => relationshipContainsRef(relationship, valid.workspaceRefId!)));
    const matchingIds = new Set(matchingSets.flatMap((set) => set.relationships.map((relationship) => relationship.relationshipId)));
    const inScope = (definition: WorkspaceSyncRelationshipV1): boolean => valid.workspaceRefId === undefined
      || matchingIds.has(definition.relationshipId);
    const relationships = local
      .filter(inScope)
      .map((definition) => ({
        definition,
        status: statusById.get(definition.relationshipId) ?? null,
      }));
    const all = await this.resolveAllDefinitions();
    const remoteRelationships = valid.workspaceRefId === undefined || all === null
      ? []
      : all
        .filter((definition) => definition.controllerMachineId !== this.localMachineId
          && relationshipContainsRef(definition, valid.workspaceRefId!)
          && !matchingIds.has(definition.relationshipId))
        .map((definition) => ({ definition, controllerMachineId: definition.controllerMachineId }));
    return WorkspaceSyncRelationshipsListRpcResultV1Schema.parse({
      controllerMachineId: this.localMachineId,
      sets: matchingSets.map((set) => ({
        hubWorkspaceRefId: set.hubWorkspaceRefId,
        controllerMachineId: set.controllerMachineId,
        relationshipIds: set.relationships.map((relationship) => relationship.relationshipId),
      })),
      relationships,
      remoteRelationships,
      membership: valid.workspaceRefId === undefined
        ? { workspaceRefId: null, found: null }
        : { workspaceRefId: valid.workspaceRefId, found: relationships.length + remoteRelationships.length > 0 },
      discoveryAvailable: all !== null,
    });
  }
  async inspectConflict(request: WorkspaceSyncConflictInspectRpcRequestV1, signal?: AbortSignal): Promise<WorkspaceSyncConflictInspectRpcResultV1> {
    this.assertStateAvailable();
    abortIfRequested(signal);
    const valid = WorkspaceSyncConflictInspectRpcRequestV1Schema.parse(request);
    await this.lifecycle.start();
    const local = [...this.definitions.values()];
    const containing = local.filter((definition) => relationshipContainsRef(definition, valid.workspaceRefId));
    if (containing.length === 0) {
      throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
    }
    const topology = await this.deriveRuntimeTopology(local);
    const set = topology.sets.find((candidate) => candidate.relationships.some(
      (relationship) => containing.some((owned) => owned.relationshipId === relationship.relationshipId),
    ));
    if (!set) {
      throw Object.assign(new Error('Workspace sync topology is unsupported'), { code: 'workspace_sync_topology_invalid' });
    }
    const endpointRefs = [...new Set(set.relationships.flatMap((relationship) => [
      relationship.alphaWorkspaceRefId,
      relationship.betaWorkspaceRefId,
    ]))];
    const memberships = new Map(endpointRefs.map((ref) => [ref, set.relationships.flatMap((relationship) => [
      ...(relationship.alphaWorkspaceRefId === ref
        ? [{ relationshipId: relationship.relationshipId, side: 'alpha' as const }] : []),
      ...(relationship.betaWorkspaceRefId === ref
        ? [{ relationshipId: relationship.relationshipId, side: 'beta' as const }] : []),
    ])] as const));
    // One content observation per distinct WorkspaceRef, including clean
    // links: a conflict page absence never proves an endpoint matches.
    const endpoints = await Promise.all(endpointRefs.map(async (ref) => await this.observeInspectEndpoint(
      ref,
      memberships.get(ref) ?? [],
      set.relationships,
      valid.path,
      signal,
    )));
    const grouped = new Map<WorkspaceSyncEntryExpectationV1, string[]>();
    for (const endpoint of endpoints) {
      if (endpoint.outcome !== 'observed' || !endpoint.observation) continue;
      const existing = [...grouped.keys()].find((entry) => areWorkspaceSyncEntryExpectationsEqual(entry, endpoint.observation!));
      if (existing) grouped.get(existing)!.push(endpoint.workspaceRefId);
      else grouped.set(endpoint.observation, [endpoint.workspaceRefId]);
    }
    const versions: { endpointWorkspaceRefIds: string[]; entry: WorkspaceSyncEntryExpectationV1; preview?: { workspaceRefId: string; preview: ReadWorkspaceSyncFileResultV1 } }[] =
      [...grouped.entries()].map(([entry, endpointWorkspaceRefIds]) => ({ endpointWorkspaceRefIds, entry }));
    if (valid.preview) {
      const selected = endpoints.find((endpoint) => endpoint.workspaceRefId === valid.preview!.workspaceRefId);
      if (!selected || selected.outcome !== 'observed' || !selected.observation) {
        throw Object.assign(new Error('Workspace sync preview selection is stale'), { code: 'conflict_changed' });
      }
      if (!areWorkspaceSyncEntryExpectationsEqual(selected.observation, valid.preview.expected)) {
        throw Object.assign(new Error('Workspace sync preview selection changed'), { code: 'conflict_changed' });
      }
      const version = versions.find((candidate) => candidate.endpointWorkspaceRefIds.includes(selected.workspaceRefId));
      if (!version) {
        throw Object.assign(new Error('Workspace sync preview selection is stale'), { code: 'conflict_changed' });
      }
      const membership = memberships.get(selected.workspaceRefId) ?? [];
      const primary = membership[0];
      if (!primary) {
        throw Object.assign(new Error('Workspace sync preview selection is stale'), { code: 'conflict_changed' });
      }
      // Only file versions have bounded text previews; every other entry
      // kind is already fully described by its canonical observation.
      const preview = await this.readInspectPreview(primary.relationshipId, primary.side, valid.path, selected.observation, signal);
      if (preview) version.preview = { workspaceRefId: selected.workspaceRefId, preview };
    }
    type PreservationOption = NonNullable<WorkspaceSyncConflictInspectRpcResultV1['preservationOptions']>[number];
    const preservationOptions: PreservationOption[] = [];
    const hubMembership = memberships.get(set.hubWorkspaceRefId) ?? [];
    for (const version of versions) {
      if (version.entry.kind !== 'file') continue;
      const source = { workspaceRefId: version.endpointWorkspaceRefIds[0]!, expected: version.entry };
      let paths: readonly [string, string];
      try {
        paths = deriveWorkspaceSyncConflictAsidePaths(valid.path, version.entry);
      } catch {
        preservationOptions.push({ status: 'unavailable', source, reason: 'path_unavailable' });
        continue;
      }
      for (const asidePath of paths) {
        const observed = await this.observeInspectEndpoint(
          set.hubWorkspaceRefId, hubMembership, set.relationships, asidePath, signal,
        );
        if (observed.outcome !== 'observed' || !observed.observation) {
          preservationOptions.push({ status: 'unavailable', source, reason: 'destination_unavailable' });
          break;
        }
        if (observed.observation.kind !== 'missing'
          && !areWorkspaceSyncEntryExpectationsEqual(observed.observation, version.entry)) {
          preservationOptions.push({
            status: 'name_conflict', source,
            proposed: { workspaceRefId: set.hubWorkspaceRefId, path: asidePath },
          });
          continue;
        }
        const propagatingToWorkspaceRefIds: string[] = [];
        const unverifiedPropagationToWorkspaceRefIds: string[] = [];
        for (const relationship of set.relationships) {
          const hubSide = relationship.alphaWorkspaceRefId === set.hubWorkspaceRefId ? 'alpha' : 'beta';
          const spokeSide = hubSide === 'alpha' ? 'beta' : 'alpha';
          const spokeRefId = hubSide === 'alpha'
            ? relationship.betaWorkspaceRefId : relationship.alphaWorkspaceRefId;
          const hubSelection = observed.selections.find((selection) => selection.relationshipId === relationship.relationshipId)?.decision;
          let spokeSelection: WorkspaceSyncPathSelectionV1;
          try {
            spokeSelection = await this.adapter.diagnoseSelection({
              relationshipId: relationship.relationshipId, side: spokeSide, path: asidePath,
            }, signal);
          } catch (error) {
            if (signal?.aborted || readErrorCode(error) === 'cancelled') throw error;
            spokeSelection = { status: 'unknown', reason: 'selection_unavailable' };
          }
          if (hubSelection?.status === 'excluded' || spokeSelection.status === 'excluded') continue;
          if (hubSelection?.status === 'included' && spokeSelection.status === 'included') {
            propagatingToWorkspaceRefIds.push(spokeRefId);
          } else {
            unverifiedPropagationToWorkspaceRefIds.push(spokeRefId);
          }
        }
        preservationOptions.push({
          status: 'available', source,
          destination: {
            workspaceRefId: set.hubWorkspaceRefId, path: asidePath, expected: observed.observation,
          },
          consequence: {
            propagatingToWorkspaceRefIds,
            ...(unverifiedPropagationToWorkspaceRefIds.length > 0 ? { unverifiedPropagationToWorkspaceRefIds } : {}),
          },
        });
        break;
      }
    }
    return WorkspaceSyncConflictInspectRpcResultV1Schema.parse({
      controllerMachineId: this.localMachineId,
      hubWorkspaceRefId: set.hubWorkspaceRefId,
      path: valid.path,
      endpoints,
      versions,
      preservationOptions,
      coverage: { complete: endpoints.every((endpoint) => endpoint.outcome === 'observed') },
    });
  }
  private async observeInspectEndpoint(
    workspaceRefId: string,
    membership: readonly (Readonly<{ relationshipId: string; side: 'alpha' | 'beta' }>)[],
    expectedDefinitions: readonly WorkspaceSyncRelationshipV1[],
    path: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncConflictInspectEndpointV1> {
    const selections = (reason: 'selection_unavailable' | 'endpoint_unavailable') => membership.map((entry) => ({
      ...entry,
      decision: { status: 'unknown' as const, reason },
    }));
    const failed = (outcome: Exclude<WorkspaceSyncConflictInspectEndpointV1['outcome'], 'observed'>): WorkspaceSyncConflictInspectEndpointV1 => ({
      workspaceRefId,
      outcome,
      selections: selections(outcome === 'unreachable' || outcome === 'revoked' ? 'endpoint_unavailable' : 'selection_unavailable'),
    });
    const primary = membership[0];
    if (!primary) return failed('unreachable');
    const definition = this.definitions.get(primary.relationshipId);
    if (!definition) return failed('unreachable');
    try {
      signal?.throwIfAborted();
      const target = await this.resolveRef(workspaceRefId);
      if (!target) return failed('unreachable');
      const localSource = await this.resolveLocalSourceAccess(definition, primary.side).catch((error: unknown) => {
        // A lapsed local fence falls through to the retained target-authority
        // path exactly like bounded file reads, never to a bare pathname.
        if (projectInspectEndpointOutcome(error) === 'unreachable') return null;
        throw error;
      });
      let observation: WorkspaceSyncEntryExpectationV1;
      if (localSource) {
        observation = await this.enqueue(definition.relationshipId, signal, async () => {
          const currentDefinition = this.definitions.get(definition.relationshipId);
          if (!currentDefinition) {
            throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
          }
          const currentLocalSource = await this.resolveLocalSourceAccess(currentDefinition, primary.side);
          if (!currentLocalSource) {
            throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
          }
          return await observeWorkspaceSyncEntryAtRoot({
            rootPath: currentLocalSource.canonicalRoot,
            relativePath: path,
            assertCurrentAuthority: currentLocalSource.assertCurrentAuthority,
          });
        }, false);
      } else {
        if (!this.observeEntryAtTarget) {
          throw Object.assign(new Error('Authenticated target entry observation is unavailable'), { code: 'agent_unavailable' });
        }
        observation = await this.observeEntryAtTarget({
          relationshipId: definition.relationshipId,
          targetMachineId: target.machineId,
          targetWorkspaceRefId: workspaceRefId,
          path,
          ...(signal ? { signal } : {}),
        });
      }
      const diagnosedSelections = await Promise.all(membership.map(async (entry) => {
        const currentDefinition = this.definitions.get(entry.relationshipId);
        const originalDefinition = expectedDefinitions.find((candidate) => candidate.relationshipId === entry.relationshipId);
        if (!currentDefinition || !originalDefinition || !areWorkspaceSyncRelationshipDefinitionsEqual(currentDefinition, originalDefinition)) {
          throw Object.assign(new Error('Workspace sync relationship changed during inspection'), { code: 'relationship_changed' });
        }
        let decision: WorkspaceSyncPathSelectionV1;
        try {
          decision = await this.adapter.diagnoseSelection({ ...entry, path }, signal);
        } catch (error) {
          if (signal?.aborted || readErrorCode(error) === 'cancelled') throw error;
          const code = readErrorCode(error);
          if (code === 'git_selection_unavailable') {
            decision = { status: 'unknown', reason: 'selection_unavailable' };
          } else if (code !== undefined && INSPECT_UNREACHABLE_CODES.has(code) && code !== 'engine_unavailable') {
            decision = { status: 'unknown', reason: 'endpoint_unavailable' };
          } else {
            throw error;
          }
        }
        return { ...entry, decision };
      }));
      return {
        workspaceRefId,
        outcome: 'observed',
        observation,
        selections: diagnosedSelections,
      };
    } catch (error) {
      if (signal?.aborted || readErrorCode(error) === 'cancelled') throw error;
      const outcome = projectInspectEndpointOutcome(error);
      if (!outcome) throw error;
      return failed(outcome);
    }
  }
  private async readInspectPreview(
    relationshipId: string,
    side: 'alpha' | 'beta',
    path: string,
    expected: WorkspaceSyncEntryExpectationV1,
    signal?: AbortSignal,
  ): Promise<ReadWorkspaceSyncFileResultV1 | undefined> {
    if (expected.kind !== 'file') return undefined;
    const preview = await this.readFile({
      relationshipId,
      side,
      path,
      expectedDigest: expected.digest,
      maxBytes: WORKSPACE_SYNC_FILE_PREVIEW_MAX_BYTES,
    }, signal);
    if (preview.status === 'changed' || preview.status === 'missing') {
      throw Object.assign(new Error('Workspace sync preview selection changed'), { code: 'conflict_changed' });
    }
    if (preview.digest !== expected.digest) {
      throw Object.assign(new Error('Workspace sync preview selection changed'), { code: 'conflict_changed' });
    }
    return preview;
  }
  async resolveConflict(
    request: WorkspaceSyncConflictResolutionV1,
    signal?: AbortSignal,
    actionReceiptId?: string,
  ): Promise<WorkspaceSyncConflictResolutionResultV1> {
    this.assertStateAvailable();
    const valid = WorkspaceSyncConflictResolutionV1Schema.parse(request);
    if (!actionReceiptId?.trim()) {
      throw Object.assign(new Error('Confirmed workspace conflict Action receipt is required'), { code: 'approval_required' });
    }
    if (valid.controllerMachineId !== this.localMachineId) {
      throw Object.assign(new Error('Workspace conflict controller changed'), { code: 'approval_stale' });
    }
    const actionInput: WorkspaceSyncConflictResolveActionInputV1 = valid;
    const stage = this.stageConflictResolutionAtTarget;
    const apply = this.applyStagedConflictResolutionAtTarget;
    if (!stage || !apply) {
      throw Object.assign(new Error('Reviewed workspace conflict transfer is unavailable'), { code: 'agent_unavailable' });
    }
    const currentSet = async () => {
      const saved = await this.resolveAllDefinitions();
      const definitions = new Map((saved ?? []).map((candidate) => [candidate.relationshipId, candidate] as const));
      for (const [id, definition] of this.definitions) definitions.set(id, definition);
      const topology = await this.deriveRuntimeTopology([...definitions.values()].filter((candidate) => candidate.enabled));
      return topology.sets.find((candidate) => candidate.hubWorkspaceRefId === valid.hubWorkspaceRefId
        && candidate.controllerMachineId === valid.controllerMachineId) ?? null;
    };
    const set = await currentSet();
    const requestedIds = [...new Set(valid.relationshipIds)].sort();
    const currentIds = set?.relationships.map((relationship) => relationship.relationshipId).sort() ?? [];
    if (!set || JSON.stringify(requestedIds) !== JSON.stringify(currentIds)
      || requestedIds.length !== valid.relationshipIds.length) {
      throw Object.assign(new Error('Reviewed workspace conflict linked set changed'), { code: 'approval_stale' });
    }
    const endpointIds = new Set(set.relationships.flatMap((relationship) => [
      relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId,
    ]));
    const sourceRelationship = set.relationships.find((relationship) =>
      relationship.alphaWorkspaceRefId === valid.source.workspaceRefId
      || relationship.betaWorkspaceRefId === valid.source.workspaceRefId);
    const targetIds = valid.targets.map((target) => target.workspaceRefId);
    if (!sourceRelationship || !endpointIds.has(valid.source.workspaceRefId)
      || new Set(targetIds).size !== targetIds.length
      || targetIds.some((id) => id === valid.source.workspaceRefId || !endpointIds.has(id))) {
      throw Object.assign(new Error('Reviewed workspace conflict endpoints changed'), { code: 'approval_stale' });
    }
    if (valid.strategy === 'keep_both') {
      const identities = new Set<string>();
      const spokeIds = new Set([...endpointIds].filter((id) => id !== valid.hubWorkspaceRefId));
      for (const alternative of valid.alternatives) {
        if (alternative.source.expected.kind !== 'file'
          || !endpointIds.has(alternative.source.workspaceRefId)
          || alternative.destination.workspaceRefId !== valid.hubWorkspaceRefId
          || !['missing', 'file'].includes(alternative.destination.expected.kind)) {
          throw Object.assign(new Error('Reviewed file alternative placement changed'), { code: 'approval_stale' });
        }
        const consequenceIds = [
          ...alternative.consequence.propagatingToWorkspaceRefIds,
          ...(alternative.consequence.unverifiedPropagationToWorkspaceRefIds ?? []),
        ];
        if (new Set(consequenceIds).size !== consequenceIds.length
          || consequenceIds.some((id) => !spokeIds.has(id))) {
          throw Object.assign(new Error('Reviewed file alternative consequence changed'), { code: 'approval_stale' });
        }
        const paths = deriveWorkspaceSyncConflictAsidePaths(valid.path, alternative.source.expected);
        if (!paths.includes(alternative.destination.path)) {
          throw Object.assign(new Error('Reviewed file alternative name changed'), { code: 'approval_stale' });
        }
        if (alternative.destination.expected.kind === 'file'
          && !areWorkspaceSyncEntryExpectationsEqual(alternative.destination.expected, alternative.source.expected)) {
          throw Object.assign(new Error('Reviewed file alternative name is occupied'), { code: 'conflict_changed' });
        }
        const identity = JSON.stringify([alternative.source.expected.digest, alternative.source.expected.executable]);
        if (identities.has(identity)) {
          throw Object.assign(new Error('Duplicate reviewed file alternative'), { code: 'approval_stale' });
        }
        identities.add(identity);
      }
    }
    type EndpointResult = WorkspaceSyncConflictResolutionResultV1['endpoints'][number];
    const outcomes = new Map<string, EndpointResult>();
    type PreservedResult = NonNullable<WorkspaceSyncConflictResolutionResultV1['preserved']>[number];
    const preserved = new Map<number, PreservedResult>();
    const confirmedPropagationByAlternative = new Map<number, readonly string[]>();
    const unverifiedPropagationByAlternative = new Map<number, readonly string[]>();
    const recordAlternative = (index: number, outcome: PreservedResult['outcome']): void => {
      if (valid.strategy !== 'keep_both') return;
      const alternative = valid.alternatives[index]!;
      preserved.set(index, {
        alternativeIndex: index,
        sourceWorkspaceRefId: alternative.source.workspaceRefId,
        destinationWorkspaceRefId: alternative.destination.workspaceRefId,
        path: alternative.destination.path,
        propagatingToWorkspaceRefIds: confirmedPropagationByAlternative.get(index)
          ?? alternative.consequence.propagatingToWorkspaceRefIds,
        ...((unverifiedPropagationByAlternative.get(index)
          ?? alternative.consequence.unverifiedPropagationToWorkspaceRefIds)?.length
          ? { unverifiedPropagationToWorkspaceRefIds: unverifiedPropagationByAlternative.get(index)
            ?? alternative.consequence.unverifiedPropagationToWorkspaceRefIds }
          : {}),
        outcome,
      });
    };
    const finish = (): WorkspaceSyncConflictResolutionResultV1 => WorkspaceSyncConflictResolutionResultV1Schema.parse({
      endpoints: valid.targets.map((target) => outcomes.get(target.workspaceRefId)
        ?? { workspaceRefId: target.workspaceRefId, status: 'unknown' }),
      ...(valid.strategy === 'keep_both' ? { preserved: valid.alternatives.map((alternative, index) => preserved.get(index) ?? {
        alternativeIndex: index,
        sourceWorkspaceRefId: alternative.source.workspaceRefId,
        destinationWorkspaceRefId: alternative.destination.workspaceRefId,
        path: alternative.destination.path,
        propagatingToWorkspaceRefIds: alternative.consequence.propagatingToWorkspaceRefIds,
        ...(alternative.consequence.unverifiedPropagationToWorkspaceRefIds?.length
          ? { unverifiedPropagationToWorkspaceRefIds: alternative.consequence.unverifiedPropagationToWorkspaceRefIds } : {}),
        outcome: { status: 'not_started' as const },
      }) } : {}),
    });
    const sourceRef = await this.resolveRef(valid.source.workspaceRefId);
    if (!sourceRef) {
      for (const target of valid.targets) outcomes.set(target.workspaceRefId, { workspaceRefId: target.workspaceRefId, status: 'offline' });
      return finish();
    }
    const recover = this.recoverConflictResolutionAtTarget;
    if (recover) {
      try {
        const result = await recover({
          relationshipId: sourceRelationship.relationshipId,
          targetMachineId: sourceRef.machineId,
          targetWorkspaceRefId: valid.source.workspaceRefId,
          ...(signal ? { signal } : {}),
        });
        if (result.status === 'recovery_needed') {
          for (const target of valid.targets) outcomes.set(target.workspaceRefId, {
            workspaceRefId: target.workspaceRefId, status: 'recovery_needed', recoveryPath: result.recoveryPath,
          });
          return finish();
        }
      } catch (error) {
        const code = readErrorCode(error);
        if (code !== 'peer_unavailable' && code !== 'agent_unavailable') throw error;
        for (const target of valid.targets) outcomes.set(target.workspaceRefId, { workspaceRefId: target.workspaceRefId, status: 'offline' });
        return finish();
      }
    }
    type TargetPlan = {
      target: (typeof valid.targets)[number];
      relationship: WorkspaceSyncRelationshipV1;
      ref: WorkspaceSyncResolvedRef;
      common: Readonly<{
        actionReceiptId: string;
        actionInput: WorkspaceSyncConflictResolveActionInputV1;
        operationId: string;
        alternativeIndex: number | null;
        relationshipId: string;
        targetMachineId: string;
        targetWorkspaceRefId: string;
        path: string;
        signal?: AbortSignal;
      }>;
      applyStarted: boolean;
    };
    const staged: TargetPlan[] = [];
    const stagedAlternatives: TargetPlan[] = [];
    const captureSources = new Map<string, string>();
    try {
      if (valid.strategy === 'keep_both') {
        for (const [index, alternative] of valid.alternatives.entries()) {
          abortIfRequested(signal);
          const sourceLink = set.relationships.find((member) => relationshipContainsRef(member, alternative.source.workspaceRefId));
          const destinationLink = set.relationships.find((member) => relationshipContainsRef(member, alternative.destination.workspaceRefId));
          if (!sourceLink || !destinationLink) throw Object.assign(new Error('Reviewed file alternative link changed'), { code: 'approval_stale' });
          const [alternativeSourceRef, destinationRef] = await Promise.all([
            this.resolveRef(alternative.source.workspaceRefId),
            this.resolveRef(alternative.destination.workspaceRefId),
          ]);
          if (!alternativeSourceRef || !destinationRef) {
            recordAlternative(index, { status: 'offline' });
            continue;
          }
          const common = {
            actionReceiptId, actionInput, alternativeIndex: index,
            operationId: deriveWorkspaceSyncConflictOperationId({
              actionReceiptId, kind: 'alternative', workspaceRefId: alternative.destination.workspaceRefId,
              path: alternative.destination.path, alternativeIndex: index,
            }),
            relationshipId: destinationLink.relationshipId,
            targetMachineId: destinationRef.machineId,
            targetWorkspaceRefId: alternative.destination.workspaceRefId,
            path: alternative.destination.path,
            ...(signal ? { signal } : {}),
          } as const;
          if (recover) {
            try {
              const recovered = await recover({
                relationshipId: destinationLink.relationshipId,
                targetMachineId: destinationRef.machineId,
                targetWorkspaceRefId: alternative.destination.workspaceRefId,
                ...(signal ? { signal } : {}),
              });
              if (recovered.status === 'recovery_needed') {
                recordAlternative(index, { status: 'recovery_needed', recoveryPath: recovered.recoveryPath });
                continue;
              }
            } catch (error) {
              const code = readErrorCode(error);
              recordAlternative(index, code === 'peer_unavailable' || code === 'agent_unavailable'
                ? { status: 'offline' } : { status: 'failed', errorCode: code ?? 'indeterminate' });
              continue;
            }
          }
          try {
            captureSources.set(alternativeSourceRef.machineId, alternative.source.workspaceRefId);
            await stage({
              ...common,
              sourceRelationshipId: sourceLink.relationshipId,
              sourceMachineId: alternativeSourceRef.machineId,
              sourceWorkspaceRefId: alternative.source.workspaceRefId,
              sourceExpected: alternative.source.expected,
              targetExpected: alternative.destination.expected,
            });
            stagedAlternatives.push({
              target: alternative.destination,
              relationship: destinationLink,
              ref: destinationRef,
              common,
              applyStarted: false,
            });
          } catch (error) {
            const code = readErrorCode(error);
            recordAlternative(index, code === 'conflict_changed'
              ? { status: 'changed' }
              : code === 'peer_unavailable' || code === 'agent_unavailable'
                ? { status: 'offline' }
                : code === 'cancelled' || signal?.aborted
                  ? { status: 'cancelled' }
                  : { status: 'failed', errorCode: code ?? 'indeterminate' });
          }
        }
        if (preserved.size > 0) {
          for (const target of valid.targets) outcomes.set(target.workspaceRefId, {
            workspaceRefId: target.workspaceRefId, status: 'failed', errorCode: 'preservation_unavailable',
          });
          return finish();
        }
      }
      for (const target of valid.targets) {
        abortIfRequested(signal);
        const relationship = set.relationships.find((member) => member.alphaWorkspaceRefId === target.workspaceRefId
          || member.betaWorkspaceRefId === target.workspaceRefId);
        if (!relationship) throw Object.assign(new Error('Reviewed workspace conflict destination link changed'), { code: 'approval_stale' });
        const ref = await this.resolveRef(target.workspaceRefId);
        if (!ref) {
          outcomes.set(target.workspaceRefId, { workspaceRefId: target.workspaceRefId, status: 'offline' });
          continue;
        }
        const common = {
          actionReceiptId, actionInput, alternativeIndex: null,
          operationId: deriveWorkspaceSyncConflictOperationId({
            actionReceiptId,
            kind: 'selected',
            workspaceRefId: target.workspaceRefId,
            path: valid.path,
          }),
          relationshipId: relationship.relationshipId,
          targetMachineId: ref.machineId, targetWorkspaceRefId: target.workspaceRefId,
          path: valid.path, ...(signal ? { signal } : {}),
        } as const;
        if (recover) {
          try {
            const result = await recover({
              relationshipId: relationship.relationshipId,
              targetMachineId: ref.machineId, targetWorkspaceRefId: target.workspaceRefId,
              ...(signal ? { signal } : {}),
            });
            if (result.status === 'recovery_needed') {
              outcomes.set(target.workspaceRefId, {
                workspaceRefId: target.workspaceRefId, status: 'recovery_needed', recoveryPath: result.recoveryPath,
              });
              continue;
            }
          } catch (error) {
            const code = readErrorCode(error);
            if (code !== 'peer_unavailable' && code !== 'agent_unavailable') throw error;
            outcomes.set(target.workspaceRefId, { workspaceRefId: target.workspaceRefId, status: 'offline' });
            continue;
          }
        }
        try {
          captureSources.set(sourceRef.machineId, valid.source.workspaceRefId);
          await stage({
            ...common,
            sourceRelationshipId: sourceRelationship.relationshipId,
            sourceMachineId: sourceRef.machineId,
            sourceWorkspaceRefId: valid.source.workspaceRefId,
            sourceExpected: valid.source.expected,
            targetExpected: target.expected,
          });
          staged.push({ target, relationship, ref, common, applyStarted: false });
        } catch (error) {
          const code = readErrorCode(error);
          if (code === 'approval_required' || code === 'approval_stale') throw error;
          outcomes.set(target.workspaceRefId, code === 'conflict_changed'
            ? { workspaceRefId: target.workspaceRefId, status: 'changed' }
            : code === 'peer_unavailable' || code === 'agent_unavailable'
              ? { workspaceRefId: target.workspaceRefId, status: 'offline' }
              : code === 'cancelled' || signal?.aborted
                ? { workspaceRefId: target.workspaceRefId, status: 'cancelled' }
                : { workspaceRefId: target.workspaceRefId, status: 'failed', errorCode: code ?? 'indeterminate' });
        }
      }
      if (staged.length === 0) return finish();
      await this.enqueueAll([
        ...requestedIds,
        ...[...endpointIds].map((id) => `workspace-ref:${id}`),
      ], async () => {
        const latest = await currentSet();
        const latestIds = latest?.relationships.map((relationship) => relationship.relationshipId).sort() ?? [];
        if (!latest || JSON.stringify(latestIds) !== JSON.stringify(currentIds)
          || set.relationships.some((relationship) => !latest.relationships.some((candidate) =>
            candidate.relationshipId === relationship.relationshipId
            && areWorkspaceSyncRelationshipDefinitionsEqual(candidate, relationship)))) {
          for (const plan of staged) outcomes.set(plan.target.workspaceRefId, {
            workspaceRefId: plan.target.workspaceRefId, status: 'changed',
          });
          return;
        }
        const authorize = this.assertConflictResolutionAuthorized;
        if (!authorize) throw Object.assign(new Error('Workspace conflict Action receipt authority is unavailable'), { code: 'approval_required' });
        await authorize(actionReceiptId, actionInput);
        await this.lifecycle.start();
        for (const relationship of set.relationships) {
          await this.assertRelationshipOwnershipCurrent(relationship.relationshipId);
        }
        const sourceSide = sourceRelationship.alphaWorkspaceRefId === valid.source.workspaceRefId ? 'alpha' : 'beta';
        const localSource = await this.resolveLocalSourceAccess(sourceRelationship, sourceSide);
        const currentSource = localSource
          ? await observeWorkspaceSyncEntryAtRoot({
            rootPath: localSource.canonicalRoot,
            relativePath: valid.path,
            assertCurrentAuthority: localSource.assertCurrentAuthority,
          })
          : this.observeEntryAtTarget
            ? await this.observeEntryAtTarget({
              relationshipId: sourceRelationship.relationshipId,
              targetMachineId: sourceRef.machineId,
              targetWorkspaceRefId: valid.source.workspaceRefId,
              path: valid.path,
              ...(signal ? { signal } : {}),
            })
            : null;
        if (!currentSource) throw Object.assign(new Error('Reviewed workspace source cannot be rechecked'), { code: 'agent_unavailable' });
        if (!areWorkspaceSyncEntryExpectationsEqual(currentSource, valid.source.expected)) {
          for (const plan of staged) outcomes.set(plan.target.workspaceRefId, {
            workspaceRefId: plan.target.workspaceRefId, status: 'changed',
          });
          return;
        }
        if (valid.strategy === 'keep_both') {
          for (const [index, alternative] of valid.alternatives.entries()) {
            const sourceLink = set.relationships.find((member) => relationshipContainsRef(member, alternative.source.workspaceRefId))!;
            const destinationLink = set.relationships.find((member) => relationshipContainsRef(member, alternative.destination.workspaceRefId))!;
            const sourceSide = sourceLink.alphaWorkspaceRefId === alternative.source.workspaceRefId ? 'alpha' : 'beta';
            const sourceAccess = await this.resolveLocalSourceAccess(sourceLink, sourceSide);
            const alternativeSourceRef = await this.resolveRef(alternative.source.workspaceRefId);
            const currentAlternative = sourceAccess
              ? await observeWorkspaceSyncEntryAtRoot({
                rootPath: sourceAccess.canonicalRoot,
                relativePath: valid.path,
                assertCurrentAuthority: sourceAccess.assertCurrentAuthority,
              })
              : alternativeSourceRef && this.observeEntryAtTarget
                ? await this.observeEntryAtTarget({
                  relationshipId: sourceLink.relationshipId,
                  targetMachineId: alternativeSourceRef.machineId,
                  targetWorkspaceRefId: alternative.source.workspaceRefId,
                  path: valid.path,
                  ...(signal ? { signal } : {}),
                }) : null;
            const destinationSide = destinationLink.alphaWorkspaceRefId === alternative.destination.workspaceRefId ? 'alpha' : 'beta';
            const destinationAccess = await this.resolveLocalSourceAccess(destinationLink, destinationSide);
            const destinationRef = await this.resolveRef(alternative.destination.workspaceRefId);
            const currentAside = destinationAccess
              ? await observeWorkspaceSyncEntryAtRoot({
                rootPath: destinationAccess.canonicalRoot,
                relativePath: alternative.destination.path,
                assertCurrentAuthority: destinationAccess.assertCurrentAuthority,
              })
              : destinationRef && this.observeEntryAtTarget
                ? await this.observeEntryAtTarget({
                  relationshipId: destinationLink.relationshipId,
                  targetMachineId: destinationRef.machineId,
                  targetWorkspaceRefId: alternative.destination.workspaceRefId,
                  path: alternative.destination.path,
                  ...(signal ? { signal } : {}),
                }) : null;
            if (!currentAlternative || !currentAside
              || !areWorkspaceSyncEntryExpectationsEqual(currentAlternative, alternative.source.expected)
              || !areWorkspaceSyncEntryExpectationsEqual(currentAside, alternative.destination.expected)) {
              recordAlternative(index, { status: 'changed' });
              for (const target of valid.targets) outcomes.set(target.workspaceRefId, {
                workspaceRefId: target.workspaceRefId, status: 'changed',
              });
              return;
            }
            const propagatingToWorkspaceRefIds: string[] = [];
            const unverifiedPropagationToWorkspaceRefIds: string[] = [];
            let consequenceChanged = false;
            for (const relationship of set.relationships) {
              const hubSide = relationship.alphaWorkspaceRefId === valid.hubWorkspaceRefId ? 'alpha' : 'beta';
              const spokeSide = hubSide === 'alpha' ? 'beta' : 'alpha';
              const spokeRefId = hubSide === 'alpha'
                ? relationship.betaWorkspaceRefId : relationship.alphaWorkspaceRefId;
              const [hubSelection, spokeSelection] = await Promise.all([
                this.adapter.diagnoseSelection({ relationshipId: relationship.relationshipId, side: hubSide, path: alternative.destination.path }, signal)
                  .catch((error: unknown): WorkspaceSyncPathSelectionV1 => {
                    if (signal?.aborted || readErrorCode(error) === 'cancelled') throw error;
                    return { status: 'unknown', reason: 'endpoint_unavailable' };
                  }),
                this.adapter.diagnoseSelection({ relationshipId: relationship.relationshipId, side: spokeSide, path: alternative.destination.path }, signal)
                  .catch((error: unknown): WorkspaceSyncPathSelectionV1 => {
                    if (signal?.aborted || readErrorCode(error) === 'cancelled') throw error;
                    return { status: 'unknown', reason: 'endpoint_unavailable' };
                  }),
              ]);
              const approvedPropagation = alternative.consequence.propagatingToWorkspaceRefIds.includes(spokeRefId);
              const approvedUnknown = alternative.consequence.unverifiedPropagationToWorkspaceRefIds?.includes(spokeRefId) ?? false;
              if (hubSelection.status === 'excluded' || spokeSelection.status === 'excluded') {
                if (approvedPropagation) consequenceChanged = true;
                continue;
              }
              if (hubSelection.status === 'included' && spokeSelection.status === 'included') {
                propagatingToWorkspaceRefIds.push(spokeRefId);
                if (!approvedPropagation && !approvedUnknown) consequenceChanged = true;
              } else {
                unverifiedPropagationToWorkspaceRefIds.push(spokeRefId);
              }
            }
            confirmedPropagationByAlternative.set(index, propagatingToWorkspaceRefIds);
            unverifiedPropagationByAlternative.set(index, unverifiedPropagationToWorkspaceRefIds);
            if (consequenceChanged) {
              recordAlternative(index, { status: 'changed' });
              for (const target of valid.targets) outcomes.set(target.workspaceRefId, {
                workspaceRefId: target.workspaceRefId, status: 'changed',
              });
              return;
            }
          }
        }
        const priorById = new Map<string, WorkspaceSyncStatusV1>();
        for (const relationship of set.relationships) {
          const prior = this.statuses.get(relationship.relationshipId) ?? await this.adapter.get(relationship.relationshipId, signal);
          if (!prior) {
            for (const plan of staged) outcomes.set(plan.target.workspaceRefId, {
              workspaceRefId: plan.target.workspaceRefId, status: 'failed', errorCode: 'relationship_not_ready',
            });
            return;
          }
          priorById.set(relationship.relationshipId, prior);
        }
        const pausedByResolution = new Set<string>();
        try {
          for (const relationship of set.relationships) {
            const prior = priorById.get(relationship.relationshipId)!;
            if (prior.state === 'paused' || prior.state === 'stopped') continue;
            await this.adapter.pause(relationship.relationshipId, signal);
            pausedByResolution.add(relationship.relationshipId);
          }
        } catch (error) {
          for (const id of pausedByResolution) await this.adapter.resume(id, signal).catch(() => undefined);
          const code = readErrorCode(error) ?? 'engine_unavailable';
          for (const plan of staged) outcomes.set(plan.target.workspaceRefId, {
            workspaceRefId: plan.target.workspaceRefId, status: 'failed', errorCode: code,
          });
          return;
        }
        try {
          await authorize(actionReceiptId, actionInput);
          for (const relationship of set.relationships) await this.assertRelationshipOwnershipCurrent(relationship.relationshipId);
        } catch (error) {
          for (const id of pausedByResolution) await this.adapter.resume(id, signal).catch(() => undefined);
          throw error;
        }
        const blocked = new Set<string>();
        const installed = new Set<string>();
        let preservationFailed = false;
        if (valid.strategy === 'keep_both') {
          for (const plan of stagedAlternatives) {
            const index = plan.common.alternativeIndex!;
            const alternative = valid.alternatives[index]!;
            if (signal?.aborted) {
              recordAlternative(index, { status: 'cancelled' });
              preservationFailed = true;
              continue;
            }
            if (areWorkspaceSyncEntryExpectationsEqual(alternative.destination.expected, alternative.source.expected)) {
              recordAlternative(index, { status: 'already_present' });
              continue;
            }
            plan.applyStarted = true;
            try {
              const disposition = await apply(plan.common);
              if (disposition.status === 'installed') {
                recordAlternative(index, { status: 'preserved' });
                for (const id of requestedIds) installed.add(id);
              } else if (disposition.status === 'recovery_needed') {
                recordAlternative(index, { status: 'recovery_needed', recoveryPath: disposition.recoveryPath });
                preservationFailed = true;
                for (const id of requestedIds) blocked.add(id);
              } else {
                recordAlternative(index, { status: 'changed' });
                preservationFailed = true;
              }
            } catch (error) {
              const code = readErrorCode(error);
              const recoveryPath = error && typeof error === 'object' && 'recoveryPath' in error
                && typeof error.recoveryPath === 'string' && error.recoveryPath.length > 0 ? error.recoveryPath : null;
              recordAlternative(index, recoveryPath
                ? { status: 'recovery_needed', recoveryPath }
                : { status: 'failed', errorCode: code ?? 'indeterminate' });
              preservationFailed = true;
              for (const id of requestedIds) blocked.add(id);
            }
          }
          if (preservationFailed) {
            for (const target of valid.targets) outcomes.set(target.workspaceRefId, {
              workspaceRefId: target.workspaceRefId, status: 'failed', errorCode: 'preservation_unavailable',
            });
          }
        }
        for (const plan of preservationFailed ? [] : staged) {
          if (signal?.aborted) {
            outcomes.set(plan.target.workspaceRefId, { workspaceRefId: plan.target.workspaceRefId, status: 'cancelled' });
            continue;
          }
          plan.applyStarted = true;
          try {
            const disposition = await apply(plan.common);
            if (disposition.status === 'recovery_needed') {
              outcomes.set(plan.target.workspaceRefId, {
                workspaceRefId: plan.target.workspaceRefId, status: 'recovery_needed', recoveryPath: disposition.recoveryPath,
              });
              blocked.add(plan.relationship.relationshipId);
            } else if (disposition.status === 'restored') {
              outcomes.set(plan.target.workspaceRefId, { workspaceRefId: plan.target.workspaceRefId, status: 'changed' });
            } else {
              outcomes.set(plan.target.workspaceRefId, { workspaceRefId: plan.target.workspaceRefId, status: 'applied' });
              installed.add(plan.relationship.relationshipId);
            }
          } catch (error) {
            const code = readErrorCode(error);
            const recoveryPath = error && typeof error === 'object' && 'recoveryPath' in error
              && typeof error.recoveryPath === 'string' && error.recoveryPath.length > 0 ? error.recoveryPath : null;
            if (recoveryPath) {
              outcomes.set(plan.target.workspaceRefId, {
                workspaceRefId: plan.target.workspaceRefId, status: 'recovery_needed', recoveryPath,
              });
              blocked.add(plan.relationship.relationshipId);
            } else if (code === 'conflict_changed') {
              outcomes.set(plan.target.workspaceRefId, { workspaceRefId: plan.target.workspaceRefId, status: 'changed' });
            } else {
              outcomes.set(plan.target.workspaceRefId, code === 'cancelled' || signal?.aborted
                ? { workspaceRefId: plan.target.workspaceRefId, status: 'unknown' }
                : { workspaceRefId: plan.target.workspaceRefId, status: 'failed', errorCode: code ?? 'indeterminate' });
              blocked.add(plan.relationship.relationshipId);
            }
          }
        }
        if (blocked.size > 0 && valid.targets.some((target) => target.workspaceRefId === valid.hubWorkspaceRefId
          && ['recovery_needed', 'failed', 'unknown'].includes(outcomes.get(target.workspaceRefId)?.status ?? ''))) {
          for (const id of requestedIds) blocked.add(id);
        }
        for (const relationship of set.relationships) {
          const id = relationship.relationshipId;
          if (blocked.has(id)) continue;
          const prior = priorById.get(id)!;
          if (!pausedByResolution.has(id)) {
            for (const plan of staged.filter((candidate) => candidate.relationship.relationshipId === id)) {
              const current = outcomes.get(plan.target.workspaceRefId);
              if (current?.status === 'applied') outcomes.set(plan.target.workspaceRefId, {
                workspaceRefId: plan.target.workspaceRefId, status: 'applied_paused',
              });
            }
            continue;
          }
          try {
            await this.recoverConflictResolutionForRelationship(relationship, signal);
            await this.assertRelationshipOwnershipCurrent(id);
            await this.adapter.resume(id, signal);
            if (installed.has(id) && prior.state !== 'stopped') await this.adapter.flush(id, signal);
          } catch {
            for (const plan of staged.filter((candidate) => candidate.relationship.relationshipId === id)) {
              const current = outcomes.get(plan.target.workspaceRefId);
              if (current?.status === 'applied') outcomes.set(plan.target.workspaceRefId, {
                workspaceRefId: plan.target.workspaceRefId, status: 'applied_paused',
              });
            }
          }
        }
      });
      return finish();
    } finally {
      try {
        for (const plan of [...stagedAlternatives, ...staged]) {
          if (!plan.applyStarted) await this.discardStagedConflictResolutionAtTarget?.({ ...plan.common, signal: undefined });
        }
      } finally {
        for (const [sourceMachineId, sourceWorkspaceRefId] of captureSources) {
          await this.releaseConflictResolutionCaptureAtSource?.({
            actionReceiptId, actionInput, operationId: actionReceiptId,
            sourceMachineId, sourceWorkspaceRefId,
          });
        }
      }
    }
  }
  async readFile(request: ReadWorkspaceSyncFileV1, signal?: AbortSignal): Promise<ReadWorkspaceSyncFileResultV1> {
    this.assertStateAvailable();
    abortIfRequested(signal);
    const valid = ReadWorkspaceSyncFileV1Schema.parse(request);
    const definition = this.definitions.get(valid.relationshipId);
    if (!definition) throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
    const localSource = await this.resolveLocalSourceAccess(definition, valid.side);
    if (localSource) {
      return await this.enqueue(valid.relationshipId, signal, async () => {
        const currentDefinition = this.definitions.get(valid.relationshipId);
        if (!currentDefinition) throw Object.assign(new Error('Workspace sync relationship is not ready'), { code: 'relationship_not_ready' });
        const currentLocalSource = await this.resolveLocalSourceAccess(currentDefinition, valid.side);
        if (!currentLocalSource) {
          throw Object.assign(new Error('Workspace sync source endpoint is no longer local'), { code: 'relationship_not_ready' });
        }
        return await readWorkspaceSyncFileAtRoot({
          rootPath: currentLocalSource.canonicalRoot,
          relativePath: valid.path,
          ...(valid.expectedDigest === undefined ? {} : { expectedDigest: valid.expectedDigest }),
          maxBytes: valid.maxBytes,
          assertCurrentAuthority: currentLocalSource.assertCurrentAuthority,
        });
      }, false);
    }
    if (!this.readAtTarget) throw Object.assign(new Error('Authenticated target file preview is unavailable'), { code: 'agent_unavailable' });
    const targetWorkspaceRefId = valid.side === 'alpha'
      ? definition.alphaWorkspaceRefId
      : definition.betaWorkspaceRefId;
    const target = await this.resolveRef(targetWorkspaceRefId);
    if (!target) throw Object.assign(new Error('Workspace sync preview target is unavailable'), { code: 'peer_unavailable' });
    return await this.readAtTarget({
      relationshipId: valid.relationshipId,
      targetMachineId: target.machineId,
      targetWorkspaceRefId,
      path: valid.path,
      ...(valid.expectedDigest === undefined ? {} : { expectedDigest: valid.expectedDigest }),
      maxBytes: valid.maxBytes,
      signal,
    });
  }
  async withAuthorizedSourceSeedExport<T>(
    request: Readonly<{
      operationId: string;
      sourceWorkspaceRefId: string;
      targetMachineId: string;
      contentPolicy: WorkspaceContentPolicyV1;
    }>,
    exportSource: (canonicalSourcePath: string) => Promise<T>,
  ): Promise<T> {
    const authorization = this.sourceSeedAuthorizations.get(request.operationId);
    if (!authorization) {
      throw Object.assign(new Error('Workspace sync source seed operation is not active'), { code: 'relationship_not_ready' });
    }
    const { operation } = authorization;
    if (!areContentPoliciesEqual(operation.contentPolicy, request.contentPolicy)) {
      throw Object.assign(new Error('Workspace sync source seed policy does not match the active operation'), { code: 'relationship_definition_conflict' });
    }
    const [alpha, beta] = await Promise.all([
      this.resolveRef(operation.alphaWorkspaceRefId, 'operationId' in operation ? operation.operationId : undefined),
      authorization.acceptedTargetWorkspace
        ?? this.resolveRef(operation.betaWorkspaceRefId, 'operationId' in operation ? operation.operationId : undefined),
    ]);
    if (!alpha || !beta) {
      throw Object.assign(new Error('Workspace sync source seed endpoint is unavailable'), { code: 'peer_unavailable' });
    }
    const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: 'relationshipId' in operation ? operation.mode : 'keep_synced',
      controllerMachineId: operation.controllerMachineId,
      alphaMachineId: alpha.machineId,
      betaMachineId: beta.machineId,
    });
    if (!roles) {
      throw Object.assign(new Error('Workspace sync source seed operation placement is invalid'), { code: 'controller_unavailable' });
    }
    const sourceWorkspaceRefId = roles.sourceEndpointRole === 'alpha'
      ? operation.alphaWorkspaceRefId
      : operation.betaWorkspaceRefId;
    const source = roles.sourceEndpointRole === 'alpha' ? alpha : beta;
    const target = roles.targetEndpointRole === 'alpha' ? alpha : beta;
    this.assertLocalSourcePlacement(source);
    if (sourceWorkspaceRefId !== request.sourceWorkspaceRefId
      || target.machineId !== request.targetMachineId) {
      throw Object.assign(new Error('Workspace sync source seed request does not match the active operation'), { code: 'target_unavailable' });
    }
    const canonicalSourcePath = await realpath(source.rootPath).catch(() => {
      throw Object.assign(new Error('Workspace sync source seed root is unavailable'), { code: 'root_changed' });
    });
    const sourceFence = authorization.ownershipHandles.find((handle) => (
      getPathRemainderWithinBase(handle.owner.canonicalRoot, canonicalSourcePath) === ''
      && getPathRemainderWithinBase(canonicalSourcePath, handle.owner.canonicalRoot) === ''
    ));
    if (!sourceFence) {
      throw Object.assign(new Error('Workspace sync source seed root is not fenced'), { code: 'root_changed' });
    }
    try {
      await sourceFence.bindCurrentRootIdentity();
    } catch {
      throw Object.assign(new Error('Workspace sync source seed root changed after admission'), { code: 'root_changed' });
    }
    return await exportSource(canonicalSourcePath);
  }
  async withSourceSeedAuthorization<T>(
    operation: WorkspaceSyncRelationshipV1 | WorkspaceSyncCopyOnceV1,
    ownershipHandles: readonly WorkspaceRootOwnershipHandle[],
    action: () => Promise<T>,
    acceptedTargetWorkspace?: WorkspaceRefV1,
  ): Promise<T> {
    const operationId = 'relationshipId' in operation ? operation.relationshipId : operation.operationId;
    if (this.sourceSeedAuthorizations.has(operationId)) {
      throw Object.assign(new Error('Workspace sync source seed operation is already active'), { code: 'relationship_definition_conflict' });
    }
    const target = acceptedTargetWorkspace ? WorkspaceRefV1Schema.parse(acceptedTargetWorkspace) : undefined;
    if (target && (!('operationId' in operation) || target.id !== operation.betaWorkspaceRefId
      || !this.localServerId || target.serverId !== this.localServerId)) {
      throw Object.assign(new Error('Workspace sync source seed target does not match the active copy'), { code: 'target_unavailable' });
    }
    this.sourceSeedAuthorizations.set(operationId, { operation, ownershipHandles,
      ...(target ? { acceptedTargetWorkspace: target } : {}) });
    this.notifyActivity();
    try {
      return await action();
    } finally {
      this.sourceSeedAuthorizations.delete(operationId);
      this.notifyActivity();
    }
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.notifyActivity();
    const cleanupFailures: unknown[] = [];
    try {
      await this.stopAllStatusObservations();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await this.lifecycle.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    const activeIngressIds = [...this.activeIngress.keys()];
    const ingressCleanup = await Promise.allSettled(
      activeIngressIds.map(async (id) => await this.closeActiveIngress(id)),
    );
    const failedIngressIds = new Set<string>();
    for (let index = 0; index < ingressCleanup.length; index += 1) {
      const result = ingressCleanup[index]!;
      if (result.status === 'rejected') {
        cleanupFailures.push(result.reason);
        failedIngressIds.add(activeIngressIds[index]!);
      }
    }
    for (const [id, custody] of [...this.fences]) {
      if (failedIngressIds.has(id)) continue;
      const results = await Promise.allSettled(custody.ownedHandles.map(async (handle) => {
        this.pendingRootReleases.add(handle);
        this.notifyActivity();
        await handle.release();
        this.pendingRootReleases.delete(handle);
        this.notifyActivity();
        return handle;
      }));
      const failedHandles: WorkspaceRootOwnershipHandle[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === 'rejected') {
          cleanupFailures.push(result.reason);
          failedHandles.push(custody.ownedHandles[index]!);
        }
      }
      if (failedHandles.length === 0) {
        try {
          await this.releaseSharedHubParticipation(id);
          this.fences.delete(id);
        } catch (error) {
          cleanupFailures.push(error);
        }
      } else {
        this.fences.set(id, { handles: custody.handles, ownedHandles: failedHandles });
      }
    }
    for (const [id, handles] of [...this.copyOwnedFences]) {
      if (failedIngressIds.has(id)) continue;
      const results = await Promise.allSettled(handles.map(async (handle) => {
        this.pendingRootReleases.add(handle);
        this.notifyActivity();
        await handle.release();
        this.pendingRootReleases.delete(handle);
        this.notifyActivity();
        return handle;
      }));
      const failedHandles: WorkspaceRootOwnershipHandle[] = [];
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index]!;
        if (result.status === 'rejected') {
          cleanupFailures.push(result.reason);
          failedHandles.push(handles[index]!);
        }
      }
      if (failedHandles.length === 0) this.copyOwnedFences.delete(id);
      else this.copyOwnedFences.set(id, failedHandles);
      if (failedHandles.length === 0) {
        const releaseSource = this.copySourceReleases.get(id);
        if (releaseSource) {
          try {
            await releaseSource();
            this.copySourceReleases.delete(id);
          } catch (error) {
            cleanupFailures.push(error);
          }
        }
      }
    }
    for (const id of [...this.participantHubKeys.keys()]) {
      if (this.fences.has(id) || this.copySourceReleases.has(id)) continue;
      try {
        await this.releaseSharedHubParticipation(id);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const associatedHandles = new Set([
      ...[...this.fences.values()].flatMap((custody) => custody.ownedHandles),
      ...[...this.copyOwnedFences.values()].flat(),
    ]);
    const detachedRootReleases = [...this.pendingRootReleases].filter((handle) => !associatedHandles.has(handle));
    await this.releaseRootHandles(detachedRootReleases).catch((error: unknown) => {
      cleanupFailures.push(error);
    });
    for (const [id, release] of [...this.copyTargetReleases]) {
      try {
        await release('abort');
        this.copyTargetReleases.delete(id);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    this.copyFences.clear();
    this.copyOperations.clear();
    this.copyTerminalPending.clear();
    this.transientDefinitions.clear();
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Workspace sync controller cleanup failed');
    }
  }
  async rehydrateFromSettings(value: unknown): Promise<readonly WorkspaceSyncStatusV1[]> {
    this.assertStateAvailable();
    const savedRelationships = validateWorkspaceSyncRelationships(value);
    const relationshipsById = new Map(savedRelationships.map((relationship) => [relationship.relationshipId, relationship] as const));
    for (const id of this.transientDefinitions) {
      const live = this.definitions.get(id);
      if (!live) continue;
      const saved = relationshipsById.get(id);
      if (saved && !areWorkspaceSyncRelationshipDefinitionsEqual(saved, live)) {
        throw Object.assign(new Error('Prepared workspace relationship conflicts with saved settings'), {
          code: 'relationship_definition_conflict',
        });
      }
      // The staged disabled row is restart intent. While the owning transaction
      // is live, its already-admitted runtime definition remains authoritative;
      // a cold controller has no transient marker and therefore keeps it paused.
      relationshipsById.set(id, live);
    }
    const savedTopology = await this.deriveRuntimeTopology([...relationshipsById.values()]);
    const invalidRelationshipIds = new Set(savedTopology.issues.flatMap((issue) => issue.relationshipIds));
    const relationships = [...relationshipsById.values()].filter((relationship) => (
      relationship.controllerMachineId === this.localMachineId
      && !invalidRelationshipIds.has(relationship.relationshipId)
    ));
    const disabledRelationships = relationships.filter((relationship) => !relationship.enabled);
    const enabledRelationships = relationships.filter((relationship) => relationship.enabled);
    const gitRelationships = enabledRelationships.filter(({ contentPolicy }) => contentPolicy.selection === 'git_worktree');
    const gitUnavailable = gitRelationships.length > 0 && !(await this.probeGit());
    const rejectUnavailableGit = gitUnavailable
      && gitRelationships.length === enabledRelationships.length
      && disabledRelationships.length === 0;
    const activeRelationships = gitUnavailable
      ? enabledRelationships.filter(({ contentPolicy }) => contentPolicy.selection !== 'git_worktree')
      : enabledRelationships;
    return await this.enqueueAll([
      ...relationships.map(({ relationshipId }) => relationshipId),
      ...relationships.flatMap((relationship) => [
        `workspace-ref:${relationship.alphaWorkspaceRefId}`,
        `workspace-ref:${relationship.betaWorkspaceRefId}`,
      ]),
      ...this.definitions.keys(),
      ...this.copyOperations.keys(),
    ], async () => {
      // Disabled records remain settings intent. Their local roots are fenced
      // before runtime discovery so an existing sidecar cannot race its
      // terminal transition. They never bootstrap a target or create a new
      // runtime session during cold rehydration.
      const desired = new Map(
        [...activeRelationships, ...disabledRelationships]
          .map((relationship) => [relationship.relationshipId, relationship]),
      );
      for (const id of this.transientDefinitions) {
        const definition = this.definitions.get(id);
        if (definition && !desired.has(id)) desired.set(id, definition);
      }
      const pendingFences = new Map<string, Readonly<{
        handles: WorkspaceRootOwnershipHandle[];
        ownedHandles: WorkspaceRootOwnershipHandle[];
      }>>();
      try {
        for (const relationship of activeRelationships) {
          const current = this.definitions.get(relationship.relationshipId);
          if (current && areWorkspaceSyncRelationshipDefinitionsEqual(current, relationship)
            && this.fences.has(relationship.relationshipId)
            && !this.ownershipLost.has(relationship.relationshipId)) {
            try {
              await this.assertRelationshipOwnershipCurrent(relationship.relationshipId);
            } catch (error) {
              if (!(typeof error === 'object' && error !== null && 'code' in error
                && error.code === 'workspace_root_ownership_lost')) throw error;
            }
          }
          if (!current || !areWorkspaceSyncRelationshipDefinitionsEqual(current, relationship)
            || !this.fences.has(relationship.relationshipId)
            || this.ownershipLost.has(relationship.relationshipId)) {
            const sourceHandles = await this.acquireSourceRoots(relationship);
            // Recorded before target preparation so a failure there still
            // releases the source fence through the loop's cleanup.
            pendingFences.set(relationship.relationshipId, {
              handles: [...sourceHandles],
              ownedHandles: [],
            });
            const targetPreparation = await this.prepareTarget(relationship, undefined);
            const carriedHandles = [...sourceHandles, ...(targetPreparation?.ownershipHandles ?? [])];
            const acquiredHandles = await this.acquireRoots(relationship, carriedHandles);
            pendingFences.set(relationship.relationshipId, {
              handles: [...carriedHandles, ...acquiredHandles],
              ownedHandles: [...acquiredHandles],
            });
          }
        }
        for (const relationship of disabledRelationships) {
          const current = this.definitions.get(relationship.relationshipId);
          if (current && areWorkspaceSyncRelationshipDefinitionsEqual(current, relationship)
            && this.fences.has(relationship.relationshipId)) {
            await this.assertRelationshipOwnershipCurrent(relationship.relationshipId);
            continue;
          }
          const sourceHandles = await this.acquireSourceRoots(relationship);
          const acquiredHandles = await this.acquireRoots(relationship, sourceHandles);
          pendingFences.set(relationship.relationshipId, {
            handles: [...sourceHandles, ...acquiredHandles],
            ownedHandles: acquiredHandles,
          });
        }
      } catch (error) {
        const cleanup = await Promise.allSettled([
          this.releaseRootHandles([...pendingFences.values()].flatMap((custody) => custody.ownedHandles)),
          ...[...pendingFences.keys()].map(async (id) => await this.releaseSharedHubParticipation(id)),
        ]);
        const cleanupFailures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (cleanupFailures.length > 0) {
          throw new AggregateError([error, ...cleanupFailures], 'Workspace sync admission and custody cleanup failed');
        }
        throw error;
      }
      const stagedPrevious = new Map<string, Readonly<{
        definition: WorkspaceSyncRelationshipV1 | undefined;
        custody: Readonly<{ handles: WorkspaceRootOwnershipHandle[]; ownedHandles: WorkspaceRootOwnershipHandle[] }> | undefined;
        ingress: ReadonlySet<ActiveWorkspaceSyncIngress>;
      }>>();
      for (const relationship of [...activeRelationships, ...disabledRelationships]) {
        const custody = pendingFences.get(relationship.relationshipId);
        if (!custody) continue;
        stagedPrevious.set(relationship.relationshipId, {
          definition: this.definitions.get(relationship.relationshipId),
          custody: this.fences.get(relationship.relationshipId),
          ingress: new Set(this.activeIngress.get(relationship.relationshipId) ?? []),
        });
        this.definitions.set(relationship.relationshipId, relationship);
        this.fences.set(relationship.relationshipId, custody);
      }
      const rollbackStaged = async (): Promise<void> => {
        for (const [id, previous] of stagedPrevious) {
          for (const entry of this.activeIngress.get(id) ?? []) {
            if (!previous.ingress.has(entry)) entry.stream.destroy();
          }
          if (previous.definition) this.definitions.set(id, previous.definition);
          else this.definitions.delete(id);
          if (previous.custody) this.fences.set(id, previous.custody);
          else this.fences.delete(id);
        }
        const cleanup = await Promise.allSettled([
          this.releaseRootHandles([...pendingFences.values()].flatMap((custody) => custody.ownedHandles)),
          ...[...pendingFences.keys()].map(async (id) => await this.releaseSharedHubParticipation(id)),
        ]);
        const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Workspace sync staged custody cleanup failed');
      };
      let existing: Map<string, WorkspaceSyncStatusV1>;
      const holdPausedRelationshipIds = new Set<string>();
      const recoveryHoldCodes = new Map<string, string>();
      try {
        await this.lifecycle.start();
        const recoveries = new Map([...this.copyOperations.values()].map((operation) => [operation.operationId, operation]));
        for (const recovery of await this.adapter.discoverCopyOnceRecoveries()) recoveries.set(recovery.operationId, recovery);
        for (const recovery of recoveries.values()) await this.recoverCopyOnce(recovery);
        for (const relationship of activeRelationships) {
          try {
            await this.recoverConflictResolutionForRelationship(relationship);
          } catch (error) {
            const code = readErrorCode(error);
            if (code !== 'workspace_sync_recovery_needed' && code !== 'peer_unavailable'
              && code !== 'agent_unavailable' && code !== 'relationship_not_ready'
              && code !== 'workspace_root_unsafe' && code !== 'workspace_root_ownership_lost'
              && code !== 'workspace_root_in_use' && code !== 'approval_stale'
              && code !== 'conflict_changed') throw error;
            holdPausedRelationshipIds.add(relationship.relationshipId);
            recoveryHoldCodes.set(relationship.relationshipId, code ?? 'workspace_sync_recovery_needed');
          }
        }
        existing = new Map((await this.adapter.rehydrate([...desired.values()], undefined, holdPausedRelationshipIds))
          .map((item) => [item.relationshipId, item]));
      } catch (error) {
        await rollbackStaged();
        throw error;
      }
      await this.releaseRootHandles(
        [...stagedPrevious.values()].flatMap((previous) => previous.custody?.ownedHandles ?? []),
      );
      for (const relationship of disabledRelationships) {
        await this.closeActiveIngress(relationship.relationshipId);
        await this.releaseRelationshipOwnership(relationship.relationshipId);
        this.ownershipLost.delete(relationship.relationshipId);
        this.definitions.set(relationship.relationshipId, relationship);
        this.transientDefinitions.delete(relationship.relationshipId);
      }
      for (const [id, current] of this.definitions) {
        const next = desired.get(id);
        if (next && areWorkspaceSyncRelationshipDefinitionsEqual(next, current)) continue;
        await this.closeActiveIngress(id);
        await this.releaseRelationshipOwnership(id);
        this.definitions.delete(id);
        this.transientDefinitions.delete(id);
        this.statuses.delete(id);
        this.reconcileStatusObservation(id);
      }
      const statuses: WorkspaceSyncStatusV1[] = [];
      for (const relationship of activeRelationships) {
        const adopted = existing.get(relationship.relationshipId);
        const recoveringOwnership = this.ownershipLost.has(relationship.relationshipId);
        if (!this.definitions.has(relationship.relationshipId) || recoveringOwnership) {
          const custody = pendingFences.get(relationship.relationshipId) ?? { handles: [], ownedHandles: [] };
          this.definitions.set(relationship.relationshipId, relationship);
          this.transientDefinitions.delete(relationship.relationshipId);
          this.fences.set(relationship.relationshipId, custody);
        }
        try {
          await this.assertRelationshipOwnershipCurrent(relationship.relationshipId);
          if (holdPausedRelationshipIds.has(relationship.relationshipId)) {
            const [alpha, beta] = await Promise.all([
              this.resolveRef(relationship.alphaWorkspaceRefId),
              this.resolveRef(relationship.betaWorkspaceRefId),
            ]);
            statuses.push(this.publish({ ...(adopted ?? {
              relationshipId: relationship.relationshipId,
              controllerMachineId: relationship.controllerMachineId,
              state: 'paused',
              alphaPath: alpha?.rootPath ?? relationship.alphaWorkspaceRefId,
              betaPath: beta?.rootPath ?? relationship.betaWorkspaceRefId,
              mode: relationship.mode,
              endpointStates: { alpha: null, beta: null },
              conflictCount: 0,
              lastCycleObservedAtMs: null,
            }), errorCode: recoveryHoldCodes.get(relationship.relationshipId) ?? 'workspace_sync_recovery_needed' }));
            continue;
          }
          const status = recoveringOwnership
            ? await this.adapter.ensure(relationship, undefined)
            : adopted ?? await this.adapter.ensure(relationship, undefined);
          this.definitions.set(relationship.relationshipId, relationship);
          if (recoveringOwnership) this.ownershipLost.delete(relationship.relationshipId);
          statuses.push(this.publish(status));
        } catch (error) {
          if (pendingFences.has(relationship.relationshipId)) {
            await this.releaseRelationshipOwnership(relationship.relationshipId);
            this.definitions.delete(relationship.relationshipId);
          }
          throw error;
        }
      }
      for (const relationship of disabledRelationships) {
        const adopted = existing.get(relationship.relationshipId);
        if (adopted) {
          statuses.push(this.publish({ ...adopted, state: 'paused' }));
          continue;
        }
        const [alpha, beta] = await Promise.all([
          this.resolveRef(relationship.alphaWorkspaceRefId),
          this.resolveRef(relationship.betaWorkspaceRefId),
        ]);
        statuses.push(this.publish({
          relationshipId: relationship.relationshipId,
          controllerMachineId: relationship.controllerMachineId,
          state: 'paused',
          alphaPath: alpha?.rootPath ?? relationship.alphaWorkspaceRefId,
          betaPath: beta?.rootPath ?? relationship.betaWorkspaceRefId,
          mode: relationship.mode,
          endpointStates: { alpha: null, beta: null },
          conflictCount: 0,
          lastCycleObservedAtMs: null,
        }));
      }
      if (gitUnavailable) {
        for (const relationship of gitRelationships) {
          const [alpha, beta] = await Promise.all([
            this.resolveRef(relationship.alphaWorkspaceRefId),
            this.resolveRef(relationship.betaWorkspaceRefId),
          ]);
          statuses.push(this.publish({
            relationshipId: relationship.relationshipId,
            controllerMachineId: relationship.controllerMachineId,
            state: 'error',
            alphaPath: alpha?.rootPath ?? relationship.alphaWorkspaceRefId,
            betaPath: beta?.rootPath ?? relationship.betaWorkspaceRefId,
            mode: relationship.mode,
            endpointStates: { alpha: null, beta: null },
            conflictCount: 0,
            lastCycleObservedAtMs: null,
            errorCode: 'git_selection_unavailable',
          }));
        }
      }
      if (rejectUnavailableGit) {
        throw Object.assign(new Error('Git is unavailable for the git_worktree workspace sync selection'), { code: 'git_selection_unavailable' });
      }
      return statuses;
    });
  }
  async openExternalStream(input: Readonly<{ endpointId: string; signal?: AbortSignal }>): Promise<Duplex> {
    this.assertStateAvailable();
    if (this.shuttingDown) {
      throw Object.assign(new Error('Workspace sync endpoint is not owned'), { code: 'relationship_not_owned' });
    }
    const candidates = [...this.definitions.values(), ...this.copyOperations.values()];
    const match = candidates.flatMap((operation) => {
      const operationId = 'relationshipId' in operation ? operation.relationshipId : operation.operationId;
      return (['alpha', 'beta'] as const).map((role) => ({ operation, operationId, role }));
    }).find(({ operationId, role }) => deriveWorkspaceSyncEndpointId(operationId, role) === input.endpointId);
    if (!match) throw Object.assign(new Error('Workspace sync endpoint is not owned'), { code: 'relationship_not_owned' });
    const { operation, operationId, role } = match;
    if (this.ownershipLost.has(operationId)) {
      throw Object.assign(new Error('Workspace root ownership was lost'), { code: 'workspace_root_ownership_lost' });
    }
    if (operation.controllerMachineId !== this.localMachineId) {
      throw Object.assign(new Error('Workspace sync controller machine is unavailable'), { code: 'controller_unavailable' });
    }
    const [alpha, beta] = await Promise.all([
      this.resolveRef(operation.alphaWorkspaceRefId, 'operationId' in operation ? operationId : undefined),
      this.resolveRef(operation.betaWorkspaceRefId, 'operationId' in operation ? operationId : undefined),
    ]);
    if (!alpha || !beta) throw Object.assign(new Error('Workspace sync endpoint is unavailable'), { code: 'peer_unavailable' });
    const endpoint = role === 'alpha' ? alpha : beta;
    const counterpart = role === 'alpha' ? beta : alpha;
    const endpointRefId = role === 'alpha' ? operation.alphaWorkspaceRefId : operation.betaWorkspaceRefId;
    const retainIfStillOwned = async (owned: WorkspaceSyncOwnedLocalAgent): Promise<Duplex> => {
      const current = 'relationshipId' in operation
        ? this.definitions.get(operationId)
        : this.copyOperations.get(operationId);
      if (!this.shuttingDown && current === operation && !this.ownershipLost.has(operationId)) {
        return this.trackOwnedIngress(operationId, owned);
      }
      owned.stream.destroy();
      await owned.stop();
      const ownershipLost = this.ownershipLost.has(operationId);
      throw Object.assign(
        new Error(ownershipLost ? 'Workspace root ownership was lost' : 'Workspace sync endpoint is not owned'),
        { code: ownershipLost ? 'workspace_root_ownership_lost' : 'relationship_not_owned' },
      );
    };
    if (endpoint.machineId === this.localMachineId) {
      if (!this.openLocalAgent) throw Object.assign(new Error('Verified local workspace agent is unavailable'), { code: 'agent_unavailable' });
      const canonicalRoot = await realpath(endpoint.rootPath).catch(() => {
        throw Object.assign(new Error('Workspace sync endpoint root is unavailable'), { code: 'root_mismatch' });
      });
      const handles = 'relationshipId' in operation
        ? this.fences.get(operationId)?.handles ?? []
        : this.copyFences.get(operationId) ?? [];
      const ownedRoot = handles.find((handle) => (
        getPathRemainderWithinBase(handle.owner.canonicalRoot, canonicalRoot) === ''
        && getPathRemainderWithinBase(canonicalRoot, handle.owner.canonicalRoot) === ''
      ));
      if (!ownedRoot) {
        throw Object.assign(new Error('Workspace sync endpoint root is not fenced'), { code: 'root_changed' });
      }
      if ('relationshipId' in operation) {
        await this.assertRelationshipOwnershipCurrent(operationId);
      } else {
        try {
          await ownedRoot.bindCurrentRootIdentity();
        } catch {
          throw Object.assign(new Error('Workspace sync endpoint root changed after admission'), { code: 'root_changed' });
        }
      }
      return await retainIfStillOwned(await this.openLocalAgent({ operationId, role, workspaceRefId: endpointRefId, canonicalRoot, ...(input.signal ? { signal: input.signal } : {}) }));
    }
    if (!this.openMachineCarrier) throw machineCarrierUnavailableError();
    const tunnel = await this.openMachineCarrier({
      operationId,
      sourceMachineId: counterpart.machineId,
      targetMachineId: endpoint.machineId,
      flow: 'workspace_sync',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const ownedTunnel = await connectWorkspaceSyncMachineTunnel(tunnel, input.signal);
    return await retainIfStillOwned({ stream: ownedTunnel.stream, stop: ownedTunnel.stop });
  }
  subscribe(id: string, signal: AbortSignal): AsyncIterable<WorkspaceSyncStatusV1> {
    const self = this;
    return { async *[Symbol.asyncIterator]() {
      const queue: WorkspaceSyncStatusV1[] = [];
      let wake: (() => void) | null = null;
      const listener = (status: WorkspaceSyncStatusV1) => { queue.push(status); wake?.(); };
      const wakeOnAbort = () => wake?.();
      const listeners = self.listeners.get(id) ?? new Set();
      listeners.add(listener);
      self.listeners.set(id, listeners);
      self.reconcileStatusObservation(id);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        signal.removeEventListener('abort', abortAndWake);
        listeners.delete(listener);
        if (listeners.size === 0) self.listeners.delete(id);
        self.reconcileStatusObservation(id);
      };
      const abortAndWake = () => {
        cleanup();
        wakeOnAbort();
      };
      signal.addEventListener('abort', abortAndWake);
      try {
        while (!signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (signal.aborted) resolve();
            });
            wake = null;
          }
          if (!signal.aborted && queue.length) yield queue.shift()!;
        }
      } finally {
        signal.removeEventListener('abort', abortAndWake);
        cleanup();
      }
    } };
  }
}
