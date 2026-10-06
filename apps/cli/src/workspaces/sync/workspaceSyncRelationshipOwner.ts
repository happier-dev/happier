import { randomUUID } from 'node:crypto';

import { accountSettingsParse, assertAccountWorkspaceSettingsTransition } from '@happier-dev/protocol/account/settings/accountSettings';
import { areWorkspaceSyncRelationshipDefinitionsEqual } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import type { AccountSettingsMutationResult, WorkspaceContentPolicyV1, WorkspaceRefV1, WorkspaceSyncPersistentModeV1, WorkspaceSyncRelationshipV1, WorkspaceSyncStatusV1, HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';

import { materializeWorkspaceRefForMachineRoot } from '@/settings/accountSettings/workspaceRefsV1';
import {
  updateAccountSettingsV2OnceAgainstLatest,
} from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import type { StoredCredentials } from '@/persistence';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import { validateWorkspaceSyncRelationship } from './workspaceSyncSettings';

export type WorkspaceSyncRelationshipSettingsMutation = (
  mutate: (settings: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>,
  signal?: AbortSignal,
) => Promise<AccountSettingsMutationResult>;

type SettingsDocument = Readonly<Record<string, unknown>>;

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
    signal?: AbortSignal;
  }>): Promise<MaterializedWorkspaceSyncEndpoints>;
  prepareCreate(input: PrepareWorkspaceSyncRelationshipInput): Promise<PreparedWorkspaceSyncRelationship>;
  setEnabled(relationshipId: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  stop(relationshipId: string, signal?: AbortSignal): Promise<void>;
}>;

export type WorkspaceSyncRelationshipOwnerOptions = Readonly<{
  localMachineId: string;
  mutateSettings: WorkspaceSyncRelationshipSettingsMutation;
  /** Reads the authoritative latest Account Settings document, not a stale UI/cache projection. */
  readSettings(): Promise<SettingsDocument>;
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
  waitForSettingsReconciliation(settingsVersion: number, signal?: AbortSignal): Promise<void>;
  createId?: () => string;
  deriveRelationshipId?: (operationId: string) => string;
  nowMs?: () => number;
}>;

function ownerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isSettledMutation(
  result: AccountSettingsMutationResult,
): result is Extract<AccountSettingsMutationResult, { status: 'applied' | 'satisfied' | 'unchanged' }> {
  return result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged';
}

function parseRefs(settings: SettingsDocument): readonly WorkspaceRefV1[] {
  try {
    return accountSettingsParse(settings).workspaceRefsV1;
  } catch (cause) {
    throw ownerError('workspace_sync_settings_invalid', cause instanceof Error ? cause.message : 'Workspace references are invalid');
  }
}

function parseRelationships(settings: SettingsDocument): readonly WorkspaceSyncRelationshipV1[] {
  try {
    return accountSettingsParse(settings).workspaceSyncRelationshipsV1;
  } catch (cause) {
    throw ownerError('workspace_sync_settings_invalid', cause instanceof Error ? cause.message : 'Workspace relationships are invalid');
  }
}

function admitWorkspaceSettingsTransition<T extends SettingsDocument>(
  previous: SettingsDocument,
  next: T,
): T {
  assertAccountWorkspaceSettingsTransition(previous, next);
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

function mutationFailure(result: AccountSettingsMutationResult): Error & { code: string } {
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

/** Production adapter to the one Account Settings compare-and-swap owner. */
export function createAccountSettingsWorkspaceSyncRelationshipMutation(
  credentials: StoredCredentials,
): WorkspaceSyncRelationshipSettingsMutation {
  return async (mutate, signal) => await updateAccountSettingsV2OnceAgainstLatest({
    credentials,
    mutate,
    signal,
  });
}

export function createWorkspaceSyncRelationshipOwner(
  options: WorkspaceSyncRelationshipOwnerOptions,
): WorkspaceSyncRelationshipOwner {
  const createId = options.createId ?? randomUUID;
  const deriveRelationshipId = options.deriveRelationshipId ?? defaultRelationshipId;
  const nowMs = options.nowMs ?? Date.now;

  const materializeEndpoints = async (input: Readonly<{
    serverId: string;
    sourceMachineId: string;
    sourceRootPath: string;
    targetMachineId: string;
    targetRootPath: string;
    signal?: AbortSignal;
  }>): Promise<MaterializedWorkspaceSyncEndpoints> => {
    let sourceRef!: WorkspaceRefV1;
    let targetRef!: WorkspaceRefV1;
    const result = await options.mutateSettings((settings) => {
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
        nowMs: nowMs(),
        createId,
      });
      sourceRef = first.workspaceRef;
      targetRef = second.workspaceRef;
      return admitWorkspaceSettingsTransition(settings, { ...settings, workspaceRefsV1: second.workspaceRefs });
    }, input.signal);
    if (!isSettledMutation(result)) throw mutationFailure(result);
    const current = await options.readSettings();
    await options.waitForSettingsReconciliation(result.version, input.signal);
    return {
      source: parseRefs(current).find((ref) => ref.id === sourceRef.id) ?? sourceRef,
      target: parseRefs(current).find((ref) => ref.id === targetRef.id) ?? targetRef,
    };
  };

  const mutateDesiredRelationships = async (
    relationshipId: string,
    mutate: (relationships: readonly WorkspaceSyncRelationshipV1[]) => readonly WorkspaceSyncRelationshipV1[],
    signal?: AbortSignal,
  ): Promise<number> => {
    const desiredRelationships: { value: readonly WorkspaceSyncRelationshipV1[] | null } = { value: null };
    const result = await options.mutateSettings((settings) => {
      desiredRelationships.value = mutate(parseRelationships(settings));
      return admitWorkspaceSettingsTransition(settings, {
        ...settings,
        workspaceSyncRelationshipsV1: desiredRelationships.value,
      });
    }, signal);
    if (!isSettledMutation(result)) {
      if (result.status === 'outcomeUnknown') {
        const current = parseRelationships(await options.readSettings());
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
    const result = await options.mutateSettings((settings) => {
      const relationships = parseRelationships(settings);
      const matches = relationships.filter((relationship) => relationship.relationshipId === relationshipId);
      if (matches.length !== 1) throw ownerError('relationship_not_ready', 'Workspace relationship is unavailable');
      const projected = project(matches[0]!);
      return admitWorkspaceSettingsTransition(settings, {
        ...settings,
        workspaceSyncRelationshipsV1: projected === null
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

    await options.waitForSettingsReconciliation(settingsVersion, signal);
  };

  return Object.freeze({
    materializeEndpoints,
    async prepareCreate(input): Promise<PreparedWorkspaceSyncRelationship> {
      input.signal?.throwIfAborted();
      if (input.sourceMachineId !== options.localMachineId) {
        throw ownerError('workspace_sync_controller_mismatch', 'Relationship creation must run on its source controller machine');
      }

      const endpoints = await materializeEndpoints(input);
      const current = await options.readSettings();
      const timestamp = nowMs();
      const candidate = validateWorkspaceSyncRelationship({
        v: 1,
        relationshipId: deriveRelationshipId(input.operationId),
        controllerMachineId: options.localMachineId,
        alphaWorkspaceRefId: endpoints.source.id,
        betaWorkspaceRefId: endpoints.target.id,
        mode: input.mode,
        contentPolicy: input.contentPolicy,
        enabled: true,
        createdAtMs: timestamp,
        updatedAtMs: timestamp,
      });
      const existing = resolveEndpointPair(parseRelationships(current), candidate);
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
          const result = await options.mutateSettings((settings) => {
            const relationships = parseRelationships(settings);
            const winner = resolveEndpointPair(relationships, relationship);
            const staged = validateWorkspaceSyncRelationship(winner
              ? { ...winner, enabled: false, updatedAtMs: nowMs() }
              : { ...relationship, enabled: false });
            stagedRelationship = staged;
            return admitWorkspaceSettingsTransition(settings, {
              ...settings,
              workspaceSyncRelationshipsV1: winner
                ? relationships.map((value) => value.relationshipId === winner.relationshipId ? staged : value)
                : [...relationships, staged],
            });
          }, input.signal);
          if (!isSettledMutation(result)) {
            const observed = resolveEndpointPair(parseRelationships(await options.readSettings()), relationship);
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
          await options.waitForSettingsReconciliation(stagedSettingsVersion, input.signal);
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
              const result = await options.mutateSettings((settings) => {
                const relationships = parseRelationships(settings);
                const winner = resolveEndpointPair(relationships, relationship);
                if (winner?.enabled) return settings;
                if (!winner) {
                  throw ownerError('relationship_not_ready', 'Workspace relationship staging intent is unavailable');
                }
                const committed = { ...winner, enabled: true, updatedAtMs: nowMs() };
                return admitWorkspaceSettingsTransition(settings, {
                  ...settings,
                  workspaceSyncRelationshipsV1: relationships.map((value) => (
                    value.relationshipId === winner.relationshipId ? committed : value
                  )),
                });
              }, input.signal);
              if (!isSettledMutation(result)) {
                outcomeUnknownThisAttempt = result.status === 'outcomeUnknown';
                const observed = resolveEndpointPair(parseRelationships(await options.readSettings()), relationship);
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
              await options.waitForSettingsReconciliation(publishedSettingsVersion, input.signal);
              reconciliationComplete = true;
            }
            const committedSettings = await options.readSettings();
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
            await options.waitForSettingsReconciliation(rollbackVersion);
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

    async stop(relationshipId, signal): Promise<void> {
      await transitionDesiredRelationship(relationshipId, () => null, signal);
    },
  });
}
