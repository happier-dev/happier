import { randomUUID } from 'node:crypto';

import { parseProjectAccountSnapshotV1, assertProjectAccountSnapshotTransition, type ProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { areWorkspaceSyncRelationshipDefinitionsEqual, areWorkspaceSyncWorkerCopyProvenancesEqual, getWorkspaceSyncWorkerCopyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { WorkspaceContentPolicyV1, WorkspaceRefV1, WorkspaceSyncPersistentModeV1, WorkspaceSyncRelationshipV1, WorkspaceSyncStatusV1, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { WorkspaceSyncCommittedCopyTargetV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';

import { materializeWorkspaceRefForMachineRoot, resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { createProjectAccountSnapshotMutation, type ProjectAccountSnapshotMutation, type ProjectAccountSnapshotMutationResult } from '@/workspaces/projectAccountRows';
import type { StoredCredentials } from '@/persistence';
import type { ProjectWorkerDependency } from '@/workspaces/execution/projectWorkerAdmission';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import { validateWorkspaceSyncRelationship } from './workspaceSyncSettings';

export type { ProjectAccountSnapshotMutation } from '@/workspaces/projectAccountRows';

export type PrepareWorkspaceSyncRelationshipInput = Readonly<{
  operationId: string;
  /** Host-derived Account Home scope; never accepted as a user-entered identity. */
  serverId: string;
  sourceMachineId: string;
  sourceRootPath: string;
  targetMachineId: string;
  targetRootPath: string;
  mode: WorkspaceSyncPersistentModeV1;
  contentPolicy: WorkspaceContentPolicyV1;
  targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
  purpose?: 'worker_clean_copy';
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  targetReplacementApprovalReceiptId?: string;
  targetReplacementApprovalActionInput?: unknown;
  flushBeforeCommit: true;
  signal?: AbortSignal;
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
}>;

export type WorkspaceSyncRelationshipOwner = Readonly<{
  materializeEndpoints(input: Readonly<{
    serverId: string;
    sourceMachineId: string;
    sourceRootPath: string;
    targetMachineId: string;
    targetRootPath: string;
    purpose?: 'worker_clean_copy';
    signal?: AbortSignal;
  }>): Promise<MaterializedWorkspaceSyncEndpoints>;
  prepareCreate(input: PrepareWorkspaceSyncRelationshipInput): Promise<PreparedWorkspaceSyncRelationship>;
  setEnabled(relationshipId: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  /** Settlement failures carry definitionRetired:true only after the graph mutation is confirmed. */
  stop(relationshipId: string, signal?: AbortSignal, retirement?: WorkspaceSyncRelationshipRetirement): Promise<void>;
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
    preparation?: Readonly<{
      transient: true;
      targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
      targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
      targetReplacementApprovalReceiptId?: string;
      targetReplacementApprovalActionInput?: unknown;
    }>,
  ): Promise<WorkspaceSyncStatusV1>;
  flushRelationship(relationshipId: string, signal?: AbortSignal): Promise<WorkspaceSyncStatusV1>;
  commitRelationshipTarget(relationship: WorkspaceSyncRelationshipV1): Promise<void>;
  terminateRelationshipRuntime(relationship: WorkspaceSyncRelationshipV1): Promise<void>;
  waitForProjectReconciliation(settingsVersion: number, signal?: AbortSignal): Promise<void>;
  readRelationshipDependencies?(relationship: WorkspaceSyncRelationshipV1, snapshot: ProjectAccountSnapshotV1): Promise<readonly ProjectWorkerDependency[]>;
  inspectCommittedRelationshipTarget?(relationship: WorkspaceSyncRelationshipV1, removal: NonNullable<WorkspaceSyncRelationshipRetirement['removeTargetCopy']>, signal?: AbortSignal, approval?: WorkspaceSyncCommittedCopyTargetV1): Promise<void>;
  removeCommittedRelationshipTarget?(relationship: WorkspaceSyncRelationshipV1, removal: NonNullable<WorkspaceSyncRelationshipRetirement['removeTargetCopy']>, signal?: AbortSignal, approval?: WorkspaceSyncCommittedCopyTargetV1): Promise<void>;
  createId?: () => string;
  deriveRelationshipId?: (operationId: string) => string;
  nowMs?: () => number;
}>;

function ownerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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

function mutationFailure(result: ProjectAccountSnapshotMutationResult): Error & { code: string } {
  if (result.status === 'conflict') return ownerError('workspace_sync_settings_conflict', 'Account Settings changed concurrently');
  if (result.status === 'cancelled') return ownerError('cancelled', 'Workspace relationship mutation was cancelled');
  if (result.status === 'outcomeUnknown') return ownerError('indeterminate', 'Workspace relationship settings outcome is unknown');
  return ownerError('workspace_sync_settings_unavailable', `Workspace relationship settings mutation failed: ${result.status}`);
}

function isIndeterminate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'indeterminate';
}

/**
 * Test-only determinism seam. Production must keep the canonical rule, because
 * the target daemon re-derives it to authorize destructive replacement; a test
 * that overrides it cannot carry a target replacement approval.
 */
const defaultRelationshipId = deriveWorkspaceSyncRelationshipId;

/** Production adapter to the graph/ref row transaction, beneath this semantic owner. */
export function createProjectAccountRowsWorkspaceSyncRelationshipMutation(
  credentials: StoredCredentials,
): ProjectAccountSnapshotMutation {
  return createProjectAccountSnapshotMutation(credentials);
}

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

  const materializeEndpoints = async (input: Readonly<{
    serverId: string;
    sourceMachineId: string;
    sourceRootPath: string;
    targetMachineId: string;
    targetRootPath: string;
    purpose?: 'worker_clean_copy';
    signal?: AbortSignal;
  }>): Promise<MaterializedWorkspaceSyncEndpoints> => {
    let sourceRef!: WorkspaceRefV1;
    let targetRef!: WorkspaceRefV1;
    const result = await mutateProjectSnapshot((settings) => {
      const first = materializeWorkspaceRefForMachineRoot(parseRefs(settings), {
        serverId: input.serverId,
        machineId: input.sourceMachineId,
        rootPath: input.sourceRootPath,
        nowMs: nowMs(),
        createId,
      });
      const second = materializeWorkspaceRefForMachineRoot(first.workspaceRefs, {
        serverId: input.serverId,
        machineId: input.targetMachineId,
        rootPath: input.targetRootPath,
        ...(input.purpose === 'worker_clean_copy' ? { parentWorkspace: {
          serverId: first.workspaceRef.serverId, workspaceId: first.workspaceRef.id,
          machineId: first.workspaceRef.machineId, rootPath: first.workspaceRef.rootPath,
        } } : {}),
        nowMs: nowMs(),
        createId,
      });
      sourceRef = first.workspaceRef;
      targetRef = second.workspaceRef;
      return admitProjectSnapshotTransition(settings, { ...settings, workspaceRefs: second.workspaceRefs });
    }, input.signal);
    if (!isSettledMutation(result)) throw mutationFailure(result);
    const current = await options.readProjectSnapshot();
    await options.waitForProjectReconciliation(result.version, input.signal);
    const currentRefs = parseRefs(current);
    const source = resolveWorkspaceRefById(currentRefs, sourceRef.id, input.serverId);
    const target = resolveWorkspaceRefById(currentRefs, targetRef.id, input.serverId);
    if (!source || !target) throw ownerError('workspace_ref_not_ready', 'Materialized workspace endpoints are unavailable');
    return { source, target };
  };

  const mutateDesiredRelationships = async (
    relationshipId: string,
    mutate: (relationships: readonly WorkspaceSyncRelationshipV1[]) => readonly WorkspaceSyncRelationshipV1[],
    signal?: AbortSignal,
  ): Promise<number> => {
    const desiredRelationships: { value: readonly WorkspaceSyncRelationshipV1[] | null } = { value: null };
    const result = await mutateProjectSnapshot((settings) => {
      desiredRelationships.value = mutate(parseRelationships(settings));
      return admitProjectSnapshotTransition(settings, {
        ...settings,
        relationships: desiredRelationships.value,
      });
    }, signal);
    if (!isSettledMutation(result)) {
      if (result.status === 'outcomeUnknown') {
        const current = parseRelationships(await options.readProjectSnapshot());
        const present = current.find((relationship) => relationship.relationshipId === relationshipId);
        const expectedPresent = desiredRelationships.value?.find((relationship) => relationship.relationshipId === relationshipId);
        if ((present?.enabled ?? null) === (expectedPresent?.enabled ?? null)) return result.lastKnownVersion;
      }
      throw mutationFailure(result);
    }
    return result.version;
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

    await options.waitForProjectReconciliation(settingsVersion, signal);
  };

  return Object.freeze({
    materializeEndpoints,
    async prepareCreate(input): Promise<PreparedWorkspaceSyncRelationship> {
      input.signal?.throwIfAborted();
      if (input.sourceMachineId !== options.localMachineId) {
        throw ownerError('workspace_sync_controller_mismatch', 'Relationship creation must run on its source controller machine');
      }

      const endpoints = await materializeEndpoints(input);
      const current = await options.readProjectSnapshot();
      const timestamp = nowMs();
      const candidate = validateWorkspaceSyncRelationship({
        v: 1,
        relationshipId: deriveRelationshipId(input.operationId),
        controllerMachineId: options.localMachineId,
        alphaWorkspaceRefId: endpoints.source.id,
        betaWorkspaceRefId: endpoints.target.id,
        ...(input.purpose === 'worker_clean_copy' ? { provenance: {
          kind: 'worker_clean_copy', sourceWorkspaceRefId: endpoints.source.id, targetWorkspaceRefId: endpoints.target.id,
        } } : {}),
        mode: input.mode,
        contentPolicy: input.contentPolicy,
        enabled: true,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
      const existing = resolveEndpointPair(parseRelationships(current), candidate);
      if (input.purpose === 'worker_clean_copy'
        && (endpoints.target.projectKey ?? endpoints.target.id) !== (endpoints.source.projectKey ?? endpoints.source.id)) {
        throw ownerError('project_workspace_changed', 'The chosen worker folder belongs to a different Project');
      }
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

      const stageDurableIntent = async (): Promise<void> => {
        if (!durableIntentStaged) {
          let stagedRelationship: WorkspaceSyncRelationshipV1 | null = null;
          const result = await mutateProjectSnapshot((settings) => {
            const relationships = parseRelationships(settings);
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
            const observed = resolveEndpointPair(parseRelationships(await options.readProjectSnapshot()), relationship);
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
        if (!stagedReconciliationComplete && stagedSettingsVersion !== null) {
          await options.waitForProjectReconciliation(stagedSettingsVersion, input.signal);
          stagedReconciliationComplete = true;
        }
      };

      await stageDurableIntent();
      let status: WorkspaceSyncStatusV1;
      try {
        status = await options.ensureRelationship(
          runtimeRelationship,
          input.signal,
          existing?.enabled === true
            ? undefined
            : {
                transient: true,
                targetBootstrap: input.targetBootstrap,
                ...(input.targetReplacementApproval
                  ? { targetReplacementApproval: input.targetReplacementApproval }
                  : {}),
                ...(input.targetReplacementApprovalReceiptId ? {
                  targetReplacementApprovalReceiptId: input.targetReplacementApprovalReceiptId,
                  targetReplacementApprovalActionInput: input.targetReplacementApprovalActionInput,
                } : {}),
              },
        );
        status = await options.flushRelationship(relationship.relationshipId, input.signal);
      } catch (error) {
        if (runtimeOwnedByTransaction && !isIndeterminate(error)) await options.terminateRelationshipRuntime(relationship);
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
              await options.commitRelationshipTarget(runtimeRelationship);
              targetCommitted = true;
            }
            if (!published) {
              const result = await mutateProjectSnapshot((settings) => {
                const relationships = parseRelationships(settings);
                const winner = resolveEndpointPair(relationships, relationship);
                if (winner?.enabled) return settings;
                if (!winner) {
                  throw ownerError('relationship_not_ready', 'Workspace relationship staging intent is unavailable');
                }
                const committed = { ...winner, enabled: true, updatedAtMs: nowMs() };
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
              await options.terminateRelationshipRuntime(runtimeRelationship);
              closed = true;
            }
            throw failure;
          }
        },
        async abort(): Promise<void> {
          if (closed) return;
          if (durableIntentStaged && runtimeOwnedByTransaction && publishedRelationship.relationshipId === relationship.relationshipId) {
            const rollbackVersion = await mutateDesiredRelationships(relationship.relationshipId, (relationships) => {
              const current = relationships.find((value) => value.relationshipId === relationship.relationshipId);
              if (!current) return relationships;
              if (existing) {
                return relationships.map((value) => value.relationshipId === relationship.relationshipId ? existing : value);
              }
              return relationships.filter((value) => value.relationshipId !== relationship.relationshipId);
            });
            await options.waitForProjectReconciliation(rollbackVersion);
          }
          if (runtimeOwnedByTransaction) await options.terminateRelationshipRuntime(runtimeRelationship);
          closed = true;
        },
      });
    },

    async setEnabled(relationshipId, enabled, signal): Promise<void> {
      await transitionDesiredRelationship(
        relationshipId,
        (relationship) => ({ ...relationship, enabled, updatedAtMs: nowMs() }),
        signal,
      );
    },

    async stop(relationshipId, signal, retirement): Promise<void> {
      let terminated!: WorkspaceSyncRelationshipV1;
      const result = await mutateProjectSnapshot(async (settings) => {
        const relationships = parseRelationships(settings);
        const matches = relationships.filter((relationship) => relationship.relationshipId === relationshipId);
        if (matches.length !== 1) throw ownerError('relationship_not_ready', 'Workspace relationship is unavailable');
        terminated = matches[0]!;
        if (retirement) {
          const workerCopy = getWorkspaceSyncWorkerCopyV1(terminated);
          if (!workerCopy) throw ownerError('workspace_copy_not_worker', 'Workspace relationship has no worker-copy creation provenance');
          if (retirement.removeTargetCopy && retirement.removeTargetCopy.workspaceRefId !== workerCopy.targetWorkspaceRefId) {
            throw ownerError('workspace_unavailable', 'Workspace removal is not the worker-copy target');
          }
        }
        if (retirement && (terminated.relationshipId !== retirement.expectedRelationship.relationshipId
          || !areWorkspaceSyncRelationshipDefinitionsEqual(terminated, retirement.expectedRelationship)
          || !areWorkspaceSyncWorkerCopyProvenancesEqual(terminated, retirement.expectedRelationship)
          || terminated.enabled !== retirement.expectedRelationship.enabled
          || terminated.createdAtMs !== retirement.expectedRelationship.createdAtMs
          || terminated.updatedAtMs !== retirement.expectedRelationship.updatedAtMs)) {
          throw ownerError('relationship_definition_conflict', 'Workspace relationship changed since review');
        }
        if (retirement && !options.readRelationshipDependencies) {
          throw ownerError('workspace_sync_dependencies_unavailable', 'Workspace relationship dependencies are unavailable');
        }
        const dependencies = await options.readRelationshipDependencies?.(terminated, settings) ?? [];
        if (dependencies.length > 0) {
          throw Object.assign(ownerError('workspace_sync_relationship_in_use', 'Workspace relationship has dependent work'), { dependencies });
        }
        if (retirement?.removeTargetCopy) {
          if (!options.inspectCommittedRelationshipTarget || !options.removeCommittedRelationshipTarget) {
            throw ownerError('workspace_copy_removal_unavailable', 'Committed copy removal is unavailable');
          }
          const approved = retirement.approval?.actionInput;
          if (!approved) throw ownerError('approval_required', 'Committed copy removal has no Action receipt');
          if (approved.expectedRelationship.relationshipId !== terminated.relationshipId
            || !areWorkspaceSyncRelationshipDefinitionsEqual(approved.expectedRelationship, terminated)
            || !areWorkspaceSyncWorkerCopyProvenancesEqual(approved.expectedRelationship, terminated)
            || approved.expectedRelationship.enabled !== terminated.enabled
            || approved.expectedRelationship.createdAtMs !== terminated.createdAtMs
            || approved.expectedRelationship.updatedAtMs !== terminated.updatedAtMs
            || approved.removeTargetCopy?.workspaceRefId !== retirement.removeTargetCopy.workspaceRefId
            || approved.removeTargetCopy?.rootFingerprint !== retirement.removeTargetCopy.rootFingerprint) {
            throw ownerError('approval_stale', 'Committed copy removal differs from the reviewed Action');
          }
          await options.inspectCommittedRelationshipTarget(terminated, retirement.removeTargetCopy, signal, retirement.approval);
        }
        return admitProjectSnapshotTransition(settings, { ...settings,
          relationships: relationships.filter((relationship) => relationship.relationshipId !== relationshipId),
        });
      }, signal);
      if (!isSettledMutation(result)) throw mutationFailure(result);
      try {
        await options.waitForProjectReconciliation(result.version, signal);
        if (retirement?.removeTargetCopy) {
          await options.removeCommittedRelationshipTarget!(terminated, retirement.removeTargetCopy, signal, retirement.approval);
        }
      } catch (error) {
        const failure = typeof error === 'object' && error !== null
          ? error
          : new Error('Workspace relationship retirement settlement failed', { cause: error });
        throw Object.assign(failure, { definitionRetired: true });
      }
    },
  });
}
