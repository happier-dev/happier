import { join } from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeWorkspaceSyncPolicyDigest, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ProjectAccountRowV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { computeExternalActionRequestEnvelopeDigestV1, isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { deriveWorkspaceSyncRelationshipId } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { logger } from '@/ui/logger';
import { readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { createProjectAccountRowsHttpBoundary, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { createWorkspaceSyncTargetContent } from '@/api/rpc/workspaceSyncTargetContent';
import { createExternalActionMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { WorkspaceSyncSourceExecutionV1Schema } from '@happier-dev/protocol/socketRpc';
import { registerProjectOpenRpcHandlers } from '@/rpc/handlers/projects/registerProjectOpenRpcHandlers';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { composeBindChildSourcePhaseTestRuntime } from './createProductionDaemonWorkspaceSyncRuntime.testkit';

const socketIo = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', async importOriginal => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return { ...actual, io: (...args: Parameters<typeof actual.io>) =>
    typeof args[0] === 'string' && args[0].startsWith('http://127.0.0.1:')
      ? actual.io(...args) : socketIo(...args) };
});

const contentPolicyInput = { v: 1 as const, selection: 'all_files' as const,
  extraIgnorePatterns: [], extraIncludePatterns: [] };
const contentPolicy = { ...contentPolicyInput, policyDigest: computeWorkspaceSyncPolicyDigest(contentPolicyInput) };

// Real requester observation keeps process-scoped custody. Isolate it from the
// older ambient-custodian fixtures so their socket stubs cannot share that state.
describe('signed Project clean preparation', () => {
  it('never lends the host bearer to non-owner copy-once Open with both workspace ids', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => channel.close());
    const requesterCredentials = { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url'), 'fixture-signature',
    ].join('.'), encryption: null };
    const rows: ProjectAccountRowV1[] = [];
    const sentAuthorization: unknown[] = [];
    let observing = false;
    const http = createProjectAccountRowsHttpBoundary(rows);
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      readAdditionalHttpResponse: async (url, config) => {
        if (observing) sentAuthorization.push(config?.headers?.Authorization);
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'requester' } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, body, config) => {
        if (observing) sentAuthorization.push(config?.headers?.Authorization);
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        return url.includes('/v1/account/project-rows/') ? http(url, body) : undefined;
      },
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const input = { operationId: 'requester-copy-open', accountServerId: fixture.serverId,
      action: fixture.prepareInput.action,
      sourceWorkspaceRefId: fixture.sourceRef.id, sourceMachineId: fixture.sourceRef.machineId,
      sourceRootPath: fixture.sourceRef.rootPath, targetWorkspaceRefId: fixture.targetRef.id,
      targetMachineId: fixture.targetRef.machineId, targetRootPath: fixture.targetRef.rootPath };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: input.operationId,
      target: { kind: 'machine', machineId: fixture.targetRef.machineId }, input: OpenProjectInputV1Schema.parse({
        serverId: fixture.serverId, machineId: fixture.targetRef.machineId,
        source: { kind: 'workspace', workspaceId: fixture.sourceRef.id, checkout: { serverId: fixture.serverId,
          workspaceId: fixture.sourceRef.id, machineId: fixture.sourceRef.machineId, rootPath: fixture.sourceRef.rootPath } },
        materialization: { kind: 'sync', targetPath: fixture.targetPath, workspaceAction: input.action } }) });
    const machineAdmission = { actorAccountId: 'requester', custodianAccountId: 'owner',
      machineId: fixture.sourceRef.machineId, installationId: fixture.controller.installationId,
      role: 'use' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-copy-open', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      accountEncryptionMode: 'plain', actionId: 'projects.open', machineId: fixture.targetRef.machineId,
      installationId: fixture.childInstallationId, custodianAccountId: 'owner', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
        sourceWorkspaceRefId: fixture.sourceRef.id, source: machineAdmission },
    } });
    const admitted = await admitRequesterAccountActionContext({ authorization, credentials: requesterCredentials,
      serverId: fixture.serverId, serverIdentityId: fixture.serverId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => true });
    if (!admitted) throw new Error('Requester custody must be admitted before copy-once Open');
    onTestFinished(() => admitted.dispose());
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission, callerInputAuthorization: admitted.authorization, verifyMachineAdmissionCurrent: async () => true,
      originalActionEnvelope: envelope, workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({
        v: 1, phase: 'prepare', operationId: input.operationId, accountServerId: fixture.serverId,
        sourceMachineId: input.sourceMachineId, sourceRootPath: input.sourceRootPath, originalActionEnvelope: envelope,
        sourceContext: { machineAdmission, callerAuthority: 'present_user', workspaceWrites: 'allow' } }) };
    const receiver = fixture.parentRpcHandlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE);
    if (!receiver) throw new Error('The registered copy-once SOURCE entry is unavailable');
    const socketStart = socketIo.mock.calls.length;
    observing = true;
    // No signed target transport is installed: the real target owner must refuse
    // rather than borrowing this source controller's Account to reach the target.
    await expect(receiver({ v: 1, phase: 'prepare', input }, context))
      .rejects.toMatchObject({ code: 'workspace_sync_update_required' });
    expect(sentAuthorization).not.toContain(`Bearer ${fixture.credentials.token}`);
    expect(JSON.stringify(socketIo.mock.calls.slice(socketStart))).not.toContain(fixture.credentials.token);
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['owner', 'manager', 'requester', 'native failure'] as const)('admits persistent Open before effects without retained private execution (%s)', async scenario => {
    const accountId = scenario === 'native failure' ? 'owner' : scenario;
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    let accountMutations = 0;
    let observing = false;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      ...(scenario === 'native failure' ? { nativeCreateFailure: new Error('Native process creation failed') } : {}),
      readAdditionalHttpPostResponse: async (url, body) => {
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (observing && url.endsWith('/mutate')) accountMutations += 1;
        return http(url, body);
      },
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const request = OpenProjectInputV1Schema.parse({ serverId: fixture.serverId, machineId: fixture.targetRef.machineId,
      source: { kind: 'workspace', workspaceId: fixture.sourceRef.id, checkout: { serverId: fixture.serverId,
        workspaceId: fixture.sourceRef.id, machineId: fixture.sourceRef.machineId, rootPath: fixture.sourceRef.rootPath } },
      materialization: { kind: 'sync', targetPath: fixture.targetPath, workspaceAction: {
        kind: 'create_relationship', mode: 'keep_both_in_sync', contentPolicy, flushBeforeCommit: true } } });
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: `installed-open-${accountId}`,
      target: { kind: 'machine', machineId: fixture.targetRef.machineId }, input: request });
    const admission = { actorAccountId: accountId, custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
      installationId: fixture.controller.installationId, role: accountId === 'manager' ? 'manage' as const : 'use' as const,
      encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-installed-open-root', binding: {
      accountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      accountEncryptionMode: 'plain', actionId: 'projects.open', machineId: fixture.targetRef.machineId,
      installationId: fixture.childInstallationId, custodianAccountId: 'owner', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
        sourceWorkspaceRefId: fixture.sourceRef.id, source: admission },
    } });
    const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: envelope.requestId,
      accountServerId: fixture.serverId, sourceMachineId: fixture.sourceRef.machineId, sourceRootPath: fixture.sourceRef.rootPath,
      originalActionEnvelope: envelope, sourceContext: { machineAdmission: admission, callerAuthority: 'present_user', workspaceWrites: 'allow' } });
    const keys = tweetnacl.sign.keyPair();
    const method = `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const content = createWorkspaceSyncTargetContent({ destination: { machineId: fixture.sourceRef.machineId,
      installationId: fixture.controller.installationId, installationPublicKey: Buffer.from(keys.publicKey).toString('base64url') },
      method, routing });
    const params = await socketRpcCodec.encodeParams(content, request, { method, callId: 'c'.repeat(32) });
    const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'installed-open-packet', params,
      externalActionExecution: createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target },
        effectActionId: 'projects.open', installationId: fixture.childInstallationId, method,
        requestId: 'installed-open-packet', params, workspaceSyncSourceRouting: routing,
        privateKey: Buffer.from(keys.secretKey).toString('base64url') }) });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: admission, verifyMachineAdmissionCurrent: async () => true, callerInputAuthorization: authorization,
      originalActionEnvelope: envelope, workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: sourceExecution };
    expect(fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId: envelope.requestId })).toBeNull();
    const handlers = new Map<string, (raw: unknown, context?: RpcHandlerContext) => unknown>();
    registerProjectOpenRpcHandlers({ registerHandler(method, handler) {
      handlers.set(method, (raw, admitted) => handler(raw as Parameters<typeof handler>[0], admitted));
    } }, { serverId: fixture.serverId, machineId: fixture.sourceRef.machineId, runtime: {
      serverId: fixture.serverId, machineId: fixture.sourceRef.machineId, accountId: 'owner',
      serverHttpBaseUrl: 'https://bind-child-home.invalid', workspaceSyncAdapter: fixture.parent.handoffAdapter,
      readCredentials: async () => fixture.credentials } });
    const receiver = handlers.get(RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN);
    if (!receiver) throw new Error('The registered persistent Open SOURCE entry is unavailable');
    const settlement = vi.spyOn(logger, 'warnLocalFile');
    onTestFinished(() => settlement.mockRestore());
    observing = true;
    const result = await receiver(request, context);
    if (scenario === 'native failure') {
      expect(accountMutations).toBeGreaterThan(0);
      expect(result).toMatchObject({ kind: 'outcomeUnknown' });
      expect(settlement.mock.calls).toContainEqual(['[Project Open] Source Sync settlement failed',
        expect.objectContaining({ effectsIssued: true })]);
    } else if (accountId !== 'requester') {
      expect(result, JSON.stringify(settlement.mock.calls)).toMatchObject({ kind: 'materialized' });
      expect(accountMutations).toBeGreaterThan(0);
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      expect(rows.some(row => row.key.kind === 'relationship-graph')).toBe(true);
    } else {
      expect(accountMutations).toBe(0);
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result).toMatchObject({ kind: 'refused', code: 'project_requester_authority_unavailable' });
      expect(settlement.mock.calls).toContainEqual(['[Project Open] Source Sync settlement failed',
        expect.objectContaining({ effectsIssued: false, code: 'project_requester_authority_unavailable' })]);
    }
  });

  it.each(['requester', 'owner'] as const)('keeps persistent Script preparation in its requester Account (%s)', async requesterAccountId => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => channel.close());
    const requesterCredentials = { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: requesterAccountId })).toString('base64url'), 'fixture-signature',
    ].join('.'), encryption: null };
    const rows: ProjectAccountRowV1[] = [];
    const accountEffects: string[] = [];
    let preparing = false;
    const requesterBearer = `Bearer ${requesterCredentials.token}`;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      readAdditionalHttpResponse: async (url, config) => {
        const accountId = config?.headers?.Authorization === requesterBearer ? 'requester' : 'owner';
        if (preparing) accountEffects.push(accountId);
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: {
          id: accountId === 'requester' ? requesterAccountId : 'owner' } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, _body, config) => {
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (preparing) accountEffects.push(config?.headers?.Authorization === requesterBearer ? 'requester' : 'owner');
        if (!url.endsWith('/list')) throw new Error('Preparation cannot mutate either Account graph');
        return { status: 200, data: { status: 'listed', coverage: 'complete', rows } };
      },
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const relationship = { v: 1 as const, relationshipId: 'non-owner-script-link',
      controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
      betaWorkspaceRefId: fixture.targetRef.id, mode: 'keep_both_in_sync' as const,
      contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
    const graphKey = { kind: 'relationship-graph' as const };
    const publishGraph = async (enabled: boolean) => {
      const row = ProjectAccountRowV1Schema.parse({ key: graphKey, revision: enabled ? 1 : 0,
        content: cipher.seal({ key: graphKey, value: { relationships: [{ ...relationship, enabled }] } }) });
      const index = rows.findIndex(value => value.key.kind === 'relationship-graph');
      if (index < 0) rows.push(row); else rows[index] = row;
      await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
        credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
      await fixture.settleProjects();
    };
    await mkdir(fixture.targetPath);
    await publishGraph(false);
    await fixture.parentManagedWorkspaceSync.ensure(relationship, undefined, { transient: true, targetBootstrap: 'use_existing' });
    await publishGraph(true);
    const before = 'controller target before requester preparation';
    await writeFile(join(fixture.targetPath, 'payload.txt'), before);
    await writeFile(join(fixture.sourcePath, 'payload.txt'), 'requester preparation must not borrow the installed link');
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'non-owner-script',
      target: { kind: 'machine', machineId: fixture.targetRef.machineId }, input: {
        workspace: { serverId: fixture.serverId, machineId: fixture.sourceRef.machineId,
          workspaceId: fixture.sourceRef.id, rootPath: fixture.sourceRef.rootPath }, selection: { kind: 'named', name: 'test' },
      } });
    const machineAdmission = { actorAccountId: requesterAccountId, custodianAccountId: 'owner',
      machineId: fixture.sourceRef.machineId, installationId: fixture.controller.installationId,
      role: 'use' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: requesterAccountId, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: fixture.targetRef.machineId, custodianAccountId: 'owner', installationId: fixture.controller.installationId,
      actionId: 'projects.script.run', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId), sourceWorkspaceRefId: fixture.sourceRef.id,
        source: machineAdmission },
    } });
    const admitted = await admitRequesterAccountActionContext({ authorization, credentials: requesterCredentials,
      serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => true });
    if (!admitted) throw new Error('The real requester projection must be admitted before preparation');
    onTestFinished(() => admitted.dispose());
    expect(readRequesterAccountActionContext(admitted.authorization)).toBe(admitted);
    expect(isExternalActionAuthorizationBoundToEnvelope(admitted.authorization.binding, {
      actionId: 'projects.script.run', machineId: fixture.targetRef.machineId, envelope,
    })).toBe(true);
    const receiver = fixture.parentRpcHandlers.get('daemon.workspaceSync.prepareBetween.v1');
    if (!receiver) throw new Error('The registered production preparation entry is unavailable');
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
      originalActionEnvelope: envelope, callerInputAuthorization: admitted.authorization, machineAdmission,
      verifyMachineAdmissionCurrent: async () => true,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
        operationId: envelope.requestId, accountServerId: fixture.serverId, sourceMachineId: fixture.sourceRef.machineId,
        sourceRootPath: fixture.sourceRef.rootPath, originalActionEnvelope: envelope,
        sourceContext: { machineAdmission, callerAuthority: 'account_automation' } }),
    };
    preparing = true;
    const result = await receiver({ sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id }, context)
      .then(value => ({ kind: 'returned' as const, value }), (error: unknown) => ({ kind: 'refused' as const,
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined }));
    expect(accountEffects).toContain('requester');
    if (requesterAccountId === 'requester') {
      expect(accountEffects).not.toContain('owner');
      // No private execution was supplied. A typed refusal must leave T's bytes alone.
      expect(result.kind === 'refused' ? result.code
        : result.value && typeof result.value === 'object' && 'errorCode' in result.value ? result.value.errorCode : undefined)
        .toBe('agent_isolation_unavailable');
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(before);
    } else {
      expect(result).toMatchObject({ kind: 'returned', value: { ok: true } });
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8'))
        .toBe('requester preparation must not borrow the installed link');
    }
  });

  it('uses one fresh route read per handoff and receiving preparation, including repeated invocations', async () => {
    const channel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(async () => await channel.close());
    const rows: ProjectAccountRowV1[] = [];
    let readRows = async () => rows;
    let rowReads = 0;
    let current = true;
    let afterNextRouteRead: (() => void) | undefined;
    let afterNextCopy: (() => void) | undefined;
    const deliveries: unknown[] = [];
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      onNativeFlush: () => {
        const afterCopy = afterNextCopy;
        afterNextCopy = undefined;
        afterCopy?.();
      },
      readAdditionalHttpResponse: async url => {
        return url.endsWith('/v1/account/encryption/currentness')
        ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
        : url.endsWith('/v1/account/profile')
        ? { status: 200, data: { id: 'owner' } }
        : url.endsWith('/v2/account/settings')
          ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } } : undefined;
      },
      readAdditionalHttpPostResponse: async (url, body) => {
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (!url.endsWith('/project-rows/list') && !url.endsWith('/project-rows/read')) return undefined;
        rowReads += 1;
        const response = projectAccountRowsReadHttpResponse(await readRows(), url, body);
        const afterRead = afterNextRouteRead;
        afterNextRouteRead = undefined;
        afterRead?.();
        return response;
      },
      // Signed Machine delivery is the network boundary. Route admission,
      // requester custody, row decoding and the result schema stay real.
      callWorkspacePrepareBetween: async descriptor => {
        deliveries.push(descriptor);
        return { ok: true, traversed: [] };
      },
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    for (const value of [fixture.sourceRef, fixture.targetRef]) {
      const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: value.id };
      rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value }) }));
    }
    const key = { kind: 'relationship-graph' as const };
    const relationship = {
      v: 1 as const, relationshipId: 'requester-clean', controllerMachineId: fixture.sourceRef.machineId,
      alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetRef.id,
      mode: 'keep_both_in_sync' as const, contentPolicy, enabled: true, createdAtMs: 1, updatedAtMs: 1,
    };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0,
      content: cipher.seal({ key, value: { relationships: [relationship] } }) }));
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'causal-clean',
      target: { kind: 'machine', machineId: fixture.targetRef.machineId }, input: {
        workspace: { serverId: fixture.serverId, machineId: fixture.sourceRef.machineId,
          workspaceId: fixture.sourceRef.id, rootPath: fixture.sourceRef.rootPath }, selection: { kind: 'named', name: 'test' },
      } });
    const sourceMachineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner',
      machineId: fixture.sourceRef.machineId, installationId: fixture.controller.installationId,
      role: 'manage' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.managedHomeId,
      machineId: fixture.targetRef.machineId, custodianAccountId: 'owner', installationId: 'parent-installation',
      actionId: 'projects.script.run', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), accountEncryptionMode: 'plain',
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
        sourceWorkspaceRefId: fixture.sourceRef.id, source: sourceMachineAdmission },
    } });
    const diagnostics = vi.spyOn(logger, 'warnLocalFile');
    onTestFinished(() => diagnostics.mockRestore());
    const admitted = await admitRequesterAccountActionContext({ authorization, credentials: fixture.credentials,
      serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => current });
    if (!admitted) throw new Error(`Requester custody was not admitted: ${JSON.stringify(diagnostics.mock.calls)}`);
    onTestFinished(async () => await admitted.dispose());
    const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
      serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', target: authorization.binding.target,
      installationId: 'parent-installation', privateKey: tweetnacl.sign.keyPair().secretKey, isCurrent: admitted.isCurrent });
    if (!carrier) throw new Error('Requester HTTP custody was not admitted');
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation', originalActionEnvelope: envelope,
      callerInputAuthorization: carrier, verifyMachineAdmissionCurrent: async () => current,
      machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.targetRef.machineId,
        installationId: 'parent-installation', role: 'manage', encryptionMode: 'plain' } };
    const request = { sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id };
    for (let invocation = 0; invocation < 2; invocation += 1) {
      rowReads = 0;
      await expect(fixture.child.handoffAdapter.prepareBetween(request, context.signal, context))
        .resolves.toEqual({ ok: true, traversed: [] });
      expect.soft(rowReads).toBe(1);
    }
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ machineId: fixture.sourceRef.machineId, sourceWorkspace: fixture.sourceRef, request });
    await mkdir(fixture.targetPath, { recursive: true });
    const graphIndex = rows.findIndex(row => row.key.kind === 'relationship-graph');
    const refreshRelationship = async (enabled: boolean, revision: number) => {
      rows[graphIndex] = ProjectAccountRowV1Schema.parse({ key, revision,
        content: cipher.seal({ key, value: { relationships: [{ ...relationship, enabled }] } }) });
      await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
        credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed',
      }));
      await fixture.settleProjects();
    };
    // Establish real target bootstrap custody before enabling the retained link.
    await refreshRelationship(false, 0);
    await fixture.parentManagedWorkspaceSync.ensure(relationship, undefined,
      { transient: true, targetBootstrap: 'use_existing' });
    await refreshRelationship(true, 1);
    const receiver = fixture.parentRpcHandlers.get('daemon.workspaceSync.prepareBetween.v1');
    if (!receiver) throw new Error('Production preparation receiver is unavailable');
    const receivingContext: RpcHandlerContext = { ...context, machineAdmission: sourceMachineAdmission,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare',
        operationId: envelope.requestId, accountServerId: fixture.serverId,
        sourceMachineId: fixture.sourceRef.machineId, sourceRootPath: fixture.sourceRef.rootPath,
        originalActionEnvelope: envelope, sourceContext: { machineAdmission: sourceMachineAdmission,
          callerAuthority: 'account_automation' } }) };
    for (let invocation = 0; invocation < 2; invocation += 1) {
      const payload = `source edit at dequeue ${invocation}`;
      await writeFile(join(fixture.sourcePath, 'payload.txt'), payload);
      rowReads = 0;
      await expect(receiver(request, receivingContext)).resolves.toMatchObject({ ok: true,
        traversed: [{ relationshipId: 'requester-clean' }] });
      expect.soft(rowReads).toBe(1);
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(payload);
    }
    rowReads = 0;
    await expect(fixture.parent.handoffAdapter.prepareBetween(request, context.signal, receivingContext))
      .resolves.toMatchObject({ ok: true, traversed: [{ relationshipId: 'requester-clean' }] });
    expect(rowReads).toBe(1);

    // A requester-private row can change after admission without updating the
    // daemon's installed Account projection before its queued physical copy.
    for (const changeKind of ['disabled relationship', 'changed endpoint'] as const) {
      const acceptedRows = [...rows];
      const payload = `${changeKind} applies at the next admission`;
      await writeFile(join(fixture.sourcePath, 'payload.txt'), payload);
      // Change Home rows after returning the admitted snapshot; the native
      // effect must retain that snapshot's endpoint rather than resolve its id again.
      afterNextRouteRead = () => {
        rows[graphIndex] = ProjectAccountRowV1Schema.parse({ key, revision: 2,
          content: cipher.seal({ key, value: { relationships: [{ ...relationship,
            enabled: changeKind !== 'disabled relationship' }] } }) });
        if (changeKind === 'changed endpoint') {
          const refKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.targetRef.id };
          const refIndex = rows.findIndex(row => row.key.kind === 'workspace-ref' && row.key.id === fixture.targetRef.id);
          rows[refIndex] = ProjectAccountRowV1Schema.parse({ key: refKey, revision: 1,
            content: cipher.seal({ key: refKey, value: { ...fixture.targetRef,
              rootPath: join(fixture.targetPath, 'rebound') } }) });
        }
      };
      await expect.soft(receiver(request, receivingContext), changeKind).resolves.toMatchObject({ ok: true });
      expect.soft(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8'), changeKind).toBe(payload);
      if (changeKind === 'disabled relationship') {
        await expect(receiver(request, receivingContext)).resolves.toMatchObject({ ok: false });
      }
      expect(await stat(join(fixture.targetPath, 'rebound')).catch(() => null)).toBeNull();
      rows.splice(0, rows.length, ...acceptedRows);
    }

    // Withdrawal after the first physical copy affects the next preparation,
    // while both effects of this admitted star route finish.
    const laterRef = { ...fixture.targetRef, id: 'later-ref', rootPath: join(fixture.targetPath, '..', 'later-target') };
    const laterKey = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: laterRef.id };
    const laterRow = ProjectAccountRowV1Schema.parse({ key: laterKey, revision: 0,
      content: cipher.seal({ key: laterKey, value: laterRef }) });
    const laterLink = { ...relationship, relationshipId: 'later-link',
      betaWorkspaceRefId: laterRef.id };
    await mkdir(laterRef.rootPath);
    rows.push(laterRow);
    rows[graphIndex] = ProjectAccountRowV1Schema.parse({ key, revision: 2,
      content: cipher.seal({ key, value: { relationships: [relationship, { ...laterLink, enabled: false }] } }) });
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed',
    }));
    await fixture.settleProjects();
    await fixture.parentManagedWorkspaceSync.ensure(laterLink, undefined, { transient: true, targetBootstrap: 'use_existing' });
    const laterEnvelope = ExternalActionRequestEnvelopeV1Schema.parse({ ...envelope, requestId: 'two-link-clean', input: {
      workspace: { serverId: fixture.serverId, machineId: fixture.targetRef.machineId,
        workspaceId: fixture.targetRef.id, rootPath: fixture.targetRef.rootPath }, selection: { kind: 'named', name: 'test' },
    } });
    const laterAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, requestId: laterEnvelope.requestId,
        workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(laterEnvelope.requestId),
          sourceWorkspaceRefId: fixture.targetRef.id, source: context.machineAdmission },
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(laterEnvelope) } });
    const laterAdmitted = await admitRequesterAccountActionContext({ authorization: laterAuthorization,
      credentials: fixture.credentials, serverId: fixture.serverId, serverIdentityId: fixture.managedHomeId,
      serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => current });
    if (!laterAdmitted) throw new Error('Two-link requester custody was not admitted');
    onTestFinished(async () => await laterAdmitted.dispose());
    const laterContext: RpcHandlerContext = { ...receivingContext, callerInputAuthorization: laterAdmitted.authorization,
      originalActionEnvelope: laterEnvelope,
      workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1Schema.parse({ ...receivingContext.workspaceSyncSourceRouting,
        operationId: laterEnvelope.requestId, sourceMachineId: fixture.targetRef.machineId,
        sourceRootPath: fixture.targetRef.rootPath, originalActionEnvelope: laterEnvelope }) };
    const copiedPayload = 'first link completed before later link changed';
    await writeFile(join(fixture.sourcePath, 'payload.txt'), copiedPayload);
    readRows = async () => [...rows.filter(row => row.key.kind !== 'relationship-graph'),
      ProjectAccountRowV1Schema.parse({ key, revision: 2, content: cipher.seal({ key, value: { relationships:
        await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8') === copiedPayload
          ? [relationship] : [relationship, laterLink] } }) })];
    rowReads = 0;
    await expect(receiver({ sourceWorkspaceRefId: fixture.targetRef.id, targetWorkspaceRefId: laterRef.id }, laterContext))
      .resolves.toMatchObject({ ok: true, traversed: [
        { relationshipId: relationship.relationshipId }, { relationshipId: laterLink.relationshipId }] });
    expect(rowReads).toBe(1);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(copiedPayload);
    expect(await readFile(join(laterRef.rootPath, 'payload.txt'), 'utf8')).toBe(copiedPayload);
    await expect(receiver({ sourceWorkspaceRefId: fixture.targetRef.id, targetWorkspaceRefId: laterRef.id }, laterContext))
      .resolves.toMatchObject({ ok: false });
    rows[graphIndex] = ProjectAccountRowV1Schema.parse({ key, revision: 3,
      content: cipher.seal({ key, value: { relationships: [relationship] } }) });
    readRows = async () => rows;

    // Already admitted finite work finishes; the next request observes revocation.
    const admittedPayload = 'admitted edit completes before the next request';
    await writeFile(join(fixture.sourcePath, 'payload.txt'), admittedPayload);
    afterNextCopy = () => { current = false; };
    await expect(receiver(request, receivingContext)).resolves.toMatchObject({ ok: true });
    current = false;
    await expect(fixture.child.handoffAdapter.prepareBetween(request, context.signal, context))
      .rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(deliveries).toHaveLength(2);
    await expect(receiver(request, receivingContext)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(admittedPayload);
  });

});
