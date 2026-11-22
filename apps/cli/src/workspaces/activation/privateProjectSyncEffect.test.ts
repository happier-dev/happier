import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, deriveWorkspaceSyncConflictOperationId } from '@happier-dev/protocol';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { executePrivateProjectSyncEffect } from './privateProjectSyncEffect';
import { runWorkspaceEffectWorker } from './workspaceEffectWorker';
import { createProductionDaemonWorkspaceSyncRuntime } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { createWorkspaceSyncNativeProcessTestBoundary } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit';
import { createWorkspaceSyncEntryExport } from '@/workspaces/sync/workspaceSyncEntryTransfer';
import { readTransferPayloadChunk, resolveTransferPayloadSizeBytes, resolveTransferPayloadManifestHash } from '@/machines/transfer/transferPayloadSource';
import { createWorkspaceSyncSeedExport } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { createScmBackendRegistry } from '@/scm/registry';
import { restoreSessionTargetRelay } from '@/daemon/spawn/prepareSessionTargetPlacement';
import { createSessionHolderSocketPath } from '@/subprocess/supervision/sessionHolder';
import { resolveSessionTargetWorkspaceTransfer } from '@/daemon/sessions/sessionTargetWorkspaces';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { reconcilePostMaterializationWithScmWorkspace } from '@/scm/workspace/workspacePostMaterialization';
import type { ScmWorkspaceIntegrationWorkspaceTransferMetadata } from '@/scm/workspace/workspaceTransfer';
import { resolveWorkspaceSyncSeedTransfer } from '@/workspaces/sync/workspaceSyncSeedTransfer';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';

it.each([false, true])('reuses a committed native finite seed across admitted child operations while preserving local edits and the original base (Git=%s)', async git => {
  await withTempDir('managed-sync-seed-', async fixture => {
    const parent = await realpath(fixture);
    const sourcePath = join(parent, 'carrier-source'); await mkdir(sourcePath);
    const bytes = Buffer.from([0, 255, 128, 4]); await writeFile(join(sourcePath, 'work.bin'), bytes);
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry(git ? [createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })] : []);
    if (git) {
      await writeFile(join(sourcePath, '.gitignore'), 'ignored.env\n');
      runScmExecutable(sourcePath, 'git', ['init', '-q']);
      runScmExecutable(sourcePath, 'git', ['add', '.']);
      runScmExecutable(sourcePath, 'git', ['-c', 'user.name=Happier Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Original source']);
      await writeFile(join(sourcePath, 'work.bin'), Buffer.from([1, 255, 128, 4]));
      await writeFile(join(sourcePath, 'ignored.env'), 'excluded');
    }
    const root = join(parent, 'native-target');
    const controller = { machineId: 'host', installationId: 'host-installation' };
    const policyInput = { v: 1 as const, selection: 'git_worktree' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const operation = { v: 1 as const, operationId: 'finite-native-seed', controllerMachineId: 'remote',
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'native', contentPolicy,
      ...(git ? { exclusionCandidates: ['ignored.env'] } : {}) };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'source', serverId: 'home', machineId: 'remote', rootPath: '/remote/source', createdAtMs: 1 },
      { id: 'native', serverId: 'home', v: 2, kind: 'managed', managedId: 'guest', controller, rootPath: root, createdAtMs: 1 },
    ], relationships: [], organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'owner' };
    const port = await executePrivateProjectSyncEffect({ kind: 'native_sync', memberHome: parent, checkout: {
      workspaceRefId: 'native', workspaceRoot: parent, existingRootPath: root, generation: 1, plugins: [], contributions: {},
      request: { serverId: 'home', machineId: 'host', source: { kind: 'workspace', workspaceId: 'source' },
        materialization: { kind: 'sync', targetPath: root, workspaceAction: { kind: 'copy_once', contentPolicy } } },
    } }, { serverId: 'home', machineId: 'host', accountId: 'owner', snapshot,
      localManagedTarget: { managedId: 'guest', controller }, agent: { executablePath: '/unused-agent' } }, {
      callMachineRpc: async () => { throw new Error('No Machine RPC expected'); },
      // Controller transport boundary: its SCM owner runs against the admitted target, while the guest has no plugin registry.
      reconcileNativeWorkspaceIntegration: async ({ workspaceIntegrationMetadata }: Readonly<{ workspaceIntegrationMetadata?: ScmWorkspaceIntegrationWorkspaceTransferMetadata }>) =>
        reconcilePostMaterializationWithScmWorkspace({ targetPath: root, workspaceIntegrationMetadata, registry }),
      prepareSourceSeed: async input => {
        if (input.operationId !== operation.operationId) throw new Error('A kept native copy must not reseed or emit another copy phase');
        const exported = await createWorkspaceSyncSeedExport({ operationId: input.operationId, sourcePath, activeServerDir: parent,
          workspaceTransfer: resolveWorkspaceSyncSeedTransfer(contentPolicy,
            input.exclusionCandidates), registry });
        return { transferId: input.operationId, sizeBytes: await resolveTransferPayloadSizeBytes(exported.payloadSource),
          manifestHash: await resolveTransferPayloadManifestHash(exported.payloadSource),
          openPayload: async () => { throw new Error('Guest must not connect to the carrier loopback listener'); },
          resolvePayloadSource: async (request: { transferId: string }) => {
            expect(Object.keys(request)).toEqual(['transferId']);
            const source = request.transferId === input.operationId ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: request.transferId, requestBody: {} });
            return { sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
              readChunk: async (chunk: { offset: number; length: number }) => new Uint8Array(await readTransferPayloadChunk({ source, ...chunk })) };
          }, dispose: async () => { await exported.payloadSource.dispose?.(); } };
      },
    }, { signal: new AbortController().signal, onEffectsIssued() {} });
    try {
      const result = await port.prepareBootstrapHere({ v: 1, bootstrapOperationId: operation.operationId,
        owner: { kind: 'copy_once', operation }, targetWorkspaceRefId: 'native', endpointRole: 'beta',
        policyDigest: contentPolicy.policyDigest, createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' });
      expect(result).toMatchObject({ state: 'ready', copyOnceBaseline: { entries: expect.arrayContaining([expect.objectContaining({ relativePath: 'work.bin' })]) } });
      expect(await readFile(join(root, 'work.bin'))).toEqual(await readFile(join(sourcePath, 'work.bin')));
      if (git) {
        expect(result).toMatchObject({ copyOnceExcludedPaths: ['ignored.env'] });
        expect(runScmExecutable(root, 'git', ['rev-parse', 'HEAD'])).toBe(runScmExecutable(sourcePath, 'git', ['rev-parse', 'HEAD']));
        await expect(readFile(join(root, 'ignored.env'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      await expect(port.releaseBootstrapHere({ v: 1, bootstrapOperationId: operation.operationId,
        targetWorkspaceRefId: 'native', reason: 'copy_committed' })).resolves.toMatchObject({ released: true });
      const edited = Buffer.from([4, 128, 255, 0]);
      await writeFile(join(root, 'work.bin'), edited);
      const nextOperation = { ...operation, operationId: 'another-admitted-native-child' };
      await expect(port.prepareBootstrapHere({ v: 1, bootstrapOperationId: nextOperation.operationId,
        owner: { kind: 'copy_once', operation: nextOperation }, targetWorkspaceRefId: 'native', endpointRole: 'beta',
        policyDigest: contentPolicy.policyDigest, createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' }))
        .resolves.toMatchObject({ state: 'ready', copyOnceBaseline: result.copyOnceBaseline });
      expect(await readFile(join(root, 'work.bin'))).toEqual(edited);
      const processBoundary = createWorkspaceSyncNativeProcessTestBoundary();
      const workers: Promise<void>[] = [];
      let baselineTransportUnavailable = false;
      const token = [Buffer.from('{}').toString('base64url'), Buffer.from('{"sub":"owner"}').toString('base64url'), 'signature'].join('.');
      const runtime = await createProductionDaemonWorkspaceSyncRuntime({ happyHomeDir: join(parent, 'controller-home'),
        activeServerDir: join(parent, 'controller-server'), activeServerId: 'home', localMachineId: controller.machineId,
        releaseChannel: 'publicdev', credentials: { token, encryption: null },
        // Guest process/transport boundary; the finite worker and FinalReady reader stay real.
        openManagedWorkspaceTarget: async () => {
          if (baselineTransportUnavailable) throw Object.assign(new Error('Native baseline transport is unavailable'), { code: 'workspace_sync_unavailable' });
          return { id: 'managed:guest', home: parent,
          platform: { os: 'linux', arch: 'x64', home: parent },
          exec: async () => { throw new Error('Baseline recovery must use the private worker'); },
          putFile: async () => { throw new Error('Baseline recovery must not write guest files'); },
          ensureWorkspaceRuntime: async () => ({ binaryPath: '/guest/happier' }),
          openChannel: (_argv, signal) => {
            const input = new PassThrough(), output = new PassThrough();
            const channel = Duplex.from({ readable: output, writable: input });
            const worker = runWorkspaceEffectWorker([], { input, output, signal, currentDirectory: () => parent })
              .finally(() => output.end());
            workers.push(worker);
            void worker.catch(error => channel.destroy(error));
            return channel;
          },
        }; },
      }, { ...processBoundary.factories, getProjectSnapshot: () => null, subscribeProjectSnapshot: () => () => {},
        resolveRootOwnershipDirectory: () => join(parent, 'controller-locks') });
      try {
        const baselineRequest = { sessionId: 'retained-session', targetWorkspace: { v: 2 as const, kind: 'managed' as const,
          serverId: 'home', workspaceId: 'native', managedId: 'guest', controller, rootPath: root } };
        expect(await runtime.readManagedProjectFilesBaseline({ ...baselineRequest, contentPolicyDigest: contentPolicy.policyDigest }))
          .toEqual(result.copyOnceBaseline);
        expect(await runtime.readManagedProjectFilesBaseline({ ...baselineRequest, contentPolicyDigest: 'f'.repeat(64) })).toBeNull();
        expect(await readFile(join(root, 'work.bin'))).toEqual(edited);
        baselineTransportUnavailable = true;
        const releaseRelay = await restoreSessionTargetRelay({ request: { managedId: 'guest' }, sessionKey: baselineRequest.sessionId,
          requesterAccountId: 'owner', holderVersion: 'test', socketPath: createSessionHolderSocketPath(), readTrustedCallerPid: () => process.pid,
          // Restored Session authority is the provider boundary; the baseline read uses the real finite worker owner above.
          openManagedSessionTarget: async ({ lifetime }) => ({ id: 'managed:guest', lifetime, holderPath: '/guest/holder', helperPath: '/guest/helper',
            socketDirectory: parent, home: parent, platform: { os: 'linux', arch: 'x64', home: parent },
            exec: async () => ({ status: 0, stdout: '', stderr: '' }), putFile: async () => undefined,
            ensureWorkspaceRuntime: async () => ({ binaryPath: '/guest/happier' }), openChannel: () => new PassThrough() }),
          workspace: { sessionId: baselineRequest.sessionId, primarySocketPath: join(parent, 'primary.sock'),
            roots: { hostRoot: '/remote/source', targetRoot: root },
            readBaseline: signal => runtime.readManagedProjectFilesBaseline({ ...baselineRequest, contentPolicyDigest: contentPolicy.policyDigest, signal }) } });
        try {
          expect(releaseRelay).toBeTypeOf('function');
          expect(resolveSessionTargetWorkspaceTransfer(baselineRequest.sessionId)).toMatchObject({
            workspace: { hostRoot: '/remote/source', targetRoot: root }, baseline: null });
        } finally { releaseRelay?.(); }
      } finally { await runtime.stop(); await Promise.all(workers); }
    } finally { await port.dispose(); }
  });
});

it.each([false, true])('inspects the admitted managed root independently of its graph reference id and host source path (Git=%s)', async git => {
  await withTempDir('managed-sync-effect-', async fixture => {
    const parent = await realpath(fixture);
    const root = join(parent, 'stable-native-folder');
    await mkdir(root);
    await writeFile(join(root, 'reviewed.txt'), 'original');
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry(git ? [createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })] : []);
    if (git) {
      runScmExecutable(root, 'git', ['init', '-q']);
      runScmExecutable(root, 'git', ['add', '.']);
      runScmExecutable(root, 'git', ['-c', 'user.name=Happier Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Native checkout']);
    }
    const hostMaterial = join(parent, 'host-capture');
    await writeFile(hostMaterial, 'selected');
    const controller = { machineId: 'host', installationId: 'host-installation' };
    const policy = { v: 1 as const, selection: git ? 'git_worktree' as const : 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'host-ref', serverId: 'home', machineId: 'host', rootPath: '/host/source', createdAtMs: 1 },
      { id: 'graph-native-ref', serverId: 'home', v: 2, kind: 'managed', managedId: 'guest', controller, rootPath: root, createdAtMs: 1 },
    ], relationships: [{ v: 1, relationshipId: 'relationship', controllerMachineId: 'host', alphaWorkspaceRefId: 'host-ref',
      betaWorkspaceRefId: 'graph-native-ref', mode: 'keep_both_in_sync', enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }],
    organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'owner' };
    const port = await executePrivateProjectSyncEffect({ kind: 'native_sync', memberHome: parent, checkout: {
      workspaceRefId: 'graph-native-ref', workspaceRoot: parent, existingRootPath: root, generation: 1, plugins: [], contributions: {},
      request: { serverId: 'home', machineId: 'host', source: { kind: 'workspace', workspaceId: 'host-ref' },
        materialization: { kind: 'sync', targetPath: root, workspaceAction: { kind: 'copy_once',
          contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) } } } },
    } }, { serverId: 'home', machineId: 'host', accountId: 'owner', snapshot,
      localManagedTarget: { managedId: 'guest', controller }, agent: { executablePath: '/unused-native-agent' } }, {
      callMachineRpc: async () => { throw new Error('No Machine RPC expected'); },
      prepareSourceSeed: async () => { throw new Error('No source transfer expected'); },
      assertConflictResolutionAuthorized: async () => undefined,
      // The controller transport boundary holds the registry; the guest has no SCM plugins.
      ...(git ? { inspectNativeWorkspaceLocation: async () =>
        inspectWorkspaceLocationWithScmWorkspace({ candidatePath: root, registry }) } : {}),
      requestResolutionExport: async () => { throw new Error('Native destination must use a streamed native source'); },
      requestNativeResolutionExport: async request => {
        const exported = await createWorkspaceSyncEntryExport({ operationId: request.operationId,
          expectation: request.sourceExpected, materialPath: hostMaterial });
        return { resolvePayloadSource: async input => {
          // Host callback receives transfer identity only; it never receives a guest destination pathname.
          expect(Object.keys(input)).toEqual(['transferId']);
          const source = input.transferId === request.operationId ? exported.payloadSource
            : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId: input.transferId, requestBody: undefined });
          return { sizeBytes: await resolveTransferPayloadSizeBytes(source), manifestHash: await resolveTransferPayloadManifestHash(source),
            readChunk: async chunk => new Uint8Array(await readTransferPayloadChunk({ source, ...chunk })) };
        }, release: async () => { await exported.payloadSource.dispose?.(); } };
      },
    }, { signal: new AbortController().signal, onEffectsIssued() {} });
    try {
      expect(await port.inspectCheckout()).toMatchObject({ rootPath: root, directory: root });
      await port.prepareBootstrapHere({ v: 1, bootstrapOperationId: 'relationship', owner: { kind: 'relationship', relationshipId: 'relationship' },
        transientRelationship: snapshot.relationships[0]!, targetWorkspaceRefId: 'graph-native-ref', endpointRole: 'beta',
        policyDigest: snapshot.relationships[0]!.contentPolicy.policyDigest, createIfMissing: false, targetBootstrap: 'use_existing' });
      const original = await port.observeEntryHere({ relationshipId: 'relationship', workspaceRefId: 'graph-native-ref', path: 'reviewed.txt' });
      const selected = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), size: 8, executable: false };
      const actionInput = { controllerMachineId: 'host', hubWorkspaceRefId: 'host-ref', relationshipIds: ['relationship'],
        path: 'reviewed.txt', strategy: 'use_source' as const, source: { workspaceRefId: 'host-ref', expected: selected },
        targets: [{ workspaceRefId: 'graph-native-ref', expected: original }] };
      const apply = { actionReceiptId: 'approved', actionInput, alternativeIndex: null, relationshipId: 'relationship',
        operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId: 'approved', kind: 'selected', workspaceRefId: 'graph-native-ref', path: 'reviewed.txt' }),
        targetMachineId: 'host', targetWorkspaceRefId: 'graph-native-ref', path: 'reviewed.txt' };
      await port.stageConflictResolutionHere({ ...apply, sourceRelationshipId: 'relationship', sourceMachineId: 'host',
        sourceWorkspaceRefId: 'host-ref', sourceExpected: selected, targetExpected: original });
      await expect(port.applyStagedConflictResolutionHere(apply)).resolves.toMatchObject({ status: 'installed' });
      expect(await readFile(join(root, 'reviewed.txt'), 'utf8')).toBe('selected');
      expect(await readFile(hostMaterial, 'utf8')).toBe('selected');
      const reverseInput = { ...actionInput, source: { workspaceRefId: 'graph-native-ref', expected: selected },
        targets: [{ workspaceRefId: 'host-ref', expected: { kind: 'missing' as const } }] };
      const reverseRequest = { ...apply, actionInput: reverseInput, targetWorkspaceRefId: 'host-ref',
        operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId: 'approved', kind: 'selected', workspaceRefId: 'host-ref', path: 'reviewed.txt' }),
        sourceRelationshipId: 'relationship', sourceMachineId: 'host', sourceWorkspaceRefId: 'graph-native-ref',
        sourceExpected: selected, targetExpected: { kind: 'missing' as const } };
      const exported = await port.prepareSourceConflictResolutionExport(reverseRequest);
      expect(exported.blobs).toHaveLength(1);
      const blob = exported.blobs[0]!;
      const readBlob = () => port.readSourceSeedBlob({ operationId: reverseRequest.operationId, transferId: blob.transferId, offset: 0, length: blob.sizeBytes });
      expect(Buffer.from(await readBlob()).toString('utf8')).toBe('selected');
      await port.releaseConflictResolutionCaptureHere({ actionReceiptId: 'approved', actionInput: reverseInput,
        operationId: 'approved', sourceMachineId: 'host', sourceWorkspaceRefId: 'graph-native-ref' });
      await expect(readBlob()).rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
      await expect(port.resolveLocalRoot('/host/source')).rejects.toMatchObject({ code: 'workspace_private_checkout_required' });
      await expect(port.replaceSnapshot({ ...snapshot, workspaceRefs: snapshot.workspaceRefs.map(ref => ref.id !== 'graph-native-ref'
        ? ref : { id: ref.id, serverId: 'home', machineId: 'host', rootPath: root, createdAtMs: 1 }) })).rejects.toBeDefined();
    } finally { await port.dispose(); }
  });
});

it('captures a private host SOURCE through the controller loan and refuses new captures after release', async () => {
  await withTempDir('private-sync-source-loan-', async fixture => {
    const parent = await realpath(fixture);
    const root = join(parent, 'source');
    await mkdir(root);
    await writeFile(join(root, 'reviewed.txt'), 'source bytes');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const relationship = { v: 1 as const, relationshipId: 'relationship', controllerMachineId: 'host',
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'target', mode: 'keep_both_in_sync' as const,
      contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'source', serverId: 'home', machineId: 'host', rootPath: root, createdAtMs: 1 },
      { id: 'target', serverId: 'home', machineId: 'remote', rootPath: '/remote/target', createdAtMs: 1 },
    ], relationships: [relationship], organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'owner' };
    const port = await executePrivateProjectSyncEffect({ kind: 'native_sync', memberHome: parent, checkout: {
      workspaceRefId: 'source', workspaceRoot: parent, generation: 1, plugins: [], contributions: {},
      request: { serverId: 'home', machineId: 'host', source: { kind: 'workspace', workspaceId: 'source' },
        materialization: { kind: 'sync', targetPath: root, workspaceAction: { kind: 'relationship', relationshipId: 'relationship', flushBeforeCommit: false } } },
    } }, { serverId: 'home', machineId: 'host', accountId: 'owner', snapshot, agent: { executablePath: '/unused-native-agent' } }, {
      callMachineRpc: async () => { throw new Error('No Machine RPC expected'); },
      prepareSourceSeed: async () => { throw new Error('No source transfer expected'); }, assertConflictResolutionAuthorized: async () => undefined,
    }, { signal: new AbortController().signal, onEffectsIssued() {} });
    const selected = { kind: 'file' as const, digest: createHash('sha1').update('source bytes').digest('hex'), size: 12, executable: false };
    const actionInput = { controllerMachineId: 'host', hubWorkspaceRefId: 'source', relationshipIds: ['relationship'], path: 'reviewed.txt',
      strategy: 'use_source' as const, source: { workspaceRefId: 'source', expected: selected },
      targets: [{ workspaceRefId: 'target', expected: { kind: 'missing' as const } }] };
    const request = { actionReceiptId: 'approved-source', actionInput, alternativeIndex: null, relationshipId: 'relationship',
      operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId: 'approved-source', kind: 'selected', workspaceRefId: 'target', path: 'reviewed.txt' }),
      targetMachineId: 'remote', targetWorkspaceRefId: 'target', path: 'reviewed.txt', sourceRelationshipId: 'relationship',
      sourceMachineId: 'host', sourceWorkspaceRefId: 'source', sourceExpected: selected, targetExpected: { kind: 'missing' as const } };
    try {
      await expect(port.prepareSourceConflictResolutionExport(request)).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
      const loan = await port.acquireLocalRoot({ ownerId: 'relationship', canonicalRoot: root, operation: 'sync' });
      if ('kind' in loan) throw new Error('SOURCE is unexpectedly owned');
      const exported = await port.prepareSourceConflictResolutionExport(request);
      expect(exported.blobs).toHaveLength(1);
      await loan.release();
      await expect(port.prepareSourceConflictResolutionExport(request)).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
    } finally { await port.dispose(); }
  });
});
