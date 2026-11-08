import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
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
import { WorkspaceSyncConflictResolutionResultV1Schema, WorkspaceSyncRelationshipCreateResultV1Schema, WorkspaceSyncRelationshipsListRpcResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncTargetRoutingV1Schema, WorkspaceSyncSourceContextV1Schema,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema, SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { registerMachineWorkspaceSyncRpcHandlers } from '@/api/machine/rpcHandlers.workspaceSync';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readMachineActionRpcResult } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { WorkspaceSyncTargetConflictRecoverResultV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { ProjectWorkerActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { computeWorkspaceSyncRootFingerprint } from '@/workspaces/sync/workspaceSyncTargetBootstrap';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import { deriveWorkspaceSyncRelationshipId } from '@/workspaces/sync/workspaceSyncRelationshipIdentity';
import { composeBindChildSourcePhaseTestRuntime, composeInstalledBindTargetTransport } from './createProductionDaemonWorkspaceSyncRuntime.testkit';
import { openProject } from '@/workspaces/activation/openProject';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createProjectAccountRowsHttpBoundary, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { configuration } from '@/configuration';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: socketIo }));

const approvalsGet = vi.hoisted(() => vi.fn());
vi.mock('@/session/actions/approvals/artifactStore', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/actions/approvals/artifactStore')>(),
  createCliApprovalsArtifactStore: () => ({ approvalsGet }),
}));

import {
  API_TOKEN_FULL_GRANT_V1,
  ApprovalRequestV2Schema,
  ExternalActionExecutionAuthorizationV1Schema,
  computeWorkspaceSyncPolicyDigest,
  createActionExecutor,
  normalizeActionsSettingsV1,
  type HandoffTargetReplacementApprovalV1,
  type WorkspaceSyncConflictResolveActionInputV1,
} from '@happier-dev/protocol';
import { parseProjectAccountSnapshotV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { buildProjectAccountRowPhysicalKeyV1, ProjectAccountRowMutationRequestV1Schema,
  ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows, subscribeActiveProjectAccountRowsSnapshot,
  withdrawActiveProjectAccountRowsSnapshot, type ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { publishServerHttpRuntimeOrigin, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
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

// As in the target-authority suite, link the real lazy API transport during collection.
await import('@/api/api');

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
  it('recovers retained remote Sync with the captured Account and Home before engine work', async () => {
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const remoteReads: Readonly<{ authorization: unknown; origin: string }>[] = [];
    const remoteRecoveries: unknown[] = [];
    let observeRemote = false;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/') ? await http(url, body) : undefined,
      readAdditionalHttpResponse: async (url, config) => {
        if (observeRemote && url.endsWith('/v1/machines/target-parent')) remoteReads.push({
          authorization: config?.headers?.Authorization, origin: new URL(url).origin,
        });
        return undefined;
      },
      handleAdditionalSocketAck: async payload => {
        if (!payload || typeof payload !== 'object' || !('method' in payload)
          || payload.method !== `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER}` || !('params' in payload)) return undefined;
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        remoteRecoveries.push(decoded.params);
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
          { status: 'recovery_needed', recoveryPath: '/member/recovery' }, decoded.callId) };
      },
    });
    const credentials = { token: [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
      Buffer.from('{"sub":"bob"}').toString('base64url'), 'captured-requester'].join('.'), encryption: null };
    const relationship = { v: 1 as const, relationshipId: 'retained-requester-remote',
      controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
      betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_synced' as const, contentPolicy,
      enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const key = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0,
      content: cipher.seal({ key, value: { relationships: [relationship] } }) }));
    let snapshot: ActiveProjectAccountRowsSnapshot = { ...settingsSnapshot(),
      workspaceRefs: [fixture.sourceRef, fixture.targetRef], relationships: [relationship] };
    const operationId = relationship.relationshipId;
    fixture.parent.handoffAdapter.retainPrivateExecution!({ phase: 'relationship',
      input: { operationId, accountServerId: fixture.serverId,
        action: { kind: 'relationship', relationshipId: operationId, flushBeforeCommit: false },
        sourceMachineId: fixture.sourceRef.machineId, sourceWorkspaceRefId: fixture.sourceRef.id, sourceRootPath: fixture.sourcePath,
        targetMachineId: fixture.targetRef.machineId, targetWorkspaceRefId: fixture.targetRef.id, targetRootPath: fixture.targetPath },
      execution: { credentials, accountRowsCustody: { serverId: fixture.serverId, accountId: 'bob',
        serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => true },
      getSnapshot: () => snapshot, replaceSnapshot: async next => { snapshot = next; },
      assertTransferCurrent: async () => undefined, release: async () => undefined },
    });
    await fixture.parent.handoffAdapter.bindPrivateExecutionRelationship!(operationId, operationId);
    observeRemote = true;
    await expect(fixture.parentManagedWorkspaceSync.ensure(relationship)).rejects.toMatchObject({ code: 'workspace_sync_recovery_needed' });
    expect(remoteRecoveries).toEqual([{ relationshipId: operationId,
      targetMachineId: fixture.targetRef.machineId, targetWorkspaceRefId: fixture.targetRef.id }]);
    expect(remoteReads.length).toBeGreaterThan(0);
    expect(remoteReads.every(read => read.authorization === `Bearer ${credentials.token}`
      && read.origin === 'https://bind-child-home.invalid')).toBe(true);
    expect(await fixture.parentManagedWorkspaceSync.list()).toEqual([]);
  });

  it.each(['copy', 'foreign-project'] as const)('settles worker creation when the installed profile differs from the portable Home identity (%s)', async outcome => {
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const profileId = configuration.activeServerId;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      profileId, serverId: 'srv_portable_copy_home',
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/')
        ? await http(url, body) : undefined });
    expect(profileId).not.toBe(fixture.serverId);
    await fixture.settleProjects();
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const target = outcome === 'copy' ? { ...fixture.targetRef, projectKey: fixture.sourceRef.id } : fixture.targetRef;
    for (const value of [fixture.sourceRef, target]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: profileId, publication: 'installed' }));
    await fixture.settleProjects();
    const installedScope = getActiveProjectAccountRowsSnapshot()?.scopeKey;
    const cancellation = new AbortController();
    const creation = fixture.parent.workspaceSync.relationshipOwner.create({
      v: 1, operationId: 'profile-scoped-worker-copy', actionInput: {
        v: 1, sourceWorkspaceRefId: fixture.sourceRef.id, targetMachineId: fixture.targetRef.machineId,
        targetPath: fixture.targetPath, mode: 'keep_synced', purpose: 'worker_clean_copy', contentPolicy,
        destinationIntent: 'materialize_from_source_workspace',
      },
    }, cancellation.signal);
    // A regression must cleanly cancel the pending owner during normal test teardown.
    onTestFinished(async () => { cancellation.abort(); await creation.catch(() => undefined); });
    if (outcome === 'foreign-project') {
      await expect(creation).rejects.toMatchObject({ code: 'project_workspace_changed' });
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(getActiveProjectAccountRowsSnapshot()?.scopeKey).toBe(installedScope);
      return;
    }
    const created = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await creation);
    expect(created.created).toBe(true);
    expect(getActiveProjectAccountRowsSnapshot()?.scopeKey).toBe(installedScope);
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationshipId: created.relationshipId, enabled: true }),
    ]));
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it('starts beside 0.2.11 sync files and creates a fresh link without changing their paths or bytes', async () => {
    const historicalFiles = new Map<string, string>();
    const historicalDirectories: string[] = [];
    const rows: ProjectAccountRowV1[] = [];
    const accountRowsHttp = createProjectAccountRowsHttpBoundary(rows);
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/')
        ? accountRowsHttp(url, body) : undefined,
      prepareActiveServerDirectory: async activeServerDir => {
        const directory = join(activeServerDir, 'workspace-replication');
        historicalDirectories.push(directory);
        await mkdir(join(directory, 'jobs'), { recursive: true, mode: 0o700 });
        // Immutable cli-v0.2.11 (98ea8fb7), workspaceReplicationJobStore.ts schema-v1 record.
        const path = join(directory, 'jobs', 'WS-LEGACY-job.json');
        const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, jobId: 'WS-LEGACY-job',
          createdAtMs: 1, updatedAtMs: 1, status: { status: 'pending', phase: 'planning', checkpoint: 'job_created',
            progressCounters: { plannedFiles: 0, plannedBytes: 0, transferredFiles: 0, transferredBytes: 0,
              appliedFiles: 0, appliedBytes: 0 }, warnings: [], blockingDivergenceCandidates: [] } }));
        await writeFile(path, bytes);
        historicalFiles.set(path, createHash('sha256').update(bytes).digest('hex'));
        const relationshipId = 'rel_2teqJ4EEScvFRzDbDcbDoHyd7LWGG5enP7dXcJs0fDo';
        const relationshipDirectory = join(directory, 'relationships', relationshipId);
        await mkdir(relationshipDirectory, { recursive: true, mode: 0o700 });
        const relationshipBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, relationshipId,
          endpoints: [{ machineId: 'machine-a', rootPath: '/workspace/alpha' },
            { machineId: 'machine-b', rootPath: '/workspace/beta' }],
          config: { mode: 'one_way_safe' }, createdAtMs: 1, updatedAtMs: 1 }));
        const relationshipPath = join(relationshipDirectory, 'relationship.json');
        await writeFile(relationshipPath, relationshipBytes);
        historicalFiles.set(relationshipPath, createHash('sha256').update(relationshipBytes).digest('hex'));
        const blob = Buffer.from([0, 255, 128, 42]);
        const digest = createHash('sha256').update(blob).digest('hex');
        const shard = join(directory, 'cas', 'sha256', digest.slice(0, 2));
        await mkdir(shard, { recursive: true, mode: 0o700 });
        const blobPath = join(shard, digest);
        await writeFile(blobPath, blob);
        historicalFiles.set(blobPath, digest);
      },
    });
    await fixture.settleProjects();
    await mkdir(fixture.targetPath, { recursive: true });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    // Publish only the available endpoints. The real relationship owner must
    // create, bootstrap and persist the fresh link through the HTTP boundary.
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const created = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await fixture.parent.workspaceSync.relationshipOwner.create({
      v: 1, operationId: 'WS-LEGACY-fresh-link', actionInput: {
        v: 1, sourceWorkspaceRefId: fixture.sourceRef.id, targetMachineId: fixture.targetRef.machineId,
        targetPath: fixture.targetPath, mode: 'keep_both_in_sync', contentPolicy, destinationIntent: 'use_existing',
      },
    }));
    expect(created.created).toBe(true);
    await fixture.parent.workspaceSync.controller.flush(created.relationshipId);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const inspect = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LEGACY_INSPECT);
    if (!inspect) throw new Error('The diagnostic RPC is not registered');
    await expect(inspect({})).resolves.toEqual({ status: 'preserved', path: historicalDirectories[0] });
    await fixture.parent.stop();
    for (const [path, before] of historicalFiles) {
      expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before);
    }
    for (const directory of historicalDirectories) {
      expect((await readdir(directory)).sort()).toEqual(['cas', 'jobs', 'relationships']);
      expect((await readdir(join(directory, '..'))).some(name => name.startsWith('workspace-replication.retired-v1-'))).toBe(false);
    }
  });

  it('reports unavailable activity and discovery during Project withdrawal and recovers on the next publication', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async url => url.endsWith('/v1/account/project-rows/list')
        ? { status: 200, data: { status: 'listed', coverage: 'complete', rows: [] } } : undefined });
    await expect(fixture.parent.activity.read()).resolves.toMatchObject({ coverage: 'complete' });
    withdrawActiveProjectAccountRowsSnapshot();
    await expect(fixture.settleProjects()).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
    // Both real controller and target activity readers run here: one async and
    // one synchronous. Neither may leave a rejected sibling promise unobserved.
    await expect(fixture.parent.activity.read()).resolves.toEqual({ items: [], coverage: 'unknown' });
    await expect(fixture.parentManagedWorkspaceSync!.listRelationships({})).resolves.toMatchObject({
      discoveryAvailable: false, relationships: [], remoteRelationships: [],
    });
    await expect(fixture.parentManagedWorkspaceSync!.ensure({
      ...settingsSnapshot().relationships[0]!, controllerMachineId: fixture.sourceRef.machineId,
      alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
    })).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    await expect(fixture.parent.activity.read()).resolves.toEqual({ items: [], coverage: 'complete' });
    await expect(fixture.parentManagedWorkspaceSync!.listRelationships({})).resolves.toMatchObject({ discoveryAvailable: true });
  });

  it.each(['open', 'source'] as const)('opens a signed personal persistent Sync through registered Project ingress and the production relationship owner (%s)', async entry => {
    const settlementLog = vi.spyOn(logger, 'warnLocalFile');
    onTestFinished(() => settlementLog.mockRestore());
    const [requester, settings, signing, execution, installedContent, socketSchemas] = await Promise.all([
      import('@/daemon/sessionEncryption/requesterAccountActionProjection'),
      import('@/settings/accountSettings/updateAccountSettingsV2WithRetry'),
      import('@happier-dev/protocol/actions/externalActionExecutionAuthorization'),
      import('@/api/externalActionExecutionAuthorization'),
      import('@/api/rpc/workspaceSyncTargetContent'),
      import('@happier-dev/protocol/socketRpc'),
    ]);
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    let settingsContent: ReturnType<typeof settings.prepareAccountSettingsV2Content>;
    let transport: Awaited<ReturnType<typeof composeInstalledBindTargetTransport>> | undefined;
    let sourceInstallation: { installationId: string; privateKey: string; publicKey: string } | undefined;
    let sourceDaemonToken = '';
    const sourceVerificationReads: string[] = [];
    const targetErrorSites: Array<{ phase: string; error: string; sites: string[]; issues?: Array<{ code: string; path: unknown[] }> }> = [];
    let observeSourceVerification = false;
    onTestFinished(() => {
      if (entry !== 'source') return;
      expect(sourceVerificationReads, JSON.stringify({ sourceReads: sourceVerificationReads.length,
        sourceAdmissions: transport?.observed.sourceAdmissionChecks,
        phases: transport?.observed.phaseOutcomes.map(value => ({ phase: value.phase, errorCode: value.errorCode,
          result: value.result && typeof value.result === 'object' && 'kind' in value.result ? value.result.kind : undefined })) }))
        .toEqual([]);
      expect(transport?.observed.sourceAdmissionChecks).toBe(0);
      expect(transport?.observed.releaseReasons, JSON.stringify({
        phases: transport?.observed.phaseOutcomes.map(value => ({ phase: value.phase, errorCode: value.errorCode,
          result: value.result && typeof value.result === 'object' && 'kind' in value.result ? value.result.kind : undefined })),
        sourceReads: sourceVerificationReads.length })).toContain('relationship_committed');
    });
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      ...(entry === 'source' ? { separateTargetParent: true, ordinaryTarget: true, withTargetChildRuntime: true,
        requesterMachineAdmissionBoundary: { machineId: 'source-parent', get daemonToken() { return sourceDaemonToken; },
          isHomeCurrent: () => true, readInstallation: () => sourceInstallation ?? null },
        callWorkspaceTargetPhase: async (descriptor, context) => {
          if (!transport) throw new Error('The installed TARGET transport is unavailable');
          try { return await transport.call(descriptor, context); }
          catch (error) {
            if (error instanceof Error) targetErrorSites.push({ phase: descriptor.routing.phase, error: error.message,
              sites: (error.stack ?? '').split('\n').filter(line => /^\s+at .+\.(?:ts|js):\d+:\d+/.test(line)),
              ...('issues' in error && Array.isArray(error.issues) ? { issues: error.issues.flatMap(issue =>
                issue && typeof issue === 'object' && 'code' in issue && typeof issue.code === 'string'
                  && 'path' in issue && Array.isArray(issue.path)
                  ? [{ code: issue.code, path: issue.path.filter((part: unknown) => typeof part === 'string' || typeof part === 'number') }]
                  : []) } : {}) });
            throw error;
          }
        } } : {}),
      readAdditionalHttpResponse: async url => {
        if (observeSourceVerification && url.endsWith('/v1/machines/source-parent')) sourceVerificationReads.push(url);
        return url.endsWith('/v1/account/profile') ? { status: 200, data: { id: 'owner' } }
        : url.endsWith('/v2/account/settings') ? { status: 200, data: { content: settingsContent, version: 1 } }
          : url.endsWith('/v1/account/encryption/currentness') ? { status: 200, data: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, settingsVersion: 1, updatedAt: 1 } } : undefined;
      },
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/')
        ? await http(url, body) : await transport?.homeResponse(url, body) });
    sourceDaemonToken = fixture.credentials.token;
    settingsContent = settings.prepareAccountSettingsV2Content({ credentials: fixture.credentials, raw: {}, envelopeKind: 'plain' });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const receiver = entry === 'source' ? { machineId: fixture.targetChildRef.machineId, installationId: fixture.targetChildInstallationId }
      : fixture.controller;
    const request = OpenProjectInputV1Schema.parse({ serverId: fixture.serverId, machineId: receiver.machineId,
      source: { kind: 'workspace', workspaceId: fixture.sourceRef.id, checkout: { serverId: fixture.serverId,
        workspaceId: fixture.sourceRef.id, machineId: fixture.sourceRef.machineId, rootPath: fixture.sourceRef.rootPath } },
      materialization: { kind: 'sync', targetPath: fixture.targetPath,
        workspaceAction: { kind: 'create_relationship', mode: 'keep_both_in_sync', contentPolicy, flushBeforeCommit: true } } });
    const envelope = { v: 1 as const, requestId: 'personal-sync-open',
      target: { kind: 'machine' as const, machineId: receiver.machineId }, input: request };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-personal-project-root', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      accountEncryptionMode: 'plain', actionId: 'projects.open', machineId: receiver.machineId,
      installationId: receiver.installationId, custodianAccountId: 'owner', requestId: 'personal-sync-open',
      requestEnvelopeDigest: signing.computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
        sourceWorkspaceRefId: fixture.sourceRef.id, source: { actorAccountId: 'owner', custodianAccountId: 'owner',
          machineId: fixture.sourceRef.machineId, installationId: fixture.controller.installationId,
          role: 'manage', encryptionMode: 'plain' } },
    } });
    const invocation = new AbortController();
    onTestFinished(() => invocation.abort());
    // Home issuance is independently exercised by the SQLite signing suite.
    // The Account profile/settings network ports and installed lifetime are boundaries;
    // Account admission, private projection, retained custody and row mutations are real.
    const admitted = await requester.admitRequesterAccountActionContext({ authorization: root, credentials: fixture.credentials,
      serverId: fixture.serverId, serverIdentityId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid',
      isCurrent: async () => !invocation.signal.aborted, isCustodyCurrent: async () => !invocation.signal.aborted,
      isRetainedCustodyCurrent: async () => true, signal: invocation.signal });
    if (!admitted) throw new Error('Real requester Account admission was refused');
    onTestFinished(() => admitted.dispose());
    const installedIdentities = new Map([fixture.sourceRef.machineId, fixture.targetChildRef.machineId].map(machineId => {
      const keys = nacl.sign.keyPair();
      return [machineId, { version: 1 as const, createdAt: 1,
        installationId: machineId === fixture.sourceRef.machineId ? fixture.controller.installationId : fixture.targetChildInstallationId,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') }] as const;
    }));
    sourceInstallation = installedIdentities.get(fixture.sourceRef.machineId)!;
    const receiverInstallation = installedIdentities.get(receiver.machineId)!;
    const authorization = await execution.projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
      serverId: fixture.serverId, serverIdentityId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid',
      target: root.binding.target, installationId: receiver.installationId,
      privateKey: receiverInstallation.privateKey, rootAdmitted: true });
    if (!authorization || !requester.readRequesterAccountActionContext(authorization)?.retainCustody) {
      throw new Error('Real requester retained Account custody was not projected');
    }
    const context: RpcHandlerContext = { signal: invocation.signal, callerAuthority: 'present_user', callerInputAuthorization: authorization,
      originalActionEnvelope: envelope,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
        installationId: fixture.controller.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    if (entry === 'source') {
      expect(receiver.machineId).not.toBe(fixture.sourceRef.machineId);
      const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: envelope.requestId,
        accountServerId: fixture.serverId, sourceMachineId: fixture.sourceRef.machineId, sourceRootPath: fixture.sourceRef.rootPath,
        originalActionEnvelope: envelope, sourceContext: { machineAdmission: context.machineAdmission,
          callerAuthority: 'present_user', workspaceWrites: 'allow' } });
      const method = `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
      const content = installedContent.createWorkspaceSyncTargetContent({ destination: { machineId: fixture.sourceRef.machineId,
        installationId: sourceInstallation.installationId, installationPublicKey: sourceInstallation.publicKey }, method, routing });
      const params = await socketRpcCodec.encodeParams(content, request, { method, callId: 'b'.repeat(32) });
      const sourceExecution = socketSchemas.WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'persistent-source-packet', params,
        externalActionExecution: execution.createExternalActionMachineRpcExecution({ context: {
          externalActionExecutionAuthorization: root, externalActionTarget: root.binding.target }, effectActionId: 'projects.open',
          installationId: receiver.installationId, method, requestId: 'persistent-source-packet', params,
          workspaceSyncSourceRouting: routing, privateKey: receiverInstallation.privateKey }) });
      transport = await composeInstalledBindTargetTransport(fixture, { operationId: envelope.requestId,
        bootstrapOperationId: deriveWorkspaceSyncRelationshipId(envelope.requestId), releaseReason: 'relationship_committed',
        originalRoot: root, sourceRouting: routing, sourceExecution, installedIdentities });
      context.workspaceSyncSourceRouting = routing;
      context.workspaceSyncSourceExecution = sourceExecution;
    }
    const handlers = new Map<string, (request: unknown, context?: RpcHandlerContext) => unknown>();
    registerProjectOpenRpcHandlers({ registerHandler(method, handler) {
      handlers.set(method, (request, admitted) => handler(request as Parameters<typeof handler>[0], admitted));
    } }, { serverId: fixture.serverId, machineId: fixture.sourceRef.machineId, runtime: {
      serverId: fixture.serverId, machineId: fixture.sourceRef.machineId, accountId: 'owner',
      serverHttpBaseUrl: 'https://bind-child-home.invalid', workspaceSyncAdapter: fixture.parent.handoffAdapter,
      readCredentials: async () => fixture.credentials } });
    const open = handlers.get(entry === 'open' ? RPC_METHODS.PROJECTS_OPEN : RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN);
    if (!open) throw new Error('Project Open ingress is not registered');
    if (entry === 'open') expect(await open(request, { ...context, verifyMachineAdmissionCurrent: async () => false }))
      .toMatchObject({ kind: 'refused', code: 'machine_access_denied' });
    expect(rows).toHaveLength(1);
    observeSourceVerification = entry === 'source';
    const result = await open(request, context);
    const diagnostics = settlementLog.mock.calls.map(([message, fields]) => ({ message,
      ...(fields && typeof fields === 'object' && 'code' in fields ? { code: fields.code } : {}),
      ...(fields && typeof fields === 'object' && 'phase' in fields ? { phase: fields.phase } : {}),
      ...(fields && typeof fields === 'object' && 'error' in fields && typeof fields.error === 'string'
        ? { errorSites: fields.error.split('\n').filter(line => /^\s+at .+\.(?:ts|js):\d+:\d+/.test(line)) } : {}),
    }));
    expect(result, JSON.stringify({ result, diagnostics, targetErrorSites, rpcDiagnostics: transport?.observed.rpcDiagnostics,
      sourceReads: sourceVerificationReads.length,
      phases: transport?.observed.phaseOutcomes.map(value => ({ phase: value.phase, errorCode: value.errorCode,
        result: value.result && typeof value.result === 'object' ? {
          keys: Object.keys(value.result), hasTarget: Reflect.has(value.result, 'targetWorkspace'),
          hasPhysicalEndpoint: Reflect.has(value.result, 'physicalEndpoint'),
        } : undefined })) }))
      .toMatchObject(entry === 'open' ? { kind: 'opened', directory: fixture.targetPath } : { kind: 'materialized' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const snapshot = await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId,
        selection: { kinds: ['workspace-ref', 'relationship-graph'] } }));
    expect(snapshot.relationships).toEqual([expect.objectContaining({ enabled: true, mode: 'keep_both_in_sync' })]);
  });

  it.each(['missing endpoint', 'missing graph'] as const)('refreshes receiving target rows before bootstrapping a newly staged remote endpoint (%s)', async missing => {
    const rows: ProjectAccountRowV1[] = Array.from({ length: 1024 }, (_, index) => {
      const key = { kind: 'project-organization' as const, serverId: 'unrelated-home', projectKey: `unrelated-${index}` };
      return ProjectAccountRowV1Schema.parse({ key, revision: 0,
        content: { t: 'plain', v: { key, value: { pinned: true } } } });
    });
    const returnedKinds: string[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      projectRowsFromHttp: true, readAdditionalHttpPostResponse: async (url, body) => {
        if (!url.endsWith('/v1/account/project-rows/list')) return undefined;
        const response = projectAccountRowsReadHttpResponse(rows, url, body);
        if (!response.data.rows) throw new Error('Expected a Project list response');
        returnedKinds.push(...response.data.rows.map(row => ProjectAccountRowV1Schema.parse(row).key.kind));
        return response;
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const sourceKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key: sourceKey, revision: 0,
      content: cipher.seal({ key: sourceKey, value: fixture.sourceRef }) }));
    const targetKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.targetRef.id };
    const targetRow = ProjectAccountRowV1Schema.parse({ key: targetKey, revision: 0,
      content: cipher.seal({ key: targetKey, value: fixture.targetRef }) });
    if (missing === 'missing graph') rows.push(targetRow);
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    // The SOURCE has just committed these rows at Home. The receiving process
    // still has the previous real Account snapshot until its next HTTP read.
    if (missing === 'missing endpoint') rows.push(targetRow);
    const relationship = { v: 1 as const, relationshipId: 'fresh-remote-endpoint',
      controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
      betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_synced' as const, contentPolicy,
      enabled: false, createdAtMs: 1, updatedAtMs: 1 };
    const graphKey = { kind: 'relationship-graph' as const };
    rows.push(ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 0,
      content: cipher.seal({ key: graphKey, value: { relationships: [relationship] } }) }));
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
    await mkdir(fixture.targetPath);
    const prepare = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
    if (!prepare) throw new Error('The receiving target bootstrap RPC is not registered');
    returnedKinds.length = 0;
    const publications: ActiveProjectAccountRowsSnapshot[] = [];
    onTestFinished(subscribeActiveProjectAccountRowsSnapshot((_previous, next) => {
      if (next) publications.push(next);
    }));
    await expect(prepare({ v: 1, bootstrapOperationId: relationship.relationshipId,
      owner: { kind: 'relationship', relationshipId: relationship.relationshipId }, transientRelationship: { ...relationship, enabled: true },
      targetWorkspaceRefId: fixture.targetRef.id, endpointRole: 'beta', policyDigest: contentPolicy.policyDigest,
      createIfMissing: false, targetBootstrap: 'use_existing' })).resolves.toMatchObject({ state: 'ready' });
    const recover = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER);
    if (!recover) throw new Error('The receiving target recovery RPC is not registered');
    await expect(recover({ relationshipId: relationship.relationshipId,
      targetMachineId: fixture.targetRef.machineId, targetWorkspaceRefId: fixture.targetRef.id }))
      .resolves.toEqual({ status: 'settled' });
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs.map(ref => ref.id))
      .toContain(fixture.targetRef.id);
    expect(returnedKinds.filter(kind => kind === 'project-organization')).toHaveLength(0);
    expect(returnedKinds.filter(kind => kind === 'relationship-graph')).toHaveLength(1);
    await fixture.settleProjects();
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([relationship]);
    expect(publications).toHaveLength(1);
    expect(publications[0]).toMatchObject({ workspaceRefs: expect.arrayContaining([fixture.targetRef]),
      relationships: [relationship] });
  });

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
          const rows = config?.headers?.Authorization === `Bearer ${targetCredentials.token}` ? targetRows : sourceRows;
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
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
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

  it.each([
    { role: 'use' as const, reachesChildAdmission: false },
    { role: 'manage' as const, reachesChildAdmission: true },
  ])('keeps a chosen-child Project Root out of its unshared physical parent before purpose admission ($role)', async ({ role, reachesChildAdmission }) => {
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
        machineId: fixture.targetChildRef.machineId, installationId: fixture.targetChildInstallationId, role, encryptionMode: 'plain' },
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
    // Use stops at the private-checkout owner before child admission. Manage
    // reaches child admission, where generic Parent access cannot replace the
    // missing purpose producer/Session bootstrap.
    expect(result).toMatchObject({ kind: 'refused' });
    if (role === 'use') expect(result).toEqual({ kind: 'refused', code: 'workspace_private_checkout_required', effectAttempted: false });
    expect(admittedChildRead).toBe(reachesChildAdmission);
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
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
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
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
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
    if (!fixture.targetParent) throw new Error('The actual receiving target runtime is unavailable');
    const rpc = new RpcHandlerManager({ scopePrefix: fixture.targetRef.machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, {
        machineId: fixture.targetRef.machineId, resolveHomeServerIdentityId: async () => fixture.serverId,
        resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => 'target-parent-installation',
      }, source) });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: fixture.targetParent.workspaceSync });
    const invokeRecovery = (actorAccountId: string) => rpc.handleRequest({
      method: `${fixture.targetRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_CONFLICT_RECOVER}`,
      params: request, callerAuthority: 'present_user', machineAdmission: {
        actorAccountId, custodianAccountId: 'owner', machineId: fixture.targetRef.machineId,
        installationId: 'target-parent-installation', role: 'manage', encryptionMode: 'plain',
      },
    }, undefined, 'authenticated_home_socket');
    // Only the authenticated Home transport is substituted. Both the success
    // producer and the foreign request's native-isolation decision are real.
    expect(WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(
      readMachineActionRpcResult(await invokeRecovery('owner')))).toEqual({ status: 'settled' });
    const refused = await invokeRecovery('foreign-requester');
    expect(refused).toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
    expect(() => WorkspaceSyncTargetConflictRecoverResultV1Schema.parse(readMachineActionRpcResult(refused)))
      .toThrowError(expect.objectContaining({ rpcErrorCode: 'agent_isolation_unavailable', effectAttempted: false }));
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
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await refreshRows();
    await fixture.settleProjects();
    const controller = fixture.parentManagedWorkspaceSync;
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

  it.each(['staged', 'legacy', 'committed', 'allow', 'ask', 'conflict-allow', 'conflict-capture-once', 'conflict-target-drift', 'conflict-capture-mismatch', 'retargeted-root', 'changed-definition', 'changed-provenance', 'active-dependency', 'foreign-actor'] as const)('retires a worker through the public Action (%s)', async lifetime => {
    const conflict = lifetime.startsWith('conflict-');
    const removeFiles = !['staged', 'legacy', 'committed'].includes(lifetime);
    const rows: ProjectAccountRowV1[] = [];
    let offline = false;
    let resolutionRoots: Readonly<{ source: string; target: string }> | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      separateTargetParent: !conflict,
      ...(conflict ? { resolutionTransfer: true } : {}),
      ...(lifetime === 'active-dependency' ? { workerRunAtMost: 1 } : {}),
      handleAdditionalSocketAck: async raw => {
        if (resolutionRoots && raw && typeof raw === 'object' && 'method' in raw && typeof raw.method === 'string') {
          // A real export/download has completed before its release request.
          // External writers do not participate in the controller's queue.
          if (raw.method.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_RELEASE}`)) {
            if (lifetime === 'conflict-capture-once') await writeFile(join(resolutionRoots.source, 'payload.txt'), 'new live source');
            if (lifetime === 'conflict-target-drift') await writeFile(join(resolutionRoots.target, 'payload.txt'), 'new target writer');
          }
          if (lifetime === 'conflict-capture-mismatch'
            && raw.method.endsWith(`:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`)) {
            await writeFile(join(resolutionRoots.source, 'payload.txt'), 'unreviewed before capture');
          }
        }
        // Home/socket refusal is the actual external boundary. The production
        // dependency census and all registered Sync owners remain real.
        if (offline && raw && typeof raw === 'object' && 'method' in raw && typeof raw.method === 'string'
          && raw.method.startsWith('target-parent:')) {
          return { ok: false, error: 'Target Machine is offline', errorCode: 'RPC_FORBIDDEN' };
        }
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, body) => {
        if (url.endsWith('/admission/verify')) {
          // Home accepts this transport. Recipient custody and requester
          // isolation must still be enforced by the real receiving daemon.
          return { status: 200, data: { v: 1, ok: true } };
        }
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (url.endsWith('/list') || url.endsWith('/read')) return projectAccountRowsReadHttpResponse(rows, url, body);
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        const current = (key: ProjectAccountRowV1['key']) => rows.find(row =>
          buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
        for (const expected of [...request.expectedRefs, ...request.mutations]) {
          if ((current(expected.key)?.revision ?? 'absent') !== expected.expectedRevision) return { status: 200,
            data: { status: 'conflict', key: expected.key, revision: current(expected.key)?.revision ?? -1 } };
        }
        const changed = request.mutations.map(mutation => ProjectAccountRowV1Schema.parse({ key: mutation.key,
          revision: (current(mutation.key)?.revision ?? -1) + 1, content: mutation.content }));
        for (const row of changed) {
          const index = rows.findIndex(value => buildProjectAccountRowPhysicalKeyV1(value.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
          if (index < 0) rows.push(row); else rows[index] = row;
        }
        return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, { ...fixture.targetRef, projectKey: fixture.sourceRef.id }]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    {
      const key = { kind: 'relationship-graph' as const };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: { relationships: [{
        v: 1, relationshipId: deriveWorkspaceSyncRelationshipId('offline-retirement'), controllerMachineId: fixture.sourceRef.machineId,
        alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
        mode: conflict ? 'keep_both_in_sync' : 'keep_synced', contentPolicy, enabled: false,
        ...(lifetime === 'legacy' ? {} : { committedAtMs: lifetime === 'staged' ? null : 1 }), createdAtMs: 1, updatedAtMs: 1,
        provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id },
      }] } }) }));
    }
    if (conflict) {
      const key = { kind: 'relationship-graph' as const };
      const index = rows.findIndex(row => row.key.kind === 'relationship-graph');
      rows[index] = ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: { relationships: [] } }) });
    }
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
      readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    if (conflict) {
      await mkdir(fixture.targetPath);
      await fixture.parent.workspaceSync.relationshipOwner.create({ v: 1, operationId: 'conflict-allow', actionInput: {
        v: 1, sourceWorkspaceRefId: fixture.sourceRef.id, targetMachineId: fixture.targetRef.machineId,
        targetPath: fixture.targetPath, mode: 'keep_both_in_sync', contentPolicy, destinationIntent: 'use_existing',
      } });
      await fixture.settleProjects();
    }
    if (lifetime === 'committed' || removeFiles && !conflict) {
      const targetHandlers = conflict ? fixture.parentRpcHandlers : fixture.targetParentRpcHandlers;
      const prepare = targetHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
      const commit = targetHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE);
      if (!prepare || !commit) throw new Error('Target materialization RPCs are not registered');
      const relationship = getActiveProjectAccountRowsSnapshot()!.relationships[0]!;
      // Establish real committed target custody with the definition paused.
      // No running source session or conflict recovery is needed for retirement.
      await prepare({ v: 1, bootstrapOperationId: relationship.relationshipId,
        owner: { kind: 'relationship', relationshipId: relationship.relationshipId },
        transientRelationship: { ...relationship, enabled: true }, targetWorkspaceRefId: fixture.targetRef.id,
        endpointRole: 'beta', policyDigest: contentPolicy.policyDigest, createIfMissing: true,
        targetBootstrap: 'materialize_from_source_workspace' });
      await writeFile(join(fixture.targetPath, 'payload.txt'), 'committed copy');
      await commit({ v: 1, bootstrapOperationId: relationship.relationshipId,
        targetWorkspaceRefId: fixture.targetRef.id, reason: 'relationship_committed' });
    }
    offline = !removeFiles;
    // Pausing disabled intent is also a controller-owned edit through
    // the registered RPC, and does not erase the commitment lifetime.
    const initial = getActiveProjectAccountRowsSnapshot()!.relationships[0]!;
    if (!conflict) {
      const handler = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE);
      if (!handler) throw new Error('Sync pause RPC is not registered');
      await expect(handler({ relationshipId: initial.relationshipId })).resolves.toEqual({ ok: true });
      expect(getActiveProjectAccountRowsSnapshot()?.relationships[0]?.committedAtMs).toEqual(initial.committedAtMs);
    }
    const expectedRelationship = getActiveProjectAccountRowsSnapshot()!.relationships[0]!;
    const admission = createProjectWorkerAdmission({ machineId: fixture.sourceRef.machineId,
      admissionDrain: createDaemonAdmissionDrain(), readPolicy: async () => ({ status: 'unavailable' }) });
    let storedApproval: ReturnType<typeof ApprovalRequestV2Schema.parse> | null = null;
    // Persistence and daemon admission are the boundary ports. The actual
    // Action approval/decision/replay and all workspace owners run below them.
    approvalsGet.mockReset().mockImplementation(async () => storedApproval);
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      approvalsCreate: async ({ request }) => { storedApproval = ApprovalRequestV2Schema.parse(request); return { artifactId: 'retirement-review' }; },
      approvalsGet: async () => storedApproval,
      approvalsUpdate: async ({ request }) => { storedApproval = ApprovalRequestV2Schema.parse(request); return { ok: true }; },
      isApprovalExecutionOriginCurrent: async () => true,
      workspaceSyncConflictResolve: async ({ actionReceiptId, input }) => {
        const resolve = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_RESOLVE);
        if (!resolve) throw new Error('Conflict resolution RPC is not registered');
        return WorkspaceSyncConflictResolutionResultV1Schema.parse(await resolve({ actionReceiptId, actionInput: input }));
      },
      projectWorkerAction: createProjectWorkerAction({
      machineId: fixture.sourceRef.machineId, serverId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid',
      credentials: fixture.credentials, accountId: 'owner', admission, isFiniteExecutionLive: () => true,
      workspaceSync: fixture.parent.workspaceSync,
    }) });
    const input = { workspace: { serverId: fixture.serverId, refId: fixture.sourceRef.id },
      machineId: fixture.sourceRef.machineId, expectedRelationship };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: fixture.serverId,
      runtimeAccountId: 'owner', actionRequestId: 'offline-retirement-review',
      actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: {
        'projects.worker.copy.retire': { approvalRequiredSurfaces: lifetime === 'ask' ? ['ui'] : [] },
        'workspace.sync.conflict.resolve': { approvalRequiredSurfaces: [] },
      }, approvalWaivedSurfaces: {
        'projects.worker.copy.retire': lifetime === 'ask' ? [] : ['ui'],
        'workspace.sync.conflict.resolve': ['ui'],
      } }),
      presentUserConfirmation: { actionId: 'projects.worker.copy.retire' as const } };
    if (conflict) {
      await writeFile(join(fixture.targetPath, 'payload.txt'), 'conflicting target');
      const actionInput = { controllerMachineId: fixture.sourceRef.machineId, hubWorkspaceRefId: fixture.sourceRef.id,
        path: 'payload.txt', source: { workspaceRefId: fixture.sourceRef.id,
          expected: await observeWorkspaceSyncEntryAtRoot({ rootPath: fixture.sourcePath, relativePath: 'payload.txt' }) },
        targets: [{ workspaceRefId: fixture.targetRef.id,
          expected: await observeWorkspaceSyncEntryAtRoot({ rootPath: fixture.targetPath, relativePath: 'payload.txt' }) }],
        relationshipIds: [expectedRelationship.relationshipId], strategy: 'use_source' as const };
      if (lifetime !== 'conflict-allow') {
        // Keep subsequent ordinary reconciliation separate from the finite
        // install assertion; a previously paused link must stay paused.
        await fixture.parentManagedWorkspaceSync.pause(expectedRelationship.relationshipId);
        resolutionRoots = { source: fixture.sourcePath, target: fixture.targetPath };
      }
      const resolution = await executor.execute('workspace.sync.conflict.resolve', actionInput, {
        ...context, presentUserConfirmation: { actionId: 'workspace.sync.conflict.resolve' },
      });
      expect(resolution, JSON.stringify({ resolution, approvalReads: approvalsGet.mock.calls }))
        .toMatchObject({ ok: true, result: { endpoints: [{ workspaceRefId: fixture.targetRef.id,
          status: lifetime === 'conflict-allow' ? 'applied' : lifetime === 'conflict-capture-once' ? 'applied_paused' : 'changed' }] } });
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(lifetime === 'conflict-target-drift'
        ? 'new target writer' : lifetime === 'conflict-capture-mismatch' ? 'conflicting target' : 'before quiesce');
      if (lifetime === 'conflict-capture-once') expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('new live source');
      return;
    }
    if (lifetime === 'committed') {
      const removeTargetCopy = { workspaceRefId: expectedRelationship.betaWorkspaceRefId,
        rootFingerprint: await computeWorkspaceSyncRootFingerprint(fixture.targetPath) };
      await expect(executor.execute('projects.worker.copy.retire', { ...input, removeTargetCopy }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_dependencies_unavailable' });
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expectedRelationship]);
    }
    if (removeFiles) {
      const removeTargetCopy = { workspaceRefId: expectedRelationship.betaWorkspaceRefId,
        rootFingerprint: await computeWorkspaceSyncRootFingerprint(fixture.targetPath) };
      if (lifetime === 'foreign-actor') {
        if (!fixture.targetParent) throw new Error('Receiving target runtime is unavailable');
        const keys = nacl.sign.keyPair();
        const admission = { machineId: fixture.targetRef.machineId, installationId: 'target-parent-installation',
          actorAccountId: 'foreign-account', custodianAccountId: 'owner', role: 'use' as const, encryptionMode: 'plain' as const };
        let lastAdmission: Awaited<ReturnType<typeof authorizeMachineRpcRequest>> | undefined;
        const rpc = new RpcHandlerManager({ scopePrefix: fixture.targetRef.machineId, encryptionMode: 'plain',
          authorizeRequest: async request => {
            lastAdmission = await authorizeMachineRpcRequest(request, { machineId: fixture.targetRef.machineId,
              resolveHomeServerIdentityId: async () => fixture.serverId,
              resolveInstallationId: () => admission.installationId, resolveCustodianAccountId: async () => 'owner',
              verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({ ...input, privateKey: keys.secretKey,
                daemonToken: fixture.credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid' }) });
            return lastAdmission;
          } });
        registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: fixture.targetParent.workspaceSync });
        const params = { actionReceiptId: 'allowed-retirement', actionInput: { ...input, removeTargetCopy } };
        const ownerAdmission = { ...admission, actorAccountId: 'owner' };
        await expect(rpc.handleRequest({ method: `${fixture.targetRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`,
          params, callerAuthority: 'present_user', machineAdmission: ownerAdmission })).resolves.toMatchObject({ ok: true });
        for (const [machineAdmission, predicate] of [
          [{ ...ownerAdmission, custodianAccountId: 'different-custodian' }, 'machine_custodian'],
          [{ ...ownerAdmission, installationId: 'different-installation' }, 'machine_installation'],
        ] as const) {
          await expect(rpc.handleRequest({ method: `${fixture.targetRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE}`,
            params, callerAuthority: 'present_user', machineAdmission })).resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
          expect(lastAdmission).toMatchObject({ ok: false, admissionPredicate: predicate });
        }
        await expect(rpc.handleRequest({ method: `${fixture.targetRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE}`,
          params, callerAuthority: 'present_user', machineAdmission: admission }))
          .resolves.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
        expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expectedRelationship]);
        expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('committed copy');
        return;
      }
      if (lifetime === 'active-dependency') {
        const worker = fixture.workerAdmissions.get(fixture.targetRef.machineId)!;
        let finish!: () => void;
        const settled = new Promise<void>(resolve => { finish = resolve; });
        const pending = worker.execute({ operationId: 'dependent-script', workspaceRefId: fixture.targetRef.id,
          relationshipId: expectedRelationship.relationshipId, signal: new AbortController().signal, accept() {},
          run: async ({ phase }) => { phase('running'); await settled; return { kind: 'process_settled', result: { ok: true, result: {} } }; } });
        onTestFinished(async () => { finish(); await pending; });
        await expect.poll(() => worker.dependencies().some(item => item.operationId === 'dependent-script' && item.state === 'running')).toBe(true);
        const inspect = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT);
        if (!inspect) throw new Error('Receiving committed-copy inspector is not registered');
        // Reach the target's dependency guard independently of the controller's
        // earlier graph-retirement guard, using its actual worker reservation.
        await expect(inspect({ actionReceiptId: 'allowed-retirement', actionInput: { ...input, removeTargetCopy } }))
          .resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_relationship_in_use',
            dependencies: [expect.objectContaining({ operationId: 'dependent-script', state: 'running' })] });
        await expect(executor.execute('projects.worker.copy.retire', { ...input, removeTargetCopy }, context))
          .resolves.toMatchObject({ ok: false, errorCode: 'workspace_sync_relationship_in_use' });
        expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expectedRelationship]);
        expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('committed copy');
        return;
      }
      if (lifetime === 'retargeted-root') {
        await rename(fixture.targetPath, `${fixture.targetPath}-retained`);
        await mkdir(fixture.targetPath);
        await writeFile(join(fixture.targetPath, 'payload.txt'), 'replacement user root');
      }
      if (lifetime === 'changed-definition' || lifetime === 'changed-provenance') {
        const changed = lifetime === 'changed-definition' ? { ...expectedRelationship, updatedAtMs: expectedRelationship.updatedAtMs + 1 }
          : { ...expectedRelationship, provenance: undefined };
        await expect(executor.execute('projects.worker.copy.retire', { ...input, expectedRelationship: changed, removeTargetCopy }, context))
          .resolves.toMatchObject({ ok: false, errorCode: 'relationship_definition_conflict' });
        expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expectedRelationship]);
        expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('committed copy');
        return;
      }
      const result = await executor.execute('projects.worker.copy.retire', { ...input, removeTargetCopy }, context);
      if (lifetime === 'retargeted-root') {
        expect(result).toMatchObject({ ok: false, errorCode: 'workspace_target_materialization_manual_recovery' });
        expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expectedRelationship]);
        expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('replacement user root');
        expect(await readFile(join(`${fixture.targetPath}-retained`, 'payload.txt'), 'utf8')).toBe('committed copy');
        return;
      }
      if (lifetime === 'ask') {
        expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'retirement-review' } });
        expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('committed copy');
        await expect(executor.execute('approval.request.decide', { artifactId: 'retirement-review', decision: 'approve' },
          { ...context, actionRequestId: 'decide-retirement' })).resolves.toMatchObject({ ok: true,
            result: { ok: true, status: 'executed', execution: { ok: true } } });
        await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
          readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
      } else {
        expect(result, JSON.stringify({ result, approvalReads: approvalsGet.mock.calls })).toMatchObject({ ok: true, result: { status: 'retired' } });
        expect(approvalsGet).not.toHaveBeenCalled();
      }
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    const retired = await executor.execute('projects.worker.copy.retire', input, context);
    if (!retired.ok) throw new Error(`Definition-only retirement refused: ${retired.errorCode}`);
    expect(retired).toMatchObject({ ok: true, result: { status: 'retired' } });
    expect(ProjectWorkerActionOutputSchemasV1['projects.worker.copy.retire'].parse(retired.result)).toEqual({ status: 'retired' });
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
    if (lifetime === 'committed') {
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('committed copy');
    } else await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['same-machine', 'cross-machine', 'worker-copy', 'other-holder'] as const)(
    'replaces a live link through real root custody (%s)', async placement => {
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true, projectRowsFromHttp: true,
      ...(placement === 'cross-machine' || placement === 'worker-copy' ? { separateTargetParent: true, remoteSeed: true } : {}),
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/') ? await http(url, body) : undefined,
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
      readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const create = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE);
    if (!create) throw new Error('The production relationship-create RPC is not registered');
    await mkdir(fixture.targetPath, { recursive: true });
    await writeFile(join(fixture.targetPath, 'payload.txt'), 'existing target bytes');
    const request = { v: 1, operationId: 'original-live-link', actionInput: { v: 1,
      sourceWorkspaceRefId: fixture.sourceRef.id, targetMachineId: fixture.targetRef.machineId, targetPath: fixture.targetPath,
      mode: 'keep_both_in_sync', destinationIntent: 'use_existing', contentPolicy,
      ...(placement === 'worker-copy' ? { purpose: 'worker_clean_copy' } : {}),
    } };
    const original = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await create(request));
    expect(original.status.state).toBe('watching');
    if (placement === 'same-machine') {
      // Match READY71's controls journey here. The other placements exercise
      // replacement directly from Watching under their real target claims.
      await fixture.parent.workspaceSync.relationshipOwner.setEnabled(original.relationshipId, false);
      await fixture.parent.workspaceSync.relationshipOwner.setEnabled(original.relationshipId, true);
      await fixture.parentManagedWorkspaceSync.flush(original.relationshipId);
    }
    await fixture.settleProjects();
    // Unlike the earlier owner-only fixture, a real controller owns this root.
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    const refs = getActiveProjectAccountRowsSnapshot()!.workspaceRefs;
    const replacement = { ...request, operationId: 'replacement-live-link', actionInput: { ...request.actionInput,
      replaceRelationshipId: original.relationshipId, destinationIntent: 'use_existing', mode: 'keep_both_in_sync' } };
    const preflight = (fixture.targetParent ? fixture.targetParentRpcHandlers : fixture.parentRpcHandlers)
      .get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT);
    if (!preflight) throw new Error('The production target preflight RPC is not registered');
    const preflightInput = { v: 1, serverId: fixture.serverId,
      machineId: fixture.targetRef.machineId, operationId: replacement.operationId,
      targetPath: fixture.targetPath, destinationIntent: 'use_existing', activatesExactMirror: false,
      replaceRelationshipId: original.relationshipId };
    const inspectReplacement = () => preflight(preflightInput);
    if (placement === 'other-holder') {
      await fixture.parent.workspaceSync.relationshipOwner.setEnabled(original.relationshipId, false);
      await fixture.settleProjects();
      const holder = await fixture.probeTarget();
      if ('kind' in holder) throw new Error('Paused target root did not release its claim');
      try {
        await expect(inspectReplacement()).rejects.toMatchObject({ rpcErrorCode: 'workspace_root_in_use' });
        expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({
          relationshipId: original.relationshipId, enabled: false,
        })]);
        // A direct creation attempt still refuses independently at admission;
        // its already-committed retirement is not silently rolled back.
        await expect(create(replacement)).rejects.toMatchObject({ rpcErrorCode: 'workspace_root_in_use' });
        // A refusal must not steal or release another operation's physical claim.
        expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap', existing: { ownerId: holder.owner.ownerId } });
        expect(getActiveProjectAccountRowsSnapshot()?.relationships.some(value =>
          value.relationshipId === deriveWorkspaceSyncRelationshipId(replacement.operationId) && value.enabled)).toBe(false);
        expect(getActiveProjectAccountRowsSnapshot()?.relationships.some(value =>
          value.relationshipId === original.relationshipId)).toBe(false);
      } finally { await holder.release(); }
    } else {
      await expect(preflight({ ...preflightInput, replaceRelationshipId: 'another-link' }))
        .rejects.toMatchObject({ rpcErrorCode: 'workspace_root_in_use' });
      await expect(inspectReplacement()).resolves.toMatchObject({ type: 'not_required' });
      await expect(preflight({ ...preflightInput, activatesExactMirror: true })).resolves.toMatchObject({
        type: 'approval_required', approval: {
          consequences: ['delete_target_only_files_during_exact_mirror'],
          operationId: replacement.operationId,
          rootFingerprint: await computeWorkspaceSyncRootFingerprint(fixture.targetPath),
        },
      });
      // Destination inspection neither retires the selected link nor releases
      // its borrowed claim while the person considers exact-mirror approval.
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({
        relationshipId: original.relationshipId, enabled: true,
      })]);
      expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
      const result = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await create(replacement));
      expect(result).toMatchObject({ created: true, relationshipId: deriveWorkspaceSyncRelationshipId(replacement.operationId),
        targetWorkspaceRefId: original.targetWorkspaceRefId, status: { state: 'watching' } });
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({
        relationshipId: result.relationshipId, mode: 'keep_both_in_sync',
        ...(placement === 'worker-copy' ? { committedAtMs: expect.any(Number), provenance: { kind: 'worker_clean_copy',
          sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: original.targetWorkspaceRefId } } : {}),
      })]);
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual(refs);
      expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
    }
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it.each(['fresh', 'retire-created', 'staged', 'retired', 'refresh-during-create', 'remote-missing-parents', 'remote-known-endpoints', 'remote-refusal', 'carrier-refusal', 'native-dial-refusal', 'pinned-9', 'native-failure'] as const)('creates a worker copy or returns an actionable native failure (%s)', async intent => {
    const createFailureLog = intent === 'native-failure' ? vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {}) : undefined;
    if (createFailureLog) onTestFinished(() => createFailureLog.mockRestore());
    // Observe only the file sink: controller, grant verification, carrier and
    // native codec remain composed through the registered create entry point.
    const carrierTrace = intent === 'native-dial-refusal' ? vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {}) : undefined;
    if (carrierTrace) {
      vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
      onTestFinished(() => { carrierTrace.mockRestore(); vi.unstubAllEnvs(); });
    }
    const rows: ProjectAccountRowV1[] = [];
    let refreshDuringCreate: (() => Promise<void>) | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: intent !== 'remote-refusal', projectRowsFromHttp: true,
      ...(intent === 'remote-missing-parents' ? { separateTargetParent: true, remoteSeed: true, missingTargetParents: true } : {}),
      ...(intent === 'remote-known-endpoints' ? { separateTargetParent: true, remoteSeed: true } : {}),
      ...(intent === 'carrier-refusal' ? { separateTargetParent: true, remoteSeed: true, nativeCarrierRefusal: true } : {}),
      ...(intent === 'native-dial-refusal' ? { separateTargetParent: true, remoteSeed: true, nativeCarrierRefusal: true, nativeCarrierDialFailure: true } : {}),
      ...(intent === 'remote-refusal' ? { separateTargetParent: true, handleAdditionalSocketAck: async (raw: unknown) => {
        if (!raw || typeof raw !== 'object' || !('method' in raw) || !('params' in raw)
          || typeof raw.method !== 'string' || !raw.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`)) return undefined;
        const content = { mode: 'plain' as const };
        const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
        return { ok: true, result: await socketRpcCodec.encodeResponse(content,
          { error: 'Workspace sync endpoint is unavailable', errorCode: 'peer_unavailable' }, decoded.callId) };
      } } : {}),
      ...(intent === 'refresh-during-create' ? { onNativeCreate: async () => { await refreshDuringCreate?.(); } } : {}),
      ...(intent === 'pinned-9' ? { nativeEndpointSummary: 'pinned-9' as const } : {}),
      ...(intent === 'native-failure' ? { nativeCreateFailure: Object.assign(
        new Error('Native command failed; token=fixture-native-secret'), { code: 'ENOSPC' },
      ) } : {}),
      readAdditionalHttpPostResponse: async (url, body) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (url.endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
        const request = ProjectAccountRowMutationRequestV1Schema.parse(body);
        const current = (key: ProjectAccountRowV1['key']) => rows.find(row =>
          buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
        for (const expected of [...request.expectedRefs, ...request.mutations]) {
          if ((current(expected.key)?.revision ?? 'absent') !== expected.expectedRevision) return { status: 200,
            data: { status: 'conflict', key: expected.key, revision: current(expected.key)?.revision ?? -1 } };
        }
        // Home persistence is replaced at HTTP; row/CAS, controller, root
        // custody, materialization and registered RPC schemas remain real.
        const changed = request.mutations.map(mutation => ProjectAccountRowV1Schema.parse({ key: mutation.key,
          revision: (current(mutation.key)?.revision ?? -1) + 1, content: mutation.content }));
        for (const row of changed) {
          const index = rows.findIndex(value => buildProjectAccountRowPhysicalKeyV1(value.key) === buildProjectAccountRowPhysicalKeyV1(row.key));
          if (index < 0) rows.push(row); else rows[index] = row;
        }
        return { status: 200, data: { status: 'updated', rows: changed, cursor: Math.max(...changed.map(row => row.revision)) } };
      } });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    if (intent !== 'fresh' && intent !== 'retire-created' && intent !== 'remote-missing-parents' && intent !== 'remote-refusal' && intent !== 'carrier-refusal' && intent !== 'native-dial-refusal') {
      const targetKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.targetRef.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key: targetKey, revision: 0, content: cipher.seal({ key: targetKey,
        value: { ...fixture.targetRef, projectKey: fixture.sourceRef.id } }) }));
      if (intent !== 'remote-known-endpoints') {
        const graphKey = { kind: 'relationship-graph' as const };
        rows.push(ProjectAccountRowV1Schema.parse({ key: graphKey, revision: 0, content: cipher.seal({ key: graphKey, value: { relationships: [{
          v: 1, relationshipId: deriveWorkspaceSyncRelationshipId(intent === 'staged' ? 'same-machine-worker-copy' : 'retired-operation'), controllerMachineId: fixture.sourceRef.machineId,
          alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_synced', contentPolicy,
          enabled: false, createdAtMs: 1, updatedAtMs: 1, provenance: { kind: 'worker_clean_copy',
            sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id },
        }] } }) }));
      }
    }
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
      await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    if (intent === 'retired' || intent === 'refresh-during-create' || intent === 'pinned-9' || intent === 'native-failure') {
      const retained = getActiveProjectAccountRowsSnapshot()!.relationships[0]!;
      await fixture.parent.workspaceSync.relationshipOwner.stop(retained.relationshipId, undefined, { expectedRelationship: retained });
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
    }
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const create = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE);
    if (!create) throw new Error('The production relationship-create RPC is not registered');
    const request = { v: 1, operationId: 'same-machine-worker-copy', actionInput: { v: 1,
      sourceWorkspaceRefId: fixture.sourceRef.id, targetMachineId: fixture.targetRef.machineId, targetPath: fixture.targetPath,
      mode: 'keep_synced', destinationIntent: 'materialize_from_source_workspace', purpose: 'worker_clean_copy', contentPolicy } };
    refreshDuringCreate = async () => {
      const index = rows.findIndex(row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(key));
      rows[index] = ProjectAccountRowV1Schema.parse({ key, revision: rows[index]!.revision + 1,
        content: cipher.seal({ key, value: { ...fixture.sourceRef, label: 'Updated during native creation' } }) });
      await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
        await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
      // A real row refresh can queue reconciliation while the native command
      // is pending; do not wait on the controller queue from inside that command.
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    if (intent === 'remote-missing-parents') {
      const preflight = fixture.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT);
      if (!preflight) throw new Error('The target daemon preflight RPC is not registered');
      await expect(preflight({ v: 1, serverId: fixture.serverId, machineId: fixture.targetRef.machineId,
        operationId: request.operationId, targetPath: fixture.targetPath,
        destinationIntent: request.actionInput.destinationIntent })).resolves.toMatchObject({ type: 'not_required' });
      await expect(stat(join(fixture.targetPath, '..'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    if (intent === 'pinned-9' || intent === 'native-failure' || intent === 'remote-refusal' || intent === 'carrier-refusal' || intent === 'native-dial-refusal') {
      const errorCode = intent === 'pinned-9' ? 'workspace_sync_update_required'
        : intent === 'remote-refusal' || intent === 'native-dial-refusal' ? 'peer_unavailable'
          : intent === 'carrier-refusal' ? 'machine_carrier_unavailable' : 'workspace_sync_unavailable';
      const carrierReason = intent === 'carrier-refusal' ? 'Authenticated Iroh machine carrier is unavailable'
        : intent === 'native-dial-refusal' ? 'machine transport is unavailable' : undefined;
      const projectedFailure = await Promise.resolve().then(() => create(request)).then(
        () => { throw new Error('The native boundary refusal unexpectedly succeeded'); }, error => error,
      );
      expect(projectedFailure).toMatchObject({ rpcErrorCode: errorCode,
        ...(carrierReason ? { message: carrierReason } : {}) });
      if (intent === 'remote-refusal') {
        await runWithServerHttpBaseUrl('https://bind-child-home.invalid', async () =>
          await readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
        const target = getActiveProjectAccountRowsSnapshot()?.workspaceRefs.find(ref =>
          ref.machineId === fixture.targetRef.machineId && ref.rootPath === fixture.targetRef.rootPath);
        if (!target) throw new Error('Create did not materialize its target reference');
        // The handoff caller releases retained execution only for a settled preparation refusal.
        await expect(fixture.parent.handoffAdapter.prepare({
          operationId: `${request.operationId}-preparation`, accountServerId: fixture.serverId,
          sourceMachineId: fixture.sourceRef.machineId, sourceRootPath: fixture.sourceRef.rootPath,
          targetMachineId: fixture.targetRef.machineId, targetRootPath: fixture.targetRef.rootPath,
          sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: target.id,
          action: { kind: 'create_relationship', mode: 'keep_both_in_sync', contentPolicy },
        })).rejects.toMatchObject({ name: 'WorkspaceSyncPreparationRefusal', code: 'peer_unavailable' });
      }
      if (carrierTrace) {
        expect(carrierTrace.mock.calls.filter(([message]) => message === '[workspace-sync-carrier-stage]'))
          .toEqual(['target_read', 'grant_mint', 'endpoint_revalidation', 'native_tunnel_open'].flatMap(stage =>
            ['begin', 'end'].map(edge => ['[workspace-sync-carrier-stage]', {
              operationId: deriveWorkspaceSyncRelationshipId(request.operationId), stage: `${stage}.${edge}`,
            }])));
        // The same public Action still returns its typed native reason with
        // tracing disabled, without producing a carrier diagnostic record.
        carrierTrace.mockClear();
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
      }
      const completions: unknown[] = [];
      const rpc = new RpcHandlerManager({ scopePrefix: fixture.sourceRef.machineId,
        localMachineId: fixture.sourceRef.machineId, encryptionMode: 'plain',
        logger: (message, data) => { if (message === '[RPC] Request completed') completions.push(data); },
        // Home proof verification is the transport boundary; daemon admission
        // and requester selection still run through their production owners.
        authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, {
          machineId: fixture.sourceRef.machineId, resolveInstallationId: () => 'parent-installation',
          resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => fixture.serverId,
          verifyMachineAdmission: async () => true,
        }),
      });
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: fixture.parent.workspaceSync });
      const executor = createActionExecutor({
        ...createUnavailableActionTransportDeps(),
        sessionHandoffTargetReplacementApprovalPreflight: async input => {
          const receiver = intent === 'remote-refusal' || intent === 'carrier-refusal' || intent === 'native-dial-refusal' ? fixture.targetParent : fixture.parent;
          if (!receiver) throw new Error('The actual preflight target daemon was not composed');
          return await receiver.workspaceSync.preflightHandoffTargetReplacement({
            v: 1, serverId: fixture.serverId, machineId: input.targetMachineId, operationId: input.operationId,
            targetPath: fixture.targetPath, destinationIntent: input.destinationIntent,
            activatesExactMirror: input.activatesExactMirror,
          });
        },
        workspaceSyncRelationshipCreate: async ({ input, operationId }) => await rpc.handleRequest({
          method: `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`,
          params: { v: 1, operationId, actionInput: input },
          callerAuthority: 'present_user',
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
            installationId: 'parent-installation', role: 'manage', encryptionMode: 'plain' },
        }),
      });
      const actionResult = await executor.execute('workspace.sync.relationship.create', request.actionInput, {
        surface: 'ui', authority: 'present_user', serverId: fixture.serverId, actionRequestId: request.operationId,
        presentUserConfirmation: { actionId: 'workspace.sync.relationship.create' },
      });
      expect(actionResult).toMatchObject({ ok: false, errorCode, ...(carrierReason ? { error: carrierReason } : {}) });
      if (createFailureLog) {
        expect(actionResult).toMatchObject({ error: expect.stringContaining('ENOSPC'), failureCause: { errorCode: 'ENOSPC' } });
        expect(projectedFailure).toMatchObject({ cause: {
          name: 'WorkspaceSyncPreparationRefusal', code: 'ENOSPC', message: expect.stringContaining('Native command failed'),
        }, failureCause: { errorCode: 'ENOSPC' } });
        expect(createFailureLog).toHaveBeenCalledWith('[Workspace Sync] Relationship create failed', expect.objectContaining({
          cause: { name: 'WorkspaceSyncPreparationRefusal', code: 'ENOSPC', message: expect.stringContaining('Native command failed') },
        }));
        expect(JSON.stringify([projectedFailure, actionResult, createFailureLog.mock.calls])).not.toContain('fixture-native-secret');
      }
      expect(completions).toContainEqual(expect.objectContaining({ outcomeCode: errorCode }));
      if (carrierTrace) expect(carrierTrace.mock.calls.filter(([message]) => message === '[workspace-sync-carrier-stage]')).toEqual([]);
      // A refused preparation restores the pre-create rows: no staged paused link remains.
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      return;
    }
    // Exercise the reported Session ingress against the real copy owner. The
    // Home access check and native process are boundaries; requester selection,
    // registered dispatch, row persistence and copied bytes stay real.
    const sessionRpc = new RpcHandlerManager({ scopePrefix: fixture.sourceRef.machineId,
      localMachineId: fixture.sourceRef.machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, {
        machineId: fixture.sourceRef.machineId, resolveInstallationId: () => 'parent-installation',
        resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => fixture.serverId,
        verifyMachineAdmission: async () => true,
      }),
    });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: sessionRpc, service: fixture.parent.workspaceSync });
    const created = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await sessionRpc.handleRequest({
      method: `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE}`, params: request,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
        installationId: 'parent-installation', role: 'manage', encryptionMode: 'plain' },
      callerAuthority: 'account_automation',
      localActionContext: { actionCaller: { kind: 'session', sessionId: 'worker-link-requester', starterDepth: 0, turnDepth: 0 } },
    }));
    expect(created).toMatchObject({ created: intent !== 'staged', status: { state: 'watching', conflictCount: 0 } });
    if (intent === 'staged') expect(created).toMatchObject({ relationshipId: deriveWorkspaceSyncRelationshipId(request.operationId), targetWorkspaceRefId: fixture.targetRef.id });
    expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([expect.objectContaining({
      relationshipId: created.relationshipId, enabled: true, committedAtMs: expect.any(Number), provenance: { kind: 'worker_clean_copy',
        sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: created.targetWorkspaceRefId },
    })]);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    if (intent === 'retire-created') {
      await fixture.parent.workspaceSync.relationshipOwner.stop(created.relationshipId);
      expect(getActiveProjectAccountRowsSnapshot()?.relationships).toEqual([]);
      const targetRow = rows.find(row => row.key.kind === 'workspace-ref' && row.key.id === created.targetWorkspaceRefId);
      if (!targetRow) throw new Error('The created target row is missing');
      rows[rows.indexOf(targetRow)] = ProjectAccountRowV1Schema.parse({ ...targetRow,
        revision: targetRow.revision + 1, content: null });
      await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
        readProjectAccountRows({ credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
      await rm(fixture.targetPath, { recursive: true });
      const replacement = WorkspaceSyncRelationshipCreateResultV1Schema.parse(await create({ ...request,
        operationId: 'replacement-worker-copy' }));
      expect(replacement).toMatchObject({ created: true, status: { state: 'watching' } });
      expect(replacement.relationshipId).not.toBe(created.relationshipId);
      await expect(fixture.parentManagedWorkspaceSync.list()).resolves.toMatchObject([
        { relationshipId: replacement.relationshipId },
      ]);
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      return;
    }
    if (intent === 'fresh') {
      const observe = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATION_OBSERVE);
      if (!observe) throw new Error('The production creation observation RPC is not registered');
      await expect(observe(request)).resolves.toMatchObject({ outcome: 'succeeded', relationshipId: created.relationshipId,
        sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: created.targetWorkspaceRefId });
      const committedAtMs = getActiveProjectAccountRowsSnapshot()!.relationships[0]!.committedAtMs;
      await fixture.parent.workspaceSync.relationshipOwner.setEnabled(created.relationshipId, false);
      expect(getActiveProjectAccountRowsSnapshot()?.relationships[0]).toMatchObject({ enabled: false, committedAtMs });
      await fixture.parent.workspaceSync.relationshipOwner.setEnabled(created.relationshipId, true);
      expect(getActiveProjectAccountRowsSnapshot()?.relationships[0]).toMatchObject({ enabled: true, committedAtMs });
      const rpc = new RpcHandlerManager({ scopePrefix: fixture.sourceRef.machineId, encryptionMode: 'plain', logger: () => {},
        authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, {
          machineId: fixture.sourceRef.machineId, resolveCustodianAccountId: async () => 'owner',
          resolveInstallationId: () => 'parent-installation',
          // Only Home access verification is replaced; preview, admission,
          // registration, materialization and the consuming schemas stay real.
          verifyMachineAdmission: async () => true,
        }),
      });
      registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: fixture.parent.workspaceSync });
      const preview = { kind: 'preview', workspace: { serverId: fixture.serverId, refId: fixture.sourceRef.id },
        machineId: fixture.sourceRef.machineId, targetMachineId: fixture.targetRef.machineId,
        targetWorkspaceRefId: created.targetWorkspaceRefId,
        expectedRelationship: getActiveProjectAccountRowsSnapshot()!.relationships[0]! };
      const inspect = (actorAccountId = 'owner') => rpc.handleRequest({
        method: `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params: preview,
        machineAdmission: { actorAccountId, custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
          installationId: 'parent-installation', role: 'manage', encryptionMode: 'plain' },
      });
      const result = ProjectWorkerActionOutputSchemasV1['projects.worker.copy.inspect'].parse(await inspect());
      expect(result).toMatchObject({ ok: true, preview: { targetMachineId: fixture.targetRef.machineId,
        workspaceRefId: created.targetWorkspaceRefId, rootFingerprint: await computeWorkspaceSyncRootFingerprint(fixture.targetPath) } });
      // A typed refusal must survive the same front-door consumer that used
      // to collapse this registered producer's error into invalid_action_output.
      expect(ActionExecuteFailureSchema.parse(await inspect('foreign-account')))
        .toMatchObject({ ok: false, errorCode: 'forbidden' });
    }
    expect(WorkspaceSyncRelationshipCreateResultV1Schema.parse(await create(request))).toMatchObject({
      created: false, relationshipId: created.relationshipId, targetWorkspaceRefId: created.targetWorkspaceRefId,
    });
    await expect(create({ ...request, operationId: 'different-operation' })).rejects.toMatchObject({
      rpcErrorCode: 'relationship_replacement_required',
    });
  });

  it('never exposes the installed Account relationships to another admitted Account', async () => {
    const rows: unknown[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true, projectRowsFromHttp: true,
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/') ? http(url, body) : undefined });
    const list = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST);
    if (!list) throw new Error('The production Sync RPC is not registered');
    await mkdir(fixture.targetPath);
    for (const ref of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref', serverId: fixture.serverId, id: ref.id };
      rows.push({ key, revision: 0, content: { t: 'plain', v: { key, value: ref } } });
    }
    const key = { kind: 'relationship-graph' };
    rows.push({ key, revision: 0, content: { t: 'plain', v: { key, value: { relationships: [{ v: 1,
      relationshipId: 'owner-relationship', controllerMachineId: fixture.sourceRef.machineId,
      alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
      mode: 'keep_synced', contentPolicy, enabled: false, createdAtMs: 1, updatedAtMs: 1 }] } } } });
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const installed = await list({});
    expect(WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(installed).relationships).toHaveLength(1);
    for (const role of ['use', 'manage'] as const) {
      const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: 'other-account', custodianAccountId: 'owner',
          machineId: fixture.sourceRef.machineId, installationId: 'parent-installation', role, encryptionMode: 'plain' } };
      await expect(list({}, context)).resolves.toMatchObject({ relationships: [], sets: [], remoteRelationships: [] });
      const statuses = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_LIST);
      if (!statuses) throw new Error('The production Sync status RPC is not registered');
      await expect(statuses({}, context)).resolves.toEqual({ statuses: [] });
      for (const method of [RPC_METHODS.DAEMON_WORKSPACE_SYNC_GET, RPC_METHODS.DAEMON_WORKSPACE_SYNC_FLUSH,
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_PAUSE, RPC_METHODS.DAEMON_WORKSPACE_SYNC_RESUME,
        RPC_METHODS.DAEMON_WORKSPACE_SYNC_TERMINATE]) {
        const control = fixture.parentRpcHandlers.get(method);
        if (!control) throw new Error('The production Sync control RPC is not registered');
        await expect(control({ relationshipId: 'owner-relationship' }, context)).rejects.toMatchObject({ rpcErrorCode: 'relationship_not_owned' });
      }
      const inspect = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICT_INSPECT);
      if (!inspect) throw new Error('The production Sync inspection RPC is not registered');
      await expect(inspect({ workspaceRefId: fixture.sourceRef.id, path: 'payload.txt' }, context))
        .rejects.toMatchObject({ rpcErrorCode: 'relationship_not_ready' });
    }
    expect(WorkspaceSyncRelationshipsListRpcResultV1Schema.parse(await list({})).relationships)
      .toEqual([expect.objectContaining({ definition: expect.objectContaining({ relationshipId: 'owner-relationship', enabled: false }) })]);
  });

  it('refuses foreign requester persistent creation before Account mutation while ordinary own creation stays live', async () => {
    const accountId = 'bob';
    let phase = 'fixture composition';
    onTestFinished(() => {
      if (phase !== 'completed') console.error('Incomplete requester persistence test', { accountId, phase });
    });
    const ownerRows: ProjectAccountRowV1[] = [];
    const requesterRows: ProjectAccountRowV1[] = [];
    const writes: { actor: 'owner' | 'requester'; request: unknown }[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true, projectRowsFromHttp: true, separateTargetParent: true,
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
    const machineAdmission = { actorAccountId: accountId, custodianAccountId: 'owner', machineId: source.machineId,
      installationId: 'parent-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: source.machineId, custodianAccountId: 'owner', installationId: 'parent-installation', actionId: 'projects.open',
      requestId: 'bob-persistent-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: source.machineId },
      accountEncryptionMode: 'plain',
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('bob-persistent-open'),
        sourceWorkspaceRefId: source.id, source: machineAdmission },
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId, serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => true, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId, serverId: fixture.serverId,
      serverIdentityId: fixture.managedHomeId, serverHttpBaseUrl: 'https://bind-child-home.invalid', accountEncryptionMode: 'plain',
      isCurrent: async () => true, createRequestHeaders: async () => ({ 'x-requester-proof': 'requester' }) } });
    const signal = new AbortController().signal;
    const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission, verifyMachineAdmissionCurrent: async () => true };
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
    expect(projectResult).toEqual({ kind: 'refused', code: 'workspace_private_checkout_required', effectAttempted: false });
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
  ])('refuses foreign requester Sync Open before touching the custodian checkout ($label)', async ({ sameWorkspace, action }) => {
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
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'owner', machineId: source.machineId,
      installationId: 'parent-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: source.machineId, custodianAccountId: 'owner', installationId: 'parent-installation', actionId: 'projects.open',
      requestId: 'requester-sibling-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: source.machineId },
      accountEncryptionMode: 'plain',
      workspaceSyncAdmission: { relationshipId: action.kind === 'relationship' ? action.relationshipId
        : deriveWorkspaceSyncRelationshipId('requester-sibling-open'), sourceWorkspaceRefId: source.id, source: machineAdmission },
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => true, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      serverIdentityId: fixture.managedHomeId, serverHttpBaseUrl: 'https://bind-child-home.invalid', accountEncryptionMode: 'plain',
      isCurrent: async () => true, createRequestHeaders: async () => ({ 'x-requester-proof': 'requester' }) } });
    const signal = new AbortController().signal;
    const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission, verifyMachineAdmissionCurrent: async () => true };
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
    expect(result).toEqual({ kind: 'refused', code: 'workspace_private_checkout_required', effectAttempted: false });
    expect(writes).toEqual([]);
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
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
      installationId: 'parent-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      machineId: fixture.sourceRef.machineId, custodianAccountId: 'owner', installationId: 'parent-installation',
      actionId: 'projects.open', requestId: 'private-project-open', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: fixture.sourceRef.machineId }, accountEncryptionMode: 'plain',
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('private-project-open'),
        sourceWorkspaceRefId: privateRef.id, source: machineAdmission },
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      accountEncryptionMode: 'plain', projectAccountRowCipher: cipher, isCurrent: async () => current, readArtifact: async () => null,
      resolveMachineContentEncryptionContext: () => ({ encryptionMode: 'plain' }) } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: fixture.serverId,
      serverIdentityId: fixture.serverId, serverHttpBaseUrl: 'https://bind-child-home.invalid', accountEncryptionMode: 'plain', isCurrent: async () => current,
      createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
    const signal = new AbortController().signal;
    const context: RpcHandlerContext = { signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission, verifyMachineAdmissionCurrent: async () => true };
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
    await expect(fixture.parent.handoffAdapter.finalize({ operationId: request.operationId, prepared, signal })).resolves.toMatchObject({
      kind: 'copy_once', operationId: request.operationId });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
  });

  it('composes one daemon-owned runtime and keeps it available after a transient engine start failure', async () => {
    const serverId = 'srv_readiness_home';
    const releaseHome = publishServerHttpRuntimeOrigin('http://127.0.0.1:43187', 'iroh', undefined, serverId);
    onTestFinished(releaseHome);
    let expectedHomeOrigin = 'http://127.0.0.1:43187';
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
      expect(new URL(url).origin).toBe(expectedHomeOrigin);
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
    const releaseBootstrapAtTarget = vi.fn(async (_request: Parameters<ReturnType<ProductionDaemonWorkspaceSyncFactories['createTargetAuthority']>['releaseBootstrapAtTarget']>[0]) => ({ ok: true as const, released: true }));
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
      observeCreation: vi.fn(async () => ({ outcome: 'unknown' as const })),
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
    const callMachineRpc = vi.fn(async (request: { method: string }): Promise<unknown> => (
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
    approvalsGet.mockReset();
    const assertTargetReplacementAuthorized = createTargetAuthority.mock.calls[0]![0].assertTargetReplacementAuthorized;
    if (!assertTargetReplacementAuthorized) throw new Error('target replacement authorizer was not composed');
    await expect(assertTargetReplacementAuthorized('approval-receipt-1', approvedActionInput, approval)).resolves.toBeUndefined();
    expect(approvalsGet).not.toHaveBeenCalled();
    const conflictInput = {
      controllerMachineId: 'machine-b',
      hubWorkspaceRefId: 'workspace-beta',
      path: 'conflict.txt',
      source: { workspaceRefId: 'workspace-alpha', expected: { kind: 'file' as const, digest: 'a'.repeat(40), executable: false, size: 1 } },
      targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'file' as const, digest: 'b'.repeat(40), executable: false, size: 1 } }],
      relationshipIds: ['rel-1'],
      strategy: 'use_source' as const,
    } satisfies WorkspaceSyncConflictResolveActionInputV1;
    const assertConflictResolutionAuthorized = createTargetAuthority.mock.calls[0]![0].assertConflictResolutionAuthorized;
    if (!assertConflictResolutionAuthorized) throw new Error('conflict authorizer was not composed');
    await expect(assertConflictResolutionAuthorized('conflict-receipt-1', conflictInput)).resolves.toBeUndefined();
    expect(approvalsGet).not.toHaveBeenCalled();
    await expect(assertTargetReplacementAuthorized('allowed-operation', { unrelated: true }, approval))
      .rejects.toMatchObject({ code: 'approval_stale' });

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
    const readsBeforeReconciliation = refreshProjectRows.mock.calls.length;
    await relationshipOwnerInput.waitForProjectReconciliation(7, reconciliationSignal);
    expect(refreshProjectRows).toHaveBeenCalledTimes(readsBeforeReconciliation);
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
      rootOwnershipManager: { tryAcquire: expect.any(Function) },
      spawnSidecar,
      launchLocalAgent,
      openMachineCarrierTunnel: expect.any(Function),
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
    const nativeRefusal = createRpcCallError({ error: 'Recovery refused', errorCode: 'agent_isolation_unavailable' });
    callMachineRpc.mockRejectedValueOnce(nativeRefusal);
    await expect.soft(daemonRuntimeInput.handoffRelationshipController?.flush('rel-1')).rejects.toBe(nativeRefusal);
    const remote = new RpcHandlerManager({ scopePrefix: 'controller', encryptionMode: 'plain', logger: () => {} });
    remote.registerHandler('flush-refusal', async () => { throw nativeRefusal; });
    const serializedRefusal = await remote.handleRequest({ method: 'controller:flush-refusal', params: {} });
    expect(serializedRefusal).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
    callMachineRpc.mockResolvedValueOnce(serializedRefusal);
    await expect(daemonRuntimeInput.handoffRelationshipController?.flush('rel-1')).rejects.toMatchObject({
      rpcErrorCode: 'agent_isolation_unavailable',
    });
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
    expectedHomeOrigin = 'http://127.0.0.1:43188';
    const releaseReplacement = publishServerHttpRuntimeOrigin(expectedHomeOrigin, 'iroh', undefined, serverId);
    onTestFinished(releaseReplacement);
    await expect(targetAuthorityInput.readChildMachineFacts?.(['machine-a'])).resolves.toEqual([]);
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
      timeoutMs: null,
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

});

describe('bind-child source handoff through real daemon controllers', () => {

  it.each(['ordinary', 'bind child'] as const)('READY63 regression: consumes the admitted %s SOURCE mapping without another SOURCE Machine read or admission', async sourceKind => {
    const sourceReads: string[] = [];
    let observeSourceReads = false;
    const [headers, signing, execution, installedContent, socketSchemas] = await Promise.all([
      import('@happier-dev/protocol/actions/externalActionApi'),
      import('@happier-dev/protocol/actions/externalActionExecutionAuthorization'),
      import('@/api/externalActionExecutionAuthorization'), import('@/api/rpc/workspaceSyncTargetContent'),
      import('@happier-dev/protocol/socketRpc'),
    ]);
    let transport: Awaited<ReturnType<typeof composeInstalledBindTargetTransport>> | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true, withTargetChildRuntime: true,
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!transport) throw new Error('The installed TARGET transport is unavailable');
        return transport.call(descriptor, context);
      },
      readAdditionalHttpPostResponse: async (url, body) => transport?.homeResponse(url, body),
      readAdditionalHttpResponse: async url => {
        if (observeSourceReads && /\/v1\/machines\/(source-parent|source-child)$/.test(url)) sourceReads.push(url);
        return undefined;
      } });
    const selected = sourceKind === 'ordinary' ? fixture.sourceRef : fixture.childRef;
    expect(new Set([fixture.childRef.machineId, fixture.targetRef.machineId, fixture.controller.machineId]).size).toBe(3);
    const operationId = `ready63-${sourceKind.replace(' ', '-')}`;
    const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: selected.machineId,
      installationId: sourceKind === 'ordinary' ? fixture.controller.installationId : fixture.childInstallationId,
      role: 'manage' as const, encryptionMode: 'plain' as const };
    const projectInput = OpenProjectInputV1Schema.parse({ serverId: fixture.serverId, machineId: fixture.targetChildRef.machineId,
      source: { kind: 'workspace', workspaceId: selected.id, checkout: { serverId: fixture.serverId,
        workspaceId: selected.id, machineId: selected.machineId, rootPath: selected.rootPath } },
      materialization: { kind: 'sync', targetPath: fixture.targetChildRef.rootPath, workspaceAction: fixture.prepareInput.action } });
    const envelope = headers.ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: operationId,
      target: { kind: 'machine', machineId: fixture.targetChildRef.machineId }, input: projectInput });
    // Home's verified response is the transport boundary. The registered SOURCE
    // handler, mapping, bootstrap, copy and settlement owners below it are real.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-ready63-root', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: fixture.serverId, actionId: 'projects.open', machineId: fixture.targetChildRef.machineId,
      installationId: fixture.targetChildInstallationId, custodianAccountId: 'owner', requestId: operationId,
      requestEnvelopeDigest: signing.computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(operationId),
        sourceWorkspaceRefId: selected.id, source: admission,
        ...(sourceKind === 'bind child' ? { child: { projection: fixture.projection, controller: fixture.controller } } : {}) },
    } });
    const sourceRouting = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId,
      accountServerId: fixture.serverId, sourceMachineId: selected.machineId, sourceRootPath: selected.rootPath,
      originalActionEnvelope: envelope,
      sourceContext: { machineAdmission: admission, callerAuthority: 'present_user', workspaceWrites: 'allow' } });
    const installedIdentities = new Map([fixture.sourceRef.machineId, fixture.targetChildRef.machineId, fixture.targetRef.machineId].map(machineId => {
      const keys = nacl.sign.keyPair();
      return [machineId, { version: 1 as const, createdAt: 1,
        installationId: machineId === fixture.sourceRef.machineId ? fixture.controller.installationId
          : machineId === fixture.targetChildRef.machineId ? fixture.targetChildInstallationId : fixture.managedTargetChild.controller!.installationId,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') }] as const;
    }));
    const installedSource = installedIdentities.get(fixture.sourceRef.machineId)!;
    const installedTarget = installedIdentities.get(fixture.targetChildRef.machineId)!;
    const method = `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const content = installedContent.createWorkspaceSyncTargetContent({ destination: { machineId: fixture.sourceRef.machineId,
      installationId: installedSource.installationId, installationPublicKey: installedSource.publicKey }, method, routing: sourceRouting });
    const params = await socketRpcCodec.encodeParams(content, projectInput, { method, callId: 'a'.repeat(32) });
    const sourceExecution = socketSchemas.WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'ready63-source-packet', params,
      externalActionExecution: execution.createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target }, effectActionId: 'projects.open',
        installationId: installedTarget.installationId, method, requestId: 'ready63-source-packet', params,
        workspaceSyncSourceRouting: sourceRouting, privateKey: installedTarget.privateKey }) });
    transport = await composeInstalledBindTargetTransport(fixture, { operationId, releaseReason: 'copy_committed',
      originalRoot: authorization, sourceRouting, sourceExecution, installedIdentities });
    const source = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!source) throw new Error('The production SOURCE ingress is unavailable');
    const input = { operationId, accountServerId: fixture.serverId, action: fixture.prepareInput.action,
      sourceMachineId: selected.machineId, sourceWorkspaceRefId: selected.id, sourceRootPath: selected.rootPath,
      targetMachineId: fixture.targetChildRef.machineId, targetRootPath: fixture.targetChildRef.rootPath };
    const context = (phase: 'prepare' | 'finalize' | 'commit'): RpcHandlerContext => ({ ...transport!.sourceContext,
      signal: new AbortController().signal,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ ...sourceRouting, phase }) });
    observeSourceReads = true;
    const wrongRelationship = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, workspaceSyncAdmission: { ...authorization.binding.workspaceSyncAdmission!, relationshipId: 'another-relationship' },
    } });
    await expect(source({ v: 1, phase: 'prepare', input }, { ...context('prepare'), callerInputAuthorization: wrongRelationship }))
      .rejects.toMatchObject({ code: 'workspace_sync_source_admission_unavailable' });
    if (sourceKind === 'bind child') {
      const wrongController = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
        ...authorization.binding, workspaceSyncAdmission: { ...authorization.binding.workspaceSyncAdmission!, child: {
          projection: fixture.projection, controller: { ...fixture.controller, machineId: fixture.targetRef.machineId },
        } },
      } });
      await expect(source({ v: 1, phase: 'prepare', input }, { ...context('prepare'), callerInputAuthorization: wrongController }))
        .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    }
    const prepared = WorkspaceSyncHandoffSourcePhaseResultV1Schema.parse(await Promise.resolve(
      source({ v: 1, phase: 'prepare', input }, context('prepare')),
    ).catch(error => {
      if (error instanceof Error) error.message += `; SOURCE admission checks: ${transport!.observed.sourceAdmissionChecks}; TARGET phases: ${JSON.stringify(transport!.observed.phaseOutcomes)}`;
      throw error;
    }));
    expect(prepared.phase).toBe('prepared');
    if (prepared.phase !== 'prepared') throw new Error('The admitted SOURCE did not prepare');
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'admitted SOURCE final bytes');
    expect(await source({ v: 1, phase: 'finalize', input, prepared: prepared.prepared }, context('finalize'))).toMatchObject({ phase: 'finalized' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('admitted SOURCE final bytes');
    expect(await source({ v: 1, phase: 'commit', input, prepared: prepared.prepared }, context('commit'))).toMatchObject({ phase: 'committed' });
    expect(sourceReads).toEqual([]);
    expect(transport.observed.sourceAdmissionChecks).toBe(0);
    for (const probe of [fixture.probeSource, fixture.probeTarget]) {
      const loan = await probe();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
    }
  });

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

  it('keeps remote workspace preparation in its containing lifetime beyond the RPC cutoff', async () => {
    let fixture: Awaited<ReturnType<typeof composeBindChildSourcePhaseTestRuntime>> | undefined;
    let issue = () => {};
    const issued = new Promise<void>(resolve => { issue = resolve; });
    let boundaryWork: Promise<unknown> | undefined;
    let issues = 0;
    fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      handleAdditionalSocketAck: async payload => {
        if (!fixture || !payload || typeof payload !== 'object' || !('method' in payload)
          || typeof payload.method !== 'string'
          || payload.method !== `${fixture.targetRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`
          || !('params' in payload)) return undefined;
        const target = fixture;
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        const receiver = target.targetParentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE);
        if (!receiver) throw new Error('The real target bootstrap handler was not registered');
        boundaryWork = (async () => {
          issues += 1;
          issue();
          await new Promise(resolve => setTimeout(resolve, 28_120));
          const result = await receiver(decoded.params, { signal: new AbortController().signal,
            callerAuthority: 'present_user', machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
              machineId: target.targetRef.machineId, installationId: 'target-parent-installation', role: 'manage', encryptionMode: 'plain' },
            verifyMachineAdmissionCurrent: async () => true });
          return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId) };
        })();
        return await boundaryWork;
      } });
    const current = fixture;
    vi.useFakeTimers();
    let settled = false;
    const pending = current.child.handoffAdapter.prepare(current.prepareInput)
      .then(prepared => ({ ok: true as const, prepared }), error => ({ ok: false as const, error }))
      .then(result => { settled = true; return result; });
    try {
      await Promise.race([issued, pending.then(result => { throw new Error(`Preparation settled before remote admission: ${JSON.stringify(result)}`); })]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(8_120);
      vi.useRealTimers();
      const result = await pending;
      expect(result, result.ok ? undefined : String(result.error)).toMatchObject({ ok: true, prepared: { kind: 'copy_once' } });
      expect(issues).toBe(1);
    } finally {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(28_120);
      vi.useRealTimers();
      await boundaryWork;
      const result = await pending;
      if (result.ok) await current.child.handoffAdapter.abort({ operationId: current.prepareInput.operationId, prepared: result.prepared });
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
    {
      const { operationId, accountServerId, action, sourceMachineId, targetMachineId,
        sourceWorkspaceRefId, targetWorkspaceRefId, sourceRootPath, targetRootPath } = fixture.prepareInput;
      const originalInput = { operationId, accountServerId, action, sourceMachineId, targetMachineId,
        sourceWorkspaceRefId, targetWorkspaceRefId, sourceRootPath, targetRootPath };
      for (const substitutedInput of [
        { ...originalInput, targetReplacementApprovalReceiptId: 'substituted-receipt' },
        { ...originalInput, targetReplacementApprovalActionInput: { sessionId: 'substituted-session' } },
        { ...originalInput, sourceWorkspaceRefId: 'substituted-source-ref' },
        { ...originalInput, sourceMachineId: 'substituted-child' },
        { ...originalInput, sourceRootPath: `${originalInput.sourceRootPath}-unrelated` },
      ]) {
        const forgedSettlement = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({
          v: 1, phase: settlement, input: substitutedInput, prepared,
        });
        await expect(fixture.callWorkspaceSourcePhase({ machineId: fixture.controller.machineId, request: forgedSettlement }))
          .rejects.toMatchObject({ code: 'workspace_sync_operation_conflict' });
        expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
        expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
      }
      const receiver = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
      if (!receiver) throw new Error('The physical SOURCE phase owner was not registered');
      const machineAdmission = { actorAccountId: 'other-requester', custodianAccountId: 'other-requester',
        machineId: originalInput.sourceMachineId, installationId: fixture.childInstallationId,
        role: 'manage' as const, encryptionMode: 'plain' as const };
      const sourceContext = { machineAdmission, callerAuthority: 'present_user' as const };
      await expect(receiver({ v: 1, phase: settlement, input: originalInput, prepared }, {
        machineAdmission, callerAuthority: 'present_user', signal: new AbortController().signal, verifyMachineAdmissionCurrent: async () => true,
        workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: settlement,
          operationId: originalInput.operationId, accountServerId: originalInput.accountServerId,
          sourceMachineId: originalInput.sourceMachineId, sourceRootPath: originalInput.sourceRootPath, sourceContext }),
      })).rejects.toMatchObject({ code: 'workspace_sync_operation_conflict' });
      const unknownOperationId = `${originalInput.operationId}-unprepared`;
      const unknownSettlement = fixture.callWorkspaceSourcePhase({ machineId: fixture.controller.machineId,
        request: WorkspaceSyncHandoffSourcePhaseRequestV1Schema.parse({ v: 1, phase: settlement,
          input: { ...originalInput, operationId: unknownOperationId }, prepared: { ...prepared, operationId: unknownOperationId } }) });
      if (settlement === 'abort') await expect(unknownSettlement).resolves.toMatchObject({ phase: 'aborted' });
      else await expect(unknownSettlement).rejects.toMatchObject({ code: 'workspace_sync_prepare_missing' });
      expect(await fixture.probeSource()).toMatchObject({ kind: 'overlap' });
      expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
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

  it('keeps the admitted physical source through final copy and re-admits a fresh operation', async () => {
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo });
    const prepared = await fixture.child.handoffAdapter.prepare(fixture.prepareInput);
    fixture.driftNativeRoot();
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'admitted source after quiescence');
    await fixture.child.handoffAdapter.finalize({ operationId: fixture.prepareInput.operationId, prepared });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('admitted source after quiescence');
    await fixture.child.handoffAdapter.abort({ operationId: fixture.prepareInput.operationId, prepared });
    const releasedSource = await fixture.probeSource();
    expect(releasedSource).not.toHaveProperty('kind');
    if (!('kind' in releasedSource)) await releasedSource.release();
    await expect(fixture.child.handoffAdapter.prepare({ ...fixture.prepareInput, operationId: 'fresh-child-copy' }))
      .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
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
      const nativeTargetController = fixture.managedTargetChild.controller;
      if (!nativeTargetController) throw new Error('The native fixture requires its installed controller.');
      expect(endpointBeforePrepare).toMatchObject({ machineId: fixture.targetRef.machineId,
        installationId: nativeTargetController.installationId });
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
        const nativeTargetController = currentFixture.managedTargetChild.controller;
        if (!nativeTargetController) throw new Error('The native fixture requires its installed controller.');
        const result = await receiver(decoded.params, { signal: completedTargetRequest.signal, callerAuthority: 'present_user',
          machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: currentFixture.targetRef.machineId,
            installationId: nativeTargetController.installationId, role: 'manage', encryptionMode: 'plain' },
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
