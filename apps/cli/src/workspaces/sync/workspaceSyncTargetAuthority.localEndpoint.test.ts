import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { connect } from 'node:net';
import { expect, it, vi } from 'vitest';
import { computeWorkspaceSyncPolicyDigest, deriveWorkspaceSyncConflictOperationId } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import * as installationStore from '@/daemon/identity/store';
import { withTempDir } from '@/testkit/fs/tempDir';
import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import { createWorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority } from './workspaceSyncTargetAuthority';
import { createWorkspaceSyncEntryExport } from './workspaceSyncEntryTransfer';
import { writeTransferPayloadSourceToFile } from '@/machines/transfer/transferPayloadFileSink';
import { runNativeConfinedWorkspaceSyncApply } from './workspaceSyncNativeConfinedFileSystem';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { prepareExistingGitWorkspaceSyncTarget } from './workspaceSyncTargetBootstrap';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';

it.each([
  { sourceCustodian: 'owner', workerCopy: true },
  { sourceCustodian: 'source-owner', workerCopy: false },
])('restores the installed Account’s signed writer reads after restart (source custodian: $sourceCustodian)', async ({ sourceCustodian, workerCopy }) => {
  await withTempDir('workspace-sync-committed-worker-', async fixture => {
    const sourceRoot = join(fixture, 'source');
    const targetRoot = join(fixture, 'copy');
    await mkdir(targetRoot);
    await writeFile(join(targetRoot, 'payload.txt'), 'existing copy');
    const operationId = 'installed-worker-copy';
    const relationshipId = deriveWorkspaceSyncRelationshipId(operationId);
    const source = { machineId: 'source', installationId: 'source-installation' };
    const target = { machineId: 'target', installationId: 'target-installation' };
    const sourceWorkspace = { id: 'alpha', serverId: 'home', machineId: source.machineId, rootPath: sourceRoot, createdAtMs: 1 };
    const targetWorkspace = { id: 'beta', serverId: 'home', machineId: target.machineId, rootPath: targetRoot, createdAtMs: 1 };
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const staged = { v: 1 as const, relationshipId, controllerMachineId: source.machineId,
      alphaWorkspaceRefId: sourceWorkspace.id, betaWorkspaceRefId: targetWorkspace.id, mode: 'keep_synced' as const,
      enabled: true, createdAtMs: 1, updatedAtMs: 1, committedAtMs: null, contentPolicy,
      ...(workerCopy ? { provenance: { kind: 'worker_clean_copy' as const,
        sourceWorkspaceRefId: sourceWorkspace.id, targetWorkspaceRefId: targetWorkspace.id } } : {}) };
    let rows: ActiveProjectAccountRowsSnapshot = { source: 'network', accountMode: 'plain', workspaceRefs: [sourceWorkspace, targetWorkspace],
      relationships: [{ ...staged, enabled: false }], organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'owner' };
    const prepare = { v: 1 as const, bootstrapOperationId: relationshipId,
      owner: { kind: 'relationship' as const, relationshipId }, targetWorkspaceRefId: targetWorkspace.id,
      endpointRole: 'beta' as const, policyDigest: contentPolicy.policyDigest, createIfMissing: true };
    const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', role: 'manage' as const, encryptionMode: 'plain' as const };
    // The Home-verified admission enters at the RPC boundary. The target writes READY itself.
    const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-proof', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home', ...source,
      custodianAccountId: sourceCustodian, actionId: 'workspace.sync.relationship.create', requestId: operationId,
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: source.machineId }, accountEncryptionMode: 'plain',
    } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, sourceWriter: source, source: {
      v: 1, phase: 'prepare', operationId, accountServerId: 'home', sourceMachineId: source.machineId, sourceRootPath: sourceRoot,
      sourceContext: { machineAdmission: { ...admission, ...source, custodianAccountId: sourceCustodian,
        role: sourceCustodian === 'owner' ? 'manage' : 'use' }, callerAuthority: 'present_user', workspaceWrites: 'allow' },
    }, target: { v: 1, phase: 'prepare', operationId, accountServerId: 'home', targetMachineId: target.machineId, targetRootPath: targetRoot } });
    const context: RpcHandlerContext = { callerAuthority: 'present_user', callerInputAuthorization, machineAdmission: { ...admission, ...target },
      verifyMachineAdmissionCurrent: async () => true, workspaceSyncSourceWriterTargetRouting: routing };
    const writerContext = (phase: 'release' | 'inspect' | 'dependencies', actor = 'owner'): RpcHandlerContext => ({
      callerAuthority: 'present_user', machineAdmission: { ...admission, ...source,
        actorAccountId: sourceCustodian, custodianAccountId: sourceCustodian },
      verifyMachineAdmissionCurrent: async () => true,
      workspaceSyncSourceWriterTargetRouting: { ...routing, source: { ...routing.source,
        sourceContext: { ...routing.source.sourceContext, machineAdmission: {
          ...routing.source.sourceContext.machineAdmission, actorAccountId: actor,
        } },
      }, target: { ...routing.target, phase } },
    });
    const read = { relationshipId, workspaceRefId: targetWorkspace.id, path: 'payload.txt', maxBytes: 128 };
    const createTarget = () => createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: target.machineId,
      localAccountId: 'owner', scmRegistry: createScmBackendRegistry([]), getProjectSnapshot: () => rows, callMachineRpc: async () => { throw new Error('Unexpected remote effect'); },
      resolutionMaterialDirectory: join(fixture, 'resolution'), bootstrap: {
        materializationDirectory: join(fixture, 'materialization'),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      } });
    const installation = {
      version: 1, createdAt: 1, installationId: target.installationId, publicKey: 'fixture', privateKey: 'fixture',
    } as const;
    const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
    const first = createTarget();
    const restarted = createTarget();
    try {
      const original = await first.prepareBootstrapHere({ ...prepare, transientRelationship: staged, targetBootstrap: 'use_existing' }, undefined, context);
      await first.releaseBootstrapHere({ v: 1, bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: targetWorkspace.id, reason: 'relationship_committed' }, undefined, writerContext('release'));
      rows = { ...rows, relationships: [{ ...staged, committedAtMs: 2, updatedAtMs: 3 }] };
      const recovered = { state: 'ready', rootFingerprint: original.rootFingerprint, created: false };
      if (workerCopy) await expect(first.prepareBootstrapHere(prepare)).resolves.toMatchObject(recovered);
      await first.releaseAllRetainedBootstraps();
      if (workerCopy) {
        identity.mockReturnValue({ ...installation, installationId: 'replacement-installation' });
        await expect(restarted.prepareBootstrapHere(prepare)).rejects.toMatchObject({ code: 'target_bootstrap_required' });
        identity.mockReturnValue(installation);
      }
      await restarted.reconcileRetainedBootstraps();
      await expect(restarted.prepareBootstrapHere(prepare)).resolves.toMatchObject(recovered);
      const ingress = { operationId: relationshipId, sourceMachineId: source.machineId, targetMachineId: target.machineId, actorAccountId: 'owner' };
      await expect(restarted.authorizeWorkspaceSyncMachineAgent(ingress)).resolves.toMatchObject({ workspaceRefId: targetWorkspace.id });
      await expect(restarted.readFileHere(read, undefined, writerContext('inspect')))
        .resolves.toMatchObject({ status: 'text', text: 'existing copy' });
      await expect(restarted.readFileHere(read, undefined, writerContext('inspect', 'unrelated')))
        .rejects.toMatchObject({ code: 'forbidden' });
      const dependencies = { serverId: 'home', machineId: target.machineId, relationshipId, workspaceRefId: targetWorkspace.id };
      await expect(restarted.assertRetainedCopyDependencyAdmission(dependencies, writerContext('dependencies'))).resolves.toBeUndefined();
      rows = { ...rows, relationships: [] };
      await restarted.reconcileRetainedBootstraps();
      await expect(restarted.authorizeWorkspaceSyncMachineAgent(ingress)).rejects.toMatchObject({ code: 'peer_unavailable' });
      await expect(restarted.readFileHere(read, undefined, writerContext('inspect')))
        .rejects.toMatchObject({ code: 'forbidden' });
      expect(await readFile(join(targetRoot, 'payload.txt'), 'utf8')).toBe('existing copy');
    } finally {
      await first.releaseAllRetainedBootstraps();
      await restarted.releaseAllRetainedBootstraps();
      identity.mockRestore();
    }
  });
});

it.each([false, true])('retains signed native target admission at the carrier while the guest owns its filesystem and release (stopped on target: %s)', async stoppedOnTarget => {
  await withTempDir('native-target-dispatch-', async fixture => {
    const root = join(fixture, 'guest'); await mkdir(root);
    runScmExecutable(root, 'git', ['init', '-q']);
    await writeFile(join(root, '.gitignore'), '.env\n');
    await writeFile(join(root, '.env'), 'excluded fixture');
    await writeFile(join(root, 'reviewed.txt'), 'conflict fixture');
    const controller = { machineId: 'carrier', installationId: 'carrier-installation' };
    const input = { v: 1 as const, selection: 'git_worktree' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...input, policyDigest: computeWorkspaceSyncPolicyDigest(input) };
    const relationship = { v: 1 as const, relationshipId: 'signed-native', controllerMachineId: 'source-machine',
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'guest', mode: 'keep_both_in_sync' as const,
      contentPolicy, enabled: false, createdAtMs: 1, updatedAtMs: 1 };
    const target = { id: 'guest', v: 2 as const, kind: 'managed' as const, managedId: 'managed-target', controller,
      serverId: 'home', rootPath: root, createdAtMs: 1 };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [target,
      { id: 'source', serverId: 'home', machineId: 'source-machine', rootPath: '/source/root', createdAtMs: 1 }],
      relationships: [relationship], rows: [], organizations: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'owner' };
    const registration = createGitScmBackendRuntimeRegistration();
    const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({ definition: { id: 'git', kind: 'git' },
      qualifiedId: 'happier.scm.git/git', executableDefinition: registration.runtime!, registration })]);
    let guestSnapshot: ActiveProjectAccountRowsSnapshot | null = snapshot;
    let carrierSnapshot: ActiveProjectAccountRowsSnapshot | null = snapshot;
    const guest = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'carrier', localAccountId: 'owner',
      localManagedTarget: { managedId: target.managedId, controller }, getProjectSnapshot: () => guestSnapshot,
      scmRegistry: registry,
      resolutionMaterialDirectory: join(fixture, 'guest-resolution'),
      callMachineRpc: async () => { throw new Error('No Machine RPC expected'); },
      bootstrap: { materializationDirectory: join(fixture, 'guest-materialization'),
        prepareGitTarget: input => prepareExistingGitWorkspaceSyncTarget(input, {
          inspectWorkspaceLocation: request => inspectWorkspaceLocationWithScmWorkspace({ ...request, registry }),
        }),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'guest-locks') }) } });
    let stoppedBeforeRootRelease = false;
    const carrier = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'carrier', localAccountId: 'owner',
      getProjectSnapshot: () => carrierSnapshot, callMachineRpc: async () => { throw new Error('No Machine RPC expected'); },
      // The process transport is the boundary; the guest's real authority below owns all root effects.
      resolveNativeTargetExecution: async () => ({ ...guest,
        replaceSnapshot: async (next: ActiveProjectAccountRowsSnapshot | null) => { guestSnapshot = next; } }),
      openNativeRootedAgent: async () => ({ stream: new PassThrough(), stop: async () => {
        const stillOwned = await guest.authorizeWorkspaceSyncMachineAgent({ operationId: relationship.relationshipId,
          sourceMachineId: 'source-machine', targetMachineId: 'carrier' });
        stoppedBeforeRootRelease = stillOwned.workspaceRefId === target.id;
      } }),
      bootstrap: { materializationDirectory: join(fixture, 'carrier-materialization'),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'carrier-locks') }) } });
    const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: controller.machineId,
      installationId: controller.installationId, role: 'use' as const, encryptionMode: 'plain' as const };
    const targetContext = { machineAdmission: admission, callerAuthority: 'account_automation' as const, workspaceWrites: 'allow' as const };
    const routing = { v: 1 as const, phase: 'prepare' as const, operationId: relationship.relationshipId,
      accountServerId: 'home', targetMachineId: controller.machineId, targetRootPath: root,
      targetManaged: { managedId: target.managedId, controller }, targetContext };
    const { targetContext: _targetContext, ...sourceTarget } = routing;
    const sourceWriterRouting = { v: 1 as const, sourceWriter: controller,
      source: { v: 1 as const, phase: 'prepare' as const, operationId: relationship.relationshipId, accountServerId: 'home',
        sourceMachineId: 'source-machine', sourceRootPath: '/source/root', sourceContext: {
          ...targetContext, machineAdmission: { ...admission, machineId: 'source-machine', installationId: 'source-installation' } } },
      target: sourceTarget };
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation', machineAdmission: admission,
      verifyMachineAdmissionCurrent: async () => true, workspaceSyncTargetRouting: routing,
      workspaceSyncSourceWriterTargetRouting: sourceWriterRouting };
    const request = { v: 1 as const, bootstrapOperationId: relationship.relationshipId,
      owner: { kind: 'relationship' as const, relationshipId: relationship.relationshipId }, transientRelationship: { ...relationship, enabled: true },
      targetWorkspaceRefId: target.id, endpointRole: 'beta' as const, policyDigest: contentPolicy.policyDigest,
      createIfMissing: false, targetBootstrap: 'use_existing' as const };
    try {
      await expect(carrier.preflightHandoffTargetReplacementHere({ v: 1, serverId: 'home', machineId: 'carrier',
        operationId: relationship.relationshipId, targetPath: root, activatesExactMirror: false, destinationIntent: 'use_existing' },
      undefined, { ...context, workspaceSyncTargetRouting: { ...routing, phase: 'preflight' } })).resolves.toMatchObject({ type: 'not_required' });
      await expect(carrier.prepareBootstrapHere(request, undefined, context)).resolves.toMatchObject({ state: 'ready' });
      const recovery = { relationshipId: relationship.relationshipId, targetMachineId: 'carrier', targetWorkspaceRefId: target.id };
      expect(carrier.hasRetainedRecoveryAdmission({ request: recovery, accountServerId: 'home', actorAccountId: 'owner', receivingMachine: controller })).toBe(true);
      expect(await carrier.recoverConflictResolutionHere(recovery)).toEqual({ status: 'settled' });
      const releaseContext: RpcHandlerContext = { signal: context.signal, callerAuthority: 'account_automation', machineAdmission: admission,
        verifyMachineAdmissionCurrent: async () => true, workspaceSyncSourceWriterTargetRouting: {
          ...sourceWriterRouting, target: { ...sourceTarget, phase: 'release' } } };
      const ingress = await carrier.acquireWorkspaceSyncMachineIngress({ operationId: relationship.relationshipId,
        sourceMachineId: 'source-machine', targetMachineId: 'carrier', actorAccountId: 'owner' });
      const client = connect({ host: '127.0.0.1', port: ingress.port });
      try {
        await once(client, 'connect');
        const bytes = Buffer.from([0, 255, 128, 4]);
        const first = once(client, 'data');
        client.write(Buffer.concat([Buffer.from(ingress.localCapability), bytes]));
        expect((await first)[0]).toEqual(bytes);
        expect(await carrier.releaseBootstrapHere({ v: 1, bootstrapOperationId: request.bootstrapOperationId,
          targetWorkspaceRefId: target.id, reason: 'relationship_committed' }, undefined, releaseContext)).toEqual({ ok: true, released: false });
        const afterAcknowledgement = once(client, 'data');
        client.write(bytes);
        expect((await afterAcknowledgement)[0]).toEqual(bytes);
      } finally { client.destroy(); await ingress.close(); }
      guestSnapshot = { ...snapshot, relationships: [{ ...relationship, enabled: true }] };
      const inspectContext: RpcHandlerContext = {
        signal: context.signal, callerAuthority: 'account_automation', machineAdmission: admission,
        verifyMachineAdmissionCurrent: async () => true,
        workspaceSyncSourceWriterTargetRouting: { ...sourceWriterRouting, target: { ...sourceTarget, phase: 'inspect' } },
      };
      const reviewed = { relationshipId: relationship.relationshipId, workspaceRefId: target.id, path: 'reviewed.txt' };
      const excluded = { ...reviewed, path: '.env' };
      for (const receiver of [guest, carrier]) {
        await expect(receiver.readFileHere({ ...reviewed, maxBytes: 128 }, undefined, inspectContext))
          .resolves.toMatchObject({ status: 'text', text: 'conflict fixture' });
        await expect(receiver.observeEntryHere(reviewed, undefined, inspectContext)).resolves.toMatchObject({ kind: 'file' });
      }
      const results = await Promise.allSettled([guest, carrier].flatMap(receiver => [
        receiver.readFileHere({ ...excluded, maxBytes: 128 }, undefined, inspectContext),
        receiver.observeEntryHere(excluded, undefined, inspectContext),
      ]));
      expect(results).toEqual(Array.from({ length: 4 }, () =>
        ({ status: 'rejected', reason: expect.objectContaining({ code: 'forbidden' }) })));

      expect(stoppedBeforeRootRelease).toBe(true);
      if (stoppedOnTarget) {
        // The person stops the link on this Machine: its own Account rows drop the relationship.
        carrierSnapshot = { ...snapshot, relationships: [] };
        await carrier.reconcileRetainedBootstraps();
        const afterStop = await Promise.allSettled([guest, carrier].flatMap(receiver => [
          receiver.readFileHere({ ...reviewed, maxBytes: 128 }, undefined, inspectContext),
          receiver.observeEntryHere(reviewed, undefined, inspectContext),
        ]));
        expect(afterStop).toEqual(Array.from({ length: 4 }, () =>
          ({ status: 'rejected', reason: expect.objectContaining({ code: 'forbidden' }) })));
        await expect(carrier.releaseBootstrapHere({ v: 1, bootstrapOperationId: request.bootstrapOperationId,
          targetWorkspaceRefId: target.id, reason: 'abort' }, undefined, releaseContext)).resolves.toMatchObject({ ok: true });
        await expect(guest.authorizeWorkspaceSyncMachineAgent({ operationId: relationship.relationshipId,
          sourceMachineId: 'source-machine', targetMachineId: 'carrier' })).rejects.toMatchObject({ code: 'peer_unavailable' });
        return;
      }
      guestSnapshot = snapshot;
      await expect(carrier.releaseBootstrapHere({ v: 1, bootstrapOperationId: request.bootstrapOperationId,
        targetWorkspaceRefId: target.id, reason: 'abort' }, undefined, releaseContext)).resolves.toEqual({ ok: true, released: true });
      expect(carrier.hasRetainedRecoveryAdmission({ request: recovery, accountServerId: 'home', actorAccountId: 'owner', receivingMachine: controller })).toBe(false);
      await expect(guest.authorizeWorkspaceSyncMachineAgent({ operationId: relationship.relationshipId,
        sourceMachineId: 'source-machine', targetMachineId: 'carrier' })).rejects.toMatchObject({ code: 'peer_unavailable' });
    } finally { await carrier.releaseAllRetainedBootstraps(); await guest.releaseAllRetainedBootstraps(); }
  });
});

it.each([
  { actorAccountId: 'target-owner', restart: false, sourceStaged: true },
  { actorAccountId: 'target-owner', restart: false, sourceStaged: false },
  { actorAccountId: 'requester', restart: true, sourceStaged: true },
])('retains a committed Fresh copy under signed authority (actor: $actorAccountId, restart: $restart, staged: $sourceStaged)', async ({ actorAccountId, restart, sourceStaged }) => {
  await withTempDir('workspace-sync-requester-restart-', async fixture => {
    const root = join(fixture, 'copy');
    await mkdir(root);
    await writeFile(join(root, 'payload.txt'), 'committed copy');
    const operationId = 'fresh-copy';
    const relationshipId = deriveWorkspaceSyncRelationshipId(operationId);
    const target = { machineId: 'target', installationId: 'target-installation' };
    const source = { machineId: 'source', installationId: 'source-installation' };
    const sourceRoot = join(fixture, 'source');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const contentPolicy = { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) };
    const staged = { v: 1 as const, relationshipId, controllerMachineId: source.machineId,
      alphaWorkspaceRefId: 'original', betaWorkspaceRefId: 'fresh', mode: 'keep_synced' as const, contentPolicy,
      enabled: true, createdAtMs: 1, updatedAtMs: 1, committedAtMs: null,
      provenance: { kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: 'original', targetWorkspaceRefId: 'fresh' } };
    const prepare = { v: 1 as const, bootstrapOperationId: relationshipId,
      owner: { kind: 'relationship' as const, relationshipId }, targetWorkspaceRefId: 'fresh',
      endpointRole: 'beta' as const, policyDigest: contentPolicy.policyDigest, createIfMissing: true };
    const admissionFor = (actorAccountId: string) => ({
      ...target, actorAccountId, custodianAccountId: 'target-owner', role: 'manage' as const, encryptionMode: 'plain' as const,
    });
    const contextFor = (actorAccountId: string): RpcHandlerContext => {
      const admission = admissionFor(actorAccountId);
      const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-proof', binding: {
        accountId: actorAccountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
        ...source, custodianAccountId: actorAccountId, actionId: 'workspace.sync.relationship.create', requestId: operationId,
        requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: source.machineId }, accountEncryptionMode: 'plain',
      } });
      const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, sourceWriter: source, source: {
        v: 1, phase: 'prepare', operationId, accountServerId: 'home', sourceMachineId: source.machineId, sourceRootPath: sourceRoot,
        sourceContext: { machineAdmission: { ...admission, ...source, custodianAccountId: actorAccountId },
          callerAuthority: 'present_user', workspaceWrites: 'allow' },
      }, target: { v: 1, phase: 'prepare', operationId, accountServerId: 'home', targetMachineId: target.machineId,
        targetRootPath: root } });
      return { callerAuthority: 'present_user', callerInputAuthorization, machineAdmission: admission,
        verifyMachineAdmissionCurrent: async () => true, workspaceSyncSourceWriterTargetRouting: routing };
    };
    let targetRows: ActiveProjectAccountRowsSnapshot = { source: 'network', accountMode: 'plain', workspaceRefs: [], relationships: [],
      organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 0, scopeKey: 'target-owner' };
    // The honest SOURCE stages its disabled row at Home before prepare; the
    // target's installed projection has not received it yet.
    const homeRows: ActiveProjectAccountRowsSnapshot = { ...targetRows,
      relationships: sourceStaged ? [{ ...staged, enabled: false }] : [] };
    let refreshes = 0;
    const createTarget = () => createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: target.machineId,
      localAccountId: 'target-owner', getProjectSnapshot: () => targetRows, refreshProjectSnapshot: async () => {
        refreshes += 1;
        targetRows = homeRows;
        return targetRows;
      }, callMachineRpc: async () => {
        throw new Error('The admitted SOURCE already qualified its workspace');
      }, resolutionMaterialDirectory: join(fixture, 'resolution'), bootstrap: {
        materializationDirectory: join(fixture, 'materialization'),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
      } });
    const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
      version: 1, createdAt: 1, installationId: target.installationId, publicKey: 'fixture-public', privateKey: 'fixture-private',
    });
    const first = createTarget();
    const restarted = createTarget();
    const context = contextFor(actorAccountId);
    try {
      const ingress = {
        operationId: relationshipId, sourceMachineId: source.machineId, targetMachineId: target.machineId, actorAccountId,
      };
      if (!sourceStaged) {
        // A SOURCE that never stages its row cannot borrow the installed Account's TARGET.
        await expect(first.prepareBootstrapHere({
          ...prepare, transientRelationship: staged, targetBootstrap: 'use_existing',
        }, undefined, context)).rejects.toMatchObject({ code: 'relationship_not_ready' });
        expect(refreshes).toBe(1);
        await expect(first.getPreparedBootstrapOwnership(prepare)).rejects.toMatchObject({ code: 'workspace_root_ownership_lost' });
        await expect(first.authorizeWorkspaceSyncMachineAgent(ingress)).rejects.toMatchObject({ code: 'peer_unavailable' });
        return;
      }
      const original = await first.prepareBootstrapHere({
        ...prepare, transientRelationship: staged, targetBootstrap: 'use_existing',
      }, undefined, context);
      const routing = context.workspaceSyncSourceWriterTargetRouting!;
      await expect(first.releaseBootstrapHere({ v: 1, bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'fresh', reason: 'relationship_committed' }, undefined, {
        callerAuthority: 'present_user', machineAdmission: { ...admissionFor(actorAccountId), ...source, custodianAccountId: actorAccountId },
        verifyMachineAdmissionCurrent: async () => true, workspaceSyncSourceWriterTargetRouting: {
          ...routing, target: { ...routing.target, phase: 'release' },
        },
      })).resolves.toEqual({ ok: true, released: false });
      const committed = { ...prepare, transientRelationship: { ...staged, committedAtMs: 2, updatedAtMs: 3 } };
      if (!restart) {
        // READY has settled, but the target's installed Account projection is
        // still behind the writer's committed relationship.
        await first.reconcileRetainedBootstraps();
        await expect(first.getPreparedBootstrapOwnership(prepare)).resolves.toMatchObject({
          owner: { rootFingerprint: original.rootFingerprint },
        });
        await expect(first.authorizeWorkspaceSyncMachineAgent(ingress)).resolves.toMatchObject({ workspaceRefId: 'fresh' });

        targetRows = { ...targetRows, relationships: [committed.transientRelationship], workspaceRefs: [
          { id: 'original', serverId: 'home', machineId: source.machineId, rootPath: sourceRoot, createdAtMs: 1 },
          { id: 'fresh', serverId: 'home', machineId: target.machineId, rootPath: root, createdAtMs: 1 },
        ] };
        await first.reconcileRetainedBootstraps();
        await expect(first.authorizeWorkspaceSyncMachineAgent(ingress)).resolves.toMatchObject({ workspaceRefId: 'fresh' });
        targetRows = { ...targetRows, relationships: [] };
        await first.reconcileRetainedBootstraps();
        await expect(first.getPreparedBootstrapOwnership(prepare)).rejects.toMatchObject({
          code: 'workspace_root_ownership_lost',
          failureCause: { phase: 'workspace_sync.target_bootstrap.ownership', errorCode: 'workspace_root_ownership_lost' },
        });
        await expect(first.authorizeWorkspaceSyncMachineAgent(ingress)).rejects.toMatchObject({ code: 'peer_unavailable' });
        return;
      }

      await first.releaseAllRetainedBootstraps();
      await restarted.reconcileRetainedBootstraps();
      await expect(restarted.prepareBootstrapHere(committed, undefined, {
        ...context, verifyMachineAdmissionCurrent: async () => false,
      })).rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
      await expect(restarted.prepareBootstrapHere(committed, undefined, contextFor('another-requester')))
        .rejects.toMatchObject({ code: 'target_bootstrap_required' });
      await expect(restarted.prepareBootstrapHere(committed, undefined, context)).resolves.toMatchObject({
        state: 'ready', targetWorkspaceRefId: 'fresh', rootFingerprint: original.rootFingerprint, created: false,
      });
      await expect(restarted.authorizeWorkspaceSyncMachineAgent({
        operationId: relationshipId, sourceMachineId: source.machineId, targetMachineId: target.machineId,
        actorAccountId: 'requester',
      })).resolves.toMatchObject({ workspaceRefId: 'fresh' });
      expect(await readFile(join(root, 'payload.txt'), 'utf8')).toBe('committed copy');
    } finally {
      await restarted.releaseAllRetainedBootstraps();
      await first.releaseAllRetainedBootstraps();
      identity.mockRestore();
    }
  });
});

it.each(['keep_both_in_sync', 'mirror_exactly'] as const)('bootstraps a managed namespace without reading its same-controller host source (%s)', async mode => {
  await withTempDir('workspace-sync-managed-namespace-', async fixture => {
    const relationshipId = deriveWorkspaceSyncRelationshipId('native-operation');
    const root = join(fixture, 'checkout');
    await mkdir(root);
    await writeFile(join(root, 'reviewed.txt'), 'native bytes');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const controller = { machineId: 'controller', installationId: 'controller-installation' };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'host', serverId: 'home', machineId: 'controller', rootPath: root, createdAtMs: 1 },
      { id: 'native', serverId: 'home', v: 2, kind: 'managed', managedId: 'guest', controller, rootPath: root, createdAtMs: 1 },
    ], relationships: [{ v: 1, relationshipId, controllerMachineId: 'controller', alphaWorkspaceRefId: 'host',
      betaWorkspaceRefId: 'native', mode, enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }],
    organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'owner' };
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: controller.machineId,
      localManagedTarget: { managedId: 'guest', controller }, getProjectSnapshot: () => snapshot,
      resolutionMaterialDirectory: join(fixture, 'resolution'),
      // Approval receipts and finite transfer are host boundaries; native custody and mutation remain real.
      assertTargetReplacementAuthorized: async () => undefined,
      assertConflictResolutionAuthorized: async () => undefined,
      requestResolutionExport: async request => {
        const exported = await createWorkspaceSyncEntryExport({ operationId: request.operationId, expectation: request.sourceExpected, materialPath: null });
        return { requestPayload: async ({ destinationPath }) => {
          await writeTransferPayloadSourceToFile({ source: exported.payloadSource, destinationPath });
        }, release: async () => { await exported.payloadSource.dispose?.(); } };
      },
      callMachineRpc: async () => { throw new Error('Native local operation must not use Machine RPC'); },
      bootstrap: { materializationDirectory: join(fixture, 'materialization'),
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') }),
        materializeLocalSeed: async () => { throw new Error('Host SOURCE must not be opened in the native namespace'); } } });
    try {
      await expect(authority.readFileHere({ relationshipId, workspaceRefId: 'host', path: 'reviewed.txt', maxBytes: 128 }))
        .rejects.toMatchObject({ code: 'workspace_machine_not_enrolled' });
      const preflight = mode === 'mirror_exactly' ? await authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'home', machineId: 'controller', operationId: 'native-operation', targetPath: root,
        activatesExactMirror: true, destinationIntent: 'use_existing',
      }) : undefined;
      if (mode === 'mirror_exactly' && preflight?.type !== 'approval_required') throw new Error('Mirror requires approval');
      await expect(authority.prepareBootstrapHere({ v: 1, bootstrapOperationId: relationshipId, owner: { kind: 'relationship', relationshipId },
        transientRelationship: snapshot.relationships[0]!, targetWorkspaceRefId: 'native', endpointRole: 'beta', policyDigest: snapshot.relationships[0]!.contentPolicy.policyDigest,
        createIfMissing: false, targetBootstrap: 'use_existing',
        ...(preflight?.type === 'approval_required' ? { targetReplacementApproval: preflight.approval,
          targetReplacementApprovalReceiptId: 'approved-native', targetReplacementApprovalActionInput: { targetMachineId: 'controller', targetPath: root } } : {}) })).resolves.toMatchObject({ state: 'ready' });
      await expect(authority.observeEntryHere({ relationshipId, workspaceRefId: 'native', path: 'reviewed.txt' }))
        .resolves.toMatchObject({ kind: 'file', size: 12 });
      await expect(authority.authorizeWorkspaceSyncMachineAgent({ operationId: relationshipId,
        sourceMachineId: 'controller', targetMachineId: 'controller' })).resolves.toEqual({
          operationId: relationshipId, role: 'beta', workspaceRefId: 'native', canonicalRoot: root,
        });
      await expect(authority.recoverConflictResolutionHere({ relationshipId, targetMachineId: 'controller', targetWorkspaceRefId: 'native' }))
        .resolves.toEqual({ status: 'settled' });
      const selected = { kind: 'missing' as const };
      const original = await authority.observeEntryHere({ relationshipId, workspaceRefId: 'native', path: 'reviewed.txt' });
      const actionInput = { controllerMachineId: 'controller', hubWorkspaceRefId: 'host', path: 'reviewed.txt',
        source: { workspaceRefId: 'host', expected: selected }, targets: [{ workspaceRefId: 'native', expected: original }],
        relationshipIds: [relationshipId], strategy: 'use_source' as const };
      const apply = { actionReceiptId: 'reviewed-native-conflict', actionInput, alternativeIndex: null,
        operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId: 'reviewed-native-conflict', kind: 'selected', workspaceRefId: 'native', path: 'reviewed.txt' }),
        relationshipId, targetMachineId: 'controller', targetWorkspaceRefId: 'native', path: 'reviewed.txt' };
      await authority.stageConflictResolutionHere({ ...apply, sourceRelationshipId: relationshipId, sourceMachineId: 'controller',
        sourceWorkspaceRefId: 'host', sourceExpected: selected, targetExpected: original });
      await expect(authority.applyStagedConflictResolutionHere(apply)).resolves.toMatchObject({ status: 'installed' });
      await expect(lstat(join(root, 'reviewed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const installed = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'controller', getProjectSnapshot: () => snapshot,
        callMachineRpc: async () => { throw new Error('No Machine RPC expected'); } });
      await expect(installed.readFileHere({ relationshipId, workspaceRefId: 'native', path: 'reviewed.txt', maxBytes: 128 }))
        .rejects.toMatchObject({ code: 'workspace_machine_not_enrolled' });
      await installed.releaseAllRetainedBootstraps();
    } finally { await authority.releaseAllRetainedBootstraps(); }
  });
});

it('reconciles only the host-selected endpoint while preserving another local root owner', async () => {
  await withTempDir('workspace-sync-local-endpoint-', async fixture => {
    const alpha = join(fixture, 'alpha');
    const beta = join(fixture, 'beta');
    await mkdir(alpha); await mkdir(beta);
    await writeFile(join(alpha, 'owned.txt'), 'other owner');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const snapshot: ActiveProjectAccountRowsSnapshot = { source: 'network', workspaceRefs: [
      { id: 'alpha', serverId: 'home', machineId: 'local', rootPath: alpha, createdAtMs: 1 },
      { id: 'beta', serverId: 'home', machineId: 'local', rootPath: beta, createdAtMs: 1 },
      { id: 'source', serverId: 'home', machineId: 'remote', rootPath: '/remote/source', createdAtMs: 1 },
    ], relationships: [{ v: 1, relationshipId: 'relationship', controllerMachineId: 'remote', alphaWorkspaceRefId: 'source',
      betaWorkspaceRefId: 'beta', mode: 'keep_both_in_sync', enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 },
    { v: 1, relationshipId: 'other-relationship', controllerMachineId: 'remote', alphaWorkspaceRefId: 'source',
      betaWorkspaceRefId: 'alpha', mode: 'keep_both_in_sync', enabled: true,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }],
    organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'requester' };
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const otherOwner = await rootOwnershipManager.tryAcquire({ ownerId: 'other-owner', canonicalRoot: alpha, operation: 'sync' });
    if ('kind' in otherOwner) throw new Error('Fixture root is already owned');
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'local', localWorkspaceRefId: 'beta',
      getProjectSnapshot: () => snapshot, callMachineRpc: async () => { throw new Error('No remote operation expected'); },
      openRootedAgent: async () => { throw new Error('No rooted agent may launch without READY'); },
      bootstrap: { materializationDirectory: join(fixture, 'materialization'), rootOwnershipManager } });
    try {
      await expect(authority.acquireWorkspaceSyncMachineIngress({ operationId: 'other-relationship', sourceMachineId: 'remote', targetMachineId: 'local' }))
        .rejects.toMatchObject({ code: 'peer_unavailable' });
      await authority.reconcileRetainedBootstraps();
      await otherOwner.assertCurrentRootIdentity(otherOwner.owner.rootFingerprint!);
      expect(await readFile(join(alpha, 'owned.txt'), 'utf8')).toBe('other owner');
      expect(await rootOwnershipManager.tryAcquire({ ownerId: 'contender', canonicalRoot: alpha, operation: 'sync' }))
        .toMatchObject({ kind: 'overlap', existing: { ownerId: 'other-owner' } });
    } finally { await authority.releaseAllRetainedBootstraps(); await otherOwner.release(); }
  });
});

it('retains failed local source agent cleanup for an explicit shutdown retry', async () => {
  await withTempDir('workspace-sync-local-source-', async root => {
    let stopped = false;
    let refuseStop = true;
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'local',
      callMachineRpc: async () => { throw new Error('No remote operation expected'); },
      // Rooted process is the genuine OS boundary. Custody and listener are real.
      openRootedAgent: async () => ({ stream: new PassThrough(), stop: async () => {
        if (refuseStop) { refuseStop = false; throw new Error('Process stop failed'); }
        stopped = true;
      } }),
    });
    await authority.openLocalWorkspaceAgentIngress({ operationId: 'operation', role: 'alpha', workspaceRefId: 'source', canonicalRoot: root });
    try {
      await expect(authority.releaseAllRetainedBootstraps()).rejects.toThrow('Process stop failed');
      expect(stopped).toBe(false);
    } finally { await authority.releaseAllRetainedBootstraps(); }
    expect(stopped).toBe(true);
  });
});

it.skipIf(process.platform !== 'linux')('settles a requester source journal with its controller loan when the installed Account graph differs', async () => {
  await withTempDir('workspace-sync-requester-recovery-', async fixture => {
    const sourceRoot = join(fixture, 'source');
    const resolutionDirectory = join(fixture, 'resolution');
    await mkdir(sourceRoot); await mkdir(resolutionDirectory);
    await writeFile(join(sourceRoot, 'reviewed.txt'), 'original');
    const materialPath = join(resolutionDirectory, 'entry');
    await writeFile(materialPath, 'selected');
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIncludePatterns: [], extraIgnorePatterns: [] };
    const relationship = { v: 1 as const, relationshipId: 'requester-relationship', controllerMachineId: 'local',
      alphaWorkspaceRefId: 'source', betaWorkspaceRefId: 'target', mode: 'keep_both_in_sync' as const, enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 };
    let requesterRows: ActiveProjectAccountRowsSnapshot | null = { source: 'network', workspaceRefs: [
      { id: 'source', serverId: 'home', machineId: 'local', rootPath: sourceRoot, createdAtMs: 1 },
      { id: 'target', serverId: 'home', machineId: 'remote', rootPath: '/remote/target', createdAtMs: 1 },
    ], relationships: [relationship], organizations: [], rows: [], graphRevision: 1, loadedAtMs: 1, scopeKey: 'requester' };
    const otherAccountRows: ActiveProjectAccountRowsSnapshot = { ...requesterRows, workspaceRefs: [], relationships: [], scopeKey: 'installed' };
    let installedRows: ActiveProjectAccountRowsSnapshot | null = null;
    const roots = createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture, 'locks') });
    const loan = await roots.tryAcquire({ ownerId: relationship.relationshipId, canonicalRoot: sourceRoot, operation: 'sync' });
    if ('kind' in loan) throw new Error('Source root is unexpectedly owned');
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'home', localMachineId: 'local',
      getProjectSnapshot: () => installedRows, resolutionMaterialDirectory: resolutionDirectory,
      callMachineRpc: async () => { throw new Error('No remote operation expected'); } });
    try {
      const expectedDestination = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
      const selectedExpectation = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
      let interrupted;
      try { interrupted = await runNativeConfinedWorkspaceSyncApply({ rootPath: sourceRoot, relativePath: 'reviewed.txt',
        expectedDestination, selectedExpectation, materialPath, recoveryDirectory: resolutionDirectory, operationId: 'requester-source',
        assertCurrentAuthority: async () => { await chmod(sourceRoot, 0o500); } }); }
      finally { await chmod(sourceRoot, 0o700); }
      expect(interrupted.status).toBe('recovery_needed');
      const request = { relationshipId: relationship.relationshipId, targetMachineId: 'local', targetWorkspaceRefId: 'source' };
      await expect(authority.recoverConflictResolutionHere(request)).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
      installedRows = otherAccountRows;
      await expect(authority.recoverConflictResolutionHere(request)).rejects.toMatchObject({ code: 'relationship_not_ready' });
      const localResolutionEndpoint = { relationship, canonicalRoot: sourceRoot,
        assertCurrentAuthority: async () => { await loan.assertCurrentRootIdentity(loan.owner.rootFingerprint!); } };
      expect(await authority.recoverConflictResolutionHere(request, undefined,
        { localResolutionEndpoint, getProjectSnapshot: () => requesterRows })).toEqual({ status: 'settled' });
      await expect(lstat(join(resolutionDirectory, 'workspace-recovery-requester-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(sourceRoot, 'reviewed.txt'), 'utf8')).toBe('original');
      requesterRows = null;
      await expect(authority.recoverConflictResolutionHere(request, undefined,
        { localResolutionEndpoint, getProjectSnapshot: () => requesterRows })).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
    } finally { await authority.releaseAllRetainedBootstraps(); await loan.release(); }
  });
});
