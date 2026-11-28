import { isDeepStrictEqual } from 'node:util';
import type {
  ReadWorkspaceSyncFileResultV1, WorkspaceRefV1, WorkspaceSyncConflictCaptureReleaseV1,
  WorkspaceSyncEntryExpectationV1, WorkspaceSyncRelationshipV1, WorkspaceSyncTargetBootstrapPrepareResultV1,
  WorkspaceSyncTargetConflictApplyResultV1, WorkspaceSyncTargetConflictApplyV1,
  WorkspaceSyncTargetConflictRecoverResultV1, WorkspaceSyncTargetConflictRecoverV1,
  WorkspaceSyncTargetConflictStageV1, WorkspaceSyncTargetEntryObserveV1, WorkspaceSyncTargetFileReadV1,
} from '@happier-dev/protocol';
import {
  ReadWorkspaceSyncFileResultV1Schema, WorkspaceSyncEntryExpectationV1Schema,
  WorkspaceSyncTargetBootstrapPrepareResultV1Schema, WorkspaceSyncTargetConflictRecoverResultV1Schema,
  WorkspaceSyncTargetConflictRecoverV1Schema, WorkspaceSyncTargetEntryObserveV1Schema,
  WorkspaceSyncTargetFileReadV1Schema,
} from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncCommittedCopyPreviewResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { isManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
  resolveWorkspaceSyncExecutionMachineIdV1,
  resolveWorkspaceSyncRelationshipEndpointRoles,
} from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import type { MachineInstallationPublicIdentityV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { logger } from '@/ui/logger';
import type { PrivateProjectNativeSync } from '@/workspaces/activation/privateProjectSyncEffect';
import type { WorkspaceRootOwnershipHandle } from './workspaceSyncRootOwnership';
import type { RetainedWorkspaceSyncPrivateExecution } from './workspaceSyncHandoffAdapter';
import type { WorkspaceSyncExecutionRegistry } from './workspaceSyncExecutionRegistry';
import type {
  WorkspaceSyncLocalManagedTarget, WorkspaceSyncLocalResolutionEndpoint, WorkspaceSyncTargetAuthority,
  WorkspaceSyncTargetBootstrapPrepareRequest, WorkspaceSyncTargetFileReadRequest,
} from './workspaceSyncTargetAuthority';

export type WorkspaceSyncTargetDriverKind =
  | 'installed_host' | 'isolated_member' | 'managed_container' | 'signed_remote_requester';

export type DriverTargetLocator = Readonly<{
  workspaceRefId: string; machineId: string; rootPath: string; targetManaged?: WorkspaceSyncLocalManagedTarget;
}>;

export type DriverBootstrapPrepareInput = Readonly<{
  prepare: WorkspaceSyncTargetBootstrapPrepareRequest;
  relationship?: WorkspaceSyncRelationshipV1;
  target: DriverTargetLocator;
  context?: RpcHandlerContext;
  expectedPhysicalEndpoint?: MachineInstallationPublicIdentityV1;
}>;

export type DriverBootstrapPrepareResult = Readonly<{
  result?: WorkspaceSyncTargetBootstrapPrepareResultV1;
  ownershipHandles?: readonly WorkspaceRootOwnershipHandle[];
}>;

export type DriverBootstrapReleaseInput = Readonly<{
  bootstrapOperationId: string; targetWorkspaceRefId: string; targetMachineId: string;
  targetRootPath?: string; targetManaged?: WorkspaceSyncLocalManagedTarget;
  reason: 'abort' | 'copy_committed' | 'relationship_committed';
  physicalEndpoint?: MachineInstallationPublicIdentityV1;
  admittedTarget?: Readonly<{ machineId: string; rootPath: string; targetManaged?: WorkspaceSyncLocalManagedTarget }>;
  context?: RpcHandlerContext; signal?: AbortSignal;
}>;

export type DriverConflictObserveInput = Readonly<{
  relationshipId: string; targetMachineId: string; targetWorkspaceRefId: string; path: string; signal?: AbortSignal;
  /** The inspecting ingress, carried to the TARGET authority's installed-writer route. */
  context?: RpcHandlerContext;
}>;

export interface WorkspaceSyncTargetDriver {
  readonly kind: WorkspaceSyncTargetDriverKind;
  prepareBootstrap(input: DriverBootstrapPrepareInput): Promise<DriverBootstrapPrepareResult>;
  releaseBootstrap(input: DriverBootstrapReleaseInput): Promise<void>;
  observeCommittedTarget(input: Readonly<{
    relationship: WorkspaceSyncRelationshipV1; target: WorkspaceRefV1; snapshot?: ActiveProjectAccountRowsSnapshot | null;
  }>): Promise<'present' | 'absent'>;
  stageConflictResolution(request: WorkspaceSyncTargetConflictStageV1 & Readonly<{ signal?: AbortSignal }>, localOnly?: boolean): Promise<void>;
  applyStagedConflictResolution(request: WorkspaceSyncTargetConflictApplyV1 & Readonly<{ signal?: AbortSignal }>, localOnly?: boolean): Promise<WorkspaceSyncTargetConflictApplyResultV1>;
  discardStagedConflictResolution(request: WorkspaceSyncTargetConflictApplyV1 & Readonly<{ signal?: AbortSignal }>, localOnly?: boolean): Promise<void>;
  releaseConflictResolutionCapture(request: WorkspaceSyncConflictCaptureReleaseV1, localOnly?: boolean): Promise<void>;
  recoverConflictResolution(request: WorkspaceSyncTargetConflictRecoverV1 & Readonly<{ signal?: AbortSignal }>, localOnly?: boolean): Promise<WorkspaceSyncTargetConflictRecoverResultV1>;
  readFile(request: WorkspaceSyncTargetFileReadRequest, context?: RpcHandlerContext, localOnly?: boolean): Promise<ReadWorkspaceSyncFileResultV1>;
  observeEntry(request: DriverConflictObserveInput, context?: RpcHandlerContext, localOnly?: boolean): Promise<WorkspaceSyncEntryExpectationV1>;
}

export type TargetDriverSharedDeps = Readonly<{
  localMachineId: string; serverId: string; targetAuthority: WorkspaceSyncTargetAuthority;
  registry: WorkspaceSyncExecutionRegistry;
  resolveLocalResolutionEndpoint: (relationshipId: string, workspaceRefId: string) => Promise<WorkspaceSyncLocalResolutionEndpoint | null>;
  openManagedNative: (relationshipId: string, workspaceRefId: string) => Promise<PrivateProjectNativeSync | null>;
  compositionError: (code: string, message: string) => Error;
}>;

const buildPreviewRequest = (serverId: string, relationship: WorkspaceSyncRelationshipV1, target: WorkspaceRefV1) => ({
  kind: 'preview' as const, workspace: { serverId, refId: relationship.alphaWorkspaceRefId },
  machineId: relationship.controllerMachineId, expectedRelationship: relationship,
  targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(target), targetWorkspaceRefId: target.id,
});

const buildFileReadWire = (r: WorkspaceSyncTargetFileReadRequest): WorkspaceSyncTargetFileReadV1 =>
  WorkspaceSyncTargetFileReadV1Schema.parse({
    relationshipId: r.relationshipId, workspaceRefId: r.targetWorkspaceRefId, path: r.path, maxBytes: r.maxBytes,
    ...(r.expectedDigest === undefined ? {} : { expectedDigest: r.expectedDigest }),
  });

const buildEntryObserveWire = (r: DriverConflictObserveInput): WorkspaceSyncTargetEntryObserveV1 =>
  WorkspaceSyncTargetEntryObserveV1Schema.parse({
    relationshipId: r.relationshipId, workspaceRefId: r.targetWorkspaceRefId, path: r.path,
  });

const targetManagedOf = (target: WorkspaceRefV1): WorkspaceSyncLocalManagedTarget | undefined =>
  isManagedWorkspaceRefV2(target) ? { managedId: target.managedId, controller: target.controller } : undefined;

const phaseRouting = <P extends 'prepare' | 'release' | 'inspect'>(
  phase: P, operationId: string, accountServerId: string, targetMachineId: string, targetRootPath: string,
  targetManaged?: WorkspaceSyncLocalManagedTarget,
) => ({
  v: 1 as const, phase, operationId, accountServerId, targetMachineId, targetRootPath,
  ...(targetManaged ? { targetManaged } : {}),
});

const previewViaPhase = async (
  serverId: string, retained: RetainedWorkspaceSyncPrivateExecution,
  relationship: WorkspaceSyncRelationshipV1, target: WorkspaceRefV1,
): Promise<'present' | 'absent'> => {
  const targetMachineId = resolveWorkspaceSyncExecutionMachineIdV1(target);
  const raw = await retained.execution.callTargetPhase!({
    machineId: targetMachineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT,
    request: buildPreviewRequest(serverId, relationship, target),
    routing: phaseRouting('inspect', retained.input.operationId, serverId, targetMachineId, target.rootPath, targetManagedOf(target)),
  });
  return WorkspaceSyncCommittedCopyPreviewResultV1Schema.parse(raw).ok ? 'present' : 'absent';
};

/** 1. Installed host target driver (host targetAuthority + installed peer RPC). */
export function createInstalledHostDriver(deps: TargetDriverSharedDeps): WorkspaceSyncTargetDriver {
  const { targetAuthority, serverId, compositionError } = deps;
  return {
    kind: 'installed_host',
    async prepareBootstrap({ prepare, context, expectedPhysicalEndpoint }) {
      const prepared = await targetAuthority.prepareBootstrapAtTarget(prepare, context);
      if (expectedPhysicalEndpoint && !isDeepStrictEqual(prepared.physicalEndpoint, expectedPhysicalEndpoint)) {
        throw compositionError('workspace_sync_child_unavailable', 'The installed target changed during preparation');
      }
      return { result: prepared, ...(prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : {}) };
    },
    async releaseBootstrap(input) {
      await targetAuthority.releaseBootstrapAtTarget({
        v: 1, bootstrapOperationId: input.bootstrapOperationId, targetWorkspaceRefId: input.targetWorkspaceRefId,
        targetMachineId: input.physicalEndpoint?.machineId ?? input.targetMachineId,
        ...(input.physicalEndpoint ? { physicalEndpoint: input.physicalEndpoint } : input.admittedTarget ? { admittedTarget: input.admittedTarget } : {}),
        reason: input.reason, ...(input.signal ? { signal: input.signal } : {}),
      }, input.context);
    },
    async observeCommittedTarget({ relationship, target, snapshot }) {
      const result = await targetAuthority.previewCommittedCopyAtTarget(buildPreviewRequest(serverId, relationship, target), undefined, snapshot ?? undefined);
      return result.ok ? 'present' : 'absent';
    },
    stageConflictResolution: ({ signal, ...wire }, localOnly) =>
      localOnly ? targetAuthority.stageConflictResolutionHere(wire, signal) : targetAuthority.stageConflictResolutionAtTarget({ ...wire, ...(signal ? { signal } : {}) }),
    applyStagedConflictResolution: ({ signal, ...wire }, localOnly) =>
      localOnly ? targetAuthority.applyStagedConflictResolutionHere(wire, signal) : targetAuthority.applyStagedConflictResolutionAtTarget({ ...wire, ...(signal ? { signal } : {}) }),
    discardStagedConflictResolution: ({ signal, ...wire }, localOnly) =>
      localOnly ? targetAuthority.discardStagedConflictResolutionHere(wire, signal) : targetAuthority.discardStagedConflictResolutionAtTarget({ ...wire, ...(signal ? { signal } : {}) }),
    releaseConflictResolutionCapture: (request, localOnly) =>
      localOnly ? targetAuthority.releaseConflictResolutionCaptureHere(request) : targetAuthority.releaseConflictResolutionCaptureAtSource(request),
    recoverConflictResolution: ({ signal, ...wire }, localOnly) => {
      if (localOnly) return targetAuthority.recoverConflictResolutionHere(wire, signal);
      logger.debug('[Workspace Sync] Recovery dispatch', { workspaceSyncRecoverySender: 'target_authority' });
      return targetAuthority.recoverConflictResolutionAtTarget({ ...wire, ...(signal ? { signal } : {}) });
    },
    readFile: (request, context, localOnly) =>
      localOnly ? targetAuthority.readFileHere(buildFileReadWire(request), request.signal, context) : targetAuthority.readFileAtTarget(request),
    observeEntry: (request, context, localOnly) =>
      localOnly ? targetAuthority.observeEntryHere(buildEntryObserveWire(request), request.signal, context) : targetAuthority.observeEntryAtTarget(request),
  };
}

/** 2. OS-isolated local member target driver (member-process nativeSync). */
export function createIsolatedMemberDriver(
  deps: TargetDriverSharedDeps, retained: RetainedWorkspaceSyncPrivateExecution,
): WorkspaceSyncTargetDriver {
  const base = createInstalledHostDriver(deps);
  const requireNative = (): PrivateProjectNativeSync => {
    if (!retained.execution.nativeSync) throw deps.compositionError('agent_isolation_unavailable', 'The captured native Sync member is unavailable');
    return retained.execution.nativeSync;
  };
  return {
    ...base,
    kind: 'isolated_member',
    async prepareBootstrap({ prepare }) {
      const prepared = await requireNative().prepareBootstrapAtTarget(prepare);
      return { result: prepared, ...(prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : {}) };
    },
    releaseBootstrap: input => requireNative().releaseBootstrapHere({
      v: 1, bootstrapOperationId: input.bootstrapOperationId, targetWorkspaceRefId: input.targetWorkspaceRefId, reason: input.reason,
    }, input.signal),
    observeCommittedTarget: ({ relationship, target, snapshot }) =>
      base.observeCommittedTarget({ relationship, target, snapshot: snapshot ?? retained.execution.getSnapshot?.() }),
    async recoverConflictResolution(request, localOnly) {
      if (localOnly || request.targetMachineId !== deps.localMachineId) return base.recoverConflictResolution(request, localOnly);
      const localResolutionEndpoint = await deps.resolveLocalResolutionEndpoint(request.relationshipId, request.targetWorkspaceRefId);
      return requireNative().recoverConflictResolutionHere({
        relationshipId: request.relationshipId, targetMachineId: request.targetMachineId, targetWorkspaceRefId: request.targetWorkspaceRefId,
      }, request.signal, { localResolutionEndpoint });
    },
  };
}

/** 3. Signed remote requester target driver (callTargetPhase + requester-scoped recovery/inspect). */
export function createSignedRemoteRequesterDriver(
  deps: TargetDriverSharedDeps, retained: RetainedWorkspaceSyncPrivateExecution,
): WorkspaceSyncTargetDriver {
  const base = createInstalledHostDriver(deps);
  const { localMachineId, serverId, targetAuthority, resolveLocalResolutionEndpoint, compositionError } = deps;
  const requirePhaseCaller = () => {
    if (!retained.execution.callTargetPhase) throw compositionError('workspace_sync_unavailable', 'Private Sync target transport is unavailable');
    return retained.execution.callTargetPhase;
  };
  const inspectRetainedTarget = async (
    method: typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE | typeof RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ,
    wire: WorkspaceSyncTargetEntryObserveV1 | WorkspaceSyncTargetFileReadV1,
    targetMachineId: string, signal?: AbortSignal,
  ) => {
    const snapshot = retained.execution.getSnapshot?.() ?? null;
    const relationship = snapshot?.relationships.find(v => v.relationshipId === wire.relationshipId);
    if (!relationship || !retained.execution.callTargetPhase) {
      throw compositionError('workspace_sync_unavailable', 'The retained Sync target transport is unavailable');
    }
    const alpha = snapshot?.workspaceRefs.find(v => v.id === relationship.alphaWorkspaceRefId && v.serverId === serverId);
    const beta = snapshot?.workspaceRefs.find(v => v.id === relationship.betaWorkspaceRefId && v.serverId === serverId);
    const roles = alpha && beta ? resolveWorkspaceSyncRelationshipEndpointRoles({
      mode: relationship.mode, controllerMachineId: relationship.controllerMachineId,
      alphaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(alpha), betaMachineId: resolveWorkspaceSyncExecutionMachineIdV1(beta),
    }) : null;
    const targetRef = roles ? (roles.targetEndpointRole === 'alpha' ? alpha : beta) : undefined;
    if (!targetRef || resolveWorkspaceSyncExecutionMachineIdV1(targetRef) !== targetMachineId || targetRef.id !== wire.workspaceRefId) {
      throw compositionError('relationship_not_owned', 'The retained Sync target changed');
    }
    return retained.execution.callTargetPhase({
      machineId: targetMachineId, method, request: wire,
      routing: phaseRouting('inspect', retained.input.operationId, serverId, targetMachineId, targetRef.rootPath, targetManagedOf(targetRef)),
      ...(signal ? { signal } : {}),
    });
  };
  return {
    ...base,
    kind: 'signed_remote_requester',
    async prepareBootstrap({ prepare, target }) {
      const { targetMachineId: _targetMachineId, signal, ...wire } = prepare;
      const raw = await requirePhaseCaller()({
        machineId: target.machineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, request: wire,
        routing: phaseRouting('prepare', retained.input.operationId, serverId, retained.input.targetMachineId, retained.input.targetRootPath, target.targetManaged),
        ...(signal ? { signal } : {}),
      });
      const result = prepare.owner.kind === 'copy_once'
        ? { success: true as const, data: WorkspaceSyncTargetBootstrapPrepareResultV1Schema.parse(raw) }
        : raw && typeof raw === 'object' && 'v' in raw ? WorkspaceSyncTargetBootstrapPrepareResultV1Schema.safeParse(raw) : null;
      if (target.machineId === localMachineId && prepare.owner.kind === 'relationship') {
        const owner = retained.execution.nativeSync ?? targetAuthority;
        return { ...(result?.success ? { result: result.data } : {}), ownershipHandles: [await owner.getPreparedBootstrapOwnership(wire)] };
      }
      return result?.success ? { result: result.data } : {};
    },
    async releaseBootstrap(input) {
      await requirePhaseCaller()({
        machineId: input.targetMachineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
        request: { v: 1 as const, bootstrapOperationId: input.bootstrapOperationId, targetWorkspaceRefId: input.targetWorkspaceRefId, reason: input.reason },
        routing: phaseRouting('release', retained.input.operationId, serverId, retained.input.targetMachineId, retained.input.targetRootPath, input.targetManaged),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
    observeCommittedTarget: async ({ relationship, target, snapshot }) => {
      if (!retained.execution.callTargetPhase && resolveWorkspaceSyncExecutionMachineIdV1(target) === localMachineId) {
        return base.observeCommittedTarget({ relationship, target, snapshot: snapshot ?? retained.execution.getSnapshot?.() });
      }
      requirePhaseCaller();
      return previewViaPhase(serverId, retained, relationship, target);
    },
    async recoverConflictResolution(request, localOnly) {
      if (localOnly) return base.recoverConflictResolution(request, localOnly);
      const wireRequest = WorkspaceSyncTargetConflictRecoverV1Schema.parse({
        relationshipId: request.relationshipId, targetMachineId: request.targetMachineId, targetWorkspaceRefId: request.targetWorkspaceRefId,
      });
      if (request.targetMachineId === localMachineId) {
        if (retained.execution.nativeSync && !retained.execution.managedTarget) {
          const localResolutionEndpoint = await resolveLocalResolutionEndpoint(request.relationshipId, request.targetWorkspaceRefId);
          return retained.execution.nativeSync.recoverConflictResolutionHere(wireRequest, request.signal, { localResolutionEndpoint });
        }
        if (retained.execution.executionIdentity?.kind === 'isolated') {
          throw compositionError('agent_isolation_unavailable', 'The captured native Sync member is unavailable');
        }
        const localResolutionEndpoint = await resolveLocalResolutionEndpoint(request.relationshipId, request.targetWorkspaceRefId);
        if (!localResolutionEndpoint || !retained.execution.getSnapshot) {
          throw compositionError('relationship_not_ready', 'The captured Sync source root is unavailable');
        }
        return targetAuthority.recoverConflictResolutionHere(wireRequest, request.signal, {
          localResolutionEndpoint, getProjectSnapshot: retained.execution.getSnapshot,
        });
      }
      logger.debug('[Workspace Sync] Recovery dispatch', {
        workspaceSyncRecoverySender: retained.execution.recoverConflictResolutionAtTarget ? 'retained_preparation' : 'restored_source',
      });
      if (retained.execution.recoverConflictResolutionAtTarget) {
        return retained.execution.recoverConflictResolutionAtTarget(wireRequest, request.signal);
      }
      return WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(readMachineActionRpcResult(await callExactMachineRpc({
        credentials: retained.execution.credentials, serverUrl: retained.execution.accountRowsCustody.serverHttpBaseUrl,
        machineId: request.targetMachineId, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER,
        request: wireRequest, timeoutMs: null, ...(request.signal ? { signal: request.signal } : {}),
      })));
    },
    async readFile(request, context, localOnly) {
      if (localOnly || request.targetMachineId === localMachineId) return base.readFile(request, context, localOnly);
      return ReadWorkspaceSyncFileResultV1Schema.parse(await inspectRetainedTarget(
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ, buildFileReadWire(request), request.targetMachineId, request.signal,
      ));
    },
    async observeEntry(request, context, localOnly) {
      if (localOnly || request.targetMachineId === localMachineId) return base.observeEntry(request, context, localOnly);
      return WorkspaceSyncEntryExpectationV1Schema.parse(await inspectRetainedTarget(
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE, buildEntryObserveWire(request), request.targetMachineId, request.signal,
      ));
    },
  };
}

/** 4. Managed container / box target driver (managedTarget native worker). */
export function createManagedContainerDriver(
  deps: TargetDriverSharedDeps, retained: RetainedWorkspaceSyncPrivateExecution,
): WorkspaceSyncTargetDriver {
  const base = createInstalledHostDriver(deps);
  const requester = createSignedRemoteRequesterDriver(deps, retained);
  const { serverId, targetAuthority, openManagedNative } = deps;
  const withManaged = async <T>(
    relationshipId: string, workspaceRefId: string,
    run: (native: PrivateProjectNativeSync) => Promise<T>, fallback: () => Promise<T>, context?: RpcHandlerContext,
  ): Promise<T> => {
    const native = context?.workspaceSyncSourceWriterTargetRouting ? null : await openManagedNative(relationshipId, workspaceRefId);
    return native ? run(native) : fallback();
  };
  return {
    ...base,
    kind: 'managed_container',
    async prepareBootstrap({ prepare, relationship }) {
      const prepared = await targetAuthority.prepareBootstrapAtTarget({ ...prepare, ...(relationship ? { transientRelationship: relationship } : {}) });
      return { result: prepared, ...(prepared.ownershipHandles ? { ownershipHandles: prepared.ownershipHandles } : {}) };
    },
    releaseBootstrap: input => targetAuthority.releaseBootstrapHere({
      v: 1, bootstrapOperationId: input.bootstrapOperationId, targetWorkspaceRefId: input.targetWorkspaceRefId, reason: input.reason,
    }, input.signal),
    observeCommittedTarget: ({ relationship, target, snapshot }) =>
      retained.execution.callTargetPhase
        ? previewViaPhase(serverId, retained, relationship, target)
        : base.observeCommittedTarget({ relationship, target, snapshot: snapshot ?? retained.execution.getSnapshot?.() }),
    stageConflictResolution: ({ signal, ...wire }, localOnly) =>
      withManaged(wire.relationshipId, wire.targetWorkspaceRefId, n => n.stageConflictResolutionHere(wire, signal), () => base.stageConflictResolution({ ...wire, ...(signal ? { signal } : {}) }, localOnly)),
    applyStagedConflictResolution: ({ signal, ...wire }, localOnly) =>
      withManaged(wire.relationshipId, wire.targetWorkspaceRefId, n => n.applyStagedConflictResolutionHere(wire, signal), () => base.applyStagedConflictResolution({ ...wire, ...(signal ? { signal } : {}) }, localOnly)),
    discardStagedConflictResolution: ({ signal, ...wire }, localOnly) =>
      withManaged(wire.relationshipId, wire.targetWorkspaceRefId, n => n.discardStagedConflictResolutionHere(wire, signal), () => base.discardStagedConflictResolution({ ...wire, ...(signal ? { signal } : {}) }, localOnly)),
    async releaseConflictResolutionCapture(request, localOnly) {
      for (const id of request.actionInput.relationshipIds) {
        const native = await openManagedNative(id, request.sourceWorkspaceRefId);
        if (native) return native.releaseConflictResolutionCaptureHere(request);
      }
      return base.releaseConflictResolutionCapture(request, localOnly);
    },
    recoverConflictResolution: ({ signal, ...wire }, localOnly) =>
      withManaged(wire.relationshipId, wire.targetWorkspaceRefId, n => n.recoverConflictResolutionHere(wire, signal),
        () => (localOnly ? base : requester).recoverConflictResolution({ ...wire, ...(signal ? { signal } : {}) }, localOnly)),
    readFile: (request, context, localOnly) =>
      withManaged(request.relationshipId, request.targetWorkspaceRefId, n => n.readFileHere(buildFileReadWire(request), request.signal),
        () => (localOnly ? base : requester).readFile(request, context, localOnly), context),
    observeEntry: (request, context, localOnly) =>
      withManaged(request.relationshipId, request.targetWorkspaceRefId, n => n.observeEntryHere(buildEntryObserveWire(request), request.signal),
        () => (localOnly ? base : requester).observeEntry(request, context, localOnly), context),
  };
}

/** Single canonical topology selector replacing repeated 4-5-way dispatch ladders. */
export function selectWorkspaceSyncTargetDriver(
  deps: TargetDriverSharedDeps,
  retained: RetainedWorkspaceSyncPrivateExecution | null | undefined,
  targetMachineId?: string,
): WorkspaceSyncTargetDriver {
  if (!retained) return createInstalledHostDriver(deps);
  if (retained.execution.managedTarget) return createManagedContainerDriver(deps, retained);
  const effectiveTargetMachineId = targetMachineId ?? retained.input.targetMachineId;
  if (!retained.execution.callTargetPhase && effectiveTargetMachineId === deps.localMachineId
    && (retained.execution.nativeSync || retained.execution.executionIdentity?.kind === 'isolated')) {
    return createIsolatedMemberDriver(deps, retained);
  }
  return createSignedRemoteRequesterDriver(deps, retained);
}
