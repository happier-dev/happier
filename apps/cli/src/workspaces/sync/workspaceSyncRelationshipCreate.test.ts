import { describe, expect, it, vi } from 'vitest';

import {
  computeWorkspaceSyncPolicyDigest,
  type WorkspaceSyncPersistentModeV1,
  type WorkspaceSyncRelationshipV1,
  type WorkspaceSyncStatusV1,
} from '@happier-dev/protocol';

import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import type { ProjectAccountSnapshotMutationResult } from '@/workspaces/projectAccountRows';
import { createWorkspaceSyncRelationshipOwner, type ProjectAccountSnapshotMutation } from './workspaceSyncRelationshipOwner';
import { createWorkspaceSyncRelationshipForProject } from './workspaceSyncRelationshipCreate';

const policy = Object.freeze({
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: Object.freeze([]),
  extraIncludePatterns: Object.freeze([]),
  policyDigest: computeWorkspaceSyncPolicyDigest({
    v: 1,
    selection: 'all_files',
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
  }),
});

function status(
  relationshipId: string,
  overrides: Partial<WorkspaceSyncStatusV1> = {},
): WorkspaceSyncStatusV1 {
  return {
    relationshipId,
    controllerMachineId: 'machine_source',
    state: 'watching',
    alphaPath: '/source',
    betaPath: '/target',
    mode: 'keep_both_in_sync',
    endpointStates: {
      alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    },
    conflictCount: 0,
    lastCycleObservedAtMs: 1,
    ...overrides,
  };
}

type EnsurePreparation = Readonly<{
  transient: true;
  targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
}>;

function createHarness(options: Readonly<{
  /** Engine facts the first completed cycle reports for the new link. */
  preparedStatus?: (relationshipId: string) => WorkspaceSyncStatusV1;
  existingRelationships?: readonly WorkspaceSyncRelationshipV1[];
}> = {}) {
  let snapshot = parseProjectAccountSnapshotV1({
    workspaceRefs: [
      { id: 'source_ref', serverId: 'server_a', machineId: 'machine_source', rootPath: '/source', createdAtMs: 1 },
      { id: 'target_ref', serverId: 'server_a', machineId: 'machine_target', rootPath: '/target', createdAtMs: 1 },
    ],
    relationships: options.existingRelationships ?? [],
  });
  const mutateProjectSnapshot: ProjectAccountSnapshotMutation = vi.fn(async mutate => {
    snapshot = await mutate(snapshot);
    return { status: 'applied', version: 1, snapshot } satisfies ProjectAccountSnapshotMutationResult;
  });
  const ensurePreparations: (EnsurePreparation | undefined)[] = [];
  const ensureRelationship = vi.fn(async (
    definition: WorkspaceSyncRelationshipV1,
    _signal?: AbortSignal,
    preparation?: EnsurePreparation,
  ) => {
    ensurePreparations.push(preparation);
    return status(definition.relationshipId);
  });
  const flushRelationship = vi.fn(async (relationshipId: string) => (
    options.preparedStatus?.(relationshipId) ?? status(relationshipId)
  ));
  const terminateRelationshipRuntime = vi.fn(async () => undefined);
  const commitRelationshipTarget = vi.fn(async () => undefined);
  const owner = createWorkspaceSyncRelationshipOwner({
    localMachineId: 'machine_source',
    mutateProjectSnapshot,
    readProjectSnapshot: async () => snapshot,
    ensureRelationship,
    flushRelationship,
    terminateRelationshipRuntime,
    commitRelationshipTarget,
    waitForProjectReconciliation: async () => undefined,
    createId: (() => {
      const values = ['unexpected_source', 'unexpected_target'];
      return () => values.shift() ?? 'unexpected_id';
    })(),
    deriveRelationshipId: (operationId) => `relationship_${operationId}`,
    nowMs: () => 100,
  });
  return {
    dependencies: {
      localServerId: 'server_a',
      localMachineId: 'machine_source',
      resolveWorkspaceRef: (workspaceRefId: string) => {
        return snapshot.workspaceRefs.find(ref => ref.id === workspaceRefId) ?? null;
      },
      relationshipOwner: owner,
    },
    ensurePreparations,
    ensureRelationship,
    terminateRelationshipRuntime,
    commitRelationshipTarget,
    readRelationships: () => snapshot.relationships,
  };
}

function request(overrides: Readonly<{
  mode?: WorkspaceSyncPersistentModeV1;
  destinationIntent?: 'use_existing' | 'materialize_from_source_workspace';
  operationId?: string;
  sourceWorkspaceRefId?: string;
}> = {}) {
  return {
    v: 1 as const,
    operationId: overrides.operationId ?? 'link_1',
    actionInput: {
      v: 1 as const,
      sourceWorkspaceRefId: overrides.sourceWorkspaceRefId ?? 'source_ref',
      targetMachineId: 'machine_target',
      targetPath: '/target',
      mode: overrides.mode ?? ('keep_both_in_sync' as const),
      contentPolicy: policy,
      destinationIntent: overrides.destinationIntent ?? ('use_existing' as const),
    },
  };
}

describe('createWorkspaceSyncRelationshipForProject', () => {
  it('attaches a divergent existing checkout without reseeding it, commits one definition, and reports the conflict', async () => {
    // The whole point of "Use existing folder": both machines already hold work
    // and the person keeps both. Reseeding here would destroy the target's.
    const harness = createHarness({
      preparedStatus: (relationshipId) => status(relationshipId, { state: 'conflicted', conflictCount: 3 }),
    });

    const result = await createWorkspaceSyncRelationshipForProject(
      harness.dependencies,
      request({ destinationIntent: 'use_existing' }),
    );

    expect(harness.ensurePreparations).toEqual([
      expect.objectContaining({ transient: true, targetBootstrap: 'use_existing' }),
    ]);
    expect(harness.readRelationships()).toEqual([
      expect.objectContaining({
        relationshipId: 'relationship_link_1',
        alphaWorkspaceRefId: 'source_ref',
        betaWorkspaceRefId: 'target_ref',
        mode: 'keep_both_in_sync',
        enabled: true,
      }),
    ]);
    expect(harness.commitRelationshipTarget).toHaveBeenCalledOnce();
    expect(harness.terminateRelationshipRuntime).not.toHaveBeenCalled();
    // Initial conflicts are a successful link that needs attention, so the
    // caller receives the committed relationship and the real engine facts.
    expect(result).toEqual(expect.objectContaining({
      v: 1,
      relationshipId: 'relationship_link_1',
      created: true,
      controllerMachineId: 'machine_source',
      sourceWorkspaceRefId: 'source_ref',
      targetWorkspaceRefId: 'target_ref',
    }));
    expect(result.status).toEqual(expect.objectContaining({ state: 'conflicted', conflictCount: 3 }));
  });

  it('carries an explicit source-materialization intent to the bootstrap owner', async () => {
    const harness = createHarness();

    await createWorkspaceSyncRelationshipForProject(
      harness.dependencies,
      request({ destinationIntent: 'materialize_from_source_workspace' }),
    );

    expect(harness.ensurePreparations).toEqual([
      expect.objectContaining({ targetBootstrap: 'materialize_from_source_workspace' }),
    ]);
  });

  it('does not alias a new operation identity to an existing endpoint pair', async () => {
    const existing: WorkspaceSyncRelationshipV1 = {
      v: 1,
      relationshipId: 'relationship_existing',
      controllerMachineId: 'machine_source',
      alphaWorkspaceRefId: 'source_ref',
      betaWorkspaceRefId: 'target_ref',
      mode: 'keep_both_in_sync',
      contentPolicy: policy,
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    const harness = createHarness({ existingRelationships: [existing] });

    await expect(createWorkspaceSyncRelationshipForProject(
      harness.dependencies,
      request({ operationId: 'link_2' }),
    )).rejects.toMatchObject({ code: 'relationship_replacement_required' });

    expect(harness.readRelationships()).toHaveLength(1);
    expect(harness.ensureRelationship).not.toHaveBeenCalled();
  });

  it('retries the same admitted operation without creating a second relationship', async () => {
    const harness = createHarness();
    const first = await createWorkspaceSyncRelationshipForProject(harness.dependencies, request());
    const retry = await createWorkspaceSyncRelationshipForProject(harness.dependencies, request());

    expect(first.created).toBe(true);
    expect(retry).toMatchObject({ relationshipId: first.relationshipId, created: false });
    expect(harness.readRelationships()).toHaveLength(1);
  });

  it('refuses a selection whose workspace is hosted by another machine before touching files', async () => {
    const harness = createHarness();

    await expect(createWorkspaceSyncRelationshipForProject(
      harness.dependencies,
      request({ sourceWorkspaceRefId: 'target_ref' }),
    )).rejects.toMatchObject({ code: 'workspace_sync_controller_mismatch' });
    expect(harness.ensureRelationship).not.toHaveBeenCalled();
    expect(harness.readRelationships()).toEqual([]);
  });

  it('refuses a selection that is not present in current settings', async () => {
    const harness = createHarness();

    await expect(createWorkspaceSyncRelationshipForProject(
      harness.dependencies,
      request({ sourceWorkspaceRefId: 'removed_ref' }),
    )).rejects.toMatchObject({ code: 'workspace_ref_not_ready' });
    expect(harness.ensureRelationship).not.toHaveBeenCalled();
  });

  it('cancels after preparation without publishing a relationship or a duplicate attempt', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    harness.ensureRelationship.mockImplementationOnce(async (definition) => {
      controller.abort();
      return status(definition.relationshipId);
    });

    await expect(createWorkspaceSyncRelationshipForProject(
      harness.dependencies,
      request({ operationId: 'link_3' }),
      controller.signal,
    )).rejects.toThrow();

    // Staged disabled intent is rolled back and the transient runtime is
    // terminated exactly once; nothing durable advertises a half-made link.
    expect(harness.readRelationships()).toEqual([]);
    expect(harness.terminateRelationshipRuntime).toHaveBeenCalledOnce();
    expect(harness.commitRelationshipTarget).not.toHaveBeenCalled();
  });
});
