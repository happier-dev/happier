import { describe, expect, it, vi } from 'vitest';
import { WorkspaceSyncController } from './workspaceSyncController';
import { deriveWorkspaceSyncConflictAsidePaths } from '@happier-dev/protocol';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRelationshipV1, type WorkspaceSyncStatusV1 } from './workspaceSyncTypes';
import { deriveWorkspaceSyncEndpointId } from './transport/workspaceSyncBrokerProtocol';
import { access, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { createWorkspaceSyncMutagenAdapter } from './workspaceSyncMutagenAdapter';
import { createWorkspaceSyncTargetAuthority } from './workspaceSyncTargetAuthority';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';

const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const definition = { v: 1 as const, relationshipId: 'r1', controllerMachineId: 'm1', alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b', mode: 'keep_synced' as const, contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
const gitWorktreePolicy = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
const gitWorktreeDefinition = { ...definition, contentPolicy: { ...gitWorktreePolicy, policyDigest: computeWorkspaceSyncPolicyDigest(gitWorktreePolicy) } };
const status: WorkspaceSyncStatusV1 = {
  relationshipId: 'r1', controllerMachineId: 'm1', state: 'watching', alphaPath: '/a', betaPath: '/b', mode: 'keep_synced',
  endpointStates: {
    alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
    beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
  },
  conflictCount: 0, lastCycleObservedAtMs: null,
};

function ownedLocalAgent(stream = new PassThrough(), stop = vi.fn(async () => undefined)) {
  return { stream, stop };
}

function fixtureWorkspaceRef(id: string) {
  return {
    machineId: id === 'b' || /^b\d+$/u.test(id) || id.endsWith('-b') ? 'm2' : 'm1',
    rootPath: `/${id}`,
  };
}

describe('WorkspaceSyncController', () => {
  it('projects accepted Sync preparation and queued flush, settling a clean watcher without material custody', async () => {
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ flush: async () => { await completion; return status; } }),
      lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(), localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef, resolveAllRelationshipDefinitions: () => [definition],
    });
    const edges: unknown[] = [];
    const unsubscribe = controller.activity.subscribe(() => edges.push(true));
    try {
      const preparing = controller.ensure(definition);
      expect(await controller.activity.read()).toMatchObject({ coverage: 'complete', items: expect.arrayContaining([
        expect.objectContaining({ category: 'sync', state: 'active' }),
      ]) });
      await preparing;
      expect(await controller.activity.read()).toMatchObject({ coverage: 'complete', items: [
        { category: 'sync', ownerRef: 'r1', state: 'settled' },
      ] });
      const flushing = controller.flush('r1');
      expect(await controller.activity.read()).toMatchObject({ items: [
        { category: 'sync', ownerRef: 'r1', state: 'active' },
      ] });
      release();
      await flushing;
      expect(await controller.activity.read()).toMatchObject({ items: [
        { category: 'sync', ownerRef: 'r1', state: 'settled' },
      ] });
      expect(edges.length).toBeGreaterThan(0);
      const edgesBeforeShutdown = edges.length;
      await controller.shutdown();
      expect(await controller.activity.read()).toMatchObject({ coverage: 'unknown' });
      expect(edges.length).toBeGreaterThan(edgesBeforeShutdown);
    } finally { release(); unsubscribe(); await controller.shutdown(); }
  });

  it('cannot prove Sync inactivity without its current relationship scope', async () => {
    const controller = new WorkspaceSyncController({ adapter: completeAdapter(), lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(), localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef });
    try { expect(await controller.activity.read()).toEqual({ items: [], coverage: 'unknown' }); }
    finally { await controller.shutdown(); }
  });
  it('preserves the reviewed hub alternative before installing a selected spoke file', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-keep-both-'));
    const hubRoot = join(fixture, 'hub');
    await mkdir(hubRoot);
    await writeFile(join(hubRoot, 'value.bin'), 'original');
    const original = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
    const chosen = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
    const asidePath = deriveWorkspaceSyncConflictAsidePaths('value.bin', original)[0];
    const events: string[] = [];
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async () => status), get: vi.fn(async () => status),
        pause: vi.fn(async () => { events.push('pause'); return { ...status, state: 'paused' as const }; }),
        resume: vi.fn(async () => status), flush: vi.fn(async () => status),
        diagnoseSelection: vi.fn(async () => ({ status: 'included' as const })),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hubRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      observeEntryAtTarget: async () => chosen,
      stageConflictResolutionAtTarget: async ({ alternativeIndex }) => { events.push(`stage:${alternativeIndex ?? 'selected'}`); },
      applyStagedConflictResolutionAtTarget: async ({ alternativeIndex }) => {
        events.push(`apply:${alternativeIndex ?? 'selected'}`);
        return { status: 'installed' };
      },
    });
    try {
      await controller.ensure(definition);
      const result = await controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'b', expected: chosen },
        targets: [{ workspaceRefId: 'a', expected: original }],
        relationshipIds: ['r1'], strategy: 'keep_both',
        alternatives: [{
          source: { workspaceRefId: 'a', expected: original },
          destination: { workspaceRefId: 'a', path: asidePath, expected: { kind: 'missing' } },
          consequence: { propagatingToWorkspaceRefIds: ['b'] },
        }],
      }, undefined, 'approval-keep-both');
      expect(result).toEqual({
        endpoints: [{ workspaceRefId: 'a', status: 'applied' }],
        preserved: [{
          alternativeIndex: 0, sourceWorkspaceRefId: 'a', destinationWorkspaceRefId: 'a',
          path: asidePath, propagatingToWorkspaceRefIds: ['b'], outcome: { status: 'preserved' },
        }],
      });
      expect(events).toEqual(['stage:0', 'stage:selected', 'pause', 'apply:0', 'apply:selected']);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('does not install the selected entry when its approved upstream preservation cannot stage', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-unavailable-aside-'));
    const hubRoot = join(fixture, 'hub');
    await mkdir(hubRoot);
    await writeFile(join(hubRoot, 'value.bin'), 'original');
    const original = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
    const chosen = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
    const asidePath = deriveWorkspaceSyncConflictAsidePaths('value.bin', original)[0];
    const stage = vi.fn(async ({ alternativeIndex }: Readonly<{ alternativeIndex: number | null }>) => {
      if (alternativeIndex === 0) throw Object.assign(new Error('upstream unavailable'), { code: 'peer_unavailable' });
    });
    const apply = vi.fn(async () => ({ status: 'installed' as const }));
    const pause = vi.fn(async () => ({ ...status, state: 'paused' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async () => status), get: vi.fn(async () => status), pause,
        diagnoseSelection: vi.fn(async () => ({ status: 'included' as const })),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hubRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      observeEntryAtTarget: async () => chosen,
      stageConflictResolutionAtTarget: stage,
      applyStagedConflictResolutionAtTarget: apply,
    });
    try {
      await controller.ensure(definition);
      const result = await controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'b', expected: chosen },
        targets: [{ workspaceRefId: 'a', expected: original }],
        relationshipIds: ['r1'], strategy: 'keep_both',
        alternatives: [{
          source: { workspaceRefId: 'a', expected: original },
          destination: { workspaceRefId: 'a', path: asidePath, expected: { kind: 'missing' } },
          consequence: { propagatingToWorkspaceRefIds: ['b'] },
        }],
      }, undefined, 'approval-unavailable-aside');
      expect(result).toMatchObject({
        endpoints: [{ workspaceRefId: 'a', status: 'failed', errorCode: 'preservation_unavailable' }],
        preserved: [{ outcome: { status: 'offline' } }],
      });
      expect(apply).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('preserves on the hub when reviewed propagation becomes unverified after a touching engine pauses', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-paused-aside-'));
    const hubRoot = join(fixture, 'hub');
    await mkdir(hubRoot);
    await writeFile(join(hubRoot, 'value.bin'), 'original');
    const original = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
    const chosen = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
    const asidePath = deriveWorkspaceSyncConflictAsidePaths('value.bin', original)[0];
    const paused = { ...status, state: 'paused' as const };
    const pause = vi.fn(async () => paused);
    const resume = vi.fn(async () => status);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async () => paused), get: vi.fn(async () => paused), pause, resume,
        diagnoseSelection: vi.fn(async () => ({ status: 'unknown' as const, reason: 'endpoint_unavailable' as const })),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hubRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      observeEntryAtTarget: async () => chosen,
      stageConflictResolutionAtTarget: async () => undefined,
      applyStagedConflictResolutionAtTarget: async () => ({ status: 'installed' }),
    });
    try {
      await controller.ensure(definition);
      const result = await controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'b', expected: chosen },
        targets: [{ workspaceRefId: 'a', expected: original }],
        relationshipIds: ['r1'], strategy: 'keep_both',
        alternatives: [{
          source: { workspaceRefId: 'a', expected: original },
          destination: { workspaceRefId: 'a', path: asidePath, expected: { kind: 'missing' } },
          consequence: { propagatingToWorkspaceRefIds: ['b'] },
        }],
      }, undefined, 'approval-paused-aside');
      expect(result).toEqual({
        endpoints: [{ workspaceRefId: 'a', status: 'applied_paused' }],
        preserved: [{
          alternativeIndex: 0, sourceWorkspaceRefId: 'a', destinationWorkspaceRefId: 'a', path: asidePath,
          propagatingToWorkspaceRefIds: [], unverifiedPropagationToWorkspaceRefIds: ['b'],
          outcome: { status: 'preserved' },
        }],
      });
      expect(pause).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('stages a reviewed spoke source through its own link for hub and sibling destinations', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-spoke-'));
    const hubRoot = join(fixture, 'hub');
    await mkdir(hubRoot);
    const second = { ...definition, relationshipId: 'r2', betaWorkspaceRefId: 'c' };
    const chosen = { kind: 'file' as const, digest: createHash('sha1').update('from-c').digest('hex'), executable: false, size: 6 };
    const stages: Array<{ sourceRelationshipId: string; relationshipId: string; targetWorkspaceRefId: string }> = [];
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async (item) => ({ ...status, relationshipId: item.relationshipId })),
        get: vi.fn(async (id) => ({ ...status, relationshipId: id })),
        pause: vi.fn(async (id) => ({ ...status, relationshipId: id, state: 'paused' as const })),
        resume: vi.fn(async (id) => ({ ...status, relationshipId: id })),
        flush: vi.fn(async (id) => ({ ...status, relationshipId: id })),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hubRoot }
        : { machineId: id === 'c' ? 'm3' : 'm2', rootPath: `/remote/${id}` },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      observeEntryAtTarget: async () => chosen,
      stageConflictResolutionAtTarget: async ({ sourceRelationshipId, relationshipId, targetWorkspaceRefId }) => {
        stages.push({ sourceRelationshipId, relationshipId, targetWorkspaceRefId });
      },
      applyStagedConflictResolutionAtTarget: async () => ({ status: 'installed' }),
    });
    try {
      await controller.ensure(definition);
      await controller.ensure(second);
      const result = await controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'c', expected: chosen },
        targets: [{ workspaceRefId: 'a', expected: { kind: 'missing' } }, { workspaceRefId: 'b', expected: { kind: 'missing' } }],
        relationshipIds: ['r1', 'r2'], strategy: 'use_source',
      }, undefined, 'approval-spoke');
      expect(stages).toEqual([
        { sourceRelationshipId: 'r2', relationshipId: 'r1', targetWorkspaceRefId: 'a' },
        { sourceRelationshipId: 'r2', relationshipId: 'r1', targetWorkspaceRefId: 'b' },
      ]);
      expect(result).toEqual({ endpoints: [
        { workspaceRefId: 'a', status: 'applied' },
        { workspaceRefId: 'b', status: 'applied' },
      ] });
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('stages every reviewed linked target before pausing all touching relationships', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-linked-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'value.bin'), 'chosen');
    const second = { ...definition, relationshipId: 'r2', betaWorkspaceRefId: 'c' };
    const events: string[] = [];
    const nativeOperationIds: string[] = [];
    const adapter = completeAdapter({
      ensure: vi.fn(async (item) => ({ ...status, relationshipId: item.relationshipId })),
      get: vi.fn(async (id) => ({ ...status, relationshipId: id })),
      pause: vi.fn(async (id) => { events.push(`pause:${id}`); return { ...status, relationshipId: id, state: 'paused' as const }; }),
      resume: vi.fn(async (id) => { events.push(`resume:${id}`); return { ...status, relationshipId: id }; }),
      flush: vi.fn(async (id) => { events.push(`flush:${id}`); return { ...status, relationshipId: id }; }),
    });
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: `/remote/${id}` },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      stageConflictResolutionAtTarget: async ({ targetWorkspaceRefId, operationId }) => {
        events.push(`stage:${targetWorkspaceRefId}`);
        nativeOperationIds.push(operationId);
      },
      applyStagedConflictResolutionAtTarget: async ({ targetWorkspaceRefId }) => {
        events.push(`apply:${targetWorkspaceRefId}`);
        return { status: 'installed' };
      },
    });
    try {
      await controller.ensure(definition);
      await controller.ensure(second);
      const source = { kind: 'file' as const, digest: createHash('sha1').update('chosen').digest('hex'), executable: false, size: 6 };
      const result = await controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'a', expected: source },
        targets: [
          { workspaceRefId: 'b', expected: { kind: 'missing' } },
          { workspaceRefId: 'c', expected: { kind: 'missing' } },
        ],
        relationshipIds: ['r1', 'r2'], strategy: 'use_source',
      }, undefined, 'approval-resolution-linked');
      expect(result).toEqual({ endpoints: [
        { workspaceRefId: 'b', status: 'applied' },
        { workspaceRefId: 'c', status: 'applied' },
      ] });
      expect(events.slice(0, 2)).toEqual(['stage:b', 'stage:c']);
      expect(nativeOperationIds).toHaveLength(2);
      expect(nativeOperationIds[0]).not.toBe(nativeOperationIds[1]);
      expect(nativeOperationIds.every((id) => /^[a-f0-9]{64}$/u.test(id))).toBe(true);
      expect(events.indexOf('apply:b')).toBeGreaterThan(events.indexOf('pause:r2'));
      expect(events.indexOf('apply:c')).toBeGreaterThan(events.indexOf('pause:r2'));
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('does not resume a clean sibling after an ambiguous hub install failure', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-hub-failure-'));
    const hubRoot = join(fixture, 'hub');
    await mkdir(hubRoot);
    const second = { ...definition, relationshipId: 'r2', betaWorkspaceRefId: 'c' };
    const chosen = { kind: 'file' as const, digest: createHash('sha1').update('from-b').digest('hex'), executable: false, size: 6 };
    const resume = vi.fn(async (id: string) => ({ ...status, relationshipId: id }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async (item) => ({ ...status, relationshipId: item.relationshipId })),
        get: vi.fn(async (id) => ({ ...status, relationshipId: id })),
        pause: vi.fn(async (id) => ({ ...status, relationshipId: id, state: 'paused' as const })),
        resume,
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hubRoot }
        : { machineId: 'm2', rootPath: `/remote/${id}` },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      observeEntryAtTarget: async () => chosen,
      stageConflictResolutionAtTarget: async () => undefined,
      applyStagedConflictResolutionAtTarget: async ({ targetWorkspaceRefId }) => {
        if (targetWorkspaceRefId === 'a') throw Object.assign(new Error('install outcome unknown'), { code: 'indeterminate' });
        return { status: 'installed' };
      },
    });
    try {
      await controller.ensure(definition);
      await controller.ensure(second);
      const result = await controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'b', expected: chosen },
        targets: [{ workspaceRefId: 'a', expected: { kind: 'missing' } }],
        relationshipIds: ['r1', 'r2'], strategy: 'use_source',
      }, undefined, 'approval-hub-unknown');
      expect(result).toEqual({ endpoints: [{ workspaceRefId: 'a', status: 'failed', errorCode: 'indeterminate' }] });
      expect(resume).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('stages reviewed bytes before pausing and resumes only after a settled install', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-controller-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'value.bin'), 'source');
    const events: string[] = [];
    const adapter = completeAdapter({
      ensure: vi.fn(async () => status),
      get: vi.fn(async () => status),
      pause: vi.fn(async () => { events.push('pause'); return { ...status, state: 'paused' as const }; }),
      resume: vi.fn(async () => { events.push('resume'); return status; }),
      flush: vi.fn(async () => { events.push('flush'); return status; }),
    });
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      stageConflictResolutionAtTarget: async () => { events.push('stage'); },
      applyStagedConflictResolutionAtTarget: async () => { events.push('apply'); return { status: 'installed' }; },
    });
    try {
      await controller.ensure(definition);
      const source = { kind: 'file' as const, digest: createHash('sha1').update('source').digest('hex'), executable: false, size: 6 };
      const target = { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 3 };
      await expect(controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'a', expected: source },
        targets: [{ workspaceRefId: 'b', expected: target }],
        relationshipIds: ['r1'], strategy: 'use_source',
      }, undefined, 'approval-resolution-1')).resolves.toEqual({
        endpoints: [{ workspaceRefId: 'b', status: 'applied' }],
      });
      expect(events).toEqual(['stage', 'pause', 'apply', 'resume', 'flush']);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects source drift after staging before any target effect', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-drift-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'value.bin'), 'source');
    const adapter = completeAdapter({ ensure: vi.fn(async () => status), pause: vi.fn(async () => status) });
    const apply = vi.fn(async () => ({ status: 'installed' as const }));
    const discard = vi.fn(async () => undefined);
    const releaseCapture = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      stageConflictResolutionAtTarget: async () => { await writeFile(join(sourceRoot, 'value.bin'), 'new source'); },
      applyStagedConflictResolutionAtTarget: apply,
      discardStagedConflictResolutionAtTarget: discard,
      releaseConflictResolutionCaptureAtSource: releaseCapture,
    });
    try {
      await controller.ensure(definition);
      await expect(controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'a', expected: {
          kind: 'file', digest: createHash('sha1').update('source').digest('hex'), executable: false, size: 6,
        } },
        targets: [{ workspaceRefId: 'b', expected: { kind: 'missing' } }],
        relationshipIds: ['r1'], strategy: 'use_source',
      }, undefined, 'approval-resolution-drift')).resolves.toEqual({
        endpoints: [{ workspaceRefId: 'b', status: 'changed' }],
      });
      expect(adapter.pause).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledWith(expect.objectContaining({ actionReceiptId: 'approval-resolution-drift', targetWorkspaceRefId: 'b' }));
      expect(releaseCapture).toHaveBeenCalledWith(expect.objectContaining({
        operationId: 'approval-resolution-drift', sourceWorkspaceRefId: 'a', sourceMachineId: 'm1',
      }));
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('keeps touching synchronization paused when replacement recovery remains', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-recovery-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'value.bin'), 'source');
    const adapter = completeAdapter({
      ensure: vi.fn(async () => status), get: vi.fn(async () => status),
      pause: vi.fn(async () => ({ ...status, state: 'paused' as const })),
      resume: vi.fn(async () => status),
    });
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a' ? { machineId: 'm1', rootPath: sourceRoot } : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      stageConflictResolutionAtTarget: async () => undefined,
      applyStagedConflictResolutionAtTarget: async () => ({ status: 'recovery_needed', recoveryPath: '/safe/recovery/value.bin' }),
    });
    try {
      await controller.ensure(definition);
      const source = { kind: 'file' as const, digest: createHash('sha1').update('source').digest('hex'), executable: false, size: 6 };
      await expect(controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'a', expected: source },
        targets: [{ workspaceRefId: 'b', expected: { ...source, digest: 'b'.repeat(40) } }],
        relationshipIds: ['r1'], strategy: 'use_source',
      }, undefined, 'approval-resolution-2')).resolves.toEqual({
        endpoints: [{ workspaceRefId: 'b', status: 'recovery_needed', recoveryPath: '/safe/recovery/value.bin' }],
      });
      expect(adapter.resume).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('does not report a restored destination as applied reviewed content', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-restored-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'value.bin'), 'source');
    const adapter = completeAdapter({
      ensure: vi.fn(async () => status), get: vi.fn(async () => status),
      pause: vi.fn(async () => ({ ...status, state: 'paused' as const })),
      resume: vi.fn(async () => status), flush: vi.fn(async () => status),
    });
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a' ? { machineId: 'm1', rootPath: sourceRoot } : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      stageConflictResolutionAtTarget: async () => undefined,
      applyStagedConflictResolutionAtTarget: async () => ({ status: 'restored' }),
    });
    try {
      await controller.ensure(definition);
      const source = { kind: 'file' as const, digest: createHash('sha1').update('source').digest('hex'), executable: false, size: 6 };
      await expect(controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'a', expected: source },
        targets: [{ workspaceRefId: 'b', expected: { ...source, digest: 'b'.repeat(40) } }],
        relationshipIds: ['r1'], strategy: 'use_source',
      }, undefined, 'approval-resolution-restored')).resolves.toEqual({
        endpoints: [{ workspaceRefId: 'b', status: 'changed' }],
      });
      expect(adapter.resume).toHaveBeenCalledOnce();
      expect(adapter.flush).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('does not resume when a changed apply result retains displaced recovery bytes', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-recovery-error-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'value.bin'), 'source');
    const adapter = completeAdapter({
      ensure: vi.fn(async () => status), get: vi.fn(async () => status),
      pause: vi.fn(async () => ({ ...status, state: 'paused' as const })),
      resume: vi.fn(async () => status),
    });
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      stageConflictResolutionAtTarget: async () => undefined,
      applyStagedConflictResolutionAtTarget: async () => {
        throw Object.assign(new Error('displaced entry needs recovery'), {
          code: 'conflict_changed', recoveryPath: '/safe/recovery/value.bin',
        });
      },
    });
    try {
      await controller.ensure(definition);
      const source = { kind: 'file' as const, digest: createHash('sha1').update('source').digest('hex'), executable: false, size: 6 };
      await expect(controller.resolveConflict({
        controllerMachineId: 'm1', hubWorkspaceRefId: 'a', path: 'value.bin',
        source: { workspaceRefId: 'a', expected: source },
        targets: [{ workspaceRefId: 'b', expected: { ...source, digest: 'b'.repeat(40) } }],
        relationshipIds: ['r1'], strategy: 'use_source',
      }, undefined, 'approval-resolution-3')).resolves.toEqual({
        endpoints: [{ workspaceRefId: 'b', status: 'recovery_needed', recoveryPath: '/safe/recovery/value.bin' }],
      });
      expect(adapter.resume).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('blocks explicit resume while a target still has native replacement recovery', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-resume-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    let recoveryNeeded = false;
    const adapter = completeAdapter({
      ensure: vi.fn(async () => status), get: vi.fn(async () => ({ ...status, state: 'paused' as const })),
      resume: vi.fn(async () => status),
    });
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => undefined,
      recoverConflictResolutionAtTarget: async () => recoveryNeeded
        ? { status: 'recovery_needed', recoveryPath: '/safe/recovery/value.bin' }
        : { status: 'settled' },
    });
    try {
      await controller.ensure(definition);
      recoveryNeeded = true;
      await expect(controller.resume(definition.relationshipId)).rejects.toMatchObject({ code: 'workspace_sync_recovery_needed' });
      expect(adapter.resume).not.toHaveBeenCalled();
      recoveryNeeded = false;
      await expect(controller.resume(definition.relationshipId)).resolves.toMatchObject({ state: 'watching' });
      expect(adapter.resume).toHaveBeenCalledOnce();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('rehydrates an unrelated link while holding a recovery-affected link paused', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-resolution-restart-'));
    const alphaRoot = join(fixture, 'alpha');
    const otherRoot = join(fixture, 'other');
    await Promise.all([mkdir(alphaRoot), mkdir(otherRoot)]);
    const other = { ...definition, relationshipId: 'r2', alphaWorkspaceRefId: 'c', betaWorkspaceRefId: 'd' };
    const paused = { ...status, state: 'paused' as const };
    const watching = { ...status, relationshipId: 'r2' };
    const adapter = completeAdapter({
      rehydrate: vi.fn(async (_definitions: readonly WorkspaceSyncRelationshipV1[], _signal?: AbortSignal, held?: ReadonlySet<string>) => {
        expect(held).toEqual(new Set(['r1']));
        return [paused, watching];
      }),
      ensure: vi.fn(async () => { throw new Error('rehydrate must not resume a recovery-held link'); }),
    });
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: alphaRoot }
        : id === 'c'
          ? { machineId: 'm1', rootPath: otherRoot }
          : { machineId: 'm2', rootPath: `/remote/${id}` },
      prepareRelationshipTarget: async () => undefined,
      recoverConflictResolutionAtTarget: async ({ relationshipId }) => relationshipId === 'r1'
        ? { status: 'recovery_needed', recoveryPath: '/safe/displaced' }
        : { status: 'settled' },
    });
    try {
      await expect(controller.rehydrateFromSettings([definition, other])).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ relationshipId: 'r1', state: 'paused', errorCode: 'workspace_sync_recovery_needed' }),
        expect.objectContaining({ relationshipId: 'r2', state: 'watching' }),
      ]));
      expect(adapter.ensure).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('publishes pause, resume, and terminate status transitions through its canonical status callback', async () => {
    const published: WorkspaceSyncStatusV1[] = [];
    const adapter = completeAdapter({
      ensure: vi.fn(async () => status),
      pause: vi.fn(async () => ({ ...status, state: 'paused' as const })),
      resume: vi.fn(async () => status),
    });
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
      onStatusPublished: (next) => published.push(next),
    });

    await controller.ensure(definition);
    await controller.pause(definition.relationshipId);
    await controller.resume(definition.relationshipId);
    await controller.terminate(definition.relationshipId);

    expect(published.map((item) => item.state)).toEqual(['watching', 'paused', 'watching', 'stopped']);
  });

  it('serializes relationship commands, accepts metadata refresh, and rejects definition mutation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ensure = vi.fn(async () => { await gate; return status; });
    const controller = new WorkspaceSyncController({ adapter: completeAdapter({ ensure }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(), localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef });
    const first = controller.ensure(definition);
    const second = controller.ensure({ ...definition, createdAtMs: 2, updatedAtMs: 3 });
    release();
    await Promise.all([first, second]);
    expect(ensure).toHaveBeenCalledTimes(2);
    await expect(controller.ensure({ ...definition, mode: 'mirror_exactly' })).rejects.toMatchObject({ code: 'relationship_definition_conflict' });
  });

  it('requires the fixed controller and never starts a target-side manager', async () => {
    const ensure = vi.fn(async () => status);
    const controller = new WorkspaceSyncController({ adapter: completeAdapter({ ensure }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(), localMachineId: 'm2', resolveWorkspaceRef: () => null });
    await expect(controller.ensure(definition)).rejects.toMatchObject({ code: 'controller_unavailable' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('fences the controller-local source root before target preparation can read it', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-source-fence-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    let sourceFencedDuringPreparation: boolean | null = null;
    const prepareRelationshipTarget = vi.fn(async () => {
      // Target preparation exports, packages and materializes these source
      // bytes, so the source fence must already be held when it runs.
      const probe = await rootOwnershipManager.tryAcquire({
        ownerId: 'seed-probe',
        canonicalRoot: await realpath(sourceRoot),
        operation: 'handoff',
      });
      sourceFencedDuringPreparation = 'kind' in probe;
      if (!('kind' in probe)) await probe.release();
    });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget,
    });
    try {
      await controller.ensure(definition);
      expect(sourceFencedDuringPreparation).toBe(true);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects relationship source export when the local machine ref belongs to another Home', async () => {
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const adapter = completeAdapter();
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      localServerId: 'home-a',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { serverId: 'home-b', machineId: 'm1', rootPath: '/a' }
        : { serverId: 'home-a', machineId: 'm2', rootPath: '/b' },
      prepareRelationshipTarget,
    });

    await expect(controller.ensure(definition)).rejects.toMatchObject({
      code: 'workspace_sync_topology_invalid',
    });
    expect(prepareRelationshipTarget).not.toHaveBeenCalled();
    expect(adapter.ensure).not.toHaveBeenCalled();
  });

  it('rejects copy_once source access when the local machine ref belongs to another Home', async () => {
    const adapter = completeAdapter();
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      localServerId: 'home-a',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { serverId: 'home-b', machineId: 'm1', rootPath: '/a' }
        : { serverId: 'home-a', machineId: 'm2', rootPath: '/b' },
    });

    await expect(controller.copyOnce({
      v: 1,
      operationId: 'copy-other-home',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: definition.contentPolicy,
    })).rejects.toMatchObject({ code: 'workspace_machine_not_enrolled' });
    expect(adapter.copyOnce).not.toHaveBeenCalled();
  });

  it('preserves a transient prepared relationship across unrelated Settings reconciliation', async () => {
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const rehydrate = vi.fn(async (definitions: readonly WorkspaceSyncRelationshipV1[]) => (
      definitions.map((item) => ({ ...status, relationshipId: item.relationshipId }))
    ));
    const adapter = completeAdapter({ rehydrate });
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      prepareRelationshipTarget,
    });

    await controller.ensure(definition, undefined, {
      transient: true,
      targetBootstrap: 'use_existing',
    });
    await expect(controller.rehydrateFromSettings([])).resolves.toMatchObject([{ relationshipId: 'r1' }]);

    expect(rehydrate).toHaveBeenLastCalledWith([definition], undefined, new Set());
    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(prepareRelationshipTarget).toHaveBeenCalledTimes(1);

    await controller.rehydrateFromSettings([definition]);
    expect(prepareRelationshipTarget).toHaveBeenCalledTimes(1);
    await controller.shutdown();
  });

  it('keeps same-id live preparation authoritative over its persisted disabled intent', async () => {
    const disabled = { ...definition, enabled: false };
    const rehydrate = vi.fn(async (definitions: readonly WorkspaceSyncRelationshipV1[]) => (
      definitions.map((item) => ({ ...status, relationshipId: item.relationshipId }))
    ));
    const adapter = completeAdapter({ rehydrate });
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      prepareRelationshipTarget: vi.fn(async () => undefined),
    });

    await controller.ensure(definition, undefined, {
      transient: true,
      targetBootstrap: 'use_existing',
    });
    await controller.rehydrateFromSettings([disabled]);

    expect(rehydrate).toHaveBeenLastCalledWith([definition], undefined, new Set());
    expect(adapter.terminate).not.toHaveBeenCalled();
    await expect(controller.flush(definition.relationshipId)).resolves.toMatchObject({ relationshipId: 'r1' });
    await controller.shutdown();
  });

  it('reacquires released ownership before materializing a reconciled disabled relationship', async () => {
    const disabled = { ...definition, enabled: false };
    const ensure = vi.fn(async () => status);
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const ownership = rootOwnership();
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure,
        rehydrate: vi.fn(async () => []),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: ownership,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      prepareRelationshipTarget,
    });

    await controller.rehydrateFromSettings([disabled]);
    ownership.tryAcquire.mockClear();

    await expect(controller.ensure({ ...disabled, enabled: true }, undefined, {
      transient: true,
      targetBootstrap: 'use_existing',
    })).resolves.toMatchObject({ relationshipId: 'r1' });

    expect(ownership.tryAcquire).toHaveBeenCalled();
    expect(prepareRelationshipTarget).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenCalledWith({ ...disabled, enabled: true }, undefined);
    await controller.shutdown();
  });

  it('serializes Settings reconciliation behind an active copy and never replays the copy', async () => {
    let releaseCopy!: () => void;
    const copyGate = new Promise<void>((resolve) => { releaseCopy = resolve; });
    let copyStarted!: () => void;
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    const copyOnce = vi.fn(async () => {
      copyStarted();
      await copyGate;
      return { ...status, relationshipId: 'copy-1', mode: 'copy_once' as const };
    });
    const discoverCopyOnceRecoveries = vi.fn(async () => []);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ copyOnce, discoverCopyOnceRecoveries }),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
    });
    const operation = {
      v: 1 as const,
      operationId: 'copy-1',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: definition.contentPolicy,
    };

    const copying = controller.copyOnce(operation);
    await started;
    const reconciling = controller.rehydrateFromSettings([]);
    await Promise.resolve();
    expect(discoverCopyOnceRecoveries).not.toHaveBeenCalled();
    releaseCopy();
    await copying;
    await reconciling;

    expect(copyOnce).toHaveBeenCalledTimes(1);
    expect(discoverCopyOnceRecoveries).toHaveBeenCalledTimes(1);
    await controller.shutdown();
  });

  it('refuses relationship creation before target preparation when the source root is already owned', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-source-busy-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const held = await rootOwnershipManager.tryAcquire({
      ownerId: 'other-operation',
      canonicalRoot: await realpath(sourceRoot),
      operation: 'handoff',
    });
    expect('kind' in held).toBe(false);
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget,
    });
    try {
      await expect(controller.ensure(definition)).rejects.toMatchObject({ code: 'workspace_root_in_use' });
      expect(prepareRelationshipTarget).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      if (!('kind' in held)) await held.release();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('shares one physical hub fence across valid links and releases it only after the last member', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-shared-hub-'));
    const roots = {
      hub: join(fixture, 'hub'),
      b: join(fixture, 'b'),
      c: join(fixture, 'c'),
    };
    await Promise.all(Object.values(roots).map(async (root) => await mkdir(root)));
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const second = {
      ...definition,
      relationshipId: 'r2',
      betaWorkspaceRefId: 'c',
    };
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async (next) => ({ ...status, relationshipId: next.relationshipId })),
        flush: vi.fn(async (id) => ({ ...status, relationshipId: id })),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: roots.hub }
        : { machineId: id === 'b' ? 'm2' : 'm3', rootPath: roots[id as 'b' | 'c'] },
      prepareRelationshipTarget: vi.fn(async () => undefined),
    });

    try {
      await Promise.all([controller.ensure(definition), controller.ensure(second)]);
      await controller.terminate(definition.relationshipId);

      const whileSecondActive = await rootOwnershipManager.tryAcquire({
        ownerId: 'probe-active',
        canonicalRoot: roots.hub,
        operation: 'handoff',
      });
      expect(whileSecondActive).toMatchObject({ kind: 'overlap' });
      await expect(controller.flush(second.relationshipId)).resolves.toMatchObject({ relationshipId: 'r2' });

      await controller.terminate(second.relationshipId);
      const afterLastMember = await rootOwnershipManager.tryAcquire({
        ownerId: 'probe-released',
        canonicalRoot: roots.hub,
        operation: 'handoff',
      });
      expect(afterLastMember).not.toHaveProperty('kind');
      if (!('kind' in afterLastMember)) await afterLastMember.release();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('releases a newly acquired hub fence when the root changes before identity binding', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-admission-loss-'));
    const hub = join(fixture, 'hub');
    const displaced = join(fixture, 'displaced');
    await mkdir(hub);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    let replaceAfterAcquisition = true;
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: {
        tryAcquire: async (request) => {
          const result = await rootOwnershipManager.tryAcquire(request);
          if (replaceAfterAcquisition && !('kind' in result) && request.canonicalRoot === hub) {
            replaceAfterAcquisition = false;
            await rename(hub, displaced);
            await mkdir(hub);
          }
          return result;
        },
      },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hub }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    try {
      await expect(controller.ensure(definition)).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      const afterFailedAdmission = await rootOwnershipManager.tryAcquire({
        ownerId: 'probe-after-failed-admission',
        canonicalRoot: hub,
        operation: 'handoff',
      });
      expect(afterFailedAdmission).not.toHaveProperty('kind');
      if (!('kind' in afterFailedAdmission)) await afterFailedAdmission.release();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('stops every shared-hub session when the one physical hub root is replaced', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-shared-loss-'));
    const hub = join(fixture, 'hub');
    const displaced = join(fixture, 'displaced');
    await mkdir(hub);
    const second = { ...definition, relationshipId: 'r2', betaWorkspaceRefId: 'c' };
    const pause = vi.fn(async (id: string) => ({ ...status, relationshipId: id, state: 'paused' as const }));
    const flush = vi.fn(async (id: string) => ({ ...status, relationshipId: id }));
    const published: WorkspaceSyncStatusV1[] = [];
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        ensure: vi.fn(async (next) => ({ ...status, relationshipId: next.relationshipId })),
        pause,
        flush,
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: hub }
        : { machineId: id === 'b' ? 'm2' : 'm3', rootPath: `/remote/${id}` },
      prepareRelationshipTarget: async () => undefined,
      onStatusPublished: (next) => published.push(next),
    });
    try {
      await controller.ensure(definition);
      await controller.ensure(second);
      await rename(hub, displaced);
      await mkdir(hub);

      await expect(controller.flush('r1')).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      expect(published).toEqual(expect.arrayContaining([
        expect.objectContaining({ relationshipId: 'r1', state: 'paused', errorCode: 'workspace_root_ownership_lost' }),
        expect.objectContaining({ relationshipId: 'r2', state: 'paused', errorCode: 'workspace_root_ownership_lost' }),
      ]));
      expect(pause).toHaveBeenCalledWith('r1');
      expect(pause).toHaveBeenCalledWith('r2');
      await expect(controller.flush('r2')).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      expect(flush).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('borrows a retained spoke as a copy source without releasing its relationship fence', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-spoke-copy-'));
    const root = join(fixture, 'spoke');
    await mkdir(root);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const retained = await rootOwnershipManager.tryAcquire({ ownerId: 'linked-spoke', canonicalRoot: root, operation: 'bootstrap' });
    if ('kind' in retained) throw new Error('Expected linked spoke custody');
    const releaseLoan = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ copyOnce: vi.fn(async (operation) => ({ ...status, relationshipId: operation.operationId, mode: 'copy_once' })) }),
      lifecycle: lifecycle(),
      rootOwnershipManager,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'spoke'
        ? { machineId: 'm1', rootPath: root }
        : { machineId: 'm2', rootPath: '/remote/target' },
      borrowLinkedSourceRoot: async () => ({ handle: retained, release: releaseLoan }),
    });
    try {
      await expect(controller.copyOnce({
        v: 1, operationId: 'copy-from-spoke', controllerMachineId: 'm1',
        alphaWorkspaceRefId: 'spoke', betaWorkspaceRefId: 'remote', contentPolicy: definition.contentPolicy,
      })).resolves.toMatchObject({ relationshipId: 'copy-from-spoke' });
      expect(releaseLoan).toHaveBeenCalledOnce();
      const overlap = await rootOwnershipManager.tryAcquire({ ownerId: 'other', canonicalRoot: root, operation: 'handoff' });
      expect(overlap).toMatchObject({ kind: 'overlap' });
    } finally {
      await controller.shutdown();
      await retained.release();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('drops borrowed hub participation when copy admission fails on its exclusive target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-copy-admission-'));
    const roots = { hub: join(fixture, 'hub'), relationshipTarget: join(fixture, 'b'), copyTarget: join(fixture, 'c') };
    await Promise.all(Object.values(roots).map(async (root) => await mkdir(root)));
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: roots.hub }
        : { machineId: 'm1', rootPath: id === 'b' ? roots.relationshipTarget : roots.copyTarget },
      prepareRelationshipTarget: vi.fn(async () => undefined),
    });
    const heldTarget = await rootOwnershipManager.tryAcquire({
      ownerId: 'held-copy-target',
      canonicalRoot: roots.copyTarget,
      operation: 'handoff',
    });
    if ('kind' in heldTarget) throw new Error('copy target fixture unexpectedly overlapped');
    try {
      await controller.ensure(definition);
      await expect(controller.copyOnce({
        v: 1,
        operationId: 'copy-failed-admission',
        controllerMachineId: 'm1',
        alphaWorkspaceRefId: 'a',
        betaWorkspaceRefId: 'c',
        contentPolicy: definition.contentPolicy,
      })).rejects.toMatchObject({ code: 'workspace_root_in_use' });
      await controller.terminate(definition.relationshipId);

      const hubProbe = await rootOwnershipManager.tryAcquire({
        ownerId: 'hub-probe',
        canonicalRoot: roots.hub,
        operation: 'handoff',
      });
      expect(hubProbe).not.toHaveProperty('kind');
      if (!('kind' in hubProbe)) await hubProbe.release();
    } finally {
      await heldTarget.release();
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('exports a seed only for the exact active operation, source, policy, destination, and retained source fence', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-seed-export-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    const exportSource = vi.fn(async (canonicalSourcePath: string) => canonicalSourcePath);
    let sourceServerId = 'home-a';
    let controller!: WorkspaceSyncController;
    controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localServerId: 'home-a',
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { serverId: sourceServerId, machineId: 'm1', rootPath: sourceRoot }
        : { serverId: 'home-a', machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget: async () => {
        await expect(controller.withAuthorizedSourceSeedExport({
          operationId: definition.relationshipId,
          sourceWorkspaceRefId: definition.alphaWorkspaceRefId,
          targetMachineId: 'm2',
          contentPolicy: definition.contentPolicy,
        }, exportSource)).resolves.toBe(await realpath(sourceRoot));
        sourceServerId = 'home-b';
        await expect(controller.withAuthorizedSourceSeedExport({
          operationId: definition.relationshipId,
          sourceWorkspaceRefId: definition.alphaWorkspaceRefId,
          targetMachineId: 'm2',
          contentPolicy: definition.contentPolicy,
        }, exportSource)).rejects.toMatchObject({ code: 'workspace_machine_not_enrolled' });
        sourceServerId = 'home-a';
        await expect(controller.withAuthorizedSourceSeedExport({
          operationId: definition.relationshipId,
          sourceWorkspaceRefId: definition.alphaWorkspaceRefId,
          targetMachineId: 'wrong-machine',
          contentPolicy: definition.contentPolicy,
        }, exportSource)).rejects.toMatchObject({ code: 'target_unavailable' });
      },
    });
    try {
      await controller.ensure(definition, undefined, {
        transient: true,
        targetBootstrap: 'materialize_from_source_workspace',
      });
      expect(exportSource).toHaveBeenCalledOnce();
      await expect(controller.withAuthorizedSourceSeedExport({
        operationId: 'not-active',
        sourceWorkspaceRefId: definition.alphaWorkspaceRefId,
        targetMachineId: 'm2',
        contentPolicy: definition.contentPolicy,
      }, exportSource)).rejects.toMatchObject({ code: 'relationship_not_ready' });
      expect(exportSource).toHaveBeenCalledOnce();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('releases all daemon-owned root custody even when sidecar shutdown fails', async () => {
    const lifecycleFailure = new Error('sidecar cleanup failed');
    const release = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => { throw lifecycleFailure; }),
      },
      rootOwnershipManager: { tryAcquire: vi.fn(async (owner) => ({
        owner: { ...owner, rootFingerprint: null },
        assertCurrentRootIdentity: async () => undefined,
        bindCurrentRootIdentity: vi.fn(async () => undefined),
        release,
      })) },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
    });

    await controller.ensure(definition);
    await expect(controller.shutdown()).rejects.toMatchObject({
      errors: [lifecycleFailure],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('settles every shutdown custody entry and retries only failed releases', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-shutdown-custody-'));
    const hub = join(fixture, 'hub');
    const target = join(fixture, 'target');
    await Promise.all([mkdir(hub), mkdir(target)]);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const firstFailure = new Error('first root release failed');
    let rejectHubRelease = true;
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => {
          const acquired = await rootOwnershipManager.tryAcquire(owner);
          if ('kind' in acquired || owner.canonicalRoot !== hub) return acquired;
          return {
            ...acquired,
            release: async () => {
              if (rejectHubRelease) {
                rejectHubRelease = false;
                throw firstFailure;
              }
              await acquired.release();
            },
          };
        }),
      },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: id === 'a' ? hub : target }),
    });
    try {
      await controller.ensure(definition);
      await expect(controller.shutdown()).rejects.toMatchObject({ errors: [firstFailure] });
      const targetAfterFailure = await rootOwnershipManager.tryAcquire({ ownerId: 'target-probe', canonicalRoot: target, operation: 'handoff' });
      expect(targetAfterFailure).not.toHaveProperty('kind');
      if (!('kind' in targetAfterFailure)) await targetAfterFailure.release();
      const hubBeforeRetry = await rootOwnershipManager.tryAcquire({ ownerId: 'hub-before-retry', canonicalRoot: hub, operation: 'handoff' });
      expect(hubBeforeRetry).toMatchObject({ kind: 'overlap' });

      await expect(controller.shutdown()).resolves.toBeUndefined();
      const hubAfterRetry = await rootOwnershipManager.tryAcquire({ ownerId: 'hub-after-retry', canonicalRoot: hub, operation: 'handoff' });
      expect(hubAfterRetry).not.toHaveProperty('kind');
      if (!('kind' in hubAfterRetry)) await hubAfterRetry.release();
    } finally {
      await controller.shutdown().catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains relationship root custody when terminate cleanup fails and retries it on the next terminate', async () => {
    const cleanupFailure = new Error('relationship root release failed');
    const release = vi.fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined);
    const adapter = completeAdapter();
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => ({
          owner: { ...owner, rootFingerprint: null },
          assertCurrentRootIdentity: async () => undefined,
          bindCurrentRootIdentity: vi.fn(async () => undefined),
          release,
        })),
      },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
    });
    await controller.ensure(definition);

    await expect(controller.terminate(definition.relationshipId)).rejects.toBe(cleanupFailure);
    await expect(controller.terminate(definition.relationshipId)).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    expect(adapter.terminate).toHaveBeenCalledTimes(2);
  });

  it('retains partially acquired root custody when a later root acquisition fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-partial-root-'));
    const hub = join(fixture, 'hub');
    const target = join(fixture, 'target');
    await Promise.all([mkdir(hub), mkdir(target)]);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const cleanupFailure = new Error('partial root release failed');
    let rejectHubRelease = true;
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => {
          if (owner.canonicalRoot === target) {
            return {
              kind: 'overlap' as const,
              existing: {
                ownerId: 'other',
                canonicalRoot: target,
                operation: 'sync' as const,
                rootFingerprint: null,
              },
            };
          }
          const result = await rootOwnershipManager.tryAcquire(owner);
          if ('kind' in result) return result;
          return {
            ...result,
            release: async () => {
              if (rejectHubRelease) {
                rejectHubRelease = false;
                throw cleanupFailure;
              }
              await result.release();
            },
          };
        }),
      },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: id === 'a' ? hub : target }),
    });
    try {
      await expect(controller.ensure(definition)).rejects.toBe(cleanupFailure);
      const beforeRetry = await rootOwnershipManager.tryAcquire({ ownerId: 'probe-before-retry', canonicalRoot: hub, operation: 'handoff' });
      expect(beforeRetry).toMatchObject({ kind: 'overlap' });
      await expect(controller.shutdown()).resolves.toBeUndefined();
      const afterRetry = await rootOwnershipManager.tryAcquire({ ownerId: 'probe-after-retry', canonicalRoot: hub, operation: 'handoff' });
      expect(afterRetry).not.toHaveProperty('kind');
      if (!('kind' in afterRetry)) await afterRetry.release();
    } finally {
      await controller.shutdown().catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects a git_worktree relationship with the canonical typed outcome when Git is unavailable', async () => {
    const ensure = vi.fn(async () => status);
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const managerLifecycle = lifecycle();
    const probeGitRuntimeDependency = vi.fn(async () => false);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure }), lifecycle: managerLifecycle, rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef,
      prepareRelationshipTarget, probeGitRuntimeDependency,
    });

    await expect(controller.ensure(gitWorktreeDefinition)).rejects.toMatchObject({ code: 'git_selection_unavailable' });
    await expect(controller.copyOnce({
      v: 1 as const,
      operationId: 'copy-git',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: gitWorktreeDefinition.contentPolicy,
    })).rejects.toMatchObject({ code: 'git_selection_unavailable' });
    expect(probeGitRuntimeDependency).toHaveBeenCalledTimes(2);
    expect(prepareRelationshipTarget).not.toHaveBeenCalled();
    expect(managerLifecycle.start).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('rejects persisted git_worktree rehydration without target, root, or enabled runtime work', async () => {
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const managerLifecycle = lifecycle();
    const ownership = rootOwnership();
    const adapter = completeAdapter();
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: managerLifecycle, rootOwnershipManager: ownership,
      localMachineId: 'm1', resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
      prepareRelationshipTarget, probeGitRuntimeDependency: vi.fn(async () => false),
    });

    await expect(controller.rehydrateFromSettings([gitWorktreeDefinition])).rejects.toMatchObject({ code: 'git_selection_unavailable' });
    expect(prepareRelationshipTarget).not.toHaveBeenCalled();
    expect(ownership.tryAcquire).not.toHaveBeenCalled();
    expect(managerLifecycle.start).toHaveBeenCalledOnce();
    expect(adapter.rehydrate).toHaveBeenCalledWith([], undefined, new Set());
    expect(adapter.ensure).not.toHaveBeenCalled();
  });

  it('terminates an existing disabled runtime even when every enabled relationship requires unavailable Git', async () => {
    const disabled = {
      ...definition,
      relationshipId: 'disabled-persisted',
      enabled: false,
    };
    const enabledGit = {
      ...gitWorktreeDefinition,
      relationshipId: 'enabled-git',
      alphaWorkspaceRefId: 'git-a',
      betaWorkspaceRefId: 'git-b',
    };
    const commands: string[] = [];
    const persistedSession = (paused: boolean) => ({
      identifier: 'mutagen-disabled-persisted',
      name: disabled.relationshipId,
      labels: {
        'external.owner': 'happier-workspace-sync',
        'external.relationship_id': disabled.relationshipId,
        'external.endpoint_role': 'alpha|beta',
        'external.schema': 'workspace-sync-v1',
        'external.policy_digest': disabled.contentPolicy.policyDigest,
        'external.alpha_workspace_ref_id': disabled.alphaWorkspaceRefId,
        'external.beta_workspace_ref_id': disabled.betaWorkspaceRefId,
        'external.controller_machine_id': disabled.controllerMachineId,
        'external.operation_kind': 'relationship',
        'external.policy_selection': 'all_files',
      },
      alpha: { protocol: 'external', host: deriveWorkspaceSyncEndpointId(disabled.relationshipId, 'alpha'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId(disabled.relationshipId, 'beta'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      mode: 'one-way-safe',
      paused,
      status: 'watching',
      successfulCycles: 1,
      conflictCount: 0,
    });
    const send = vi.fn(async (command: { t: string }) => {
      commands.push(command.t);
      if (command.t === 'list') return { sessions: [persistedSession(false)], nextCursor: null };
      if (command.t === 'terminate') return null;
      throw new Error(`unexpected Mutagen command: ${command.t}`);
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => fixtureWorkspaceRef(id),
    });
    const ownership = rootOwnership();
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: ownership,
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
      prepareRelationshipTarget,
      probeGitRuntimeDependency: vi.fn(async () => false),
    });

    await expect(controller.rehydrateFromSettings([disabled, enabledGit])).resolves.toEqual([
      expect.objectContaining({ relationshipId: disabled.relationshipId, state: 'paused' }),
      expect.objectContaining({
        relationshipId: enabledGit.relationshipId,
        state: 'error',
        errorCode: 'git_selection_unavailable',
      }),
    ]);
    expect(commands).toEqual(['list', 'list', 'terminate']);
    expect(prepareRelationshipTarget).not.toHaveBeenCalled();
  });

  it('fences a disabled local root before runtime transition and publishes only after releasing it', async () => {
    const events: string[] = [];
    const disabled = { ...definition, relationshipId: 'disabled-ordered', enabled: false };
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        rehydrate: vi.fn(async () => { events.push('runtime-transition'); return []; }),
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => {
          events.push('fence');
          return {
            owner: { ...owner, rootFingerprint: null },
            assertCurrentRootIdentity: async () => undefined,
            bindCurrentRootIdentity: vi.fn(async () => undefined),
            release: vi.fn(async () => { events.push('release'); }),
          };
        }),
      },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      onStatusPublished: () => { events.push('publish'); },
    });

    await expect(controller.rehydrateFromSettings([disabled])).resolves.toEqual([
      expect.objectContaining({ relationshipId: disabled.relationshipId, state: 'paused' }),
    ]);
    expect(events).toEqual(['fence', 'runtime-transition', 'release', 'publish']);
  });

  it('removes a stale persisted runtime before rejecting an all-Git settings snapshot when Git is unavailable', async () => {
    const commands: Array<{ t: string; sessionIdentifier?: string }> = [];
    const stale = {
      identifier: 'mutagen-removed',
      name: 'removed',
      labels: {
        'external.owner': 'happier-workspace-sync',
        'external.relationship_id': 'removed',
        'external.endpoint_role': 'alpha|beta',
        'external.schema': 'workspace-sync-v1',
        'external.policy_digest': definition.contentPolicy.policyDigest,
        'external.alpha_workspace_ref_id': definition.alphaWorkspaceRefId,
        'external.beta_workspace_ref_id': definition.betaWorkspaceRefId,
        'external.controller_machine_id': definition.controllerMachineId,
        'external.operation_kind': 'relationship',
        'external.policy_selection': 'all_files',
      },
      alpha: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('removed', 'alpha'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId('removed', 'beta'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      mode: 'one-way-safe',
      paused: false,
      status: 'watching',
      successfulCycles: 1,
      conflictCount: 0,
    };
    const send = vi.fn(async (command: { t: string; sessionIdentifier?: string }) => {
      commands.push(command);
      if (command.t === 'list') return { sessions: [stale], nextCursor: null };
      if (command.t === 'terminate') return null;
      throw new Error(`unexpected Mutagen command: ${command.t}`);
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => fixtureWorkspaceRef(id),
    });
    const ownership = rootOwnership();
    const prepareRelationshipTarget = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: ownership,
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
      prepareRelationshipTarget,
      probeGitRuntimeDependency: vi.fn(async () => false),
    });

    await expect(controller.rehydrateFromSettings([gitWorktreeDefinition])).rejects.toMatchObject({
      code: 'git_selection_unavailable',
    });
    expect(commands.map(({ t, sessionIdentifier }) => [t, sessionIdentifier])).toEqual([
      ['list', undefined],
      ['list', undefined],
      ['terminate', stale.identifier],
    ]);
    expect(ownership.tryAcquire).not.toHaveBeenCalled();
    expect(prepareRelationshipTarget).not.toHaveBeenCalled();
  });

  it('rejects a recovered git_worktree copy operation before reacquiring roots or dispatching it', async () => {
    const operation = {
      v: 1 as const,
      operationId: 'copy-git-recovered',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: gitWorktreeDefinition.contentPolicy,
    };
    const ownership = rootOwnership();
    const adapter = completeAdapter({
      discoverCopyOnceRecoveries: vi.fn(async () => [operation]),
      rehydrate: vi.fn(async () => []),
    });
    const recoverCopyOnceTarget = vi.fn(async () => ({ release: vi.fn(async () => undefined) }));
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(), rootOwnershipManager: ownership, localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a' ? { machineId: 'm1', rootPath: '/a' } : { machineId: 'm2', rootPath: '/b' },
      recoverCopyOnceTarget, probeGitRuntimeDependency: vi.fn(async () => false),
    });

    await expect(controller.rehydrateFromSettings([])).rejects.toMatchObject({ code: 'git_selection_unavailable' });
    expect(ownership.tryAcquire).not.toHaveBeenCalled();
    expect(recoverCopyOnceTarget).not.toHaveBeenCalled();
    expect(adapter.copyOnce).not.toHaveBeenCalled();
  });

  it('keeps an all_files relationship usable while the Git runtime dependency is unavailable', async () => {
    const ensure = vi.fn(async () => status);
    const probeGitRuntimeDependency = vi.fn(async () => false);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef,
      probeGitRuntimeDependency,
    });

    await expect(controller.ensure(definition)).resolves.toMatchObject({ relationshipId: 'r1' });
    await expect(controller.rehydrateFromSettings([definition])).resolves.toMatchObject([{ relationshipId: 'r1' }]);
    expect(probeGitRuntimeDependency).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it('rehydrates all_files relationships while reporting only git_worktree as unavailable', async () => {
    const allFilesStatus = {
      ...status,
      relationshipId: 'all-files',
      alphaPath: '/all-files-a',
      betaPath: '/all-files-b',
    };
    const allFilesDefinition = {
      ...definition,
      relationshipId: 'all-files',
      alphaWorkspaceRefId: 'all-files-a',
      betaWorkspaceRefId: 'all-files-b',
    };
    const gitDefinition = {
      ...gitWorktreeDefinition,
      relationshipId: 'git-files',
      alphaWorkspaceRefId: 'git-files-a',
      betaWorkspaceRefId: 'git-files-b',
    };
    const rehydrate = vi.fn(async (relationships: readonly WorkspaceSyncRelationshipV1[]) => relationships.map((relationship) => ({
      ...status,
      relationshipId: relationship.relationshipId,
      alphaPath: `/${relationship.alphaWorkspaceRefId}`,
      betaPath: `/${relationship.betaWorkspaceRefId}`,
    })));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ rehydrate }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef,
      probeGitRuntimeDependency: vi.fn(async () => false),
    });

    await expect(controller.rehydrateFromSettings([allFilesDefinition, gitDefinition])).resolves.toEqual([
      allFilesStatus,
      expect.objectContaining({
        relationshipId: 'git-files',
        state: 'error',
        errorCode: 'git_selection_unavailable',
      }),
    ]);
    expect(rehydrate).toHaveBeenCalledWith([allFilesDefinition], undefined, new Set());
  });

  it('resolves the Git runtime dependency through the canonical SCM command owner by default', async () => {
    const ensure = vi.fn(async () => status);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(controller.ensure(gitWorktreeDefinition)).rejects.toMatchObject({ code: 'git_selection_unavailable' });
    } finally {
      process.env.PATH = originalPath;
    }
    expect(ensure).not.toHaveBeenCalled();
    await expect(controller.ensure(gitWorktreeDefinition)).resolves.toMatchObject({ relationshipId: 'r1' });
  });

  it('admits a 33rd valid relationship without an arbitrary controller count limit', async () => {
    const ensure = vi.fn(async (next: typeof definition) => ({ ...status, relationshipId: next.relationshipId }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', resolveWorkspaceRef: fixtureWorkspaceRef,
    });
    const relationships = Array.from({ length: 33 }, (_, index) => ({
      ...definition,
      relationshipId: `r${index + 1}`,
      alphaWorkspaceRefId: `a${index + 1}`,
      betaWorkspaceRefId: `b${index + 1}`,
    }));

    const admitted: WorkspaceSyncStatusV1[] = [];
    for (const next of relationships) admitted.push(await controller.ensure(next));
    expect(admitted).toHaveLength(33);
    expect(ensure).toHaveBeenCalledTimes(33);
    await controller.shutdown();
  });

  it('fails closed when a required adapter operation is absent', async () => {
    expect(() => new WorkspaceSyncController({ adapter: {} as never, lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(), localMachineId: 'm1', resolveWorkspaceRef: () => null })).toThrowError(expect.objectContaining({ code: 'workspace_sync_unavailable' }));
  });

  it('pauses Mutagen and releases custody when a mutation detects lost root identity', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-flush-loss-'));
    const rootPath = join(fixture, 'root');
    await mkdir(rootPath);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const pause = vi.fn(async () => ({ ...status, state: 'paused' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ pause }), lifecycle: lifecycle(), localMachineId: 'm1',
      rootOwnershipManager,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definition);
      await rename(rootPath, join(fixture, 'old-root'));
      await mkdir(rootPath);
      await expect(controller.flush('r1')).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      expect(pause).toHaveBeenCalledWith('r1');
      const replacement = await rootOwnershipManager.tryAcquire({ ownerId: 'replacement-probe', canonicalRoot: rootPath, operation: 'handoff' });
      expect(replacement).not.toHaveProperty('kind');
      if (!('kind' in replacement)) await replacement.release();
      await controller.terminate('r1');
    } finally {
      await controller.shutdown().catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('serializes bind-detected loss behind an in-flight mutation, then reacquires through canonical ensure before resume', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-queued-loss-'));
    const rootPath = join(fixture, 'root');
    await mkdir(rootPath);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const order: string[] = [];
    let finishFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => { finishFlush = resolve; });
    let acquisition = 0;
    const tryAcquire = vi.fn(async (owner) => {
      acquisition += 1;
      const currentAcquisition = acquisition;
      const acquired = await rootOwnershipManager.tryAcquire(owner);
      if ('kind' in acquired) return acquired;
      return {
        ...acquired,
        release: async () => {
          order.push(currentAcquisition === 1 ? 'release-old' : 'release-fresh');
          await acquired.release();
        },
      };
    });
    const pause = vi.fn(async () => { order.push('pause'); return { ...status, state: 'paused' as const }; });
    const ensure = vi.fn(async () => { order.push('ensure'); return status; });
    const resume = vi.fn(async () => { order.push('resume-direct'); return status; });
    const flush = vi.fn(async () => {
      order.push('flush-start');
      await flushGate;
      order.push('flush-end');
      return status;
    });
    const prepareRelationshipTarget = vi.fn(async () => { order.push('prepare-target'); });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ pause, ensure, resume, flush }),
      lifecycle: lifecycle(),
      rootOwnershipManager: { tryAcquire },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath }
        : { machineId: 'm2', rootPath: '/remote/b' },
      prepareRelationshipTarget,
    });
    try {
      await controller.ensure(definition);
      order.length = 0;
      const flushing = controller.flush('r1');
      await vi.waitFor(() => expect(order).toEqual(['flush-start']));
      expect(order).toEqual(['flush-start']);
      expect(pause).not.toHaveBeenCalled();

      await rename(rootPath, join(fixture, 'old-root'));
      await mkdir(rootPath);

      const losingFlush = controller.flush('r1');
      const losingFlushResult = expect(losingFlush).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });

      finishFlush();
      await flushing;
      await losingFlushResult;
      expect(order).toEqual(['flush-start', 'flush-end', 'pause', 'release-old']);

      await controller.resume('r1');
      expect(tryAcquire).toHaveBeenCalledTimes(2);
      expect(prepareRelationshipTarget).toHaveBeenCalledTimes(2);
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(resume).not.toHaveBeenCalled();
      expect(order.slice(-2)).toEqual(['prepare-target', 'ensure']);
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains copy_once root authority after an indeterminate dispatch and releases it only after terminal retry', async () => {
    const release = vi.fn(async () => undefined);
    const tryAcquire = vi.fn(async (owner) => ({
      owner: { ...owner, rootFingerprint: null },
      assertCurrentRootIdentity: async () => undefined,
      bindCurrentRootIdentity: vi.fn(async () => undefined),
      release,
    }));
    const copyOnce = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('result lost'), { code: 'indeterminate' }))
      .mockResolvedValueOnce({ ...status, relationshipId: 'copy-1', mode: 'copy_once' as const });
    const get = vi.fn(async () => ({ ...status, relationshipId: 'copy-1', mode: 'copy_once' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ copyOnce, get }),
      lifecycle: lifecycle(),
      rootOwnershipManager: { tryAcquire },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: `/tmp/controller-copy-${process.pid}` }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    const operation = {
      v: 1 as const,
      operationId: 'copy-1',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };

    await expect(controller.copyOnce(operation)).rejects.toMatchObject({ code: 'indeterminate' });
    expect(release).not.toHaveBeenCalled();
    await expect(controller.get('copy-1')).resolves.toMatchObject({ relationshipId: 'copy-1', mode: 'copy_once' });
    expect(release).not.toHaveBeenCalled();

    await expect(controller.copyOnce(operation)).resolves.toMatchObject({ relationshipId: 'copy-1', mode: 'copy_once' });
    expect(tryAcquire).toHaveBeenCalledOnce();
    expect(copyOnce).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('retains copy_once runtime and root custody when the operation and required termination both fail', async () => {
    const operationError = Object.assign(new Error('flush failed'), { code: 'engine_error' });
    const cleanupError = Object.assign(new Error('termination acknowledgement unavailable'), { code: 'agent_unavailable' });
    const operationId = 'copy-dual-failure';
    let terminateAttempts = 0;
    const genericSession = (overrides: Record<string, unknown> = {}) => ({
      identifier: 'mutagen-copy-dual-failure',
      name: operationId,
      labels: {
        'external.owner': 'happier-workspace-sync',
        'external.relationship_id': operationId,
        'external.endpoint_role': 'alpha|beta',
        'external.schema': 'workspace-sync-v1',
        'external.policy_digest': computeWorkspaceSyncPolicyDigest(policy),
        'external.alpha_workspace_ref_id': 'a',
        'external.beta_workspace_ref_id': 'b',
        'external.controller_machine_id': 'm1',
        'external.operation_kind': 'copy_once',
        'external.policy_selection': 'all_files',
      },
      alpha: { protocol: 'external', host: deriveWorkspaceSyncEndpointId(operationId, 'alpha'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      beta: { protocol: 'external', host: deriveWorkspaceSyncEndpointId(operationId, 'beta'), path: '', state: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } },
      mode: 'one-way-safe',
      paused: false,
      status: 'watching',
      successfulCycles: 0,
      conflictCount: 0,
      ...overrides,
    });
    const send = vi.fn(async (command: { t: string }) => {
      if (command.t === 'list') return { sessions: [], nextCursor: null };
      if (command.t === 'create') return genericSession({ paused: true, status: 'disconnected' });
      if (command.t === 'flush') throw operationError;
      if (command.t === 'terminate') {
        terminateAttempts += 1;
        if (terminateAttempts === 1) throw cleanupError;
        return null;
      }
      return genericSession();
    });
    const adapter = createWorkspaceSyncMutagenAdapter({
      send,
      createRequestId: () => 'request-1',
      resolveWorkspaceRef: async (id) => ({ machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` }),
    });
    const release = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: { tryAcquire: vi.fn(async (owner) => ({
        owner: { ...owner, rootFingerprint: null },
        assertCurrentRootIdentity: async () => undefined,
        bindCurrentRootIdentity: vi.fn(async () => undefined),
        release,
      })) },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => ({ machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` }),
    });
    const operation = {
      v: 1 as const,
      operationId,
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };

    const first = await controller.copyOnce(operation).catch((error: unknown) => error);
    expect(first).toMatchObject({ code: 'indeterminate', cause: operationError, cleanupError });
    expect(release).not.toHaveBeenCalled();

    await expect(controller.terminate(operationId)).resolves.toBeUndefined();
    expect(terminateAttempts).toBe(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses carried copy_once custody without reacquiring or releasing its exact root', async () => {
    const carriedRelease = vi.fn(async () => undefined);
    const carried = Object.freeze({
      owner: {
        ownerId: 'copy-carried',
        canonicalRoot: `/tmp/controller-copy-carried-${process.pid}`,
        operation: 'handoff' as const,
        rootFingerprint: null,
      },
      assertCurrentRootIdentity: async () => undefined,
      bindCurrentRootIdentity: vi.fn(async () => undefined),
      release: carriedRelease,
    });
    const tryAcquire = vi.fn(async () => ({
      kind: 'overlap' as const,
      existing: carried.owner,
    }));
    const copyOnce = vi.fn(async () => ({
      ...status,
      relationshipId: 'copy-carried',
      mode: 'copy_once' as const,
    }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ copyOnce }),
      lifecycle: lifecycle(),
      rootOwnershipManager: { tryAcquire },
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: carried.owner.canonicalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    const operation = {
      v: 1 as const,
      operationId: 'copy-carried',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };

    await expect(controller.copyOnce(operation, undefined, [carried])).resolves.toMatchObject({
      relationshipId: 'copy-carried',
    });
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(carried.bindCurrentRootIdentity).toHaveBeenCalledOnce();
    expect(carriedRelease).not.toHaveBeenCalled();
    await controller.shutdown();
    expect(carriedRelease).not.toHaveBeenCalled();
  });

  it('closes and denies endpoint ingress when admission detects lost root identity', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-ingress-'));
    const rootPath = join(fixture, 'root');
    await mkdir(rootPath);
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const agentStream = new PassThrough();
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ pause: vi.fn(async () => ({ ...status, state: 'paused' as const })) }),
      lifecycle: lifecycle(),
      rootOwnershipManager,
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath }
        : { machineId: 'm2', rootPath: '/remote/b' },
      openLocalWorkspaceAgentStream: vi.fn(async () => ownedLocalAgent(agentStream)),
    });
    try {
      await controller.ensure(definition);
      await rename(rootPath, join(fixture, 'old-root'));
      await mkdir(rootPath);
      await expect(controller.openExternalStream({
        endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
      })).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      expect(agentStream.destroyed).toBe(false);
      const replacement = await rootOwnershipManager.tryAcquire({ ownerId: 'replacement-probe', canonicalRoot: rootPath, operation: 'handoff' });
      expect(replacement).not.toHaveProperty('kind');
      if (!('kind' in replacement)) await replacement.release();
      await expect(controller.openExternalStream({
        endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
      })).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rehydrates enabled relationships from settings without persisted Mutagen IDs', async () => {
    const events: string[] = [];
    const ensure = vi.fn(async () => status);
    const rehydrate = vi.fn(async () => { events.push('rehydrate'); return []; });
    const lifecycleOwner = lifecycle();
    lifecycleOwner.start.mockImplementation(async () => { events.push('start'); });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure, rehydrate }), lifecycle: lifecycleOwner, localMachineId: 'm1',
      prepareRelationshipTarget: vi.fn(async () => { events.push('target'); }),
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => {
          events.push('fence');
          return {
            owner: { ...owner, rootFingerprint: null },
            assertCurrentRootIdentity: async () => undefined,
            bindCurrentRootIdentity: vi.fn(async () => undefined),
            release: vi.fn(async () => undefined),
          };
        }),
      },
      resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
    });
    await controller.rehydrateFromSettings([definition]);
    expect(events.slice(0, 5)).toEqual(['fence', 'target', 'fence', 'start', 'rehydrate']);
    expect(rehydrate).toHaveBeenCalledWith([definition], undefined, new Set());
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledWith(definition, undefined);
    await controller.shutdown();
  });

  it('keeps disabled intent paused across a cold restart while an enabled relationship bootstraps through target authority', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-disabled-restart-'));
    const roots = {
      disabledAlpha: join(fixture, 'disabled-alpha'),
      disabledBeta: join(fixture, 'disabled-beta'),
      enabledAlpha: join(fixture, 'enabled-alpha'),
      enabledBeta: join(fixture, 'enabled-beta'),
    };
    await Promise.all([
      mkdir(roots.disabledAlpha),
      mkdir(roots.disabledBeta),
      mkdir(roots.enabledAlpha),
      mkdir(roots.enabledBeta),
    ]);
    const gitPolicyInput = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: [],
      extraIncludePatterns: [],
    };
    const disabled = {
      ...definition,
      relationshipId: 'disabled-restart',
      alphaWorkspaceRefId: 'disabled-alpha',
      betaWorkspaceRefId: 'disabled-beta',
      enabled: false,
      contentPolicy: { ...gitPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(gitPolicyInput) },
    };
    const enabled = {
      ...definition,
      relationshipId: 'enabled-restart',
      alphaWorkspaceRefId: 'enabled-alpha',
      betaWorkspaceRefId: 'enabled-beta',
    };
    let disabledEnabled = false;
    let projectsReady = false;
    const projectSnapshot = (): ActiveProjectAccountRowsSnapshot => ({
      source: 'network',
      workspaceRefs: [
        { id: 'disabled-alpha', serverId: 'server-1', machineId: 'm1', rootPath: roots.disabledAlpha, createdAtMs: 1 },
        { id: 'disabled-beta', serverId: 'server-1', machineId: 'm2', rootPath: roots.disabledBeta, createdAtMs: 1 },
        { id: 'enabled-alpha', serverId: 'server-1', machineId: 'm1', rootPath: roots.enabledAlpha, createdAtMs: 1 },
        { id: 'enabled-beta', serverId: 'server-1', machineId: 'm2', rootPath: roots.enabledBeta, createdAtMs: 1 },
      ],
      relationships: projectsReady
        ? [{ ...disabled, enabled: disabledEnabled }, enabled]
        : [],

      graphRevision: disabledEnabled ? 2 : 1,
      loadedAtMs: 1,
      organizations: [], rows: [], scopeKey: 'account-1',
    });
    const targetLockDirectory = join(fixture, 'target-locks');
    const initialAuthority = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'm2',
      getProjectSnapshot: projectSnapshot,
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      bootstrap: {
        materializationDirectory: join(fixture, 'target-staging'),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: targetLockDirectory }),
        prepareGitTarget: async ({ canonicalRoot }) => {
          await mkdir(canonicalRoot, { recursive: true });
        },
      },
    });
    await initialAuthority.prepareBootstrapAtTarget({
      v: 1,
      bootstrapOperationId: enabled.relationshipId,
      owner: { kind: 'relationship', relationshipId: enabled.relationshipId },
      transientRelationship: enabled,
      targetWorkspaceRefId: enabled.betaWorkspaceRefId,
      targetMachineId: 'm2',
      endpointRole: 'beta',
      policyDigest: enabled.contentPolicy.policyDigest,
      createIfMissing: true,
      targetBootstrap: 'use_existing',
    });
    await initialAuthority.releaseBootstrapAtTarget({
      v: 1,
      bootstrapOperationId: enabled.relationshipId,
      targetWorkspaceRefId: enabled.betaWorkspaceRefId,
      targetMachineId: 'm2',
      reason: 'relationship_committed',
    });
    const initiallyEnabledDisabledRelationship = { ...disabled, enabled: true };
    await initialAuthority.prepareBootstrapAtTarget({
      v: 1,
      bootstrapOperationId: disabled.relationshipId,
      owner: { kind: 'relationship', relationshipId: disabled.relationshipId },
      transientRelationship: initiallyEnabledDisabledRelationship,
      targetWorkspaceRefId: disabled.betaWorkspaceRefId,
      targetMachineId: 'm2',
      endpointRole: 'beta',
      policyDigest: disabled.contentPolicy.policyDigest,
      createIfMissing: true,
      targetBootstrap: 'use_existing',
    });
    await initialAuthority.releaseBootstrapAtTarget({
      v: 1,
      bootstrapOperationId: disabled.relationshipId,
      targetWorkspaceRefId: disabled.betaWorkspaceRefId,
      targetMachineId: 'm2',
      reason: 'relationship_committed',
    });
    projectsReady = true;
    await initialAuthority.releaseAllRetainedBootstraps();
    const targetRootOwnership = createWorkspaceRootOwnershipManager({ lockDirectory: targetLockDirectory });
    const authority = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'm2',
      getProjectSnapshot: projectSnapshot,
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      bootstrap: {
        materializationDirectory: join(fixture, 'target-staging'),
        rootOwnershipManager: targetRootOwnership,
        prepareGitTarget: async ({ canonicalRoot }) => {
          await mkdir(canonicalRoot, { recursive: true });
        },
      },
    });
    const prepareRelationshipTarget = vi.fn(async (relationship: WorkspaceSyncRelationshipV1) => (
      await authority.prepareBootstrapAtTarget({
        v: 1,
        bootstrapOperationId: relationship.relationshipId,
        owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
        targetWorkspaceRefId: relationship.betaWorkspaceRefId,
        targetMachineId: 'm2',
        endpointRole: 'beta',
        policyDigest: relationship.contentPolicy.policyDigest,
        createIfMissing: true,
      })
    ));
    const adapter = completeAdapter({
      rehydrate: vi.fn(async () => []),
      ensure: vi.fn(async (relationship: WorkspaceSyncRelationshipV1) => ({
        ...status,
        relationshipId: relationship.relationshipId,
        mode: relationship.mode,
      })),
    });
    let gitAvailable = false;
    const probeGitRuntimeDependency = vi.fn(async () => gitAvailable);
    const refs = new Map(projectSnapshot().workspaceRefs.map((ref) => [ref.id, ref]));
    const controllerRootOwnership = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'controller-locks') });
    const tryAcquire = vi.fn(async (input: Parameters<typeof controllerRootOwnership.tryAcquire>[0]) => (
      await controllerRootOwnership.tryAcquire(input)
    ));
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: { tryAcquire },
      localMachineId: 'm1',
      localServerId: 'server-1',
      resolveWorkspaceRef: (id) => refs.get(id) ?? null,
      prepareRelationshipTarget,
      probeGitRuntimeDependency,
    });
    try {
      await expect(controller.rehydrateFromSettings([disabled, enabled])).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ relationshipId: 'disabled-restart', state: 'paused' }),
        expect.objectContaining({ relationshipId: 'enabled-restart' }),
      ]));
      expect(prepareRelationshipTarget).toHaveBeenCalledTimes(1);
      expect(prepareRelationshipTarget).toHaveBeenCalledWith(enabled, undefined);
      expect(probeGitRuntimeDependency).not.toHaveBeenCalled();
      expect(tryAcquire).toHaveBeenCalledWith(expect.objectContaining({ ownerId: disabled.alphaWorkspaceRefId }));
      await expect(access(roots.disabledBeta)).resolves.toBeUndefined();

      disabledEnabled = true;
      gitAvailable = true;
      const resumed = { ...disabled, enabled: true };
      await expect(controller.rehydrateFromSettings([resumed, enabled])).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ relationshipId: 'disabled-restart' }),
        expect.objectContaining({ relationshipId: 'enabled-restart' }),
      ]));
      expect(prepareRelationshipTarget).toHaveBeenCalledWith(resumed, undefined);
      expect(probeGitRuntimeDependency).toHaveBeenCalledOnce();
      expect(tryAcquire).toHaveBeenCalledWith(expect.objectContaining({ ownerId: disabled.alphaWorkspaceRefId }));
      await expect(access(roots.disabledBeta)).resolves.toBeUndefined();
    } finally {
      await controller.shutdown().catch(() => undefined);
      await authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rehydrates valid saved components while leaving an invalid saved component cold', async () => {
    const invalidSecond = {
      ...definition,
      relationshipId: 'invalid-second',
      betaWorkspaceRefId: 'c',
    };
    const invalidCycle = {
      ...definition,
      relationshipId: 'invalid-cycle',
      controllerMachineId: 'm2',
      alphaWorkspaceRefId: 'b',
      betaWorkspaceRefId: 'c',
    };
    const valid = {
      ...definition,
      relationshipId: 'valid-unrelated',
      alphaWorkspaceRefId: 'd',
      betaWorkspaceRefId: 'e',
    };
    const rehydrate = vi.fn(async (relationships: readonly WorkspaceSyncRelationshipV1[]) => (
      relationships.map((relationship) => ({ ...status, relationshipId: relationship.relationshipId }))
    ));
    const adapter = completeAdapter({ rehydrate });
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => ({
        machineId: id === 'a' || id === 'd' ? 'm1' : id === 'b' ? 'm2' : id === 'c' ? 'm3' : 'm4',
        rootPath: `/${id}`,
      }),
      prepareRelationshipTarget: vi.fn(async () => undefined),
    });

    await controller.rehydrateFromSettings([definition, invalidSecond, invalidCycle, valid]);

    expect(rehydrate).toHaveBeenCalledWith([valid], undefined, new Set());
    expect(adapter.ensure).not.toHaveBeenCalled();
    expect(adapter.terminate).not.toHaveBeenCalled();
    await controller.shutdown();
  });

  it('uses the canonical queued ensure before a handoff flush can start a newly-written relationship', async () => {
    const events: string[] = [];
    const ensure = vi.fn(async () => { events.push('ensure'); return status; });
    const flush = vi.fn(async () => { events.push('flush'); return status; });
    const lifecycleOwner = lifecycle();
    lifecycleOwner.start.mockImplementation(async () => { events.push('start'); });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure, flush }),
      lifecycle: lifecycleOwner,
      localMachineId: 'm1',
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => {
          events.push('fence');
          return {
            owner: { ...owner, rootFingerprint: null },
            assertCurrentRootIdentity: async () => undefined,
            bindCurrentRootIdentity: vi.fn(async () => undefined),
            release: vi.fn(async () => undefined),
          };
        }),
      },
      resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
      resolveRelationshipDefinition: (relationshipId) => relationshipId === definition.relationshipId ? definition : null,
      prepareRelationshipTarget: vi.fn(async () => { events.push('target'); }),
    });

    await controller.flush(definition.relationshipId);

    expect(events).toEqual(['fence', 'target', 'fence', 'start', 'ensure', 'start', 'flush']);
    await controller.shutdown();
  });

  it('retains root ownership until rooted-agent cleanup succeeds when settings remove a relationship', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-settings-removal-'));
    const roots = { a: join(fixture, 'a'), b: join(fixture, 'b') };
    await Promise.all([mkdir(roots.a), mkdir(roots.b)]);
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const cleanupFailure = new Error('removed relationship rooted-agent cleanup failed');
    let failStop = true;
    const stop = vi.fn(async () => {
      if (failStop) throw cleanupFailure;
    });
    const rootOwnershipManager = {
      tryAcquire: vi.fn(async (owner) => {
        const release = vi.fn(async () => undefined);
        releases.push(release);
        return {
          owner: { ...owner, rootFingerprint: null },
          assertCurrentRootIdentity: async () => undefined,
          bindCurrentRootIdentity: vi.fn(async () => undefined),
          release,
        };
      }),
    };
    const rehydrate = vi.fn().mockResolvedValue([])
      .mockResolvedValueOnce([status])
      .mockResolvedValueOnce([]);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ rehydrate }), lifecycle: lifecycle(), localMachineId: 'm1',
      rootOwnershipManager,
      openLocalWorkspaceAgentStream: vi.fn(async () => ownedLocalAgent(new PassThrough(), stop)),
      resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: roots[id as keyof typeof roots] }),
    });

    await controller.rehydrateFromSettings([definition]);
    await controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId(definition.relationshipId, 'alpha'),
    });
    await expect(controller.rehydrateFromSettings([])).rejects.toBe(cleanupFailure);
    expect(releases.every((release) => release.mock.calls.length === 0)).toBe(true);

    failStop = false;
    await expect(controller.rehydrateFromSettings([])).resolves.toEqual([]);

    expect(rehydrate).toHaveBeenNthCalledWith(1, [definition], undefined, new Set());
    expect(rehydrate).toHaveBeenNthCalledWith(2, [], undefined, new Set());
    expect(rehydrate).toHaveBeenNthCalledWith(3, [], undefined, new Set());
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    await controller.shutdown();
    await rm(fixture, { recursive: true, force: true });
  });

  it('maps an opaque endpoint to the lifecycle-owned machine tunnel loopback port', async () => {
    const applicationServer = createServer({ allowHalfOpen: true }, (socket) => {
      let admission = Buffer.alloc(0);
      const consumeCapability = (chunk: Buffer) => {
        admission = Buffer.concat([admission, chunk]);
        if (admission.length < 64) return;
        socket.off('data', consumeCapability);
        const payload = admission.subarray(64);
        if (payload.length > 0) socket.write(payload);
        socket.pipe(socket);
      };
      socket.on('data', consumeCapability);
    });
    applicationServer.listen({ host: '127.0.0.1', port: 0 });
    await once(applicationServer, 'listening');
    const applicationAddress = applicationServer.address();
    if (!applicationAddress || typeof applicationAddress === 'string') throw new Error('test application port unavailable');
    const close = vi.fn(async () => undefined);
    const openMachineCarrierTunnel = vi.fn(async () => ({
      localPort: applicationAddress.port,
      localCapability: 'a'.repeat(64),
      observedPath: 'direct' as const,
      close,
    }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', openMachineCarrierTunnel,
      resolveWorkspaceRef: (id) => ({ machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` }),
    });
    await controller.ensure(definition);
    const stream = await controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId('r1', 'beta') });
    expect(openMachineCarrierTunnel).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'r1', sourceMachineId: 'm1', targetMachineId: 'm2', flow: 'workspace_sync',
    }));
    const echoed = once(stream, 'data') as Promise<[Buffer]>;
    stream.write(Buffer.from('native-tunnel-loopback'));
    await expect(echoed).resolves.toEqual([Buffer.from('native-tunnel-loopback')]);
    stream.destroy();
    await once(stream, 'close');
    expect(close).toHaveBeenCalledOnce();
    await controller.terminate('r1');
    applicationServer.close();
  });

  it('awaits a delayed remote tunnel cleanup failure and retains it for shutdown retry', async () => {
    const applicationServer = createServer({ allowHalfOpen: true }, (socket) => {
      socket.once('data', () => socket.pipe(socket));
    });
    applicationServer.listen({ host: '127.0.0.1', port: 0 });
    await once(applicationServer, 'listening');
    const applicationAddress = applicationServer.address();
    if (!applicationAddress || typeof applicationAddress === 'string') throw new Error('test application port unavailable');
    const cleanupFailure = new Error('remote native tunnel cleanup failed');
    let rejectFirstCleanup!: (error: unknown) => void;
    const firstCleanup = new Promise<void>((_, reject) => { rejectFirstCleanup = reject; });
    const close = vi.fn()
      .mockReturnValueOnce(firstCleanup)
      .mockResolvedValueOnce(undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      openMachineCarrierTunnel: vi.fn(async () => ({
        localPort: applicationAddress.port,
        localCapability: 'a'.repeat(64),
        observedPath: 'direct' as const,
        close,
      })),
      resolveWorkspaceRef: (id) => ({ machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` }),
    });
    await controller.ensure(definition);
    const stream = await controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId('r1', 'beta') });

    stream.destroy();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    const terminating = controller.terminate('r1');
    rejectFirstCleanup(cleanupFailure);
    await expect(terminating).rejects.toBe(cleanupFailure);
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
    applicationServer.close();
  });

  it('allows manager resume to re-enter the relationship through its external stream', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-reentrant-agent-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const openLocalWorkspaceAgentStream = vi.fn(async () => ownedLocalAgent());
    let controller!: WorkspaceSyncController;
    const ensure = vi.fn(async () => {
      const stream = await controller.openExternalStream({
        endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
      });
      stream.destroy();
      return status;
    });
    controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(localRoot, 'locks') }),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });

    const ensuring = controller.ensure(definition);
    await vi.waitFor(() => expect(openLocalWorkspaceAgentStream).toHaveBeenCalledOnce(), { timeout: 1_000 });
    await expect(ensuring).resolves.toEqual(status);
    await controller.shutdown();
    await rm(localRoot, { recursive: true, force: true });
  });

  it('publishes the desired relationship fence before manager rehydration opens its external stream', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-rehydrate-agent-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const openLocalWorkspaceAgentStream = vi.fn(async () => ownedLocalAgent());
    let controller!: WorkspaceSyncController;
    const rehydrate = vi.fn(async () => {
      const stream = await controller.openExternalStream({
        endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
      });
      stream.destroy();
      return [status];
    });
    controller = new WorkspaceSyncController({
      adapter: completeAdapter({ rehydrate }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(localRoot, 'locks') }),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });

    await expect(controller.rehydrateFromSettings([definition])).resolves.toEqual([status]);
    expect(openLocalWorkspaceAgentStream).toHaveBeenCalledOnce();
    await controller.shutdown();
    await rm(localRoot, { recursive: true, force: true });
  });

  it('rolls back provisioned relationship fences when manager rehydration fails', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-rehydrate-rollback-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const opened = new PassThrough();
    const openLocalWorkspaceAgentStream = vi.fn(async () => ownedLocalAgent(opened));
    let controller!: WorkspaceSyncController;
    const rehydrate = vi.fn(async () => {
      await controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha') });
      throw Object.assign(new Error('manager rehydrate failed'), { code: 'engine_unavailable' });
    });
    controller = new WorkspaceSyncController({
      adapter: completeAdapter({
        rehydrate,
      }),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(localRoot, 'locks') }),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });

    await expect(controller.rehydrateFromSettings([definition])).rejects.toMatchObject({ code: 'engine_unavailable' });
    expect(opened.destroyed).toBe(true);
    await expect(controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    })).rejects.toMatchObject({ code: 'relationship_not_owned' });
    await controller.shutdown();
    await rm(localRoot, { recursive: true, force: true });
  });

  it('opens a local endpoint through the verified rooted agent seam, not machine carrier', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-local-agent-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const openLocalWorkspaceAgentStream = vi.fn(async () => ownedLocalAgent());
    const openMachineCarrierTunnel = vi.fn();
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', openLocalWorkspaceAgentStream, openMachineCarrierTunnel,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);

    const stream = await controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha') });

    expect(openLocalWorkspaceAgentStream).toHaveBeenCalledWith({
      operationId: 'r1', role: 'alpha', workspaceRefId: 'a', canonicalRoot: await realpath(localRoot),
    });
    expect(openMachineCarrierTunnel).not.toHaveBeenCalled();
    stream.destroy();
    await controller.terminate('r1');
    await rm(localRoot, { recursive: true, force: true });
  });

  it('keeps admitted ingress live for graceful manager SHUTDOWN, then closes it while rejecting new ingress', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-shutdown-order-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const stream = new PassThrough();
    const events: string[] = [];
    let releaseManagerShutdown!: () => void;
    const managerShutdown = new Promise<void>((resolve) => { releaseManagerShutdown = resolve; });
    const openLocalWorkspaceAgentStream = vi.fn(async () => ownedLocalAgent(stream, vi.fn(async () => {
      events.push('ingress-stop');
    })));
    const lifecycleOwner = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => {
        events.push('manager-shutdown');
        await managerShutdown;
      }),
    };
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycleOwner, rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', openLocalWorkspaceAgentStream,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);
    await controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha') });

    const shutdown = controller.shutdown();
    await vi.waitFor(() => expect(lifecycleOwner.stop).toHaveBeenCalledOnce());
    expect(stream.destroyed).toBe(false);
    await expect(controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    })).rejects.toMatchObject({ code: 'relationship_not_owned' });
    expect(openLocalWorkspaceAgentStream).toHaveBeenCalledOnce();

    releaseManagerShutdown();
    await shutdown;
    expect(events).toEqual(['manager-shutdown', 'ingress-stop']);
    await rm(localRoot, { recursive: true, force: true });
  });

  it('does not publish a late local ingress after its relationship terminates', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-local-agent-race-'));
    const canonicalLocalRoot = await realpath(localRoot);
    let resolveAgent!: (agent: ReturnType<typeof ownedLocalAgent>) => void;
    const pendingAgent = new Promise<ReturnType<typeof ownedLocalAgent>>((resolve) => {
      resolveAgent = resolve;
    });
    const stream = new PassThrough();
    const agent = ownedLocalAgent(stream);
    const openLocalWorkspaceAgentStream = vi.fn(async () => await pendingAgent);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);

    const opening = controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    });
    await vi.waitFor(() => expect(openLocalWorkspaceAgentStream).toHaveBeenCalledOnce());
    await controller.terminate('r1');
    resolveAgent(agent);

    await expect(opening).rejects.toMatchObject({ code: 'relationship_not_owned' });
    expect(agent.stop).toHaveBeenCalledOnce();
    expect(stream.destroyed).toBe(true);
    await controller.shutdown();
    await rm(localRoot, { recursive: true, force: true });
  });

  it('retains local agent process custody after close cleanup fails and retries it during shutdown', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-local-agent-retry-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const cleanupFailure = new Error('local agent cleanup failed');
    const stop = vi.fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValueOnce(undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream: vi.fn(async () => ownedLocalAgent(new PassThrough(), stop)),
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);
    const stream = await controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    });

    stream.destroy();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    await rm(localRoot, { recursive: true, force: true });
  });

  it('clears successful local agent custody after natural stream termination', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-local-agent-natural-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const stream = new PassThrough();
    const stop = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream: vi.fn(async () => ownedLocalAgent(stream, stop)),
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);
    await controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    });

    stream.destroy();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    await controller.shutdown();
    expect(stop).toHaveBeenCalledOnce();
    await rm(localRoot, { recursive: true, force: true });
  });

  it('surfaces persistent local agent cleanup failure and keeps it retryable across shutdown attempts', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-local-agent-persistent-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const cleanupFailure = new Error('persistent local agent cleanup failure');
    const stop = vi.fn(async () => { throw cleanupFailure; });
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream: vi.fn(async () => ownedLocalAgent(new PassThrough(), stop)),
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);
    const stream = await controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    });
    stream.destroy();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());

    await expect(controller.shutdown()).rejects.toMatchObject({ errors: [cleanupFailure] });
    await expect(controller.shutdown()).rejects.toMatchObject({ errors: [cleanupFailure] });
    expect(stop).toHaveBeenCalledTimes(3);
    await rm(localRoot, { recursive: true, force: true });
  });

  it('retains relationship root custody while rooted-agent shutdown keeps failing', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-agent-fence-'));
    const canonicalLocalRoot = await realpath(localRoot);
    const cleanupFailure = new Error('rooted agent cleanup failed');
    let failStop = true;
    const stop = vi.fn(async () => {
      if (failStop) throw cleanupFailure;
    });
    const release = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: {
        tryAcquire: vi.fn(async (owner) => ({
          owner: { ...owner, canonicalRoot: canonicalLocalRoot, rootFingerprint: null },
          assertCurrentRootIdentity: async () => undefined,
          bindCurrentRootIdentity: vi.fn(async () => undefined),
          renew: vi.fn(async () => undefined),
          release,
        })),
      },
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream: vi.fn(async () => ownedLocalAgent(new PassThrough(), stop)),
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: canonicalLocalRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);
    await controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    });

    await expect(controller.shutdown()).rejects.toMatchObject({ errors: [cleanupFailure] });
    expect(release).not.toHaveBeenCalled();

    failStop = false;
    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
    await rm(localRoot, { recursive: true, force: true });
  });

  it('rejects a local endpoint when the filesystem object no longer matches its held fence', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-root-'));
    const localRoot = join(fixture, 'workspace');
    await mkdir(localRoot);
    const openLocalWorkspaceAgentStream = vi.fn(async () => ownedLocalAgent());
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      openLocalWorkspaceAgentStream,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: localRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    await controller.ensure(definition);
    await rename(localRoot, `${localRoot}-old`);
    await mkdir(localRoot);

    await expect(controller.openExternalStream({
      endpointId: deriveWorkspaceSyncEndpointId('r1', 'alpha'),
    })).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
    expect(openLocalWorkspaceAgentStream).not.toHaveBeenCalled();
    await controller.shutdown();
    await rm(fixture, { recursive: true, force: true });
  });

  it('wakes and closes a status subscription immediately when its signal aborts', async () => {
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: () => null,
    });
    const abort = new AbortController();
    const iterator = controller.subscribe('r1', abort.signal)[Symbol.asyncIterator]();
    const waiting = iterator.next();
    abort.abort();

    await expect(Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 100)),
    ])).resolves.toEqual({ done: true, value: undefined });
  });

  it('observes engine-only status changes while subscribed and stops observing after abort', async () => {
    let observedStatus = status;
    const get = vi.fn(async () => observedStatus);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ get }),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
    });
    await controller.ensure(definition);

    const abort = new AbortController();
    const iterator = controller.subscribe('r1', abort.signal)[Symbol.asyncIterator]();
    observedStatus = { ...status, state: 'conflicted', conflictCount: 1 };

    await expect(Promise.race([
      iterator.next(),
      new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 100)),
    ])).resolves.toEqual({
        done: false,
        value: { ...status, state: 'conflicted', conflictCount: 1 },
    });

    const waiting = iterator.next();
    abort.abort();
    await expect(waiting).resolves.toEqual({ done: true, value: undefined });
    const callsAfterAbort = get.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(get).toHaveBeenCalledTimes(callsAfterAbort);
    await controller.shutdown();
  });

  it('publishes engine-only status changes for enabled production relationships and stops on shutdown', async () => {
    let observedStatus = status;
    const get = vi.fn(async () => observedStatus);
    const published: WorkspaceSyncStatusV1[] = [];
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ get }),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
      onStatusPublished: (next) => published.push(next),
    });
    await controller.ensure(definition);
    await Promise.resolve();
    published.length = 0;

    observedStatus = { ...status, state: 'disconnected' };
    await vi.waitFor(() => expect(published).toEqual([{ ...status, state: 'disconnected' }]), { timeout: 2_000 });

    await controller.shutdown();
    const callsAfterShutdown = get.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(get).toHaveBeenCalledTimes(callsAfterShutdown);
  });

  it('preserves the last known status across a transient observation failure and publishes recovery', async () => {
    const recovered = { ...status, state: 'conflicted' as const, conflictCount: 1 };
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('manager temporarily unavailable'))
      .mockResolvedValue(recovered);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ get }),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
    });
    await controller.ensure(definition);

    const abort = new AbortController();
    const iterator = controller.subscribe('r1', abort.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: recovered });
    expect(get).toHaveBeenCalledTimes(2);

    abort.abort();
    await iterator.next();
    await controller.shutdown();
  });

  it('serializes status observation behind an in-flight relationship command', async () => {
    let releasePause!: () => void;
    const pauseGate = new Promise<void>((resolve) => { releasePause = resolve; });
    let pauseStarted!: () => void;
    const pauseDidStart = new Promise<void>((resolve) => { pauseStarted = resolve; });
    const pause = vi.fn(async () => {
      pauseStarted();
      await pauseGate;
      return { ...status, state: 'paused' as const };
    });
    const get = vi.fn(async () => ({ ...status, state: 'conflicted' as const, conflictCount: 1 }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ pause, get }),
      lifecycle: lifecycle(),
      rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1',
      resolveWorkspaceRef: fixtureWorkspaceRef,
    });
    await controller.ensure(definition);

    const pausing = controller.pause('r1');
    await pauseDidStart;
    const abort = new AbortController();
    const iterator = controller.subscribe('r1', abort.signal)[Symbol.asyncIterator]();
    const observing = iterator.next();
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();

    releasePause();
    await expect(pausing).resolves.toMatchObject({ state: 'paused' });
    await expect(observing).resolves.toMatchObject({
      done: false,
      value: { state: 'paused' },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { state: 'conflicted', conflictCount: 1 },
    });
    abort.abort();
    await iterator.next();
    await controller.shutdown();
  });


  it('routes bounded file reads to the selected authenticated WorkspaceRef without sending a root path', async () => {
    const readFileAtTarget = vi.fn(async () => ({
      status: 'text' as const, text: 'hello', digest: 'd'.repeat(40), size: 5,
    }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', readFileAtTarget,
      resolveWorkspaceRef: (id) => ({ machineId: id === 'a' ? 'm1' : 'm2', rootPath: `/${id}` }),
    });
    await controller.ensure(definition);

    await expect(controller.readFile({
      relationshipId: 'r1', side: 'beta', path: 'src/file.ts',
      expectedDigest: 'cccccccccccccccccccccccccccccccccccccccc', maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'text', text: 'hello' });

    expect(readFileAtTarget).toHaveBeenCalledWith({
      relationshipId: 'r1', targetMachineId: 'm2', targetWorkspaceRefId: 'b',
      path: 'src/file.ts', expectedDigest: 'cccccccccccccccccccccccccccccccccccccccc', maxBytes: 1024, signal: undefined,
    });
    await controller.terminate('r1');
  });

  it('reads the fenced local source directly while the target preview remains on target authority', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-source-preview-'));
    const sourceRoot = join(fixture, 'source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'source.txt'), 'source bytes');
    const readFileAtTarget = vi.fn(async () => ({
      status: 'text' as const, text: 'target bytes', digest: 'target-digest', size: 12,
    }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      readFileAtTarget,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definition);

      const [sourcePreview, targetPreview] = await Promise.all([
        controller.readFile({ relationshipId: 'r1', side: 'alpha', path: 'source.txt', maxBytes: 1024 }),
        controller.readFile({ relationshipId: 'r1', side: 'beta', path: 'target.txt', maxBytes: 1024 }),
      ]);

      expect(sourcePreview).toMatchObject({ status: 'text', text: 'source bytes' });
      expect(targetPreview).toMatchObject({ status: 'text', text: 'target bytes' });
      expect(readFileAtTarget).toHaveBeenCalledOnce();
      expect(readFileAtTarget).toHaveBeenCalledWith(expect.objectContaining({
        relationshipId: 'r1', targetMachineId: 'm2', targetWorkspaceRefId: 'b', path: 'target.txt',
      }));
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('fails a local source preview closed when the fenced root object is replaced before access', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-controller-source-preview-fence-'));
    const sourceRoot = join(fixture, 'source');
    const retainedRoot = join(fixture, 'retained-source');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'source.txt'), 'retained bytes');
    const readFileAtTarget = vi.fn(async () => ({ status: 'missing' as const }));
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter(),
      lifecycle: lifecycle(),
      rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      localMachineId: 'm1',
      readFileAtTarget,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: sourceRoot }
        : { machineId: 'm2', rootPath: '/remote/b' },
    });
    try {
      await controller.ensure(definition);
      await rename(sourceRoot, retainedRoot);
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, 'source.txt'), 'replacement bytes');

      await expect(controller.readFile({
        relationshipId: 'r1', side: 'alpha', path: 'source.txt', maxBytes: 1024,
      })).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      expect(readFileAtTarget).not.toHaveBeenCalled();
    } finally {
      await controller.shutdown();
      await rm(fixture, { recursive: true, force: true });
    }
  });


  it('fail-closes every state-touching entry point with the exact typed legacy-state code', async () => {
    for (const code of ['legacy_workspace_sync_state_unsupported', 'legacy_workspace_sync_state_unknown'] as const) {
      const adapter = completeAdapter();
      const lifecycle = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
      const controller = new WorkspaceSyncController({
        adapter, lifecycle, rootOwnershipManager: rootOwnership(), localMachineId: 'm1',
        resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
        assertLegacyStateAvailable: () => { throw Object.assign(new Error('legacy workspace sync state'), { code }); },
      });
      const expectTyped = (run: Promise<unknown>) => expect(run).rejects.toMatchObject({ code });
      await expectTyped(controller.get('r1'));
      await expectTyped(controller.list());
      await expectTyped(controller.ensure(definition));
      await expectTyped(controller.copyOnce({
        v: 1, operationId: 'op-1', controllerMachineId: 'm1', alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b',
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      }));
      await expectTyped(controller.flush('r1'));
      await expectTyped(controller.pause('r1'));
      await expectTyped(controller.resume('r1'));
      await expectTyped(controller.terminate('r1'));
      await expectTyped(controller.listConflicts({ relationshipId: 'r1', limit: 100 }));
      await expectTyped(controller.readFile({ relationshipId: 'r1', side: 'beta', path: 'src/x.ts', maxBytes: 64 }));
      await expectTyped(controller.rehydrateFromSettings([definition]));
      await expectTyped(controller.openExternalStream({ endpointId: deriveWorkspaceSyncEndpointId('r1', 'beta') }));
      // No engine command, lifecycle start, or target RPC may have run.
      expect(lifecycle.start).not.toHaveBeenCalled();
      for (const method of ['rehydrate', 'ensure', 'copyOnce', 'get', 'list', 'flush', 'pause', 'resume', 'terminate', 'listConflicts'] as const) {
        expect(adapter[method]).not.toHaveBeenCalled();
      }
    }
  });

  it('keeps current behavior when the availability assertion passes', async () => {
    const ensure = vi.fn(async () => status);
    const controller = new WorkspaceSyncController({
      adapter: completeAdapter({ ensure }), lifecycle: lifecycle(), rootOwnershipManager: rootOwnership(),
      localMachineId: 'm1', resolveWorkspaceRef: (id) => ({ machineId: 'm1', rootPath: `/${id}` }),
      assertLegacyStateAvailable: () => undefined,
    });
    await controller.ensure(definition);
    expect(ensure).toHaveBeenCalledOnce();
    await controller.terminate('r1');
  });
});

describe('WorkspaceSyncController copy_once restart recovery', () => {
  it('does not commit recovered target custody from historical cycles when the finite result has problems', async () => {
    const operation = {
      v: 1 as const, operationId: 'copy-restart-problem', controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };
    let discoveryCount = 0;
    const adapter = completeAdapter({
      discoverCopyOnceRecoveries: vi.fn(async () => (++discoveryCount === 1 ? [operation] : [])),
      copyOnce: vi.fn(async () => ({
        ...status,
        relationshipId: operation.operationId,
        mode: 'copy_once' as const,
        state: 'error' as const,
        endpointStates: {
          ...status.endpointStates,
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 1 },
        },
      })),
      rehydrate: vi.fn(async () => []),
    });
    const releaseTarget = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(), localMachineId: 'm1', rootOwnershipManager: rootOwnership(),
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      recoverCopyOnceTarget: vi.fn(async () => ({ release: releaseTarget })),
    });

    await expect(controller.rehydrateFromSettings([])).rejects.toMatchObject({ code: 'workspace_sync_not_clean' });
    expect(releaseTarget).toHaveBeenCalledWith('abort');
    expect(releaseTarget).not.toHaveBeenCalledWith('commit');
  });

  it('reacquires exact roots and target authority before settling the same persisted operation', async () => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const operation = {
      v: 1 as const,
      operationId: 'copy-restart-1',
      controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a',
      betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };
    const copyOnce = vi.fn(async () => ({
      ...status,
      relationshipId: operation.operationId,
      mode: 'copy_once' as const,
    }));
    let discoveryCount = 0;
    const adapter = completeAdapter({
      discoverCopyOnceRecoveries: vi.fn(async () => {
        discoveryCount += 1;
        return discoveryCount === 1 ? [operation] : [];
      }),
      copyOnce,
      rehydrate: vi.fn(async () => []),
    });
    const releaseTarget = vi.fn(async () => undefined);
    const recoverCopyOnceTarget = vi.fn(async () => ({ release: releaseTarget }));
    const ownership = rootOwnership();
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      localMachineId: 'm1',
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      rootOwnershipManager: ownership,
      recoverCopyOnceTarget,
    });

    await expect(controller.rehydrateFromSettings([])).resolves.toEqual([]);

    expect(ownership.tryAcquire).toHaveBeenCalledWith({
      ownerId: operation.operationId,
      canonicalRoot: '/a',
      operation: 'sync',
    });
    expect(recoverCopyOnceTarget).toHaveBeenCalledWith(operation);
    expect(copyOnce).toHaveBeenCalledWith(operation);
    expect(releaseTarget).toHaveBeenCalledWith('commit');
    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(adapter.rehydrate).toHaveBeenCalledWith([], undefined, new Set());
  });

  it('retains recovered root and target fences until terminal cleanup succeeds', async () => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const operation = {
      v: 1 as const, operationId: 'copy-restart-pending', controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };
    let discoveryCount = 0;
    const adapter = completeAdapter({
      discoverCopyOnceRecoveries: vi.fn(async () => {
        discoveryCount += 1;
        return discoveryCount === 1 ? [operation] : [];
      }),
      copyOnce: vi.fn(async () => ({ ...status, relationshipId: operation.operationId, mode: 'copy_once' as const })),
      rehydrate: vi.fn(async () => []),
    });
    const releaseRoot = vi.fn(async () => undefined);
    const rootOwnershipManager = {
      tryAcquire: vi.fn(async (owner) => ({
        owner: { ...owner, rootFingerprint: null },
        assertCurrentRootIdentity: async () => undefined,
        bindCurrentRootIdentity: vi.fn(async () => undefined),
        release: releaseRoot,
      })),
    };
    let targetReleaseAttempts = 0;
    const releaseTarget = vi.fn(async () => {
      targetReleaseAttempts += 1;
      if (targetReleaseAttempts === 1) throw new Error('target release unavailable');
    });
    const recoverCopyOnceTarget = vi.fn(async () => ({ release: releaseTarget }));
    const controller = new WorkspaceSyncController({
      adapter, lifecycle: lifecycle(), localMachineId: 'm1', rootOwnershipManager,
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      recoverCopyOnceTarget,
    });

    await expect(controller.rehydrateFromSettings([])).rejects.toMatchObject({ code: 'indeterminate' });
    expect(releaseRoot).not.toHaveBeenCalled();
    await expect(controller.rehydrateFromSettings([])).resolves.toEqual([]);
    expect(recoverCopyOnceTarget).toHaveBeenCalledTimes(1);
    expect(releaseTarget).toHaveBeenCalledTimes(2);
    expect(releaseRoot).toHaveBeenCalledTimes(1);
  });

  it('retains a failed copy target shutdown release for a later shutdown retry', async () => {
    const operation = {
      v: 1 as const, operationId: 'copy-shutdown-pending', controllerMachineId: 'm1',
      alphaWorkspaceRefId: 'a', betaWorkspaceRefId: 'b',
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
    };
    const adapter = completeAdapter({
      discoverCopyOnceRecoveries: vi.fn(async () => [operation]),
      copyOnce: vi.fn(async () => {
        throw Object.assign(new Error('copy result unknown'), { code: 'indeterminate' });
      }),
      rehydrate: vi.fn(async () => []),
    });
    const targetFailure = new Error('target release unavailable');
    const releaseTarget = vi.fn()
      .mockRejectedValueOnce(targetFailure)
      .mockResolvedValueOnce(undefined);
    const releaseRoot = vi.fn(async () => undefined);
    const controller = new WorkspaceSyncController({
      adapter,
      lifecycle: lifecycle(),
      localMachineId: 'm1',
      rootOwnershipManager: { tryAcquire: vi.fn(async (owner) => ({
        owner: { ...owner, rootFingerprint: null },
        assertCurrentRootIdentity: async () => undefined,
        bindCurrentRootIdentity: vi.fn(async () => undefined),
        release: releaseRoot,
      })) },
      resolveWorkspaceRef: (id) => id === 'a'
        ? { machineId: 'm1', rootPath: '/a' }
        : { machineId: 'm2', rootPath: '/b' },
      recoverCopyOnceTarget: vi.fn(async () => ({ release: releaseTarget })),
    });

    await expect(controller.rehydrateFromSettings([])).rejects.toMatchObject({ code: 'indeterminate' });
    await expect(controller.shutdown()).rejects.toMatchObject({ errors: [targetFailure] });
    expect(releaseTarget).toHaveBeenCalledOnce();
    expect(releaseRoot).toHaveBeenCalledOnce();

    await expect(controller.shutdown()).resolves.toBeUndefined();
    expect(releaseTarget).toHaveBeenCalledTimes(2);
    expect(releaseRoot).toHaveBeenCalledOnce();
  });
});

function completeAdapter(overrides: Record<string, unknown> = {}) {
  return {
    discoverCopyOnceRecoveries: vi.fn(async () => []), rehydrate: vi.fn(async () => [status]), ensure: vi.fn(async () => status), copyOnce: vi.fn(async () => status), get: vi.fn(async () => status),
    list: vi.fn(async () => [status]), flush: vi.fn(async () => status), pause: vi.fn(async () => status),
    resume: vi.fn(async () => status), terminate: vi.fn(async () => undefined),
    listConflicts: vi.fn(async () => ({ status: 'page' as const, relationshipId: 'r1', totalCount: 0, nextCursor: null, conflicts: [] })),
    diagnoseSelection: vi.fn(async () => ({ status: 'unknown' as const, reason: 'selection_unavailable' as const })),
    ...overrides,
  };
}

function lifecycle() { return { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }; }
function rootOwnership() {
  return { tryAcquire: vi.fn(async (owner) => ({
    owner: { ...owner, rootFingerprint: null },
    assertCurrentRootIdentity: async () => undefined,
    bindCurrentRootIdentity: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  })) };
}
