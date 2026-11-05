import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { readAgentLaunchFrame } from '@/daemon/agentIsolation/agentLaunchFrame';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import { materializePrivateProjectCheckoutProcess, startPrivateProjectSyncProcess } from './privateProjectCheckoutProcess';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { runWorkspaceEffectWorker } from './workspaceEffectWorker';
import { workspaceCheckoutNativeBoundary as boundary } from './workspaceCheckoutNative.testkit';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createWorkspaceEffectScmRegistry, prepareWorkspaceCheckoutEffect } from './workspaceEffect';
import { createWorkspaceSyncSeedExport, resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { createDirectTransferServerLifecycle } from '@/machines/transfer/directTransferServerLifecycle';
import { buildDirectPeerTransferEndpointPath } from '@/machines/transfer/directPeerTransport';
import type { PrivateProjectSyncNetwork } from './privateProjectSyncEffect';
import { runNativeConfinedWorkspaceSyncApply } from '@/workspaces/sync/workspaceSyncNativeConfinedFileSystem';

// Genuine filesystem/process boundaries only. The parent authorizer, framed
// launch, supervisor, duplex bridge, child and canonical materializer stay real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { workspaceCheckoutFilesystemBoundary } = await import('./workspaceCheckoutNative.testkit');
  const filesystem = workspaceCheckoutFilesystemBoundary(actual);
  return { ...filesystem, readdir: (...args: Parameters<typeof actual.readdir>) => {
    if (String(args[0]).endsWith('/workspace-sync/resolution')) {
      expect(boundary.identity.getStore()).toBe('member');
      boundary.phases.push('resolution-member');
    }
    return Reflect.apply(filesystem.readdir, filesystem, args);
  } };
});

it.skipIf(process.platform !== 'linux').each(['empty', 'same_machine', 'local_git', 'remote_git', 'linked_loan', 'source_traversal'] as const)('keeps private Sync bootstrap and rooted ingress in the admitted member child (%s)', async mode => {
  await withTempDir('private-sync-process-', async workspaceRoot => {
    const seed = mode === 'local_git' || mode === 'remote_git';
    const rootPath = join(workspaceRoot, 'accepted-checkout');
    const sourceId = mode === 'source_traversal' ? '../foreign' : 'source';
    const sourceRoot = join(workspaceRoot, sourceId);
    const sourceMachineId = mode === 'local_git' || mode === 'same_machine' || mode === 'source_traversal' ? 'machine' : 'source-machine';
    if (mode === 'same_machine') { await mkdir(sourceRoot); await writeFile(join(sourceRoot, 'seed.txt'), 'member source'); }
    if (seed) {
      await mkdir(sourceRoot); await writeFile(join(sourceRoot, 'seed.txt'), 'member seed');
      const git = promisify(execFile);
      await git('git', ['init', '-b', 'main'], { cwd: sourceRoot });
      await git('git', ['add', '.'], { cwd: sourceRoot });
      await git('git', ['-c', 'user.name=Native Sync test', '-c', 'user.email=native@example.invalid', 'commit', '-m', 'initial'], { cwd: sourceRoot });
    }
    boundary.privateRoot = rootPath;
    if (mode === 'same_machine') boundary.privateRoots = [sourceRoot];
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
      requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'canonical-home' }),
      workspaceRoot, home: workspaceRoot, agentUid: 2401, agentGid: 2401 };
    const snapshot = { enabled: true, status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const },
      workspaceRoots: [workspaceRoot], memberIdentity, localTransport: { agentUid: 2401, agentGid: 2401 },
      launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        runtimeHome: join(workspaceRoot, 'runtime'), environment: {}, selectedEnvironmentKeys: [], selectedMaterials: [] } };
    const policyInput = { v: 1 as const, selection: seed ? 'git_worktree' as const : 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const relationship = { v: 1 as const, relationshipId: 'sync-op', controllerMachineId: sourceMachineId,
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'accepted-checkout', mode: 'keep_both_in_sync' as const,
      contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const rows: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: sourceId, serverId: 'canonical-home', machineId: sourceMachineId, rootPath: sourceRoot, createdAtMs: 1 },
      { id: 'accepted-checkout', serverId: 'canonical-home', machineId: 'machine', rootPath, createdAtMs: 1 }],
      relationships: mode === 'linked_loan' ? [relationship] : [], organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 1, scopeKey: 'requester' };
    let sourceRegistry: Awaited<ReturnType<typeof createWorkspaceEffectScmRegistry>> | undefined;
    const transfers = mode === 'remote_git' ? createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] }) : null;
    boundary.launch = async (input, output) => {
      const frame = await readAgentLaunchFrame(input);
      expect(frame.nativeIdentity?.agentUid).toBe(2401);
      await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal, currentDirectory: () => workspaceRoot });
    };
    let effectsIssued = 0;
    const nativeInput = {
      prepared: { workspaceRefId: 'accepted-checkout', rootPath, destinationParentPath: workspaceRoot, destinationDirectoryName: 'accepted-checkout' },
      memberRoot: { identity: memberIdentity, workspaceRoot, daemonGid: 2400 },
      effect: { workspaceRefId: 'accepted-checkout', workspaceRoot, generation: 1, plugins: [], contributions: {},
        request: { serverId: 'canonical-home', machineId: 'machine', source: { kind: 'workspace', workspaceId: sourceId },
          materialization: { kind: 'sync', targetPath: rootPath, workspaceAction: { kind: 'copy_once', contentPolicy } } } },
      configuration: { serverId: 'canonical-home', machineId: 'machine', accountId: 'member', snapshot: rows,
        agent: { executablePath: '/verified/mutagen-agent' } },
      network: { callMachineRpc: async () => { throw new Error('No remote operation expected'); },
        refreshProjectSnapshot: async () => rows,
        prepareSourceSeed: async (request: Parameters<PrivateProjectSyncNetwork['prepareSourceSeed']>[0]): ReturnType<PrivateProjectSyncNetwork['prepareSourceSeed']> => {
          if (!transfers || !sourceRegistry) throw new Error('Only the remote Git target needs a seed');
          const exported = await createWorkspaceSyncSeedExport({ operationId: request.operationId, sourcePath: sourceRoot,
            activeServerDir: join(workspaceRoot, 'source-export'), workspaceTransfer: resolveWorkspaceSyncSeedTransfer(contentPolicy), registry: sourceRegistry.registry });
          if (exported.payloadSource.sizeBytes === undefined || exported.payloadSource.manifestHash === undefined) {
            throw new Error('Native Sync seed fixture requires a measured payload size and manifest hash');
          }
          const published = await transfers.publishTransferWhenReady({ transferId: request.operationId, ...exported });
          return { transferId: request.operationId, sizeBytes: exported.payloadSource.sizeBytes, manifestHash: exported.payloadSource.manifestHash,
            openPayload: async ({ transferId }) => ({ endpointCandidates: published.endpointCandidates.map(candidate => candidate.kind === 'http'
              ? { ...candidate, url: new URL(buildDirectPeerTransferEndpointPath(transferId), candidate.url).toString() } : candidate), dispose: async () => {} }),
            dispose: async () => { transfers.clearPublishedTransfer(request.operationId); } };
        } },
      launch: { requesterIdentity, agentIsolation: { read: () => snapshot }, signal: new AbortController().signal, assertCurrent() {} },
      managedHappierBinaryPath: '/opt/happier/cli/current/happier', verifyCurrent: async () => {}, onEffectsIssued() { effectsIssued += 1; },
    } satisfies Parameters<typeof startPrivateProjectSyncProcess>[0];
    const pluginFixture = seed ? await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } }) : null;
    if (pluginFixture) Object.assign(nativeInput, await prepareWorkspaceCheckoutEffect({ request: nativeInput.effect.request,
      workspaceRefId: nativeInput.prepared.workspaceRefId, workspaceRoot, registry: pluginFixture.registry }));
    if (mode === 'remote_git') sourceRegistry = await createWorkspaceEffectScmRegistry(nativeInput.effect,
      { signal: new AbortController().signal, onEffectsIssued() {} });
    await expect(startPrivateProjectSyncProcess({ ...nativeInput, launch: { ...nativeInput.launch,
      agentIsolation: { read: () => ({ enabled: true, status: { kind: 'applying', phase: 'runtime_replacement' }, workspaceRoots: [workspaceRoot] }) },
    } })).rejects.toMatchObject({ code: 'agent_isolation_unavailable', execLaunch: 'notStarted' });
    expect(boundary.phases).not.toContain('native_spawn');
    if (mode === 'source_traversal') {
      let unexpected: Awaited<ReturnType<typeof startPrivateProjectSyncProcess>> | undefined;
      try {
        await expect(startPrivateProjectSyncProcess(nativeInput).then(value => { unexpected = value; return value; }))
          .rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
        expect(effectsIssued).toBe(0);
        expect(boundary.runAsUsers).not.toContain('mutagen-member');
        await expect(lstat(rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await unexpected?.dispose(); boundary.completed = true; }
      return;
    }
    const process = await startPrivateProjectSyncProcess(nativeInput);
    try {
      const request = { v: 1 as const, bootstrapOperationId: 'sync-op', owner: mode === 'linked_loan'
        ? { kind: 'relationship' as const, relationshipId: 'sync-op' } : { kind: 'copy_once' as const,
        operation: { v: 1 as const, operationId: 'sync-op', controllerMachineId: sourceMachineId, alphaWorkspaceRefId: 'source',
          betaWorkspaceRefId: 'accepted-checkout', contentPolicy } }, targetWorkspaceRefId: 'accepted-checkout', endpointRole: 'beta' as const,
        policyDigest: contentPolicy.policyDigest, createIfMissing: true,
        ...(mode === 'linked_loan' ? { transientRelationship: relationship } : {}),
        targetBootstrap: seed ? 'materialize_from_source_workspace' as const : 'use_existing' as const };
      const bootstrap = await process.prepareBootstrapAtTarget({ ...request, targetMachineId: 'machine' });
      expect(bootstrap).toMatchObject({ state: 'ready', ...(seed ? {} : { created: true }) });
      expect(bootstrap.ownershipHandles?.[0]?.owner.canonicalRoot).toBe(rootPath);
      await bootstrap.ownershipHandles?.[0]?.bindCurrentRootIdentity();
      if (seed) expect(await boundary.identity.run('member', () => readFile(join(rootPath, 'seed.txt'), 'utf8'))).toBe('member seed');
      await expect(realpath(rootPath)).rejects.toMatchObject({ code: 'EACCES' });
      if (mode === 'local_git') await expect(process.inspectCheckout()).rejects.toMatchObject({ code: 'workspace_private_checkout_required', details: { reason: 'workspace_git_metadata_shared' } });
      else expect(await process.inspectCheckout()).toMatchObject({ rootPath, directory: rootPath });
      await expect(process.prepareBootstrapHere({ ...request, targetWorkspaceRefId: 'source' })).rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
      if (mode === 'same_machine') {
        const resolutionDirectory = join(workspaceRoot, '.happier', 'workspace-sync', 'resolution');
        const orphanStage = join(resolutionDirectory, 'stage-orphan');
        await mkdir(orphanStage, { recursive: true });
        await writeFile(join(orphanStage, 'entry'), 'orphan');
        await process.replaceSnapshot({ ...rows, workspaceRefs: [...rows.workspaceRefs,
          { id: 'foreign', serverId: 'canonical-home', machineId: 'machine', rootPath: join(workspaceRoot, 'foreign'), createdAtMs: 1 }],
          relationships: [relationship, { ...relationship, relationshipId: 'foreign-relation', betaWorkspaceRefId: 'foreign' }] });
        for (const targetWorkspaceRefId of ['source', 'accepted-checkout']) {
          expect(await process.recoverConflictResolutionHere({ relationshipId: relationship.relationshipId,
            targetMachineId: 'machine', targetWorkspaceRefId })).toEqual({ status: 'settled' });
        }
        expect(boundary.phases).toContain('resolution-member');
        await expect(lstat(orphanStage)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(process.recoverConflictResolutionHere({ relationshipId: 'foreign-relation', targetMachineId: 'machine',
          targetWorkspaceRefId: 'foreign' })).rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
        expect(await process.borrowSourceRootForCopy({ operationId: 'ordinary-copy', workspaceRefId: 'source' })).toBeNull();
        await expect(realpath(sourceRoot)).rejects.toMatchObject({ code: 'EACCES' });
        expect(await process.resolveLocalRoot(sourceRoot)).toBe(sourceRoot);
        await expect(process.resolveLocalRoot(join(workspaceRoot, 'foreign'))).rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
        const sourceOwnership = await process.acquireLocalRoot({ ownerId: 'sync-op', canonicalRoot: sourceRoot, operation: 'sync' });
        if ('kind' in sourceOwnership) throw new Error('Source root unexpectedly overlapped');
        try {
          await sourceOwnership.bindCurrentRootIdentity();
          const stagedRelationship = { ...relationship, enabled: false };
          await process.replaceSnapshot({ ...rows, relationships: [stagedRelationship] });
          const reviewedPath = join(sourceRoot, 'reviewed.txt');
          const materialPath = join(resolutionDirectory, 'entry');
          await writeFile(reviewedPath, 'original'); await writeFile(materialPath, 'selected');
          const expectedDestination = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
          const selectedExpectation = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
          const interrupted = await boundary.identity.run('member', async () => {
            try { return await runNativeConfinedWorkspaceSyncApply({ rootPath: sourceRoot, relativePath: 'reviewed.txt', expectedDestination,
              selectedExpectation, materialPath, recoveryDirectory: resolutionDirectory, operationId: 'interrupted-source',
              assertCurrentAuthority: async () => { await chmod(sourceRoot, 0o500); } }); }
            finally { await chmod(sourceRoot, 0o700); }
          });
          expect(interrupted.status).toBe('recovery_needed');
          const recoveryRequest = { relationshipId: stagedRelationship.relationshipId, targetMachineId: 'machine', targetWorkspaceRefId: 'source' };
          const borrowedAccess = { relationship: stagedRelationship, canonicalRoot: sourceRoot,
            assertCurrentAuthority: async () => { await sourceOwnership.assertCurrentRootIdentity(sourceOwnership.owner.rootFingerprint!); } };
          await expect(process.recoverConflictResolutionHere(recoveryRequest)).rejects.toMatchObject({ code: 'relationship_not_ready' });
          expect(await process.recoverConflictResolutionHere(recoveryRequest, undefined, { localResolutionEndpoint: borrowedAccess })).toEqual({ status: 'settled' });
          await expect(process.recoverConflictResolutionHere(recoveryRequest, undefined,
            { localResolutionEndpoint: { ...borrowedAccess, relationship: { ...stagedRelationship, controllerMachineId: 'other-controller' } } }))
            .rejects.toMatchObject({ code: 'relationship_not_ready' });
          await expect(process.recoverConflictResolutionHere(recoveryRequest, undefined,
            { localResolutionEndpoint: { ...borrowedAccess, canonicalRoot: join(workspaceRoot, 'foreign') } }))
            .rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
          await expect(lstat(join(resolutionDirectory, 'workspace-recovery-interrupted-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(reviewedPath, 'utf8')).toBe('original');
          expect(boundary.runAsUsers).toContain('recovery-member');
          await process.replaceSnapshot({ ...rows, relationships: [relationship] });
          const sourceIngress = await process.openLocalWorkspaceAgentIngress({ operationId: 'sync-op', role: 'alpha', workspaceRefId: 'source', canonicalRoot: sourceRoot });
          const sourceSocket = connect(sourceIngress.port, '127.0.0.1');
          try {
            await once(sourceSocket, 'connect'); const echoed = once(sourceSocket, 'data');
            sourceSocket.write(Buffer.from(`${sourceIngress.localCapability}source-bytes`));
            expect(String((await echoed)[0])).toBe('source-bytes');
            expect(boundary.runAsUsers).toContain(`mutagen-member:${sourceRoot}`);
          } finally { sourceSocket.destroy(); await sourceIngress.close(); }
        } finally { await sourceOwnership.release(); }
      }
      const ingress = await process.acquireWorkspaceSyncMachineIngress({ operationId: 'sync-op', sourceMachineId, targetMachineId: 'machine' });
      const socket = connect(ingress.port, '127.0.0.1');
      try {
        await once(socket, 'connect');
        const echoed = once(socket, 'data');
        socket.write(Buffer.from(`${ingress.localCapability}member-bytes`));
        expect(String((await echoed)[0])).toBe('member-bytes');
        expect(boundary.runAsUsers).toContain('mutagen-member');
      } finally { socket.destroy(); await ingress.close(); }
      await expect(process.replaceSnapshot({ ...rows, workspaceRefs: rows.workspaceRefs.map(ref => ref.id === 'accepted-checkout'
        ? { ...ref, rootPath: join(workspaceRoot, 'other-checkout') } : ref) })).rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
      if (mode === 'linked_loan') {
        await process.releaseBootstrapHere({ v: 1, bootstrapOperationId: 'sync-op', targetWorkspaceRefId: 'accepted-checkout', reason: 'relationship_committed' });
        const loan = await process.borrowSourceRootForCopy({ operationId: 'copy-from-spoke', workspaceRefId: 'accepted-checkout' });
        expect(loan).not.toBeNull();
        if (!loan) throw new Error('Committed spoke did not lend its root');
        try {
          await process.replaceSnapshot({ ...rows, relationships: [] });
          await process.reconcileRetainedBootstraps();
          expect(await process.acquireLocalRoot({ ownerId: 'contender', canonicalRoot: rootPath, operation: 'sync' })).toMatchObject({ kind: 'overlap' });
          await loan.handle.assertCurrentRootIdentity(loan.handle.owner.rootFingerprint!);
        } finally { await loan.release(); }
        const available = await process.acquireLocalRoot({ ownerId: 'after-loan', canonicalRoot: rootPath, operation: 'sync' });
        expect(available).not.toHaveProperty('kind');
        if (!('kind' in available)) await available.release();
        await process.replaceSnapshot(null);
      } else {
        await process.replaceSnapshot(null);
        expect(await process.releaseBootstrapHere({ v: 1, bootstrapOperationId: 'sync-op', targetWorkspaceRefId: 'accepted-checkout', reason: 'abort' }))
          .toEqual({ ok: true, released: true });
      }
    } finally { await process.dispose(); await transfers?.stop(); await sourceRegistry?.dispose(); await pluginFixture?.dispose(); boundary.completed = true; }
    expect(boundary.childFailure).toBeUndefined();
  });
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { spawnWorkspaceCheckoutNativeBoundary } = await import('./workspaceCheckoutNative.testkit');
  return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
    if (args[0]?.startsWith('workspace-confined-')) {
      expect(boundary.identity.getStore()).toBe('member');
      boundary.runAsUsers.push('recovery-member');
      return actual.spawn(command, args, options);
    }
    if (command === 'git' || command.endsWith('/git')) {
      if (String(options.cwd).startsWith(boundary.privateRoot)) expect(boundary.identity.getStore()).toBe('member');
      if (boundary.identity.getStore() === 'member') boundary.runAsUsers.push('git-member');
      return actual.spawn(command, args, options);
    }
    const agentIndex = args.indexOf('/verified/mutagen-agent');
    if (command === '/verified/mutagen-agent' || agentIndex !== -1) {
      expect(boundary.identity.getStore()).toBe('member');
      const agentArgs = command === '/verified/mutagen-agent' ? args : args.slice(agentIndex + 1);
      expect(agentArgs.slice(0, 3)).toEqual(['synchronizer', '--external', '--root']);
      expect([boundary.privateRoot, ...boundary.privateRoots]).toContain(agentArgs[3]);
      boundary.runAsUsers.push('mutagen-member');
      boundary.runAsUsers.push(`mutagen-member:${agentArgs[3]}`);
      return actual.spawn('/bin/cat', [], options);
    }
    if (command !== 'sudo') throw new Error('Only the member native launch is expected');
    expect(args.slice(0, 2)).toEqual(['-n', '-u']);
    expect(args.slice(-2)).toEqual(['/opt/happier/cli/current/happier', 'agent-launch']);
    return spawnWorkspaceCheckoutNativeBoundary();
  } };
});

afterEach(() => {
  const stalled = boundary.phases.length > 0 && !boundary.completed;
  const phases = boundary.phases.join(',');
  boundary.reset();
  if (stalled) throw new Error(`Private checkout fixture did not settle; closed phases: ${phases}`);
});

it.skipIf(process.platform !== 'linux')('accepts member-verified private checkout readback when daemon physical traversal is denied', async () => {
  await withTempDir('private-checkout-process-', async workspaceRoot => {
    const rootPath = join(workspaceRoot, 'accepted-checkout');
    const directory = join(rootPath, 'packages', 'app');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(rootPath, 0o700);
    boundary.privateRoot = rootPath;
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
      requester: { serverId: 'profile', accountId: 'member', machineId: 'machine', installationId: 'installation' } };
    const memberIdentity = { ...deriveAgentIsolationMemberIdentity({ ...requesterIdentity, homeServerIdentityId: 'canonical-home' }),
      workspaceRoot, agentUid: 2401, agentGid: 2401 };
    const snapshot = { enabled: true, status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' as const },
      workspaceRoots: [workspaceRoot], memberIdentity, localTransport: { agentUid: 2401, agentGid: 2401 },
      launch: { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        runtimeHome: join(memberIdentity.home, 'runtime', 'fixture'), environment: {}, selectedEnvironmentKeys: [], selectedMaterials: [] } };
    boundary.launch = async (input, output) => {
      const frame = await readAgentLaunchFrame(input);
      boundary.phases.push('native_frame_decoded');
      expect(frame.nativeIdentity).toEqual({ username: memberIdentity.username, agentUid: 2401, agentGid: 2401, home: memberIdentity.home });
      expect(frame.executable).toBe('/opt/happier/cli/current/happier');
      expect(frame.args).toEqual(['workspace-effect']);
      boundary.phases.push('native_worker_started');
      await runWorkspaceEffectWorker([], { input, output, signal: new AbortController().signal,
        currentDirectory: () => workspaceRoot });
    };
    await expect(realpath(directory)).rejects.toMatchObject({ code: 'EACCES' });
    boundary.phases = [];
    const result = await materializePrivateProjectCheckoutProcess({
      prepared: { workspaceRefId: 'accepted-checkout', rootPath, destinationParentPath: workspaceRoot, destinationDirectoryName: 'accepted-checkout' },
      memberRoot: { identity: memberIdentity, workspaceRoot, daemonGid: 2400 },
      effect: { workspaceRefId: 'accepted-checkout', workspaceRoot, existingRootPath: rootPath, generation: 1, plugins: [], contributions: {},
        request: { serverId: 'canonical-home', machineId: 'machine', source: { kind: 'workspace', workspaceId: 'accepted-checkout' },
          materialization: { kind: 'attach' }, subdir: 'packages/app' } },
      launch: { requesterIdentity, agentIsolation: { read: () => snapshot }, signal: new AbortController().signal, assertCurrent() {} },
      managedHappierBinaryPath: '/opt/happier/cli/current/happier', verifyCurrent: async () => {},
      onEffectsIssued() { throw new Error('Existing checkout acceptance must not clone'); },
    }).finally(() => { boundary.completed = true; });
    expect(boundary.childFailure).toBeUndefined();
    expect(result).toEqual({ rootPath, directory, created: false });
    await expect(realpath(directory)).rejects.toMatchObject({ code: 'EACCES' });
  });
});
