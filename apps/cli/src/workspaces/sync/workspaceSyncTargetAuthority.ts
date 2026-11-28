import { areWorkspaceSyncRelationshipDefinitionsEqual, deriveWorkspaceSyncConflictOperationId, HandoffTargetReplacementPreflightResultV1Schema, HandoffTargetReplacementPreflightV1Schema, ReadWorkspaceSyncFileResultV1Schema, WorkspaceSyncEntryExpectationV1Schema, WorkspaceSyncTargetEntryObserveV1Schema, WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseResultV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema, WorkspaceSyncTargetConflictStageV1Schema, WorkspaceSyncConflictCaptureReleaseV1Schema, WorkspaceSyncTargetConflictApplyV1Schema, WorkspaceSyncTargetConflictApplyResultV1Schema, WorkspaceSyncTargetConflictRecoverV1Schema, WorkspaceSyncTargetConflictRecoverResultV1Schema, WorkspaceSyncTargetFileReadV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { deriveWorkspaceSyncTopology, resolveWorkspaceSyncExecutionMachineIdV1, resolveWorkspaceSyncEndpoint, resolveWorkspaceSyncRelationshipEndpointRoles, resolveWorkspaceSyncRelationshipTransferDirection } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { areWorkspaceSyncWorkerCopyProvenancesEqual, getWorkspaceSyncWorkerCopyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeWorkspaceRootPathV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { isWorkspaceSyncLocalNamespace, type WorkspaceSyncLocalManagedTarget } from './workspaceSyncExecutionNamespace';
export { isWorkspaceSyncLocalNamespace, type WorkspaceSyncLocalManagedTarget } from './workspaceSyncExecutionNamespace';
import { isManagedWorkspaceRefV2, type ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceSyncChildMachineFacts } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { readWorkspaceSyncSourceAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { isProjectWorkspaceSyncOpenActionV1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { isWorkspaceSyncRelationshipWriteActionId } from '@happier-dev/protocol/actions/actionIds';
import { resolveWorkspaceWriteActionAdmissionV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveWorkspaceReplicationSourceInputsWithScmWorkspace } from '@/scm/workspace/workspaceTransferResolution';
import { projectWorkspaceSyncWriterTargetContext, resolveWorkspaceSyncSeedTransfer } from './workspaceSyncSeedTransfer';
import { realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { openManagedMachineRead, readManagedMachineFull, readManagedMachineReads } from '@/machines/managed/readManagedMachine';
import { unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { isManagedDevcontainerChildProjectionCurrentV1, deriveManagedDevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { SocketRpcMachineAdmissionContextV1 } from '@happier-dev/protocol/socketRpc';
import { isDeepStrictEqual } from 'node:util';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { randomUUID } from 'node:crypto';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { HandoffTargetReplacementApprovalV1Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffTargetReplacementApprovalV1';
import { WorkspaceSyncCommittedCopyTargetV1Schema, WorkspaceSyncCommittedCopyTargetResultV1Schema,
  doesWorkspaceSyncCopyRetirementRequestMatchV1,
  WorkspaceSyncCommittedCopyPreviewV1Schema, WorkspaceSyncCommittedCopyPreviewResultV1Schema,
  type WorkspaceSyncCommittedCopyPreviewV1, type WorkspaceSyncCommittedCopyPreviewResultV1,
  type WorkspaceSyncCommittedCopyTargetV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import type { ProjectWorkerCopyRetireInputV1 } from '@happier-dev/protocol';
import type { ProjectWorkerDependencyV1, ProjectWorkerDependencyQueryV1 } from '@happier-dev/protocol/workspaces/projectWorkerExecutionV1';
import type { ReadWorkspaceSyncFileResultV1, WorkspaceSyncEntryExpectationV1, WorkspaceSyncTargetEntryObserveV1, WorkspaceSyncConflictResolveActionInputV1, HandoffTargetReplacementPreflightResultV1, HandoffTargetReplacementPreflightV1, WorkspaceContentPolicyV1, WorkspaceRefV1, WorkspaceSyncCopyOnceV1, WorkspaceSyncRelationshipV1, WorkspaceSyncTargetBootstrapPrepareResultV1, WorkspaceSyncTargetBootstrapPrepareV1, WorkspaceSyncTargetBootstrapReleaseResultV1, WorkspaceSyncTargetBootstrapReleaseV1, WorkspaceSyncTargetConflictStageV1, WorkspaceSyncConflictCaptureReleaseV1, WorkspaceSyncTargetConflictApplyV1, WorkspaceSyncTargetConflictApplyResultV1, WorkspaceSyncTargetConflictRecoverV1, WorkspaceSyncTargetConflictRecoverResultV1, WorkspaceSyncTargetFileReadV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceWriterTargetRoutingV1Schema,
  isSignedWorkspaceSyncHandoffReleaseV1,
  type WorkspaceSyncTargetRoutingV1, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';
import { prepareProjectCheckoutRemoval, requireProjectCheckoutRemovalOperation } from '@/workspaces/projectSetup/projectCheckoutRemoval';
import { buildActionExecutorContextForRpc, projectWorkspaceSyncPhysicalContextFromActionContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { lstat, readdir, realpath, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

import {
  getActiveProjectAccountRowsSnapshot,
  type ActiveProjectAccountRowsSnapshot,
} from '@/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { applyCapturedWorkspaceSyncEntryAtRoot, captureWorkspaceSyncEntryAtRoot, recoverWorkspaceSyncEntryReplacementAtRoot } from './workspaceSyncConflicts';
import { discoverNativeConfinedWorkspaceSyncRecovery } from './workspaceSyncNativeConfinedFileSystem';
import { createWorkspaceSyncEntryExport, stageWorkspaceSyncEntryExport } from './workspaceSyncEntryTransfer';
import { ensureProtectedLocalStateDirectory } from '@/utils/fs/protectedLocalState';
import { observeWorkspaceSyncEntryAtRoot, readWorkspaceSyncFileAtRoot } from './workspaceSyncFileRead';
import type { WorkspaceSyncOwnedLocalAgent, WorkspaceSyncTargetEntryObserve, WorkspaceSyncLocalAgentStreamOpen } from './workspaceSyncController';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import { computeWorkspaceSyncAbsentRootFingerprint } from './workspaceSyncRootIdentity';
import {
  computeWorkspaceSyncRootFingerprint,
  rehydrateWorkspaceSyncTargetBootstrap,
  workspaceSyncTargetBootstrap,
  inspectWorkspaceSyncCommittedCopy,
  removeWorkspaceSyncCommittedCopy,
  readWorkspaceSyncFinalReadyFact,
  type WorkspaceSyncTargetBootstrapDependencies,
  type WorkspaceSyncTargetBootstrapInput,
} from './workspaceSyncTargetBootstrap';
import type { WorkspaceSyncRequesterCopyCustody } from './workspaceSyncFinalReadyFact';
import type { WorkspaceRootOwnershipHandle, WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import type { WorkspaceSyncSourceRootLoan } from './workspaceSyncTypes';
import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { DirectPeerOnDemandTransferScope } from '@/machines/transfer/directPeerTransport';
import type { TransferPayloadSource } from '@/machines/transfer/transferPayloadSource';
import { prepareExistingGitWorkspaceSyncTarget } from './workspaceSyncTargetBootstrap';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';
import type {
  WorkspaceExportMaterializationCustody,
  WorkspaceTargetMaterializationFence,
  WorkspaceTargetMaterializationWorkerCopyCreation,
} from '@/scm/workspace/workspaceExportMaterialization';
import { openWorkspaceSyncMachineIngress, type WorkspaceSyncMachineIngress } from './workspaceSyncMachineIngress';
export type { WorkspaceSyncMachineIngress } from './workspaceSyncMachineIngress';

export type WorkspaceSyncTargetFileReadRequest = Readonly<{
  relationshipId: string;
  targetMachineId: string;
  targetWorkspaceRefId: string;
  path: string;
  expectedDigest?: string;
  maxBytes: number;
  signal?: AbortSignal;
  /** The reading ingress; an installed writer reaches another Account's TARGET only through it. */
  context?: RpcHandlerContext;
}>;

export type WorkspaceSyncTargetBootstrapPrepareRequest = Readonly<
  WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ targetMachineId: string; signal?: AbortSignal;
    /** Original admitted namespace for the first-hop authorization; never serialized as a new grant. */
    admittedTarget?: Readonly<{ machineId: string; rootPath: string; targetManaged?: WorkspaceSyncLocalManagedTarget }> }>
>;
export type WorkspaceSyncTargetBootstrapReleaseRequest = Readonly<
  WorkspaceSyncTargetBootstrapReleaseV1 & Readonly<{ targetMachineId: string; signal?: AbortSignal;
    admittedTarget?: Readonly<{ machineId: string; rootPath: string; targetManaged?: WorkspaceSyncLocalManagedTarget }>;
    physicalEndpoint?: MachineInstallationPublicIdentityV1 }>
>;
/** Existing target RPCs sent by the actually admitted child socket, never the source custodian. */
export type WorkspaceSyncTargetPhaseDescriptor = Readonly<{
  machineId: string;
  method: typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ
    | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE
    | typeof RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES;
  request: unknown;
  routing: Omit<WorkspaceSyncTargetRoutingV1, 'targetContext'>;
  /** Exact public managed controller or Home-witnessed recipient; never a Machine access grant. */
  physicalEndpoint?: MachineInstallationPublicIdentityV1;
  /** Current reviewed retirement continuation; never inherited from the native create. */
  callerInputAuthorization?: RpcHandlerContext['callerInputAuthorization'];
  /** Live containing operation ports; transported only by the private request continuation. */
  operationContext?: RpcHandlerContext['localActionContext'];
  retainedCheckoutTeardown?: RpcHandlerContext['retainedCheckoutTeardown'];
  signal?: AbortSignal;
}>;
/** Host-admitted personal retirement; approval and foreign requester ingress stay at their owners. */
export type WorkspaceSyncCommittedCopyRequest = WorkspaceSyncCommittedCopyTargetV1 & Readonly<{ signal?: AbortSignal }>;
export type WorkspaceSyncCommittedCopyPreviewRequest = WorkspaceSyncCommittedCopyPreviewV1 & Readonly<{ signal?: AbortSignal }>;
export type WorkspaceSyncTargetBootstrapAtTargetResult = WorkspaceSyncTargetBootstrapPrepareResultV1 & Readonly<{
  /**
   * Owner-local custody borrowed by the controller. This is never serialized
   * across the machine RPC boundary; release remains owned by this authority.
   */
  ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
}>;

export type WorkspaceSyncMachineAgentDescriptor = Readonly<{
  operationId: string;
  role: 'alpha' | 'beta';
  workspaceRefId: string;
  canonicalRoot: string;
}>;

export type AcquireWorkspaceSyncMachineIngressRequest = Readonly<{
  /** Home-verified native carrier actor; retained target authority owns admission. */
  actorAccountId?: string;
  operationId: string;
  sourceMachineId: string;
  targetMachineId: string;
  /** Existing signed grant/operation deadline for the one native attach. */
  expiresAtMs?: number;
  signal?: AbortSignal;
}>;

/**
 * Local bootstrap resources supplied by the daemon composition root. The
 * staging directory and root-ownership manager are daemon-owned; the receiving
 * authority never accepts them over the wire.
 */
export type WorkspaceSyncTargetBootstrapAuthorityDependencies = Readonly<{
  materializationDirectory: string;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  /** Filesystem-boundary injection for testing final READY publication failure. */
  writeReadyFact?: WorkspaceSyncTargetBootstrapDependencies['writeReadyFact'];
  /** Filesystem-boundary injection for restart receipt rehydration and cleanup failure tests. */
  rehydrateMaterializationFromReceiptPath?: NonNullable<WorkspaceSyncTargetBootstrapDependencies['rehydrateMaterializationFromReceiptPath']>;
  /** Canonical SCM owner for verifying/materializing the selected Git target. */
  prepareGitTarget?: WorkspaceSyncTargetBootstrapInput['prepareGitTarget'];
  materializeRemoteSeed?: (input: Readonly<{
    operationId: string;
    sourceMachineId: string;
    sourceWorkspaceRefId: string;
    managedSourceOnController?: true;
    canonicalRoot: string;
    /** Complete bounded selection policy: a seed that drops it loses explicitly included ignored paths. */
    contentPolicy: WorkspaceContentPolicyV1;
    exclusionCandidates?: readonly string[];
    materializationReceiptPath: string;
    originalTargetExists: boolean;
    targetFence: WorkspaceTargetMaterializationFence;
    /** Actual prepare invocation; never serialized or retained globally. */
    context?: RpcHandlerContext;
    signal?: AbortSignal;
  }>) => Promise<WorkspaceExportMaterializationCustody & Readonly<{ manifest?: WorkspaceManifest; excludedPaths?: readonly string[] }>>;
  materializeLocalSeed?: (input: Readonly<{
    operationId: string;
    sourcePath: string;
    canonicalRoot: string;
    contentPolicy: WorkspaceContentPolicyV1;
    exclusionCandidates?: readonly string[];
    materializationReceiptPath: string;
    originalTargetExists: boolean;
    targetFence: WorkspaceTargetMaterializationFence;
  }>) => Promise<WorkspaceExportMaterializationCustody & Readonly<{ manifest?: WorkspaceManifest; excludedPaths?: readonly string[] }>>;
}>;

export type WorkspaceSyncTargetAuthority = Readonly<{
  activity: LiveWorkProducerV1;
  /** Exact continuation of a signed native target loan; no new admission. */
  hasRetainedRecoveryAdmission(input: Readonly<{
    request: WorkspaceSyncTargetConflictRecoverV1;
    accountServerId: string;
    actorAccountId: string;
    receivingMachine: Readonly<{ machineId: string; installationId: string }>;
  }>): boolean;
  /** Host-admitted personal read; public ingress must validate current receiving authority. */
  previewCommittedCopyHere(request: WorkspaceSyncCommittedCopyPreviewRequest, context?: RpcHandlerContext): Promise<WorkspaceSyncCommittedCopyPreviewResultV1>;
  previewCommittedCopyAtTarget(request: WorkspaceSyncCommittedCopyPreviewRequest, context?: RpcHandlerContext,
    snapshot?: ActiveProjectAccountRowsSnapshot): Promise<WorkspaceSyncCommittedCopyPreviewResultV1>;
  inspectCommittedCopyHere(request: WorkspaceSyncCommittedCopyRequest, context?: RpcHandlerContext): Promise<void>;
  removeCommittedCopyHere(request: WorkspaceSyncCommittedCopyRequest, context?: RpcHandlerContext): Promise<void>;
  assertRetainedCopyDependencyAdmission(request: ProjectWorkerDependencyQueryV1, context: RpcHandlerContext): Promise<void>;
  /** Installed SOURCE writer's dependency read of its retained TARGET endpoint; null when this daemon is not that writer. */
  readDependenciesAsInstalledWriter(request: ProjectWorkerDependencyQueryV1, context?: RpcHandlerContext, signal?: AbortSignal): Promise<unknown> | null;
  inspectCommittedCopyAtTarget(request: WorkspaceSyncCommittedCopyRequest, context?: RpcHandlerContext): Promise<void>;
  removeCommittedCopyAtTarget(request: WorkspaceSyncCommittedCopyRequest, context?: RpcHandlerContext): Promise<void>;
  /** Owner-local: lend retained spoke custody for a finite source read. */
  borrowSourceRootForCopy(request: Readonly<{ operationId: string; workspaceRefId: string }>): Promise<WorkspaceSyncSourceRootLoan | null>;
  preflightHandoffTargetReplacementHere(request: HandoffTargetReplacementPreflightV1, signal?: AbortSignal, context?: RpcHandlerContext): Promise<HandoffTargetReplacementPreflightResultV1>;
  preflightHandoffTargetReplacementAtTarget(request: HandoffTargetReplacementPreflightV1 & Readonly<{ signal?: AbortSignal; targetManaged?: WorkspaceSyncLocalManagedTarget }>, context?: RpcHandlerContext): Promise<HandoffTargetReplacementPreflightResultV1>;
  stageConflictResolutionHere(request: WorkspaceSyncTargetConflictStageV1, signal?: AbortSignal): Promise<void>;
  applyStagedConflictResolutionHere(request: WorkspaceSyncTargetConflictApplyV1, signal?: AbortSignal): Promise<WorkspaceSyncTargetConflictApplyResultV1>;
  discardStagedConflictResolutionHere(request: WorkspaceSyncTargetConflictApplyV1, signal?: AbortSignal): Promise<void>;
  recoverConflictResolutionHere(request: WorkspaceSyncTargetConflictRecoverV1, signal?: AbortSignal,
    context?: WorkspaceSyncConflictRecoveryContext): Promise<WorkspaceSyncTargetConflictRecoverResultV1>;
  recoverConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictRecoverV1 & Readonly<{ signal?: AbortSignal }>): Promise<WorkspaceSyncTargetConflictRecoverResultV1>;
  /** The same-binary worker receives only the carrier's admitted Inspect mode. */
  readFileHere(request: WorkspaceSyncTargetFileReadV1, signal?: AbortSignal, context?: RpcHandlerContext,
    admittedWriterRead?: true): Promise<ReadWorkspaceSyncFileResultV1>;
  observeEntryHere(request: WorkspaceSyncTargetEntryObserveV1, signal?: AbortSignal, context?: RpcHandlerContext,
    admittedWriterRead?: true): Promise<WorkspaceSyncEntryExpectationV1>;
  stageConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictStageV1 & Readonly<{ signal?: AbortSignal }>): Promise<void>;
  applyStagedConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictApplyV1 & Readonly<{ signal?: AbortSignal }>): Promise<WorkspaceSyncTargetConflictApplyResultV1>;
  discardStagedConflictResolutionAtTarget(request: WorkspaceSyncTargetConflictApplyV1 & Readonly<{ signal?: AbortSignal }>): Promise<void>;
  releaseConflictResolutionCaptureHere(request: WorkspaceSyncConflictCaptureReleaseV1): Promise<void>;
  releaseConflictResolutionCaptureAtSource(request: WorkspaceSyncConflictCaptureReleaseV1): Promise<void>;
  readFileAtTarget(request: WorkspaceSyncTargetFileReadRequest): Promise<ReadWorkspaceSyncFileResultV1>;
  observeEntryAtTarget: WorkspaceSyncTargetEntryObserve;
  prepareBootstrapHere(request: WorkspaceSyncTargetBootstrapPrepareV1, signal?: AbortSignal, context?: RpcHandlerContext, admitted?: WorkspaceSyncNativeBootstrapAdmission): Promise<WorkspaceSyncTargetBootstrapPrepareResultV1>;
  /** Owner-local consumption of a completed preparation; never a wire RPC. */
  getPreparedBootstrapOwnership(request: Readonly<{ bootstrapOperationId: string; targetWorkspaceRefId: string }>): Promise<WorkspaceRootOwnershipHandle>;
  releaseBootstrapHere(request: WorkspaceSyncTargetBootstrapReleaseV1, signal?: AbortSignal, context?: RpcHandlerContext, admitted?: WorkspaceSyncNativeBootstrapAdmission): Promise<WorkspaceSyncTargetBootstrapReleaseResultV1>;
  prepareBootstrapAtTarget(request: WorkspaceSyncTargetBootstrapPrepareRequest, context?: RpcHandlerContext): Promise<WorkspaceSyncTargetBootstrapAtTargetResult>;
  releaseBootstrapAtTarget(request: WorkspaceSyncTargetBootstrapReleaseRequest, context?: RpcHandlerContext): Promise<WorkspaceSyncTargetBootstrapReleaseResultV1>;
  /** Owner-local admission for a provider stream; never opens a guest TCP listener. */
  authorizeWorkspaceSyncMachineAgent(request: AcquireWorkspaceSyncMachineIngressRequest): Promise<WorkspaceSyncMachineAgentDescriptor>;
  acquireWorkspaceSyncMachineIngress(request: AcquireWorkspaceSyncMachineIngressRequest): Promise<WorkspaceSyncMachineIngress>;
  /** Owner-local controller endpoint whose root custody was already retained. Never a wire RPC. */
  openLocalWorkspaceAgentIngress(request: Parameters<WorkspaceSyncLocalAgentStreamOpen>[0]): Promise<WorkspaceSyncMachineIngress>;
  /** Owner-local, non-wire: release retained relationship fences the Project rows no longer own. */
  reconcileRetainedBootstraps(): Promise<void>;
  /** Owner-local disposal of one native execution, joining its carrier streams before root release. */
  releaseNativeTargetExecution(request: Readonly<{ target: ManagedWorkspaceRefV2 }>): Promise<void>;
  /** Owner-local, non-wire: release every retained handle on daemon shutdown. */
  releaseAllRetainedBootstraps(): Promise<void>;
  prepareSourceSeedExport(request: Readonly<{ operationId: string; sourceWorkspaceRefId: string; targetMachineId: string; contentPolicy: WorkspaceContentPolicyV1; exclusionCandidates?: readonly string[] }>): Promise<Readonly<{
    payloadSource: TransferPayloadSource;
    onDemandScope: DirectPeerOnDemandTransferScope;
  }>>;
  prepareConflictResolutionExport(request: WorkspaceSyncTargetConflictStageV1): ReturnType<typeof createWorkspaceSyncEntryExport>;
}>;

/** Same-binary native process port. Host admission contexts never cross this boundary. */
export type WorkspaceSyncNativeTargetExecution = Pick<WorkspaceSyncTargetAuthority,
  'prepareBootstrapHere' | 'releaseBootstrapHere' | 'getPreparedBootstrapOwnership'
  | 'preflightHandoffTargetReplacementHere' | 'reconcileRetainedBootstraps'
  | 'readFileHere' | 'observeEntryHere' | 'recoverConflictResolutionHere'
  | 'stageConflictResolutionHere' | 'applyStagedConflictResolutionHere' | 'discardStagedConflictResolutionHere'
  | 'releaseConflictResolutionCaptureHere' | 'borrowSourceRootForCopy' | 'authorizeWorkspaceSyncMachineAgent'
  | 'releaseAllRetainedBootstraps'> & Readonly<{
  replaceSnapshot(snapshot: ActiveProjectAccountRowsSnapshot | null): Promise<void>;
}>;

/** Owner-local projection of admission already checked by the carrier. No credentials cross this seam. */
export type WorkspaceSyncNativeBootstrapAdmission = Readonly<{
  targetRouting?: Omit<WorkspaceSyncTargetRoutingV1, 'phase'>;
  sourceWriterTargetRouting?: RetainedSourceWriterTargetRouting;
}>;

/** Existing controller-owned root loan; same-process callers may carry it across the native bridge. */
export type WorkspaceSyncLocalResolutionEndpoint = NonNullable<Awaited<ReturnType<NonNullable<
  WorkspaceSyncTargetAuthorityDependencies['resolveLocalResolutionEndpoint']
>>>>;

/** Host-only recovery custody; an explicit Account projection carries its controller's actual root loan. */
export type WorkspaceSyncConflictRecoveryContext = Readonly<{
  localResolutionEndpoint?: WorkspaceSyncLocalResolutionEndpoint | null;
  getProjectSnapshot?: never;
}> | Readonly<{
  localResolutionEndpoint: WorkspaceSyncLocalResolutionEndpoint;
  getProjectSnapshot(): ActiveProjectAccountRowsSnapshot | null;
}>;

export type WorkspaceSyncTargetAuthorityDependencies = Readonly<{
  /** Host-only placement adapter, called after canonical TARGET admission. */
  resolveNativeTargetExecution?(target: ManagedWorkspaceRefV2, context?: RpcHandlerContext): Promise<WorkspaceSyncNativeTargetExecution>;
  localServerId: string;
  localMachineId: string;
  /** Native process filesystem, distinct from its controller Machine filesystem. */
  localManagedTarget?: WorkspaceSyncLocalManagedTarget;
  /** Account whose installed or captured rows this authority owns. */
  localAccountId?: string;
  /** Captured native child owns this one admitted local endpoint. */
  localWorkspaceRefId?: string;
  scmRegistry?: ScmBackendRegistry;
  getProjectSnapshot?: (operationId?: string) => ActiveProjectAccountRowsSnapshot | null;
  /** Passive preview reads current Home rows, never the daemon's retained row cache. */
  refreshProjectSnapshot?(signal?: AbortSignal, context?: RpcHandlerContext): Promise<ActiveProjectAccountRowsSnapshot>;
  /** Current ordinary/managed/native facts, supplied by the real daemon composition. */
  readChildMachineFacts?(machineIds: readonly string[], signal?: AbortSignal, context?: RpcHandlerContext): Promise<readonly WorkspaceSyncChildMachineFacts[]>;
  /** Host-private installed-child sender. Context and callbacks are never wire input. */
  callWorkspaceTargetPhase?(descriptor: WorkspaceSyncTargetPhaseDescriptor, context: RpcHandlerContext): Promise<unknown>;
  assertConflictResolutionAuthorized?(
    actionReceiptId: string,
    actionInput: WorkspaceSyncConflictResolveActionInputV1,
  ): Promise<void>;
  assertTargetReplacementAuthorized?(
    actionReceiptId: string,
    actionInput: unknown,
    approval: import('@happier-dev/protocol').HandoffTargetReplacementApprovalV1,
  ): Promise<void>;
  assertCommittedCopyRemovalAuthorized?(actionReceiptId: string, actionInput: ProjectWorkerCopyRetireInputV1): Promise<void>;
  /** Installed Project owner; the current retirement keeps its original operation. */
  resolveProjectRuntime?(context: RpcHandlerContext): Promise<ProjectFiniteActionRuntime | null>;
  readCommittedCopyDependencies?(actionInput: ProjectWorkerCopyRetireInputV1): Promise<readonly ProjectWorkerDependencyV1[]>;
  callMachineRpc(input: Readonly<{
    machineId: string;
    method: string;
    request: unknown;
    /** The Account transport retains the original removal operation's live ports. */
    operationContext?: RpcHandlerContext['localActionContext'];
    signal?: AbortSignal;
  }>): Promise<unknown>;
  bootstrap?: WorkspaceSyncTargetBootstrapAuthorityDependencies;
  openRootedAgent?(input: Readonly<{
    operationId: string;
    role: 'alpha' | 'beta';
    workspaceRefId: string;
    canonicalRoot: string;
    signal?: AbortSignal;
  }>): Promise<WorkspaceSyncOwnedLocalAgent>;
  openNativeRootedAgent?(input: WorkspaceSyncMachineAgentDescriptor & Readonly<{
    target: ManagedWorkspaceRefV2;
    signal?: AbortSignal;
  }>): Promise<WorkspaceSyncOwnedLocalAgent>;
  prepareSourceSeedExport?: (input: Readonly<{
    operationId: string;
    sourceWorkspaceRefId: string;
    targetMachineId: string;
    contentPolicy: WorkspaceContentPolicyV1;
    exclusionCandidates?: readonly string[];
  }>) => Promise<Readonly<{ payloadSource: TransferPayloadSource; onDemandScope: DirectPeerOnDemandTransferScope }>>;
  resolutionMaterialDirectory?: string;
  resolveLocalResolutionEndpoint?: (relationshipId: string, workspaceRefId: string) => Promise<Readonly<{
    /** The actual retained controller definition; required for transient recovery. */
    relationship?: WorkspaceSyncRelationshipV1;
    canonicalRoot: string;
    assertCurrentAuthority(): Promise<void>;
  }> | null>;
  requestResolutionExport?: (request: WorkspaceSyncTargetConflictStageV1 & Readonly<{ signal?: AbortSignal }>) => Promise<Readonly<{
    requestPayload(request: Readonly<{ transferId: string; destinationPath: string; expectedSizeBytes?: number; expectedManifestHash?: string }>): Promise<void>;
    release(): Promise<void>;
  }>>;
  discoverConflictRecovery?: typeof discoverNativeConfinedWorkspaceSyncRecovery;
  recoverConflictEntry?: typeof recoverWorkspaceSyncEntryReplacementAtRoot;
}>;

/** One read of the admitted relation, shared by Sync preparation and final child Workspace acceptance. */
export async function readWorkspaceSyncChildMachineFacts(input: Readonly<{
  serverId: string;
  serverHttpBaseUrl: string;
  homeTarget?: ResolvedHomeTarget;
  /** Local profile selects credentials/state only; it is never the wire Home qualifier. */
  localProfileId?: string;
  credentials?: StoredCredentials;
  machineIds: readonly string[];
  /** Exact relationship being admitted, never inferred from a foreign Machine id. */
  relationshipId?: string;
  /** Namespace acceptance never borrows parent storage or requires parent reachability. */
  purpose?: 'physical_sync' | 'child_namespace' | 'admitted_mapping';
  /** Admitted physical receiving Machine for a forwarded reviewed child namespace read. */
  receivingMachineId?: string;
  signal?: AbortSignal;
  authorization?: ExternalActionExecutionAuthorizationV1;
  effectActionId?: string;
  externalAction?: NonNullable<Parameters<typeof callExactMachineRpc>[0]['externalAction']>;
  /** Receiving physical controller consumes its own row and a current Home-proven child, not foreign Machine metadata. */
  controllerOwnedChild?: Readonly<{ controllerMachineId: string; admission: SocketRpcMachineAdmissionContextV1;
    verifyCurrent(): Promise<boolean> }>;
}>): Promise<readonly WorkspaceSyncChildMachineFacts[]> {
  return await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
    const { ApiClient } = await import('@/api/api');
    if (!input.authorization && !input.credentials) throw endpointMachineUnavailable('Requester content custody is unavailable');
    // Native physical preparation holds the admitted requester's credentials.
    // Its unchanged original Action is not a generic requester HTTP grant.
    const api = !input.authorization || input.purpose === 'physical_sync' ? await ApiClient.create(input.credentials!) : null;
    const readMachine = (machineId: string) => api
      ? api.getMachine(machineId, { signal: input.signal })
      : ApiClient.getRequesterMachine(machineId, { authorization: input.authorization!,
        effectActionId: input.effectActionId, signal: input.signal });
    // Observations use the requester's Machine read port. Physical effects
    // still consume the signed Sync SOURCE facts below.
    const effectActionId = input.authorization
      ? ActionIdSchema.safeParse(input.effectActionId ?? input.authorization.binding.actionId) : null;
    const readOnly = input.purpose !== 'physical_sync' && effectActionId?.success === true
      && getActionSpec(effectActionId.data).sideEffectClass === 'read';
    const facts: WorkspaceSyncChildMachineFacts[] = [];
    const owned = input.controllerOwnedChild;
    const ownerAccountId = input.credentials ? readAccountIdFromToken(input.credentials.token) : null;
    const useOwnedRow = owned !== undefined && ownerAccountId !== null && owned.admission.custodianAccountId !== ownerAccountId;
    const ownedRows = useOwnedRow ? await (async () => {
      if (!input.credentials || !await owned.verifyCurrent()) throw endpointMachineUnavailable('Current child admission is unavailable');
      const rows = await readManagedMachineReads({ credentials: input.credentials, serverHttpBaseUrl: input.serverHttpBaseUrl,
        homeId: input.serverId, enrolledMachineId: owned.admission.machineId, ...(input.signal ? { signal: input.signal } : {}) });
      return rows.map(read => ({ read, machine: unwrapManagedMachineReadV1(read) }))
        .filter(({ machine }) => machine.homeId === input.serverId && machine.custodianAccountId === ownerAccountId
          && machine.creationState === 'active' && machine.allocation === 'bound' && machine.archivedAt === undefined
          && machine.controller?.machineId === owned.controllerMachineId && machine.enrolledMachineId === owned.admission.machineId
          && machine.enrollmentAccountId === owned.admission.custodianAccountId);
    })() : [];
    if (useOwnedRow && ownedRows.length !== 1) throw endpointMachineUnavailable('Exact controller-owned enrollment is unavailable');
    // Start the endpoint reads together, but consume settled results in input
    // order so per-read admission and the existing refusal precedence remain.
    const reads = [...new Set(input.machineIds)].map(machineId => ({ machineId,
      result: (async () => {
        const sourceMachineId = input.authorization?.binding.workspaceSyncAdmission?.source.machineId;
        // A SOURCE-bound Move also reads its selected WORKER through the
        // requester's existing Machine read port. Only SOURCE facts come from
        // the signed Sync admission; mutating WORKER-bound roots still require
        // it for every foreign endpoint, including when the admission is missing.
        // Project Open binds its opening Machine and has no WORKER: every other
        // endpoint is its Source, so only the admission may name it.
        const localAdmittedMachineId = input.purpose === 'child_namespace' && input.receivingMachineId
          ? input.receivingMachineId : input.authorization?.binding.machineId;
        if (input.authorization && !readOnly && (machineId === sourceMachineId
          || machineId !== localAdmittedMachineId
            && (input.authorization.binding.machineId !== sourceMachineId
              || isProjectWorkspaceSyncOpenActionV1(input.authorization.binding.actionId)))) {
          const binding = input.authorization.binding;
          const admitted = input.relationshipId ? readWorkspaceSyncSourceAdmissionV1(binding,
            { serverId: input.serverId, machineId, relationshipId: input.relationshipId }) : null;
          if (!admitted) {
            throw authorityError('workspace_sync_source_admission_unavailable', 'The admitted Sync source facts are unavailable');
          }
          return { admitted };
        }
        const retainedManaged = useOwnedRow && machineId === owned.admission.machineId ? ownedRows[0] : undefined;
        const machine = retainedManaged ? null : await readMachine(machineId);
        return { machine, retainedManaged };
      })().then(value => ({ value }), (error: unknown) => ({ error })) }));
    for (const { machineId, result } of reads) {
      const settled = await result;
      if ('error' in settled) throw settled.error;
      if ('admitted' in settled.value) {
        const admitted = settled.value.admitted;
        if (admitted?.child) facts.push({ serverId: input.serverId, machineId,
          installationId: admitted.source.installationId, projection: admitted.child.projection,
          controller: { ...admitted.child.controller, available: true }, admittedRelationshipId: admitted.relationshipId });
        continue;
      }
      const { machine, retainedManaged } = settled.value;
      if (!retainedManaged && (!machine || machine.revokedAt != null || machine.replacedByMachineId)) {
        throw endpointMachineUnavailable('Current Machine is unavailable');
      }
      // The controller-owned list carries Home's exact recipient projection;
      // open that selected carrier before deriving the private child facts.
      let managedMachine: ManagedMachineV1 | undefined = retainedManaged ? await (async () => {
        if (!input.credentials) {
          throw endpointMachineUnavailable('Requester content custody is unavailable');
        }
        return await openManagedMachineRead({ credentials: input.credentials,
          serverHttpBaseUrl: input.serverHttpBaseUrl, read: retainedManaged.read, signal: input.signal });
      })() : undefined;
      const projection = managedMachine ? deriveManagedDevcontainerChildProjectionV1({ managedMachineId: managedMachine.id,
        controllerMachineId: managedMachine.controller?.machineId, enrolledMachineId: managedMachine.enrolledMachineId,
        resource: managedMachine.resource }) : machine?.metadata?.devcontainerChild;
      if (!projection) continue;
      const installationId = retainedManaged ? owned!.admission.installationId : machine?.installationId;
      if (!installationId || !retainedManaged && machine?.metadata?.username !== projection.observation.user) {
        throw endpointMachineUnavailable('Child installation or native user is unavailable');
      }
      // Devcontainer projection validation consumes the private resource
      // snapshot. The public GET/LIST union is deliberately structural, so
      // this path must use the already captured Account custody to open it.
      if (!input.credentials) {
        throw endpointMachineUnavailable('Requester content custody is unavailable');
      }
      if (!managedMachine) {
        managedMachine = await readManagedMachineFull({ credentials: input.credentials,
          serverHttpBaseUrl: input.serverHttpBaseUrl, homeId: input.serverId,
          managedId: projection.relation.managedMachineId, signal: input.signal,
          ...(input.authorization ? { authorization: input.authorization, effectActionId: input.effectActionId } : {}) });
      }
      if (input.purpose !== 'child_namespace' && !isManagedDevcontainerChildProjectionCurrentV1({ homeId: input.serverId, machineId,
        projection, managedMachine })) {
        throw endpointMachineUnavailable('Child enrollment is no longer current');
      }
      const nativeController = managedMachine.controller;
      if (!nativeController) throw endpointMachineUnavailable('The physical child controller is unavailable');
      const controller: WorkspaceSyncChildMachineFacts['controller'] = { ...nativeController, available: false };
      if (retainedManaged && !await owned!.verifyCurrent()) throw endpointMachineUnavailable('Current child admission is unavailable');
      facts.push({ serverId: input.serverId, machineId, installationId,
        projection, managedMachine, controller });
    }
    return facts;
  });
}

/** This reader's own refusal: the generic code with the step that produced it (HANDOFF-SYNC-CHILD-1124). */
function endpointMachineUnavailable(message: string): Error {
  return Object.assign(authorityError('workspace_sync_child_unavailable', message), { failureCause: {
    phase: 'workspace_sync.endpoint_machine.read', errorClass: 'Error', errorCode: 'workspace_sync_child_unavailable', httpStatus: null,
  } satisfies ActionFailureCauseV1 });
}

function projectTargetQualificationUnavailable(phase: 'preflight' | 'prepare', message: string): Error {
  const code = 'workspace_sync_child_unavailable';
  return Object.assign(authorityError(code, message), { failureCause: {
    phase: `workspace_sync.target.${phase}.qualification`, errorClass: 'Error', errorCode: code, httpStatus: null,
  } satisfies ActionFailureCauseV1 });
}

function authorityError(code: string, message: string, workspaceSyncIngressRefusal?:
  | 'workspace_placement_mismatch' | 'endpoint_unavailable' | 'authority_closing'
  | 'ingress_active' | 'agent_aborted' | 'authorization_expired' | 'identity_incomplete'
  | 'target_machine_mismatch' | 'rehydration_actor_mismatch' | 'ready_target_missing'
  | 'ready_target_ambiguous' | 'retained_actor_mismatch' | 'target_ownership_ended'): Error {
  return Object.assign(new Error(message), { code,
    ...(workspaceSyncIngressRefusal ? { workspaceSyncIngressRefusal } : {}) });
}

function resolveOwnedWorkspace(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  relationshipId: string,
  workspaceRefId: string,
  serverId: string,
  requiredState: 'enabled' | 'any' = 'enabled',
): Readonly<{ relationship: WorkspaceSyncRelationshipV1; workspace: WorkspaceRefV1 }> {
  const relationships = snapshot?.relationships ?? [];
  const relationshipMatches = relationships.filter((candidate) => (
    candidate.relationshipId === relationshipId && (requiredState === 'any' || candidate.enabled)
  ));
  if (relationshipMatches.length !== 1) {
    throw authorityError('relationship_not_ready', 'Workspace sync relationship is not ready');
  }
  const relationship = relationshipMatches[0]!;
  if (
    relationship.alphaWorkspaceRefId !== workspaceRefId
    && relationship.betaWorkspaceRefId !== workspaceRefId
  ) {
    throw authorityError('relationship_not_ready', 'Workspace reference is not owned by the relationship');
  }
  return { relationship, workspace: resolveWorkspaceRef(snapshot, workspaceRefId, serverId) };
}

function assertTargetMachine(workspace: WorkspaceRefV1, targetMachineId: string): void {
  if (!targetMachineId.trim() || resolveWorkspaceSyncExecutionMachineIdV1(workspace) !== targetMachineId.trim()) {
    throw authorityError('peer_unavailable', 'Workspace sync target machine does not own the selected workspace', 'workspace_placement_mismatch');
  }
}

/**
 * A workspace may name this machine while belonging to another Personal Home.
 * Local target authority exists only for a workspace enrolled through this
 * daemon's current Home; transport reachability is a separate Lane 06 check.
 */
function assertLocalWorkspacePlacement(
  workspace: WorkspaceRefV1,
  localServerId: string,
  localMachineId: string,
  localManagedTarget?: WorkspaceSyncLocalManagedTarget,
): void {
  if (!isWorkspaceSyncLocalNamespace(workspace, localServerId, localMachineId, localManagedTarget)) {
    throw authorityError(
      'workspace_machine_not_enrolled',
      'Workspace sync target machine is not enrolled in this Home',
    );
  }
}

function assertOkResult(value: unknown): void {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== 1
    || (value as Readonly<Record<string, unknown>>).ok !== true
  ) {
    throw authorityError('indeterminate', 'Workspace sync target mutation returned an invalid result');
  }
}

function assertResultOk(value: unknown): asserts value is { ok: true; released: boolean } {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || (value as Readonly<Record<string, unknown>>).ok !== true
    || typeof (value as Readonly<Record<string, unknown>>).released !== 'boolean'
  ) {
    throw authorityError('indeterminate', 'Workspace sync target bootstrap release returned an invalid result');
  }
}

/** Resolves the single workspace ref for an id or fails closed. */
function resolveWorkspaceRef(
  snapshot: Pick<ActiveProjectAccountRowsSnapshot, 'workspaceRefs'> | null,
  workspaceRefId: string,
  serverId: string,
): WorkspaceRefV1 {
  const workspace = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], workspaceRefId, serverId);
  if (!workspace) {
    throw authorityError('peer_unavailable', 'Workspace sync endpoint is unavailable', 'endpoint_unavailable');
  }
  return workspace;
}

async function resolveEnabledRelationshipPreflightTarget(input: Readonly<{
  snapshot: ActiveProjectAccountRowsSnapshot | null;
  operationId: string;
  replaceRelationshipId?: string;
  canonicalRoot: string;
  localServerId: string;
  localMachineId: string;
  localManagedTarget?: WorkspaceSyncLocalManagedTarget;
}>): Promise<Readonly<{
  relationship: WorkspaceSyncRelationshipV1;
  target: WorkspaceRefV1;
}> | null> {
  const relationshipId = deriveWorkspaceSyncRelationshipId(input.operationId);
  const enabled = input.snapshot?.relationships.filter(relationship => relationship.enabled) ?? [];
  const relationship = enabled.find(value => value.relationshipId === relationshipId)
    ?? enabled.find(value => value.relationshipId === input.replaceRelationshipId);
  if (!relationship) return null;
  const target = resolveWorkspaceRefById(
    input.snapshot?.workspaceRefs ?? [],
    relationship.betaWorkspaceRefId,
    input.localServerId,
  );
  if (
    !target
    || target.serverId.trim() !== input.localServerId
    || !isWorkspaceSyncLocalNamespace(target, input.localServerId, input.localMachineId, input.localManagedTarget)
  ) return null;
  const targetCanonicalRoot = await realpath(target.rootPath).catch(() => null);
  return targetCanonicalRoot === input.canonicalRoot
    ? { relationship, target }
    : null;
}

/** Initial materialization and recovery share the receiving target's persisted Home proof. */
export function resolvePersistedWorkerCopyCreation(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  relationship: WorkspaceSyncRelationshipV1 | null,
  sourceWorkspaceRefId: string,
  targetWorkspaceRefId: string,
  serverId: string,
): WorkspaceTargetMaterializationWorkerCopyCreation | undefined {
  if (!relationship) return undefined;
  const matches = snapshot?.relationships.filter(candidate => candidate.relationshipId === relationship.relationshipId) ?? [];
  const persisted = matches.length === 1 ? matches[0] : undefined;
  const workerCopy = persisted && getWorkspaceSyncWorkerCopyV1(persisted);
  if (!persisted || !workerCopy
    || !areWorkspaceSyncRelationshipDefinitionsEqual(persisted, relationship)
    || !areWorkspaceSyncWorkerCopyProvenancesEqual(persisted, relationship)
    || workerCopy.sourceWorkspaceRefId !== sourceWorkspaceRefId
    || workerCopy.targetWorkspaceRefId !== targetWorkspaceRefId) return undefined;
  return { serverId, relationshipId: persisted.relationshipId,
    sourceWorkspaceRefId: workerCopy.sourceWorkspaceRefId, targetWorkspaceRefId: workerCopy.targetWorkspaceRefId };
}

/**
 * Resolves the bootstrap owner against the current Project rows and
 * returns the locally resolved target/source roots plus the owner operation
 * id. Every decision is made from the receiving daemon's own snapshot; the
 * caller supplies identity fields only.
 */
function resolveBootstrapOwner(
  snapshot: ActiveProjectAccountRowsSnapshot | null,
  request: WorkspaceSyncTargetBootstrapPrepareV1,
  serverId: string,
  admittedCopy?: Readonly<{ target: WorkspaceRefV1; sourceWriterMachineId: string }>,
): Readonly<{
  operationId: string;
  targetRootPath: string;
  sourceRootPath: string | undefined;
  relationshipId: string | null;
  targetWorkspaceRefId: string;
  targetWorkspace: WorkspaceRefV1;
  sourceWorkspaceRefId: string;
  sourceWorkspace: WorkspaceRefV1 | null;
  sourceMachineId: string;
  endpointRole: 'alpha' | 'beta';
  contentPolicy: WorkspaceContentPolicyV1;
    exclusionCandidates?: readonly string[];
  relationship: WorkspaceSyncRelationshipV1 | null;
}> {
  const target = admittedCopy?.target ?? resolveWorkspaceRef(snapshot, request.targetWorkspaceRefId, serverId);
  if (request.owner.kind === 'relationship') {
    const relationshipId = request.owner.relationshipId;
    const relationships = snapshot?.relationships ?? [];
    const persistedMatches = relationships.filter((candidate) => (
      candidate.relationshipId === relationshipId && candidate.enabled
    ));
    const transient = request.transientRelationship;
    if (transient) {
      const sameId = relationships.filter((candidate) => candidate.relationshipId === relationshipId);
      if (sameId.length > 1 || (sameId[0] && !areWorkspaceSyncRelationshipDefinitionsEqual(sameId[0], transient))) {
        throw authorityError('bootstrap_definition_conflict', 'Transient relationship conflicts with Account Settings');
      }
    } else if (persistedMatches.length !== 1) {
      throw authorityError('relationship_not_ready', 'Workspace sync relationship is not ready');
    }
    const relationship = transient ?? persistedMatches[0]!;
    const alpha = resolveWorkspaceRef(snapshot, relationship.alphaWorkspaceRefId, serverId);
    const beta = resolveWorkspaceRef(snapshot, relationship.betaWorkspaceRefId, serverId);
    const initialRoles = resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: relationship.mode,
      controllerMachineId: relationship.controllerMachineId,
      alphaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(alpha),
      betaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(beta),
    });
    if (!initialRoles) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace sync relationship controller placement is invalid');
    }
    const expectedRefId = request.endpointRole === 'alpha'
      ? relationship.alphaWorkspaceRefId
      : relationship.betaWorkspaceRefId;
    if (request.targetWorkspaceRefId !== expectedRefId) {
      throw authorityError('relationship_not_ready', 'Workspace sync bootstrap target does not match the declared relationship endpoint');
    }
    if (request.policyDigest !== relationship.contentPolicy.policyDigest) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap policy digest conflicts with the relationship');
    }
    const sourceRefId = request.endpointRole === 'alpha'
      ? relationship.betaWorkspaceRefId
      : relationship.alphaWorkspaceRefId;
    const source = sourceRefId === relationship.alphaWorkspaceRefId ? alpha : beta;
    if (request.targetBootstrap !== undefined) {
      if (request.endpointRole !== initialRoles.targetEndpointRole) {
        throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap target does not match the relationship initial roles');
      }
    } else if (!resolveWorkspaceSyncRelationshipTransferDirection({
      relationship,
      sourceWorkspaceRefId: sourceRefId,
      targetWorkspaceRefId: request.targetWorkspaceRefId,
    })) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace sync relationship does not allow this transfer direction');
    }
    return {
      operationId: relationship.relationshipId,
      targetRootPath: target.rootPath,
      sourceRootPath: source.rootPath,
      relationshipId: relationship.relationshipId,
      targetWorkspaceRefId: request.targetWorkspaceRefId,
      targetWorkspace: target,
      sourceWorkspaceRefId: sourceRefId,
      sourceWorkspace: source,
      sourceMachineId: resolveWorkspaceSyncExecutionMachineIdV1(source),
      endpointRole: request.endpointRole,
      contentPolicy: relationship.contentPolicy,
      relationship,
    };
  }
  const operation = request.owner.operation;
  // A copy_once operation always bootstraps its beta endpoint.
  if (request.endpointRole !== 'beta' || request.targetWorkspaceRefId !== operation.betaWorkspaceRefId) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap target does not match the copy_once operation');
  }
  if (request.policyDigest !== operation.contentPolicy.policyDigest) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap policy digest conflicts with the copy_once operation');
  }
  if (admittedCopy && operation.controllerMachineId.trim() !== admittedCopy.sourceWriterMachineId) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync copy controller does not match the admitted source writer');
  }
  const remoteSource = admittedCopy && admittedCopy.sourceWriterMachineId !== resolveWorkspaceSyncExecutionMachineIdV1(target);
  const source = remoteSource ? null : resolveWorkspaceRef(snapshot, operation.alphaWorkspaceRefId, serverId);
  const sourceMachineId = (source ? resolveWorkspaceSyncExecutionMachineIdV1(source) : undefined) ?? admittedCopy!.sourceWriterMachineId;
  if (operation.controllerMachineId.trim() !== sourceMachineId) {
    throw authorityError('bootstrap_definition_conflict', 'Workspace sync copy controller does not own the source endpoint');
  }
  return {
    operationId: operation.operationId,
    targetRootPath: target.rootPath,
    sourceRootPath: source?.rootPath,
    relationshipId: null,
    targetWorkspaceRefId: target.id,
    targetWorkspace: target,
    sourceWorkspaceRefId: operation.alphaWorkspaceRefId,
    sourceWorkspace: source,
    sourceMachineId,
    endpointRole: request.endpointRole,
    contentPolicy: operation.contentPolicy,
    ...(operation.exclusionCandidates ? { exclusionCandidates: operation.exclusionCandidates } : {}),
    relationship: null,
  };
}

/** Stable definition; the validated policy digest below covers every policy operand. */
function canonicalBootstrapDefinition(request: WorkspaceSyncTargetBootstrapPrepareV1): string {
  const owner = request.owner.kind === 'relationship'
    ? { kind: 'relationship', relationshipId: request.owner.relationshipId }
    : {
      kind: 'copy_once',
      operation: {
        v: request.owner.operation.v,
        operationId: request.owner.operation.operationId,
        controllerMachineId: request.owner.operation.controllerMachineId,
        alphaWorkspaceRefId: request.owner.operation.alphaWorkspaceRefId,
        betaWorkspaceRefId: request.owner.operation.betaWorkspaceRefId,
      },
    };
  return JSON.stringify({
    v: request.v,
    bootstrapOperationId: request.bootstrapOperationId,
    owner,
    ...(request.transientRelationship ? { transientRelationship: request.transientRelationship } : {}),
    targetWorkspaceRefId: request.targetWorkspaceRefId,
    endpointRole: request.endpointRole,
    policyDigest: request.policyDigest,
    createIfMissing: request.createIfMissing,
    ...(request.targetBootstrap ? { targetBootstrap: request.targetBootstrap } : {}),
    ...(request.replaceRelationshipId ? { replaceRelationshipId: request.replaceRelationshipId } : {}),
    ...(request.targetReplacementApproval
      ? { targetReplacementApproval: request.targetReplacementApproval }
      : {}),
  });
}

type RetainedSourceWriterTargetRouting = Omit<WorkspaceSyncSourceWriterTargetRoutingV1, 'target'> & Readonly<{
  target: Omit<WorkspaceSyncSourceWriterTargetRoutingV1['target'], 'phase'>;
}>;

function nativeBootstrapAdmission(input: WorkspaceSyncNativeBootstrapAdmission): WorkspaceSyncNativeBootstrapAdmission {
  const context = (value: WorkspaceSyncTargetRoutingV1['targetContext']) => ({
    machineAdmission: value.machineAdmission, callerAuthority: value.callerAuthority,
  });
  const writer = input.sourceWriterTargetRouting;
  const target = {
    ...(input.targetRouting ? { targetRouting: { ...input.targetRouting, targetContext: context(input.targetRouting.targetContext) } } : {}),
  };
  if (!writer) return target;
  const { originalActionEnvelope: _envelope, ...source } = writer.source;
  return { ...target, sourceWriterTargetRouting: { ...writer, source: {
    ...source, sourceContext: context(writer.source.sourceContext),
  } } };
}

type RetainedBootstrap = Readonly<{
  bootstrapOperationId: string;
  definition: string;
  result: WorkspaceSyncTargetBootstrapPrepareResultV1;
  handle: WorkspaceRootOwnershipHandle;
  materializationCustody?: WorkspaceExportMaterializationCustody;
  publishReady(): Promise<void>;
  /** Process-local projection of the durable READY fact; true means custody may only commit. */
  readyPublished: boolean;
  relationshipId: string | null;
  operationId: string;
  sourceWorkspaceRefId: string;
  sourceMachineId: string;
  sourceRootPath: string | undefined;
  targetWorkspaceRefId: string;
  targetMachineId: string;
  targetRootPath: string;
  endpointRole: 'alpha' | 'beta';
  relationshipDefinition: WorkspaceSyncRelationshipV1 | null;
  /** Existing transient authority retained only until its durable relationship is observed enabled. */
  transientAuthority: boolean;
  createIfMissing: boolean;
  /** Original admitted child authority; cleanup never substitutes the parent custodian. */
  targetRouting?: Omit<WorkspaceSyncTargetRoutingV1, 'phase'>;
  /** The same installed source writer may release this loan after child retirement. */
  sourceWriterTargetRouting?: RetainedSourceWriterTargetRouting;
  requesterCopyCustody?: WorkspaceSyncRequesterCopyCustody;
}> & {
  /** Only a relationship observed in the installed Account's rows can disappear from them. */
  observedInInstalledAccount?: true;
};

type RetainedNativeBootstrap = Readonly<{
  kind: 'native';
  execution: WorkspaceSyncNativeTargetExecution;
  workspace: ManagedWorkspaceRefV2;
  bootstrapOperationId: string;
  definition: string;
  result: WorkspaceSyncTargetBootstrapPrepareResultV1;
  relationshipId: string | null;
  operationId: string;
  sourceWorkspaceRefId: string;
  sourceMachineId: string;
  sourceRootPath: string | undefined;
  targetWorkspaceRefId: string;
  targetMachineId: string;
  targetRootPath: string;
  endpointRole: 'alpha' | 'beta';
  relationshipDefinition: WorkspaceSyncRelationshipV1 | null;
  transientAuthority: boolean;
  createIfMissing: boolean;
  targetRouting?: RetainedBootstrap['targetRouting'];
  sourceWriterTargetRouting?: RetainedBootstrap['sourceWriterTargetRouting'];
}>;

type ResolvedBootstrapOwner = ReturnType<typeof resolveBootstrapOwner>;

function retainedBootstrapMatchesOwner(
  entry: RetainedBootstrap | RetainedNativeBootstrap,
  owner: ResolvedBootstrapOwner,
  request: WorkspaceSyncTargetBootstrapPrepareV1,
): boolean {
  return entry.relationshipId === owner.relationshipId
    && entry.operationId === owner.operationId
    && entry.sourceWorkspaceRefId === owner.sourceWorkspaceRefId
    && entry.sourceMachineId === owner.sourceMachineId
    && entry.sourceRootPath === owner.sourceRootPath
    && entry.targetWorkspaceRefId === owner.targetWorkspaceRefId
    && entry.targetMachineId === resolveWorkspaceSyncExecutionMachineIdV1(owner.targetWorkspace)
    && entry.targetRootPath === owner.targetRootPath
    && entry.endpointRole === owner.endpointRole
    && entry.result.policyDigest === request.policyDigest
    && (entry.relationshipDefinition === null
      ? owner.relationship === null
      : owner.relationship !== null
        && areWorkspaceSyncRelationshipDefinitionsEqual(entry.relationshipDefinition, owner.relationship));
}

/**
 * Relationship creation prepares the target from transient intent, then the
 * same operation re-enters after that exact definition is published. SOURCE
 * also carries that row in its signed transient projection on reconnect.
 * Bootstrap mechanics are absent on replay, and every stable relationship
 * and endpoint fact must still match the retained authority.
 */
function isExactPersistedRelationshipReentry(
  entry: RetainedBootstrap | RetainedNativeBootstrap,
  owner: ResolvedBootstrapOwner,
  request: WorkspaceSyncTargetBootstrapPrepareV1,
): boolean {
  return request.owner.kind === 'relationship'
    && request.targetBootstrap === undefined
    && request.targetReplacementApproval === undefined
    && entry.bootstrapOperationId === request.bootstrapOperationId
    && entry.relationshipDefinition !== null
    && entry.createIfMissing === request.createIfMissing
    && retainedBootstrapMatchesOwner(entry, owner, request);
}

function retainedAuthorityKey(input: Readonly<{
  relationshipId: string | null;
  operationId: string;
  endpointRole: 'alpha' | 'beta';
  targetWorkspaceRefId: string;
}>): string {
  return JSON.stringify(input.relationshipId
    ? ['relationship', input.relationshipId, input.endpointRole, input.targetWorkspaceRefId]
    : ['copy_once', input.operationId, input.endpointRole, input.targetWorkspaceRefId]);
}


export function createWorkspaceSyncTargetAuthority(
  dependencies: WorkspaceSyncTargetAuthorityDependencies,
): WorkspaceSyncTargetAuthority {
  const localMachineId = dependencies.localMachineId.trim();
  const localServerId = dependencies.localServerId.trim();
  if (!localMachineId) throw new TypeError('Workspace sync target authority requires a local machine id');
  if (!localServerId) throw new TypeError('Workspace sync target authority requires a local server id');
  const isLocalWorkspace = (workspace: WorkspaceRefV1) => isWorkspaceSyncLocalNamespace(workspace, localServerId, localMachineId, dependencies.localManagedTarget);
  const isHostedNativeWorkspace = (workspace: WorkspaceRefV1) => !dependencies.localManagedTarget
    && dependencies.resolveNativeTargetExecution !== undefined && isManagedWorkspaceRefV2(workspace)
    && isWorkspaceSyncLocalNamespace(workspace, localServerId, localMachineId, workspace);
  const isExecutionHere = (workspace: WorkspaceRefV1) => isLocalWorkspace(workspace) || isHostedNativeWorkspace(workspace);
  const readSnapshot = dependencies.getProjectSnapshot ?? getActiveProjectAccountRowsSnapshot;
  const requireSnapshot = (snapshot: ActiveProjectAccountRowsSnapshot | null): ActiveProjectAccountRowsSnapshot => {
    if (!snapshot) {
      throw authorityError('project_account_rows_unavailable', 'Project rows are unavailable');
    }
    return snapshot;
  };
  const getSnapshot = (operationId?: string): ActiveProjectAccountRowsSnapshot => requireSnapshot(readSnapshot(operationId));
  const readInvocationSnapshot = async (signal?: AbortSignal, context?: RpcHandlerContext, operationId?: string): Promise<ActiveProjectAccountRowsSnapshot> => {
    const authorization = context?.callerInputAuthorization;
    if (!authorization) return getSnapshot(operationId);
    // The refresh owner decides requester currentness once: the installed row
    // reader validates the host-only projections, and a member's refresh is the
    // host's already-admitted requester custody. Do not re-check them here.
    if (!dependencies.refreshProjectSnapshot) {
      throw authorityError('project_requester_authority_unavailable', 'The admitted requester projection is unavailable');
    }
    signal?.throwIfAborted();
    return await dependencies.refreshProjectSnapshot(signal, context);
  };
  const bootstrap = dependencies.bootstrap ?? null;
  const callMachineRpc: WorkspaceSyncTargetAuthorityDependencies['callMachineRpc'] = async request => {
    return readMachineActionRpcResult(await dependencies.callMachineRpc(request));
  };

  // The receipt names the chosen execution namespace. Only the canonical native
  // mapper can bind it to this owner's physical filesystem; it never restamps it.
  const readReplacementTarget = async (machineId: string, rootPath: string, signal?: AbortSignal, context?: RpcHandlerContext) => {
    if (dependencies.localManagedTarget) {
      const matches = getSnapshot().workspaceRefs.filter(ref => isLocalWorkspace(ref) && ref.rootPath === rootPath);
      const workspace = matches.length === 1 ? matches[0]! : null;
      if (machineId !== localMachineId || !workspace) throw authorityError('workspace_machine_not_enrolled', 'Native target does not own the selected workspace');
      return { machineId, rootPath, approvalRoot: null, facts: [], workspace, endpoint: workspace, physicalEndpoint: undefined };
    }
    const childMachines = await dependencies.readChildMachineFacts?.([machineId], signal, context) ?? [];
    const facts = childMachines.filter(child => child.serverId === localServerId && child.machineId === machineId);
    if (facts.length === 0) return { machineId, rootPath, approvalRoot: null, facts, workspace: null, endpoint: null,
      physicalEndpoint: undefined };
    const workspaceRefs = getSnapshot().workspaceRefs;
    const workspace = resolveWorkspaceRefV1(workspaceRefs, { serverId: localServerId, machineId, rootPath });
    if (workspace.kind !== 'resolved') {
      throw authorityError('workspace_sync_child_unavailable', 'The chosen child target root is unavailable');
    }
    const mapped = resolveWorkspaceSyncEndpoint({ workspace: workspace.ref, workspaceRefs, childMachines });
    if (!mapped.ok) throw authorityError(mapped.code, 'The chosen child target storage is unavailable');
    const child = facts.find(fact => fact.machineId === machineId);
    const publicController = child?.managedMachine?.controllerAccess;
    const physicalEndpoint = child && publicController && resolveWorkspaceSyncExecutionMachineIdV1(mapped.endpoint) !== machineId
      ? { machineId: child.controller.machineId, installationId: child.controller.installationId,
        installationPublicKey: publicController.installationPublicKey } : undefined;
    return { machineId: resolveWorkspaceSyncExecutionMachineIdV1(mapped.endpoint), rootPath: mapped.endpoint.rootPath,
      approvalRoot: mapped.endpoint.id === workspace.ref.id ? null : workspace.ref.rootPath,
      facts, workspace: workspace.ref, endpoint: mapped.endpoint, physicalEndpoint };
  };
  const bindReplacementTarget = async (machineId: string, rootPath: string, signal?: AbortSignal, context?: RpcHandlerContext) => {
    const accepted = await readReplacementTarget(machineId, rootPath, signal, context);
    return { ...accepted, assertCurrent: async () => {
      const current = await readReplacementTarget(machineId, rootPath, signal, context);
      const address = (workspace: WorkspaceRefV1 | null) => workspace === null ? null : {
        id: workspace.id, serverId: workspace.serverId,
        ...(isManagedWorkspaceRefV2(workspace) ? { v: workspace.v, kind: workspace.kind, managedId: workspace.managedId, controller: workspace.controller } : { machineId: workspace.machineId }),
        rootPath: workspace.rootPath, projectKey: workspace.projectKey,
      };
      const binding = (target: typeof accepted) => ({
        machineId: target.machineId, rootPath: target.rootPath, approvalRoot: target.approvalRoot,
        physicalEndpoint: target.physicalEndpoint,
        workspace: address(target.workspace), endpoint: address(target.endpoint),
        facts: target.facts.map(fact => ({ installationId: fact.installationId,
          projection: fact.projection, controller: fact.controller })),
      });
      if (!isDeepStrictEqual(binding(current), binding(accepted))) {
        throw authorityError('workspace_sync_child_unavailable', 'The chosen child target storage changed before replacement');
      }
    } };
  };

  // Process-local custody is keyed by stable relationship endpoint authority,
  // not by the handoff request that happened to prepare it. The Project rows and
  // final READY fact remain the restart sources; no runtime id is persisted.
  const retained = new Map<string, RetainedBootstrap | RetainedNativeBootstrap>();
  const physicalRetained = {
    get(key: string): RetainedBootstrap | undefined {
      const entry = retained.get(key);
      return entry && !('kind' in entry) ? entry : undefined;
    },
    *entries(): IterableIterator<readonly [string, RetainedBootstrap]> {
      for (const [key, entry] of retained) if (!('kind' in entry)) yield [key, entry];
    },
    *values(): IterableIterator<RetainedBootstrap> {
      for (const [, entry] of this.entries()) yield entry;
    },
    *keys(): IterableIterator<string> {
      for (const [key] of this.entries()) yield key;
    },
    has(key: string): boolean { return this.get(key) !== undefined; },
    set(key: string, entry: RetainedBootstrap): void { retained.set(key, entry); },
    delete(key: string): void { retained.delete(key); },
  };
  const nativeEntries = () => [...retained.entries()].filter(
    (entry): entry is [string, RetainedNativeBootstrap] => 'kind' in entry[1],
  );
  const findNativeEndpoint = (workspaceRefId: string, relationshipId?: string) => nativeEntries().find(([, entry]) => (
    entry.targetWorkspaceRefId === workspaceRefId && (relationshipId === undefined || entry.relationshipId === relationshipId)
  ));

  const nativeExecutionFor = async (workspace: WorkspaceRefV1, context?: RpcHandlerContext) => {
    if (dependencies.localManagedTarget || !isManagedWorkspaceRefV2(workspace)) return null;
    if (!isWorkspaceSyncLocalNamespace(workspace, localServerId, localMachineId, workspace)) return null;
    const admitted = findNativeEndpoint(workspace.id)?.[1];
    if (admitted && !context && isDeepStrictEqual(admitted.workspace, workspace)) return admitted.execution;
    return dependencies.resolveNativeTargetExecution?.(workspace, context) ?? null;
  };
  const nativeExecutionForEndpoint = async (workspaceRefId: string, operationId?: string, relationshipId?: string) => {
    const admitted = findNativeEndpoint(workspaceRefId, relationshipId)?.[1];
    if (admitted) return admitted.execution;
    const workspace = resolveWorkspaceRefById(readSnapshot(operationId)?.workspaceRefs ?? [], workspaceRefId, localServerId);
    return workspace ? await nativeExecutionFor(workspace) : null;
  };
  const resolveAdmittedNativeWorkspace = (snapshot: ActiveProjectAccountRowsSnapshot,
    locator: WorkspaceSyncLocalManagedTarget, rootPath: string, workspaceRefId?: string): ManagedWorkspaceRefV2 => {
    const resolution = resolveWorkspaceRefV1(snapshot.workspaceRefs, { v: 2, kind: 'managed',
      ...locator, serverId: localServerId, rootPath });
    if (resolution.kind !== 'resolved' || !isManagedWorkspaceRefV2(resolution.ref)
      || !isWorkspaceSyncLocalNamespace(resolution.ref, localServerId, localMachineId, locator)
      || workspaceRefId !== undefined && resolution.ref.id !== workspaceRefId) {
      throw authorityError('workspace_sync_child_unavailable', 'The admitted native target does not resolve to this endpoint');
    }
    return resolution.ref;
  };

  const readTargetRouting = async (
    context: RpcHandlerContext | undefined,
    phase: 'preflight' | 'prepare' | 'release',
  ): Promise<Omit<WorkspaceSyncTargetRoutingV1, 'phase'> | undefined> => {
    if (!context?.workspaceSyncTargetRouting) return undefined;
    const { phase: admittedPhase, ...routing } = WorkspaceSyncTargetRoutingV1Schema.parse(context.workspaceSyncTargetRouting);
    // RPC admission owns the request binding, including derived relationship ids and, for a
    // Project Open, the prepare definition matching the signed Open's workspace action.
    if (admittedPhase !== phase || routing.accountServerId !== localServerId
      || routing.targetMachineId !== context.machineAdmission?.machineId
      || routing.targetManaged !== undefined && (routing.targetManaged.controller.machineId !== routing.targetMachineId
        || routing.targetManaged.controller.installationId !== context.machineAdmission?.installationId)
      || !isDeepStrictEqual(routing.targetContext.machineAdmission, context.machineAdmission)
      || routing.targetContext.callerAuthority !== context.callerAuthority
      || !isDeepStrictEqual(routing.targetContext.sessionActionOrigin, context.sessionActionOrigin)
      || !isDeepStrictEqual(routing.targetContext.callerInputConstraints, context.callerInputConstraints)
      || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
      throw authorityError('workspace_sync_child_unavailable', 'The original target admission is unavailable');
    }
    return routing;
  };
  const readSourceWriterTargetRouting = async (
    context: RpcHandlerContext | undefined,
    phase: 'prepare' | 'release' | 'inspect' | 'dependencies' | 'remove',
    targetRouting?: Omit<WorkspaceSyncTargetRoutingV1, 'phase'>,
  ): Promise<RetainedSourceWriterTargetRouting | undefined> => {
    const raw = context && 'workspaceSyncSourceWriterTargetRouting' in context
      ? context.workspaceSyncSourceWriterTargetRouting : undefined;
    if (!raw) return undefined;
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(raw);
    const { phase: admittedPhase, ...target } = routing.target;
    if (admittedPhase !== phase || target.accountServerId !== localServerId) {
      throw authorityError('bootstrap_definition_conflict', 'Source writer target phase does not match this operation');
    }
    if (phase === 'prepare') {
      if (!targetRouting) throw authorityError('workspace_sync_child_unavailable', 'The admitted target context is unavailable');
      const { targetContext: _targetContext, ...admittedTarget } = targetRouting;
      if (!isDeepStrictEqual(target, admittedTarget)) {
        throw authorityError('bootstrap_definition_conflict', 'Source writer target placement does not match the admitted target');
      }
    } else {
      const admission = context?.machineAdmission;
      if (isSignedWorkspaceSyncHandoffReleaseV1(routing, context?.callerInputAuthorization)) {
        const handoff = context?.callerInputAuthorization?.binding.handoffAdmission;
        if (context?.workspaceSyncTargetRouting || !admission || !handoff
          || admission.machineId !== routing.target.targetMachineId
          || admission.machineId !== handoff.targetMachineId
          || admission.installationId !== handoff.targetInstallationId
          || admission.actorAccountId !== context.callerInputAuthorization!.binding.accountId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
          throw authorityError('workspace_sync_child_unavailable', 'The installed source writer cleanup transport is unavailable');
        }
      } else if (context?.workspaceSyncTargetRouting || !admission
        || admission.machineId !== routing.sourceWriter.machineId
        || admission.installationId !== routing.sourceWriter.installationId
        || admission.actorAccountId !== admission.custodianAccountId
        || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
        throw authorityError('workspace_sync_child_unavailable', 'The installed source writer cleanup transport is unavailable');
      }
    }
    return { ...routing, target };
  };
  const assertPrepareWrites = (
    request: WorkspaceSyncTargetBootstrapPrepareV1,
    targetContext: WorkspaceSyncTargetRoutingV1['targetContext'],
    relationship: WorkspaceSyncRelationshipV1 | null = null,
  ): void => {
    const contentPolicy = relationship?.contentPolicy
      ?? (request.owner.kind === 'copy_once' ? request.owner.operation.contentPolicy : null);
    if (!contentPolicy) throw authorityError('relationship_not_ready', 'The workspace relationship is unavailable');
    const workspaceAction = relationship && request.targetBootstrap !== undefined
      ? { kind: 'create_relationship', mode: relationship.mode, contentPolicy, flushBeforeCommit: true }
      : relationship
        ? { kind: 'relationship', relationshipId: relationship.relationshipId, flushBeforeCommit: false }
        : { kind: 'copy_once', contentPolicy };
    const admission = resolveWorkspaceWriteActionAdmissionV1({ spec: getActionSpec('session.handoff'),
      actionInput: { workspaceAction }, workspaceWrites: targetContext.workspaceWrites,
      currentWorkspaceWrites: targetContext.sessionActionOrigin?.workspaceWrites,
      agentCaller: targetContext.sessionActionOrigin !== undefined });
    if (!admission.ok) throw authorityError(admission.errorCode, admission.errorCode);
  };
  const inFlight = new Map<string, Promise<unknown>>();
  const activeIngresses = new Map<string, Set<() => Promise<void>>>();
  const sourceLoans = new Map<string, Set<string>>();
  const sourceLoanOwners = new Map<string, string>();
  const deferredDiscards = new Map<string, 'commit' | 'abort'>();
  const activityListeners = new Set<() => void>();
  const notifyActivity = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot change target custody. */ }
    }
  };
  const activity: LiveWorkProducerV1 = Object.freeze({
    read(): Omit<LiveWorkInventoryV1, 'idleSince'> {
      const ids = new Set([...retained.keys(), ...inFlight.keys(), ...activeIngresses.keys(),
        ...sourceLoans.keys(), ...deferredDiscards.keys()]);
      const items: LiveWorkItemV1[] = [...ids].map(ownerRef => {
        const entry = retained.get(ownerRef);
        const held = inFlight.has(ownerRef) || (activeIngresses.get(ownerRef)?.size ?? 0) > 0
          || (sourceLoans.get(ownerRef)?.size ?? 0) > 0 || deferredDiscards.has(ownerRef)
          || (entry && ('kind' in entry || !entry.readyPublished || entry.transientAuthority || entry.relationshipId === null));
        const settled = entry && !('kind' in entry) && entry.readyPublished
          && (!entry.materializationCustody || entry.materializationCustody.receipt.committed !== undefined);
        return { category: 'sync', ownerRef, attribution: { kind: 'unknown' },
          state: held ? 'active' : settled ? 'settled' : 'unknown' };
      });
      return { items, coverage: closing || readSnapshot() === null ? 'unknown' : 'complete' };
    },
    subscribe(listener: () => void): () => void {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
  });
  let closing = false;

  const commitPublishedMaterializationCustody = async (entry: RetainedBootstrap): Promise<void> => {
    if (!entry.readyPublished) return;
    await entry.materializationCustody?.commit();
  };

  const parseCommittedCopy = (request: WorkspaceSyncCommittedCopyRequest) => {
    request.signal?.throwIfAborted();
    // Signal is owner-local cancellation, not part of the closed wire authority envelope.
    const { signal: _signal, ...wire } = request;
    const parsed = WorkspaceSyncCommittedCopyTargetV1Schema.parse(wire);
    const relationship = parsed.actionInput.expectedRelationship;
    const removal = parsed.actionInput.removeTargetCopy!;
    const workerCopy = getWorkspaceSyncWorkerCopyV1(relationship);
    if (!workerCopy) throw authorityError('workspace_copy_not_worker', 'Workspace relationship has no worker-copy creation provenance');
    if (removal.workspaceRefId !== workerCopy.targetWorkspaceRefId) {
      throw authorityError('workspace_unavailable', 'Workspace removal is not the worker-copy target');
    }
    if (parsed.actionInput.workspace.serverId !== localServerId
      || parsed.actionInput.machineId !== relationship.controllerMachineId
      || ![relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].includes(parsed.actionInput.workspace.refId)
      || ![relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId].includes(removal.workspaceRefId)) {
      throw authorityError('approval_stale', 'Reviewed workspace retirement placement changed');
    }
    return { parsed, relationship, removal, workerCopy };
  };

  const resolveCommittedCopy = (request: WorkspaceSyncCommittedCopyRequest,
    snapshot: Pick<ActiveProjectAccountRowsSnapshot, 'workspaceRefs' | 'relationships'> | null = getSnapshot()) => {
    const { parsed, relationship, removal, workerCopy } = parseCommittedCopy(request);
    if (!bootstrap) throw authorityError('target_bootstrap_required', 'Workspace copy custody is unavailable');
    if (!snapshot) throw authorityError('peer_unavailable', 'Workspace sync endpoint is unavailable', 'endpoint_unavailable');
    const endpointRole = relationship.alphaWorkspaceRefId === removal.workspaceRefId ? 'alpha'
      : relationship.betaWorkspaceRefId === removal.workspaceRefId ? 'beta' : null;
    if (!endpointRole) throw authorityError('bootstrap_definition_conflict', 'Workspace is not a reviewed relationship endpoint');
    const workspace = resolveWorkspaceRef(snapshot, removal.workspaceRefId, localServerId);
    if (!isLocalWorkspace(workspace)) {
      throw authorityError('workspace_sync_target_mismatch', 'Committed copy removal must run at its target machine');
    }
    return {
      relationship,
      parsed,
      workspace,
      snapshot,
      endpointRole,
      bootstrap,
      copy: {
        rootPath: workspace.rootPath,
        relationshipId: relationship.relationshipId,
        endpointRole,
        rootFingerprint: removal.rootFingerprint,
        materializationDirectory: bootstrap.materializationDirectory,
        workerCopyCreation: { serverId: localServerId, relationshipId: relationship.relationshipId,
          sourceWorkspaceRefId: workerCopy.sourceWorkspaceRefId,
          targetWorkspaceRefId: removal.workspaceRefId },
        ...(request.signal ? { signal: request.signal } : {}),
      } satisfies Parameters<typeof inspectWorkspaceSyncCommittedCopy>[0],
    };
  };

  const assertCommittedCopyApproved = async (request: WorkspaceSyncCommittedCopyRequest) => {
    const { parsed } = parseCommittedCopy(request);
    if (!dependencies.assertCommittedCopyRemovalAuthorized) {
      throw authorityError('approval_required', 'Workspace copy removal Action receipt authority is unavailable');
    }
    await dependencies.assertCommittedCopyRemovalAuthorized(parsed.actionReceiptId, parsed.actionInput);
    if (!dependencies.readCommittedCopyDependencies) {
      throw authorityError('workspace_sync_dependencies_unavailable', 'Workspace copy dependencies are unavailable');
    }
    const active = await dependencies.readCommittedCopyDependencies(parsed.actionInput);
    if (active.length > 0) {
      throw Object.assign(authorityError('workspace_sync_relationship_in_use', 'Workspace copy has dependent work'), { dependencies: active });
    }
  };

  const assertCommittedCopyRelationshipCurrent = (snapshot: Pick<ActiveProjectAccountRowsSnapshot, 'relationships'>, relationship: WorkspaceSyncRelationshipV1) => {
    const matches = snapshot.relationships.filter((value) => value.relationshipId === relationship.relationshipId);
    if (matches.length !== 1 || !areWorkspaceSyncRelationshipDefinitionsEqual(matches[0]!, relationship)
      || !areWorkspaceSyncWorkerCopyProvenancesEqual(matches[0]!, relationship)
      || matches[0]!.enabled !== relationship.enabled
      || matches[0]!.createdAtMs !== relationship.createdAtMs
      || matches[0]!.updatedAtMs !== relationship.updatedAtMs) {
      throw authorityError('bootstrap_definition_conflict', 'Workspace relationship changed since review');
    }
  };

  const resolveCommittedCopyPreview = (request: WorkspaceSyncCommittedCopyPreviewRequest, snapshot: ActiveProjectAccountRowsSnapshot) => {
    request.signal?.throwIfAborted();
    const { signal: _signal, ...wire } = request;
    const parsed = WorkspaceSyncCommittedCopyPreviewV1Schema.parse(wire);
    const relationship = parsed.expectedRelationship;
    const endpoints = [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId];
    if (parsed.workspace.serverId !== localServerId || parsed.machineId !== relationship.controllerMachineId
      || !endpoints.includes(parsed.workspace.refId) || !endpoints.includes(parsed.targetWorkspaceRefId)) {
      throw authorityError('root_mismatch', 'Workspace copy preview placement changed');
    }
    assertCommittedCopyRelationshipCurrent(snapshot, relationship);
    // Both endpoints must still belong to this Home's canonical Account graph.
    for (const workspaceRefId of endpoints) resolveWorkspaceRef(snapshot, workspaceRefId, localServerId);
    const workspace = resolveWorkspaceRef(snapshot, parsed.targetWorkspaceRefId, localServerId);
    if (resolveWorkspaceSyncExecutionMachineIdV1(workspace) !== parsed.targetMachineId) {
      throw authorityError('root_mismatch', 'Workspace copy preview target changed');
    }
    return { parsed, relationship, workspace, sourceWorkspace: resolveWorkspaceRef(snapshot, parsed.workspace.refId, localServerId),
      endpointRole: relationship.alphaWorkspaceRefId === workspace.id ? 'alpha' as const : 'beta' as const };
  };

  const refreshCommittedCopyPreview = async (request: WorkspaceSyncCommittedCopyPreviewRequest, context?: RpcHandlerContext) => {
    request.signal?.throwIfAborted();
    if (!dependencies.refreshProjectSnapshot) {
      throw authorityError('workspace_copy_preview_unavailable', 'Current Home rows for workspace copy preview are unavailable');
    }
    return resolveCommittedCopyPreview(request, await dependencies.refreshProjectSnapshot(request.signal, context));
  };

  const inspectCommittedCopyPreviewHere = async (
    request: WorkspaceSyncCommittedCopyPreviewRequest,
    resolved: ReturnType<typeof resolveCommittedCopyPreview>,
  ): Promise<WorkspaceSyncCommittedCopyPreviewResultV1> => {
    if (!isLocalWorkspace(resolved.workspace)) {
      throw authorityError('root_mismatch', 'Workspace copy preview must run at its physical target');
    }
    if (!bootstrap) throw authorityError('target_bootstrap_required', 'Workspace copy custody is unavailable');
    let observed: Readonly<{ rootFingerprint: string; sizeBytes?: number }> | null = null;
    try {
      observed = await inspectWorkspaceSyncCommittedCopy({ rootPath: resolved.workspace.rootPath,
        relationshipId: resolved.relationship.relationshipId, endpointRole: resolved.endpointRole,
        materializationDirectory: bootstrap.materializationDirectory,
        measureSize: true,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'workspace_copy_not_owned')) throw error;
    }
    // Admitted once before the read; a later change takes effect at the next
    // request, and removal re-checks its reviewed fingerprint.
    if (!observed) return { ok: false, errorCode: 'workspace_copy_not_owned' };
    return { ok: true, preview: { targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(resolved.workspace),
      workspaceRefId: resolved.workspace.id, rootFingerprint: observed.rootFingerprint,
      ...(observed.sizeBytes === undefined ? {} : { sizeBytes: observed.sizeBytes }) } };
  };

  const committedCopyAtTarget = async (request: WorkspaceSyncCommittedCopyRequest, phase: 'inspect' | 'remove', context?: RpcHandlerContext) => {
    const { parsed, removal } = parseCommittedCopy(request);
    const workspace = resolveWorkspaceRef(getSnapshot(), removal.workspaceRefId, localServerId);
    if (isLocalWorkspace(workspace)) {
      await (phase === 'inspect' ? authority.inspectCommittedCopyHere : authority.removeCommittedCopyHere)(request, context);
      return;
    }
    const result = await callMachineRpc({ machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace),
      method: phase === 'inspect' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT : RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE,
      request: parsed, ...(request.signal ? { signal: request.signal } : {}),
      ...(phase === 'remove' && context?.localActionContext ? { operationContext: context.localActionContext } : {}),
    });
    const parsedResult = WorkspaceSyncCommittedCopyTargetResultV1Schema.safeParse(result);
    if (!parsedResult.success) {
      assertOkResult(result);
      throw parsedResult.error;
    }
    if (!parsedResult.data.ok) {
      throw Object.assign(authorityError(parsedResult.data.errorCode, 'Workspace copy has dependent work'), { dependencies: parsedResult.data.dependencies });
    }
  };

  const exclusive = <T>(id: string, action: () => Promise<T>, allowClosing = false): Promise<T> => {
    const prior = inFlight.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(async () => {
      if (closing && !allowClosing) throw authorityError('peer_unavailable', 'Workspace sync target authority is shutting down', 'authority_closing');
      return await action();
    });
    const registered = next.catch(() => undefined);
    inFlight.set(id, registered);
    notifyActivity();
    void registered.then(() => { if (inFlight.get(id) === registered) inFlight.delete(id); notifyActivity(); });
    return next;
  };

  const throwFailures = (failures: readonly unknown[], message: string): void => {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
  };
  const closeActiveIngressesFor = async (authorityKey: string): Promise<void> => {
    const failures: unknown[] = [];
    for (const result of await Promise.allSettled([...(activeIngresses.get(authorityKey) ?? [])].map(close => close()))) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    throwFailures(failures, 'Workspace sync target ingress cleanup failed');
  };
  const discardRetained = async (authorityKey: string, outcome: 'commit' | 'abort' = 'abort'): Promise<void> => {
    const native = retained.get(authorityKey);
    if (native && 'kind' in native) {
      await closeActiveIngressesFor(authorityKey);
      await native.execution.releaseAllRetainedBootstraps();
      retained.delete(authorityKey);
      activeIngresses.delete(authorityKey);
      notifyActivity();
      return;
    }
    let entry = physicalRetained.get(authorityKey);
    if (!entry) return;
    const cleanupFailures: unknown[] = [];
    let materializationCustodyExternalized = false;
    let custodySettlementFailed = false;
    await closeActiveIngressesFor(authorityKey);
    if ((sourceLoans.get(authorityKey)?.size ?? 0) > 0) {
      // The relationship may stop while a copy is reading its old spoke.
      // Close ingress now, but keep its physical source handle until that finite borrower releases it.
      deferredDiscards.set(authorityKey, outcome);
      return;
    }
    try {
      if (outcome === 'commit' || entry.readyPublished) {
        if (!entry.readyPublished) {
          await entry.publishReady();
          entry = { ...entry, readyPublished: true };
          physicalRetained.set(authorityKey, entry);
        }
        await commitPublishedMaterializationCustody(entry);
      } else await entry.materializationCustody?.abort();
    } catch (error) {
      custodySettlementFailed = true;
      materializationCustodyExternalized = (error as { code?: unknown }).code === 'workspace_target_materialization_manual_recovery';
      // The durable receipt is now the sole recovery authority; drop process-local entry on custody proof failure.
      if (!materializationCustodyExternalized) cleanupFailures.push(error);
    }
    if (outcome === 'commit' && !entry.readyPublished) throwFailures(cleanupFailures, 'Workspace sync target READY publication failed');
    if (entry.readyPublished && custodySettlementFailed && !materializationCustodyExternalized) {
      throwFailures(cleanupFailures, 'Workspace sync committed target custody cleanup failed');
    }
    await entry.handle.release().catch((error: unknown) => { cleanupFailures.push(error); });
    if (cleanupFailures.length === 0 || materializationCustodyExternalized) {
      physicalRetained.delete(authorityKey);
      activeIngresses.delete(authorityKey);
      deferredDiscards.delete(authorityKey);
      notifyActivity();
      if (cleanupFailures.length === 0) return;
    }
    throwFailures(cleanupFailures, 'Workspace sync target authority cleanup failed');
  };

  const relationshipOwnsEndpoint = (
    snapshot: ActiveProjectAccountRowsSnapshot | null,
    entry: RetainedBootstrap | RetainedNativeBootstrap,
    requireEnabled: boolean,
  ): boolean => {
    if (!entry.relationshipId) return false;
    const matches = (snapshot?.relationships ?? []).filter((candidate) => (
      candidate.relationshipId === entry.relationshipId && (!requireEnabled || candidate.enabled)
    ));
    if (matches.length !== 1) return false;
    const relationship = matches[0]!;
    const expectedTargetRef = entry.endpointRole === 'alpha'
      ? relationship.alphaWorkspaceRefId
      : relationship.betaWorkspaceRefId;
    const expectedSourceRef = entry.endpointRole === 'alpha'
      ? relationship.betaWorkspaceRefId
      : relationship.alphaWorkspaceRefId;
    const target = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], expectedTargetRef, localServerId);
    const source = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], expectedSourceRef, localServerId);
    return expectedTargetRef === entry.targetWorkspaceRefId
      && expectedSourceRef === entry.sourceWorkspaceRefId
      && entry.relationshipDefinition !== null
      && areWorkspaceSyncRelationshipDefinitionsEqual(relationship, entry.relationshipDefinition)
      && target !== null && target !== undefined && ('kind' in entry
        ? isWorkspaceSyncLocalNamespace(target, localServerId, localMachineId, entry.workspace) && target.rootPath === entry.workspace.rootPath
        : isLocalWorkspace(target))
      && resolveWorkspaceSyncExecutionMachineIdV1(target) === entry.targetMachineId
      && (source ? resolveWorkspaceSyncExecutionMachineIdV1(source) : undefined) === entry.sourceMachineId
      && relationship.contentPolicy.policyDigest === entry.result.policyDigest;
  };

  type InstalledWriterLoan = Pick<RetainedBootstrap, 'relationshipId' | 'sourceWriterTargetRouting' | 'targetRouting'>;
  const installedWriterRelationshipId = (loan: InstalledWriterLoan): string | null => (
    loan.relationshipId && loan.sourceWriterTargetRouting && dependencies.localAccountId !== undefined
      && loan.targetRouting?.targetContext.machineAdmission.actorAccountId === dependencies.localAccountId
      ? loan.relationshipId : null);
  const includesRelationship = (snapshot: ActiveProjectAccountRowsSnapshot | null, relationshipId: string) => (
    (snapshot?.relationships ?? []).some(relationship => relationship.relationshipId === relationshipId));

  const observeInstalledWriterLoan = (entry: RetainedBootstrap, snapshot: ActiveProjectAccountRowsSnapshot | null) => {
    const relationshipId = installedWriterRelationshipId(entry);
    if (!relationshipId) return;
    const published = includesRelationship(snapshot, relationshipId);
    if (published) entry.observedInInstalledAccount = true;
    return published;
  };

  /**
   * The SOURCE owner stages a same-Account writer loan's row at Home before
   * prepare. A lagging installed projection gets one refresh; a row still
   * absent was never staged, and the person would have no link to Stop.
   */
  const admitInstalledWriterLoan = async (loan: InstalledWriterLoan, signal?: AbortSignal): Promise<void> => {
    const relationshipId = installedWriterRelationshipId(loan);
    if (!relationshipId || includesRelationship(readSnapshot(), relationshipId)) return;
    const refreshed = dependencies.refreshProjectSnapshot ? await dependencies.refreshProjectSnapshot(signal) : null;
    if (!includesRelationship(refreshed, relationshipId)) {
      throw authorityError('relationship_not_ready', 'The SOURCE has not staged this Workspace Sync relationship');
    }
  };

  /** A retained relationship fence must survive only while its durable relationship owns the endpoint. */
  const relationshipStillOwnsEndpoint = (
    snapshot: ActiveProjectAccountRowsSnapshot | null,
    entry: RetainedBootstrap | RetainedNativeBootstrap,
  ): boolean => relationshipOwnsEndpoint(snapshot, entry, true);

  const resolveInstalledWorkerCopyCustody = (
    binding: WorkspaceSyncRequesterCopyCustody,
    relationship: WorkspaceSyncRelationshipV1,
    source: WorkspaceRefV1,
    target: WorkspaceRefV1,
  ): WorkspaceSyncRequesterCopyCustody | undefined => {
    if (binding.accountServerId !== localServerId || binding.actorAccountId !== dependencies.localAccountId
      || binding.relationship.relationshipId !== relationship.relationshipId
      || !areWorkspaceSyncRelationshipDefinitionsEqual(binding.relationship, relationship)
      || !areWorkspaceSyncWorkerCopyProvenancesEqual(binding.relationship, relationship)
      || binding.sourceWorkspace.id !== source.id || binding.sourceWorkspace.rootPath !== source.rootPath
      || binding.sourceWorkspace.machineId !== resolveWorkspaceSyncExecutionMachineIdV1(source)
      || binding.target.machineId !== localMachineId) return undefined;
    const installed = readSnapshot();
    const committed = installed?.relationships.find(candidate => candidate.relationshipId === relationship.relationshipId);
    if (!committed?.enabled || committed.committedAtMs === null
      || !resolvePersistedWorkerCopyCreation(installed, relationship, source.id, target.id, localServerId)) return undefined;
    const installedSource = resolveWorkspaceRefById(installed?.workspaceRefs ?? [], source.id, localServerId);
    const installedTarget = resolveWorkspaceRefById(installed?.workspaceRefs ?? [], target.id, localServerId);
    if (!installedSource || installedSource.rootPath !== source.rootPath
      || resolveWorkspaceSyncExecutionMachineIdV1(installedSource) !== binding.sourceWorkspace.machineId
      || !installedTarget || installedTarget.rootPath !== target.rootPath || !isLocalWorkspace(installedTarget)
      || binding.target.installationId !== readInstallationIdentityIfExistsSync()?.installationId) return undefined;
    return { ...binding, relationship: committed };
  };

  const rehydrateLocalEndpoint = async (input: Readonly<{
    relationshipId: string | null;
    operationId: string;
    endpointRole: 'alpha' | 'beta';
    targetWorkspace: WorkspaceRefV1;
    sourceWorkspace: WorkspaceRefV1;
    contentPolicy: WorkspaceContentPolicyV1;
    bootstrapOperationId: string;
    definition: string;
    relationshipDefinition: WorkspaceSyncRelationshipV1 | null;
    transientAuthority: boolean;
    createIfMissing: boolean;
    extraBootstrap?: Partial<Parameters<typeof rehydrateWorkspaceSyncTargetBootstrap>[0]>;
  }>): Promise<RetainedBootstrap | null> => {
    if (!bootstrap || !isLocalWorkspace(input.targetWorkspace)
      || dependencies.localWorkspaceRefId !== undefined && input.targetWorkspace.id !== dependencies.localWorkspaceRefId) return null;
    assertLocalWorkspacePlacement(input.targetWorkspace, localServerId, localMachineId, dependencies.localManagedTarget);
    const authorityKey = retainedAuthorityKey({
      relationshipId: input.relationshipId, operationId: input.operationId,
      endpointRole: input.endpointRole, targetWorkspaceRefId: input.targetWorkspace.id,
    });
    return await exclusive(authorityKey, async () => {
      const existing = physicalRetained.get(authorityKey);
      if (existing) { await commitPublishedMaterializationCustody(existing); return existing; }
      const prepared = await rehydrateWorkspaceSyncTargetBootstrap({
        rootPath: input.targetWorkspace.rootPath, relationshipId: input.operationId,
        endpointRole: input.endpointRole, targetWorkspaceRefId: input.targetWorkspace.id,
        policyDigest: input.contentPolicy.policyDigest, contentSelection: input.contentPolicy.selection,
        ...(input.contentPolicy.contentOnly ? { contentOnly: true as const } : {}),
        materializationDirectory: bootstrap.materializationDirectory, rootOwnershipManager: bootstrap.rootOwnershipManager,
        ...(bootstrap.prepareGitTarget ? { prepareGitTarget: bootstrap.prepareGitTarget } : {}),
        ...input.extraBootstrap,
      }, bootstrap.rehydrateMaterializationFromReceiptPath
        ? { rehydrateMaterializationFromReceiptPath: bootstrap.rehydrateMaterializationFromReceiptPath } : undefined);
      if (!prepared) return null;
      const result = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
        v: 1, bootstrapOperationId: input.bootstrapOperationId, targetWorkspaceRefId: input.targetWorkspace.id,
        state: 'ready', created: false, rootFingerprint: prepared.rootFingerprint, policyDigest: prepared.policyDigest,
      });
      const entry: RetainedBootstrap = {
        bootstrapOperationId: input.bootstrapOperationId, definition: input.definition, result,
        handle: prepared.ownershipHandles[0]!, relationshipId: input.relationshipId, operationId: input.operationId,
        sourceWorkspaceRefId: input.sourceWorkspace.id, sourceMachineId: resolveWorkspaceSyncExecutionMachineIdV1(input.sourceWorkspace),
        sourceRootPath: input.sourceWorkspace.rootPath, targetWorkspaceRefId: input.targetWorkspace.id,
        targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(input.targetWorkspace), targetRootPath: input.targetWorkspace.rootPath,
        endpointRole: input.endpointRole, relationshipDefinition: input.relationshipDefinition,
        transientAuthority: input.transientAuthority, createIfMissing: input.createIfMissing,
        ...(prepared.requesterCopyCustody ? { requesterCopyCustody: prepared.requesterCopyCustody } : {}),
        ...(prepared.materializationCustody ? { materializationCustody: prepared.materializationCustody } : {}),
        publishReady: prepared.publishReady, readyPublished: prepared.readyPublished,
      };
      physicalRetained.set(authorityKey, entry);
      await commitPublishedMaterializationCustody(entry);
      return entry;
    });
  };

  const rehydrateRelationshipEndpoint = async (input: Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    endpointRole: 'alpha' | 'beta';
    targetWorkspace: WorkspaceRefV1;
    sourceWorkspace: WorkspaceRefV1;
    recoverMaterializationOnly?: boolean;
    /** The exact current invocation's Home rows, when they differ from daemon custody. */
    projectSnapshot?: ActiveProjectAccountRowsSnapshot | null;
    requesterCopyCustody?: WorkspaceSyncRequesterCopyCustody;
  }>): Promise<RetainedBootstrap | null> => {
    const workerCopyCreation = resolvePersistedWorkerCopyCreation(
      input.projectSnapshot === undefined ? getSnapshot(input.relationship.relationshipId) : input.projectSnapshot,
      input.relationship, input.sourceWorkspace.id, input.targetWorkspace.id, localServerId,
    );
    // An installed Account can resume its committed copy from the binding written during signed creation.
    const recoverInstalledCustody = (stored: WorkspaceSyncRequesterCopyCustody) =>
      resolveInstalledWorkerCopyCustody(stored, input.relationship, input.sourceWorkspace, input.targetWorkspace);
    return await rehydrateLocalEndpoint({
      relationshipId: input.relationship.relationshipId, operationId: input.relationship.relationshipId,
      endpointRole: input.endpointRole, targetWorkspace: input.targetWorkspace, sourceWorkspace: input.sourceWorkspace,
      contentPolicy: input.relationship.contentPolicy,
      bootstrapOperationId: `rehydrated:${input.relationship.relationshipId}:${input.endpointRole}`,
      definition: 'rehydrated-from-settings-and-materialization-receipt',
      relationshipDefinition: input.relationship, transientAuthority: input.requesterCopyCustody !== undefined, createIfMissing: false,
      extraBootstrap: {
        ...(workerCopyCreation ? { workerCopyCreation } : {}),
        ...(input.requesterCopyCustody || workerCopyCreation
          ? { requesterCopyCustody: input.requesterCopyCustody ?? recoverInstalledCustody } : {}),
        ...(input.recoverMaterializationOnly ? { requireMaterializationReceipt: true } : {}),
      },
    });
  };

  const rehydrateCopyOnceEndpoint = async (input: Readonly<{
    request: WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ owner: Readonly<{ kind: 'copy_once'; operation: WorkspaceSyncCopyOnceV1 }> }>;
    targetWorkspace: WorkspaceRefV1;
    sourceWorkspace: WorkspaceRefV1;
  }>): Promise<RetainedBootstrap | null> => {
    const operation = input.request.owner.operation;
    return await rehydrateLocalEndpoint({
      relationshipId: null, operationId: operation.operationId, endpointRole: 'beta',
      targetWorkspace: input.targetWorkspace, sourceWorkspace: input.sourceWorkspace, contentPolicy: operation.contentPolicy,
      bootstrapOperationId: input.request.bootstrapOperationId, definition: canonicalBootstrapDefinition(input.request),
      relationshipDefinition: null, transientAuthority: false, createIfMissing: input.request.createIfMissing,
      extraBootstrap: dependencies.localManagedTarget && dependencies.localAccountId && isManagedWorkspaceRefV2(input.targetWorkspace)
        ? { nativeCopyOwner: { accountId: dependencies.localAccountId, target: input.targetWorkspace } } : undefined,
    });
  };

  const rehydrateIngressOwner = async (facts: Readonly<{
    operationId: string;
    sourceMachineId: string;
    targetMachineId: string;
  }>): Promise<void> => {
    const snapshot = getSnapshot(facts.operationId);
    const relationships = (snapshot?.relationships ?? []).filter((candidate) => (
      candidate.relationshipId === facts.operationId && candidate.enabled
    ));
    if (relationships.length !== 1) return;
    const relationship = relationships[0]!;
    const refs = snapshot?.workspaceRefs ?? [];
    const candidates = (['alpha', 'beta'] as const).flatMap((endpointRole) => {
      const targetRefId = endpointRole === 'alpha' ? relationship.alphaWorkspaceRefId : relationship.betaWorkspaceRefId;
      const sourceRefId = endpointRole === 'alpha' ? relationship.betaWorkspaceRefId : relationship.alphaWorkspaceRefId;
      const targetWorkspace = resolveWorkspaceRefById(refs, targetRefId, localServerId);
      const sourceWorkspace = resolveWorkspaceRefById(refs, sourceRefId, localServerId);
      return targetWorkspace && sourceWorkspace && isLocalWorkspace(targetWorkspace)
        && resolveWorkspaceSyncExecutionMachineIdV1(targetWorkspace) === facts.targetMachineId
        && resolveWorkspaceSyncExecutionMachineIdV1(sourceWorkspace) === facts.sourceMachineId
        ? [{ endpointRole, targetWorkspace, sourceWorkspace }]
        : [];
    });
    if (candidates.length !== 1) return;
    await rehydrateRelationshipEndpoint({ relationship, ...candidates[0]! });
  };

  const assertRetainedRootIdentity = async (input: Readonly<{
    authorityKey: string;
    entry: RetainedBootstrap;
    rootPath: string;
  }>): Promise<string> => {
    try {
      await input.entry.handle.bindCurrentRootIdentity();
    } catch {
      await discardRetained(input.authorityKey);
      throw authorityError('root_changed', 'Workspace sync target root identity changed');
    }
    const canonicalRoot = await realpath(input.rootPath).catch(() => null);
    if (canonicalRoot !== input.entry.handle.owner.canonicalRoot
      || input.entry.handle.owner.rootFingerprint !== input.entry.result.rootFingerprint) {
      await discardRetained(input.authorityKey);
      throw authorityError('root_changed', 'Workspace sync target root identity changed');
    }
    return canonicalRoot;
  };

  const requireRetainedRelationshipEndpoint = async (input: Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    workspace: WorkspaceRefV1;
  }>): Promise<Readonly<{
    authorityKey: string;
    entry: RetainedBootstrap;
    canonicalRoot: string;
  }>> => {
    const endpointRole = input.relationship.alphaWorkspaceRefId === input.workspace.id
      ? 'alpha'
      : input.relationship.betaWorkspaceRefId === input.workspace.id
        ? 'beta'
        : null;
    if (!endpointRole) {
      throw authorityError('relationship_not_ready', 'Workspace reference is not owned by the relationship');
    }
    const sourceWorkspaceRefId = endpointRole === 'alpha'
      ? input.relationship.betaWorkspaceRefId
      : input.relationship.alphaWorkspaceRefId;
    const sourceWorkspace = resolveWorkspaceRef(getSnapshot(input.relationship.relationshipId), sourceWorkspaceRefId, localServerId);
    const authorityKey = retainedAuthorityKey({
      relationshipId: input.relationship.relationshipId,
      operationId: input.relationship.relationshipId,
      endpointRole,
      targetWorkspaceRefId: input.workspace.id,
    });
    let entry = physicalRetained.get(authorityKey) ?? null;
    if (!entry) {
      entry = await rehydrateRelationshipEndpoint({
        relationship: input.relationship,
        endpointRole,
        targetWorkspace: input.workspace,
        sourceWorkspace,
      });
    }
    if (!entry || !relationshipStillOwnsEndpoint(getSnapshot(entry.operationId), entry)) {
      throw authorityError('relationship_not_ready', 'Workspace sync target root is not retained by a ready relationship');
    }
    const canonicalRoot = await assertRetainedRootIdentity({
      authorityKey,
      entry,
      rootPath: input.workspace.rootPath,
    });
    return { authorityKey, entry, canonicalRoot };
  };

  const assertRetainedRelationshipEndpointCurrent = async (input: Readonly<{
    authorityKey: string;
    entry: RetainedBootstrap;
    workspace: WorkspaceRefV1;
  }>): Promise<void> => {
    if (physicalRetained.get(input.authorityKey) !== input.entry
      || !relationshipStillOwnsEndpoint(getSnapshot(input.entry.operationId), input.entry)) {
      throw authorityError('relationship_not_ready', 'Workspace sync target root is no longer retained by the relationship');
    }
    await assertRetainedRootIdentity({
      authorityKey: input.authorityKey,
      entry: input.entry,
      rootPath: input.workspace.rootPath,
    });
  };

  const findRetainedTarget = (request: WorkspaceSyncTargetConflictRecoverV1) => {
    for (const endpointRole of ['alpha', 'beta'] as const) {
      const authorityKey = retainedAuthorityKey({ ...request, operationId: request.relationshipId, endpointRole });
      const entry = retained.get(authorityKey);
      if (entry?.targetMachineId === request.targetMachineId && entry.relationshipDefinition) return { authorityKey, entry, relationship: entry.relationshipDefinition };
    }
    return null;
  };

  const findRetainedRecoveryTarget = (request: WorkspaceSyncTargetConflictRecoverV1) => {
    const match = findRetainedTarget(request);
    return match && !('kind' in match.entry) && match.entry.sourceWriterTargetRouting && match.entry.transientAuthority
      ? { authorityKey: match.authorityKey, entry: match.entry } : null;
  };

  const readRetainedTargetRoot = async (authorityKey: string, entry: RetainedBootstrap, rootPath = entry.targetRootPath) => {
    const canonicalRoot = await assertRetainedRootIdentity({ authorityKey, entry, rootPath });
    return { canonicalRoot, assertCurrentAuthority: async () => {
      if (physicalRetained.get(authorityKey) !== entry) {
        throw authorityError('relationship_not_ready', 'The admitted Sync target loan is unavailable');
      }
      await assertRetainedRootIdentity({ authorityKey, entry, rootPath });
    } };
  };

  const resolveRecoveryWorkspace = async (request: WorkspaceSyncTargetConflictRecoverV1,
    context?: WorkspaceSyncConflictRecoveryContext) => {
    // Initial SOURCE admission already lent this physical endpoint to the
    // relationship. Its custodian's Account graph cannot describe that loan.
    const admittedTarget = !context?.getProjectSnapshot && findRetainedRecoveryTarget(request);
    if (admittedTarget) {
      const { authorityKey, entry } = admittedTarget;
      const relationship = entry.relationshipDefinition!;
      const workspace: WorkspaceRefV1 = dependencies.localManagedTarget
        ? resolveWorkspaceRef(getSnapshot(entry.operationId), entry.targetWorkspaceRefId, localServerId)
        : { id: entry.targetWorkspaceRefId, serverId: localServerId, machineId: entry.targetMachineId, rootPath: entry.targetRootPath, createdAtMs: relationship.createdAtMs };
      assertLocalWorkspacePlacement(workspace, localServerId, localMachineId, dependencies.localManagedTarget);
      return { relationship, workspace, transientAccess: await readRetainedTargetRoot(authorityKey, entry, workspace.rootPath) };
    }
    const localResolutionEndpoint = context?.localResolutionEndpoint;
    const readRecoverySnapshot = context?.getProjectSnapshot;
    const getRecoverySnapshot = readRecoverySnapshot ? () => requireSnapshot(readRecoverySnapshot()) : getSnapshot;
    const { relationship, workspace } = resolveOwnedWorkspace(
      getRecoverySnapshot(), request.relationshipId, request.targetWorkspaceRefId, localServerId, 'any',
    );
    if (resolveWorkspaceSyncExecutionMachineIdV1(workspace) !== request.targetMachineId) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict recovery endpoint changed');
    }
    if (relationship.enabled && !readRecoverySnapshot) return { relationship, workspace, transientAccess: null };

    // Initial relationship preparation deliberately leaves the durable graph
    // disabled. Only the already retained controller/target root may settle its
    // journal before engine ingress; a paused row alone grants no recovery loan.
    type Access = Readonly<{ canonicalRoot: string; assertCurrentAuthority(): Promise<void> }>;
    const checkedAccess = (access: Access, localWorkspace: WorkspaceRefV1): Access => ({
      canonicalRoot: access.canonicalRoot,
      assertCurrentAuthority: async () => {
        const current = resolveOwnedWorkspace(getRecoverySnapshot(), relationship.relationshipId, workspace.id, localServerId, 'any');
        if (!areWorkspaceSyncRelationshipDefinitionsEqual(current.relationship, relationship)
          || !isDeepStrictEqual(current.workspace, workspace)
          || !isDeepStrictEqual(resolveWorkspaceRef(getRecoverySnapshot(), localWorkspace.id, localServerId), localWorkspace)) {
          throw authorityError('relationship_not_ready', 'Workspace recovery endpoint is no longer owned by the retained definition');
        }
        const canonicalRoot = await realpath(localWorkspace.rootPath).catch(() => null);
        if (canonicalRoot !== access.canonicalRoot) {
          throw authorityError('root_changed', 'Workspace recovery root identity changed');
        }
        await access.assertCurrentAuthority();
      },
    });
    const localMemberIds = isLocalWorkspace(workspace)
      ? [workspace.id]
      : [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId];
    for (const refId of localMemberIds) {
      const member = resolveWorkspaceRef(getRecoverySnapshot(), refId, localServerId);
      if (!isLocalWorkspace(member)) continue;
      assertLocalWorkspacePlacement(member, localServerId, localMachineId, dependencies.localManagedTarget);
      const controllerAccess = member.id === request.targetWorkspaceRefId && localResolutionEndpoint
        ? localResolutionEndpoint : await dependencies.resolveLocalResolutionEndpoint?.(relationship.relationshipId, member.id);
      if (!controllerAccess?.relationship
        || !areWorkspaceSyncRelationshipDefinitionsEqual(controllerAccess.relationship, relationship)) continue;
      const transientAccess = checkedAccess(controllerAccess, member);
      await transientAccess.assertCurrentAuthority();
      return { relationship, workspace, transientAccess };
    }
    if (!readRecoverySnapshot && isLocalWorkspace(workspace)) {
      assertLocalWorkspacePlacement(workspace, localServerId, localMachineId, dependencies.localManagedTarget);
      const endpointRole = relationship.alphaWorkspaceRefId === workspace.id ? 'alpha' : 'beta';
      const authorityKey = retainedAuthorityKey({ relationshipId: relationship.relationshipId,
        operationId: relationship.relationshipId, endpointRole, targetWorkspaceRefId: workspace.id });
      const entry = physicalRetained.get(authorityKey);
      if (entry?.transientAuthority && relationshipOwnsEndpoint(getRecoverySnapshot(), entry, false)) {
        const canonicalRoot = await assertRetainedRootIdentity({ authorityKey, entry, rootPath: workspace.rootPath });
        const transientAccess = checkedAccess({ canonicalRoot, assertCurrentAuthority: async () => {
          if (physicalRetained.get(authorityKey) !== entry || !entry.transientAuthority
            || !relationshipOwnsEndpoint(getRecoverySnapshot(), entry, false)) {
            throw authorityError('relationship_not_ready', 'Workspace recovery target no longer retains its transient bootstrap');
          }
          await assertRetainedRootIdentity({ authorityKey, entry, rootPath: workspace.rootPath });
        } }, workspace);
        await transientAccess.assertCurrentAuthority();
        return { relationship, workspace, transientAccess };
      }
    }
    throw authorityError('relationship_not_ready', 'Workspace sync disabled endpoint has no current bootstrap recovery custody');
  };

  const approvedResolutionEffect = (request: WorkspaceSyncTargetConflictStageV1 | WorkspaceSyncTargetConflictApplyV1) => {
    if (request.alternativeIndex === null) {
      return {
        source: request.actionInput.source,
        target: request.actionInput.targets.find((candidate) => candidate.workspaceRefId === request.targetWorkspaceRefId),
        sourcePath: request.actionInput.path,
        targetPath: request.actionInput.path,
        kind: 'selected' as const,
      };
    }
    const alternative = request.actionInput.strategy === 'keep_both'
      ? request.actionInput.alternatives[request.alternativeIndex]
      : undefined;
    if (!alternative || alternative.source.expected.kind !== 'file') {
      throw authorityError('approval_stale', 'Reviewed workspace conflict alternative changed');
    }
    return {
      source: alternative.source,
      target: alternative.destination,
      sourcePath: request.actionInput.path,
      targetPath: alternative.destination.path,
      kind: 'alternative' as const,
    };
  };
  const validateResolutionEndpoint = async (
    request: WorkspaceSyncTargetConflictStageV1 | WorkspaceSyncTargetConflictApplyV1,
    endpoint: 'source' | 'target',
  ): Promise<Readonly<{
    relationship: WorkspaceSyncRelationshipV1;
    workspace: WorkspaceRefV1;
    canonicalRoot: string;
    assertCurrentAuthority(): Promise<void>;
  }>> => {
    const effect = approvedResolutionEffect(request);
    if (request.operationId !== deriveWorkspaceSyncConflictOperationId({
        actionReceiptId: request.actionReceiptId,
        kind: effect.kind,
        workspaceRefId: request.targetWorkspaceRefId,
        path: request.path,
        ...(request.alternativeIndex === null ? {} : { alternativeIndex: request.alternativeIndex }),
      })
      || request.actionInput.controllerMachineId !== (getSnapshot(request.relationshipId)?.relationships ?? [])
        .find((relationship) => relationship.relationshipId === request.relationshipId)?.controllerMachineId
      || !request.actionInput.relationshipIds.includes(request.relationshipId)
      || effect.targetPath !== request.path) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict authority changed');
    }
    const snapshot = getSnapshot(request.relationshipId);
    const relationships = (snapshot?.relationships ?? []).filter((candidate) => candidate.enabled);
    const topology = deriveWorkspaceSyncTopology({
      serverId: localServerId,
      workspaceRefs: snapshot?.workspaceRefs ?? [],
      relationships,
    });
    const set = topology.sets.find((candidate) => candidate.hubWorkspaceRefId === request.actionInput.hubWorkspaceRefId
      && candidate.controllerMachineId === request.actionInput.controllerMachineId
      && candidate.relationships.some((member) => member.relationshipId === request.relationshipId));
    const approvedIds = [...request.actionInput.relationshipIds].sort();
    const currentIds = set?.relationships.map((member) => member.relationshipId).sort() ?? [];
    const sourceRelationshipId = 'sourceRelationshipId' in request
      ? request.sourceRelationshipId
      : set?.relationships.find((member) => member.alphaWorkspaceRefId === effect.source.workspaceRefId
        || member.betaWorkspaceRefId === effect.source.workspaceRefId)?.relationshipId;
    if (!set || JSON.stringify(approvedIds) !== JSON.stringify(currentIds)
      || !sourceRelationshipId || !currentIds.includes(sourceRelationshipId)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict linked set changed');
    }
    const sourceMember = set.relationships.find((member) => member.relationshipId === sourceRelationshipId);
    if (!sourceMember || (sourceMember.alphaWorkspaceRefId !== effect.source.workspaceRefId
      && sourceMember.betaWorkspaceRefId !== effect.source.workspaceRefId)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict source link changed');
    }
    const workspaceRefId = endpoint === 'source' && 'sourceWorkspaceRefId' in request
      ? request.sourceWorkspaceRefId
      : request.targetWorkspaceRefId;
    const endpointRelationshipId = endpoint === 'source' ? sourceRelationshipId : request.relationshipId;
    const { relationship, workspace } = resolveOwnedWorkspace(snapshot, endpointRelationshipId, workspaceRefId, localServerId);
    const approvedTarget = effect.target;
    const targetPlacement = resolveOwnedWorkspace(getSnapshot(request.relationshipId), request.relationshipId, request.targetWorkspaceRefId, localServerId).workspace;
    if (!approvedTarget || resolveWorkspaceSyncExecutionMachineIdV1(targetPlacement) !== request.targetMachineId
      || ('targetExpected' in request && JSON.stringify(approvedTarget.expected) !== JSON.stringify(request.targetExpected))) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict destination changed');
    }
    const expectedEndpoint = endpoint === 'source' ? effect.source : effect.target;
    const expected = endpoint === 'source' && 'sourceExpected' in request
      ? request.sourceExpected
      : endpoint === 'target' && 'targetExpected' in request
        ? request.targetExpected
        : expectedEndpoint?.expected;
    if (!expectedEndpoint || expectedEndpoint.workspaceRefId !== workspaceRefId
      || JSON.stringify(expectedEndpoint.expected) !== JSON.stringify(expected)
      || ('sourceMachineId' in request && endpoint === 'source' && resolveWorkspaceSyncExecutionMachineIdV1(workspace) !== request.sourceMachineId)
      || resolveWorkspaceSyncExecutionMachineIdV1(workspace) !== request.targetMachineId && endpoint === 'target') {
      throw authorityError('approval_stale', 'Reviewed workspace conflict endpoint changed');
    }
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId, dependencies.localManagedTarget);
    if (!dependencies.assertConflictResolutionAuthorized) {
      throw authorityError('approval_required', 'Workspace conflict Action receipt authority is unavailable');
    }
    await dependencies.assertConflictResolutionAuthorized(request.actionReceiptId, request.actionInput);
    if (relationship.controllerMachineId === localMachineId && !dependencies.localManagedTarget) {
      const access = await dependencies.resolveLocalResolutionEndpoint?.(relationship.relationshipId, workspace.id);
      if (!access) throw authorityError('workspace_root_ownership_lost', 'Controller does not retain the reviewed workspace endpoint');
      await access.assertCurrentAuthority();
      return { relationship, workspace, ...access };
    }
    const retainedEndpoint = await requireRetainedRelationshipEndpoint({ relationship, workspace });
    return {
      relationship, workspace, canonicalRoot: retainedEndpoint.canonicalRoot,
      assertCurrentAuthority: async () => await assertRetainedRelationshipEndpointCurrent({
        authorityKey: retainedEndpoint.authorityKey,
        entry: retainedEndpoint.entry,
        workspace,
      }),
    };
  };

  const stagedResolutions = new Map<string, Readonly<{
    workspaceRefId: string;
    path: string;
    expectation: import('@happier-dev/protocol').WorkspaceSyncEntryExpectationV1;
    targetExpected: import('@happier-dev/protocol').WorkspaceSyncEntryExpectationV1;
    stagingDirectory: string;
    materialPath: string | null;
  }>>();
  const stagedResolutionKey = (operationId: string, workspaceRefId: string, path: string): string =>
    JSON.stringify([operationId, workspaceRefId, path]);
  const capturedResolutions = new Map<string, Readonly<{
    actionReceiptId: string;
    sourceWorkspaceRefId: string;
    path: string;
    actionInput: WorkspaceSyncConflictResolveActionInputV1;
    expectation: WorkspaceSyncEntryExpectationV1;
    materialPath: string | null;
    captureDirectory: string;
  }>>();
  const capturedResolutionKey = (actionReceiptId: string, sourceWorkspaceRefId: string, path: string, expectation: WorkspaceSyncEntryExpectationV1): string =>
    JSON.stringify([actionReceiptId, sourceWorkspaceRefId, path, expectation]);
  const resolutionDirectory = dependencies.resolutionMaterialDirectory;
  let resolutionDirectoryReady: Promise<string> | null = null;
  const requireResolutionDirectory = async (): Promise<string> => {
    if (!resolutionDirectory) throw authorityError('agent_unavailable', 'Reviewed workspace conflict material directory is unavailable');
    resolutionDirectoryReady ??= (async () => {
      await ensureProtectedLocalStateDirectory(resolutionDirectory, { authority: 'owned' });
      // Captures and successful target stages are process-owned private material,
      // not native recovery evidence. No old daemon operation can still own
      // them when this fresh authority starts.
      for (const entry of await readdir(resolutionDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() && (entry.name.startsWith('capture-') || entry.name.startsWith('stage-'))) {
          await rm(join(resolutionDirectory, entry.name), { recursive: true, force: true });
        }
      }
      return resolutionDirectory;
    })().catch((error: unknown) => {
      resolutionDirectoryReady = null;
      throw error;
    });
    return await resolutionDirectoryReady;
  };
  const recoverConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictRecoverV1,
    signal?: AbortSignal,
    context?: WorkspaceSyncConflictRecoveryContext,
  ): Promise<WorkspaceSyncTargetConflictRecoverResultV1> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictRecoverV1Schema.parse(rawRequest);
    const native = await nativeExecutionForEndpoint(request.targetWorkspaceRefId, request.relationshipId, request.relationshipId);
    if (native) return await native.recoverConflictResolutionHere(request, signal);
    const { relationship, workspace, transientAccess } = await resolveRecoveryWorkspace(request, context);
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId, dependencies.localManagedTarget);
    const recoveryDirectory = await requireResolutionDirectory();
    const records = await (dependencies.discoverConflictRecovery ?? discoverNativeConfinedWorkspaceSyncRecovery)({ recoveryDirectory });
    if (records.length === 0) {
      await transientAccess?.assertCurrentAuthority();
      return { status: 'settled' };
    }
    const canonicalRoot = await realpath(workspace.rootPath);
    const matching = records.filter((record) => record.rootPath === canonicalRoot);
    if (matching.length === 0) {
      await transientAccess?.assertCurrentAuthority();
      return { status: 'settled' };
    }
    let access = transientAccess ?? context?.localResolutionEndpoint
      ?? await dependencies.resolveLocalResolutionEndpoint?.(relationship.relationshipId, workspace.id) ?? null;
    let release: (() => Promise<void>) | null = null;
    if (!access) {
      try {
        const retainedEndpoint = await requireRetainedRelationshipEndpoint({ relationship, workspace });
        access = {
          canonicalRoot: retainedEndpoint.canonicalRoot,
          assertCurrentAuthority: async () => await assertRetainedRelationshipEndpointCurrent({
            authorityKey: retainedEndpoint.authorityKey,
            entry: retainedEndpoint.entry,
            workspace,
          }),
        };
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'relationship_not_ready') throw error;
        if (!bootstrap) throw error;
        const acquired = await bootstrap.rootOwnershipManager.tryAcquire({
          ownerId: `workspace-sync-recovery:${relationship.relationshipId}:${workspace.id}`,
          canonicalRoot,
          operation: 'sync',
        });
        if ('kind' in acquired) throw authorityError('workspace_root_in_use', 'Workspace conflict recovery root overlaps an active operation');
        access = {
          canonicalRoot: acquired.owner.canonicalRoot,
          assertCurrentAuthority: async () => {
            if (acquired.owner.rootFingerprint === null
              || await computeWorkspaceSyncRootFingerprint(acquired.owner.canonicalRoot) !== acquired.owner.rootFingerprint) {
              throw authorityError('workspace_root_ownership_lost', 'Workspace conflict recovery root identity changed');
            }
          },
        };
        release = acquired.release;
      }
    }
    try {
      if (!access) throw authorityError('workspace_root_ownership_lost', 'Workspace conflict recovery root is unavailable');
      if (access.canonicalRoot !== canonicalRoot) throw authorityError('workspace_root_ownership_lost', 'Reviewed workspace recovery root changed');
      await access.assertCurrentAuthority();
      for (const record of matching) {
        signal?.throwIfAborted();
        const outcome = await (dependencies.recoverConflictEntry ?? recoverWorkspaceSyncEntryReplacementAtRoot)({
          rootPath: access.canonicalRoot,
          recoveryDirectory,
          operationId: record.operationId,
          assertCurrentAuthority: access.assertCurrentAuthority,
        });
        if (outcome.status === 'recovery_needed') {
          return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(outcome);
        }
      }
      return { status: 'settled' };
    } finally {
      await release?.();
    }
  };
  const prepareConflictResolutionExport = async (
    rawRequest: WorkspaceSyncTargetConflictStageV1,
  ): ReturnType<typeof createWorkspaceSyncEntryExport> => {
    const request = WorkspaceSyncTargetConflictStageV1Schema.parse(rawRequest);
    const source = await validateResolutionEndpoint(request, 'source');
    const effect = approvedResolutionEffect(request);
    const cacheKey = capturedResolutionKey(request.actionReceiptId, request.sourceWorkspaceRefId, effect.sourcePath, request.sourceExpected);
    const retained = capturedResolutions.get(cacheKey);
    if (retained) {
      if (retained.sourceWorkspaceRefId !== request.sourceWorkspaceRefId || retained.path !== effect.sourcePath
        || JSON.stringify(retained.actionInput) !== JSON.stringify(request.actionInput)
        || JSON.stringify(retained.expectation) !== JSON.stringify(request.sourceExpected)) {
        throw authorityError('approval_stale', 'Reviewed workspace conflict capture owner changed');
      }
      const exported = await createWorkspaceSyncEntryExport({
        operationId: request.operationId,
        expectation: retained.expectation,
        materialPath: retained.materialPath,
      });
      return exported;
    }
    const directory = await requireResolutionDirectory();
    const captureDirectory = await mkdtemp(join(directory, 'capture-'));
    try {
      const captured = await captureWorkspaceSyncEntryAtRoot({
        rootPath: source.canonicalRoot,
        relativePath: effect.sourcePath,
        expected: request.sourceExpected,
        captureDirectory,
        operationId: deriveWorkspaceSyncConflictOperationId({
          actionReceiptId: request.actionReceiptId,
          kind: 'capture',
          workspaceRefId: request.sourceWorkspaceRefId,
          path: effect.sourcePath,
        }),
        assertCurrentAuthority: source.assertCurrentAuthority,
      });
      const exported = await createWorkspaceSyncEntryExport({
        operationId: request.operationId,
        expectation: captured.expectation,
        materialPath: captured.materialPath,
      });
      capturedResolutions.set(cacheKey, {
        actionReceiptId: request.actionReceiptId,
        sourceWorkspaceRefId: request.sourceWorkspaceRefId,
        path: effect.sourcePath,
        actionInput: request.actionInput,
        expectation: captured.expectation,
        materialPath: captured.materialPath,
        captureDirectory,
      });
      return exported;
    } catch (error) {
      await rm(captureDirectory, { recursive: true, force: true });
      throw error;
    }
  };
  const releaseConflictResolutionCaptureHere = async (rawRequest: WorkspaceSyncConflictCaptureReleaseV1): Promise<void> => {
    const request = WorkspaceSyncConflictCaptureReleaseV1Schema.parse(rawRequest);
    const native = await nativeExecutionForEndpoint(request.sourceWorkspaceRefId);
    if (native) return await native.releaseConflictResolutionCaptureHere(request);
    if (request.operationId !== request.actionReceiptId || request.sourceMachineId !== localMachineId) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict capture owner changed');
    }
    for (const [key, captured] of capturedResolutions) {
      if (captured.actionReceiptId !== request.actionReceiptId) continue;
      if (JSON.stringify(captured.actionInput) !== JSON.stringify(request.actionInput)) {
        throw authorityError('approval_stale', 'Reviewed workspace conflict capture owner changed');
      }
      await rm(captured.captureDirectory, { recursive: true, force: true });
      capturedResolutions.delete(key);
    }
  };
  const stageConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictStageV1,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictStageV1Schema.parse(rawRequest);
    const native = await nativeExecutionForEndpoint(request.targetWorkspaceRefId, request.relationshipId, request.relationshipId);
    if (native) return await native.stageConflictResolutionHere(request, signal);
    const target = await validateResolutionEndpoint(request, 'target');
    const effect = approvedResolutionEffect(request);
    const source = resolveOwnedWorkspace(getSnapshot(request.sourceRelationshipId), request.sourceRelationshipId, request.sourceWorkspaceRefId, localServerId).workspace;
    if (resolveWorkspaceSyncExecutionMachineIdV1(source) !== request.sourceMachineId || request.sourceWorkspaceRefId !== effect.source.workspaceRefId
      || JSON.stringify(request.sourceExpected) !== JSON.stringify(effect.source.expected)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict source changed');
    }
    if (!dependencies.requestResolutionExport) {
      throw authorityError('agent_unavailable', 'Reviewed workspace conflict transfer is unavailable');
    }
    const stagedKey = stagedResolutionKey(request.operationId, target.workspace.id, request.path);
    if (stagedResolutions.has(stagedKey)) {
      throw authorityError('conflict_changed', 'Reviewed workspace conflict material is already staged for this endpoint');
    }
    const directory = await requireResolutionDirectory();
    const stagingDirectory = await mkdtemp(join(directory, 'stage-'));
    let remote: Awaited<ReturnType<NonNullable<typeof dependencies.requestResolutionExport>>> | null = null;
    try {
      remote = await dependencies.requestResolutionExport({ ...request, ...(signal ? { signal } : {}) });
      const materialPath = await stageWorkspaceSyncEntryExport({
        operationId: request.operationId,
        stagingDirectory,
        expectation: request.sourceExpected,
        requestPayload: remote.requestPayload,
      });
      await target.assertCurrentAuthority();
      stagedResolutions.set(stagedKey, {
        workspaceRefId: target.workspace.id,
        path: request.path,
        expectation: request.sourceExpected,
        targetExpected: request.targetExpected,
        stagingDirectory,
        materialPath,
      });
    } catch (error) {
      stagedResolutions.delete(stagedKey);
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      // The finite-transfer owner also expires an unreleased export. Failure
      // to release it cannot invalidate already verified target material.
      await remote?.release().catch(() => undefined);
    }
  };
  const applyStagedConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictApplyV1,
    signal?: AbortSignal,
  ): Promise<WorkspaceSyncTargetConflictApplyResultV1> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictApplyV1Schema.parse(rawRequest);
    const native = await nativeExecutionForEndpoint(request.targetWorkspaceRefId, request.relationshipId, request.relationshipId);
    if (native) return await native.applyStagedConflictResolutionHere(request, signal);
    const target = await validateResolutionEndpoint(request, 'target');
    const effect = approvedResolutionEffect(request);
    const stagedKey = stagedResolutionKey(request.operationId, target.workspace.id, request.path);
    const staged = stagedResolutions.get(stagedKey);
    if (!staged || staged.workspaceRefId !== target.workspace.id || staged.path !== request.path
      || JSON.stringify(staged.expectation) !== JSON.stringify(effect.source.expected)
      || JSON.stringify(staged.targetExpected) !== JSON.stringify(effect.target?.expected)) {
      throw authorityError('conflict_changed', 'Reviewed workspace conflict staging is no longer available');
    }
    const recoveryDirectory = await requireResolutionDirectory();
    const outcome = await applyCapturedWorkspaceSyncEntryAtRoot({
        rootPath: target.canonicalRoot,
        relativePath: request.path,
        expectedDestination: staged.targetExpected,
        selectedExpectation: staged.expectation,
        materialPath: staged.materialPath,
        recoveryDirectory,
        operationId: request.operationId,
        assertCurrentAuthority: target.assertCurrentAuthority,
    });
    if (outcome.status !== 'recovery_needed') {
      stagedResolutions.delete(stagedKey);
      await rm(staged.stagingDirectory, { recursive: true, force: true });
    }
    return WorkspaceSyncTargetConflictApplyResultV1Schema.parse(outcome);
  };
  const discardStagedConflictResolutionHere = async (
    rawRequest: WorkspaceSyncTargetConflictApplyV1,
    signal?: AbortSignal,
  ): Promise<void> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetConflictApplyV1Schema.parse(rawRequest);
    const native = await nativeExecutionForEndpoint(request.targetWorkspaceRefId, request.relationshipId, request.relationshipId);
    if (native) return await native.discardStagedConflictResolutionHere(request, signal);
    const effect = approvedResolutionEffect(request);
    const stagedKey = stagedResolutionKey(request.operationId, request.targetWorkspaceRefId, request.path);
    const staged = stagedResolutions.get(stagedKey);
    if (!staged) return;
    if (request.operationId !== deriveWorkspaceSyncConflictOperationId({
        actionReceiptId: request.actionReceiptId,
        kind: effect.kind,
        workspaceRefId: request.targetWorkspaceRefId,
        path: request.path,
        ...(request.alternativeIndex === null ? {} : { alternativeIndex: request.alternativeIndex }),
      })
      || request.targetMachineId !== localMachineId
      || effect.target?.workspaceRefId !== request.targetWorkspaceRefId
      || effect.targetPath !== request.path
      || JSON.stringify(staged.expectation) !== JSON.stringify(effect.source.expected)
      || JSON.stringify(staged.targetExpected) !== JSON.stringify(effect.target?.expected)) {
      throw authorityError('approval_stale', 'Reviewed workspace conflict stage owner changed');
    }
    await rm(staged.stagingDirectory, { recursive: true, force: true });
    stagedResolutions.delete(stagedKey);
  };

  // A writer-routed read serves only what the relationship's content policy syncs,
  // decided by the same selection owner as the seed export.
  const assertWriterReadSelection = async (root: string, path: string, policy: WorkspaceContentPolicyV1) => {
    const selected = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace({ sourcePath: root,
      workspaceTransfer: resolveWorkspaceSyncSeedTransfer(policy), registry: dependencies.scmRegistry });
    if (!selected.entries.some(entry => entry.relativePath === path)) {
      throw authorityError('forbidden', 'Workspace Sync read is outside the target content policy');
    }
  };

  const resolveTargetRead = async (request: WorkspaceSyncTargetEntryObserveV1,
    context?: RpcHandlerContext, admittedWriterRead?: true) => {
    const routing = await readSourceWriterTargetRouting(context, 'inspect');
    if (routing || admittedWriterRead) {
      const match = findRetainedTarget({ relationshipId: request.relationshipId,
        targetMachineId: localMachineId, targetWorkspaceRefId: request.workspaceRefId });
      if (!match || (routing ? !isAdmittedBySourceWriter(match.entry, routing)
        && !isRestoredInstalledWriter(match.entry, routing) : !match.entry.sourceWriterTargetRouting)) {
        throw authorityError('forbidden', 'Workspace Sync read does not match retained target custody');
      }
      // The worker holds the corresponding retained loan and sees its own filesystem.
      if ('kind' in match.entry) return { native: match.entry.execution, admittedWriterRead: true as const };
      if (!match.entry.readyPublished) throw authorityError('relationship_not_ready', 'Workspace Sync target is not ready');
      const access = await readRetainedTargetRoot(match.authorityKey, match.entry);
      await assertWriterReadSelection(access.canonicalRoot, request.path, match.relationship.contentPolicy);
      return access;
    }
    const native = await nativeExecutionForEndpoint(request.workspaceRefId, request.relationshipId, request.relationshipId);
    if (native) return { native };
    const { relationship, workspace } = resolveOwnedWorkspace(getSnapshot(request.relationshipId), request.relationshipId, request.workspaceRefId, localServerId);
    assertLocalWorkspacePlacement(workspace, localServerId, localMachineId, dependencies.localManagedTarget);
    const { authorityKey, entry, canonicalRoot } = await requireRetainedRelationshipEndpoint({ relationship, workspace });
    return { canonicalRoot, assertCurrentAuthority: () => assertRetainedRelationshipEndpointCurrent({ authorityKey, entry, workspace }) };
  };

  const readFileHere = async (
    rawRequest: WorkspaceSyncTargetFileReadV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
    admittedWriterRead?: true,
  ): Promise<ReadWorkspaceSyncFileResultV1> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetFileReadV1Schema.parse(rawRequest);
    const access = await resolveTargetRead(request, context, admittedWriterRead);
    if ('native' in access) return await access.native.readFileHere(request, signal, undefined, access.admittedWriterRead);
    signal?.throwIfAborted();
    return ReadWorkspaceSyncFileResultV1Schema.parse(await readWorkspaceSyncFileAtRoot({
      rootPath: access.canonicalRoot,
      relativePath: request.path,
      maxBytes: request.maxBytes,
      ...(request.expectedDigest === undefined ? {} : { expectedDigest: request.expectedDigest }),
      assertCurrentAuthority: access.assertCurrentAuthority,
    }));
  };

  const observeEntryHere = async (
    rawRequest: WorkspaceSyncTargetEntryObserveV1,
    signal?: AbortSignal,
    context?: RpcHandlerContext,
    admittedWriterRead?: true,
  ): Promise<WorkspaceSyncEntryExpectationV1> => {
    signal?.throwIfAborted();
    const request = WorkspaceSyncTargetEntryObserveV1Schema.parse(rawRequest);
    const access = await resolveTargetRead(request, context, admittedWriterRead);
    if ('native' in access) return await access.native.observeEntryHere(request, signal, undefined, access.admittedWriterRead);
    signal?.throwIfAborted();
    return WorkspaceSyncEntryExpectationV1Schema.parse(await observeWorkspaceSyncEntryAtRoot({
      rootPath: access.canonicalRoot,
      relativePath: request.path,
      assertCurrentAuthority: access.assertCurrentAuthority,
    }));
  };

  // Controller-owned local endpoints and retained target endpoints share the
  // same rooted-agent/listener custody and shutdown map.
  type AdmittedMachineAgent = WorkspaceSyncMachineAgentDescriptor & Readonly<{ authorityKey: string; nativeTarget?: ManagedWorkspaceRefV2; assertCurrent(): void }>;
  const withMachineIngressEndpoint = async <T>(request: AcquireWorkspaceSyncMachineIngressRequest,
    consume: (endpoint: AdmittedMachineAgent) => T | Promise<T>): Promise<T> => {
      request.signal?.throwIfAborted();
      if (closing) throw authorityError('peer_unavailable', 'Workspace sync target authority is shutting down', 'authority_closing');
      const facts = {
        operationId: request.operationId.trim(),
        sourceMachineId: request.sourceMachineId.trim(),
        targetMachineId: request.targetMachineId.trim(),
      };
      if (request.expiresAtMs !== undefined && request.expiresAtMs <= Date.now()) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress authorization expired', 'authorization_expired');
      }
      if (Object.values(facts).some((value) => !value)) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress identity is incomplete', 'identity_incomplete');
      }
      if (facts.targetMachineId !== localMachineId) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress targets another daemon', 'target_machine_mismatch');
      }
      return await exclusive(`machine-ingress:${facts.operationId}:${facts.sourceMachineId}:${facts.targetMachineId}`, async () => {
      let matches = [...retained.entries()].filter(([, entry]) => (
        entry.operationId === facts.operationId
        && entry.sourceMachineId === facts.sourceMachineId
        && entry.targetMachineId === facts.targetMachineId
      ));
      if (matches.length === 0) {
        // Restart rehydration restores installed custody only, so its actor is
        // the local Account; refuse another actor before re-taking the root.
        if (request.actorAccountId !== undefined && request.actorAccountId !== dependencies.localAccountId) {
          throw authorityError('peer_unavailable', 'Workspace sync machine ingress belongs to another Account', 'rehydration_actor_mismatch');
        }
        await rehydrateIngressOwner(facts);
        matches = [...retained.entries()].filter(([, entry]) => (
          entry.operationId === facts.operationId
          && entry.sourceMachineId === facts.sourceMachineId
          && entry.targetMachineId === facts.targetMachineId
        ));
      }
      if (matches.length !== 1) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress is not owned by a ready target',
          matches.length === 0 ? 'ready_target_missing' : 'ready_target_ambiguous');
      }
      const [authorityKey, entry] = matches[0]!;
      if ('kind' in entry) {
        // The retained native execution owns the admitted requester Account;
        // its physical endpoint authorizes ingress under that custody.
        const descriptor = await entry.execution.authorizeWorkspaceSyncMachineAgent(request);
        const assertCurrent = () => {
          const current = retained.get(authorityKey);
          if (!current || !('kind' in current) || current.execution !== entry.execution
            || current.result.rootFingerprint !== entry.result.rootFingerprint) {
            throw authorityError('peer_unavailable', 'Workspace sync target ownership ended before ingress was ready', 'target_ownership_ended');
          }
        };
        assertCurrent();
        return await consume({ ...descriptor, authorityKey, nativeTarget: entry.workspace, assertCurrent });
      }
      const actorAccountId = entry.targetRouting?.targetContext.machineAdmission.actorAccountId
        ?? dependencies.localAccountId;
      if (request.actorAccountId !== undefined && request.actorAccountId !== actorAccountId) {
        throw authorityError('peer_unavailable', 'Workspace sync machine ingress belongs to another Account', 'retained_actor_mismatch');
      }
      // A signed SOURCE preparation lends this endpoint to its requester.
      // The custodian's Account graph does not contain that requester's ref;
      // the retained preparation owns its placement and root until release.
      let targetRootPath = entry.targetRootPath;
      if (!entry.transientAuthority || !entry.sourceWriterTargetRouting) {
        const target = resolveWorkspaceRef(getSnapshot(entry.operationId), entry.targetWorkspaceRefId, localServerId);
        assertLocalWorkspacePlacement(target, localServerId, localMachineId, dependencies.localManagedTarget);
        targetRootPath = target.rootPath;
      }
      const currentRoot = await assertRetainedRootIdentity({
        authorityKey,
        entry,
        rootPath: targetRootPath,
      });

      const endpoint: AdmittedMachineAgent = { authorityKey, operationId: facts.operationId,
        role: entry.endpointRole, workspaceRefId: entry.targetWorkspaceRefId, canonicalRoot: currentRoot,
        assertCurrent: () => {
          if (physicalRetained.get(authorityKey) !== entry) throw authorityError('peer_unavailable', 'Workspace sync target ownership ended before ingress was ready', 'target_ownership_ended');
          if (entry.relationshipId && !entry.transientAuthority && !relationshipStillOwnsEndpoint(getSnapshot(entry.operationId), entry)) {
            throw authorityError('relationship_not_ready', 'Workspace sync relationship no longer owns the target endpoint');
          }
        } };
      endpoint.assertCurrent();
      return await consume(endpoint);
      });
  };

  const openLocalAgentIngress = async (request: Readonly<{ signal?: AbortSignal; expiresAtMs?: number }>, input: Readonly<{
    authorityKey: string; operationId: string; role: 'alpha' | 'beta'; workspaceRefId: string; canonicalRoot: string;
    nativeTarget?: ManagedWorkspaceRefV2; assertCurrent(): void;
  }>): Promise<WorkspaceSyncMachineIngress> => {
    const openRootedAgent = dependencies.openRootedAgent;
    const openNativeRootedAgent = dependencies.openNativeRootedAgent;
    if (input.nativeTarget ? !openNativeRootedAgent : !openRootedAgent) throw authorityError('agent_unavailable', 'Verified rooted workspace sync agent is unavailable');
    if ((activeIngresses.get(input.authorityKey)?.size ?? 0) > 0) {
      throw authorityError('peer_unavailable', 'Workspace sync machine ingress is already active', 'ingress_active');
    }
    return openWorkspaceSyncMachineIngress(request, {
      openAgent: signal => {
        const descriptor = { operationId: input.operationId, role: input.role,
          workspaceRefId: input.workspaceRefId, canonicalRoot: input.canonicalRoot, signal };
        return input.nativeTarget ? openNativeRootedAgent!({ ...descriptor, target: input.nativeTarget }) : openRootedAgent!(descriptor);
      },
      assertCurrent: input.assertCurrent,
      isClosing: () => closing,
      retain: close => {
        const closers = activeIngresses.get(input.authorityKey) ?? new Set<() => Promise<void>>();
        closers.add(close);
        activeIngresses.set(input.authorityKey, closers);
        notifyActivity();
        return () => {
          closers.delete(close);
          if (closers.size === 0) activeIngresses.delete(input.authorityKey);
          notifyActivity();
        };
      },
    });
  };

  // A retained TARGET loan is this admitted work only for the same SOURCE writer,
  // requester Account and placement its stored signed admission names.
  const isAdmittedBySourceWriter = (entry: RetainedBootstrap | RetainedNativeBootstrap, routing: Pick<RetainedSourceWriterTargetRouting, 'sourceWriter' | 'source'>
    & Readonly<{ target: Pick<RetainedSourceWriterTargetRouting['target'], 'targetMachineId' | 'targetRootPath'> }>) => {
    const admitted = entry.sourceWriterTargetRouting;
    return admitted !== undefined && isDeepStrictEqual(routing.sourceWriter, admitted.sourceWriter)
      && routing.source.sourceContext.machineAdmission.actorAccountId === admitted.source.sourceContext.machineAdmission.actorAccountId
      && routing.source.sourceMachineId === entry.sourceMachineId && routing.source.sourceRootPath === entry.sourceRootPath
      && routing.target.targetMachineId === entry.targetMachineId && routing.target.targetRootPath === entry.targetRootPath;
  };

  // Reloaded physical endpoints use the installed Account's committed binding.
  // Home has already verified the installed SOURCE; READY bound the exact two roots.
  const isRestoredInstalledWriter = (entry: RetainedBootstrap | RetainedNativeBootstrap,
    routing: RetainedSourceWriterTargetRouting): boolean => {
    if ('kind' in entry || entry.sourceWriterTargetRouting || entry.transientAuthority
      || !entry.readyPublished || !entry.relationshipDefinition
      || getWorkspaceSyncWorkerCopyV1(entry.relationshipDefinition) !== null && entry.relationshipDefinition.committedAtMs == null
      || routing.source.sourceContext.machineAdmission.actorAccountId !== dependencies.localAccountId
      || routing.sourceWriter.machineId !== entry.relationshipDefinition.controllerMachineId
      || routing.source.sourceMachineId !== entry.sourceMachineId || routing.source.sourceRootPath !== entry.sourceRootPath
      || routing.target.targetMachineId !== entry.targetMachineId || routing.target.targetRootPath !== entry.targetRootPath
      || routing.target.targetManaged !== undefined
      || !relationshipStillOwnsEndpoint(readSnapshot(), entry)) return false;
    const binding = entry.requesterCopyCustody;
    return binding === undefined || isDeepStrictEqual(routing.sourceWriter, binding.sourceWriter);
  };

  // Another person's Machine holds no requester Account custody. A signed writer's
  // Replace then finds the person's own link through the loan its signed admission made.
  const resolveAdmittedReplacementLoan = (rawRouting: unknown, request: HandoffTargetReplacementPreflightV1) => {
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(rawRouting);
    for (const relationshipId of [deriveWorkspaceSyncRelationshipId(request.operationId), request.replaceRelationshipId]) {
      const matches = [...physicalRetained.values()].filter(entry => entry.relationshipId === relationshipId
        && entry.endpointRole === 'beta' && entry.relationshipDefinition && isAdmittedBySourceWriter(entry, routing));
      const relationship = matches.length === 1 ? matches[0]!.relationshipDefinition : null;
      if (!relationship) continue;
      const entry = matches[0]!;
      return { relationship, target: { id: entry.targetWorkspaceRefId, serverId: localServerId,
        machineId: entry.targetMachineId, rootPath: entry.targetRootPath, createdAtMs: relationship.createdAtMs } satisfies WorkspaceRefV1 };
    }
    return null;
  };

  // One retained native loan owns preview, dependency observation and reviewed removal.
  // Home authenticates the installed SOURCE transport; this owner binds its original requester and exact physical copy.
  const resolveRetainedCopyCustody = async (request: Readonly<{
    relationshipId: string; targetWorkspaceRefId?: string;
    expectedRelationship?: WorkspaceSyncRelationshipV1;
    sourceWorkspace?: Readonly<{ serverId: string; refId: string }>;
    sourceMachineId?: string;
  }>, context: RpcHandlerContext, phase: 'inspect' | 'dependencies' | 'remove') => {
    const routing = await readSourceWriterTargetRouting(context, phase);
    if (!routing) throw authorityError('forbidden', 'Workspace copy requires its original source writer');
    const localInstallationId = readInstallationIdentityIfExistsSync()?.installationId;
    const matchesBinding = (binding: WorkspaceSyncRequesterCopyCustody, targetWorkspaceRefId: string,
      targetRootPath: string, endpointRole: 'alpha' | 'beta') => {
      const relationship = binding.relationship;
      const workerCopy = getWorkspaceSyncWorkerCopyV1(relationship);
      return binding.accountServerId === localServerId
        && binding.actorAccountId === routing.source.sourceContext.machineAdmission.actorAccountId
        && isDeepStrictEqual(binding.sourceWriter, routing.sourceWriter)
        && binding.sourceWorkspace.machineId === routing.source.sourceMachineId
        && binding.sourceWorkspace.rootPath === routing.source.sourceRootPath
        && binding.target.machineId === localMachineId && binding.target.machineId === routing.target.targetMachineId
        && binding.target.installationId === localInstallationId
        && targetRootPath === routing.target.targetRootPath
        && relationship.relationshipId === request.relationshipId
        && (endpointRole === 'alpha' ? relationship.alphaWorkspaceRefId : relationship.betaWorkspaceRefId) === targetWorkspaceRefId
        && workerCopy?.sourceWorkspaceRefId === binding.sourceWorkspace.id && workerCopy.targetWorkspaceRefId === targetWorkspaceRefId
        && (request.targetWorkspaceRefId === undefined || request.targetWorkspaceRefId === targetWorkspaceRefId)
        && (request.sourceMachineId === undefined || request.sourceMachineId === binding.sourceWorkspace.machineId)
        && (request.sourceWorkspace === undefined || request.sourceWorkspace.refId === binding.sourceWorkspace.id
          && request.sourceWorkspace.serverId === localServerId)
        && (request.expectedRelationship === undefined || areWorkspaceSyncRelationshipDefinitionsEqual(request.expectedRelationship, relationship)
          && areWorkspaceSyncWorkerCopyProvenancesEqual(request.expectedRelationship, relationship));
    };
    let matches = [...physicalRetained.entries()].filter(([, entry]) => entry.relationshipId === request.relationshipId
      && (request.targetWorkspaceRefId === undefined || entry.targetWorkspaceRefId === request.targetWorkspaceRefId));
    let restoredBindingMatched = false;
    if (matches.length === 0 && bootstrap) {
      // Only the native creation's durable binding can restore a foreign copy. The
      // newly authenticated route is compared with that identity, never adopted.
      const facts = await Promise.all((['alpha', 'beta'] as const).map(role =>
        readWorkspaceSyncFinalReadyFact(bootstrap.materializationDirectory, request.relationshipId, role)));
      const candidates = facts.filter(fact => fact?.v === 2 && fact.relationshipId === request.relationshipId
        && fact.policyDigest === fact.requesterCopyCustody.relationship.contentPolicy.policyDigest
        && matchesBinding(fact.requesterCopyCustody, fact.targetWorkspaceRefId, fact.canonicalRoot, fact.endpointRole));
      const fact = candidates.length === 1 ? candidates[0] : undefined;
      if (fact?.v === 2) {
        const binding = fact.requesterCopyCustody;
        await rehydrateRelationshipEndpoint({ relationship: binding.relationship, endpointRole: fact.endpointRole,
          sourceWorkspace: { ...binding.sourceWorkspace, serverId: localServerId, createdAtMs: binding.relationship.createdAtMs },
          targetWorkspace: { id: fact.targetWorkspaceRefId, serverId: localServerId, machineId: localMachineId,
            rootPath: fact.canonicalRoot, createdAtMs: binding.relationship.createdAtMs },
          projectSnapshot: null, requesterCopyCustody: binding, recoverMaterializationOnly: true });
        matches = [...physicalRetained.entries()].filter(([, entry]) => entry.relationshipId === request.relationshipId
          && entry.targetWorkspaceRefId === fact.targetWorkspaceRefId);
        restoredBindingMatched = true;
      }
    }
    const match = matches.length === 1 ? matches[0] : undefined;
    const entry = match?.[1];
    if (!match || !entry || !entry.relationshipDefinition || !entry.sourceRootPath
      || (entry.requesterCopyCustody
        ? !restoredBindingMatched && !matchesBinding(entry.requesterCopyCustody, entry.targetWorkspaceRefId, entry.targetRootPath, entry.endpointRole)
        : !isAdmittedBySourceWriter(entry, routing)
          && !(phase === 'dependencies' && isRestoredInstalledWriter(entry, routing))
          || request.sourceMachineId !== undefined && request.sourceMachineId !== entry.sourceMachineId
          || request.sourceWorkspace !== undefined && (request.sourceWorkspace.refId !== entry.sourceWorkspaceRefId
            || request.sourceWorkspace.serverId !== localServerId)
          || request.expectedRelationship !== undefined && (
            !areWorkspaceSyncRelationshipDefinitionsEqual(request.expectedRelationship, entry.relationshipDefinition)
            || !areWorkspaceSyncWorkerCopyProvenancesEqual(request.expectedRelationship, entry.relationshipDefinition)))) {
      throw authorityError('forbidden', 'Workspace copy does not match retained requester custody');
    }
    const [authorityKey] = match;
    const relationship = entry.relationshipDefinition;
    const workspace: WorkspaceRefV1 = { id: entry.targetWorkspaceRefId, serverId: localServerId,
      machineId: entry.targetMachineId, rootPath: entry.targetRootPath, createdAtMs: relationship.createdAtMs };
    const sourceWorkspace: WorkspaceRefV1 = { id: entry.sourceWorkspaceRefId, serverId: localServerId,
      machineId: entry.sourceMachineId, rootPath: entry.sourceRootPath, createdAtMs: relationship.createdAtMs };
    const assertCurrent = async () => {
      if (physicalRetained.get(authorityKey) !== entry) throw authorityError('relationship_not_ready', 'Workspace copy custody is unavailable');
      await assertRetainedRootIdentity({ authorityKey, entry, rootPath: workspace.rootPath });
    };
    await assertCurrent();
    return { authorityKey, entry, relationship, workspace, sourceWorkspace, assertCurrent };
  };

  const assertRetainedCopyRetirement = (request: WorkspaceSyncCommittedCopyRequest, context?: RpcHandlerContext) => {
    const routing = context?.workspaceSyncSourceWriterTargetRouting;
    if (routing && (!context?.callerInputAuthorization || !doesWorkspaceSyncCopyRetirementRequestMatchV1(
      context.callerInputAuthorization, routing, parseCommittedCopy(request).parsed))) {
      throw authorityError('forbidden', 'Workspace copy removal requires the current reviewed retirement');
    }
  };

  const prepareCommittedCopyHere = async (
    request: WorkspaceSyncCommittedCopyRequest,
    context: RpcHandlerContext | undefined,
    phase: 'inspect' | 'remove',
  ) => {
    assertRetainedCopyRetirement(request, context);
    await assertCommittedCopyApproved(request);
    return context?.workspaceSyncSourceWriterTargetRouting
      ? await resolveRetainedCopyCustody({
          relationshipId: request.actionInput.expectedRelationship.relationshipId,
          targetWorkspaceRefId: request.actionInput.removeTargetCopy!.workspaceRefId,
          expectedRelationship: request.actionInput.expectedRelationship,
          sourceWorkspace: request.actionInput.workspace,
          sourceMachineId: request.actionInput.machineId,
        }, context, phase)
      : null;
  };
  const localAdmittedTarget = (
    workspace: WorkspaceRefV1 | null,
    rootPath: string,
    signal?: AbortSignal,
  ): Awaited<ReturnType<typeof bindReplacementTarget>> => ({
    machineId: localMachineId, rootPath, approvalRoot: null, facts: [],
    ...(workspace ? { workspace, endpoint: workspace } : { workspace: null, endpoint: null }),
    physicalEndpoint: undefined,
    assertCurrent: async () => { signal?.throwIfAborted(); },
  });
  const callAtTarget = async <TResult>(input: Readonly<{
    machineId: string;
    method: string;
    request: unknown;
    signal?: AbortSignal;
    local: () => Promise<TResult>;
    isLocal: boolean;
    parse: (raw: unknown) => TResult;
  }>): Promise<TResult> => {
    if (input.isLocal) return await input.local();
    return input.parse(await callMachineRpc({
      machineId: input.machineId,
      method: input.method,
      request: input.request,
      ...(input.signal ? { signal: input.signal } : {}),
    }));
  };
  const assertOwnedTargetWorkspace = (relationshipId: string, workspaceRefId: string, targetMachineId: string, staleMessage?: string) => {
    const { workspace } = resolveOwnedWorkspace(getSnapshot(relationshipId), relationshipId, workspaceRefId, localServerId);
    if (staleMessage) {
      if (resolveWorkspaceSyncExecutionMachineIdV1(workspace) !== targetMachineId) throw authorityError('approval_stale', staleMessage);
    } else {
      assertTargetMachine(workspace, targetMachineId);
    }
    return workspace;
  };
  const verifyRetainedRootOrDiscard = async (
    authorityKey: string,
    entry: RetainedBootstrap,
    targetRootPath: string,
    errorMessage: string,
  ): Promise<void> => {
    const currentRoot = await realpath(targetRootPath).catch(() => null);
    const currentFingerprint = currentRoot ? await computeWorkspaceSyncRootFingerprint(currentRoot).catch(() => null) : null;
    if (currentRoot !== entry.handle.owner.canonicalRoot || currentFingerprint !== entry.result.rootFingerprint) {
      await discardRetained(authorityKey);
      throw authorityError('root_changed', errorMessage);
    }
  };
  const parseVoidOk = (raw: unknown): void => { assertOkResult(raw); };
  // The installed SOURCE writer reads its exact retained TARGET endpoint through
  // Home's writer-target admission (current writer custody, the writer's access to
  // the TARGET Machine) and the TARGET's retained-custody match. A raw Account RPC
  // to another Account's Machine stays custodian_only.
  const resolveInstalledWriterTargetSender = (context: RpcHandlerContext | undefined, phase: 'inspect' | 'dependencies',
    relationshipId: string, sourceWorkspace: WorkspaceRefV1, targetWorkspace: WorkspaceRefV1) => {
    const admission = context?.machineAdmission;
    const installedAccountId = dependencies.localAccountId;
    const send = dependencies.callWorkspaceTargetPhase;
    if (!context || !admission || !installedAccountId || !send || admission.actorAccountId !== installedAccountId
      || admission.machineId !== localMachineId || resolveWorkspaceSyncExecutionMachineIdV1(sourceWorkspace) !== localMachineId) return undefined;
    const targetMachineId = resolveWorkspaceSyncExecutionMachineIdV1(targetWorkspace);
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: { machineId: localMachineId, installationId: admission.installationId },
      source: { v: 1, phase: 'prepare', operationId: relationshipId, accountServerId: localServerId,
        sourceMachineId: localMachineId, sourceRootPath: sourceWorkspace.rootPath,
        sourceContext: projectWorkspaceSyncPhysicalContextFromActionContext(buildActionExecutorContextForRpc(context)) },
      target: { v: 1, phase, operationId: relationshipId, accountServerId: localServerId,
        targetMachineId, targetRootPath: targetWorkspace.rootPath } });
    return async (method: string, request: unknown, signal?: AbortSignal) => await send({ machineId: targetMachineId,
      method, request, routing: routing.target, ...(signal ? { signal } : {}) }, {
      signal: signal ?? context.signal, callerAuthority: 'present_user',
      machineAdmission: admission,
      workspaceSyncSourceWriterTargetRouting: routing });
  };
  /** The relationship's other endpoint, read from the same rows that named the TARGET. */
  const findRelationshipSourceWorkspace = (relationshipId: string, targetWorkspace: WorkspaceRefV1) => {
    const snapshot = readSnapshot(relationshipId);
    const relationship = snapshot?.relationships.find(value => value.relationshipId === relationshipId);
    const sourceRefId = relationship?.alphaWorkspaceRefId === targetWorkspace.id ? relationship.betaWorkspaceRefId
      : relationship?.betaWorkspaceRefId === targetWorkspace.id ? relationship.alphaWorkspaceRefId : undefined;
    return snapshot && sourceRefId ? resolveWorkspaceRefById(snapshot.workspaceRefs, sourceRefId, localServerId) : null;
  };
  const callTargetRead = async <TResult>(input: Readonly<{ relationshipId: string; workspace: WorkspaceRefV1; method: string;
    request: unknown; signal?: AbortSignal; context?: RpcHandlerContext; local: () => Promise<TResult>; parse: (raw: unknown) => TResult }>) => {
    const isLocal = isExecutionHere(input.workspace);
    const sourceWorkspace = isLocal ? undefined : findRelationshipSourceWorkspace(input.relationshipId, input.workspace);
    const send = sourceWorkspace && resolveInstalledWriterTargetSender(input.context, 'inspect', input.relationshipId,
      sourceWorkspace, input.workspace);
    if (send) return input.parse(await send(input.method, input.request, input.signal));
    return await callAtTarget({ machineId: resolveWorkspaceSyncExecutionMachineIdV1(input.workspace), method: input.method,
      request: input.request, signal: input.signal, isLocal, local: input.local, parse: input.parse });
  };

  const authority: WorkspaceSyncTargetAuthority = {
    activity,
    hasRetainedRecoveryAdmission: ({ request, accountServerId, actorAccountId, receivingMachine }) => {
      const target = findNativeEndpoint(request.targetWorkspaceRefId, request.relationshipId)?.[1].targetRouting
        ?? findRetainedRecoveryTarget(request)?.entry.targetRouting;
      const admitted = target?.targetContext.machineAdmission;
      return target?.accountServerId === accountServerId && admitted?.actorAccountId === actorAccountId
        && admitted.machineId === receivingMachine.machineId
        && admitted.installationId === receivingMachine.installationId
        && request.targetMachineId === receivingMachine.machineId;
    },
    previewCommittedCopyHere: async (request, context) => {
      if (context?.workspaceSyncSourceWriterTargetRouting?.target.phase !== 'inspect') {
        return inspectCommittedCopyPreviewHere(request, await refreshCommittedCopyPreview(request, context));
      }
      const { entry, relationship, workspace, sourceWorkspace } = await resolveRetainedCopyCustody({
        relationshipId: request.expectedRelationship.relationshipId, targetWorkspaceRefId: request.targetWorkspaceRefId,
        expectedRelationship: request.expectedRelationship, sourceWorkspace: request.workspace, sourceMachineId: request.machineId,
      }, context, 'inspect');
      if (request.targetMachineId !== resolveWorkspaceSyncExecutionMachineIdV1(workspace)) throw authorityError('forbidden', 'Workspace copy target changed');
      const { signal: _signal, ...wire } = request;
      return inspectCommittedCopyPreviewHere(request, { parsed: WorkspaceSyncCommittedCopyPreviewV1Schema.parse(wire),
        relationship, workspace, sourceWorkspace, endpointRole: entry.endpointRole });
    },
    previewCommittedCopyAtTarget: async (request, context, snapshot) => {
      const resolved = snapshot ? resolveCommittedCopyPreview(request, snapshot) : await refreshCommittedCopyPreview(request, context);
      const { parsed, workspace } = resolved;
      if (isLocalWorkspace(workspace)) return await inspectCommittedCopyPreviewHere(request, resolved);
      const send = resolveInstalledWriterTargetSender(context, 'inspect', parsed.expectedRelationship.relationshipId,
        resolved.sourceWorkspace, workspace);
      const raw = send
        ? await send(RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, parsed, request.signal)
        : await callMachineRpc({ machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace),
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, request: parsed,
          ...(request.signal ? { signal: request.signal } : {}) });
      const result = WorkspaceSyncCommittedCopyPreviewResultV1Schema.safeParse(raw);
      if (!result.success) {
        assertOkResult(raw);
        throw result.error;
      }
      if (result.data.ok && (result.data.preview.targetMachineId !== parsed.targetMachineId
        || result.data.preview.workspaceRefId !== parsed.targetWorkspaceRefId)) {
        throw authorityError('root_mismatch', 'Workspace copy preview response changed target');
      }
      return result.data;
    },
    assertRetainedCopyDependencyAdmission: async (request, context) => {
      const { entry } = await resolveRetainedCopyCustody({ relationshipId: request.relationshipId }, context, 'dependencies');
      if (request.serverId !== localServerId || request.machineId !== localMachineId
        || (request.workspaceRefId !== entry.sourceWorkspaceRefId && request.workspaceRefId !== entry.targetWorkspaceRefId)) {
        throw authorityError('forbidden', 'Dependency observation does not match retained requester custody');
      }
    },
    readDependenciesAsInstalledWriter: (request, context, signal) => {
      const snapshot = readSnapshot(request.relationshipId);
      const relationship = snapshot?.relationships.find(value => value.relationshipId === request.relationshipId);
      const endpoints = relationship ? [relationship.alphaWorkspaceRefId, relationship.betaWorkspaceRefId]
        .map(id => resolveWorkspaceRefById(snapshot!.workspaceRefs, id, localServerId)) : [];
      const target = endpoints.find(ref => ref !== null && resolveWorkspaceSyncExecutionMachineIdV1(ref) === request.machineId);
      const source = endpoints.find(ref => ref !== null && ref !== target);
      const send = target && source && resolveInstalledWriterTargetSender(context, 'dependencies', request.relationshipId, source, target);
      return send ? send(RPC_METHODS.DAEMON_PROJECT_WORKER_DEPENDENCIES, request, signal) : null;
    },
    inspectCommittedCopyHere: async (request, context) => {
      const native = await prepareCommittedCopyHere(request, context, 'inspect');
      const resolved = resolveCommittedCopy(request, native ? { workspaceRefs: [native.sourceWorkspace, native.workspace],
        relationships: [request.actionInput.expectedRelationship] } : getSnapshot());
      assertCommittedCopyRelationshipCurrent(resolved.snapshot, resolved.relationship);
      await inspectWorkspaceSyncCommittedCopy(resolved.copy);
    },
    removeCommittedCopyHere: async (request, context) => {
      const native = await prepareCommittedCopyHere(request, context, 'remove');
      const retirePreparedCopy = context?.localActionContext?.retirePreparedWorkspaceCopy;
      // The retained loan supplies the exact physical ref without opening the
      // custodian's unrelated Account graph.
      const resolved = resolveCommittedCopy(request, native ? { workspaceRefs: [native.sourceWorkspace, native.workspace],
        relationships: retirePreparedCopy ? [request.actionInput.expectedRelationship] : [] } : getSnapshot());
      if (resolved.snapshot.relationships.some(relationship =>
        relationship.relationshipId !== (retirePreparedCopy ? resolved.relationship.relationshipId : undefined)
        && (relationship.alphaWorkspaceRefId === resolved.workspace.id || relationship.betaWorkspaceRefId === resolved.workspace.id))) {
        throw authorityError('workspace_root_in_use', 'Workspace copy still belongs to a relationship');
      }
      if (retirePreparedCopy) {
        assertCommittedCopyRelationshipCurrent(resolved.snapshot, resolved.relationship);
        await inspectWorkspaceSyncCommittedCopy(resolved.copy);
      }
      // Finish cleanup while the admitted requester and the target's retained custody still exist.
      const resolveProjectRuntime = dependencies.resolveProjectRuntime;
      const preparation = resolveProjectRuntime ? await (async () => {
        if (!context) throw authorityError('project_setup_operation_unavailable', 'The original retirement operation is unavailable');
        const actionContext = buildActionExecutorContextForRpc(context);
        const operation = requireProjectCheckoutRemovalOperation({
          ...actionContext, actionRequestId: actionContext.actionRequestId ?? undefined,
          resumeActionRequest: actionContext.resumeActionRequest === true ? true : undefined,
        });
        const runtime = await resolveProjectRuntime(context);
        if (!runtime) throw authorityError('project_setup_operation_unavailable', 'Requester Project cleanup is unavailable');
        const admitted = native && context.retainedCheckoutTeardown;
        const association = admitted ? { workspace: admitted.data
          ? { ...resolved.workspace, projectKey: admitted.data.project.projectId } : resolved.workspace,
          project: admitted.data?.project ?? null } : resolved.workspace.projectKey ? { workspace: resolved.workspace,
          project: { serverId: resolved.workspace.serverId, projectId: resolved.workspace.projectKey } } : undefined;
        return await prepareProjectCheckoutRemoval({ runtime, ingress: context, context: actionContext, operation,
          worktreePath: resolved.workspace.rootPath,
          ...(association ? { association } : {}), ...(admitted && admitted.data ? { admittedTeardown: admitted.data } : {}),
          skipCleanup: request.actionInput.removeTargetCopy?.skipCleanup === true });
      })() : undefined;
      await retirePreparedCopy?.();
      if (!native) {
        if (retirePreparedCopy && dependencies.refreshProjectSnapshot) {
          await dependencies.refreshProjectSnapshot(request.signal);
        }
        await authority.reconcileRetainedBootstraps();
      }
      await removeWorkspaceSyncCommittedCopy({ ...resolved.copy, rootOwnershipManager: resolved.bootstrap.rootOwnershipManager,
        ...(native ? { retainedOwnership: native.entry.handle } : {}) });
      if (native) await discardRetained(native.authorityKey, 'commit');
      preparation?.settle('deleted');
    },
    inspectCommittedCopyAtTarget: async (request, context) => await committedCopyAtTarget(request, 'inspect', context),
    removeCommittedCopyAtTarget: async (request, context) => await committedCopyAtTarget(request, 'remove', context),
    borrowSourceRootForCopy: async ({ operationId, workspaceRefId }) => {
      const native = await nativeExecutionForEndpoint(workspaceRefId);
      if (native) return native.borrowSourceRootForCopy({ operationId, workspaceRefId });
      const snapshot = getSnapshot();
      const workspace = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], workspaceRefId, localServerId);
      if (!workspace || !isLocalWorkspace(workspace) || workspace.serverId.trim() !== localServerId) return null;
      const relationships = (snapshot?.relationships ?? []).filter((relationship) => {
        if (!relationship.enabled) return false;
        const alpha = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], relationship.alphaWorkspaceRefId, localServerId);
        const beta = resolveWorkspaceRefById(snapshot?.workspaceRefs ?? [], relationship.betaWorkspaceRefId, localServerId);
        if (!alpha || !beta) return false;
        const roles = resolveWorkspaceSyncRelationshipEndpointRoles({
          mode: relationship.mode,
          controllerMachineId: relationship.controllerMachineId,
          alphaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(alpha),
          betaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(beta),
        });
        return roles && (roles.targetEndpointRole === 'alpha' ? alpha.id : beta.id) === workspaceRefId;
      });
      if (relationships.length === 0) return null;
      if (relationships.length !== 1) throw authorityError('relationship_not_ready', 'Workspace sync source has conflicting retained target owners');
      const { authorityKey, entry } = await requireRetainedRelationshipEndpoint({ relationship: relationships[0]!, workspace });
      return await exclusive(authorityKey, async () => {
        if (physicalRetained.get(authorityKey) !== entry || !entry.readyPublished) {
          throw authorityError('relationship_not_ready', 'Workspace sync source is not a committed linked spoke');
        }
        await assertRetainedRelationshipEndpointCurrent({ authorityKey, entry, workspace });
        const priorOwner = sourceLoanOwners.get(operationId);
        if (priorOwner && priorOwner !== authorityKey) throw authorityError('relationship_not_ready', 'Workspace copy source loan conflicts with an active operation');
        const members = sourceLoans.get(authorityKey) ?? new Set<string>();
        members.add(operationId);
        sourceLoans.set(authorityKey, members);
        sourceLoanOwners.set(operationId, authorityKey);
        return {
          handle: entry.handle,
          release: async () => await exclusive(authorityKey, async () => {
            if (sourceLoanOwners.get(operationId) !== authorityKey) return;
            sourceLoanOwners.delete(operationId);
            members.delete(operationId);
            if (members.size > 0) return;
            sourceLoans.delete(authorityKey);
            const outcome = deferredDiscards.get(authorityKey);
            if (outcome) await discardRetained(authorityKey, outcome);
          }, true),
        };
      });
    },
    preflightHandoffTargetReplacementHere: async (rawRequest, signal, context) => {
      signal?.throwIfAborted();
      const request = HandoffTargetReplacementPreflightV1Schema.parse(rawRequest);
      if (request.serverId !== localServerId) {
        throw authorityError('target_unavailable', 'Handoff target placement does not match this daemon');
      }
      const admittedContext = projectWorkspaceSyncWriterTargetContext(context, localMachineId);
      const nativeRouting = admittedContext?.workspaceSyncTargetRouting?.targetManaged
        ? await readTargetRouting(admittedContext, 'preflight') : undefined;
      if (nativeRouting?.targetManaged) {
        if (nativeRouting.operationId !== request.operationId || nativeRouting.targetMachineId !== request.machineId
          || nativeRouting.targetRootPath !== request.targetPath) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted native target placement changed');
        }
        const snapshot = getSnapshot(request.operationId);
        const target = resolveAdmittedNativeWorkspace(snapshot, nativeRouting.targetManaged, request.targetPath);
        if (!dependencies.localManagedTarget) {
          const execution = await nativeExecutionFor(target, context);
          if (!execution) throw authorityError('workspace_sync_child_unavailable', 'The admitted native target execution is unavailable');
          await execution.replaceSnapshot(snapshot);
          const result = await execution.preflightHandoffTargetReplacementHere(request, signal);
          return HandoffTargetReplacementPreflightResultV1Schema.parse({ ...result, targetWorkspace: target });
        }
      }
      const writer = context?.workspaceSyncSourceWriterTargetRouting;
      const normalWriter = writer && context?.callerInputAuthorization
        && isWorkspaceSyncRelationshipWriteActionId(context.callerInputAuthorization.binding.actionId)
        && !context.workspaceSyncTargetRouting;
      // Home and the signed source packet already bind the requester to this
      // physical destination. Its custodian's Account catalog is irrelevant.
      const target = normalWriter
        ? localAdmittedTarget(null, request.targetPath, signal)
        : await bindReplacementTarget(request.machineId, request.targetPath, signal, context);
      if (context?.workspaceSyncTargetRouting) {
        const routing = WorkspaceSyncTargetRoutingV1Schema.parse(context.workspaceSyncTargetRouting);
        if (routing.phase !== 'preflight' || routing.operationId !== request.operationId
          || routing.accountServerId !== localServerId || routing.targetMachineId !== request.machineId
          || routing.targetRootPath !== request.targetPath
          || !isDeepStrictEqual(routing.targetContext.machineAdmission, context.machineAdmission)
          || routing.targetContext.callerAuthority !== context.callerAuthority
          || !isDeepStrictEqual(routing.targetContext.sessionActionOrigin, context.sessionActionOrigin)
          || !isDeepStrictEqual(routing.targetContext.callerInputConstraints, context.callerInputConstraints)
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
          throw authorityError('workspace_sync_child_unavailable', 'The original target admission is unavailable');
        }
        const child = target.facts.find(fact => fact.machineId === request.machineId);
        if (!child || child.installationId !== context.machineAdmission?.installationId
          || target.machineId !== localMachineId) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted child target does not resolve to this parent');
        }
      }
      if (context?.machineAdmission && !context.workspaceSyncTargetRouting
        && target.machineId === localMachineId
        && (request.machineId !== localMachineId || context.machineAdmission.machineId !== localMachineId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent())) {
        throw authorityError('workspace_sync_child_unavailable', 'The target admission does not belong to this Machine');
      }
      if (target.machineId !== localMachineId) {
        const child = target.facts.find(fact => fact.machineId === request.machineId);
        if (!child || request.machineId !== localMachineId || !context?.machineAdmission
          || context.workspaceSyncTargetRouting || context.machineAdmission.machineId !== request.machineId
          || context.machineAdmission.installationId !== child.installationId
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()) {
          throw authorityError('workspace_sync_child_unavailable', 'The original target admission is unavailable');
        }
        if (!dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The admitted target child transport is unavailable');
        }
        await target.assertCurrent();
        return HandoffTargetReplacementPreflightResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: target.machineId,
          ...(target.physicalEndpoint ? { physicalEndpoint: target.physicalEndpoint } : {}),
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
          request,
          routing: { v: 1, phase: 'preflight', operationId: request.operationId,
            accountServerId: localServerId, targetMachineId: request.machineId, targetRootPath: request.targetPath },
          ...(signal ? { signal } : {}),
        }, context));
      }
      let targetWorkspace: WorkspaceRefV1 | undefined;
      if (context?.callerInputAuthorization?.binding.actionId === 'projects.open'
        && context.workspaceSyncSourceExecution && context.workspaceSyncSourceWriterTargetRouting) {
        const writerTarget = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(context.workspaceSyncSourceWriterTargetRouting);
        const jointRouting = context.workspaceSyncTargetRouting
          ? WorkspaceSyncTargetRoutingV1Schema.parse(context.workspaceSyncTargetRouting) : undefined;
        if (jointRouting) {
          const { targetContext: _targetContext, ...targetRouting } = jointRouting;
          if (!isDeepStrictEqual(writerTarget.target, targetRouting)) {
            throw projectTargetQualificationUnavailable('preflight', 'The qualified Project target placement is unavailable');
          }
        }
        const binding = context.callerInputAuthorization.binding;
        if (writerTarget.target.phase !== 'preflight' || writerTarget.target.operationId !== request.operationId
          || writerTarget.target.accountServerId !== localServerId || writerTarget.target.targetMachineId !== request.machineId
          || writerTarget.target.targetRootPath !== request.targetPath
          || !jointRouting && (request.machineId !== localMachineId
            || context.machineAdmission?.machineId !== localMachineId || context.machineAdmission.installationId !== binding.installationId)) {
          throw projectTargetQualificationUnavailable('preflight', 'The qualified Project target placement is unavailable');
        }
        let qualified = target.endpoint;
        if (!jointRouting) {
          const address = { serverId: localServerId, machineId: localMachineId, rootPath: target.rootPath };
          let own = resolveWorkspaceRefV1(getSnapshot().workspaceRefs, address);
          // A signed Open's Home write can return before the installed Account
          // receives its row update. Read from that same Account on a miss.
          if (own.kind === 'missing' && binding.accountId === dependencies.localAccountId && dependencies.refreshProjectSnapshot) {
            const snapshot = await dependencies.refreshProjectSnapshot(signal);
            own = resolveWorkspaceRefV1(snapshot.workspaceRefs, address);
          }
          qualified = own.kind === 'resolved' ? own.ref : null;
        }
        if (!qualified || qualified.serverId.trim() !== localServerId
          || resolveWorkspaceSyncExecutionMachineIdV1(qualified) !== localMachineId || qualified.rootPath !== target.rootPath) {
          throw projectTargetQualificationUnavailable('preflight', 'The qualified Project target Workspace is unavailable');
        }
        // The bound writer or independent D returns its own existing row.
        // Neither materializes a row in the SOURCE graph.
        targetWorkspace = qualified;
      }
      const requested = normalize(resolve(target.rootPath));
      if (requested === resolve('/')) {
        throw authorityError('workspace_root_unsafe', 'Handoff target root is invalid');
      }
      const before = await lstat(requested).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (before && (!before.isDirectory() || before.isSymbolicLink())) {
        throw authorityError('workspace_root_unsafe', 'Handoff target root must be a real directory');
      }
      const canonicalRoot = before
        ? await realpath(requested)
        : await realpathWithAbsentSuffix(requested)
          .catch(() => null);
      if (!canonicalRoot || canonicalRoot === resolve('/')) {
        throw authorityError('workspace_root_unsafe', 'Handoff target parent is unavailable');
      }
      if (!bootstrap) throw authorityError('workspace_sync_unavailable', 'Workspace sync bootstrap authority is unavailable');
      // A signed writer's Replace lends only the requester's own link, never from
      // this custodian's catalog: through the requester's rows when their Account
      // custody is open here, else through the link's own signed admission.
      const admittedLoan = normalWriter && request.replaceRelationshipId
        && !readRequesterAccountActionContext(context?.callerInputAuthorization);
      const snapshot = !normalWriter ? getSnapshot(request.operationId)
        : request.replaceRelationshipId && !admittedLoan ? await readInvocationSnapshot(signal, context, request.operationId) : null;
      const preflightTarget = admittedLoan ? resolveAdmittedReplacementLoan(writer, request) : await resolveEnabledRelationshipPreflightTarget({
        snapshot,
        operationId: request.operationId,
        replaceRelationshipId: request.replaceRelationshipId,
        canonicalRoot,
        localServerId,
        localMachineId,
        localManagedTarget: dependencies.localManagedTarget,
      });
      let borrowedOwnership: WorkspaceRootOwnershipHandle | undefined;
      if (preflightTarget) {
        const authorityKey = retainedAuthorityKey({
          relationshipId: preflightTarget.relationship.relationshipId,
          operationId: preflightTarget.relationship.relationshipId,
          endpointRole: 'beta',
          targetWorkspaceRefId: preflightTarget.target.id,
        });
        const entry = physicalRetained.get(authorityKey);
        // Inspect under the exact live target loan, never a second acquisition
        // of the selected link's root. Creation still owns retirement and full
        // immutable-definition validation after destination approval.
        if (entry
          && entry.relationshipId === preflightTarget.relationship.relationshipId
          && entry.targetWorkspaceRefId === preflightTarget.target.id) {
          const retainedRoot = await assertRetainedRootIdentity({
            authorityKey,
            entry,
            rootPath: preflightTarget.target.rootPath,
          });
          if (retainedRoot === canonicalRoot) {
            if (entry.relationshipId === deriveWorkspaceSyncRelationshipId(request.operationId)) {
              await target.assertCurrent();
              return HandoffTargetReplacementPreflightResultV1Schema.parse({ type: 'not_required',
                ...(targetWorkspace ? { targetWorkspace } : {}) });
            }
            borrowedOwnership = entry.handle;
          }
        }
      }
      const ownership = borrowedOwnership ?? await bootstrap.rootOwnershipManager.tryAcquire({
        ownerId: request.operationId,
        canonicalRoot,
        operation: 'handoff',
        deferRootIdentityBinding: true,
      });
      if ('kind' in ownership) throw authorityError('workspace_root_in_use', 'Handoff target root overlaps an active operation');
      try {
        signal?.throwIfAborted();
        await target.assertCurrent();
        const current = await lstat(requested).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
        if (current && (!current.isDirectory() || current.isSymbolicLink())) {
          throw authorityError('workspace_root_unsafe', 'Handoff target root must be a real directory');
        }
        // Only source materialization replaces what is already here; attaching
        // an existing checkout preserves it and reconciles the difference as
        // ordinary conflicts. This mirrors the bootstrap owner's own rule, so
        // the proof this preflight stamps is the one that owner will require.
        // An omitted intent keeps the original materializing meaning.
        const replacesWhenNonEmpty = request.destinationIntent !== 'use_existing';
        let replacesNonEmptyTarget = false;
        // An absent root has no object identity to fingerprint; its canonical
        // absence is the fact the approval binds, so a root appearing later
        // fails the replay comparison exactly like a changed root would.
        let rootFingerprint = computeWorkspaceSyncAbsentRootFingerprint(canonicalRoot);
        if (current) {
          const currentCanonicalRoot = await realpath(requested);
          if (currentCanonicalRoot !== canonicalRoot) {
            throw authorityError('root_changed', 'Handoff target root changed during inspection');
          }
          replacesNonEmptyTarget = replacesWhenNonEmpty
            && (await readdir(currentCanonicalRoot)).length > 0;
          await ownership.bindCurrentRootIdentity();
          rootFingerprint = await computeWorkspaceSyncRootFingerprint(currentCanonicalRoot);
        }
        // Exact mirroring authorizes deleting target-only files for the life of
        // the relationship, so it needs the destination confirmation even when
        // there is nothing to replace today. Both consequences of one
        // destination decision travel in one proof.
        const consequences = [
          ...(replacesNonEmptyTarget ? ['replace_nonempty_workspace_target'] as const : []),
          ...(request.activatesExactMirror ? ['delete_target_only_files_during_exact_mirror'] as const : []),
        ];
        if (consequences.length === 0) {
          return HandoffTargetReplacementPreflightResultV1Schema.parse({ type: 'not_required',
            ...(targetWorkspace ? { targetWorkspace } : {}) });
        }
        return HandoffTargetReplacementPreflightResultV1Schema.parse({
          type: 'approval_required',
          ...(targetWorkspace ? { targetWorkspace } : {}),
          approval: HandoffTargetReplacementApprovalV1Schema.parse({
            v: 1,
            consequences,
            serverId: localServerId,
            machineId: request.machineId,
            canonicalRoot: target.approvalRoot ?? canonicalRoot,
            rootFingerprint,
            operationId: request.operationId,
          }),
        });
      } finally {
        if (!borrowedOwnership) await ownership.release();
      }
    },

    preflightHandoffTargetReplacementAtTarget: async (request, context) => {
      const { signal: _signal, targetManaged, ...wireInput } = request;
      const wireRequest = HandoffTargetReplacementPreflightV1Schema.parse(wireInput);
      if (wireRequest.serverId !== localServerId) {
        throw authorityError('target_unavailable', 'Handoff target server does not match this daemon');
      }
      const source = context?.workspaceSyncSourceWriterTargetRouting?.source ?? context?.workspaceSyncSourceRouting;
      if (context?.callerInputAuthorization && source) {
        context.signal.throwIfAborted();
        if (!source.sourceContext || source.accountServerId !== localServerId || source.operationId !== wireRequest.operationId
          || !dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The admitted original target transport is unavailable');
        }
        return HandoffTargetReplacementPreflightResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: wireRequest.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
          request: wireRequest, routing: { v: 1, phase: 'preflight', operationId: wireRequest.operationId,
            accountServerId: localServerId, targetMachineId: wireRequest.machineId, targetRootPath: wireRequest.targetPath,
            ...(targetManaged ? { targetManaged } : {}) },
          ...(request.signal ? { signal: request.signal } : {}),
        }, context));
      }
      if (wireRequest.machineId === localMachineId) {
        return await authority.preflightHandoffTargetReplacementHere(wireRequest, request.signal, context);
      }
      const target = await readReplacementTarget(wireRequest.machineId, wireRequest.targetPath, request.signal);
      if (target.machineId === localMachineId) {
        return await authority.preflightHandoffTargetReplacementHere(wireRequest, request.signal);
      }
      return HandoffTargetReplacementPreflightResultV1Schema.parse(await callMachineRpc({
        machineId: target.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
        request: wireRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      }));
    },

    prepareSourceSeedExport: async (request) => {
      if (!dependencies.prepareSourceSeedExport) {
        throw authorityError('target_bootstrap_offline', 'Workspace sync source seed is unavailable');
      }
      return await dependencies.prepareSourceSeedExport({
        operationId: request.operationId,
        sourceWorkspaceRefId: request.sourceWorkspaceRefId,
        targetMachineId: request.targetMachineId,
        contentPolicy: request.contentPolicy,
        ...(request.exclusionCandidates ? { exclusionCandidates: request.exclusionCandidates } : {}),
      });
    },
    prepareConflictResolutionExport,
    releaseConflictResolutionCaptureHere,
    stageConflictResolutionHere,
    applyStagedConflictResolutionHere,
    discardStagedConflictResolutionHere,
    recoverConflictResolutionHere,
    readFileHere,
    observeEntryHere,
    stageConflictResolutionAtTarget: async ({ signal, ...wireRequest }) => {
      const parsed = WorkspaceSyncTargetConflictStageV1Schema.parse(wireRequest);
      const workspace = assertOwnedTargetWorkspace(parsed.relationshipId, parsed.targetWorkspaceRefId, parsed.targetMachineId, 'Reviewed workspace conflict target Machine changed');
      return await callAtTarget({
        machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace), method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_STAGE,
        request: parsed, signal, isLocal: isExecutionHere(workspace),
        local: () => stageConflictResolutionHere(parsed, signal), parse: parseVoidOk,
      });
    },
    applyStagedConflictResolutionAtTarget: async ({ signal, ...wireRequest }) => {
      const parsed = WorkspaceSyncTargetConflictApplyV1Schema.parse(wireRequest);
      const workspace = assertOwnedTargetWorkspace(parsed.relationshipId, parsed.targetWorkspaceRefId, parsed.targetMachineId, 'Reviewed workspace conflict target Machine changed');
      return await callAtTarget({
        machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace), method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_APPLY,
        request: parsed, signal, isLocal: isExecutionHere(workspace),
        local: () => applyStagedConflictResolutionHere(parsed, signal),
        parse: raw => WorkspaceSyncTargetConflictApplyResultV1Schema.parse(raw),
      });
    },
    discardStagedConflictResolutionAtTarget: async ({ signal, ...wireRequest }) => {
      const parsed = WorkspaceSyncTargetConflictApplyV1Schema.parse(wireRequest);
      return await callAtTarget({
        machineId: parsed.targetMachineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_STAGE_DISCARD,
        request: parsed, signal, isLocal: parsed.targetMachineId === localMachineId,
        local: () => discardStagedConflictResolutionHere(parsed, signal), parse: parseVoidOk,
      });
    },
    releaseConflictResolutionCaptureAtSource: async (request) => {
      const parsed = WorkspaceSyncConflictCaptureReleaseV1Schema.parse(request);
      return await callAtTarget({
        machineId: parsed.sourceMachineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_CAPTURE_RELEASE,
        request: parsed, isLocal: parsed.sourceMachineId === localMachineId,
        local: () => releaseConflictResolutionCaptureHere(parsed), parse: parseVoidOk,
      });
    },
    recoverConflictResolutionAtTarget: async (request) => {
      const parsed = WorkspaceSyncTargetConflictRecoverV1Schema.parse({
        relationshipId: request.relationshipId, targetMachineId: request.targetMachineId, targetWorkspaceRefId: request.targetWorkspaceRefId,
      });
      const { workspace, transientAccess } = await resolveRecoveryWorkspace(parsed);
      if (isExecutionHere(workspace)) return await recoverConflictResolutionHere(parsed, request.signal);
      await transientAccess?.assertCurrentAuthority();
      return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(await callMachineRpc({
        machineId: resolveWorkspaceSyncExecutionMachineIdV1(workspace), method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER,
        request: parsed, ...(request.signal ? { signal: request.signal } : {}),
      }));
    },
    readFileAtTarget: async (request) => {
      const targetRequest = WorkspaceSyncTargetFileReadV1Schema.parse({
        relationshipId: request.relationshipId, workspaceRefId: request.targetWorkspaceRefId, path: request.path,
        maxBytes: request.maxBytes, ...(request.expectedDigest === undefined ? {} : { expectedDigest: request.expectedDigest }),
      });
      const workspace = assertOwnedTargetWorkspace(targetRequest.relationshipId, targetRequest.workspaceRefId, request.targetMachineId);
      return await callTargetRead({ relationshipId: targetRequest.relationshipId, workspace,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ, request: targetRequest,
        ...(request.signal ? { signal: request.signal } : {}), ...(request.context ? { context: request.context } : {}),
        local: () => readFileHere(targetRequest, request.signal),
        parse: raw => ReadWorkspaceSyncFileResultV1Schema.parse(raw),
      });
    },
    observeEntryAtTarget: async (request) => {
      const targetRequest = WorkspaceSyncTargetEntryObserveV1Schema.parse({
        relationshipId: request.relationshipId, workspaceRefId: request.targetWorkspaceRefId, path: request.path,
      });
      const workspace = assertOwnedTargetWorkspace(targetRequest.relationshipId, targetRequest.workspaceRefId, request.targetMachineId);
      return await callTargetRead({ relationshipId: targetRequest.relationshipId, workspace,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE, request: targetRequest,
        ...(request.signal ? { signal: request.signal } : {}), ...(request.context ? { context: request.context } : {}),
        local: () => observeEntryHere(targetRequest, request.signal),
        parse: raw => WorkspaceSyncEntryExpectationV1Schema.parse(raw),
      });
    },

    getPreparedBootstrapOwnership: async request => {
      const native = findNativeEndpoint(request.targetWorkspaceRefId)?.[1];
      if (native?.bootstrapOperationId === request.bootstrapOperationId) return native.execution.getPreparedBootstrapOwnership(request);
      const entry = [...physicalRetained.values()].find(candidate => (
        candidate.bootstrapOperationId === request.bootstrapOperationId
        && candidate.targetWorkspaceRefId === request.targetWorkspaceRefId
      ));
      if (!entry) {
        const code = 'workspace_root_ownership_lost';
        throw Object.assign(authorityError(code, 'Workspace sync target custody was not retained'), { failureCause: {
          phase: 'workspace_sync.target_bootstrap.ownership', errorClass: 'Error', errorCode: code, httpStatus: null,
        } satisfies ActionFailureCauseV1 });
      }
      return entry.handle;
    },
    prepareBootstrapHere: async (rawRequest, signal, context, admitted) => {
      signal?.throwIfAborted();
      const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse(rawRequest);
      if (!bootstrap) {
        throw authorityError('workspace_sync_unavailable', 'Workspace sync target bootstrap is unavailable');
      }
      const writerTarget = context?.workspaceSyncSourceWriterTargetRouting
        ? WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(context.workspaceSyncSourceWriterTargetRouting) : undefined;
      // The installed SOURCE has admitted the requester's Account and stages
      // this exact relationship before signing the physical TARGET call. These
      // are invocation projections of that SOURCE custody, never TARGET rows.
      const normalRelationship = writerTarget && context?.callerInputAuthorization
        && isWorkspaceSyncRelationshipWriteActionId(context.callerInputAuthorization.binding.actionId)
        && !context.workspaceSyncTargetRouting && request.owner.kind === 'relationship'
        ? request.transientRelationship : undefined;
      let sourceInvocation: ActiveProjectAccountRowsSnapshot | undefined;
      if (normalRelationship && writerTarget) {
        if (request.owner.kind !== 'relationship' || normalRelationship.relationshipId !== request.owner.relationshipId
          || normalRelationship.controllerMachineId !== writerTarget.source.sourceMachineId
          || writerTarget.target.targetMachineId !== localMachineId) {
          throw authorityError('bootstrap_definition_conflict', 'The admitted Sync relationship placement changed');
        }
        const sourceId = request.endpointRole === 'beta' ? normalRelationship.alphaWorkspaceRefId : normalRelationship.betaWorkspaceRefId;
        const targetId = request.endpointRole === 'beta' ? normalRelationship.betaWorkspaceRefId : normalRelationship.alphaWorkspaceRefId;
        sourceInvocation = dependencies.localManagedTarget || writerTarget.target.targetManaged ? getSnapshot(request.bootstrapOperationId) : { source: 'network', workspaceRefs: [
          { id: sourceId, serverId: localServerId, machineId: writerTarget.source.sourceMachineId,
            rootPath: writerTarget.source.sourceRootPath, createdAtMs: normalRelationship.createdAtMs },
          { id: targetId, serverId: localServerId, machineId: localMachineId,
            rootPath: writerTarget.target.targetRootPath, createdAtMs: normalRelationship.createdAtMs },
        ], relationships: [normalRelationship], organizations: [], rows: [], graphRevision: 'absent',
          loadedAtMs: 0, scopeKey: context!.callerInputAuthorization!.binding.accountId };
      }
      const admittedContext = projectWorkspaceSyncWriterTargetContext(context, localMachineId);
      const targetRouting = admitted?.targetRouting ?? await readTargetRouting(admittedContext, 'prepare');
      const sourceWriterTargetRouting = admitted?.sourceWriterTargetRouting ?? await readSourceWriterTargetRouting(context, 'prepare', targetRouting);
      let admittedTarget: Awaited<ReturnType<typeof bindReplacementTarget>> | undefined;
      let independentTarget: WorkspaceRefV1 | undefined;
      if (targetRouting?.targetManaged) {
        independentTarget = resolveAdmittedNativeWorkspace(getSnapshot(request.bootstrapOperationId),
          targetRouting.targetManaged, targetRouting.targetRootPath, request.targetWorkspaceRefId);
        admittedTarget = localAdmittedTarget(independentTarget, independentTarget.rootPath, signal);
      } else if (targetRouting && dependencies.localWorkspaceRefId !== undefined) {
        const target = resolveWorkspaceRef(getSnapshot(request.bootstrapOperationId), request.targetWorkspaceRefId, localServerId);
        if (request.targetWorkspaceRefId !== dependencies.localWorkspaceRefId
          || targetRouting.targetMachineId !== localMachineId || !isLocalWorkspace(target)
          || target.rootPath !== targetRouting.targetRootPath) {
          throw authorityError('workspace_sync_child_unavailable', 'The captured native target does not resolve to this endpoint');
        }
        independentTarget = target;
        admittedTarget = localAdmittedTarget(target, target.rootPath, signal);
      }
      if (sourceWriterTargetRouting && targetRouting && !targetRouting.targetManaged && !independentTarget) {
        if (sourceInvocation) {
          independentTarget = resolveWorkspaceRef(sourceInvocation, request.targetWorkspaceRefId, localServerId);
          admittedTarget = localAdmittedTarget(independentTarget, independentTarget.rootPath, signal);
        } else admittedTarget = await bindReplacementTarget(targetRouting.targetMachineId, targetRouting.targetRootPath, signal, context);
        const child = admittedTarget.facts.find(fact => fact.machineId === targetRouting.targetMachineId);
        const rootBinding = context?.callerInputAuthorization?.binding;
        // This TARGET qualifies its own row for the Open it was signed for, or for the handoff Home admitted
        // to it (the root's signed TARGET Machine and installation; ruling 2026-11-24 23:56Z (3)).
        const ownTargetInstallationId = rootBinding?.actionId === 'projects.open' && context?.workspaceSyncSourceExecution
          ? rootBinding.installationId
          : rootBinding?.actionId === 'session.handoff' && rootBinding.handoffAdmission?.targetMachineId === localMachineId
            ? rootBinding.handoffAdmission.targetInstallationId : undefined;
        if (!child && ownTargetInstallationId !== undefined && !context?.workspaceSyncTargetRouting
          && targetRouting.targetMachineId === localMachineId
          && targetRouting.targetContext.machineAdmission.installationId === ownTargetInstallationId) {
          const own = resolveWorkspaceRefV1(getSnapshot().workspaceRefs, {
            serverId: localServerId, machineId: localMachineId, rootPath: targetRouting.targetRootPath,
          });
          if (own.kind !== 'resolved') {
            throw projectTargetQualificationUnavailable('prepare', 'The qualified Project target Workspace is unavailable');
          }
          independentTarget = own.ref;
          const binding = admittedTarget;
          admittedTarget = { ...binding, workspace: own.ref, endpoint: own.ref, assertCurrent: async () => {
            await binding.assertCurrent();
            const current = resolveWorkspaceRefV1(getSnapshot().workspaceRefs, {
              serverId: localServerId, machineId: localMachineId, rootPath: targetRouting.targetRootPath,
            });
            if (current.kind !== 'resolved' || !isDeepStrictEqual(current.ref, own.ref)) {
              throw projectTargetQualificationUnavailable('prepare', 'The qualified Project target Workspace changed before preparation');
            }
          } };
        }
        if ((!child && !independentTarget) || child && child.installationId !== targetRouting.targetContext.machineAdmission.installationId
          || !admittedTarget.endpoint) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted child target does not resolve to this endpoint');
        }
        if (admittedTarget.machineId !== localMachineId) {
          if (targetRouting.targetMachineId !== localMachineId || context?.workspaceSyncTargetRouting
            || !dependencies.callWorkspaceTargetPhase || !context) {
            throw authorityError('workspace_sync_child_unavailable', 'The admitted target transport is unavailable');
          }
          await admittedTarget.assertCurrent();
          return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
            machineId: admittedTarget.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
            ...(admittedTarget.physicalEndpoint ? { physicalEndpoint: admittedTarget.physicalEndpoint } : {}),
            request, routing: { v: 1, phase: 'prepare', operationId: request.bootstrapOperationId,
              accountServerId: localServerId, targetMachineId: targetRouting.targetMachineId,
              targetRootPath: targetRouting.targetRootPath }, ...(signal ? { signal } : {}),
          }, context));
        }
      }
      // The physical TARGET owns its rows. A qualified joint request carries
      // only the remote SOURCE locator; its installed writer requalifies that
      // row when serving the seed, rather than sharing the borrower's graph.
      const admittedCopy = sourceWriterTargetRouting && admittedTarget?.endpoint && request.owner.kind === 'copy_once'
        ? { target: admittedTarget.endpoint, sourceWriterMachineId: sourceWriterTargetRouting.sourceWriter.machineId } : undefined;
      const installedWriterTarget = sourceWriterTargetRouting && admittedTarget?.endpoint;
      if (!admitted) {
        await admitInstalledWriterLoan({ relationshipId: request.owner.kind === 'relationship' ? request.owner.relationshipId : null,
          ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}), ...(targetRouting ? { targetRouting } : {}) }, signal);
      }
      let invocationSnapshot = sourceInvocation ?? (installedWriterTarget ? getSnapshot() : await readInvocationSnapshot(signal, context, request.bootstrapOperationId));
      let owner = resolveBootstrapOwner(invocationSnapshot, request, localServerId, admittedCopy);
      // resolveBootstrapOwner may use a caller's transient runtime definition. Only
      // the receiving target's already-staged Home row can prove original creation.
      let workerCopyCreation = resolvePersistedWorkerCopyCreation(invocationSnapshot, owner.relationship,
        owner.sourceWorkspaceRefId, owner.targetWorkspaceRefId, localServerId);
      if (request.replaceRelationshipId && !sourceInvocation && !installedWriterTarget) {
        const predecessorInSnapshot = invocationSnapshot.relationships.some(
          candidate => candidate.relationshipId === request.replaceRelationshipId,
        );
        const stagedWorkerCopyMissing = owner.relationship !== null
          && getWorkspaceSyncWorkerCopyV1(owner.relationship) !== null
          && workerCopyCreation === undefined;
        if ((predecessorInSnapshot || stagedWorkerCopyMissing) && dependencies.refreshProjectSnapshot) {
          const refreshed = await dependencies.refreshProjectSnapshot(signal);
          invocationSnapshot = refreshed ?? getSnapshot(request.bootstrapOperationId);
          owner = resolveBootstrapOwner(invocationSnapshot, request, localServerId, admittedCopy);
          workerCopyCreation = resolvePersistedWorkerCopyCreation(invocationSnapshot, owner.relationship,
            owner.sourceWorkspaceRefId, owner.targetWorkspaceRefId, localServerId);
        }
        if (!invocationSnapshot.relationships.some(candidate => candidate.relationshipId === request.replaceRelationshipId)
          && [...retained.values()].some(entry => entry.relationshipId === request.replaceRelationshipId)) {
          await authority.reconcileRetainedBootstraps();
        }
      }
      const nativeExecution = await nativeExecutionFor(owner.targetWorkspace, context);
      if (!nativeExecution) assertLocalWorkspacePlacement(owner.targetWorkspace, localServerId, localMachineId, dependencies.localManagedTarget);
      if (nativeExecution && !admittedTarget) {
        admittedTarget = localAdmittedTarget(owner.targetWorkspace, owner.targetRootPath, signal);
      }
      let requesterCopyCustody: WorkspaceSyncRequesterCopyCustody | undefined;
      if (sourceWriterTargetRouting && owner.relationship && getWorkspaceSyncWorkerCopyV1(owner.relationship)) {
        const installation = readInstallationIdentityIfExistsSync();
        if (!installation || !owner.sourceRootPath) {
          throw authorityError('forbidden', 'Workspace copy creation identity is unavailable');
        }
        requesterCopyCustody = {
          accountServerId: localServerId,
          actorAccountId: sourceWriterTargetRouting.source.sourceContext.machineAdmission.actorAccountId,
          sourceWriter: sourceWriterTargetRouting.sourceWriter,
          sourceWorkspace: { id: owner.sourceWorkspaceRefId, machineId: owner.sourceMachineId, rootPath: owner.sourceRootPath },
          target: { machineId: localMachineId, installationId: installation.installationId },
          relationship: owner.relationship,
        };
      }
      let allowReplaceRebind = false;
      if (request.replaceRelationshipId) {
        if ([...retained.values()].some(entry => entry.relationshipId === request.replaceRelationshipId)
          || invocationSnapshot.relationships.some(candidate => candidate.relationshipId === request.replaceRelationshipId)) {
          throw authorityError('bootstrap_definition_conflict', 'The link selected for replacement is still active');
        }
        const predecessorReadyFact = await readWorkspaceSyncFinalReadyFact(
          bootstrap.materializationDirectory,
          request.replaceRelationshipId,
          request.endpointRole,
        );
        if (sourceWriterTargetRouting || sourceInvocation || requesterCopyCustody) {
          const callerAccountId = requesterCopyCustody?.actorAccountId
            ?? sourceWriterTargetRouting?.source.sourceContext.machineAdmission.actorAccountId
            ?? context?.callerInputAuthorization?.binding.accountId;
          if (workerCopyCreation) {
            const pred = predecessorReadyFact?.v === 2 ? predecessorReadyFact.requesterCopyCustody : null;
            const predWorkerCopy = pred ? getWorkspaceSyncWorkerCopyV1(pred.relationship) : null;
            const matchesRequesterPredecessor = predecessorReadyFact !== null
              && predecessorReadyFact.v === 2
              && requesterCopyCustody !== undefined
              && pred !== null
              && predecessorReadyFact.relationshipId === request.replaceRelationshipId
              && predecessorReadyFact.endpointRole === request.endpointRole
              && predecessorReadyFact.targetWorkspaceRefId === owner.targetWorkspaceRefId
              && pred.accountServerId === requesterCopyCustody.accountServerId
              && pred.actorAccountId === requesterCopyCustody.actorAccountId
              && isDeepStrictEqual(pred.sourceWriter, requesterCopyCustody.sourceWriter)
              && isDeepStrictEqual(pred.sourceWorkspace, requesterCopyCustody.sourceWorkspace)
              && isDeepStrictEqual(pred.target, requesterCopyCustody.target)
              && pred.relationship.relationshipId === request.replaceRelationshipId
              && predWorkerCopy?.sourceWorkspaceRefId === workerCopyCreation.sourceWorkspaceRefId
              && predWorkerCopy?.targetWorkspaceRefId === workerCopyCreation.targetWorkspaceRefId;
            if (!matchesRequesterPredecessor) {
              throw authorityError('forbidden', 'The link selected for replacement does not match caller custody');
            }
            allowReplaceRebind = true;
          } else if (predecessorReadyFact?.v === 2 && predecessorReadyFact.requesterCopyCustody.actorAccountId !== callerAccountId) {
            throw authorityError('forbidden', 'The link selected for replacement does not match caller custody');
          }
        } else if (predecessorReadyFact?.v === 2) {
          const localInstallationId = readInstallationIdentityIfExistsSync()?.installationId;
          const pred = predecessorReadyFact.requesterCopyCustody;
          const matchesInstalledOwner = dependencies.localAccountId !== undefined
            && pred.accountServerId === localServerId
            && pred.actorAccountId === dependencies.localAccountId
            && pred.target.machineId === localMachineId
            && pred.target.installationId === localInstallationId
            && predecessorReadyFact.relationshipId === request.replaceRelationshipId
            && predecessorReadyFact.endpointRole === request.endpointRole
            && predecessorReadyFact.targetWorkspaceRefId === owner.targetWorkspaceRefId;
          if (!matchesInstalledOwner) {
            throw authorityError('forbidden', 'The link selected for replacement belongs to another account');
          }
          allowReplaceRebind = Boolean(workerCopyCreation);
        } else if (predecessorReadyFact?.v === 3) {
          throw authorityError('forbidden', 'The link selected for replacement does not match caller custody');
        } else if (predecessorReadyFact?.v === 1) {
          if (predecessorReadyFact.relationshipId !== request.replaceRelationshipId
            || predecessorReadyFact.endpointRole !== request.endpointRole
            || predecessorReadyFact.targetWorkspaceRefId !== owner.targetWorkspaceRefId) {
            throw authorityError('forbidden', 'The link selected for replacement does not match target endpoint');
          }
          allowReplaceRebind = Boolean(workerCopyCreation);
        }
      }
      const sourceIsLocal = owner.sourceWorkspace !== null && isLocalWorkspace(owner.sourceWorkspace);
      const localSourceRootPath = sourceIsLocal ? owner.sourceRootPath : undefined;
      if (sourceIsLocal && localSourceRootPath === undefined) {
        throw authorityError('workspace_ref_not_ready', 'The local source root is unavailable');
      }
      if (sourceWriterTargetRouting && request.owner.kind === 'copy_once'
        && request.owner.operation.operationId !== sourceWriterTargetRouting.source.operationId) {
        throw authorityError('bootstrap_definition_conflict', 'The source writer copy operation changed');
      }
      if (targetRouting) {
        if (!admitted) assertPrepareWrites(request, targetRouting.targetContext, owner.relationship);
        admittedTarget ??= await bindReplacementTarget(targetRouting.targetMachineId, targetRouting.targetRootPath, signal, context);
        const child = admittedTarget.facts.find(fact => fact.machineId === targetRouting.targetMachineId);
        if ((!child && !independentTarget) || child && child.installationId !== targetRouting.targetContext.machineAdmission.installationId
          || admittedTarget.machineId !== localMachineId || admittedTarget.rootPath !== owner.targetRootPath
          || admittedTarget.endpoint?.id !== owner.targetWorkspaceRefId) {
          throw authorityError('workspace_sync_child_unavailable', 'The admitted child target does not resolve to this endpoint');
        }
      }
      // Exact mirroring authorizes deleting target-only files for the life of
      // the relationship, whichever way this endpoint is established: attaching
      // an existing folder is non-destructive today and still deletes its
      // target-only files on the next reconciliation. The consequence therefore
      // belongs to every new mirroring endpoint, not only to a materializing
      // one. An established relationship rehydrating its READY custody carries
      // no bootstrap choice and needs no new proof.
      const activatesExactMirror = owner.relationship?.mode === 'mirror_exactly'
        && request.targetBootstrap !== undefined;
      let approvedTarget: Awaited<ReturnType<typeof bindReplacementTarget>> | undefined;
      // This daemon owns local authorization, and its prepare RPC is reachable
      // without the Action wrapper, so the complete binding is proven here
      // before any retained lookup or filesystem work. Canonical root and
      // object identity stay with bootstrap, which inspects the real target.
      if (request.targetReplacementApproval) {
        const approval = request.targetReplacementApproval;
        if (request.targetReplacementApprovalActionInput === undefined) {
          throw authorityError('approval_stale', 'Workspace target replacement approval has no Action receipt');
        }
        // A verified normal SOURCE invocation already consumed the requester's
        // native confirmation or persisted receipt. Other families retain the target check.
        if (!sourceInvocation && !admitted) {
          if (!dependencies.assertTargetReplacementAuthorized || !request.targetReplacementApprovalReceiptId) {
            throw authorityError('approval_stale', 'Workspace target replacement approval has no Action receipt');
          }
          await dependencies.assertTargetReplacementAuthorized(
            request.targetReplacementApprovalReceiptId,
            request.targetReplacementApprovalActionInput,
            approval,
          );
        }
        if (approval.serverId !== localServerId) {
          throw authorityError('approval_stale', 'Workspace target replacement approval placement is stale');
        }
        approvedTarget = sourceInvocation || admitted || nativeExecution ? admittedTarget
          : await bindReplacementTarget(approval.machineId, approval.canonicalRoot, signal, context);
        if (!approvedTarget) throw authorityError('approval_stale', 'The admitted Workspace target is unavailable');
        if (approvedTarget.machineId !== localMachineId
          || (approvedTarget.endpoint !== null && (approvedTarget.endpoint.id !== owner.targetWorkspaceRefId
            || approvedTarget.rootPath !== owner.targetRootPath))) {
          throw authorityError('approval_stale', 'Workspace target replacement approval placement is stale');
        }
        const boundToThisOwner = owner.relationshipId === null
          ? approval.operationId === owner.operationId
          : deriveWorkspaceSyncRelationshipId(approval.operationId) === owner.relationshipId;
        if (!boundToThisOwner) {
          throw authorityError('approval_stale', 'Workspace target replacement approval is stamped for another operation');
        }
        if (approval.consequences.includes('delete_target_only_files_during_exact_mirror') !== activatesExactMirror) {
          throw authorityError('approval_stale', 'Workspace target replacement approval does not match this relationship mode');
        }
      }
      const authorityKey = retainedAuthorityKey({
        relationshipId: owner.relationshipId,
        operationId: owner.operationId,
        endpointRole: owner.endpointRole,
        targetWorkspaceRefId: owner.targetWorkspaceRefId,
      });
      const definition = canonicalBootstrapDefinition(request);
      if (nativeExecution && isManagedWorkspaceRefV2(owner.targetWorkspace)) {
        const workspace = owner.targetWorkspace;
        return await exclusive(authorityKey, async () => {
          const bound = [...retained.entries()].find(([, entry]) => entry.bootstrapOperationId === request.bootstrapOperationId);
          if (bound && (bound[0] !== authorityKey || bound[1].definition !== definition
            && !isExactPersistedRelationshipReentry(bound[1], owner, request))) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap operation id already owns a different definition');
          }
          const previous = retained.get(authorityKey);
          if (previous && (!('kind' in previous) || !isDeepStrictEqual(previous.workspace, workspace)
            || previous.targetRouting?.targetContext.machineAdmission.actorAccountId !== targetRouting?.targetContext.machineAdmission.actorAccountId)) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync target authority already owns another endpoint');
          }
          await nativeExecution.replaceSnapshot(invocationSnapshot);
          const result = await nativeExecution.prepareBootstrapHere(request, signal, undefined,
            nativeBootstrapAdmission({ ...(targetRouting ? { targetRouting } : {}), ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}) }));
          retained.set(authorityKey, { kind: 'native', execution: nativeExecution, workspace,
            bootstrapOperationId: request.bootstrapOperationId, definition, result,
            relationshipId: owner.relationshipId, operationId: owner.operationId,
            sourceWorkspaceRefId: owner.sourceWorkspaceRefId, sourceMachineId: owner.sourceMachineId,
            sourceRootPath: owner.sourceRootPath, targetRootPath: owner.targetRootPath, createIfMissing: request.createIfMissing,
            targetWorkspaceRefId: owner.targetWorkspaceRefId, targetMachineId: localMachineId,
            endpointRole: owner.endpointRole, relationshipDefinition: owner.relationship,
            transientAuthority: request.transientRelationship !== undefined,
            ...(targetRouting ? { targetRouting } : {}), ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}) });
          notifyActivity();
          return result;
        });
      }
      const operationBinding = [...physicalRetained.entries()].find(([, entry]) => (
        entry.bootstrapOperationId === request.bootstrapOperationId
      ));
      if (operationBinding
        && (operationBinding[0] !== authorityKey
          || (operationBinding[1].definition !== definition
            && !isExactPersistedRelationshipReentry(operationBinding[1], owner, request)))) {
        throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap operation id already owns a different definition');
      }
      if (!request.targetBootstrap && !physicalRetained.has(authorityKey)) {
        if (!owner.relationship) {
          const rehydrated = request.owner.kind === 'copy_once' && owner.sourceWorkspace
            ? await rehydrateCopyOnceEndpoint({
                request: request as WorkspaceSyncTargetBootstrapPrepareV1 & Readonly<{ owner: Readonly<{ kind: 'copy_once'; operation: WorkspaceSyncCopyOnceV1 }> }>,
                targetWorkspace: owner.targetWorkspace,
                sourceWorkspace: owner.sourceWorkspace,
              })
            : null;
          if (!rehydrated) {
            throw authorityError('target_bootstrap_required', 'Workspace sync target requires an explicit bootstrap choice');
          }
        } else {
          if (!owner.sourceWorkspace) throw authorityError('workspace_ref_not_ready', 'The relationship source is unavailable');
          const rehydrated = await rehydrateRelationshipEndpoint({
            relationship: owner.relationship,
            projectSnapshot: invocationSnapshot,
            endpointRole: owner.endpointRole,
            targetWorkspace: owner.targetWorkspace,
            sourceWorkspace: owner.sourceWorkspace,
            ...(requesterCopyCustody ? { requesterCopyCustody } : {}),
          });
          if (!rehydrated) {
            throw authorityError('target_bootstrap_required', 'Existing workspace relationship has no verified target bootstrap');
          }
        }
      }
      const settleNormalTargetRecovery = async () => {
        if (!sourceInvocation || !owner.relationshipId) return;
        const recovered = await recoverConflictResolutionHere({ relationshipId: owner.relationshipId,
          targetMachineId: localMachineId, targetWorkspaceRefId: owner.targetWorkspaceRefId }, signal);
        if (recovered.status === 'recovery_needed') {
          throw Object.assign(authorityError('workspace_sync_recovery_needed', 'Workspace target recovery must settle before Sync can start'),
            { recoveryPath: recovered.recoveryPath });
        }
      };
      return await exclusive(authorityKey, async () => {
        signal?.throwIfAborted();
        await admittedTarget?.assertCurrent();
        const retainedEntry = physicalRetained.get(authorityKey);
        if (retainedEntry) {
          const persistedRelationshipReentry = isExactPersistedRelationshipReentry(retainedEntry, owner, request);
          const installedWorkerCopyReentry = persistedRelationshipReentry && retainedEntry.readyPublished
            && retainedEntry.requesterCopyCustody && owner.relationship && owner.sourceWorkspace
            && !targetRouting && !sourceWriterTargetRouting && !context?.callerInputAuthorization
            && (!context?.machineAdmission || context.machineAdmission.actorAccountId === dependencies.localAccountId)
            && resolveInstalledWorkerCopyCustody(retainedEntry.requesterCopyCustody, owner.relationship, owner.sourceWorkspace, owner.targetWorkspace);
          if (retainedEntry.bootstrapOperationId === request.bootstrapOperationId
            && !installedWorkerCopyReentry
            && (!isDeepStrictEqual(retainedEntry.targetRouting, targetRouting)
              || !isDeepStrictEqual(retainedEntry.sourceWriterTargetRouting, sourceWriterTargetRouting))) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync target authority changed before preparation');
          }
          if (retainedEntry.bootstrapOperationId === request.bootstrapOperationId
            && retainedEntry.definition !== definition
            && !persistedRelationshipReentry) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap operation id already owns a different definition');
          }
          if (!retainedBootstrapMatchesOwner(retainedEntry, owner, request)) {
            throw authorityError('bootstrap_definition_conflict', 'Workspace sync target authority conflicts with the current settings owner');
          }
          if (retainedEntry.bootstrapOperationId === request.bootstrapOperationId) {
            if (persistedRelationshipReentry) {
              await verifyRetainedRootOrDiscard(authorityKey, retainedEntry, owner.targetRootPath, 'Workspace sync target root identity changed before settings reconciliation');
              physicalRetained.set(authorityKey, { ...retainedEntry, definition });
            }
            await settleNormalTargetRecovery();
            return { ...retainedEntry.result, targetWorkspace: owner.targetWorkspace,
              ...(installedWorkerCopyReentry ? { created: false } : {}) };
          }
          await verifyRetainedRootOrDiscard(authorityKey, retainedEntry, owner.targetRootPath, 'Workspace sync target root identity changed before handoff rebinding');
          const reboundResult = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
            ...retainedEntry.result,
            targetWorkspace: owner.targetWorkspace,
            bootstrapOperationId: request.bootstrapOperationId,
            created: false,
          });
          const { targetRouting: _priorTargetRouting, sourceWriterTargetRouting: _priorSourceWriterTargetRouting, ...retainedBasis } = retainedEntry;
          const rebound: RetainedBootstrap = {
            ...retainedBasis,
            bootstrapOperationId: request.bootstrapOperationId,
            definition,
            result: reboundResult,
            transientAuthority: sourceInvocation !== undefined || retainedBasis.transientAuthority,
            ...(targetRouting ? { targetRouting } : {}),
            ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}),
          };
          observeInstalledWriterLoan(rebound, readSnapshot());
          physicalRetained.set(authorityKey, rebound);
          await settleNormalTargetRecovery();
          return reboundResult;
        }
        signal?.throwIfAborted();
        const seedMaterializer = request.targetBootstrap === 'materialize_from_source_workspace' && (!sourceIsLocal || localSourceRootPath !== undefined)
          ? async (params: Readonly<{ canonicalRoot: string; materializationReceiptPath: string; originalTargetExists: boolean; targetFence: WorkspaceTargetMaterializationFence }>) => {
              const common = {
                operationId: owner.operationId, contentPolicy: owner.contentPolicy,
                ...(owner.exclusionCandidates ? { exclusionCandidates: owner.exclusionCandidates } : {}),
                ...params,
              };
              if (!sourceIsLocal) {
                if (!bootstrap.materializeRemoteSeed) throw authorityError('target_bootstrap_offline', 'Workspace sync source seed is unavailable');
                return await bootstrap.materializeRemoteSeed({
                  ...common, sourceMachineId: owner.sourceMachineId, sourceWorkspaceRefId: owner.sourceWorkspaceRefId,
                  ...(owner.sourceWorkspace && isManagedWorkspaceRefV2(owner.sourceWorkspace) && owner.sourceMachineId === localMachineId ? { managedSourceOnController: true as const } : {}),
                  ...(admittedContext ? { context: admittedContext } : {}), ...(signal ? { signal } : {}),
                });
              }
              if (!bootstrap.materializeLocalSeed) throw authorityError('target_bootstrap_offline', 'Workspace sync local source seed is unavailable');
              return await bootstrap.materializeLocalSeed({ ...common, sourcePath: localSourceRootPath! });
            }
          : null;
        const prepared = await workspaceSyncTargetBootstrap({
          rootPath: owner.targetRootPath,
          ...(localSourceRootPath !== undefined
            ? { sourceRootPath: localSourceRootPath }
            : {}),
          relationshipId: owner.operationId,
          endpointRole: request.endpointRole,
          targetWorkspaceRefId: owner.targetWorkspaceRefId,
          policyDigest: request.policyDigest,
          contentSelection: owner.contentPolicy.selection,
          ...(owner.contentPolicy.contentOnly ? { contentOnly: true as const } : {}),
          ...(workerCopyCreation ? { workerCopyCreation } : {}),
          ...(allowReplaceRebind && request.replaceRelationshipId ? { replaceRelationshipId: request.replaceRelationshipId } : {}),
          ...(requesterCopyCustody ? { requesterCopyCustody } : {}),
          ...(request.owner.kind === 'copy_once' && dependencies.localManagedTarget && dependencies.localAccountId
            && isManagedWorkspaceRefV2(owner.targetWorkspace)
            ? { nativeCopyOwner: { accountId: dependencies.localAccountId, target: owner.targetWorkspace } } : {}),
          ...(request.targetReplacementApproval
            ? { targetReplacementApproval: request.targetReplacementApproval }
            : {}),
          ...(approvedTarget?.approvalRoot ? { targetReplacementApprovalTarget: {
            canonicalRoot: approvedTarget.approvalRoot, assertCurrent: approvedTarget.assertCurrent,
          } } : {}),
          activatesExactMirror,
          materializationDirectory: bootstrap.materializationDirectory,
          rootOwnershipManager: bootstrap.rootOwnershipManager,
          ...(owner.contentPolicy.selection === 'git_worktree' && seedMaterializer
            ? { prepareGitTarget: async (gitInput: Parameters<NonNullable<WorkspaceSyncTargetBootstrapInput['prepareGitTarget']>>[0]) => {
                if (gitInput.targetBootstrap === 'use_existing') {
                  await (bootstrap.prepareGitTarget
                    ? bootstrap.prepareGitTarget(gitInput)
                    : prepareExistingGitWorkspaceSyncTarget({ canonicalRoot: gitInput.canonicalRoot, targetState: gitInput.targetState }));
                  return;
                }
                // The seed materializer reconciles its actual SCM metadata.
                return await seedMaterializer({
                  canonicalRoot: gitInput.canonicalRoot, materializationReceiptPath: gitInput.materializationReceiptPath,
                  originalTargetExists: gitInput.targetState !== 'missing', targetFence: gitInput.targetFence,
                });
              } }
            : bootstrap.prepareGitTarget ? { prepareGitTarget: bootstrap.prepareGitTarget } : {}),
          ...(seedMaterializer ? { materializeSeed: seedMaterializer } : {}),
          createIfMissing: request.createIfMissing,
          targetBootstrap: request.targetBootstrap!,
        }, {
          ...(bootstrap.writeReadyFact ? { writeReadyFact: bootstrap.writeReadyFact } : {}),
          ...(bootstrap.rehydrateMaterializationFromReceiptPath
            ? { rehydrateMaterializationFromReceiptPath: bootstrap.rehydrateMaterializationFromReceiptPath }
            : {}),
        });
        const result = WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse({
          v: 1,
          bootstrapOperationId: request.bootstrapOperationId,
          targetWorkspaceRefId: owner.targetWorkspaceRefId,
          state: 'ready',
          created: prepared.created,
          rootFingerprint: prepared.rootFingerprint,
          policyDigest: prepared.policyDigest,
          ...(prepared.copyOnceBaseline ? { copyOnceBaseline: prepared.copyOnceBaseline } : {}),
          ...(prepared.copyOnceExcludedPaths ? { copyOnceExcludedPaths: prepared.copyOnceExcludedPaths } : {}),
          targetWorkspace: owner.targetWorkspace,
        });
        const entry: RetainedBootstrap = {
          bootstrapOperationId: request.bootstrapOperationId,
          definition,
          result,
          handle: prepared.ownershipHandles[0]!,
          ...(prepared.materializationCustody
            ? { materializationCustody: prepared.materializationCustody }
            : {}),
          publishReady: prepared.publishReady,
          readyPublished: prepared.readyPublished,
          relationshipId: owner.relationshipId,
          operationId: owner.operationId,
          sourceWorkspaceRefId: owner.sourceWorkspaceRefId,
          sourceMachineId: owner.sourceMachineId,
          sourceRootPath: owner.sourceRootPath,
          targetWorkspaceRefId: owner.targetWorkspaceRefId,
          targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(owner.targetWorkspace),
          targetRootPath: owner.targetRootPath,
          endpointRole: owner.endpointRole,
          relationshipDefinition: owner.relationship,
          transientAuthority: sourceInvocation !== undefined || request.transientRelationship !== undefined
            && !invocationSnapshot.relationships.some((candidate) => (
              candidate.relationshipId === owner.relationshipId && candidate.enabled
            )),
          createIfMissing: request.createIfMissing,
          ...(targetRouting ? { targetRouting } : {}),
          ...(sourceWriterTargetRouting ? { sourceWriterTargetRouting } : {}),
          ...(requesterCopyCustody ? { requesterCopyCustody } : {}),
        };
        observeInstalledWriterLoan(entry, readSnapshot());
        physicalRetained.set(authorityKey, entry);
        await commitPublishedMaterializationCustody(entry);
        await settleNormalTargetRecovery();
        return result;
      });
    },

    releaseBootstrapHere: async (rawRequest, signal, context, admitted) => {
      signal?.throwIfAborted();
      const request = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse(rawRequest);
      const targetRouting = admitted?.targetRouting ?? await readTargetRouting(context, 'release');
      const sourceWriterTargetRouting = admitted?.sourceWriterTargetRouting ?? await readSourceWriterTargetRouting(context, 'release');
      const match = [...retained.entries()].find(([, entry]) => (
        entry.bootstrapOperationId === request.bootstrapOperationId
      ));
      if (!match) return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false });
      const [authorityKey] = match;
      return await exclusive(authorityKey, async () => {
        signal?.throwIfAborted();
        let entry = retained.get(authorityKey);
        if (!entry || entry.bootstrapOperationId !== request.bootstrapOperationId) {
          return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false });
        }
        // A lost ACK leaves the source with its admitted logical ref, not the
        // physical row returned by preparation. Only the same retained B loan
        // may use that exact original definition; ordinary releases stay exact.
        const originalDefinition: unknown = entry.sourceWriterTargetRouting && sourceWriterTargetRouting
          ? JSON.parse(entry.definition) : null;
        const matchesOriginalRef = originalDefinition !== null && typeof originalDefinition === 'object'
          && 'targetWorkspaceRefId' in originalDefinition && originalDefinition.targetWorkspaceRefId === request.targetWorkspaceRefId;
        if (entry.targetWorkspaceRefId !== request.targetWorkspaceRefId && !matchesOriginalRef) {
          throw authorityError('bootstrap_definition_conflict', 'Workspace sync bootstrap release does not match the retained operation');
        }
        if ((!('kind' in entry) || context || admitted) && (entry.sourceWriterTargetRouting || sourceWriterTargetRouting
          ? !isDeepStrictEqual(entry.sourceWriterTargetRouting, sourceWriterTargetRouting)
          : !isDeepStrictEqual(entry.targetRouting, targetRouting))) {
          throw authorityError('bootstrap_definition_conflict', 'Workspace sync target cleanup authority does not match the retained operation');
        }
        if ('kind' in entry) {
          const snapshot = getSnapshot(entry.operationId);
          const keepsRelationship = entry.relationshipId && (relationshipStillOwnsEndpoint(snapshot, entry)
            || request.reason === 'relationship_committed' && (relationshipOwnsEndpoint(snapshot, entry, false) || entry.transientAuthority));
          if (!keepsRelationship) await closeActiveIngressesFor(authorityKey);
          const result = await entry.execution.releaseBootstrapHere(request, signal, undefined,
            nativeBootstrapAdmission({ ...(entry.targetRouting ? { targetRouting: entry.targetRouting } : {}),
              ...(entry.sourceWriterTargetRouting ? { sourceWriterTargetRouting: entry.sourceWriterTargetRouting } : {}) }));
          if (result.released) { retained.delete(authorityKey); activeIngresses.delete(authorityKey); notifyActivity(); }
          return result;
        }
        const durableRelationshipOwnsEndpoint = entry.relationshipId
          ? relationshipOwnsEndpoint(getSnapshot(entry.operationId), entry, false)
          : false;
        if (entry.relationshipId && (relationshipStillOwnsEndpoint(getSnapshot(entry.operationId), entry)
          || (request.reason === 'relationship_committed'
            && (durableRelationshipOwnsEndpoint || entry.transientAuthority)))) {
          if (request.reason === 'relationship_committed') {
            if (!entry.readyPublished) {
              await entry.publishReady();
              entry = { ...entry, readyPublished: true };
              physicalRetained.set(authorityKey, entry);
            }
            await commitPublishedMaterializationCustody(entry);
          }
          // The persistent relationship still owns this endpoint: its fence
          // must survive abort/copy_committed until the relationship is
          // disabled/terminated or the daemon shuts down.
          return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: false });
        }
        await discardRetained(authorityKey, request.reason === 'abort' ? 'abort' : 'commit');
        return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse({ ok: true, released: true });
      });
    },

    prepareBootstrapAtTarget: async (request, context) => {
      const wireRequest = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({
        v: request.v,
        bootstrapOperationId: request.bootstrapOperationId,
        owner: request.owner,
        ...(request.transientRelationship ? { transientRelationship: request.transientRelationship } : {}),
        targetWorkspaceRefId: request.targetWorkspaceRefId,
        endpointRole: request.endpointRole,
        policyDigest: request.policyDigest,
        createIfMissing: request.createIfMissing,
        ...(request.targetBootstrap ? { targetBootstrap: request.targetBootstrap } : {}),
        ...(request.replaceRelationshipId ? { replaceRelationshipId: request.replaceRelationshipId } : {}),
        ...(request.targetReplacementApproval
          ? {
              targetReplacementApproval: request.targetReplacementApproval,
              targetReplacementApprovalReceiptId: request.targetReplacementApprovalReceiptId,
              targetReplacementApprovalActionInput: request.targetReplacementApprovalActionInput,
            }
          : {}),
      });
      const source = context?.workspaceSyncSourceWriterTargetRouting?.source ?? context?.workspaceSyncSourceRouting;
      if (context?.callerInputAuthorization && source) {
        context.signal.throwIfAborted();
        // A relationship bootstrap is named by the relationship its admitted operation derives;
        // the wire schema already ties owner.relationshipId to bootstrapOperationId.
        const relationship = wireRequest.owner.kind === 'relationship' ? wireRequest.transientRelationship ?? null : null;
        if (!source.sourceContext || !request.admittedTarget || source.accountServerId !== localServerId
          || (wireRequest.owner.kind === 'relationship'
            ? wireRequest.bootstrapOperationId !== deriveWorkspaceSyncRelationshipId(source.operationId)
            : source.operationId !== wireRequest.bootstrapOperationId)
          || !dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The admitted original target transport is unavailable');
        }
        assertPrepareWrites(wireRequest, source.sourceContext, relationship);
        return WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: request.admittedTarget.machineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, request: wireRequest,
          routing: { v: 1, phase: 'prepare', operationId: wireRequest.bootstrapOperationId,
            accountServerId: localServerId, targetMachineId: request.admittedTarget.machineId,
            targetRootPath: request.admittedTarget.rootPath,
            ...(request.admittedTarget.targetManaged ? { targetManaged: request.admittedTarget.targetManaged } : {}) },
          ...(request.signal ? { signal: request.signal } : {}),
        }, context));
      }
      const workspace = resolveWorkspaceRef(await readInvocationSnapshot(request.signal, context, request.bootstrapOperationId), wireRequest.targetWorkspaceRefId, localServerId);
      assertTargetMachine(workspace, request.targetMachineId);
      const bindPreparedTarget = (result: WorkspaceSyncTargetBootstrapAtTargetResult): WorkspaceSyncTargetBootstrapAtTargetResult => {
        if (request.admittedTarget) {
          const target = result.targetWorkspace;
          if (!target) throw authorityError('workspace_sync_update_required', 'The prepared target endpoint proof is unavailable');
          if (target.serverId !== localServerId || target.id !== wireRequest.targetWorkspaceRefId
            || resolveWorkspaceSyncExecutionMachineIdV1(target) !== request.admittedTarget.machineId
            || normalizeWorkspaceRootPathV1(target.rootPath) !== normalizeWorkspaceRootPathV1(request.admittedTarget.rootPath)) {
            throw authorityError('relationship_definition_conflict', 'The prepared Sync endpoint conflicts with the admitted effect');
          }
        }
        return result;
      };
      const admittedMachineId = request.admittedTarget?.machineId ?? resolveWorkspaceSyncExecutionMachineIdV1(workspace);
      if (admittedMachineId === localMachineId && isExecutionHere(workspace)) {
        const result = await authority.prepareBootstrapHere(wireRequest, request.signal, context);
        return bindPreparedTarget({ ...result, ownershipHandles: [await authority.getPreparedBootstrapOwnership(wireRequest)] });
      }
      if (context?.callerInputAuthorization) {
        throw authorityError('workspace_sync_update_required', 'The original requester target transport is unavailable');
      }
      return bindPreparedTarget(WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(await callMachineRpc({
        machineId: admittedMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
        request: wireRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      })));
    },

    releaseBootstrapAtTarget: async (request, context) => {
      const wireRequest = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse({
        v: request.v,
        bootstrapOperationId: request.bootstrapOperationId,
        targetWorkspaceRefId: request.targetWorkspaceRefId,
        reason: request.reason,
      });
      if (request.physicalEndpoint && context?.workspaceSyncSourceWriterTargetRouting) {
        const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(context.workspaceSyncSourceWriterTargetRouting);
        if (routing.target.phase !== 'release' || routing.target.operationId !== wireRequest.bootstrapOperationId
          || routing.target.accountServerId !== localServerId || routing.sourceWriter.machineId !== localMachineId
          || request.physicalEndpoint.machineId !== request.targetMachineId || context.callerInputAuthorization
          || !dependencies.callWorkspaceTargetPhase) {
          throw authorityError('workspace_sync_update_required', 'The retained target cleanup transport is unavailable');
        }
        return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(await dependencies.callWorkspaceTargetPhase({
          machineId: request.physicalEndpoint.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
          request: wireRequest, routing: routing.target, physicalEndpoint: request.physicalEndpoint,
          ...(request.signal ? { signal: request.signal } : {}),
        }, context));
      }
      if (context?.callerInputAuthorization) {
        // Cleanup releases the exact already-retained finite receipt. It is not
        // a new Account effect and remains possible after requester retirement.
        const entry = [...retained.values()].find(candidate => candidate.bootstrapOperationId === request.bootstrapOperationId
          && candidate.targetWorkspaceRefId === request.targetWorkspaceRefId
          && candidate.targetMachineId === request.targetMachineId);
        if (entry && entry.relationshipId === null && entry.targetMachineId === localMachineId) {
          return await authority.releaseBootstrapHere(wireRequest, request.signal);
        }
        throw authorityError('workspace_sync_update_required', 'The original requester target cleanup transport is unavailable');
      }
      const workspace = resolveWorkspaceRef(getSnapshot(request.bootstrapOperationId), wireRequest.targetWorkspaceRefId, localServerId);
      assertTargetMachine(workspace, request.targetMachineId);
      const admittedMachineId = request.admittedTarget?.machineId ?? resolveWorkspaceSyncExecutionMachineIdV1(workspace);
      if (admittedMachineId === localMachineId && isExecutionHere(workspace)) {
        return await authority.releaseBootstrapHere(wireRequest, request.signal);
      }
      const result: unknown = await callMachineRpc({
        machineId: admittedMachineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
        request: wireRequest,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      assertResultOk(result);
      return WorkspaceSyncTargetBootstrapReleaseResultV1Schema.parse(result);
    },

    openLocalWorkspaceAgentIngress: async request => {
      // The owner-local controller already retained its root handle. No wire
      // RPC exposes this port or grants a caller-selected filesystem path.
      const canonicalRoot = await realpath(request.canonicalRoot);
      if (canonicalRoot !== request.canonicalRoot) throw authorityError('root_changed', 'Workspace sync local endpoint root changed');
      return await openLocalAgentIngress(request, { ...request, canonicalRoot,
        authorityKey: `local-agent:${request.operationId}:${request.role}:${request.workspaceRefId}`,
        assertCurrent: () => { request.signal?.throwIfAborted(); } });
    },

    authorizeWorkspaceSyncMachineAgent: request => withMachineIngressEndpoint(request,
      ({ operationId, role, workspaceRefId, canonicalRoot }) => ({ operationId, role, workspaceRefId, canonicalRoot })),
    acquireWorkspaceSyncMachineIngress: request => {
      if (!dependencies.openRootedAgent && !dependencies.openNativeRootedAgent) throw authorityError('agent_unavailable', 'Verified rooted workspace sync agent is unavailable');
      return withMachineIngressEndpoint(request, endpoint => openLocalAgentIngress(request, endpoint));
    },

    reconcileRetainedBootstraps: async () => {
      const snapshot = getSnapshot();
      for (const [authorityKey, entry] of nativeEntries()) {
        const current = getSnapshot(entry.operationId);
        const preservesSourceLoan = entry.transientAuthority && entry.sourceWriterTargetRouting;
        if (entry.relationshipId && !preservesSourceLoan && !relationshipOwnsEndpoint(current, entry, false)) {
          await discardRetained(authorityKey);
          continue;
        }
        if (entry.relationshipId && !preservesSourceLoan && !relationshipStillOwnsEndpoint(current, entry)) {
          await closeActiveIngressesFor(authorityKey);
        }
        await entry.execution.replaceSnapshot(current);
        await entry.execution.reconcileRetainedBootstraps();
        if (entry.relationshipId && !preservesSourceLoan && !relationshipStillOwnsEndpoint(current, entry)) {
          retained.delete(authorityKey);
          notifyActivity();
        }
      }
      const rehydrateAfterReconciliation = async (
        input: Parameters<typeof rehydrateRelationshipEndpoint>[0],
      ): Promise<void> => {
        await rehydrateRelationshipEndpoint(input).catch((error: unknown) => {
          const code = (error as { code?: unknown }).code;
          if (code === 'root_changed'
            || code === 'target_bootstrap_required'
            || code === 'workspace_target_materialization_manual_recovery') return null;
          throw error;
        });
      };
      for (const [authorityKey, entry] of [...physicalRetained.entries()]) {
        // READY can precede installed Account publication. Only removal of a
        // previously observed relationship withdraws the committed writer loan.
        if (observeInstalledWriterLoan(entry, snapshot) === false
          && entry.observedInInstalledAccount && entry.readyPublished) {
          await discardRetained(authorityKey);
          continue;
        }
        // Installed Account publication cannot withdraw a signed SOURCE loan
        // lent to another Account. It ends through release, not unrelated rows.
        if (entry.relationshipId && (!entry.transientAuthority || !(entry.sourceWriterTargetRouting || entry.requesterCopyCustody))) {
          const snapshot = getSnapshot(entry.operationId);
          const enabledOwner = relationshipStillOwnsEndpoint(snapshot, entry);
          const stagedOwner = entry.transientAuthority && relationshipOwnsEndpoint(snapshot, entry, false);
          if (!enabledOwner && !stagedOwner) {
            await discardRetained(authorityKey);
            continue;
          }
          if (enabledOwner && entry.transientAuthority) {
            physicalRetained.set(authorityKey, { ...entry, transientAuthority: false });
          }
          const workspace = resolveWorkspaceRefById(
            snapshot?.workspaceRefs ?? [],
            entry.targetWorkspaceRefId,
            localServerId,
          );
          if (!workspace) {
            await discardRetained(authorityKey);
            continue;
          }
          await assertRetainedRootIdentity({
            authorityKey,
            entry,
            rootPath: workspace.rootPath,
          }).catch(() => undefined);
        }
      }
      if (!snapshot || !bootstrap) return;
      for (const relationship of snapshot.relationships ?? []) {
        const hasLiveTransientAuthority = [...physicalRetained.values()].some((entry) => (
          entry.relationshipId === relationship.relationshipId && entry.transientAuthority
        ));
        if (!relationship.enabled && hasLiveTransientAuthority) continue;
        const alpha = resolveWorkspaceRefById(snapshot.workspaceRefs ?? [], relationship.alphaWorkspaceRefId, localServerId);
        const beta = resolveWorkspaceRefById(snapshot.workspaceRefs ?? [], relationship.betaWorkspaceRefId, localServerId);
        if (!alpha || !beta) continue;
        if (isLocalWorkspace(alpha)) {
          await rehydrateAfterReconciliation({
            relationship,
            endpointRole: 'alpha',
            targetWorkspace: alpha,
            sourceWorkspace: beta,
            ...(!relationship.enabled ? { recoverMaterializationOnly: true } : {}),
          });
        }
        if (isLocalWorkspace(beta)) {
          await rehydrateAfterReconciliation({
            relationship,
            endpointRole: 'beta',
            targetWorkspace: beta,
            sourceWorkspace: alpha,
            ...(!relationship.enabled ? { recoverMaterializationOnly: true } : {}),
          });
        }
        if (!relationship.enabled) {
          for (const [authorityKey, entry] of [...physicalRetained.entries()]) {
            if (entry.relationshipId === relationship.relationshipId) await discardRetained(authorityKey);
          }
        }
      }
    },

    releaseNativeTargetExecution: async request => {
      for (const [authorityKey, entry] of nativeEntries().filter(([, candidate]) => isDeepStrictEqual(candidate.workspace, request.target))) {
        await exclusive(authorityKey, async () => {
          if (retained.get(authorityKey) !== entry) return;
          await closeActiveIngressesFor(authorityKey);
          await entry.execution.releaseAllRetainedBootstraps();
          retained.delete(authorityKey);
          activeIngresses.delete(authorityKey);
          notifyActivity();
        });
      }
    },

    releaseAllRetainedBootstraps: async () => {
      closing = true;
      notifyActivity();
      const ingressCloseFailures = new Map<string, unknown[]>();
      await Promise.all([...activeIngresses.entries()].map(async ([authorityKey, closers]) => {
        const results = await Promise.allSettled([...closers].map(async (close) => await close()));
        const rejected = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (rejected.length > 0) ingressCloseFailures.set(authorityKey, rejected);
      }));
      await Promise.all([...inFlight.values()]);
      const failures: unknown[] = [...ingressCloseFailures.values()].flat();
      for (const authorityKey of [...retained.keys()]) {
        if (ingressCloseFailures.has(authorityKey)) continue;
        await discardRetained(authorityKey).catch((error: unknown) => { failures.push(error); });
      }
      if (sourceLoans.size > 0) {
        failures.push(authorityError('peer_unavailable', 'Workspace sync source loans remain active during shutdown'));
      }
      for (const [operationId, captured] of capturedResolutions) {
        await rm(captured.captureDirectory, { recursive: true, force: true })
          .then(() => { capturedResolutions.delete(operationId); })
          .catch((error: unknown) => { failures.push(error); });
      }
      throwFailures(failures, 'Workspace sync target authority shutdown failed');
    },
  };
  return authority;
}
