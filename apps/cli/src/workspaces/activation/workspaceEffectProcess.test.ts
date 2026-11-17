import { Duplex, PassThrough } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runWorkspaceEffectWorker } from './workspaceEffectWorker';
import { runWorkspaceEffectChannel } from './workspaceEffectProcess';
import { startPrivateProjectSyncChannel } from './privateProjectCheckoutProcess';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import type { MaterializedProjectCheckout } from './materializeProjectCheckout';

it('performs the canonical checkout through an admitted native byte channel', async () => {
  await withTempDir('native-workspace-channel-', async workspaceRoot => {
    const rootPath = join(workspaceRoot, 'checkout');
    await mkdir(rootPath);
    const input = new PassThrough();
    const output = new PassThrough();
    const channel = Duplex.from({ readable: output, writable: input });
    const signal = new AbortController().signal;
    const worker = runWorkspaceEffectWorker([], { input, output, signal, currentDirectory: () => workspaceRoot })
      .finally(() => output.end());
    let result: MaterializedProjectCheckout | undefined;
    let failure: unknown;
    const outcome = await runWorkspaceEffectChannel({ channel, signal, id: 'checkout',
      effect: { workspaceRoot, workspaceRefId: 'checkout', existingRootPath: rootPath, generation: 1, plugins: [], contributions: {},
        request: { serverId: 'home', machineId: 'controller', source: { kind: 'workspace', workspaceId: 'source' }, materialization: { kind: 'attach' } } },
      services: { onEffectsIssued: async () => {}, complete: async (value: MaterializedProjectCheckout) => { result = value; },
        fail: async (error: Error) => { failure = error; } }, refusal: code => new Error(code) });
    await worker;
    expect(failure).toBeUndefined();
    expect(outcome).toEqual({ settled: true, exitedCleanly: true });
    expect(result).toMatchObject({ rootPath, directory: rootPath });
  });
});


it.each(['keep_synced', 'keep_both_in_sync'] as const)('keeps native bootstrap and file reads in the retained framed worker (%s)', async mode => {
  await withTempDir('native-sync-channel-', async home => {
    const workspaceRoot = join(home, 'workspaces');
    const targetRoot = join(workspaceRoot, 'stable-root-hash');
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, 'kept.txt'), 'guest bytes');
    const controller = { machineId: 'controller', installationId: 'installation' };
    const target = { v: 2 as const, kind: 'managed' as const, id: 'guest-workspace-ref', serverId: 'home',
      managedId: 'sandbox', controller, rootPath: targetRoot, createdAtMs: 1 };
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const relationship = { v: 1 as const, relationshipId: 'native-relationship', controllerMachineId: controller.machineId,
      alphaWorkspaceRefId: 'host', betaWorkspaceRefId: target.id, mode, contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'host', serverId: 'home', machineId: controller.machineId, rootPath: targetRoot, createdAtMs: 1 }, target],
      relationships: [relationship], organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 1, scopeKey: 'requester' };
    const input = new PassThrough(), output = new PassThrough();
    const channel = Duplex.from({ readable: output, writable: input });
    const lifetime = new AbortController();
    const worker = runWorkspaceEffectWorker([], { input, output, signal: lifetime.signal, currentDirectory: () => workspaceRoot })
      .finally(() => output.end());
    const native = await startPrivateProjectSyncChannel({ channel, signal: lifetime.signal, memberHome: home,
      effect: { workspaceRoot, workspaceRefId: target.id, existingRootPath: targetRoot, generation: 1, plugins: [], contributions: {},
        request: { serverId: 'home', machineId: controller.machineId, source: { kind: 'workspace', workspaceId: 'host' },
          materialization: { kind: 'sync', targetPath: targetRoot, workspaceAction: { kind: 'copy_once', contentPolicy } } } },
      configuration: { serverId: 'home', machineId: controller.machineId, accountId: 'member', snapshot,
        localManagedTarget: { managedId: target.managedId, controller }, agent: { executablePath: '/verified/guest-agent' } },
      network: { callMachineRpc: async () => { throw new Error('The host root is not a local guest source'); },
        refreshProjectSnapshot: async () => snapshot, prepareSourceSeed: async () => { throw new Error('The existing guest copy must be retained'); } },
      onEffectsIssued() {},
    });
    try {
      expect(native.agentExecutablePath).toBe('/verified/guest-agent');
      const bootstrap = await native.prepareBootstrapAtTarget({ v: 1, bootstrapOperationId: relationship.relationshipId,
        owner: { kind: 'relationship', relationshipId: relationship.relationshipId }, targetWorkspaceRefId: target.id,
        targetMachineId: controller.machineId, endpointRole: 'beta', policyDigest: contentPolicy.policyDigest,
        transientRelationship: relationship, createIfMissing: false, targetBootstrap: 'use_existing' });
      expect(bootstrap).toMatchObject({ state: 'ready', created: false });
      expect(await native.readFileHere({ relationshipId: relationship.relationshipId, workspaceRefId: target.id, path: 'kept.txt', maxBytes: 1024 }))
        .toMatchObject({ status: 'text', text: 'guest bytes' });
      await expect(native.readFileHere({ relationshipId: relationship.relationshipId, workspaceRefId: 'host', path: 'kept.txt', maxBytes: 1024 }))
        .rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
    } finally { await native.dispose(); await worker; }
  });
});
