import { join } from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { DevcontainerChildProjectionV1 } from '@happier-dev/protocol/machines/managed/devcontainerV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, WorkspaceSyncHandoffSourcePhaseResultV1Schema,
  WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceContextV1Schema,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema, SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { composeBindChildSourcePhaseTestRuntime, composeInstalledBindTargetTransport } from './createProductionDaemonWorkspaceSyncRuntime.testkit';
import { openProject } from '@/workspaces/activation/openProject';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));

const approvalsGet = vi.hoisted(() => vi.fn());
vi.mock('@/session/actions/approvals/artifactStore', () => ({
  createCliApprovalsArtifactStore: () => ({ approvalsGet }),
}));

import {
  API_TOKEN_FULL_GRANT_V1,
  ExternalActionExecutionAuthorizationV1Schema,
  computeWorkspaceSyncPolicyDigest,
  type HandoffTargetReplacementApprovalV1,
  type WorkspaceSyncConflictResolveActionInputV1,
} from '@happier-dev/protocol';
import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowMutationRequestV1Schema,
  ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, type ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { WorkspaceSyncLegacyStateInspection } from '@/workspaces/sync/workspaceSyncLegacyState';
import { createWorkspaceSyncHandoffAdapter } from '@/workspaces/sync/workspaceSyncHandoffAdapter';
import type {
  FiniteTransferMachineTunnel,
  WorkspaceSyncMachineTunnel,
  WorkspaceSyncMachineTunnelOpenInput,
} from '@/workspaces/sync/workspaceSyncMachineCarrierStream';
import {
  createProductionDaemonWorkspaceSyncRuntime,
  type ProductionDaemonWorkspaceSyncFactories,
} from './createProductionDaemonWorkspaceSyncRuntime';

const contentPolicyInput = {
  v: 1 as const,
  selection: 'all_files' as const,
  extraIgnorePatterns: [],
  extraIncludePatterns: [],
};
const contentPolicy = {
  ...contentPolicyInput,
  policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput),
};

function settingsSnapshot(): ActiveProjectAccountRowsSnapshot {
  return {
    source: 'network',
    ...parseProjectAccountSnapshotV1({
      workspaceRefs: [
        {
          id: 'workspace-alpha',
          serverId: 'server-1',
          machineId: 'machine-a',
          rootPath: '/work/alpha',
          createdAtMs: 1,
        },
        {
          id: 'workspace-beta',
          serverId: 'server-1',
          machineId: 'machine-b',
          rootPath: '/work/beta',
          createdAtMs: 1,
        },
      ],
      relationships: [{
        v: 1,
        relationshipId: 'rel-1',
        controllerMachineId: 'machine-b',
        alphaWorkspaceRefId: 'workspace-alpha',
        betaWorkspaceRefId: 'workspace-beta',
        mode: 'keep_both_in_sync',
        contentPolicy,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
      }],
    }),
    graphRevision: 1,
    loadedAtMs: 1,
    organizations: [],
    rows: [],
    scopeKey: 'scope-1',
  };
}

describe('createProductionDaemonWorkspaceSyncRuntime', () => {
  it.each(['distinct SOURCE row id', 'cross-Account same row id'] as const)(
    'copies into the accepted physical TARGET workspace without borrowing its rows into the SOURCE writer graph (%s)', async sourceRowNamespace => {
    const sourceRows: ProjectAccountRowV1[] = [];
    const targetRows: ProjectAccountRowV1[] = [];
    let transport: Awaited<ReturnType<typeof composeInstalledBindTargetTransport>> | undefined;
    const targetCredentials = { token: [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'target-owner' })).toString('base64url'), 'fixture-signature'].join('.'), encryption: null };
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      withTargetChildRuntime: true, projectRowsFromHttp: true, targetCredentials,
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!transport) throw new Error('The real installed TARGET transport was not composed');
        return transport.call(descriptor, context);
      },
      readAdditionalHttpPostResponse: async (url, body, config) => {
        if (url.includes('/v1/account/project-rows/')) {
          if (!url.endsWith('/list')) throw new Error('Finite copy cannot mutate either Account graph');
          const headers = axios.AxiosHeaders.from(config?.headers);
          const rows = headers.get('Authorization') === `Bearer ${targetCredentials.token}` ? targetRows : sourceRows;
          return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        }
        return transport?.homeResponse(url, body);
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const publish = (rows: ProjectAccountRowV1[], refs: readonly typeof fixture.sourceRef[]) => {
      for (const ref of refs) {
        const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: ref.id };
        rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: ref }) }));
      }
      const key = { kind: 'relationship-graph' as const };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: { relationships: [] } }) }));
    };
    // These are the two real owner graphs. There is no logical child row or
    // chosen/physical TARGET row in P1, and no SOURCE row in target-owner.
    // The ordinary physical SOURCE id isolates retained TARGET lookup from the
    // separate cross-Account namespace contract: identical row ids must not
    // collapse the admitted D namespace into a no-op.
    const physicalSourceRef = sourceRowNamespace === 'cross-Account same row id'
      ? { ...fixture.sourceRef, id: fixture.targetChildRef.id }
      : fixture.sourceRef;
    publish(sourceRows, [physicalSourceRef]);
    publish(targetRows, [fixture.targetRef, fixture.targetChildRef]);
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId }));
    await fixture.settleProjects();
    const operationId = 'accepted-physical-copy';
    transport = await composeInstalledBindTargetTransport(fixture, { operationId, releaseReason: 'copy_committed' });
    const source = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!source) throw new Error('The actual SOURCE phase owner was not registered');
    const input = { operationId, accountServerId: fixture.serverId, sourceSessionId: 'actual-source-session',
      action: { kind: 'copy_once' as const, contentPolicy }, sourceMachineId: fixture.childRef.machineId,
      sourceWorkspaceRefId: 'borrower-source-ref', sourceRootPath: fixture.childRef.rootPath,
      targetMachineId: fixture.targetChildRef.machineId, targetWorkspaceRefId: fixture.targetChildRef.id,
      targetRootPath: fixture.targetChildRef.rootPath };
    const sourceContext = { ...transport.sourceContext, signal: new AbortController().signal };
    const prepare = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await source({ v: 1, phase: 'prepare', input }, sourceContext));
    expect(prepare.phase).toBe('prepared');
    if (prepare.phase !== 'prepared') throw new Error('SOURCE did not retain the physical preparation');
    expect(fixture.parent.handoffAdapter.resolvePreparedCopyTarget?.(operationId, fixture.targetRef.id))
      .toMatchObject({ id: fixture.targetRef.id, serverId: fixture.serverId,
        machineId: fixture.targetRef.machineId, rootPath: fixture.targetPath });
    expect(fixture.parent.handoffAdapter.resolvePreparedCopyTarget?.('another-copy', fixture.targetRef.id)).toBeNull();
    expect(fixture.parent.handoffAdapter.resolvePreparedCopyTarget?.(operationId, fixture.targetChildRef.id)).toBeNull();
    expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'final bytes for the admitted child');
    const phaseContext = (phase: 'finalize' | 'commit') => ({ ...sourceContext,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ ...transport!.sourceRouting, phase }) });
    const finalized = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await source({ v: 1, phase: 'finalize', input,
      prepared: prepare.prepared }, phaseContext('finalize')));
    expect(finalized.phase).toBe('finalized');
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('final bytes for the admitted child');
    const committed = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await source({ v: 1, phase: 'commit', input,
      prepared: prepare.prepared }, phaseContext('commit')));
    expect(committed.phase).toBe('committed');
    expect(fixture.parent.handoffAdapter.resolvePreparedCopyTarget?.(operationId, fixture.targetRef.id)).toBeNull();
    expect(sourceRows.filter(row => row.key.kind === 'workspace-ref').map(row => row.key)).toEqual([
      { kind: 'workspace-ref', serverId: fixture.serverId, id: physicalSourceRef.id },
    ]);
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });

  it('keeps a chosen-child Project Root out of its unshared physical parent before purpose admission', async () => {
    const parentReads: string[] = [];
    let admittedChildRead = false;
    const rows: ProjectAccountRowV1[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      withTargetChildRuntime: true,
      readAdditionalHttpResponse: async (url, config) => {
        if (config?.headers?.['x-requester-proof'] !== 'project-requester') return undefined;
        if (url.endsWith('/machines/target-child')) admittedChildRead = true;
        if (!url.endsWith('/machines/target-parent')) return undefined;
        // Home grants the requester Use on chosen D, not generic access to P2.
        parentReads.push(url);
        throw Object.assign(new Error('machine_access_denied'), { response: { status: 403, data: { error: 'machine_access_denied' } } });
      },
      readAdditionalHttpPostResponse: async (url, _body, config) => {
        if (config?.headers?.['x-requester-proof'] !== 'project-requester' || !url.endsWith('/v1/account/project-rows/list')) return undefined;
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      } });
    if (!fixture.targetChild) throw new Error('The actual chosen-child runtime was not composed');
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef, fixture.targetChildRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    // This is an already Home-verified ingress response vector, not a claim
    // that this test issued the Root or exercised public dispatcher selection.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-project-root', binding: {
      accountId: 'project-requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      accountEncryptionMode: 'plain', actionId: 'projects.open', machineId: fixture.targetChildRef.machineId,
      installationId: fixture.targetChildInstallationId, custodianAccountId: 'owner', requestId: 'project-child-open',
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: fixture.targetChildRef.machineId },
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'project-requester', serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => true, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'project-requester', serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid', accountEncryptionMode: 'plain',
      isCurrent: async () => true, createRequestHeaders: async () => ({ 'x-requester-proof': 'project-requester' }) } });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      callerInputAuthorization: authorization, machineAdmission: { actorAccountId: 'project-requester', custodianAccountId: 'owner',
        machineId: fixture.targetChildRef.machineId, installationId: fixture.targetChildInstallationId, role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    const handlers = new Map<string, (request: unknown, context?: RpcHandlerContext) => unknown>();
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
      // Unknown transport input is parsed by the real registered owner.
      handlers.set(method, (request, admitted) => handler(request as Parameters<typeof handler>[0], admitted));
    } };
    registerProjectOpenRpcHandlers(registrar, { serverId: fixture.serverId, machineId: fixture.targetChildRef.machineId,
      runtime: { serverId: fixture.serverId, machineId: fixture.targetChildRef.machineId, accountId: 'owner',
        serverHttpBaseUrl: 'https://bind-child-home.invalid', workspaceSyncAdapter: fixture.targetChild.handoffAdapter,
        readCredentials: async () => { throw new Error('Project requester cannot borrow custodian credentials'); } } });
    const open = handlers.get(RPC_METHODS.PROJECTS_OPEN);
    if (!open) throw new Error('The actual Project ingress was not registered');
    const result = await open({ serverId: fixture.serverId, machineId: fixture.targetChildRef.machineId,
      source: { kind: 'workspace', workspaceId: fixture.sourceRef.id },
      materialization: { kind: 'sync', targetPath: fixture.targetChildRef.rootPath,
        workspaceAction: { kind: 'copy_once', contentPolicy } } }, context);
    // With no genuine purpose producer/Session bootstrap, refusal is safe;
    // generic Parent read/Inspect is not a substitute for that admission.
    expect(result).toMatchObject({ kind: 'refused' });
    expect(admittedChildRead).toBe(true);
    expect(parentReads).toEqual([]);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });

  it('refuses registered recovery of a paused target without retained bootstrap custody', async () => {
    const rows: ProjectAccountRowV1[] = [];
    const writes: unknown[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async (url, body) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        writes.push(body);
        throw new Error('A paused target without custody cannot mutate Account rows');
      } });
    await mkdir(fixture.targetPath);
    await writeFile(join(fixture.targetPath, 'payload.txt'), 'unowned target');
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const key = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key,
      value: { relationships: [{ v: 1, relationshipId: 'paused-without-target-custody',
        controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
        betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_both_in_sync', contentPolicy,
        enabled: false, createdAtMs: 1, updatedAtMs: 1 }] } }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId }));
    const recover = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER);
    if (!recover) throw new Error('The actual target recovery RPC was not registered');
    await expect(recover({ relationshipId: 'paused-without-target-custody', targetMachineId: fixture.targetRef.machineId,
      targetWorkspaceRefId: fixture.targetRef.id }, { signal: new AbortController().signal })).rejects
      .toMatchObject({ code: 'relationship_not_ready' });
    expect(writes).toEqual([]);
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({ enabled: false })]);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('unowned target');
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it('checks retained transient target custody before empty recovery and refuses a replaced root', async () => {
    const rows: ProjectAccountRowV1[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async (url) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        throw new Error('Target recovery cannot mutate Account rows');
      } });
    await mkdir(fixture.targetPath);
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const relationship = { v: 1 as const, relationshipId: 'retained-transient-recovery',
      controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
      betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_both_in_sync' as const, contentPolicy,
      enabled: false, createdAtMs: 1, updatedAtMs: 1 };
    const key = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key,
      value: { relationships: [relationship] } }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId }));
    const prepare = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
    const recover = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER);
    if (!prepare || !recover) throw new Error('The actual target bootstrap/recovery RPCs were not registered');
    const context = { signal: new AbortController().signal };
    await expect(prepare(WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({ v: 1,
      bootstrapOperationId: relationship.relationshipId, owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
      transientRelationship: { ...relationship, enabled: true }, targetWorkspaceRefId: fixture.targetRef.id,
      endpointRole: 'beta', policyDigest: contentPolicy.policyDigest, createIfMissing: true, targetBootstrap: 'use_existing' }), context))
      .resolves.toMatchObject({ state: 'ready' });
    const request = { relationshipId: relationship.relationshipId, targetMachineId: fixture.targetRef.machineId,
      targetWorkspaceRefId: fixture.targetRef.id };
    await expect(recover(request, context)).resolves.toEqual({ status: 'settled' });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    // A new inode at the same path is not the endpoint retained by bootstrap.
    const retainedPath = `${fixture.targetPath}-retained`;
    await rename(fixture.targetPath, retainedPath);
    await mkdir(fixture.targetPath);
    await writeFile(join(fixture.targetPath, 'payload.txt'), 'replacement must survive');
    await expect(recover(request, context)).rejects.toMatchObject({ code: 'root_changed' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('replacement must survive');
    expect(await readdir(retainedPath)).toEqual([]);
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({ enabled: false })]);
  });

  it('keeps cold-disabled transient Sync custody and live flush through unrelated Account row refresh', async () => {
    const rows: ProjectAccountRowV1[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async (url) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        throw new Error('Transient preparation and refresh cannot enable the durable graph');
      } });
    await mkdir(fixture.targetPath);
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const disabled = { v: 1 as const, relationshipId: 'cold-disabled-live-preparation',
      controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
      betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_both_in_sync' as const, contentPolicy,
      enabled: false, createdAtMs: 1, updatedAtMs: 1 };
    const graphKey = { kind: 'relationship-graph' as const };
    const graphRow = ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 0, content: cipher.seal({ key: graphKey,
      value: { relationships: [disabled] } }) });
    rows.push(graphRow);
    const refreshRows = async () => await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId }));
    await refreshRows();
    await fixture.settleProjects();
    const controller = fixture.parent.workspaceSync.controller;
    // The established transient contract starts the actual adapter with enabled
    // runtime intent; it does not publish an enabled Account relationship.
    await expect(controller.ensure({ ...disabled, enabled: true }, undefined,
      { transient: true, targetBootstrap: 'use_existing' })).resolves.toMatchObject({ state: 'watching' });
    const assertRetainedFences = async () => {
      for (const probe of [fixture.probeSource, fixture.probeTarget]) {
        const loan = await probe();
        if (!('kind' in loan)) await loan.release();
        expect(loan).toMatchObject({ kind: 'overlap' });
      }
    };
    await assertRetainedFences();
    expect(rows.find(row => row.key.kind === 'relationship-graph')).toEqual(graphRow);
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([disabled]);

    const refKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    const index = rows.findIndex(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(refKey));
    rows[index] = ProjectAccountRowV1Schema.parse({ key: refKey, revision: 1,
      content: cipher.seal({ key: refKey, value: { ...fixture.sourceRef, label: 'Unrelated display metadata' } }) });
    await refreshRows();
    await fixture.settleProjects();
    await assertRetainedFences();
    expect(rows.find(row => row.key.kind === 'relationship-graph')).toEqual(graphRow);
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([disabled]);
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'latest transient source bytes');
    await expect(controller.flush(disabled.relationshipId)).resolves.toMatchObject({ state: 'watching' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('latest transient source bytes');
  });

  it.each([
    { label: 'foreign Account', accountId: 'bob', authenticationKind: 'account' as const, separateTargetParent: true },
    { label: 'same Account terminal', accountId: 'owner', authenticationKind: 'terminal' as const, separateTargetParent: false },
    { label: 'same Account without persistent caller transport', accountId: 'owner', authenticationKind: 'account' as const, separateTargetParent: false },
  ])('refuses private requester persistent creation before Account mutation while ordinary own creation stays live ($label)', async ({ accountId, authenticationKind, separateTargetParent }) => {
    let phase = 'fixture composition';
    onTestFinished(() => {
      if (phase !== 'completed') console.error('Incomplete requester persistence test', { accountId, phase });
    });
    const ownerRows: ProjectAccountRowV1[] = [];
    // Same-Account principals address the same durable graph even though their
    // admitted transport/automation ceilings are distinct.
    const requesterRows: ProjectAccountRowV1[] = accountId === 'owner' ? ownerRows : [];
    const writes: { actor: 'owner' | 'requester'; request: unknown }[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true, projectRowsFromHttp: true, separateTargetParent,
      onCompositionPhase: current => { phase = current; },
      readAdditionalHttpPostResponse: async (url, body, config) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        const actor = config?.headers?.['x-requester-proof'] === 'requester' ? 'requester' : 'owner';
        const rows = actor === 'requester' ? requesterRows : ownerRows;
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        expect(url.endsWith('/mutate')).toBe(true);
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        writes.push({ actor, request });
        const currentRow = (key: ProjectAccountRowV1['key']) => rows.find(row =>
          buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
        for (const expected of [...request.expectedRefs, ...request.mutations]) {
          const current = currentRow(expected.key);
          if ((current?.revision ?? 'absent') !== expected.expectedRevision) return { status: 200,
            data: { status: 'conflict', key: expected.key, revision: current?.revision ?? -1 } };
        }
        // HTTP persistence is the boundary; real row/CAS and relationship owners
        // validate this complete acknowledged transaction beneath it.
        const changed = request.mutations.map(mutation => ProjectAccountRowV1Schema.parse({ key: mutation.key,
          revision: (currentRow(mutation.key)?.revision ?? -1) + 1, content: mutation.content }));
        for (const row of changed) {
          const index = rows.findIndex(value => buildProjectAccountRowPhysicalKeyV1(value.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
          if (index < 0) rows.push(row); else rows[index] = row;
        }
        return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const source = { ...fixture.sourceRef, id: 'bob-source' };
    const target = { ...fixture.targetRef, id: 'bob-target' };
    for (const value of [source, target]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      requesterRows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const ownerBefore = [...ownerRows];
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId, authentication: { kind: authenticationKind, tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: source.machineId, custodianAccountId: 'owner', installationId: 'parent-installation', actionId: 'projects.open',
      requestId: 'bob-persistent-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: source.machineId },
      accountEncryptionMode: 'plain',
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId, serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => true, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId, serverId: fixture.serverId,
      serverIdentityId: fixture.managedHomeId, serverHttpBaseUrl: 'https://bind-child-home.invalid', accountEncryptionMode: 'plain',
      isCurrent: async () => true, createRequestHeaders: async () => ({ 'x-requester-proof': 'requester' }) } });
    const signal = new AbortController().signal;
    const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', machineId: source.machineId,
        installationId: 'parent-installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const request = { operationId: 'bob-persistent-open', accountServerId: fixture.serverId,
      action: { kind: 'create_relationship' as const, mode: 'keep_synced' as const, contentPolicy, flushBeforeCommit: true as const },
      sourceMachineId: source.machineId, sourceRootPath: source.rootPath, sourceWorkspaceRefId: source.id,
      targetMachineId: target.machineId, targetRootPath: target.rootPath, targetWorkspaceRefId: target.id, signal };
    phase = 'private Project Open';
    const projectResult = await openProject({ serverId: fixture.serverId, machineId: source.machineId,
      source: { kind: 'workspace', workspaceId: source.id },
      materialization: { kind: 'sync', targetPath: target.rootPath, workspaceAction: request.action } }, {
      serverId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid', machineId: source.machineId,
      accountId: 'owner', workspaceSyncAdapter: fixture.parent.handoffAdapter,
      readCredentials: async () => { throw new Error('A requester Project cannot borrow the daemon Account'); },
    }, context);
    expect(writes, JSON.stringify(projectResult)).toEqual([]);
    expect(projectResult).toEqual({ kind: 'refused', code: 'workspace_sync_update_required' });
    phase = 'private adapter preparation';
    const outcome = await fixture.parent.handoffAdapter.prepare(request, undefined, context).then(
      prepared => ({ kind: 'prepared' as const, prepared }),
      (error: unknown) => ({ kind: 'refused' as const, code: error && typeof error === 'object' && 'code' in error ? error.code : null }));
    expect(writes, JSON.stringify(outcome)).toEqual([]);
    expect(outcome).toEqual({ kind: 'refused', code: 'workspace_sync_update_required' });
    expect(ownerRows).toEqual(ownerBefore);
    expect(requesterRows).toHaveLength(2);

    // This fixture's copy-only default has an absent target. Persistent cold
    // reconciliation fences disabled endpoints before bootstrap, so give the
    // ordinary owner a real, empty target with an OS-observable root identity.
    await mkdir(fixture.targetPath);
    const ownRequest = { ...request, operationId: 'own-persistent-open', sourceWorkspaceRefId: undefined, targetWorkspaceRefId: undefined };
    phase = 'ordinary own preparation';
    const ownPreparation = await fixture.parent.handoffAdapter.prepare(ownRequest).then(
      prepared => ({ kind: 'prepared' as const, prepared }),
      (error: unknown) => ({ kind: 'refused' as const, code: error && typeof error === 'object' && 'code' in error ? error.code : null,
        existing: error && typeof error === 'object' && 'existing' in error ? error.existing : null,
        message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
    expect(ownPreparation, JSON.stringify({ phase: 'ordinary-own-prepare', ownPreparation,
      relationships: getActiveProjectAccountRowsSnapshot()?.relationships })).toMatchObject({ kind: 'prepared' });
    if (ownPreparation.kind !== 'prepared') throw new Error('Ordinary owner relationship preparation failed');
    const own = ownPreparation.prepared;
    phase = 'ordinary own finalization';
    await fixture.parent.handoffAdapter.finalize({ operationId: ownRequest.operationId, prepared: own, signal });
    phase = 'ordinary own commit';
    await fixture.parent.handoffAdapter.commit({ operationId: ownRequest.operationId, prepared: own, signal });
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({
      relationshipId: own.relationshipId, enabled: true,
    })]);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every(write => write.actor === 'owner')).toBe(true);
    phase = 'completed';
  });

  it.each([
    { label: 'relationship', sameWorkspace: false,
      action: { kind: 'relationship' as const, relationshipId: 'requester-relationship', flushBeforeCommit: true } },
    { label: 'linked Workspace', sameWorkspace: false, action: { kind: 'linked_workspace' as const } },
    { label: 'same Workspace linked no-op', sameWorkspace: true, action: { kind: 'linked_workspace' as const } },
  ])('keeps private requester Sync siblings at their actual effect boundary ($label)', async ({ sameWorkspace, action }) => {
    const ownerRows: ProjectAccountRowV1[] = [];
    const requesterRows: ProjectAccountRowV1[] = [];
    const writes: { actor: 'owner' | 'requester'; request: unknown }[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async (url, body, config) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        const actor = config?.headers?.['x-requester-proof'] === 'requester' ? 'requester' : 'owner';
        const rows = actor === 'requester' ? requesterRows : ownerRows;
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        expect(url.endsWith('/mutate')).toBe(true);
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        writes.push({ actor, request });
        const currentRow = (key: ProjectAccountRowV1['key']) => rows.find(row =>
          buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
        for (const expected of [...request.expectedRefs, ...request.mutations]) {
          const current = currentRow(expected.key);
          if ((current?.revision ?? 'absent') !== expected.expectedRevision) return { status: 200,
            data: { status: 'conflict', key: expected.key, revision: current?.revision ?? -1 } };
        }
        const changed = request.mutations.map(mutation => ProjectAccountRowV1Schema.parse({ key: mutation.key,
          revision: (currentRow(mutation.key)?.revision ?? -1) + 1, content: mutation.content }));
        for (const row of changed) {
          const index = rows.findIndex(value => buildProjectAccountRowPhysicalKeyV1(value.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
          if (index < 0) rows.push(row); else rows[index] = row;
        }
        return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
      } });
    await mkdir(fixture.targetPath);
    await writeFile(join(fixture.targetPath, 'payload.txt'), 'target unchanged');
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const source = { ...fixture.sourceRef, id: 'requester-source' };
    const target = sameWorkspace ? source : { ...fixture.targetRef, id: 'requester-target' };
    for (const value of sameWorkspace ? [source] : [source, target]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      requesterRows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const graphKey = { kind: 'relationship-graph' as const };
    const graphRow = ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 0, content: cipher.seal({ key: graphKey,
      value: { relationships: sameWorkspace ? [] : [{ v: 1, relationshipId: 'requester-relationship',
        controllerMachineId: source.machineId, alphaWorkspaceRefId: source.id, betaWorkspaceRefId: target.id,
        mode: 'keep_both_in_sync', contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 }] } }) });
    requesterRows.push(graphRow);
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: source.machineId, custodianAccountId: 'owner', installationId: 'parent-installation', actionId: 'projects.open',
      requestId: 'requester-sibling-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: source.machineId },
      accountEncryptionMode: 'plain',
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => true, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      serverIdentityId: fixture.managedHomeId, serverHttpBaseUrl: 'https://bind-child-home.invalid', accountEncryptionMode: 'plain',
      isCurrent: async () => true, createRequestHeaders: async () => ({ 'x-requester-proof': 'requester' }) } });
    const signal = new AbortController().signal;
    const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'owner', machineId: source.machineId,
        installationId: 'parent-installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const directPreparation = await fixture.parent.handoffAdapter.prepare({ operationId: 'requester-sibling-direct',
      accountServerId: fixture.serverId, action, sourceMachineId: source.machineId, targetMachineId: target.machineId,
      sourceRootPath: source.rootPath, targetRootPath: target.rootPath,
      sourceWorkspaceRefId: source.id, targetWorkspaceRefId: target.id, signal }, undefined, context).then(
      prepared => ({ kind: 'prepared' as const, prepared }),
      (error: unknown) => ({ kind: 'refused' as const,
        code: error && typeof error === 'object' && 'code' in error ? error.code : null,
        message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
    expect(writes, JSON.stringify(directPreparation)).toEqual([]);
    if (!sameWorkspace) expect(directPreparation, JSON.stringify(directPreparation))
      .toMatchObject({ kind: 'refused', code: 'workspace_sync_update_required' });
    const result = await openProject({ serverId: fixture.serverId, machineId: source.machineId,
      source: { kind: 'workspace', workspaceId: source.id },
      materialization: { kind: 'sync', targetPath: target.rootPath, workspaceAction: action } }, {
      serverId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid', machineId: source.machineId,
      accountId: 'owner', workspaceSyncAdapter: fixture.parent.handoffAdapter,
      readCredentials: async () => { throw new Error('A requester Project cannot borrow the daemon Account'); },
    }, context);
    expect(writes.filter(write => write.actor === 'owner'), JSON.stringify(result)).toEqual([]);
    expect(ownerRows).toEqual([]);
    expect(requesterRows.find(row => row.key.kind === 'relationship-graph')).toEqual(graphRow);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('target unchanged');
    if (!sameWorkspace) {
      expect(writes).toEqual([]);
      expect(result, JSON.stringify(directPreparation)).toEqual({ kind: 'refused', code: 'workspace_sync_update_required' });
      return;
    }
    expect(result, JSON.stringify({ result, directPreparation })).toMatchObject({ kind: 'opened', directory: source.rootPath,
      workspace: { workspaceId: source.id } });
    const prepared = await fixture.parent.handoffAdapter.prepare({ operationId: 'requester-linked-noop',
      accountServerId: fixture.serverId, action, sourceMachineId: source.machineId, targetMachineId: source.machineId,
      sourceRootPath: source.rootPath, targetRootPath: source.rootPath,
      sourceWorkspaceRefId: source.id, targetWorkspaceRefId: source.id, signal }, undefined, context);
    expect(prepared).toMatchObject({ kind: 'linked_workspace', traversed: [] });
    expect(await fixture.parent.handoffAdapter.finalize({ operationId: prepared.operationId, prepared, signal }))
      .toMatchObject({ kind: 'linked_workspace', traversed: [] });
    expect(await fixture.parent.handoffAdapter.commit({ operationId: prepared.operationId, prepared, signal }))
      .toMatchObject({ kind: 'linked_workspace', traversed: [] });
    expect(writes.every(write => write.actor === 'requester')).toBe(true);
  });

  it('prepares the admitted requester Workspace from private current rows and never the daemon Account projection', async () => {
    let requesterOnly = false;
    const requestHeaders: unknown[] = [];
    let privateRows: unknown[] = [];
    let privateReads = 0;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo,
      readAdditionalHttpResponse: async (_url, config) => {
        if (!requesterOnly) return undefined;
        requestHeaders.push(config?.headers);
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, _data, config) => {
        if (!requesterOnly || !url.endsWith('/project-rows/list')) return undefined;
        requestHeaders.push(config?.headers);
        privateReads += 1;
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows: privateRows } };
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const privateRef = { ...fixture.sourceRef, id: 'bob-source-ref' };
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: privateRef.id };
    privateRows = [{ key, revision: 0, content: cipher.seal({ key, value: privateRef }) }];
    let current = true;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home-identity',
      machineId: fixture.sourceRef.machineId, custodianAccountId: 'owner', installationId: 'parent-installation',
      actionId: 'projects.open', requestId: 'private-project-open', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: fixture.sourceRef.machineId }, accountEncryptionMode: 'plain',
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => current, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      serverIdentityId: 'home-identity', serverHttpBaseUrl: 'https://home.test', accountEncryptionMode: 'plain', isCurrent: async () => current,
      createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
    const signal = new AbortController().signal;
    const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
        installationId: 'parent-installation', role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    requesterOnly = true;
    const request = { ...fixture.prepareInput, operationId: 'private-project-open', signal,
      sourceMachineId: privateRef.machineId, targetMachineId: privateRef.machineId,
      sourceRootPath: privateRef.rootPath, targetRootPath: privateRef.rootPath,
      sourceWorkspaceRefId: privateRef.id, targetWorkspaceRefId: privateRef.id };
    const prepared = await fixture.parent.handoffAdapter.prepare(request, undefined, context);
    expect(prepared).toMatchObject({ kind: 'copy_once', operationId: request.operationId });
    expect(privateReads).toBeGreaterThan(0);
    expect(requestHeaders.length).toBeGreaterThan(0);
    expect(requestHeaders.every(headers => !!headers && typeof headers === 'object'
      && Reflect.get(headers, 'x-requester-proof') === 'bob' && !Reflect.has(headers, 'Authorization'))).toBe(true);
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    current = false;
    await expect(fixture.parent.handoffAdapter.finalize({ operationId: request.operationId, prepared, signal })).rejects.toMatchObject({
      code: 'project_requester_authority_unavailable' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it('composes one daemon-owned runtime and keeps it available after a transient engine start failure', async () => {
    const serverId = 'srv_readiness_home';
    const caseSettingsSnapshot = (): ActiveProjectAccountRowsSnapshot => {
      const snapshot = settingsSnapshot();
      return { ...snapshot, workspaceRefs: snapshot.workspaceRefs.map(ref => ({ ...ref, serverId })) };
    };
    const serverUrl = 'https://readiness-home.invalid';
    const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: serverId,
      canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] });
    const homeTarget = resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
      profile: { id: serverId, serverUrl, webappUrl: serverUrl, homeConnectionDescriptor: descriptor } });
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/v1/features')) throw new Error(`Unexpected Home identity boundary: ${url}`);
      return new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: serverId } } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    let childProjection: DevcontainerChildProjectionV1 | undefined;
    let controllerOnline = true;
    let managedChild: ManagedMachineV1 | undefined;
    socketIo.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: async (_event, payload) => {
      if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Invalid RPC boundary');
      const content = { mode: 'plain' as const };
      const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
      return { ok: true, result: await socketRpcCodec.encodeResponse(content,
        { machine: { ...managedChild, observation: { availability: 'present', observedAt: 1 } } }, decoded.callId) };
    } }));
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const id = url.slice(url.lastIndexOf('/') + 1);
      return { status: 200, data: { machine: { id, active: id !== 'machine-b' || controllerOnline,
        installationId: id === 'machine-b' ? 'controller-installation' : `${id}-installation`,
        devcontainerChild: id === 'bind-child' ? childProjection ?? null : null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/coder', username: 'coder',
          happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier',
          ...(id === 'bind-child' && childProjection ? { devcontainerChild: childProjection } : {}) }) } } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (url.endsWith('/machines/managed/actions/get')) return { status: 200, data: managedChild };
      throw new Error(`Unexpected HTTP boundary: ${url}`);
    });
    onTestFinished(() => { get.mockRestore(); post.mockRestore(); socketIo.mockReset(); fetchBoundary.mockRestore(); });
    type ProductionInput = Parameters<typeof createProductionDaemonWorkspaceSyncRuntime>[0];
    const controller = Object.freeze({
      marker: 'controller',
      resolveLocalResolutionEndpoint: vi.fn(async () => null),
      borrowSourceRootForCopy: vi.fn(async (): Promise<{ handle: unknown; release: () => Promise<void> } | null> => null),
      withAuthorizedSourceSeedExport: vi.fn(async (
        _request: Readonly<{ operationId: string }>,
        exportSource: (sourcePath: string) => Promise<unknown>,
      ) => await exportSource('/work/source')),
      withSourceSeedAuthorization: vi.fn(async (
        _operation: Readonly<{ operationId: string }>,
        _handles: readonly unknown[],
        action: () => Promise<unknown>,
      ) => await action()),
    });
    let handoffAdapter = createWorkspaceSyncHandoffAdapter({
      sync: controller as unknown as Parameters<typeof createWorkspaceSyncHandoffAdapter>[0]['sync'],
      bootstrap: async () => ({ release: async () => undefined }),
    });
    const runtimeStartError = Object.assign(new Error('artifact unavailable'), { code: 'engine_unavailable' });
    const runtime = {
      handoffAdapter,
      managedWorkspaceSync: controller,
      openExternalStream: vi.fn(),
      openRootedAgent: vi.fn(),
      start: vi.fn(async () => { throw runtimeStartError; }),
      stop: vi.fn(async () => undefined),
      whenProjectsSettled: vi.fn(async () => undefined),
    };
    const prepareBootstrapAtTarget = vi.fn(async () => ({
      v: 1 as const,
      bootstrapOperationId: 'copy-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      state: 'ready' as const,
      created: true,
      rootFingerprint: 'a'.repeat(64),
      policyDigest: contentPolicy.policyDigest,
    }));
    const releaseBootstrapAtTarget = vi.fn(async () => ({ ok: true as const, released: true }));
    const targetAuthority = {
      readFileHere: vi.fn(),
      observeEntryHere: vi.fn(),
      stageConflictResolutionHere: vi.fn(async () => undefined),
      applyStagedConflictResolutionHere: vi.fn(async () => ({ status: 'installed' as const })),
      recoverConflictResolutionHere: vi.fn(async () => ({ status: 'settled' as const })),
      stageConflictResolutionAtTarget: vi.fn(async () => undefined),
      applyStagedConflictResolutionAtTarget: vi.fn(async () => ({ status: 'installed' as const })),
      recoverConflictResolutionAtTarget: vi.fn(async () => ({ status: 'settled' as const })),
      prepareConflictResolutionExport: vi.fn(),
      readFileAtTarget: vi.fn(),
      observeEntryAtTarget: vi.fn(),
      prepareBootstrapHere: vi.fn(),
      releaseBootstrapHere: vi.fn(),
      prepareBootstrapAtTarget,
      releaseBootstrapAtTarget,
      acquireWorkspaceSyncMachineIngress: vi.fn(),
      reconcileRetainedBootstraps: vi.fn(async () => undefined),
      releaseAllRetainedBootstraps: vi.fn(async () => undefined),
    };
    const sourceOwnership = Object.freeze({
      owner: { ownerId: 'copy-op-1', canonicalRoot: '/work/alpha', operation: 'handoff' as const },
      renew: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    });
    const rootOwnershipManager = Object.freeze({
      tryAcquire: vi.fn(async () => sourceOwnership),
    });
    const peerIdentityValidator = Object.freeze({
      setExpectedSidecarPid: vi.fn(),
      validate: vi.fn(async () => true),
    });
    const broker = Object.freeze({ marker: 'broker' });
    const createDaemonRuntime = vi.fn<ProductionDaemonWorkspaceSyncFactories['createDaemonRuntime']>(
      (input) => {
        handoffAdapter = createWorkspaceSyncHandoffAdapter({
          sync: controller as unknown as Parameters<typeof createWorkspaceSyncHandoffAdapter>[0]['sync'],
          bootstrap: input.bootstrap,
          prepareBetween: input.handoffPrepareBetween,
          resolveExecutionInput: input.resolveHandoffExecutionInput,
        });
        return { ...runtime, handoffAdapter } as unknown as ReturnType<ProductionDaemonWorkspaceSyncFactories['createDaemonRuntime']>;
      },
    );
    const createTargetAuthority = vi.fn<ProductionDaemonWorkspaceSyncFactories['createTargetAuthority']>(
      () => targetAuthority as unknown as ReturnType<ProductionDaemonWorkspaceSyncFactories['createTargetAuthority']>,
    );
    const createRootOwnershipManager = vi.fn(() => rootOwnershipManager);
    const resolveRootOwnershipDirectory = vi.fn(() => '/user-home/.happier/runtime/workspace-sync-root-ownership');
    const createPeerIdentityValidator = vi.fn(() => peerIdentityValidator);
    const createBroker = vi.fn(async () => broker);
    const spawnSidecar = vi.fn();
    const launchLocalAgent = vi.fn();
    const prepareGitTarget = vi.fn(async () => undefined);
    const relationshipOwner = {
      materializeEndpoints: vi.fn(),
      prepareCreate: vi.fn(),
      setEnabled: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const createRelationshipOwner = vi.fn<ProductionDaemonWorkspaceSyncFactories['createRelationshipOwner']>(
      () => relationshipOwner,
    );
    const refreshProjectRows = vi.fn(async () => ({
      ...caseSettingsSnapshot(),
      graphRevision: 7,
      scopeKey: 'scope-1',
      whenRefreshed: null,
    }));
    const controllerStatus = {
      relationshipId: 'rel-1',
      controllerMachineId: 'machine-b',
      state: 'watching' as const,
      alphaPath: '/work/alpha',
      betaPath: '/work/beta',
      mode: 'keep_both_in_sync' as const,
      endpointStates: {
        alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
        beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
      },
      conflictCount: 0,
      lastCycleObservedAtMs: null,
    };
    const callMachineRpc = vi.fn(async (request: { method: string }) => (
      request.method === 'daemon.directTransfer.export.prepare'
        ? {
            success: true, transferId: 'rel-1', expiresAt: Date.now() + 60_000,
            endpointCandidates: [{
              kind: 'http', url: 'http://127.0.0.1:9999/machine-transfers/direct/source',
              expiresAt: Date.now() + 60_000,
            }],
            sizeBytes: 50, manifestHash: `sha256:${'a'.repeat(64)}`,
          }
        : request.method === 'daemon.workspaceSync.prepareBetween.v1'
        ? { ok: true, traversed: [
            { relationshipId: 'rel-2', policyDigest: contentPolicy.policyDigest, status: { ...controllerStatus, relationshipId: 'rel-2' } },
            { relationshipId: 'rel-1', policyDigest: contentPolicy.policyDigest, status: controllerStatus },
          ] }
        : request.method.startsWith('daemon.workspaceSync.')
        ? { status: controllerStatus }
        : { ok: true }
    ));
    const unsubscribeSettings = vi.fn();
    const subscribeProjectSnapshot = vi.fn(() => unsubscribeSettings);
    const warn = vi.fn();
    const closeTunnel = vi.fn(async () => undefined);
    const openMachineCarrierTunnelCalls: WorkspaceSyncMachineTunnelOpenInput[] = [];
    async function openMachineCarrierTunnel(
      input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'file_transfer' }>,
    ): Promise<FiniteTransferMachineTunnel>;
    async function openMachineCarrierTunnel(
      input: Extract<WorkspaceSyncMachineTunnelOpenInput, { flow: 'workspace_sync' }>,
    ): Promise<WorkspaceSyncMachineTunnel>;
    async function openMachineCarrierTunnel(
      input: WorkspaceSyncMachineTunnelOpenInput,
    ): Promise<FiniteTransferMachineTunnel | WorkspaceSyncMachineTunnel> {
      openMachineCarrierTunnelCalls.push(input);
      const lifecycle = {
        localPort: 48_123,
        observedPath: 'direct' as const,
        close: closeTunnel,
      };
      return input.flow === 'workspace_sync'
        ? { ...lifecycle, localCapability: 'a'.repeat(64) }
        : lifecycle;
    }
    const requestDirectTransferPayloadFile = vi.fn(async (
      _request: Parameters<NonNullable<ProductionInput['requestDirectTransferPayloadFile']>>[0],
    ) => undefined);
    const materializeSeedExport = vi.fn(async (request: Parameters<typeof import('@/workspaces/sync/workspaceSyncSeedTransfer').materializeWorkspaceSyncSeedExport>[0]) => {
      await request.requestPayload({ transferId: 'rel-1', destinationPath: '/tmp/manifest' });
      await request.requestPayload({ transferId: 'rel-1:blob:one', destinationPath: '/tmp/one', expectedSizeBytes: 3, expectedManifestHash: `sha256:${'b'.repeat(64)}` });
      await request.requestPayload({ transferId: 'rel-1:blob:two', destinationPath: '/tmp/two', expectedSizeBytes: 4, expectedManifestHash: `sha256:${'c'.repeat(64)}` });
      return { commit: async () => undefined, abort: async () => undefined };
    });
    const materializeLocalSeed = vi.fn(async () => ({
      commit: async () => undefined,
      abort: async () => undefined,
    }));
    const prepareSourceSeedExport = vi.fn(async () => ({
      payloadSource: { marker: 'payload' },
      onDemandScope: { marker: 'scope' },
    }));
    const activeServerDir = join('/happier-home', 'servers', serverId);
    const inspectLegacyState = vi.fn(async () => ({
      status: 'absent',
      path: join(activeServerDir, 'workspace-replication'),
    }) as WorkspaceSyncLegacyStateInspection);
    let activeSnapshot = caseSettingsSnapshot();
    const factories = {
      createDaemonRuntime,
      createTargetAuthority,
      createRootOwnershipManager,
      resolveRootOwnershipDirectory,
      createPeerIdentityValidator,
      createBroker,
      spawnSidecar,
      launchLocalAgent,
      prepareGitTarget,
      createRelationshipOwner,
      refreshProjectRows,
      getProjectSnapshot: () => activeSnapshot,
      subscribeProjectSnapshot,
      callMachineRpc,
      inspectLegacyState,
      materializeSeedExport,
      materializeLocalSeed,
      prepareSourceSeedExport,
      warn,
    } as unknown as ProductionDaemonWorkspaceSyncFactories;
    const onReadinessPublished = vi.fn();

    const production = await createProductionDaemonWorkspaceSyncRuntime({
      happyHomeDir: '/happier-home',
      activeServerDir,
      activeServerId: serverId,
      homeTarget,
      localMachineId: 'machine-a',
      releaseChannel: 'publicdev',
      credentials: { token: 'secret-token', encryption: null },
      openMachineCarrierTunnel,
      requestDirectTransferPayloadFile,
      onReadinessPublished,
    }, factories);

    const approval: HandoffTargetReplacementApprovalV1 = {
      v: 1 as const,
      consequences: ['replace_nonempty_workspace_target'] as const,
      serverId,
      machineId: 'machine-b',
      canonicalRoot: '/work/beta',
      rootFingerprint: 'a'.repeat(64),
      operationId: 'handoff-action-1',
    };
    const approvedActionInput = {
      sessionId: 'session-1',
      targetMachineId: 'machine-b',
      targetPath: '/work/beta',
      workspaceAction: { kind: 'copy_once' as const, contentPolicy },
    };
    const approvedArtifact = {
      v: 2 as const,
      status: 'executing' as const,
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli' as const },
      executionOriginV1: {
        v: 1 as const,
        authority: 'present_user' as const,
        surface: 'cli' as const,
        caller: { kind: 'host' as const },
        serverId,
        sessionId: 'session-1',
        machineId: 'machine-b',
        actionId: 'session.handoff' as const,
        requestId: 'handoff-action-1',
      },
      approval: { flow: 'deferred' as const, result: 'required' as const },
      actionId: 'session.handoff' as const,
      actionArgs: approvedActionInput,
      summary: 'Approve handoff',
      handoffTargetReplacementApproval: approval,
      decision: { kind: 'approve' as const, decidedAtMs: 2 },
    };
    approvalsGet.mockResolvedValue(approvedArtifact);
    const assertTargetReplacementAuthorized = createTargetAuthority.mock.calls[0]![0].assertTargetReplacementAuthorized;
    if (!assertTargetReplacementAuthorized) throw new Error('target replacement authorizer was not composed');
    await expect(assertTargetReplacementAuthorized('approval-receipt-1', approvedActionInput, approval)).resolves.toBeUndefined();
    expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'approval-receipt-1', serverId });
    const conflictInput = {
      controllerMachineId: 'machine-b',
      hubWorkspaceRefId: 'workspace-beta',
      path: 'conflict.txt',
      source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 1 } },
      targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 1 } }],
      relationshipIds: ['rel-1'],
      strategy: 'use_source' as const,
    } satisfies WorkspaceSyncConflictResolveActionInputV1;
    const conflictArtifact = {
      ...approvedArtifact,
      actionId: 'workspace.sync.conflict.resolve' as const,
      executionOriginV1: {
        ...approvedArtifact.executionOriginV1,
        actionId: 'workspace.sync.conflict.resolve' as const,
        machineId: 'machine-b',
        requestId: 'conflict-request-1',
      },
      actionArgs: conflictInput,
      handoffTargetReplacementApproval: undefined,
    };
    const assertConflictResolutionAuthorized = createTargetAuthority.mock.calls[0]![0].assertConflictResolutionAuthorized;
    if (!assertConflictResolutionAuthorized) throw new Error('conflict authorizer was not composed');
    approvalsGet.mockResolvedValueOnce(conflictArtifact);
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).resolves.toBeUndefined();
    approvalsGet.mockResolvedValueOnce({
      ...conflictArtifact,
      actionArgs: {
        strategy: conflictInput.strategy,
        relationshipIds: [...conflictInput.relationshipIds],
        targets: [...conflictInput.targets],
        source: { ...conflictInput.source },
        path: conflictInput.path,
        hubWorkspaceRefId: conflictInput.hubWorkspaceRefId,
        controllerMachineId: conflictInput.controllerMachineId,
      },
    });
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).resolves.toBeUndefined();
    approvalsGet.mockResolvedValueOnce(conflictArtifact);
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', {
      ...conflictInput,
      source: { ...conflictInput.source, expected: { ...conflictInput.source.expected, digest: 'c'.repeat(40) } },
    })).rejects.toMatchObject({ code: 'approval_stale' });
    approvalsGet.mockResolvedValueOnce({ ...conflictArtifact, v: 1 });
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).rejects.toMatchObject({ code: 'approval_stale' });
    approvalsGet.mockResolvedValueOnce({ ...conflictArtifact, status: 'approved' });
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).rejects.toMatchObject({ code: 'approval_stale' });
    approvalsGet.mockResolvedValueOnce({
      ...conflictArtifact,
      executionOriginV1: { ...conflictArtifact.executionOriginV1, serverId: 'srv_other_home' },
    });
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).rejects.toMatchObject({ code: 'approval_stale' });
    approvalsGet.mockResolvedValueOnce({
      ...conflictArtifact,
      executionOriginV1: { ...conflictArtifact.executionOriginV1, machineId: 'machine-c' },
    });
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).rejects.toMatchObject({ code: 'approval_stale' });
    const staleApprovalCases: Array<readonly [unknown, unknown, HandoffTargetReplacementApprovalV1]> = [
      [{ ...approvedArtifact, status: 'approved' }, approvedActionInput, approval],
      [{ ...approvedArtifact, decision: { kind: 'reject', decidedAtMs: 2 } }, approvedActionInput, approval],
      [{ ...approvedArtifact, actionId: 'session.restore', executionOriginV1: { ...approvedArtifact.executionOriginV1, actionId: 'session.restore' } }, approvedActionInput, approval],
      [{ ...approvedArtifact, executionOriginV1: { ...approvedArtifact.executionOriginV1, serverId: 'srv_other_home' } }, approvedActionInput, approval],
      [{ ...approvedArtifact, executionOriginV1: { ...approvedArtifact.executionOriginV1, requestId: 'other-operation' } }, approvedActionInput, approval],
      [{ ...approvedArtifact, executionOriginV1: { ...approvedArtifact.executionOriginV1, sessionId: 'other-session' } }, approvedActionInput, approval],
      [approvedArtifact, { ...approvedActionInput, targetPath: '/work/other' }, approval],
      [approvedArtifact, { ...approvedActionInput, workspaceAction: { ...approvedActionInput.workspaceAction, kind: 'create_relationship' } }, approval],
      [approvedArtifact, approvedActionInput, { ...approval, canonicalRoot: '/work/other' }],
      [approvedArtifact, approvedActionInput, { ...approval, rootFingerprint: 'b'.repeat(64) }],
      [approvedArtifact, approvedActionInput, { ...approval, machineId: 'machine-c' }],
    ];
    for (const [artifact, actionInput, proof] of staleApprovalCases) {
      approvalsGet.mockResolvedValueOnce(artifact);
      await expect(assertTargetReplacementAuthorized('approval-receipt-1', actionInput, proof)).rejects.toMatchObject({ code: 'approval_stale' });
    }

    const remoteMaterialize = createTargetAuthority.mock.calls[0]![0].bootstrap?.materializeRemoteSeed;
    const remoteSeedCancellation = new AbortController();
    await remoteMaterialize?.({
      operationId: 'rel-1', sourceMachineId: 'machine-b', sourceWorkspaceRefId: 'workspace-beta',
      canonicalRoot: '/work/alpha', contentPolicy,
      materializationReceiptPath: '/work/.alpha.happier-materialization.json',
      originalTargetExists: false,
      targetFence: { state: 'missing', identity: null },
      signal: remoteSeedCancellation.signal,
    });
    expect(openMachineCarrierTunnelCalls.map((request) => request.flow)).toEqual([
      'file_transfer', 'file_transfer', 'file_transfer',
    ]);
    expect(openMachineCarrierTunnelCalls.every((request) => !('operationId' in request))).toBe(true);
    expect(requestDirectTransferPayloadFile).toHaveBeenCalledTimes(3);
    for (const [request] of requestDirectTransferPayloadFile.mock.calls) {
      expect(request.endpointCandidates).toHaveLength(1);
      expect(new URL(request.endpointCandidates[0]!.url).hostname).toBe('127.0.0.1');
      expect(new URL(request.endpointCandidates[0]!.url).port).toBe('48123');
      expect(request.fetchFn).toBeUndefined();
      expect(request.signal).toBe(remoteSeedCancellation.signal);
    }

    expect(inspectLegacyState).toHaveBeenCalledOnce();
    expect(inspectLegacyState).toHaveBeenCalledWith(expect.objectContaining({ activeServerDir }));
    expect(createRootOwnershipManager).toHaveBeenCalledOnce();
    expect(resolveRootOwnershipDirectory).toHaveBeenCalledOnce();
    expect(createRootOwnershipManager).toHaveBeenCalledWith({
      lockDirectory: '/user-home/.happier/runtime/workspace-sync-root-ownership',
    });
    expect(createTargetAuthority).toHaveBeenCalledOnce();
    expect(createDaemonRuntime).toHaveBeenCalledOnce();
    expect(createDaemonRuntime.mock.calls[0]?.[0].observeEntryAtTarget).toBe(targetAuthority.observeEntryAtTarget);
    expect(production.workspaceSync.observeEntryAtTarget).toBe(targetAuthority.observeEntryHere);
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '[DAEMON RUN] Workspace sync engine is initially unavailable; commands and settings changes may retry it',
      runtimeStartError,
    );
    expect(onReadinessPublished).toHaveBeenLastCalledWith({
      engine: { state: 'unavailable', errorCode: 'engine_unavailable' },
      carrier: { state: 'ready' },
    });
    expect(production.handoffAdapter).toBe(handoffAdapter);
    expect(production.workspaceSync.controller).toBe(controller);
    expect(production.workspaceSync.relationshipOwner).toEqual(expect.objectContaining({
      create: expect.any(Function),
      setEnabled: expect.any(Function),
      stop: expect.any(Function),
    }));
    await production.workspaceSync.relationshipOwner.setEnabled('rel-1', false);
    await production.workspaceSync.relationshipOwner.stop('rel-1');
    expect(relationshipOwner.setEnabled).toHaveBeenCalledWith('rel-1', false, undefined);
    expect(relationshipOwner.stop).toHaveBeenCalledWith('rel-1', undefined, undefined);
    expect(createRelationshipOwner).toHaveBeenCalledOnce();

    const relationshipOwnerInput = createRelationshipOwner.mock.calls[0]![0];
    const reconciliationSignal = new AbortController().signal;
    await relationshipOwnerInput.waitForProjectReconciliation(7, reconciliationSignal);
    expect(refreshProjectRows).toHaveBeenCalledWith({
      credentials: { token: 'secret-token', encryption: null },
      signal: reconciliationSignal,
    });
    expect(runtime.whenProjectsSettled).toHaveBeenCalledWith({
      graphRevision: 7,
      scopeKey: 'scope-1',
      signal: reconciliationSignal,
    });

    const daemonRuntimeInput = createDaemonRuntime.mock.calls[0]![0];
    expect(daemonRuntimeInput.relationshipOwner).toEqual(expect.objectContaining({
      materializeEndpoints: expect.any(Function),
      prepareCreate: expect.any(Function),
    }));
    expect(daemonRuntimeInput).toMatchObject({
      daemonDataRoot: join('/happier-home', 'daemon'),
      localMachineId: 'machine-a',
      releaseChannel: 'publicdev',
      rootOwnershipManager,
      spawnSidecar,
      launchLocalAgent,
      openMachineCarrierTunnel,
    });
    await expect(daemonRuntimeInput.resolveWorkspaceRef('workspace-alpha')).resolves.toEqual({
      serverId,
      machineId: 'machine-a',
      rootPath: '/work/alpha',
    });
    await expect(daemonRuntimeInput.resolveWorkspaceRef('workspace-missing')).resolves.toBeNull();
    await daemonRuntimeInput.prepareRelationshipTarget(caseSettingsSnapshot().relationships[0]!);
    expect(prepareBootstrapAtTarget).toHaveBeenCalledWith({
      v: 1,
      bootstrapOperationId: 'rel-1',
      owner: { kind: 'relationship', relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-alpha',
      targetMachineId: 'machine-a',
      endpointRole: 'alpha',
      policyDigest: contentPolicy.policyDigest,
      createIfMissing: true,
    });
    await expect(daemonRuntimeInput.handoffRelationshipController?.flush('rel-1')).resolves.toEqual(controllerStatus);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-b',
      method: 'daemon.workspaceSync.flush.v1',
      request: { relationshipId: 'rel-1' },
    }));

    activeSnapshot = {
      ...activeSnapshot,
      ...parseProjectAccountSnapshotV1({
        ...activeSnapshot,
        workspaceRefs: [
          ...activeSnapshot.workspaceRefs,
          { id: 'workspace-c', serverId, machineId: 'machine-c', rootPath: '/work/c', createdAtMs: 1 },
        ],
        relationships: [
          ...activeSnapshot.relationships,
          { v: 1, relationshipId: 'rel-2', controllerMachineId: 'machine-b', alphaWorkspaceRefId: 'workspace-beta', betaWorkspaceRefId: 'workspace-c', mode: 'keep_both_in_sync', contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 },
        ],
      }),
    };
    // Finite worker dequeue consumes the same routed owner, even when the
    // receiving worker is distinct from the relationship controller.
    await expect(production.handoffAdapter.prepareBetween({
      sourceWorkspaceRefId: 'workspace-c', targetWorkspaceRefId: 'workspace-alpha',
    })).resolves.toMatchObject({ ok: true, traversed: [{ relationshipId: 'rel-2' }, { relationshipId: 'rel-1' }] });
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-b', method: 'daemon.workspaceSync.prepareBetween.v1',
      request: { sourceWorkspaceRefId: 'workspace-c', targetWorkspaceRefId: 'workspace-alpha' },
    }));
    const linkedFence = await daemonRuntimeInput.bootstrap({
      operationId: 'handoff-linked', action: { kind: 'linked_workspace' },
      sourceMachineId: 'machine-c', targetMachineId: 'machine-a',
      sourceWorkspaceRefId: 'workspace-c', targetWorkspaceRefId: 'workspace-alpha',
      sourceRootPath: '/work/c', targetRootPath: '/work/alpha',
    });
    expect(prepareBootstrapAtTarget).toHaveBeenLastCalledWith(expect.objectContaining({
      owner: { kind: 'relationship', relationshipId: 'rel-1' },
      targetWorkspaceRefId: 'workspace-alpha', endpointRole: 'alpha', createIfMissing: false,
    }), undefined);
    expect(prepareBootstrapAtTarget.mock.lastCall).not.toHaveProperty('0.targetBootstrap');
    expect(prepareSourceSeedExport).not.toHaveBeenCalled();
    await linkedFence.release('commit');

    const childRef = { id: 'workspace-child', serverId, machineId: 'bind-child', rootPath: '/child/custom', createdAtMs: 1 };
    const observation = { nativeResourceId: 'container-current', user: 'coder', workspaceFolder: childRef.rootPath,
      storage: { kind: 'bind' as const, hostPath: '/work/beta', childPath: childRef.rootPath } };
    childProjection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer', parentMachineId: 'machine-b' }, observation };
    managedChild = { id: 'managed-child', homeId: serverId, custodianAccountId: 'owner',
      controller: { machineId: 'machine-b', installationId: 'controller-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: observation },
      allocation: 'bound', creationState: 'active', enrolledMachineId: 'bind-child', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    activeSnapshot = { ...activeSnapshot, workspaceRefs: [...activeSnapshot.workspaceRefs, childRef] };
    await expect(production.handoffAdapter.prepareBetween({ sourceWorkspaceRefId: childRef.id,
      targetWorkspaceRefId: 'workspace-alpha' })).resolves.toMatchObject({ ok: true });
    expect(callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'machine-b',
      method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN,
      request: { sourceWorkspaceRefId: childRef.id, targetWorkspaceRefId: 'workspace-alpha' } }));
    const childFence = await daemonRuntimeInput.bootstrap({ operationId: 'child-linked', action: { kind: 'linked_workspace' },
      sourceMachineId: childRef.machineId, targetMachineId: 'machine-a', sourceWorkspaceRefId: childRef.id,
      targetWorkspaceRefId: 'workspace-alpha', sourceRootPath: childRef.rootPath, targetRootPath: '/work/alpha' });
    await childFence.release('commit');
    const childCopyFence = await daemonRuntimeInput.bootstrap({ operationId: 'child-copy', action: { kind: 'copy_once', contentPolicy },
      sourceMachineId: 'machine-a', targetMachineId: childRef.machineId, sourceWorkspaceRefId: 'workspace-alpha',
      targetWorkspaceRefId: childRef.id, sourceRootPath: '/work/alpha', targetRootPath: childRef.rootPath });
    await childCopyFence.release('commit');
    if (!daemonRuntimeInput.resolveHandoffExecutionInput) throw new Error('Production execution mapper is unavailable');
    const newOrdinaryTarget = await daemonRuntimeInput.resolveHandoffExecutionInput({ operationId: 'child-new-ordinary-target',
      action: { kind: 'copy_once', contentPolicy }, sourceMachineId: childRef.machineId, targetMachineId: 'machine-a',
      sourceWorkspaceRefId: childRef.id, sourceRootPath: childRef.rootPath, targetRootPath: '/new-ordinary-target' });
    expect(newOrdinaryTarget.input).toMatchObject({ sourceMachineId: 'machine-b', sourceWorkspaceRefId: 'workspace-beta',
      sourceRootPath: '/work/beta', targetMachineId: 'machine-a', targetRootPath: '/new-ordinary-target' });
    expect(newOrdinaryTarget.input.targetWorkspaceRefId).toBeUndefined();
    await newOrdinaryTarget.assertCurrent();
    controllerOnline = false;
    const rpcCount = callMachineRpc.mock.calls.length;
    await expect(production.handoffAdapter.prepareBetween({ sourceWorkspaceRefId: childRef.id,
      targetWorkspaceRefId: 'workspace-alpha' })).resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_child_unavailable', completed: [] });
    expect(callMachineRpc.mock.calls.length).toBe(rpcCount);
    controllerOnline = true;

    await expect(daemonRuntimeInput.createBroker({
      brokerDir: '/broker',
      brokerInstanceId: 'broker-1',
      launchNonce: 'nonce-1',
      launchSecret: new Uint8Array(32),
      openExternalStream: vi.fn(),
    })).resolves.toBe(broker);
    expect(createPeerIdentityValidator).toHaveBeenCalledOnce();
    expect(createBroker).toHaveBeenCalledWith(expect.objectContaining({ peerIdentityValidator }));

    const targetAuthorityInput = createTargetAuthority.mock.calls[0]![0];
    expect(targetAuthorityInput.bootstrap?.prepareGitTarget).toBe(prepareGitTarget);
    await targetAuthorityInput.bootstrap?.materializeLocalSeed?.({
      operationId: 'local-op',
      sourcePath: '/work/alpha',
      canonicalRoot: '/work/beta',
      contentPolicy,
      materializationReceiptPath: '/work/.beta.happier-materialization.json',
      originalTargetExists: false,
      targetFence: { state: 'missing', identity: null },
    });
    expect(materializeLocalSeed).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'local-op',
      sourcePath: '/work/alpha',
      targetPath: '/work/beta',
      // `all_files` opts out of Git selection, so the seed must not silently
      // narrow to Git's ignore rules.
      workspaceTransfer: {
        includeIgnoredMode: 'exclude',
        ignoredIncludeGlobs: [],
        includeAllIgnored: true,
        extraIgnorePatterns: [],
      },
    }));

    // A Git-selected policy carries the paths the user explicitly opted back in
    // past Git's ignore rules through to the existing SCM enumeration owner.
    const gitPolicyInput = {
      v: 1 as const,
      selection: 'git_worktree' as const,
      extraIgnorePatterns: ['coverage/**'],
      extraIncludePatterns: ['dist/**', 'packages/app/.env.local'],
    };
    const gitPolicy = { ...gitPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(gitPolicyInput) };
    await targetAuthorityInput.bootstrap?.materializeLocalSeed?.({
      operationId: 'local-op-git',
      sourcePath: '/work/alpha',
      canonicalRoot: '/work/beta',
      contentPolicy: gitPolicy,
      materializationReceiptPath: '/work/.beta.happier-materialization.json',
      originalTargetExists: false,
      targetFence: { state: 'missing', identity: null },
    });
    expect(materializeLocalSeed).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceTransfer: {
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**', 'packages/app/.env.local'],
        extraIgnorePatterns: ['coverage/**'],
      },
    }));

    await targetAuthorityInput.prepareSourceSeedExport?.({
      operationId: 'seed-op-git',
      sourceWorkspaceRefId: 'workspace-alpha',
      targetMachineId: 'machine-b',
      contentPolicy: gitPolicy,
    });
    expect(prepareSourceSeedExport).toHaveBeenLastCalledWith(expect.objectContaining({
      operationId: 'seed-op-git',
      sourcePath: '/work/source',
      workspaceTransfer: {
        includeIgnoredMode: 'include_selected',
        ignoredIncludeGlobs: ['dist/**', 'packages/app/.env.local'],
        extraIgnorePatterns: ['coverage/**'],
      },
    }));
    await targetAuthorityInput.callMachineRpc({
      machineId: 'machine-b',
      method: 'daemon.test',
      request: { value: 1 },
    });
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials: { token: 'secret-token', encryption: null },
      machineId: 'machine-b',
      method: 'daemon.test',
      request: { value: 1 },
    });

    const fence = await daemonRuntimeInput.bootstrap({
      operationId: 'copy-op-1',
      action: { kind: 'copy_once', contentPolicy },
      sourceMachineId: 'machine-a',
      targetMachineId: 'machine-b',
      sourceWorkspaceRefId: 'workspace-alpha',
      targetWorkspaceRefId: 'workspace-beta',
      sourceRootPath: '/caller/must/not/cross/the/wire',
      targetRootPath: '/caller/must/not/cross/the/wire/either',
    });
    const releasesBeforeRetry = releaseBootstrapAtTarget.mock.calls.length;
    const sourceReleasesBeforeRetry = sourceOwnership.release.mock.calls.length;
    releaseBootstrapAtTarget.mockRejectedValueOnce(Object.assign(new Error('target temporarily unavailable'), { code: 'peer_unavailable' }));
    await expect(fence.release('commit')).rejects.toMatchObject({ code: 'peer_unavailable' });
    await expect(fence.release('commit')).resolves.toBeUndefined();
    expect(releaseBootstrapAtTarget).toHaveBeenCalledTimes(releasesBeforeRetry + 2);
    expect(releaseBootstrapAtTarget.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      v: 1,
      bootstrapOperationId: 'copy-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      targetMachineId: 'machine-b',
      reason: 'copy_committed',
      signal: expect.objectContaining({ aborted: false }),
    }));
    expect(releaseBootstrapAtTarget.mock.lastCall?.[0]).toHaveProperty('signal', expect.any(AbortSignal));
    expect(sourceOwnership.release).toHaveBeenCalledTimes(sourceReleasesBeforeRetry + 1);

    const releaseLinkedSource = vi.fn(async () => undefined);
    controller.borrowSourceRootForCopy.mockResolvedValueOnce({
      handle: sourceOwnership,
      release: releaseLinkedSource,
    });
    const acquisitionsBeforeLinkedCopy = rootOwnershipManager.tryAcquire.mock.calls.length;
    const linkedCopyFence = await daemonRuntimeInput.bootstrap({
      operationId: 'copy-linked-source',
      action: { kind: 'copy_once', contentPolicy },
      sourceMachineId: 'machine-a',
      targetMachineId: 'machine-b',
      sourceWorkspaceRefId: 'workspace-alpha',
      targetWorkspaceRefId: 'workspace-beta',
      sourceRootPath: '/caller/source',
      targetRootPath: '/caller/target',
    });
    expect(rootOwnershipManager.tryAcquire).toHaveBeenCalledTimes(acquisitionsBeforeLinkedCopy);
    await linkedCopyFence.release('commit');
    expect(releaseLinkedSource).toHaveBeenCalledOnce();

    // Cancellation ends forward synchronization work, but must not cancel the
    // mandatory target cleanup that settles the materialization receipt and
    // discards any target created for this copy operation.
    const cancelledWork = new AbortController();
    const cancelledFence = await daemonRuntimeInput.bootstrap({
      operationId: 'copy-op-cancelled',
      action: { kind: 'copy_once', contentPolicy },
      sourceMachineId: 'machine-a',
      targetMachineId: 'machine-b',
      sourceWorkspaceRefId: 'workspace-alpha',
      targetWorkspaceRefId: 'workspace-beta',
      sourceRootPath: '/caller/must/not/cross/the/wire',
      targetRootPath: '/caller/must/not/cross/the/wire/either',
      signal: cancelledWork.signal,
    });
    releaseBootstrapAtTarget.mockImplementationOnce(async (request) => {
      request.signal?.throwIfAborted();
      return { ok: true as const, released: true };
    });
    cancelledWork.abort();
    await expect(cancelledFence.release('abort')).resolves.toBeUndefined();
    expect(releaseBootstrapAtTarget.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      v: 1,
      bootstrapOperationId: 'copy-op-cancelled',
      targetWorkspaceRefId: 'workspace-beta',
      targetMachineId: 'machine-b',
      reason: 'abort',
    }));
    expect(releaseBootstrapAtTarget.mock.lastCall?.[0].signal?.aborted).toBe(false);
    expect(releaseBootstrapAtTarget.mock.lastCall?.[0].signal).not.toBe(cancelledWork.signal);
    await relationshipOwnerInput.commitRelationshipTarget(caseSettingsSnapshot().relationships[0]!);
    expect(releaseBootstrapAtTarget.mock.lastCall?.[0]).toEqual({
      v: 1,
      bootstrapOperationId: 'rel-1',
      targetWorkspaceRefId: 'workspace-alpha',
      targetMachineId: 'machine-a',
      reason: 'relationship_committed',
    });

    const runtimeStopFailure = new Error('runtime stop failed');
    const authorityStopFailure = new Error('authority stop failed');
    runtime.stop.mockRejectedValueOnce(runtimeStopFailure);
    targetAuthority.releaseAllRetainedBootstraps.mockRejectedValueOnce(authorityStopFailure);
    const stopError = await production.stop().then(() => null, (error: unknown) => error);
    expect(stopError).toBeInstanceOf(AggregateError);
    expect((stopError as AggregateError).errors).toEqual([runtimeStopFailure, authorityStopFailure]);
    expect(unsubscribeSettings).toHaveBeenCalledOnce();
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(targetAuthority.releaseAllRetainedBootstraps).toHaveBeenCalledOnce();

    await expect(production.stop()).resolves.toBeUndefined();
    expect(runtime.stop).toHaveBeenCalledTimes(2);
    expect(targetAuthority.releaseAllRetainedBootstraps).toHaveBeenCalledTimes(2);
  });

  describe('retired legacy-state gate', () => {
    type GateStatus = 'legacy_workspace_sync_state_unsupported' | 'legacy_workspace_sync_state_unknown' | 'absent';

    async function compose(status: GateStatus) {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-prod-ws-sync-gate-'));
      const legacyPath = join(activeServerDir, 'workspace-replication');
      const inspection: WorkspaceSyncLegacyStateInspection = status === 'absent'
        ? { status: 'absent', path: legacyPath }
        : status === 'legacy_workspace_sync_state_unknown'
          ? { status, path: legacyPath, reason: 'test-fixture' }
          : {
            status,
            classification: 'retired_v1',
            path: legacyPath,
            quarantinePath: `${legacyPath}.retired-v1-1700000000000-fixture`,
            schemaVersion: 1,
            inventoryHash: 'a'.repeat(64),
          };
      const inspectLegacyState = vi.fn(async () => inspection);
      const spawnSidecar = vi.fn(async () => {
        throw new Error('sidecar must not spawn while the legacy gate is closed');
      });
      const createBroker = vi.fn(async () => {
        throw new Error('broker must not be created while the legacy gate is closed');
      });
      const launchLocalAgent = vi.fn();
      const callMachineRpc = vi.fn(async () => undefined);
      const warn = vi.fn();
      const unsubscribe = vi.fn();
      const factories = {
        getProjectSnapshot: settingsSnapshot,
        subscribeProjectSnapshot: vi.fn(() => unsubscribe),
        callMachineRpc,
        createBroker,
        spawnSidecar,
        launchLocalAgent,
        inspectLegacyState,
        warn,
      } as unknown as ProductionDaemonWorkspaceSyncFactories;
      const production = await createProductionDaemonWorkspaceSyncRuntime({
        happyHomeDir: activeServerDir,
        activeServerDir,
        localMachineId: 'machine-a',
        releaseChannel: 'publicdev',
        credentials: { token: 'secret-token', encryption: null },
      }, factories);
      return {
        production,
        spawnSidecar,
        createBroker,
        launchLocalAgent,
        callMachineRpc,
        warn,
        inspectLegacyState,
        cleanup: async () => {
          await production.stop();
          await rm(activeServerDir, { recursive: true, force: true });
        },
      };
    }

    it('fail-closes controller and target-authority entry points with the exact typed code', async () => {
      for (const status of ['legacy_workspace_sync_state_unsupported', 'legacy_workspace_sync_state_unknown'] as const) {
        const composed = await compose(status);
        try {
          const { production, spawnSidecar, createBroker, launchLocalAgent, callMachineRpc, warn, inspectLegacyState } = composed;
          expect(inspectLegacyState).toHaveBeenCalledOnce();
          // Startup rehydration is refused observably, with the same typed code.
          expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ code: status }));

          const expectTyped = (run: Promise<unknown>) => expect(run).rejects.toMatchObject({ code: status });
          await expectTyped(production.workspaceSync.controller.get('rel-1'));
          await expectTyped(production.workspaceSync.controller.list());
          await expectTyped(production.workspaceSync.controller.flush('rel-1'));
          await expectTyped(production.workspaceSync.controller.terminate('rel-1'));
          await expectTyped(production.workspaceSync.prepareBootstrapAtTarget({
            v: 1,
            bootstrapOperationId: 'boot-op-1',
            owner: { kind: 'relationship', relationshipId: 'rel-1' },
            targetWorkspaceRefId: 'workspace-alpha',
            endpointRole: 'alpha',
            policyDigest: contentPolicy.policyDigest,
            createIfMissing: true,
          }));
          await expectTyped(production.acquireWorkspaceSyncMachineIngress({
            operationId: 'rel-1',
            sourceMachineId: 'machine-b',
            targetMachineId: 'machine-a',
          }));

          // No process, IPC, agent or machine-RPC side effect may have run.
          expect(createBroker).not.toHaveBeenCalled();
          expect(spawnSidecar).not.toHaveBeenCalled();
          expect(launchLocalAgent).not.toHaveBeenCalled();
          expect(callMachineRpc).not.toHaveBeenCalled();
        } finally {
          await composed.cleanup();
        }
      }
    });

    it('reinspects and reports retired state without exposing a cleanup action', async () => {
      const retired = await compose('legacy_workspace_sync_state_unsupported');
      try {
        await expect(retired.production.workspaceSync.inspectRetiredState())
          .resolves.toMatchObject({
            status: 'legacy_workspace_sync_state_unsupported',
            classification: 'retired_v1',
            schemaVersion: 1,
          });
        expect(retired.inspectLegacyState).toHaveBeenCalledTimes(2);
      } finally {
        await retired.cleanup();
      }

      const unknown = await compose('legacy_workspace_sync_state_unknown');
      try {
        await expect(unknown.production.workspaceSync.inspectRetiredState())
          .resolves.toMatchObject({ status: 'legacy_workspace_sync_state_unknown', reason: 'test-fixture' });
      } finally {
        await unknown.cleanup();
      }
    });

    it('keeps current behavior when inspection reports absent legacy state', async () => {
      const composed = await compose('absent');
      try {
        const { production, spawnSidecar, createBroker, launchLocalAgent, inspectLegacyState } = composed;
        expect(inspectLegacyState).toHaveBeenCalledOnce();

        // The no-op gate lets the call reach the normal engine path.
        const error = await production.workspaceSync.controller.list()
          .then(() => null, (e) => e as { code?: string });
        expect(error).toBeTruthy();
        expect(['legacy_workspace_sync_state_unsupported', 'legacy_workspace_sync_state_unknown']).not.toContain(error!.code);
        expect(error!.code).toBe('engine_unavailable');
        expect(launchLocalAgent).not.toHaveBeenCalled();
      } finally {
        await composed.cleanup();
      }
    });
  });
});

describe('bind-child source handoff through real daemon controllers', () => {

  it('refuses an unavailable same-custodian requester projection before ambient independent target custody', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true });
    const receiver = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!receiver || !fixture.targetParent) throw new Error('Real source and second physical target controllers were not composed');
    const operationId = 'same-owner-source-scoped-token-excludes-target';
    const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ v: 1, phase: 'prepare', input: {
      operationId, accountServerId: fixture.serverId, action: fixture.prepareInput.action,
      sourceMachineId: fixture.childRef.machineId, sourceWorkspaceRefId: fixture.childRef.id, sourceRootPath: fixture.childRef.rootPath,
      targetMachineId: fixture.targetRef.machineId, targetWorkspaceRefId: fixture.targetRef.id,
      targetRootPath: fixture.targetRef.rootPath,
    } });
    const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
        installationId: fixture.childInstallationId, role: 'manage', encryptionMode: 'plain' },
      callerAuthority: 'present_user', workspaceWrites: 'allow',
    });
    // Canonical admitted Home-response boundary vector, NOT a claim that this
    // fixture minted a credential. Actual signer/Home verification belongs to
    // the composed API and server authorization suites. The actor is genuinely
    // the custodian here; only this original credential's target scope is narrow.
    const callerInputAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
      token: 'home-issued-pat-boundary', binding: {
        serverIdentityId: fixture.managedHomeId, accountId: 'owner', principalId: 'owner', credentialId: 'pat',
        custodianAccountId: 'owner', machineId: fixture.childRef.machineId, installationId: fixture.childInstallationId,
        actionId: 'session.handoff', requestId: operationId, requestEnvelopeDigest: 'A'.repeat(43),
        target: { kind: 'machine', machineId: fixture.childRef.machineId },
        grant: { ...API_TOKEN_FULL_GRANT_V1, targets: { sessions: [], machines: [fixture.childRef.machineId] } },
      } });
    const context = (phase: 'prepare' | 'abort', scoped: boolean): RpcHandlerContext => ({ signal: new AbortController().signal,
      machineAdmission: sourceContext.machineAdmission, callerAuthority: sourceContext.callerAuthority,
      ...(scoped ? { callerInputAuthorization } : {}),
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase,
        operationId, accountServerId: fixture.serverId, sourceMachineId: fixture.childRef.machineId,
        sourceRootPath: fixture.childRef.rootPath, sourceContext }),
      verifyMachineAdmissionCurrent: async () => true });
    // Establish this exact ordinary P2 path with the same unsigned custodian:
    // the network and real target owner genuinely admit it and hold custody.
    const unsigned = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await receiver(request, context('prepare', false)));
    if (unsigned.phase !== 'prepared') throw new Error('The ordinary custodian target path did not prepare');
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    expect(await readdir(fixture.targetPath)).toEqual([]);
    await receiver(WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ ...request, phase: 'abort', prepared: unsigned.prepared }),
      context('abort', false));
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const afterUnsignedAbort = await fixture.probeTarget();
    expect(afterUnsignedAbort).not.toHaveProperty('kind');
    if (!('kind' in afterUnsignedAbort)) await afterUnsignedAbort.release();
    // This admitted wire vector has no original-target purpose transport. It
    // refuses before target custody; it does not prove that a genuinely current
    // PAT was minted or admitted for the independently chosen target.
    await expect(receiver(request, context('prepare', true))).rejects.toMatchObject({ code: 'workspace_sync_update_required' });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });

  it('refuses unavailable original target admission before borrowing the custodian physical target authority', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true });
    if (!fixture.targetParent) throw new Error('The second physical target controller was not composed');
    const receiver = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!receiver) throw new Error('Production source phase receiver was not registered');
    const operationId = 'borrower-source-child-to-unadmitted-target-child';
    const originalInput = { operationId, accountServerId: fixture.serverId, action: fixture.prepareInput.action,
      sourceMachineId: fixture.childRef.machineId, sourceWorkspaceRefId: fixture.childRef.id, sourceRootPath: fixture.childRef.rootPath,
      targetMachineId: fixture.targetChildRef.machineId, targetWorkspaceRefId: fixture.targetChildRef.id,
      targetRootPath: fixture.targetChildRef.rootPath };
    const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ v: 1, phase: 'prepare', input: originalInput });
    const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({
      machineAdmission: { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
        installationId: fixture.childInstallationId, role: 'use', encryptionMode: 'plain' },
      callerAuthority: 'present_user', workspaceWrites: 'allow',
      callerInputConstraints: { models: null, permissionModes: ['default'] },
    });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: sourceContext.machineAdmission, callerAuthority: sourceContext.callerAuthority,
      callerInputConstraints: sourceContext.callerInputConstraints,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: request.phase,
        operationId, accountServerId: fixture.serverId, sourceMachineId: fixture.childRef.machineId,
        sourceRootPath: fixture.childRef.rootPath, sourceContext }),
      verifyMachineAdmissionCurrent: async () => true };
    // Home admitted B only on source child C. It denies chosen target D, while
    // the daemon's ambient custodian A can reach physical parent P2. Until the
    // canonical original-target purpose is available, that ambient grant must
    // not be used as the borrower's target authority.
    await expect(receiver(request, context)).rejects.toMatchObject({ code: 'workspace_sync_update_required' });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });

  it('refuses a routed borrower child write ceiling before custody and allows the custodian with write authority', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo });
    const receiver = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!receiver) throw new Error('Production source phase receiver was not registered');
    const sourceSessionId = 'source-child-session';
    const { operationId, accountServerId, action, sourceMachineId, targetMachineId,
      sourceWorkspaceRefId, targetWorkspaceRefId, sourceRootPath, targetRootPath } = fixture.prepareInput;
    const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ v: 1, phase: 'prepare', input: {
      operationId, accountServerId, sourceSessionId, action, sourceMachineId, targetMachineId,
      sourceWorkspaceRefId, targetWorkspaceRefId, sourceRootPath, targetRootPath,
    } });
    const machineAdmission = { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
      installationId: fixture.childInstallationId, role: 'use' as const, encryptionMode: 'plain' as const };
    const deniedOrigin = SessionActionRpcOriginV1Schema.parse({
      v: 1, caller: { kind: 'session', sessionId: sourceSessionId, starterDepth: 0, turnDepth: 0 },
      sourceTurnId: 'source-child-turn', requestId: operationId, callerPermissionMode: 'read-only', workspaceWrites: 'deny',
    });
    // Genuine Home ingress boundary vector: workspaceWrites deny is the deciding ceiling; permission facts travel unchanged.
    const deniedSourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission,
      callerAuthority: 'account_automation', sessionActionOrigin: deniedOrigin,
      callerPermissionMode: 'read-only', workspaceWrites: 'deny',
      callerInputConstraints: { models: null, permissionModes: ['read-only'] },
    });
    const routing = (phase: 'prepare' | 'finalize' | 'commit', sourceContext: ReturnType<typeof WorkspaceSyncSourceContextV1Schema.parse>) =>
      WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase, operationId, accountServerId,
        sourceMachineId, sourceRootPath, sourceSessionId, sourceContext });
    const context = (phase: 'prepare' | 'finalize' | 'commit', sourceContext: ReturnType<typeof WorkspaceSyncSourceContextV1Schema.parse>): RpcHandlerContext => ({
      signal: new AbortController().signal, machineAdmission: sourceContext.machineAdmission,
      callerAuthority: sourceContext.callerAuthority,
      ...(sourceContext.sessionActionOrigin ? { sessionActionOrigin: sourceContext.sessionActionOrigin } : {}),
      ...(sourceContext.callerInputConstraints ? { callerInputConstraints: sourceContext.callerInputConstraints } : {}),
      workspaceSyncSourceRouting: routing(phase, sourceContext), verifyMachineAdmissionCurrent: async () => true,
    });
    const { workspaceWrites: _redundantSourceCeiling, ...deniedOriginOnly } = deniedSourceContext;
    for (const sourceContext of [deniedSourceContext, WorkspaceSyncSourceContextV1Schema.parse(deniedOriginOnly)]) {
      await expect(receiver(request, context('prepare', sourceContext)))
        .rejects.toMatchObject({ code: 'workspace_write_denied' });
    }
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const unacquired = await probe();
      expect(unacquired).not.toHaveProperty('kind');
      if (!('kind' in unacquired)) await unacquired.release();
    }

    // The custodian can choose its own independent target. A source-only
    // borrower grant cannot supply that target admission, even on the same parent.
    const allowedSourceContext = WorkspaceSyncSourceContextV1Schema.parse({
      machineAdmission: { ...machineAdmission, actorAccountId: 'owner', role: 'manage' },
      callerAuthority: 'present_user', workspaceWrites: 'allow' });
    const result = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await receiver(request, context('prepare', allowedSourceContext)));
    if (result.phase !== 'prepared') throw new Error('Routed source preparation did not retain custody');
    expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    expect(await readdir(fixture.targetPath)).toEqual([]);
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'allowed final delta');
    await receiver(WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ ...request, phase: 'finalize', prepared: result.prepared }),
      context('finalize', allowedSourceContext));
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('allowed final delta');
    await receiver(WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ ...request, phase: 'commit', prepared: result.prepared }),
      context('commit', allowedSourceContext));
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const released = await probe();
      expect(released).not.toHaveProperty('kind');
      if (!('kind' in released)) await released.release();
    }
  });

  it.each(['commit', 'abort'] as const)('keeps source custody on the real parent across child preparation and %s', async settlement => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo });
    const work = new AbortController();
    const prepared = await fixture.child.handoffAdapter.prepare({ ...fixture.prepareInput, signal: work.signal });
    expect(prepared).toMatchObject({ kind: 'copy_once', operationId: fixture.prepareInput.operationId });
    expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    // The all-files owner fences an absent/empty target; final copy happens after quiescence.
    expect(await readdir(fixture.targetPath)).toEqual([]);
    if (settlement === 'abort') {
      const { operationId, accountServerId, action, sourceMachineId, targetMachineId,
        sourceWorkspaceRefId, targetWorkspaceRefId, sourceRootPath, targetRootPath } = fixture.prepareInput;
      const originalInput = { operationId, accountServerId, action, sourceMachineId, targetMachineId,
        sourceWorkspaceRefId, targetWorkspaceRefId, sourceRootPath, targetRootPath };
      for (const substitutedInput of [
        { ...originalInput, targetReplacementApprovalReceiptId: 'substituted-receipt' },
        { ...originalInput, targetReplacementApprovalActionInput: { sessionId: 'substituted-session' } },
        { ...originalInput, sourceWorkspaceRefId: 'substituted-source-ref' },
      ]) {
        const forgedAbort = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({
          v: 1, phase: 'abort', input: substitutedInput, prepared,
        });
        await expect(fixture.callWorkspaceSourcePhase({ machineId: fixture.controller.machineId, request: forgedAbort }))
          .rejects.toMatchObject({ code: 'workspace_sync_operation_conflict' });
        expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
        expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
      }
    }
    // The Session coordinator quiesces the original child Session before this final source delta.
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'after quiesce');
    await fixture.child.handoffAdapter.finalize({ operationId: fixture.prepareInput.operationId, prepared });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('after quiesce');
    expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
    if (settlement === 'abort') {
      work.abort();
      fixture.driftNativeRoot();
    }
    await fixture.child.handoffAdapter[settlement]({ operationId: fixture.prepareInput.operationId, prepared, signal: work.signal });
    const releasedSource = await fixture.probeSource();
    expect(releasedSource).not.toHaveProperty('kind');
    if (!('kind' in releasedSource)) await releasedSource.release();
    const releasedTarget = await fixture.probeTarget();
    expect(releasedTarget).not.toHaveProperty('kind');
    if (!('kind' in releasedTarget)) await releasedTarget.release();
    if (settlement === 'commit') expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('after quiesce');
    else await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses fresh native source drift before final copy and releases parent custody on abort', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo });
    const prepared = await fixture.child.handoffAdapter.prepare(fixture.prepareInput);
    fixture.driftNativeRoot();
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'must not copy');
    await expect(fixture.child.handoffAdapter.finalize({ operationId: fixture.prepareInput.operationId, prepared }))
      .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    expect(await readdir(fixture.targetPath)).toEqual([]);
    await fixture.child.handoffAdapter.abort({ operationId: fixture.prepareInput.operationId, prepared });
    const releasedSource = await fixture.probeSource();
    expect(releasedSource).not.toHaveProperty('kind');
    if (!('kind' in releasedSource)) await releasedSource.release();
  });

  it('requires source-phase support before quiescence or acquiring parent custody', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, sourcePhaseUnavailable: true });
    await expect(fixture.child.handoffAdapter.prepare(fixture.prepareInput))
      .rejects.toMatchObject({ code: 'workspace_sync_update_required' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const unacquiredSource = await fixture.probeSource();
    expect(unacquiredSource).not.toHaveProperty('kind');
    if (!('kind' in unacquiredSource)) await unacquiredSource.release();
  });
});

describe('admitted shared bind-child target through the existing registered target RPCs', () => {
  it('preflights the original borrower child grant at its physical parent without a parent grant', async () => {
    let transportFixture: Awaited<ReturnType<typeof composeBindChildSourcePhaseTestRuntime>> | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo,
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!transportFixture) throw new Error('Target transport was used before runtime composition finished');
        expect(descriptor.machineId).toBe(transportFixture.controller.machineId);
        expect(descriptor.method).toBe(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT);
        expect(descriptor.request).toEqual(request);
        expect(context.machineAdmission).toEqual({ actorAccountId: 'borrower', custodianAccountId: 'owner',
          machineId: transportFixture.childRef.machineId, installationId: transportFixture.childInstallationId,
          role: 'use', encryptionMode: 'plain' });
        const targetContext = WorkspaceSyncSourceContextV1Schema.parse({
          machineAdmission: context.machineAdmission, callerAuthority: context.callerAuthority,
          ...(context.callerInputConstraints ? { callerInputConstraints: context.callerInputConstraints } : {}),
        });
        const routing = WorkspaceSyncTargetRoutingV1Schema.parse({ ...descriptor.routing, targetContext });
        expect(routing).toMatchObject({ v: 1, phase: 'preflight', operationId: request.operationId,
          accountServerId: transportFixture.serverId, targetMachineId: transportFixture.childRef.machineId,
          targetRootPath: transportFixture.childRef.rootPath });
        const receiver = transportFixture.parentRpcHandlers.get(descriptor.method);
        if (!receiver) throw new Error('Existing physical-parent target receiver was not registered');
        // Genuine Home relay boundary: retain the original child admission; no physical-parent grant is invented.
        return await receiver(descriptor.request, { ...context,
          signal: descriptor.signal ?? context.signal, workspaceSyncTargetRouting: routing });
      },
    });
    transportFixture = fixture;
    if (fixture.projection.observation.storage.kind !== 'bind') throw new Error('Expected a current native bind observation');
    fixture.projection.observation.storage.hostPath = fixture.targetPath;
    await mkdir(fixture.targetPath);
    await writeFile(join(fixture.targetPath, 'existing.txt'), 'reviewed parent target bytes');
    const handlers = new Map<string, (request: unknown, context?: RpcHandlerContext) => unknown>();
    const registrar: RpcHandlerRegistrar = { registerHandler(method, handler) {
      // This network boundary supplies unknown input; registered handlers perform the real strict-schema parse.
      handlers.set(method, (request, context) => handler(request as Parameters<typeof handler>[0], context));
    } };
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: registrar, service: fixture.child.workspaceSync });
    const receiver = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT);
    if (!receiver) throw new Error('Existing child target receiver was not registered');
    const request = { v: 1 as const, serverId: fixture.serverId, machineId: fixture.childRef.machineId,
      targetPath: fixture.childRef.rootPath, operationId: 'shared-child-target-preflight',
      destinationIntent: 'materialize_from_source_workspace' as const };
    // Admitted selected-child receiver boundary only; ordinary socket first-hop admission has its own owner tests.
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
        installationId: fixture.childInstallationId, role: 'use', encryptionMode: 'plain' },
      callerInputConstraints: { models: null, permissionModes: ['default'] },
      verifyMachineAdmissionCurrent: async () => true };
    const result = await receiver(request, context);
    expect(result).toMatchObject({ type: 'approval_required', approval: {
      machineId: fixture.childRef.machineId, canonicalRoot: fixture.childRef.rootPath,
      serverId: fixture.serverId, operationId: request.operationId,
      rootFingerprint: await computeWorkspaceSyncRootFingerprint(fixture.targetPath),
      consequences: ['replace_nonempty_workspace_target'],
    } });
    expect(await readFile(join(fixture.targetPath, 'existing.txt'), 'utf8')).toBe('reviewed parent target bytes');
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
    fixture.driftNativeRoot();
    await expect(receiver(request, context)).rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    expect(await readFile(join(fixture.targetPath, 'existing.txt'), 'utf8')).toBe('reviewed parent target bytes');
  });
});

describe('retained admitted bind-child target custody', () => {
  it('captures the installed physical target before prepare and releases cross-custodian custody after a completed acknowledgement is lost', async () => {
    const work = new AbortController();
    let releaseAcknowledgement = () => {};
    const acknowledgementWithheld = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    const operationId = 'runtime-installed-target-lost-ack';
    let transport: Awaited<ReturnType<typeof composeInstalledBindTargetTransport>> | undefined;
    let endpointBeforePrepare: import('@happier-dev/protocol/machines/identity/installationIdentity').MachineInstallationPublicIdentityV1 | undefined;
    const targetCredentials = { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'target-owner' })).toString('base64url'), 'fixture-signature',
    ].join('.'), encryption: null };
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      withTargetChildRuntime: true, targetCredentials,
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!transport) throw new Error('Installed target transport was used before composition');
        return await transport.call(descriptor, context);
      },
      readAdditionalHttpPostResponse: async (url, raw) => await transport?.homeResponse(url, raw),
    });
    transport = await composeInstalledBindTargetTransport(fixture, { operationId,
      onCompletedPrepare: async () => {
        if (!transport) throw new Error('Actual installed transport was not retained');
        endpointBeforePrepare = transport.observed.preflightEndpoint;
        expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
        expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
        // The receiver is finished on its independent lifetime. The sender's
        // CANCEL cannot roll it back and never reaches a live receiver signal.
        transport.retire();
        work.abort();
        await acknowledgementWithheld;
      } });
    const input = { ...fixture.prepareInput, operationId, signal: work.signal,
      sourceSessionId: transport.sourceRouting.sourceSessionId,
      targetMachineId: fixture.targetChildRef.machineId, targetWorkspaceRefId: fixture.targetChildRef.id,
      targetRootPath: fixture.targetChildRef.rootPath };
    const source = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!source) throw new Error('The actual SOURCE phase owner was not registered');
    // Build the canonical wire fixture, not the host-private preparation input
    // (which contains callbacks and a process-local AbortSignal).
    const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ v: 1, phase: 'prepare', input: {
      operationId: input.operationId, accountServerId: input.accountServerId,
      sourceSessionId: input.sourceSessionId, action: input.action,
      sourceMachineId: input.sourceMachineId, sourceWorkspaceRefId: input.sourceWorkspaceRefId,
      sourceRootPath: input.sourceRootPath, targetMachineId: input.targetMachineId,
      targetWorkspaceRefId: input.targetWorkspaceRefId, targetRootPath: input.targetRootPath,
    } });
    try {
      await expect(source(request, {
        ...transport.sourceContext, signal: work.signal,
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(transport.observed.prepared).toBe(true);
      expect(endpointBeforePrepare).toMatchObject({ machineId: fixture.targetRef.machineId,
        installationId: fixture.managedTargetChild.controller.installationId });
      expect(transport.observed.releaseDestination).toBe(fixture.targetRef.machineId);
      // Both real writer loans must be available again, and aborted target
      // materialization restores absence rather than preserving uncommitted bytes.
      for (const probe of [fixture.probeSource, fixture.probeTarget]) {
        const loan = await probe();
        expect(loan).not.toHaveProperty('kind');
        if (!('kind' in loan)) await loan.release();
      }
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    } finally { releaseAcknowledgement(); }
  });

  it('releases physical target custody when cancellation loses a completed preparation acknowledgement', async () => {
    const work = new AbortController();
    const completedTargetRequest = new AbortController();
    let releaseAcknowledgement = () => {};
    const acknowledgementWithheld = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    let currentFixture: Awaited<ReturnType<typeof composeBindChildSourcePhaseTestRuntime>> | undefined;
    let targetPrepared = false;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      handleAdditionalSocketAck: async raw => {
        if (!raw || typeof raw !== 'object' || !('method' in raw)
          || raw.method !== `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`) return undefined;
        if (!currentFixture || !('params' in raw)) throw new Error('Physical target network fixture was not composed');
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, raw.params, raw.method);
        const receiver = currentFixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
        if (!receiver) throw new Error('Real physical target prepare receiver was not registered');
        // Genuine Account socket admission to ordinary P2, not the unfinished
        // borrowed-child first-hop producer. The target service stays real.
        const result = await receiver(decoded.params, { signal: completedTargetRequest.signal, callerAuthority: 'present_user',
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: currentFixture.targetRef.machineId,
            installationId: currentFixture.managedTargetChild.controller.installationId, role: 'manage', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => true });
        expect(result).toMatchObject({ state: 'ready', created: true });
        expect(await currentFixture.probeSource()).toMatchObject({ kind: 'overlap' });
        expect(await currentFixture.probeTarget()).toMatchObject({ kind: 'overlap' });
        expect(await readdir(currentFixture.targetPath)).toEqual([]);
        targetPrepared = true;
        const acknowledgement = { ok: true,
          result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) };
        // Preparation has completed, but the real callSocketRpc caller never
        // receives its receipt: cancellation races the network acknowledgement.
        // The completed remote request is no longer cancellable by the relay;
        // the receiver's separate signal therefore remains live.
        work.abort();
        await acknowledgementWithheld;
        return acknowledgement;
      } });
    currentFixture = fixture;
    const input = { ...fixture.prepareInput, operationId: 'cancel-completed-target-preparation', signal: work.signal,
      sourceMachineId: fixture.sourceRef.machineId, sourceWorkspaceRefId: fixture.sourceRef.id,
      sourceRootPath: fixture.sourcePath };
    try {
      await expect(fixture.parent.handoffAdapter.prepare(input)).rejects.toThrow();
      expect(targetPrepared).toBe(true);
      // This local preparation never proceeds to finalize/copy. Neither
      // writer's custody may be stranded by the lost acknowledgement.
      expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      for (const probe of [fixture.probeSource, fixture.probeTarget]) {
        const loan = await probe();
        expect(loan).not.toHaveProperty('kind');
        if (!('kind' in loan)) await loan.release();
      }
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      releaseAcknowledgement();
    }
  });

  it('releases the same target loan directly from its authenticated source writer after the chosen child retires', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true });
    const prepare = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
    const release = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE);
    if (!prepare || !release) throw new Error('Existing physical-parent target receivers were not registered');
    const operationId = 'source-writer-retained-target';
    const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({ v: 1, bootstrapOperationId: operationId,
      owner: { kind: 'copy_once', operation: { v: 1, operationId, controllerMachineId: fixture.sourceRef.machineId,
        alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
        contentPolicy: fixture.prepareInput.action.contentPolicy } }, targetWorkspaceRefId: fixture.targetRef.id,
      endpointRole: 'beta', policyDigest: contentPolicy.policyDigest, createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace' });
    const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({
      machineAdmission: { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
        installationId: fixture.childInstallationId, role: 'use', encryptionMode: 'plain' },
      callerAuthority: 'account_automation', workspaceWrites: 'allow',
      callerInputConstraints: { models: null, permissionModes: ['default'] },
    });
    const targetContext = WorkspaceSyncSourceContextV1Schema.parse({ ...sourceContext,
      machineAdmission: { ...sourceContext.machineAdmission, machineId: fixture.targetChildRef.machineId,
        installationId: fixture.targetChildInstallationId } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: fixture.controller,
      source: { v: 1, phase: 'prepare', operationId, accountServerId: fixture.serverId,
        sourceMachineId: fixture.childRef.machineId, sourceRootPath: fixture.childRef.rootPath,
        sourceSessionId: 'actual-source-session', sourceContext },
      target: { v: 1, phase: 'prepare', operationId, accountServerId: fixture.serverId,
        targetMachineId: fixture.targetChildRef.machineId, targetRootPath: fixture.targetChildRef.rootPath } });
    // These are actual Home verification response boundaries. The server suites
    // own installed socket/signature/Root checks; the real receiver owns its loan.
    const prepareContext = { signal: new AbortController().signal,
      machineAdmission: targetContext.machineAdmission, callerAuthority: targetContext.callerAuthority,
      callerInputConstraints: targetContext.callerInputConstraints,
      workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({ ...routing.target, targetContext }),
      workspaceSyncSourceWriterTargetRouting: routing, verifyMachineAdmissionCurrent: async () => true };
    await expect(prepare(request, prepareContext)).resolves.toMatchObject({ state: 'ready', created: true });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    fixture.driftTargetNativeRoot();
    delete fixture.managedTargetChild.enrolledMachineId;
    const cleanupRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...routing,
      target: { ...routing.target, phase: 'release' } });
    const releaseContext = { signal: new AbortController().signal, callerAuthority: 'present_user' as const,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', ...fixture.controller,
        role: 'manage' as const, encryptionMode: 'plain' as const },
      // No D grant, Session bootstrap, or retired Root bearer accompanies release.
      workspaceSyncSourceWriterTargetRouting: cleanupRouting, verifyMachineAdmissionCurrent: async () => true };
    const releaseRequest = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse({ v: 1, bootstrapOperationId: operationId,
      targetWorkspaceRefId: fixture.targetRef.id, reason: 'abort' });
    for (const substituted of [
      WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...cleanupRouting,
        sourceWriter: { machineId: 'unrelated-parent', installationId: 'unrelated-installation' } }),
      WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...cleanupRouting,
        source: { ...cleanupRouting.source, sourceContext: { ...sourceContext, workspaceWrites: 'deny' } } }),
      WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...cleanupRouting,
        source: { ...cleanupRouting.source, sourceContext: { ...sourceContext,
          machineAdmission: { ...sourceContext.machineAdmission, actorAccountId: 'another-borrower' } } } }),
      WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...cleanupRouting,
        source: { ...cleanupRouting.source, sourceRootPath: '/another/source' } }),
    ]) {
      const forgedContext = { ...releaseContext, workspaceSyncSourceWriterTargetRouting: substituted,
        machineAdmission: { ...releaseContext.machineAdmission, ...substituted.sourceWriter } };
      await expect(release(releaseRequest, forgedContext)).rejects.toHaveProperty('code');
      expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    }
    const unknownOperation = 'never-prepared-target';
    await expect(release({ ...releaseRequest, bootstrapOperationId: unknownOperation }, { ...releaseContext,
      workspaceSyncSourceWriterTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...cleanupRouting,
        target: { ...cleanupRouting.target, operationId: unknownOperation } }) }))
      .resolves.toEqual({ ok: true, released: false });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    await expect(release(releaseRequest, releaseContext)).resolves.toEqual({ ok: true, released: true });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const released = await fixture.probeTarget();
    expect(released).not.toHaveProperty('kind');
    if (!('kind' in released)) await released.release();
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it('denies target writes before custody and releases only the exact retained child context after drift or revocation', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true });
    const prepare = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
    const release = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE);
    if (!prepare || !release) throw new Error('Existing physical-parent target receivers were not registered');
    const operationId = 'retained-borrower-child-target';
    const request = WorkspaceSyncTargetBootstrapPrepareV1Schema.parse({ v: 1, bootstrapOperationId: operationId,
      owner: { kind: 'copy_once', operation: { v: 1, operationId, controllerMachineId: fixture.sourceRef.machineId,
        alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
        contentPolicy: fixture.prepareInput.action.contentPolicy } },
      targetWorkspaceRefId: fixture.targetRef.id, endpointRole: 'beta',
      policyDigest: fixture.prepareInput.action.contentPolicy.policyDigest,
      createIfMissing: true, targetBootstrap: 'materialize_from_source_workspace' });
    const allowed = WorkspaceSyncSourceContextV1Schema.parse({
      machineAdmission: { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.targetChildRef.machineId,
        installationId: fixture.targetChildInstallationId, role: 'use', encryptionMode: 'plain' },
      callerAuthority: 'present_user', workspaceWrites: 'allow',
      callerInputConstraints: { models: null, permissionModes: ['default'] },
    });
    let borrowerGrantCurrent = true;
    const context = (phase: 'prepare' | 'release', targetContext: ReturnType<typeof WorkspaceSyncSourceContextV1Schema.parse>): RpcHandlerContext => ({
      signal: new AbortController().signal, machineAdmission: targetContext.machineAdmission,
      callerAuthority: targetContext.callerAuthority, callerInputConstraints: targetContext.callerInputConstraints,
      ...(targetContext.sessionActionOrigin ? { sessionActionOrigin: targetContext.sessionActionOrigin } : {}),
      workspaceSyncTargetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({ v: 1, phase, operationId,
        accountServerId: fixture.serverId, targetMachineId: fixture.targetChildRef.machineId,
        targetRootPath: fixture.targetChildRef.rootPath, targetContext }),
      // New work consumes the current borrower grant. Cleanup's Home-verified
      // physical custodian socket remains current after that grant is revoked;
      // its original child authority must come from the retained operation.
      verifyMachineAdmissionCurrent: async () => phase === 'release' || borrowerGrantCurrent,
    });
    const denied = WorkspaceSyncSourceContextV1Schema.parse({ ...allowed, workspaceWrites: 'deny' });
    await expect(prepare(request, context('prepare', denied))).rejects.toMatchObject({ code: 'workspace_write_denied' });
    const { workspaceWrites: _redundantTargetCeiling, ...targetWithoutCeiling } = allowed;
    const deniedOriginOnly = WorkspaceSyncSourceContextV1Schema.parse({ ...targetWithoutCeiling,
      callerAuthority: 'account_automation', sessionActionOrigin: SessionActionRpcOriginV1Schema.parse({
        v: 1, caller: { kind: 'session', sessionId: 'source-child-session', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'source-child-turn', requestId: operationId, callerPermissionMode: 'read-only', workspaceWrites: 'deny',
      }) });
    await expect(prepare(request, context('prepare', deniedOriginOnly))).rejects.toMatchObject({ code: 'workspace_write_denied' });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const unacquired = await fixture.probeTarget();
    expect(unacquired).not.toHaveProperty('kind');
    if (!('kind' in unacquired)) await unacquired.release();
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');

    await expect(prepare(request, context('prepare', allowed))).resolves.toMatchObject({
      state: 'ready', bootstrapOperationId: operationId, targetWorkspaceRefId: fixture.targetRef.id, created: true,
    });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    expect(await readdir(fixture.targetPath)).toEqual([]);
    const releaseRequest = WorkspaceSyncTargetBootstrapReleaseV1Schema.parse({ v: 1, bootstrapOperationId: operationId,
      targetWorkspaceRefId: fixture.targetRef.id, reason: 'abort' });
    for (const substituted of [
      WorkspaceSyncSourceContextV1Schema.parse({ ...allowed,
        machineAdmission: { ...allowed.machineAdmission, actorAccountId: 'another-borrower' } }),
      denied,
    ]) {
      await expect(release(releaseRequest, context('release', substituted)))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    }
    fixture.driftTargetNativeRoot();
    delete fixture.managedTargetChild.enrolledMachineId;
    borrowerGrantCurrent = false;
    await expect(prepare(request, context('prepare', allowed)))
      .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    await expect(release(releaseRequest, context('release', allowed))).resolves.toEqual({ ok: true, released: true });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const released = await fixture.probeTarget();
    expect(released).not.toHaveProperty('kind');
    if (!('kind' in released)) await released.release();
    // A settled/unknown release keeps the existing idempotent cleanup contract.
    await expect(release(releaseRequest, context('release', allowed))).resolves.toEqual({ ok: true, released: false });
  });
});

describe('captured immutable Home across distinct local Sync profiles', () => {
  async function composeHomeFixture(observedHomeId: string) {
    const managedHomeId = 'srv_physical_home';
    const serverUrl = 'https://physical-home.invalid';
    const descriptor = HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: managedHomeId,
      canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] });
    const target = (profileId: string) => resolveHomeTargetFromDescriptor({ descriptor, authority: 'saved_profile',
      profile: { id: profileId, serverUrl, webappUrl: serverUrl, homeConnectionDescriptor: descriptor } });
    // Fresh live Home identity is a genuine network boundary; the resolver,
    // descriptor parser and runtime/fact-reader authority remain real.
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/v1/features')) throw new Error(`Unexpected Home identity boundary: ${url}`);
      return new Response(JSON.stringify({ features: {}, capabilities: {
        serverIdentity: { serverIdentityId: observedHomeId },
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    onTestFinished(() => { fetchBoundary.mockRestore(); });
    return await composeBindChildSourcePhaseTestRuntime({ socketIo,
      serverId: managedHomeId, parentServerId: managedHomeId, managedHomeId,
      homeTarget: target('child-profile'), parentHomeTarget: target('parent-profile') });
  }

  it('maps public immutable Home WorkspaceRefs across two distinct captured local profiles without changing the original request', async () => {
    const fixture = await composeHomeFixture('srv_physical_home');
    for (const ref of [fixture.sourceRef, fixture.childRef, fixture.targetRef]) {
      expect(ref.serverId).toBe('srv_physical_home');
    }
    const receiver = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!receiver) throw new Error('Production source phase receiver was not registered');
    const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
        installationId: fixture.childInstallationId, role: 'manage', encryptionMode: 'plain' },
      callerAuthority: 'present_user', workspaceWrites: 'allow',
    });
    const input = { ...fixture.prepareInput, callWorkspaceSourcePhase: async (descriptor: Readonly<{
      machineId: string; request: unknown; signal?: AbortSignal;
    }>) => {
      const request = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse(descriptor.request);
      expect(descriptor.machineId).toBe(fixture.sourceRef.machineId);
      expect(request.input).toMatchObject({ accountServerId: 'srv_physical_home',
        sourceMachineId: fixture.childRef.machineId, sourceRootPath: fixture.childRef.rootPath,
        targetMachineId: fixture.targetRef.machineId, targetRootPath: fixture.targetPath });
      // The parent resolves only its captured parent-profile. The public Home
      // qualifier crosses this relay unchanged; neither daemon rewrites the
      // canonical Account WorkspaceRefs to local aliases.
      const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: request.phase,
        operationId: request.input.operationId, accountServerId: request.input.accountServerId,
        sourceMachineId: request.input.sourceMachineId, sourceRootPath: request.input.sourceRootPath, sourceContext });
      return await receiver(request, { signal: descriptor.signal ?? new AbortController().signal,
        machineAdmission: sourceContext.machineAdmission, callerAuthority: sourceContext.callerAuthority,
        workspaceSyncSourceRouting: routing, verifyMachineAdmissionCurrent: async () => true });
    } };
    const prepared = await fixture.child.handoffAdapter.prepare(input);
    expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'same Home final delta');
    await fixture.child.handoffAdapter.finalize({ operationId: input.operationId, prepared });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('same Home final delta');
    await fixture.child.handoffAdapter.commit({ operationId: input.operationId, prepared });
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });

  it('refuses a fresh foreign immutable Home before bind custody or filesystem effects', async () => {
    const fixture = await composeHomeFixture('srv_foreign_home');
    await expect(fixture.child.handoffAdapter.prepare(fixture.prepareInput))
      .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });
});
