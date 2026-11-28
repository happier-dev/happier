import { randomUUID } from 'node:crypto';
import { readRpcErrorCode } from '@happier-dev/protocol/rpc/errors';
import { isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';

import { parseProjectAccountSnapshotV1, assertProjectAccountSnapshotTransition, resolveProjectAccountWorkspaceRefRemovalV1, type ProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { areWorkspaceSyncRelationshipDefinitionsEqual, areWorkspaceSyncWorkerCopyProvenancesEqual, getWorkspaceSyncWorkerCopyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceContentPolicyV1, WorkspaceRefV1, WorkspaceSyncPersistentModeV1, WorkspaceSyncRelationshipV1, WorkspaceSyncStatusV1, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncCommittedCopyTargetV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

import { materializeWorkspaceRefForMachineRoot, materializeWorkspaceRefForManagedRoot, resolveWorkspaceRefById, resolveWorkspaceRefForMachineRoot } from '@/workspaces/workspaceRefsV1';
import type { WorkspaceAddressV2, ManagedWorkspaceRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1, workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { ProjectAccountSnapshotMutation, ProjectAccountSnapshotMutationResult } from '@/workspaces/projectAccountRows';
import type { ProjectWorkerDependency } from '@/workspaces/execution/projectWorkerAdmission';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import type { WorkspaceSyncRelationshipPreparation, WorkspaceSyncRequesterTarget } from './workspaceSyncTypes';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { validateWorkspaceSyncRelationship } from './workspaceSyncSettings';
import type { WorkspaceSyncRelationshipCreateRpcRequestV1, WorkspaceSyncRelationshipCreationObservationV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';

export type { ProjectAccountSnapshotMutation } from '@/workspaces/projectAccountRows';

export type MaterializeWorkspaceSyncEndpointsInput = Readonly<{
  /** Host-derived Account Home scope; never accepted as a user-entered identity. */
  serverId: string;
  sourceMachineId: string;
  sourceRootPath: string;
  targetRootPath: string;
  sourceWorkspaceRefId?: string;
  sourceAddress?: WorkspaceAddressV2;
  targetWorkspaceRefId?: string;
  purpose?: 'worker_clean_copy' | 'project_files';
  signal?: AbortSignal;
}> & (Readonly<{ targetMachineId: string; targetManaged?: never }>
  | Readonly<{ targetMachineId?: never; targetManaged: Pick<ManagedWorkspaceRefV2, 'managedId' | 'controller'> }>);

export type PrepareWorkspaceSyncRelationshipInput = MaterializeWorkspaceSyncEndpointsInput & Readonly<{
  operationId: string;
  replaceRelationshipId?: string;
  mode: WorkspaceSyncPersistentModeV1;
  contentPolicy: WorkspaceContentPolicyV1;
  targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
  flushBeforeCommit: true;
  /** The admitted ingress context, in-process only; its owner decides whether a TARGET call carries it. */
  requesterContext?: RpcHandlerContext;
}>;

export type PreparedWorkspaceSyncRelationship = Readonly<{
  relationship: WorkspaceSyncRelationshipV1;
  status: WorkspaceSyncStatusV1;
  reused: boolean;
  commit(): Promise<WorkspaceSyncRelationshipV1>;
  abort(): Promise<void>;
}>;

export type MaterializedWorkspaceSyncEndpoints = Readonly<{
  source: WorkspaceRefV1;
  target: WorkspaceRefV1;
  withdrawTarget(cause: unknown): Promise<never>;
}>;

export type WorkspaceSyncRelationshipOwner = Readonly<{
  materializeEndpoints(input: MaterializeWorkspaceSyncEndpointsInput): Promise<MaterializedWorkspaceSyncEndpoints>;
  prepareCreate(input: PrepareWorkspaceSyncRelationshipInput): Promise<PreparedWorkspaceSyncRelationship>;
  observeCreation(input: WorkspaceSyncRelationshipCreateRpcRequestV1 & Readonly<{ serverId: string }>): Promise<WorkspaceSyncRelationshipCreationObservationV1>;
  setEnabled(relationshipId: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  /** Settlement failures carry definitionRetired:true only after the graph mutation is confirmed. */
  stop(relationshipId: string, signal?: AbortSignal, retirement?: WorkspaceSyncRelationshipRetirement): Promise<void | Readonly<{ uncheckedMachineIds: readonly string[] }>>;
}>;

export type WorkspaceSyncRelationshipRetirement = Readonly<{
  expectedRelationship: WorkspaceSyncRelationshipV1;
  removeTargetCopy?: Readonly<{ workspaceRefId: string; rootFingerprint: string }>;
  /** Host-injected persisted Action receipt; not a public retirement input field. */
  approval?: WorkspaceSyncCommittedCopyTargetV1;
}>;

export type WorkspaceSyncRelationshipOwnerOptions = Readonly<{
  localMachineId: string;
  mutateProjectSnapshot: ProjectAccountSnapshotMutation;
  /** Reads the latest opened graph and refs through the credentialed row channel. */
  readProjectSnapshot(): Promise<unknown>;
  ensureRelationship(
    definition: WorkspaceSyncRelationshipV1,
    signal?: AbortSignal,
    preparation?: WorkspaceSyncRelationshipPreparation,
  ): Promise<WorkspaceSyncStatusV1>;
  flushRelationship(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  /** Qualifies an admitted requester's TARGET once per creation; undefined keeps today's path. */
  prepareRequesterTarget?(relationship: WorkspaceSyncRelationshipV1, requester: Readonly<{ context: RpcHandlerContext;
    targetBootstrap: PrepareWorkspaceSyncRelationshipInput['targetBootstrap']; signal?: AbortSignal }>): Promise<WorkspaceSyncRequesterTarget | undefined>;
  commitRelationshipTarget(relationship: WorkspaceSyncRelationshipV1, requesterTarget?: WorkspaceSyncRequesterTarget): Promise<void>;
  terminateRelationshipRuntime(relationship: WorkspaceSyncRelationshipV1, requesterTarget?: WorkspaceSyncRequesterTarget): Promise<void>;
  waitForProjectReconciliation(settingsVersion: number, signal?: AbortSignal): Promise<void>;
  readRelationshipDependencies?(relationship: WorkspaceSyncRelationshipV1, snapshot: ProjectAccountSnapshotV1,
    removal?: NonNullable<WorkspaceSyncRelationshipRetirement['removeTargetCopy']>): Promise<Readonly<{ dependencies: readonly ProjectWorkerDependency[]; uncheckedMachineIds?: readonly string[] }>>;
  removeCommittedRelationshipTarget?(relationship: WorkspaceSyncRelationshipV1, approval: WorkspaceSyncCommittedCopyTargetV1,
    retirePreparedCopy: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  createId?: () => string;
  deriveRelationshipId?: (operationId: string) => string;
  nowMs?: () => number;
  /** Passive target observation; absence is distinct from an unreachable peer. */
  observeRelationshipTarget?(relationship: WorkspaceSyncRelationshipV1, target: WorkspaceRefV1): Promise<'present' | 'absent'>;
}>;

/** Preparation failed after runtime cleanup and acknowledged graph rollback; filesystem effects may remain. */
export class WorkspaceSyncPreparationRefusal extends Error {
  readonly code: string;

  constructor(code: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : code, { cause });
    this.name = 'WorkspaceSyncPreparationRefusal';
    this.code = code;
    if (cause && typeof cause === 'object' && 'failureCause' in cause) {
      Object.assign(this, { failureCause: cause.failureCause });
    }
  }
}

function ownerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Home or the receiver refused this step before it ran, by the step's own typed `effectAttempted: false`. */
function isRefusedBeforeEffect(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'effectAttempted' in error && error.effectAttempted === false);
}

/** A settled step's own code, or undefined when it carries none. */
function readFailureCode(error: unknown): string | undefined {
  return readRpcErrorCode(error) ?? (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined);
}

function withCleanupErrors(primary: unknown, cleanupErrors: readonly unknown[]): unknown {
  if (!cleanupErrors.length) return primary;
  const failure = new AggregateError([primary, ...cleanupErrors], primary instanceof Error ? primary.message
    : 'Workspace Sync preparation failed', { cause: primary });
  const code = readRpcErrorCode(primary) ?? (primary && typeof primary === 'object' && 'code' in primary
    && typeof primary.code === 'string' ? primary.code : undefined);
  if (code) Object.assign(failure, { code });
  // The primary step's typed phase passes through unchanged; cleanup never replaces it.
  const failureCause = primary && typeof primary === 'object' && 'failureCause' in primary ? primary.failureCause : undefined;
  if (failureCause !== undefined) Object.assign(failure, { failureCause });
  return failure;
}

function isSettledMutation(
  result: ProjectAccountSnapshotMutationResult,
): result is Extract<ProjectAccountSnapshotMutationResult, { status: 'applied' | 'unchanged' }> {
  return result.status === 'applied' || result.status === 'unchanged';
}

function parseRefs(settings: unknown): readonly WorkspaceRefV1[] {
  try {
    return parseProjectAccountSnapshotV1(settings).workspaceRefs;
  } catch (cause) {
    throw ownerError('workspace_sync_settings_invalid', cause instanceof Error ? cause.message : 'Workspace references are invalid');
  }
}

function parseRelationships(settings: unknown): readonly WorkspaceSyncRelationshipV1[] {
  try {
    return parseProjectAccountSnapshotV1(settings).relationships;
  } catch (cause) {
    throw ownerError('workspace_sync_settings_invalid', cause instanceof Error ? cause.message : 'Workspace relationships are invalid');
  }
}

function admitProjectSnapshotTransition<T extends ProjectAccountSnapshotV1>(
  previous: ProjectAccountSnapshotV1,
  next: T,
): T {
  assertProjectAccountSnapshotTransition(previous, next);
  return next;
}

function unorderedPairMatches(
  relationship: WorkspaceSyncRelationshipV1,
  alphaRefId: string,
  betaRefId: string,
): boolean {
  return (relationship.alphaWorkspaceRefId === alphaRefId && relationship.betaWorkspaceRefId === betaRefId)
    || (relationship.alphaWorkspaceRefId === betaRefId && relationship.betaWorkspaceRefId === alphaRefId);
}

function resolveEndpointPair(
  relationships: readonly WorkspaceSyncRelationshipV1[],
  requested: WorkspaceSyncRelationshipV1,
): WorkspaceSyncRelationshipV1 | null {
  if (relationships.some(relationship => unorderedPairMatches(relationship,
    requested.alphaWorkspaceRefId, requested.betaWorkspaceRefId)
    && !areWorkspaceSyncWorkerCopyProvenancesEqual(relationship, requested))) {
    throw ownerError('relationship_provenance_conflict', 'Workspace copy purpose differs from its creation provenance');
  }
  const identityMatches = relationships.filter((relationship) => (
    relationship.relationshipId === requested.relationshipId
  ));
  if (identityMatches.length > 1) {
    throw ownerError('relationship_definition_conflict', 'Workspace relationship identity is duplicated');
  }
  const identityMatch = identityMatches[0];
  if (identityMatch) {
    if (!areWorkspaceSyncRelationshipDefinitionsEqual(identityMatch, requested)) {
      throw ownerError('relationship_definition_conflict', 'Workspace relationship identity has a different immutable definition');
    }
    return identityMatch;
  }

  const matches = relationships.filter((relationship) => unorderedPairMatches(
    relationship,
    requested.alphaWorkspaceRefId,
    requested.betaWorkspaceRefId,
  ));
  if (matches.length > 1) throw ownerError('relationship_definition_conflict', 'Multiple relationships own this workspace pair');
  const existing = matches[0];
  if (!existing) return null;
  throw ownerError('relationship_replacement_required', 'This workspace pair is owned by a different relationship');
}

function matchesReviewedRelationship(current: WorkspaceSyncRelationshipV1, expected: WorkspaceSyncRelationshipV1): boolean {
  return current.relationshipId === expected.relationshipId
    && areWorkspaceSyncRelationshipDefinitionsEqual(current, expected)
    && areWorkspaceSyncWorkerCopyProvenancesEqual(current, expected)
    && current.enabled === expected.enabled
    && current.createdAtMs === expected.createdAtMs
    && current.updatedAtMs === expected.updatedAtMs;
}

function mutationFailure(result: ProjectAccountSnapshotMutationResult): Error & { code: string } {
  if (result.status === 'conflict') return ownerError('workspace_sync_settings_conflict', 'Account Settings changed concurrently');
  if (result.status === 'cancelled') return ownerError('cancelled', 'Workspace relationship mutation was cancelled');
  if (result.status === 'outcomeUnknown') return ownerError('indeterminate', 'Workspace relationship settings outcome is unknown');
  return ownerError('workspace_sync_settings_unavailable', `Workspace relationship settings mutation failed: ${result.status}`);
}

/** Codes by which runtime reconciliation says an endpoint is not ready yet, not that the request failed. */
const RECONCILING_REFUSAL_CODES: ReadonlySet<string> = new Set(['peer_unavailable', 'relationship_not_ready', 'agent_unavailable']);

function isReconcilingRefusal(error: unknown): boolean {
  const code = readRpcErrorCode(error) ?? (typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' ? error.code : undefined);
  return isMachineRequestReachabilityFailureV1(error) || (code !== undefined && RECONCILING_REFUSAL_CODES.has(code));
}

function isIndeterminate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'indeterminate';
}

function preparationRefusal(error: unknown, signal?: AbortSignal): unknown {
  const code = readFailureCode(error);
  return signal?.aborted || !code || code === 'cancelled' || isIndeterminate(error)
    || error instanceof WorkspaceSyncPreparationRefusal || error instanceof AggregateError
    ? error : new WorkspaceSyncPreparationRefusal(code, error);
}

/**
 * Test-only determinism seam. Production must keep the canonical rule, because
 * the target daemon re-derives it to authorize destructive replacement; a test
 * that overrides it cannot carry a target replacement approval.
 */
const defaultRelationshipId = deriveWorkspaceSyncRelationshipId;

export function createWorkspaceSyncRelationshipOwner(
  options: WorkspaceSyncRelationshipOwnerOptions,
): WorkspaceSyncRelationshipOwner {
  const createId = options.createId ?? randomUUID;
  const deriveRelationshipId = options.deriveRelationshipId ?? defaultRelationshipId;
  const nowMs = options.nowMs ?? Date.now;
  const mutateProjectSnapshot: ProjectAccountSnapshotMutation = async (mutate, signal) => {
    for (;;) {
      signal?.throwIfAborted();
      const result = await options.mutateProjectSnapshot(mutate, signal);
      if (result.status !== 'conflict') return result;
      // A fresh row census re-runs the same semantic admission. No local lock
      // can authorize the refs that were observed before a graph conflict.
    }
  };

  const publishEndpoints = async (input: MaterializeWorkspaceSyncEndpointsInput) => {
    let sourceRef!: WorkspaceRefV1;
    let targetRef!: WorkspaceRefV1;
    let targetCreated = false;
    const result = await mutateProjectSnapshot((settings) => {
      const refs = parseRefs(settings);
      const first = input.sourceAddress
        ? (() => {
            const source = resolveWorkspaceRefV1(refs, input.sourceAddress);
            if (source.kind !== 'resolved') {
              throw ownerError('workspace_ref_not_ready', 'Prepared managed source is no longer current');
            }
            return { workspaceRef: source.ref, workspaceRefs: refs };
          })()
        : materializeWorkspaceRefForMachineRoot(refs, {
            serverId: input.serverId,
            machineId: input.sourceMachineId,
            rootPath: input.sourceRootPath,
            nowMs: nowMs(),
            createId: () => input.sourceWorkspaceRefId ?? createId(),
          });
      const targetInput = {
        serverId: input.serverId,
        rootPath: input.targetRootPath,
        ...(input.purpose === 'worker_clean_copy' || input.purpose === 'project_files' ? { parentWorkspace: workspaceAddressFromRefV2(first.workspaceRef) } : {}),
        nowMs: nowMs(),
        createId: () => input.targetWorkspaceRefId ?? createId(),
      };
      const second = input.targetManaged
        ? materializeWorkspaceRefForManagedRoot(first.workspaceRefs, { ...targetInput, ...input.targetManaged })
        : materializeWorkspaceRefForMachineRoot(first.workspaceRefs, { ...targetInput, machineId: input.targetMachineId });
      if ((input.sourceWorkspaceRefId && first.workspaceRef.id !== input.sourceWorkspaceRefId)
        || (input.targetWorkspaceRefId && second.workspaceRef.id !== input.targetWorkspaceRefId)) {
        throw ownerError('workspace_ref_not_ready', 'Prepared workspace endpoint identity differs from its existing root');
      }
      sourceRef = first.workspaceRef;
      targetRef = second.workspaceRef;
      targetCreated = second.created;
      return admitProjectSnapshotTransition(settings, { ...settings, workspaceRefs: second.workspaceRefs });
    }, input.signal);
    if (!isSettledMutation(result)) throw mutationFailure(result);
    try {
      const current = await options.readProjectSnapshot();
      await options.waitForProjectReconciliation(result.version, input.signal);
      const currentRefs = parseRefs(current);
      const source = resolveWorkspaceRefById(currentRefs, sourceRef.id, input.serverId);
      const target = resolveWorkspaceRefById(currentRefs, targetRef.id, input.serverId);
      if (!source || !target) throw ownerError('workspace_ref_not_ready', 'Materialized workspace endpoints are unavailable');
      return { endpoints: { source, target }, targetCreated };
    } catch (error) {
      return withdrawUnstagedTarget(targetCreated ? targetRef : undefined, error);
    }
  };

  const rollbackCreationRows = async (
    relationshipId: string | null,
    mutate: (relationships: readonly WorkspaceSyncRelationshipV1[]) => readonly WorkspaceSyncRelationshipV1[],
    createdTarget?: WorkspaceRefV1,
  ): Promise<number> => {
    const desiredRelationships: { value: readonly WorkspaceSyncRelationshipV1[] | null } = { value: null };
    let targetToWithdraw: WorkspaceRefV1 | undefined;
    const result = await mutateProjectSnapshot((settings) => {
      desiredRelationships.value = mutate(parseRelationships(settings));
      const next = { ...settings, relationships: desiredRelationships.value };
      targetToWithdraw = undefined;
      if (createdTarget) {
        try {
          next.workspaceRefs = resolveProjectAccountWorkspaceRefRemovalV1(next, {
            serverId: createdTarget.serverId, workspaceRefId: createdTarget.id,
          });
          targetToWithdraw = createdTarget;
        } catch (error) {
          if (readFailureCode(error) !== 'workspace_ref_in_use') throw error;
        }
      }
      return admitProjectSnapshotTransition(settings, next);
    });
    if (!isSettledMutation(result)) {
      if (result.status === 'outcomeUnknown') {
        const current = parseProjectAccountSnapshotV1(await options.readProjectSnapshot());
        const present = current.relationships.find((relationship) => relationship.relationshipId === relationshipId);
        const expectedPresent = desiredRelationships.value?.find((relationship) => relationship.relationshipId === relationshipId);
        if ((present?.enabled ?? null) === (expectedPresent?.enabled ?? null)
          && (!targetToWithdraw || !resolveWorkspaceRefById(current.workspaceRefs, targetToWithdraw.id, targetToWithdraw.serverId))) {
          return result.lastKnownVersion;
        }
      }
      throw mutationFailure(result);
    }
    return result.version;
  };

  const withdrawUnstagedTarget = async (target: WorkspaceRefV1 | undefined, cause: unknown): Promise<never> => {
    if (target && !isIndeterminate(cause)) {
      try {
        const version = await rollbackCreationRows(null, relationships => relationships, target);
        await options.waitForProjectReconciliation(version);
      } catch (error) {
        throw withCleanupErrors(cause, [error]);
      }
    }
    throw cause;
  };

  const transitionDesiredRelationship = async (
    relationshipId: string,
    project: (relationship: WorkspaceSyncRelationshipV1) => WorkspaceSyncRelationshipV1 | null,
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await mutateProjectSnapshot((settings) => {
      const relationships = parseRelationships(settings);
      const matches = relationships.filter((relationship) => relationship.relationshipId === relationshipId);
      if (matches.length !== 1) throw ownerError('relationship_not_ready', 'Workspace relationship is unavailable');
      const projected = project(matches[0]!);
      return admitProjectSnapshotTransition(settings, {
        ...settings,
        relationships: projected === null
          ? relationships.filter((relationship) => relationship.relationshipId !== relationshipId)
          : relationships.map((relationship) => relationship.relationshipId === relationshipId ? projected : relationship),
      });
    }, signal);

    let settingsVersion: number;
    if (isSettledMutation(result)) {
      settingsVersion = result.version;
    } else {
      // Direct lifecycle RPCs do not currently carry an action-operation id.
      // A lost settings acknowledgement therefore cannot be promoted to
      // success from a later read or safely compensated under a new identity.
      throw mutationFailure(result);
    }

    try {
      await options.waitForProjectReconciliation(settingsVersion, signal);
    } catch (error) {
      // The request is committed. While the sync agent restarts, runtime
      // reconciliation refuses with a "not ready yet" code and converges by
      // itself (the runtime keeps reconciliation required until it succeeds);
      // the row follows the status projection. Reporting that refusal would tell
      // the person a request that took effect had failed.
      if (!isReconcilingRefusal(error)) throw error;
    }
  };

  const assertNoDependencies = async (relationship: WorkspaceSyncRelationshipV1, snapshot: ProjectAccountSnapshotV1,
    retirement?: WorkspaceSyncRelationshipRetirement) => {
    if (retirement && !options.readRelationshipDependencies) {
      throw ownerError('workspace_sync_dependencies_unavailable', 'Workspace relationship dependencies are unavailable');
    }
    const observation = await options.readRelationshipDependencies?.(relationship, snapshot, retirement?.removeTargetCopy);
    const dependencies = observation?.dependencies ?? [];
    if (dependencies.length > 0) {
      throw Object.assign(ownerError('workspace_sync_relationship_in_use', 'Workspace relationship has dependent work'), { dependencies });
    }
    return observation?.uncheckedMachineIds;
  };

  const stop: WorkspaceSyncRelationshipOwner['stop'] = async (relationshipId, signal, retirement) => {
    const removal = retirement?.removeTargetCopy;
    const currentRelationship = (snapshot: ProjectAccountSnapshotV1) => {
      const relationships = parseRelationships(snapshot);
      const matches = relationships.filter(relationship => relationship.relationshipId === relationshipId);
      if (matches.length !== 1) throw ownerError('relationship_not_ready', 'Workspace relationship is unavailable');
      const current = matches[0]!;
      if (!retirement) return current;
      const workerCopy = getWorkspaceSyncWorkerCopyV1(current);
      if (!workerCopy) throw ownerError('workspace_copy_not_worker', 'Workspace relationship has no worker-copy creation provenance');
      if (removal && removal.workspaceRefId !== workerCopy.targetWorkspaceRefId) {
        throw ownerError('workspace_unavailable', 'Workspace removal is not the worker-copy target');
      }
      if (!matchesReviewedRelationship(current, retirement.expectedRelationship)) {
        throw ownerError('relationship_definition_conflict', 'Workspace relationship changed since review');
      }
      return current;
    };
    let definitionRetired = false;
    let uncheckedMachineIds: readonly string[] | undefined;
    const observationResult = () => uncheckedMachineIds?.length ? { uncheckedMachineIds } : undefined;
    const retire = async () => {
      const result = await mutateProjectSnapshot(async settings => {
        const current = currentRelationship(settings);
        if (!removal) uncheckedMachineIds = await assertNoDependencies(current, settings, retirement);
        return admitProjectSnapshotTransition(settings, { ...settings,
          relationships: settings.relationships.filter(relationship => relationship.relationshipId !== relationshipId),
        });
      }, signal);
      if (!isSettledMutation(result)) throw mutationFailure(result);
      definitionRetired = true;
      await options.waitForProjectReconciliation(result.version, signal);
    };

    let retirementRefusal: unknown;
    try {
      if (!removal) {
        await retire();
        return observationResult();
      }
      const snapshot = parseProjectAccountSnapshotV1(await options.readProjectSnapshot());
      const relationship = currentRelationship(snapshot);
      const approval = retirement?.approval;
      if (!options.removeCommittedRelationshipTarget) {
        throw ownerError('workspace_copy_removal_unavailable', 'Committed copy removal is unavailable');
      }
      if (!approval) throw ownerError('approval_required', 'Committed copy removal has no Action receipt');
      if (!matchesReviewedRelationship(relationship, approval.actionInput.expectedRelationship)
        || approval.actionInput.removeTargetCopy?.workspaceRefId !== removal.workspaceRefId
        || approval.actionInput.removeTargetCopy?.rootFingerprint !== removal.rootFingerprint) {
        throw ownerError('approval_stale', 'Committed copy removal differs from the reviewed Action');
      }
      await assertNoDependencies(relationship, snapshot, retirement);
      await options.removeCommittedRelationshipTarget(relationship, approval, async () => {
        try {
          await retire();
        } catch (error) {
          // A remote continuation reports only transport-safe errors. The
          // controller can still return its own original graph refusal.
          retirementRefusal = error;
          throw error;
        }
      }, signal);
      if (!definitionRetired) throw ownerError('workspace_copy_removal_unavailable', 'Target did not settle the reviewed retirement');
    } catch (cause) {
      const error = retirementRefusal ?? cause;
      if (!definitionRetired) throw error;
      // Plain stop has already committed, and a restarting Sync runtime will converge.
      if (!removal && isReconcilingRefusal(error)) return observationResult();
      const failure = typeof error === 'object' && error !== null
        ? error : new Error('Workspace relationship retirement settlement failed', { cause: error });
      throw Object.assign(failure, { definitionRetired: true });
    }
  };

  const activeCreations = new Set<string>();
  const prepareCreate = async (input: PrepareWorkspaceSyncRelationshipInput): Promise<PreparedWorkspaceSyncRelationship> => {
      input.signal?.throwIfAborted();
      if (input.sourceMachineId !== options.localMachineId) {
        throw ownerError('workspace_sync_controller_mismatch', 'Relationship creation must run on its source controller machine');
      }

      const { endpoints, targetCreated } = await publishEndpoints(input)
        .catch((error: unknown) => { throw preparationRefusal(error, input.signal); });
      const refuseBeforeStaging = async (error: unknown): Promise<never> =>
        withdrawUnstagedTarget(targetCreated ? endpoints.target : undefined, error)
          .catch((failure: unknown) => { throw preparationRefusal(failure, input.signal); });
      const { candidate, existing, replacedRelationship } = await (async () => {
        const current = await options.readProjectSnapshot();
        const timestamp = nowMs();
        const candidate = validateWorkspaceSyncRelationship({
          v: 1,
          relationshipId: deriveRelationshipId(input.operationId),
          controllerMachineId: options.localMachineId,
          alphaWorkspaceRefId: endpoints.source.id,
          betaWorkspaceRefId: endpoints.target.id,
          ...(input.purpose === 'worker_clean_copy' ? { committedAtMs: null, provenance: {
            kind: 'worker_clean_copy', sourceWorkspaceRefId: endpoints.source.id, targetWorkspaceRefId: endpoints.target.id,
          } } : {}),
          mode: input.mode,
          contentPolicy: input.contentPolicy,
          enabled: true,
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
        });
        let relationships = parseRelationships(current);
        let replacedRelationship: WorkspaceSyncRelationshipV1 | undefined;
        if (input.replaceRelationshipId) {
          const previous = relationships.find(value => value.relationshipId === input.replaceRelationshipId);
          const replay = relationships.find(value => value.relationshipId === candidate.relationshipId);
          if (!previous && !replay) {
            throw ownerError('relationship_not_ready', 'The link selected for replacement is unavailable');
          }
          if (previous) {
            if (previous.relationshipId === candidate.relationshipId
              || previous.controllerMachineId !== options.localMachineId
              || previous.alphaWorkspaceRefId !== candidate.alphaWorkspaceRefId
              || previous.betaWorkspaceRefId !== candidate.betaWorkspaceRefId
              || !areWorkspaceSyncWorkerCopyProvenancesEqual(previous, candidate)) {
              throw ownerError('relationship_definition_conflict', 'Replacement needs a new identity with the selected link endpoints and purpose');
            }
            replacedRelationship = previous;
            relationships = relationships.filter(value => value.relationshipId !== previous.relationshipId);
          }
        }
        const existing = resolveEndpointPair(relationships, candidate);
        if (input.purpose === 'worker_clean_copy'
          && (endpoints.target.projectKey ?? endpoints.target.id) !== (endpoints.source.projectKey ?? endpoints.source.id)) {
          throw ownerError('project_workspace_changed', 'The chosen worker folder belongs to a different Project');
        }
        return { candidate, existing, replacedRelationship };
      })().catch(refuseBeforeStaging);
      const relationship = existing ?? candidate;
      const runtimeRelationship = relationship.enabled
        ? relationship
        : validateWorkspaceSyncRelationship({ ...relationship, enabled: true });
      const reused = existing !== null;
      const runtimeOwnedByTransaction = existing?.enabled !== true;
      let closed = false;
      let published = false;
      let publishedRelationship = relationship;
      let durableIntentStaged = existing?.enabled === true;
      let stagedSettingsVersion: number | null = null;
      let stagedReconciliationComplete = existing?.enabled === true;
      let publishedSettingsVersion: number | null = null;
      let reconciliationComplete = false;
      let targetCommitted = false;
      let predecessorReleased = false;
      // The admitted requester's TARGET path, qualified before any effect; held for this transaction only.
      let requesterTarget: WorkspaceSyncRequesterTarget | undefined;
      // Without one, each release keeps today's exact call.
      const heldRequesterTarget = (): [] | [WorkspaceSyncRequesterTarget] => requesterTarget ? [requesterTarget] : [];
      if (input.requesterContext && runtimeOwnedByTransaction && options.prepareRequesterTarget) {
        try {
          requesterTarget = await options.prepareRequesterTarget(runtimeRelationship, { context: input.requesterContext,
            targetBootstrap: input.targetBootstrap, ...(input.signal ? { signal: input.signal } : {}) });
        } catch (error) {
          return refuseBeforeStaging(error);
        }
      }

      const stageDurableIntent = async (): Promise<void> => {
        if (!durableIntentStaged) {
          let stagedRelationship: WorkspaceSyncRelationshipV1 | null = null;
          const result = await mutateProjectSnapshot(async (settings) => {
            let relationships = parseRelationships(settings);
            if (replacedRelationship) {
              // A Replace is one graph transition: the predecessor leaves in the
              // same write that stages its successor, so topology admission sees
              // the graph the Replace produces. A failure restores it below.
              const predecessor = relationships.find(value => value.relationshipId === replacedRelationship!.relationshipId);
              if (!predecessor || !matchesReviewedRelationship(predecessor, replacedRelationship)) {
                throw ownerError('relationship_definition_conflict', 'The link selected for replacement changed');
              }
              await assertNoDependencies(predecessor, settings);
              relationships = relationships.filter(value => value.relationshipId !== predecessor.relationshipId);
            }
            const winner = resolveEndpointPair(relationships, relationship);
            const staged = validateWorkspaceSyncRelationship(winner
              ? { ...winner, enabled: false, updatedAtMs: nowMs() }
              : { ...relationship, enabled: false });
            stagedRelationship = staged;
            return admitProjectSnapshotTransition(settings, {
              ...settings,
              relationships: winner
                ? relationships.map((value) => value.relationshipId === winner.relationshipId ? staged : value)
                : [...relationships, staged],
            });
          }, input.signal);
          if (!isSettledMutation(result)) {
            const observed = await options.readProjectSnapshot()
              .then(current => resolveEndpointPair(parseRelationships(current), relationship))
              .catch(() => { throw mutationFailure(result); });
            if (!observed || observed.enabled) throw mutationFailure(result);
            durableIntentStaged = true;
            publishedRelationship = observed;
            stagedSettingsVersion = result.status === 'outcomeUnknown' ? result.lastKnownVersion : null;
          } else {
            durableIntentStaged = true;
            publishedRelationship = stagedRelationship ?? publishedRelationship;
            stagedSettingsVersion = result.version;
          }
        }
        if (replacedRelationship && !predecessorReleased) {
          // The predecessor left the graph with the swap. Its runtime and TARGET
          // custody end before the staged successor is fenced on the same roots.
          // A failure from here on restores the predecessor row, and
          // reconciliation re-establishes its runtime as after a daemon restart.
          predecessorReleased = true;
          await options.terminateRelationshipRuntime(replacedRelationship);
        }
        if (!stagedReconciliationComplete && stagedSettingsVersion !== null) {
          await options.waitForProjectReconciliation(stagedSettingsVersion, input.signal);
          stagedReconciliationComplete = true;
        }
      };

      const restoreStagedIntent = async (): Promise<void> => {
        if (!durableIntentStaged || !runtimeOwnedByTransaction || publishedRelationship.relationshipId !== relationship.relationshipId) return;
        const rollbackVersion = await rollbackCreationRows(relationship.relationshipId, (relationships) => {
          const current = relationships.find((value) => value.relationshipId === relationship.relationshipId);
          if (!current) return relationships;
          if (existing) {
            return relationships.map((value) => value.relationshipId === relationship.relationshipId ? existing : value);
          }
          const remaining = relationships.filter((value) => value.relationshipId !== relationship.relationshipId);
          // A failed Replace puts the person's original link back exactly as reviewed.
          return replacedRelationship && !remaining.some(value => value.relationshipId === replacedRelationship!.relationshipId)
            ? [...remaining, replacedRelationship] : remaining;
        }, targetCreated && !published ? endpoints.target : undefined);
        await options.waitForProjectReconciliation(rollbackVersion);
      };

      const cleanupFailedCreation = async (definition: WorkspaceSyncRelationshipV1, ensureRefusedBeforeEffect = false): Promise<unknown[]> => {
        const cleanupErrors: unknown[] = [];
        try {
          await options.terminateRelationshipRuntime(definition, ...heldRequesterTarget());
        } catch (cleanupError) {
          // Ensure prepares the target first: refused before that effect, there is
          // nothing to release, so a release also refused before it ran is not pending.
          if (!ensureRefusedBeforeEffect || !isRefusedBeforeEffect(cleanupError)) cleanupErrors.push(cleanupError);
        }
        // Restore staged intent even when runtime termination fails, preserving
        // cleanup failures alongside the original preparation or commit cause.
        try {
          await restoreStagedIntent();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        return cleanupErrors;
      };

      try {
        await stageDurableIntent();
      } catch (error) {
        if (!durableIntentStaged) {
          return refuseBeforeStaging(error);
        }
        if (isIndeterminate(error)) throw error;
        if (replacedRelationship) {
          const cleanupErrors = await cleanupFailedCreation(relationship);
          if (cleanupErrors.length) throw withCleanupErrors(error, cleanupErrors);
        } else if (!existing) {
          // Disabled reconciliation can refuse a root before target preparation starts.
          // Withdraw this attempt's row so it cannot block the next reconciliation.
          try {
            await restoreStagedIntent();
          } catch (cleanupError) {
            throw withCleanupErrors(error, [cleanupError]);
          }
          throw preparationRefusal(error, input.signal);
        }
        throw error;
      }
      let status: WorkspaceSyncStatusV1;
      let ensureRefusedBeforeEffect = false;
      try {
        status = await options.ensureRelationship(
          runtimeRelationship,
          input.signal,
          existing?.enabled === true
            ? undefined
            : {
                transient: true,
                targetBootstrap: input.targetBootstrap,
                ...(input.replaceRelationshipId ? { replaceRelationshipId: input.replaceRelationshipId } : {}),
                ...(input.targetReplacementApproval
                  ? { targetReplacementApproval: input.targetReplacementApproval,
                      targetReplacementApprovalActionInput: input.targetReplacementApprovalActionInput }
                  : {}),
                ...(input.targetReplacementApprovalReceiptId ? {
                  targetReplacementApprovalReceiptId: input.targetReplacementApprovalReceiptId,
                } : {}),
                ...(requesterTarget ? { requesterTarget } : {}),
              },
        ).catch((error: unknown) => {
          ensureRefusedBeforeEffect = isRefusedBeforeEffect(error);
          throw error;
        });
        status = await options.flushRelationship(relationship.relationshipId, input.signal);
      } catch (error) {
        if (runtimeOwnedByTransaction && !isIndeterminate(error)) {
          const cleanupErrors = await cleanupFailedCreation(relationship, ensureRefusedBeforeEffect);
          if (cleanupErrors.length) {
            throw withCleanupErrors(error, cleanupErrors);
          }
          throw preparationRefusal(error, input.signal);
        }
        throw error;
      }
      return Object.freeze({
        relationship,
        status,
        reused,
        async commit(): Promise<WorkspaceSyncRelationshipV1> {
          if (closed) return publishedRelationship;
          let outcomeUnknownThisAttempt = false;
          try {
            await stageDurableIntent();
            if (!targetCommitted) {
              await options.commitRelationshipTarget(runtimeRelationship, ...heldRequesterTarget());
              targetCommitted = true;
            }
            if (!published) {
              const result = await mutateProjectSnapshot((settings) => {
                const relationships = parseRelationships(settings);
                const winner = resolveEndpointPair(relationships, relationship);
                if (winner?.enabled && (!getWorkspaceSyncWorkerCopyV1(winner) || winner.committedAtMs !== null)) return settings;
                if (!winner) {
                  throw ownerError('relationship_not_ready', 'Workspace relationship staging intent is unavailable');
                }
                const timestamp = nowMs();
                const committed = { ...winner, enabled: true, updatedAtMs: timestamp,
                  ...(getWorkspaceSyncWorkerCopyV1(winner) ? { committedAtMs: winner.committedAtMs ?? timestamp } : {}),
                };
                return admitProjectSnapshotTransition(settings, {
                  ...settings,
                  relationships: relationships.map((value) => (
                    value.relationshipId === winner.relationshipId ? committed : value
                  )),
                });
              }, input.signal);
              if (!isSettledMutation(result)) {
                outcomeUnknownThisAttempt = result.status === 'outcomeUnknown';
                const observed = resolveEndpointPair(parseRelationships(await options.readProjectSnapshot()), relationship);
                if (!observed?.enabled) throw mutationFailure(result);
                published = true;
                publishedRelationship = observed;
                publishedSettingsVersion = result.status === 'outcomeUnknown' ? result.lastKnownVersion : null;
              } else {
                published = true;
                publishedSettingsVersion = result.version;
              }
            }
            if (!reconciliationComplete && publishedSettingsVersion !== null) {
              await options.waitForProjectReconciliation(publishedSettingsVersion, input.signal);
              reconciliationComplete = true;
            }
            const committedSettings = await options.readProjectSnapshot();
            publishedRelationship = resolveEndpointPair(parseRelationships(committedSettings), relationship) ?? publishedRelationship;
            return publishedRelationship;
          } catch (error) {
            const failure = !published && outcomeUnknownThisAttempt && !isIndeterminate(error)
              ? ownerError('indeterminate', 'Workspace relationship settings outcome is unknown')
              : error;
            if (!published && runtimeOwnedByTransaction && !isIndeterminate(failure)) {
              const cleanupErrors = await cleanupFailedCreation(runtimeRelationship);
              if (cleanupErrors.length) throw withCleanupErrors(failure, cleanupErrors);
              closed = true;
            }
            throw failure;
          }
        },
        async abort(): Promise<void> {
          if (closed) return;
          if (targetCreated && !published && runtimeOwnedByTransaction) {
            // TARGET release still needs the ref to route the abort.
            const cleanupErrors = await cleanupFailedCreation(runtimeRelationship);
            if (cleanupErrors.length) throw withCleanupErrors(cleanupErrors[0], cleanupErrors.slice(1));
          } else {
            await restoreStagedIntent();
            if (runtimeOwnedByTransaction) await options.terminateRelationshipRuntime(runtimeRelationship, ...heldRequesterTarget());
          }
          closed = true;
        },
      });

  };

  return Object.freeze({
    async materializeEndpoints(input) {
      const { endpoints, targetCreated } = await publishEndpoints(input);
      return { ...endpoints, withdrawTarget: cause => withdrawUnstagedTarget(targetCreated ? endpoints.target : undefined, cause) };
    },
    async prepareCreate(input): Promise<PreparedWorkspaceSyncRelationship> {
      activeCreations.add(input.operationId);
      try {
        const prepared = await prepareCreate(input);
        return { ...prepared,
          commit: async () => { try { return await prepared.commit(); } finally { activeCreations.delete(input.operationId); } },
          abort: async () => { try { await prepared.abort(); } finally { activeCreations.delete(input.operationId); } },
        };
      } catch (error) { activeCreations.delete(input.operationId); throw error; }
    },
    async observeCreation(input): Promise<WorkspaceSyncRelationshipCreationObservationV1> {
      if (activeCreations.has(input.operationId)) return { outcome: 'unknown' };
      // Attaching an existing checkout has no materialization custody to read
      // back. Do not mistake mere directory presence for a committed copy.
      if (input.actionInput.purpose !== 'worker_clean_copy') return { outcome: 'unknown' };
      const snapshot = parseProjectAccountSnapshotV1(await options.readProjectSnapshot());
      const source = resolveWorkspaceRefById(snapshot.workspaceRefs, input.actionInput.sourceWorkspaceRefId, input.serverId);
      if (!source || resolveWorkspaceSyncExecutionMachineIdV1(source) !== options.localMachineId) {
        throw ownerError('workspace_sync_controller_mismatch', 'Creation read-back must run on its source controller');
      }
      const target = resolveWorkspaceRefForMachineRoot(snapshot.workspaceRefs, { serverId: input.serverId,
        machineId: input.actionInput.targetMachineId, rootPath: input.actionInput.targetPath });
      const relationship = snapshot.relationships.find(value => value.relationshipId === deriveRelationshipId(input.operationId));
      if (relationship?.committedAtMs == null) return { outcome: 'failed', errorCode: 'workspace_sync_relationship_not_committed' };
      if (!target) return { outcome: 'unknown' };
      const candidate = validateWorkspaceSyncRelationship({ ...relationship, controllerMachineId: options.localMachineId,
        alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id,
        mode: input.actionInput.mode, contentPolicy: input.actionInput.contentPolicy,
        provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id },
      });
      resolveEndpointPair(snapshot.relationships, candidate);
      if (!options.observeRelationshipTarget) return { outcome: 'unknown' };
      try {
        if (await options.observeRelationshipTarget(relationship, target) === 'absent') {
          return { outcome: 'failed', errorCode: 'workspace_sync_copy_absent' };
        }
      } catch { return { outcome: 'unknown' }; }
      return { outcome: 'succeeded', relationshipId: relationship.relationshipId,
        controllerMachineId: relationship.controllerMachineId, sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id };
    },

    async setEnabled(relationshipId, enabled, signal): Promise<void> {
      await transitionDesiredRelationship(
        relationshipId,
        (relationship) => ({ ...relationship, enabled, updatedAtMs: nowMs() }),
        signal,
      );
    },

    stop,
  });
}
