import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from './workspaceSyncTargetAuthority';
import { computeWorkspaceSyncRootFingerprint } from './workspaceSyncTargetBootstrap';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';

import {
  computeWorkspaceSyncPolicyDigest,
  type WorkspaceSyncStatusV1,
} from '@happier-dev/protocol';
import type { ProjectAccountSnapshotMutationResult } from '@/workspaces/projectAccountRows';

import {
  createWorkspaceSyncRelationshipOwner,
  type ProjectAccountSnapshotMutation,
  type WorkspaceSyncRelationshipOwnerOptions,
} from './workspaceSyncRelationshipOwner';

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

function status(id: string): WorkspaceSyncStatusV1 {
  return {
    relationshipId: id,
    controllerMachineId: 'machine_source',
    state: 'watching',
    alphaPath: '/source',
    betaPath: '/target',
    mode: 'keep_synced',
    endpointStates: {
      alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    },
    conflictCount: 0,
    lastCycleObservedAtMs: 1,
  };
}

function createHarness(
  retirement: Pick<WorkspaceSyncRelationshipOwnerOptions, 'inspectCommittedRelationshipTarget' | 'removeCommittedRelationshipTarget'> = {},
  initialSnapshot: Readonly<Record<string, unknown>> = { workspaceRefs: [], relationships: [] },
) {
  let settings: Readonly<Record<string, unknown>> = initialSnapshot;
  let beforeNextMutation: ((current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>) | undefined;
  let returnOutcomeUnknownAfterApplying = false;
  let returnOutcomeUnknownWithoutApplying = false;
  let failNextRead = false;
  const mutateProjectSnapshot: ProjectAccountSnapshotMutation = vi.fn(async (mutate) => {
    if (returnOutcomeUnknownWithoutApplying) {
      returnOutcomeUnknownWithoutApplying = false;
      return { status: 'outcomeUnknown', lastKnownVersion: 1 } satisfies ProjectAccountSnapshotMutationResult;
    }
    if (beforeNextMutation) {
      settings = beforeNextMutation(settings);
      beforeNextMutation = undefined;
    }
    settings = await mutate(settings as never);
    if (returnOutcomeUnknownAfterApplying) {
      returnOutcomeUnknownAfterApplying = false;
      return { status: 'outcomeUnknown', lastKnownVersion: 1 } satisfies ProjectAccountSnapshotMutationResult;
    }
    return { status: 'applied', version: 1, snapshot: settings as never } satisfies ProjectAccountSnapshotMutationResult;
  });
  const ensureRelationship = vi.fn(async (definition) => status(definition.relationshipId));
  const flushRelationship = vi.fn(async (id: string) => status(id));
  const terminateRelationshipRuntime = vi.fn(async () => undefined);
  const commitRelationshipTarget = vi.fn(async () => undefined);
  const waitForProjectReconciliation = vi.fn(async (_settingsVersion: number, _signal?: AbortSignal) => undefined);
  const admission = createProjectWorkerAdmission({ machineId: 'machine_target', admissionDrain: createDaemonAdmissionDrain(),
    readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }),
  });
  const owner = createWorkspaceSyncRelationshipOwner({
    localMachineId: 'machine_source',
    mutateProjectSnapshot,
    readProjectSnapshot: async () => {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('settings read unavailable');
      }
      return settings;
    },
    ensureRelationship,
    flushRelationship,
    terminateRelationshipRuntime,
    commitRelationshipTarget,
    waitForProjectReconciliation,
    readRelationshipDependencies: async (relationship) => admission.dependencies().filter((dependency) => (
      dependency.relationshipId === relationship.relationshipId
      || dependency.workspaceRefId === relationship.alphaWorkspaceRefId || dependency.workspaceRefId === relationship.betaWorkspaceRefId
    )),
    createId: (() => {
      const values = ['source_ref', 'target_ref'];
      return () => values.shift() ?? 'unexpected_id';
    })(),
    deriveRelationshipId: (operationId) => operationId === 'handoff_1' ? 'relationship_1' : `relationship_${operationId}`,
    nowMs: () => 100,
    ...retirement,
  });
  return {
    owner,
    read: () => settings,
    mutateProjectSnapshot,
    ensureRelationship,
    flushRelationship,
    terminateRelationshipRuntime,
    commitRelationshipTarget,
    waitForProjectReconciliation,
    admission,
    applyNextMutationWithUnknownOutcome: () => { returnOutcomeUnknownAfterApplying = true; },
    loseNextMutationOutcomeWithoutApplying: () => { returnOutcomeUnknownWithoutApplying = true; },
    failNextSettingsRead: () => { failNextRead = true; },
    beforeNextSettingsMutation: (mutate: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>) => {
      beforeNextMutation = mutate;
    },
  };
}

const createInput = {
  operationId: 'handoff_1',
  serverId: 'server_a',
  sourceMachineId: 'machine_source',
  sourceRootPath: '/source',
  targetMachineId: 'machine_target',
  targetRootPath: '/target',
  mode: 'keep_synced' as const,
  contentPolicy: policy,
  targetBootstrap: 'use_existing' as const,
  flushBeforeCommit: true as const,
};

/** Home persistence boundary fixture: an already-created worker copy, not ordinary prepareCreate conversion. */
function workerCopySnapshot(sourceRootPath = '/source', targetRootPath = '/target', enabled = true) {
  return parseProjectAccountSnapshotV1({
    workspaceRefs: [
      { id: 'source_ref', serverId: 'server_a', machineId: 'machine_source', rootPath: sourceRootPath, createdAtMs: 100 },
      { id: 'target_ref', serverId: 'server_a', machineId: 'machine_target', rootPath: targetRootPath, createdAtMs: 100 },
    ],
    relationships: [{ v: 1, relationshipId: 'relationship_1', controllerMachineId: 'machine_source',
      alphaWorkspaceRefId: 'source_ref', betaWorkspaceRefId: 'target_ref', mode: 'keep_synced', contentPolicy: policy,
      enabled, createdAtMs: 100, updatedAtMs: 100,
      provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: 'source_ref', targetWorkspaceRefId: 'target_ref' } }],
  });
}

describe('WorkspaceSyncRelationshipOwner', () => {
  it('keeps ordinary Sync termination but refuses worker retirement of the same unproven relationship', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    const expectedRelationship = await prepared.commit();
    const retained = harness.read();
    await expect(harness.owner.stop(expectedRelationship.relationshipId, undefined, { expectedRelationship }))
      .rejects.toMatchObject({ code: 'workspace_copy_not_worker' });
    expect(harness.read()).toEqual(retained);
    await harness.owner.stop(expectedRelationship.relationshipId);
    expect(parseProjectAccountSnapshotV1(harness.read()).relationships).toEqual([]);
  });

  it.each(['preserve', 'remove', 'replaced_before_stop', 'replaced_after_stop'] as const)('uses canonical stop with real target custody: %s', async (scenario) => {
    const removeBytes = scenario !== 'preserve';
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-relationship-retirement-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    const materializationDirectory = join(fixture, 'materialization');
    await mkdir(source);
    await mkdir(materializationDirectory);
    const harness = createHarness({
      inspectCommittedRelationshipTarget: async (_expectedRelationship, _removal, _signal, approval) => {
        if (!approval) throw new Error('Missing host receipt carrier');
        await authority.inspectCommittedCopyHere(approval);
      },
      removeCommittedRelationshipTarget: async (_expectedRelationship, _removal, _signal, approval) => {
        if (!approval) throw new Error('Missing host receipt carrier');
        await authority.removeCommittedCopyHere(approval);
      },
    }, workerCopySnapshot(source, target, false));
    const authority = createWorkspaceSyncTargetAuthority({
      localMachineId: 'machine_target', localServerId: 'server_a',
      getProjectSnapshot: () => ({ ...parseProjectAccountSnapshotV1(harness.read()), source: 'network',
        organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'scope' }),
      callMachineRpc: async () => { throw new Error('unexpected transport'); },
      assertCommittedCopyRemovalAuthorized: async (receiptId) => {
        // The Artifact persistence/authorization boundary admits only this reviewed fixture receipt.
        if (receiptId !== 'approved-retirement') throw Object.assign(new Error('Not approved'), { code: 'approval_required' });
      },
      readCommittedCopyDependencies: async (input) => harness.admission.dependencies({ workspaceRefId: input.removeTargetCopy?.workspaceRefId }),
      bootstrap: { materializationDirectory, rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }) },
    });
    try {
      const stagedRelationship = parseProjectAccountSnapshotV1(harness.read()).relationships[0]!;
      const prepared = await authority.prepareBootstrapHere({
        v: 1, bootstrapOperationId: 'relationship_1', owner: { kind: 'relationship', relationshipId: 'relationship_1' },
        transientRelationship: { ...stagedRelationship, enabled: true }, targetWorkspaceRefId: 'target_ref', endpointRole: 'beta',
        policyDigest: policy.policyDigest, createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace',
      });
      await writeFile(join(target, 'copy.txt'), 'committed copy');
      await harness.owner.setEnabled('relationship_1', true);
      await authority.releaseBootstrapHere({ v: 1, bootstrapOperationId: prepared.bootstrapOperationId,
        targetWorkspaceRefId: 'target_ref', reason: 'relationship_committed' });
      const expectedRelationship = parseProjectAccountSnapshotV1(harness.read()).relationships[0]!;
      const removeTargetCopy = { workspaceRefId: 'target_ref', rootFingerprint: await computeWorkspaceSyncRootFingerprint(target) };
      if (removeBytes) {
        const preflightFailure = await harness.owner.stop('relationship_1', undefined, { expectedRelationship, removeTargetCopy,
          approval: { actionReceiptId: 'approved-retirement', actionInput: {
            workspace: { serverId: 'server_a', refId: 'source_ref' }, machineId: 'machine_source', expectedRelationship,
            removeTargetCopy: { ...removeTargetCopy, workspaceRefId: 'source_ref' },
          } },
        }).catch((error: unknown) => error);
        expect(preflightFailure).toMatchObject({ code: 'approval_stale' });
        expect(preflightFailure).not.toHaveProperty('definitionRetired');
        expect(harness.read().relationships).toHaveLength(1);
        await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('committed copy');
      }
      const replaceRoot = async () => {
        await rename(target, join(fixture, 'retained-copy'));
        await mkdir(target);
        await writeFile(join(target, 'user.txt'), 'replacement user root');
      };
      if (scenario === 'replaced_before_stop') await replaceRoot();
      if (scenario === 'replaced_after_stop') {
        // Replace the physical object at the OS boundary after the graph write,
        // while the canonical owner waits for runtime reconciliation.
        harness.waitForProjectReconciliation.mockImplementationOnce(replaceRoot);
      }
      const stopped = harness.owner.stop('relationship_1', undefined, { expectedRelationship,
        ...(removeBytes ? { removeTargetCopy, approval: { actionReceiptId: 'approved-retirement', actionInput: {
          workspace: { serverId: 'server_a', refId: 'source_ref' }, machineId: 'machine_source', expectedRelationship, removeTargetCopy,
        } } } : {}),
      });
      if (scenario === 'replaced_before_stop' || scenario === 'replaced_after_stop') {
        const failure = await stopped.catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
        if (scenario === 'replaced_after_stop') {
          expect(failure).toHaveProperty('definitionRetired', true);
          expect(harness.read().relationships).toEqual([]);
        } else {
          expect(failure).not.toHaveProperty('definitionRetired');
          expect(harness.read().relationships).toHaveLength(1);
        }
        await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('replacement user root');
        await expect(readFile(join(fixture, 'retained-copy', 'copy.txt'), 'utf8')).resolves.toBe('committed copy');
        return;
      }
      await stopped;
      expect(harness.read().relationships).toEqual([]);
      if (removeBytes) await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      else await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('committed copy');
    } finally {
      await authority.releaseAllRetainedBootstraps();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('refuses retirement and ordinary termination with the actual queued or reserved dependencies', async () => {
    const harness = createHarness({}, workerCopySnapshot());
    const expectedRelationship = parseProjectAccountSnapshotV1(harness.read()).relationships[0]!;
    let finishWork!: () => void;
    const processBoundary = new Promise<void>((resolve) => { finishWork = resolve; });
    let reserved!: () => void;
    const reservation = new Promise<void>((resolve) => { reserved = resolve; });
    const running = harness.admission.execute({ operationId: 'copying', workspaceRefId: 'target_ref', relationshipId: 'relationship_1',
      signal: new AbortController().signal, accept: () => {}, onReserved: reserved,
      run: async () => { await processBoundary; return { kind: 'no_launch', result: { ok: true, result: null } }; },
    });
    await reservation;
    let accepted!: () => void;
    const queued = new Promise<void>((resolve) => { accepted = resolve; });
    const cancellation = new AbortController();
    const waiting = harness.admission.execute({ operationId: 'waiting', workspaceRefId: 'target_ref', relationshipId: 'relationship_1',
      signal: cancellation.signal, accept: accepted,
      run: async () => ({ kind: 'no_launch', result: { ok: true, result: null } }),
    });
    try {
      await queued;
      const dependencies = harness.admission.dependencies();
      expect(dependencies.map((dependency) => dependency.state)).toEqual(['reserved', 'queued']);
      await expect(harness.owner.stop('relationship_1')).rejects.toMatchObject({ code: 'workspace_sync_relationship_in_use', dependencies });
      await expect(harness.owner.stop('relationship_1', undefined, { expectedRelationship }))
        .rejects.toMatchObject({ code: 'workspace_sync_relationship_in_use', dependencies });
      expect(harness.read().relationships).toEqual([expect.objectContaining({ relationshipId: 'relationship_1' })]);
    } finally {
      cancellation.abort();
      finishWork();
      await Promise.all([running, waiting]);
    }
  });

  it('checks the reviewed definition against the latest mutation census before retirement', async () => {
    const harness = createHarness({}, workerCopySnapshot());
    const expectedRelationship = parseProjectAccountSnapshotV1(harness.read()).relationships[0]!;
    await harness.owner.setEnabled('relationship_1', false);
    await expect(harness.owner.stop('relationship_1', undefined, { expectedRelationship }))
      .rejects.toMatchObject({ code: 'relationship_definition_conflict' });
    expect(harness.read().relationships).toEqual([expect.objectContaining({ enabled: false })]);
  });

  it('returns the materialized endpoints from the authenticated Home when ids recur in another Home', async () => {
    const harness = createHarness();
    harness.beforeNextSettingsMutation((current) => ({
      ...current,
      workspaceRefs: [
        { id: 'source_ref', serverId: 'server_b', machineId: 'machine_source', rootPath: '/other-source', createdAtMs: 1 },
        { id: 'target_ref', serverId: 'server_b', machineId: 'machine_target', rootPath: '/other-target', createdAtMs: 1 },
        { id: 'source_ref', serverId: 'server_a', machineId: 'machine_source', rootPath: '/source', createdAtMs: 1 },
        { id: 'target_ref', serverId: 'server_a', machineId: 'machine_target', rootPath: '/target', createdAtMs: 1 },
      ],
    }));
    await expect(harness.owner.materializeEndpoints(createInput)).resolves.toMatchObject({
      source: { id: 'source_ref', serverId: 'server_a', rootPath: '/source' },
      target: { id: 'target_ref', serverId: 'server_a', rootPath: '/target' },
    });
  });

  it('persists and reconciles disabled intent before target preparation, then enables only after READY commit', async () => {
    const harness = createHarness();
    let relationshipAtEnsure: unknown;
    let reconciliationsAtEnsure = 0;
    harness.ensureRelationship.mockImplementationOnce(async (definition) => {
      relationshipAtEnsure = (harness.read().relationships as readonly unknown[])[0];
      reconciliationsAtEnsure = harness.waitForProjectReconciliation.mock.calls.length;
      return status(definition.relationshipId);
    });
    const prepared = await harness.owner.prepareCreate(createInput);

    expect(harness.ensureRelationship).toHaveBeenCalledOnce();
    expect(harness.ensureRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: true }),
      undefined,
      expect.objectContaining({ transient: true }),
    );
    expect(harness.flushRelationship).toHaveBeenCalledWith('relationship_1', undefined);
    expect(relationshipAtEnsure).toEqual(expect.objectContaining({
      relationshipId: 'relationship_1',
      enabled: false,
    }));
    expect(reconciliationsAtEnsure).toBeGreaterThanOrEqual(2);
    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
    ]);

    await prepared.commit();
    expect(harness.read().relationships).toEqual([
      expect.objectContaining({
        relationshipId: 'relationship_1',
        alphaWorkspaceRefId: 'source_ref',
        betaWorkspaceRefId: 'target_ref',
        enabled: true,
      }),
    ]);
    expect(harness.commitRelationshipTarget).toHaveBeenCalledWith(expect.objectContaining({ relationshipId: 'relationship_1' }));
  });

  it('keeps the durable relationship disabled until target READY commit succeeds', async () => {
    const harness = createHarness();
    const crashAtTargetCommit = new Error('injected process loss before target READY');
    let relationshipAtTargetCommit: unknown;
    harness.commitRelationshipTarget.mockImplementationOnce(async () => {
      relationshipAtTargetCommit = (harness.read().relationships as readonly unknown[])[0];
      throw crashAtTargetCommit;
    });
    const prepared = await harness.owner.prepareCreate(createInput);

    await expect(prepared.commit()).rejects.toBe(crashAtTargetCommit);
    expect(relationshipAtTargetCommit).toEqual(expect.objectContaining({
      relationshipId: 'relationship_1',
      enabled: false,
    }));
    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
    ]);
  });

  it('reuses only the exact Action-derived relationship and requires replacement for an occupied endpoint pair', async () => {
    const harness = createHarness();
    const first = await harness.owner.prepareCreate(createInput);
    await first.commit();
    const exact = await harness.owner.prepareCreate(createInput);
    expect(exact.relationship.relationshipId).toBe('relationship_1');
    expect(exact.reused).toBe(true);

    await expect(harness.owner.prepareCreate({ ...createInput, operationId: 'handoff_2' }))
      .rejects.toMatchObject({ code: 'relationship_replacement_required' });
    await expect(harness.owner.prepareCreate({ ...createInput, mode: 'mirror_exactly' }))
      .rejects.toMatchObject({ code: 'relationship_definition_conflict' });
    await expect(harness.owner.prepareCreate({ ...createInput, mode: 'mirror_exactly', operationId: 'handoff_3' }))
      .rejects.toMatchObject({ code: 'relationship_replacement_required' });
  });

  it('re-admits the same relationship against a fresh row census after a proven CAS conflict', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    const mutation = harness.mutateProjectSnapshot as ReturnType<typeof vi.fn>;
    mutation.mockResolvedValueOnce({ status: 'conflict', currentVersion: 2 });

    await expect(prepared.commit()).resolves.toMatchObject({ relationshipId: 'relationship_1', enabled: true });
    expect(harness.terminateRelationshipRuntime).not.toHaveBeenCalled();
    expect(harness.read().relationships).toEqual([expect.objectContaining({ relationshipId: 'relationship_1', enabled: true })]);
  });

  it('preserves the stable relationship transaction across an unknown settings outcome and retries idempotently', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    harness.loseNextMutationOutcomeWithoutApplying();
    harness.failNextSettingsRead();

    await expect(prepared.commit()).rejects.toMatchObject({ code: 'indeterminate' });
    expect(harness.terminateRelationshipRuntime).not.toHaveBeenCalled();
    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
    ]);

    await expect(prepared.commit()).resolves.toMatchObject({ relationshipId: 'relationship_1' });
    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1' }),
    ]);
  });

  it('compensates the durable relationship and engine when the enclosing target commit fails', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();

    await prepared.abort();

    expect(harness.read().relationships).toEqual([]);
    expect(harness.terminateRelationshipRuntime).toHaveBeenCalledWith(expect.objectContaining({ relationshipId: 'relationship_1' }));
  });

  it('restores a reused disabled relationship when target commit fails after temporary publication', async () => {
    const harness = createHarness();
    const first = await harness.owner.prepareCreate(createInput);
    await first.commit();
    await harness.owner.setEnabled('relationship_1', false);
    harness.terminateRelationshipRuntime.mockClear();

    const retried = await harness.owner.prepareCreate(createInput);
    await retried.commit();
    await retried.abort();

    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
    ]);
    expect(harness.terminateRelationshipRuntime).toHaveBeenCalledOnce();
  });

  it('uses settings as the sole durable pause/resume/stop lifecycle writer', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    harness.waitForProjectReconciliation.mockClear();

    await harness.owner.setEnabled('relationship_1', false);
    await harness.owner.setEnabled('relationship_1', true);
    await harness.owner.stop('relationship_1');

    expect(harness.terminateRelationshipRuntime).not.toHaveBeenCalled();
    expect(harness.waitForProjectReconciliation).toHaveBeenCalledTimes(3);
    expect(harness.waitForProjectReconciliation.mock.calls.map(([settingsVersion]) => settingsVersion))
      .toEqual([1, 1, 1]);
    expect(harness.read().relationships).toEqual([]);
  });

  it('validates enable admission against the latest CAS snapshot without rejecting an unrelated valid component', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    await harness.owner.setEnabled('relationship_1', false);
    const unrelatedPolicy = policy;
    harness.beforeNextSettingsMutation((current) => ({
      ...current,
      workspaceRefs: [
        ...(current.workspaceRefs as readonly unknown[]),
        { id: 'other_source', serverId: 'server_a', machineId: 'machine_source', rootPath: '/other-source', createdAtMs: 1 },
        { id: 'other_target', serverId: 'server_a', machineId: 'machine_other', rootPath: '/other-target', createdAtMs: 1 },
      ],
      relationships: [
        ...(current.relationships as readonly unknown[]),
        {
          v: 1,
          relationshipId: 'unrelated',
          controllerMachineId: 'machine_source',
          alphaWorkspaceRefId: 'other_source',
          betaWorkspaceRefId: 'other_target',
          mode: 'keep_synced',
          contentPolicy: unrelatedPolicy,
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    }));

    await expect(harness.owner.setEnabled('relationship_1', true)).resolves.toBeUndefined();
    expect(harness.read().relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: true }),
      expect.objectContaining({ relationshipId: 'unrelated', enabled: true }),
    ]));
  });

  it('rejects enable admission when the latest CAS snapshot added an invalid relationship in the same component', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    await harness.owner.setEnabled('relationship_1', false);
    harness.waitForProjectReconciliation.mockClear();
    harness.beforeNextSettingsMutation((current) => ({
      ...current,
      relationships: [
        ...(current.relationships as readonly unknown[]),
        {
          v: 1,
          relationshipId: 'concurrent-invalid',
          controllerMachineId: 'machine_source',
          alphaWorkspaceRefId: 'source_ref',
          betaWorkspaceRefId: 'target_ref',
          mode: 'keep_synced',
          contentPolicy: policy,
          enabled: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ],
    }));

    await expect(harness.owner.setEnabled('relationship_1', true))
      .rejects.toMatchObject({ code: 'workspace_sync_topology_invalid' });
    expect(harness.waitForProjectReconciliation).not.toHaveBeenCalled();
    expect(harness.read().relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
      expect.objectContaining({ relationshipId: 'concurrent-invalid', enabled: false }),
    ]));
  });

  it('keeps a settled pause intent when runtime reconciliation fails', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    harness.waitForProjectReconciliation.mockClear();
    harness.waitForProjectReconciliation
      .mockRejectedValueOnce(Object.assign(new Error('engine rejected pause'), { code: 'engine_unavailable' }));

    await expect(harness.owner.setEnabled('relationship_1', false))
      .rejects.toMatchObject({ code: 'engine_unavailable', message: 'engine rejected pause' });

    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
    ]);
    expect(harness.waitForProjectReconciliation).toHaveBeenCalledTimes(1);
  });

  it('keeps a settled stop intent when runtime reconciliation fails', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    harness.waitForProjectReconciliation.mockClear();
    const reconciliationFailure = Object.assign(new Error('engine rejected termination'), { code: 'engine_unavailable' });
    harness.waitForProjectReconciliation
      .mockRejectedValueOnce(reconciliationFailure);

    const failure = await harness.owner.stop('relationship_1').catch((error: unknown) => error);
    expect(failure).toBe(reconciliationFailure);
    expect(failure).toMatchObject({ code: 'engine_unavailable', message: 'engine rejected termination', definitionRetired: true });

    expect(harness.read().relationships).toEqual([]);
    expect(harness.waitForProjectReconciliation).toHaveBeenCalledTimes(1);
  });

  it('leaves indeterminate durable intent in place without unsafe compensation', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    harness.waitForProjectReconciliation.mockClear();
    harness.waitForProjectReconciliation.mockRejectedValueOnce(
      Object.assign(new Error('pause dispatch outcome unknown'), { code: 'indeterminate' }),
    );

    await expect(harness.owner.setEnabled('relationship_1', false))
      .rejects.toMatchObject({ code: 'indeterminate' });

    expect(harness.read().relationships).toEqual([
      expect.objectContaining({ relationshipId: 'relationship_1', enabled: false }),
    ]);
    expect(harness.waitForProjectReconciliation).toHaveBeenCalledTimes(1);
  });

  it('reports an outcome-unknown settings write as indeterminate without claiming engine reconciliation', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    harness.waitForProjectReconciliation.mockClear();
    harness.applyNextMutationWithUnknownOutcome();

    const failure = await harness.owner.stop('relationship_1').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'indeterminate' });
    expect(failure).not.toHaveProperty('definitionRetired');
    expect(harness.read().relationships).toEqual([]);
    expect(harness.waitForProjectReconciliation).not.toHaveBeenCalled();
  });

  it('compensates a determinate engine failure but preserves an indeterminate operation for same-id settlement', async () => {
    const determinate = createHarness();
    determinate.ensureRelationship.mockRejectedValueOnce(Object.assign(new Error('rejected'), { code: 'target_unavailable' }));
    await expect(determinate.owner.prepareCreate(createInput)).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(determinate.terminateRelationshipRuntime).toHaveBeenCalledWith(expect.objectContaining({ relationshipId: 'relationship_1' }));

    const indeterminate = createHarness();
    indeterminate.ensureRelationship.mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'indeterminate' }));
    await expect(indeterminate.owner.prepareCreate(createInput)).rejects.toMatchObject({ code: 'indeterminate' });
    expect(indeterminate.terminateRelationshipRuntime).not.toHaveBeenCalled();

    const retry = await indeterminate.owner.prepareCreate(createInput);
    expect(retry.relationship.relationshipId).toBe('relationship_1');
  });

  it('rejects malformed relationship settings without rewriting them as an empty desired set', async () => {
    const harness = createHarness();
    const prepared = await harness.owner.prepareCreate(createInput);
    await prepared.commit();
    const current = harness.read() as { relationships: unknown };
    current.relationships = [{ malformed: true }];
    harness.waitForProjectReconciliation.mockClear();

    await expect(harness.owner.setEnabled('relationship_1', false))
      .rejects.toMatchObject({ code: 'workspace_sync_settings_invalid' });
    expect(current.relationships).toEqual([{ malformed: true }]);
    expect(harness.waitForProjectReconciliation).not.toHaveBeenCalled();
  });

  it('cleans up a disabled relationship that this transaction temporarily starts and then aborts', async () => {
    const harness = createHarness();
    const first = await harness.owner.prepareCreate(createInput);
    await first.commit();
    await harness.owner.setEnabled('relationship_1', false);
    harness.terminateRelationshipRuntime.mockClear();

    const retry = await harness.owner.prepareCreate(createInput);
    expect(retry.reused).toBe(true);
    await retry.abort();

    expect(harness.terminateRelationshipRuntime).toHaveBeenCalledWith(expect.objectContaining({ relationshipId: 'relationship_1' }));
  });
});
