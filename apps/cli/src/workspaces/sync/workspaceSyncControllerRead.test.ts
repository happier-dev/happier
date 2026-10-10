import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile, chmod, rm, rename, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { deriveWorkspaceSyncConflictAsidePaths } from '@happier-dev/protocol';
import { computeWorkspaceSyncPolicyDigest } from './workspaceSyncTypes';
import { WorkspaceSyncController } from './workspaceSyncController';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';

const LINUX_ONLY = process.platform !== 'linux';

const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const withPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
const definitionAB = {
  v: 1 as const, relationshipId: 'rel-ab', controllerMachineId: 'machine-a',
  alphaWorkspaceRefId: 'workspace-a', betaWorkspaceRefId: 'workspace-b',
  mode: 'keep_both_in_sync' as const, contentPolicy: withPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
};
const definitionAC = {
  ...definitionAB, relationshipId: 'rel-ac', betaWorkspaceRefId: 'workspace-c', createdAtMs: 2, updatedAtMs: 2,
};
const statusAB = {
  relationshipId: 'rel-ab', controllerMachineId: 'machine-a', state: 'watching' as const,
  alphaPath: '/repo/a', betaPath: '/repo/b', mode: 'keep_both_in_sync' as const,
  endpointStates: {
    alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
  },
  conflictCount: 1, lastCycleObservedAtMs: 11,
};
const statusAC = { ...statusAB, relationshipId: 'rel-ac', betaPath: '/repo/c', conflictCount: 0 };

function completeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    discoverCopyOnceRecoveries: vi.fn(async () => []),
    rehydrate: vi.fn(async () => [statusAB]),
    ensure: vi.fn(async () => statusAB),
    copyOnce: vi.fn(async () => statusAB),
    get: vi.fn(async () => statusAB),
    list: vi.fn(async () => [statusAB, statusAC]),
    flush: vi.fn(async () => statusAB),
    pause: vi.fn(async () => statusAB),
    resume: vi.fn(async () => statusAB),
    terminate: vi.fn(async () => undefined),
    listConflicts: vi.fn(async () => ({ status: 'page' as const, relationshipId: 'rel-ab', totalCount: 0, nextCursor: null, conflicts: [] })),
    diagnoseSelection: vi.fn(async () => ({ status: 'unknown' as const, reason: 'selection_unavailable' as const })),
    ...overrides,
  };
}

function lifecycle() {
  return { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
}

function stubRootOwnership() {
  return {
    tryAcquire: vi.fn(async (owner) => ({
      owner: { ...owner, rootFingerprint: null },
      assertCurrentRootIdentity: async () => undefined,
      bindCurrentRootIdentity: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    })),
  };
}

function sha1File(bytes: string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

describe('WorkspaceSyncController read inspection', () => {
  it('lists local definitions with current statuses and one derived set', async () => {
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: stubRootOwnership(),
      localMachineId: 'machine-a',
      resolveWorkspaceRef: (id) => ({ machineId: id === 'workspace-a' ? 'machine-a' : 'machine-x', rootPath: `/${id}` }),
    });
    await controller.ensure(definitionAB);
    await controller.ensure(definitionAC);

    const result = await controller.listRelationships({});
    expect(result.controllerMachineId).toBe('machine-a');
    expect(result.relationships.map((entry) => entry.definition.relationshipId).sort()).toEqual(['rel-ab', 'rel-ac']);
    expect(result.relationships.find((entry) => entry.definition.relationshipId === 'rel-ab')?.status).toMatchObject({
      conflictCount: 1,
    });
    expect(result.sets).toHaveLength(1);
    expect(result.sets[0]).toMatchObject({ hubWorkspaceRefId: 'workspace-a', controllerMachineId: 'machine-a' });
    expect([...(result.sets[0]?.relationshipIds ?? [])].sort()).toEqual(['rel-ab', 'rel-ac']);
    expect(result.membership).toEqual({ workspaceRefId: null, found: null });
    expect(result.discoveryAvailable).toBe(false);
    expect(result.remoteRelationships).toEqual([]);
    await controller.shutdown();
  });

  it('narrows the derived set by member and reports an absent member as not found', async () => {
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: stubRootOwnership(),
      localMachineId: 'machine-a',
      resolveWorkspaceRef: (id) => ({ machineId: id === 'workspace-a' ? 'machine-a' : 'machine-x', rootPath: `/${id}` }),
    });
    await controller.ensure(definitionAB);
    await controller.ensure(definitionAC);

    // A member filter selects its complete derived set: the clean spoke and
    // the other link arrive together, never as isolated rows.
    const filtered = await controller.listRelationships({ workspaceRefId: 'workspace-c' });
    expect(filtered.relationships.map((entry) => entry.definition.relationshipId).sort()).toEqual(['rel-ab', 'rel-ac']);
    expect(filtered.sets).toHaveLength(1);
    expect(filtered.sets[0]).toMatchObject({ hubWorkspaceRefId: 'workspace-a' });
    expect(filtered.membership).toEqual({ workspaceRefId: 'workspace-c', found: true });

    // Missing is explicit: no relationships and found false, never an empty clean bill.
    const absent = await controller.listRelationships({ workspaceRefId: 'workspace-unknown' });
    expect(absent.relationships).toEqual([]);
    expect(absent.sets).toEqual([]);
    expect(absent.membership).toEqual({ workspaceRefId: 'workspace-unknown', found: false });
    await controller.shutdown();
  });

  it('discovers same-Account relationships owned by another controller without fabricating status', async () => {
    const remote = {
      ...definitionAB, relationshipId: 'rel-de', controllerMachineId: 'machine-x',
      alphaWorkspaceRefId: 'workspace-d', betaWorkspaceRefId: 'workspace-e',
    };
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: stubRootOwnership(),
      localMachineId: 'machine-a',
      resolveWorkspaceRef: (id) => ({ machineId: id === 'workspace-a' ? 'machine-a' : 'machine-x', rootPath: `/${id}` }),
      resolveAllRelationshipDefinitions: () => [definitionAB, definitionAC, remote],
    });
    await controller.ensure(definitionAB);
    await controller.ensure(definitionAC);

    const result = await controller.listRelationships({ workspaceRefId: 'workspace-d' });
    expect(result.relationships).toEqual([]);
    expect(result.remoteRelationships).toHaveLength(1);
    expect(result.remoteRelationships[0]).toMatchObject({ controllerMachineId: 'machine-x' });
    expect(result.remoteRelationships[0]?.definition.relationshipId).toBe('rel-de');
    expect(result.discoveryAvailable).toBe(true);
    expect(result.membership).toEqual({ workspaceRefId: 'workspace-d', found: true });
    await controller.shutdown();
  });

  it('rejects inspection for a workspace outside current membership without touching endpoints', async () => {
    const observeEntryAtTarget = vi.fn(async () => ({ kind: 'missing' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: stubRootOwnership(),
      localMachineId: 'machine-a', observeEntryAtTarget,
      resolveWorkspaceRef: (id) => ({ machineId: 'machine-a', rootPath: `/${id}` }),
    });
    await controller.ensure(definitionAB);
    await expect(controller.inspectConflict({ workspaceRefId: 'workspace-unknown', path: 'src/index.ts' }))
      .rejects.toMatchObject({ code: 'relationship_not_ready' });
    expect(observeEntryAtTarget).not.toHaveBeenCalled();
    await controller.shutdown();
  });

  it('retains local evidence and marks a remote endpoint unreachable when observation transport is absent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-no-transport-'));
    const rootA = join(fixture, 'a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a',
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definitionAB);
      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-a', path: 'src/index.ts' });
      expect(result.coverage).toEqual({ complete: false });
      expect(result.endpoints.find((entry) => entry.workspaceRefId === 'workspace-a')).toMatchObject({
        outcome: 'observed', observation: { kind: 'missing' },
      });
      expect(result.endpoints.find((entry) => entry.workspaceRefId === 'workspace-b')).toEqual({
        workspaceRefId: 'workspace-b', outcome: 'unreachable',
        selections: [{ relationshipId: 'rel-ab', side: 'beta', decision: { status: 'unknown', reason: 'endpoint_unavailable' } }],
      });
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('cancels in-flight inspection through the request signal without producing stale results', async () => {
    const observeEntryAtTarget = vi.fn(async () => ({ kind: 'missing' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: stubRootOwnership(),
      localMachineId: 'machine-a', observeEntryAtTarget,
      resolveWorkspaceRef: (id) => ({ machineId: id === 'workspace-a' ? 'machine-a' : 'machine-b', rootPath: `/${id}` }),
    });
    await controller.ensure(definitionAB);
    const abort = new AbortController();
    abort.abort();
    await expect(controller.inspectConflict(
      { workspaceRefId: 'workspace-a', path: 'src/index.ts' },
      abort.signal,
    )).rejects.toMatchObject({ code: 'cancelled' });
    expect(observeEntryAtTarget).not.toHaveBeenCalled();
    await controller.shutdown();
  });
});

describe('WorkspaceSyncController selected-path inspection', () => {
  it.skipIf(LINUX_ONLY)('offers a deterministic alternate aside without touching an occupied name and labels excluded preservation local', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-aside-'));
    const rootA = join(fixture, 'a');
    await mkdir(rootA);
    await writeFile(join(rootA, 'value.txt'), 'hub');
    const betaFile = { kind: 'file' as const, digest: sha1File('beta'), executable: false, size: 4 };
    const [primary, alternate] = deriveWorkspaceSyncConflictAsidePaths('value.txt', betaFile);
    await writeFile(join(rootA, primary), 'occupied');
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        diagnoseSelection: vi.fn(async ({ path }: Readonly<{ path: string }>) =>
          path === 'value.txt' ? { status: 'included' as const }
            : { status: 'excluded' as const, reason: 'git_ignore' as const }),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a',
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
      observeEntryAtTarget: async ({ path }) => path === 'value.txt' ? betaFile : { kind: 'missing' as const },
    });
    try {
      await controller.ensure(definitionAB);
      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-a', path: 'value.txt' });
      expect(result.preservationOptions).toContainEqual({
        status: 'name_conflict', source: { workspaceRefId: 'workspace-b', expected: betaFile },
        proposed: { workspaceRefId: 'workspace-a', path: primary },
      });
      expect(result.preservationOptions).toContainEqual({
        status: 'available', source: { workspaceRefId: 'workspace-b', expected: betaFile },
        destination: { workspaceRefId: 'workspace-a', path: alternate, expected: { kind: 'missing' } },
        consequence: { propagatingToWorkspaceRefIds: [] },
      });
      await expect(readFile(join(rootA, primary), 'utf8')).resolves.toBe('occupied');
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(LINUX_ONLY)('observes every set endpoint from a clean spoke, including another link conflict', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-'));
    const rootA = join(fixture, 'a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    await writeFile(join(rootA, 'src', 'index.ts'), 'alpha bytes');
    const observeEntryAtTarget = vi.fn(async (input: Readonly<{ targetWorkspaceRefId: string }>) => {
      if (input.targetWorkspaceRefId === 'workspace-b') {
        return { kind: 'file' as const, digest: sha1File('beta bytes'), executable: false, size: 10 };
      }
      return { kind: 'file' as const, digest: sha1File('gamma bytes'), executable: false, size: 11 };
    });
    const diagnoseSelection = vi.fn(async (request: Readonly<{ relationshipId: string; side: 'alpha' | 'beta'; path: string }>) =>
      request.relationshipId === 'rel-ac' ? { status: 'excluded' as const, reason: 'git_ignore' as const }
        : { status: 'included' as const });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ diagnoseSelection }), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a', observeEntryAtTarget,
      resolveWorkspaceRef: (id) => {
        if (id === 'workspace-a') return { machineId: 'machine-a', rootPath: rootA };
        if (id === 'workspace-b') return { machineId: 'machine-b', rootPath: '/remote/b' };
        return { machineId: 'machine-c', rootPath: '/remote/c' };
      },
    });
    try {
      await controller.ensure(definitionAB);
      await controller.ensure(definitionAC);

      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-c', path: 'src/index.ts' });
      expect(result.controllerMachineId).toBe('machine-a');
      expect(result.hubWorkspaceRefId).toBe('workspace-a');
      expect(result.path).toBe('src/index.ts');
      expect(result.coverage).toEqual({ complete: true });
      expect(result.endpoints.map((endpoint) => endpoint.workspaceRefId).sort()).toEqual([
        'workspace-a', 'workspace-b', 'workspace-c',
      ]);
      for (const endpoint of result.endpoints) expect(endpoint.outcome).toBe('observed');
      // Three distinct available versions stay distinct.
      expect(result.versions).toHaveLength(3);
      const betaAside = deriveWorkspaceSyncConflictAsidePaths('src/index.ts', {
        kind: 'file', digest: sha1File('beta bytes'), executable: false, size: 10,
      })[0];
      expect(result.preservationOptions).toContainEqual({
        status: 'available',
        source: { workspaceRefId: 'workspace-b', expected: { kind: 'file', digest: sha1File('beta bytes'), executable: false, size: 10 } },
        destination: { workspaceRefId: 'workspace-a', path: betaAside, expected: { kind: 'missing' } },
        consequence: { propagatingToWorkspaceRefIds: ['workspace-b'] },
      });
      // Metadata by default: no bounded preview is concatenated.
      for (const version of result.versions) expect(version.preview).toBeUndefined();
      // The shared hub has a distinct engine answer for each relationship.
      const endpointA = result.endpoints.find((endpoint) => endpoint.workspaceRefId === 'workspace-a');
      expect(endpointA?.selections).toEqual([
        { relationshipId: 'rel-ab', side: 'alpha', decision: { status: 'included' } },
        { relationshipId: 'rel-ac', side: 'alpha', decision: { status: 'excluded', reason: 'git_ignore' } },
      ]);
      expect(result.endpoints.find((endpoint) => endpoint.workspaceRefId === 'workspace-b')?.selections).toEqual([
        { relationshipId: 'rel-ab', side: 'beta', decision: { status: 'included' } },
      ]);
      expect(diagnoseSelection).toHaveBeenCalledWith({ relationshipId: 'rel-ac', side: 'beta', path: 'src/index.ts' }, undefined);
      // One content observation per ref: the shared hub is observed once.
      expect(observeEntryAtTarget).toHaveBeenCalledTimes(2);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(LINUX_ONLY)('keeps executable-bit differences as separate versions', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-exec-'));
    const rootA = join(fixture, 'a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    await writeFile(join(rootA, 'src', 'run.sh'), 'same bytes');
    await chmod(join(rootA, 'src', 'run.sh'), 0o755);
    const observeEntryAtTarget = vi.fn(async () => (
      { kind: 'file' as const, digest: sha1File('same bytes'), executable: false, size: 10 }
    ));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a', observeEntryAtTarget,
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definitionAB);
      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-a', path: 'src/run.sh' });
      expect(result.coverage).toEqual({ complete: true });
      // Same bytes with different executable semantics are not the same version.
      expect(result.versions).toHaveLength(2);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(LINUX_ONLY)('retains reachable versions when one endpoint is offline', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-offline-'));
    const rootA = join(fixture, 'a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    await writeFile(join(rootA, 'src', 'index.ts'), 'alpha bytes');
    const observeEntryAtTarget = vi.fn(async () => {
      throw Object.assign(new Error('peer is offline'), { code: 'peer_unavailable' });
    });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a', observeEntryAtTarget,
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definitionAB);
      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-a', path: 'src/index.ts' });
      expect(result.coverage).toEqual({ complete: false });
      expect(result.endpoints.find((endpoint) => endpoint.workspaceRefId === 'workspace-a')?.outcome).toBe('observed');
      const remote = result.endpoints.find((endpoint) => endpoint.workspaceRefId === 'workspace-b');
      expect(remote?.outcome).toBe('unreachable');
      expect(remote?.observation).toBeUndefined();
      expect(remote?.selections).toEqual([
        { relationshipId: 'rel-ab', side: 'beta', decision: { status: 'unknown', reason: 'endpoint_unavailable' } },
      ]);
      // The reachable version survives; the offline endpoint is coverage, not a version.
      expect(result.versions).toHaveLength(1);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(LINUX_ONLY)('fetches exactly one bounded preview for the reviewed expectation', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-preview-'));
    const rootA = join(fixture, 'a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    await writeFile(join(rootA, 'src', 'index.ts'), 'alpha bytes');
    const betaObservation = { kind: 'file' as const, digest: sha1File('beta bytes'), executable: false, size: 10 };
    const observeEntryAtTarget = vi.fn(async () => betaObservation);
    const readFileAtTarget = vi.fn(async () => (
      { status: 'text' as const, text: 'beta bytes', digest: betaObservation.digest, size: 10 }
    ));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a', observeEntryAtTarget, readFileAtTarget,
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definitionAB);
      const result = await controller.inspectConflict({
        workspaceRefId: 'workspace-a',
        path: 'src/index.ts',
        preview: { workspaceRefId: 'workspace-b', expected: betaObservation },
      });
      const withPreview = result.versions.filter((version) => version.preview !== undefined);
      expect(withPreview).toHaveLength(1);
      expect(withPreview[0]).toMatchObject({
        endpointWorkspaceRefIds: ['workspace-b'],
        preview: { workspaceRefId: 'workspace-b', preview: { status: 'text', text: 'beta bytes' } },
      });
      expect(readFileAtTarget).toHaveBeenCalledTimes(1);

      // A drifted source is a typed change, never a stale preview.
      await expect(controller.inspectConflict({
        workspaceRefId: 'workspace-a',
        path: 'src/index.ts',
        preview: { workspaceRefId: 'workspace-b', expected: { kind: 'missing' as const } },
      })).rejects.toMatchObject({ code: 'conflict_changed' });
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.skipIf(LINUX_ONLY)('discloses no bytes when the fenced root is replaced before observation', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-root-'));
    const rootA = join(fixture, 'a');
    const retainedRoot = join(fixture, 'retained-a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    await writeFile(join(rootA, 'src', 'index.ts'), 'alpha bytes');
    const observeEntryAtTarget = vi.fn(async () => ({ kind: 'missing' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a', observeEntryAtTarget,
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definitionAB);
      await rename(rootA, retainedRoot);
      await mkdir(join(rootA, 'src'), { recursive: true });
      await writeFile(join(rootA, 'src', 'index.ts'), 'replacement bytes');

      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-a', path: 'src/index.ts' });
      const local = result.endpoints.find((endpoint) => endpoint.workspaceRefId === 'workspace-a');
      expect(local?.outcome).toBe('unreachable');
      expect(local?.observation).toBeUndefined();
      expect(result.coverage).toEqual({ complete: false });
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('projects endpoint failures independently without converting unknown errors', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-inspect-outcomes-'));
    const rootA = join(fixture, 'a');
    await mkdir(join(rootA, 'src'), { recursive: true });
    const cases = [
      ['changed', Object.assign(new Error('changed'), { code: 'conflict_changed' })],
      ['unreachable', Object.assign(new Error('gone'), { code: 'target_unavailable' })],
      ['unsupported', Object.assign(new Error('kind'), { code: 'workspace_file_unsupported' })],
      ['revoked', Object.assign(new Error('denied'), { code: 'approval_required' })],
    ] as const;
    for (const [outcome, error] of cases) {
      const observeEntryAtTarget = vi.fn(async (): Promise<never> => { throw error; });
      const controller = new WorkspaceSyncController({
        adapter: completeAdapter(), lifecycle: lifecycle(),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
        localMachineId: 'machine-a', observeEntryAtTarget,
        resolveWorkspaceRef: (id) => id === 'workspace-a'
          ? { machineId: 'machine-a', rootPath: rootA }
          : { machineId: 'machine-b', rootPath: '/remote/b' },
      });
      await controller.ensure(definitionAB);
      const result = await controller.inspectConflict({ workspaceRefId: 'workspace-b', path: 'src/index.ts' });
      expect(result.coverage).toEqual({ complete: false });
      expect(result.endpoints.find((endpoint) => endpoint.workspaceRefId === 'workspace-b')?.outcome).toBe(outcome);
      await controller.shutdown();
    }
    const unknown = Object.assign(new Error('strange'), { code: 'strange_code' });
    const failing = vi.fn(async (): Promise<never> => { throw unknown; });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'machine-a', observeEntryAtTarget: failing,
      resolveWorkspaceRef: (id) => id === 'workspace-a'
        ? { machineId: 'machine-a', rootPath: rootA }
        : { machineId: 'machine-b', rootPath: '/remote/b' },
    });
    await controller.ensure(definitionAB);
    await expect(controller.inspectConflict({ workspaceRefId: 'workspace-b', path: 'src/index.ts' })).rejects.toBe(unknown);
    await controller.shutdown();
    await rm(fixture, { recursive: true, force: true });
  });
});
