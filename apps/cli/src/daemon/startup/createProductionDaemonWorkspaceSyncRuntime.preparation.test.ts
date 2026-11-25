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
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { AxiosError } from 'axios';
import type { AdmittedRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
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
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(input.operationId),
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

  it.each(['owner', 'manager', 'requester', 'native failure'] as const)('requires requester custody for non-owner persistent Open before effects (%s)', async scenario => {
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
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(`installed-open-${accountId}`),
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
    } else if (accountId === 'owner') {
      expect(result, JSON.stringify(settlement.mock.calls)).toMatchObject({ kind: 'materialized' });
      expect(accountMutations).toBeGreaterThan(0);
      expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      expect(rows.some(row => row.key.kind === 'relationship-graph')).toBe(true);
    } else {
      // Manage admits Machine work, but does not lend the custodian's Account
      // graph. Both non-owner roles need their own retained requester custody.
      expect(accountMutations).toBe(0);
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(result).toMatchObject({ kind: 'refused', code: 'project_requester_authority_unavailable' });
      expect(settlement.mock.calls).toContainEqual(['[Project Open] Source Sync settlement failed',
        expect.objectContaining({ effectsIssued: false, code: 'project_requester_authority_unavailable' })]);
    }
  });

  // L12 READY218: Home refuses a non-custodian's raw custodian-only TARGET bootstrap and admits
  // the signed writer → target path at Use. Both Home decisions below read the route policy
  // owner and the TARGET grant the way Home does, so a call on the wrong path is refused here too.
  it.each(['use member', 'no Use on the TARGET', 'no admitted context'] as const)(
    'bootstraps a member Keep updated TARGET only through the signed writer → target path (%s)', async scenario => {
    const targetOwner = 'target-owner';
    const targetCredentials = { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: targetOwner })).toString('base64url'), 'fixture-signature',
    ].join('.'), encryption: null };
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const raw: Array<Readonly<{ method: string; refused: boolean }>> = [];
    const signed: Array<Readonly<{ phase: string; reason?: string; refused?: true }>> = [];
    const targetResults: unknown[] = [];
    const targetRole = scenario === 'no Use on the TARGET' ? null : 'use' as const;
    const homeRefusal = (failureCause?: Readonly<{ phase: string; errorCode: string }>) => ({ ok: false as const,
      error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN,
      ...(failureCause ? { failureCause: { ...failureCause, errorClass: 'Error' as const, httpStatus: 403 }, effectAttempted: false as const } : {}) });
    const targetInstallation = { machineId: 'target-parent', installationId: 'target-parent-installation',
      installationPublicKey: Buffer.from(tweetnacl.sign.keyPair().publicKey).toString('base64url') };
    let current: Awaited<ReturnType<typeof composeBindChildSourcePhaseTestRuntime>> | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      separateTargetParent: true, targetCredentials,
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/') ? http(url, body) : undefined,
      // Home's generic Machine admission of a raw call: a custodian-only route needs the TARGET custodian.
      handleAdditionalSocketAck: async (payload, token) => {
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
          || !payload.method.startsWith('target-parent:daemon.workspaceSync.')) return undefined;
        const method = payload.method.slice('target-parent:'.length);
        const refused = resolveMachineRpcRoutePolicy(method).sharedMachineAccess === 'custodian_only'
          && readAccountIdFromToken(token ?? '') !== targetOwner;
        raw.push({ method, refused });
        return refused ? homeRefusal({ phase: 'rpc.admission.machine', errorCode: 'custodian_only' }) : undefined;
      },
      // Home's writer → target admission, then the TARGET daemon's own registered receiver.
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!current) throw new Error('The TARGET runtime is not composed');
        const phase = descriptor.routing.phase;
        const writer = context.workspaceSyncSourceWriterTargetRouting;
        const source = writer?.source ?? context.workspaceSyncSourceRouting;
        const root = context.callerInputAuthorization;
        const admission = context.machineAdmission;
        if (descriptor.machineId !== current.targetRef.machineId || !source?.sourceContext) throw new Error('Home has no writer → target route');
        if (phase === 'release') {
          // Rootless cleanup: only the installed SOURCE writer, under its own custody.
          if (root || writer?.target.phase !== 'release' || !descriptor.physicalEndpoint || !admission
            || admission.actorAccountId !== 'owner' || admission.custodianAccountId !== 'owner'
            || admission.machineId !== current.sourceRef.machineId || writer.sourceWriter.machineId !== admission.machineId) {
            signed.push({ phase, refused: true });
            throw createRpcCallError(homeRefusal());
          }
        } else if (root?.binding.actionId !== 'projects.open' || root.binding.machineId !== current.targetRef.machineId
          || source.operationId !== root.binding.requestId || !targetRole) {
          // TARGET resolution needs the requester's Use; refused before it is forwarded.
          signed.push({ phase, refused: true });
          throw createRpcCallError(homeRefusal());
        }
        const request = descriptor.request;
        signed.push({ phase, ...(phase === 'release' && request && typeof request === 'object' && 'reason' in request
          ? { reason: String(request.reason) } : {}) });
        // The TARGET's own materialization is not composed here: it refuses its prepare typed, so the
        // creation must release through the signed cleanup path to the installation the preflight proved.
        if (phase === 'prepare') throw createRpcCallError({ error: 'The TARGET refused its preparation', errorCode: 'target_prepare_refused' });
        const receiver = current.targetParentRpcHandlers.get(descriptor.method);
        if (!receiver) throw new Error(`The TARGET receiver is not registered: ${descriptor.method}`);
        const incoming: RpcHandlerContext = phase === 'release'
          ? { signal: new AbortController().signal, callerAuthority: 'present_user', machineAdmission: admission,
              workspaceSyncSourceWriterTargetRouting: writer, verifyMachineAdmissionCurrent: async () => true }
          : { signal: new AbortController().signal, callerAuthority: source.sourceContext.callerAuthority,
              machineAdmission: { actorAccountId: root!.binding.accountId, custodianAccountId: targetOwner,
                machineId: targetInstallation.machineId, installationId: targetInstallation.installationId,
                role: targetRole!, encryptionMode: 'plain' },
              callerInputAuthorization: root,
              ...(context.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: context.workspaceSyncSourceExecution } : {}),
              workspaceSyncSourceWriterTargetRouting: { v: 1,
                sourceWriter: { machineId: current.sourceRef.machineId, installationId: current.controller.installationId },
                source, target: descriptor.routing },
              verifyMachineAdmissionCurrent: async () => true };
        // The TARGET is a separate installed daemon: it reads its own published rows first.
        const readRows = (credentials: typeof targetCredentials) => runWithServerHttpBaseUrl('https://bind-child-home.invalid',
          () => readProjectAccountRows({ credentials, serverId: current!.serverId, publication: 'installed' }));
        await readRows(targetCredentials);
        await current.settleProjects(targetInstallation.machineId);
        let result: unknown;
        try { result = await receiver(request, incoming); } finally {
          await readRows(current.credentials);
          await current.settleProjects(current.sourceRef.machineId);
        }
        targetResults.push({ phase, result });
        // The SOURCE client binds a TARGET-owned result to Home's verified destination.
        return phase !== 'release' && result && typeof result === 'object' && 'targetWorkspace' in result
          ? { ...result, physicalEndpoint: targetInstallation } : result;
      },
    });
    current = fixture;
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const workspaceAction = { kind: 'create_relationship' as const, mode: 'keep_both_in_sync' as const, contentPolicy, flushBeforeCommit: true as const };
    if (scenario === 'no admitted context') {
      // The Machine owner's own Sync: no admitted requester, so today's raw path, which Home refuses here.
      await expect(runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => fixture.parent.handoffAdapter.prepare({
        operationId: 'owner-own-sync', accountServerId: fixture.serverId,
        action: workspaceAction, sourceMachineId: fixture.sourceRef.machineId, sourceWorkspaceRefId: fixture.sourceRef.id,
        sourceRootPath: fixture.sourceRef.rootPath, targetMachineId: fixture.targetRef.machineId,
        targetRootPath: fixture.targetPath }))).rejects.toMatchObject({ code: RPC_ERROR_CODES.FORBIDDEN });
      expect(signed).toEqual([]);
      expect(raw).toContainEqual({ method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE, refused: true });
      return;
    }
    const request = OpenProjectInputV1Schema.parse({ serverId: fixture.serverId, machineId: fixture.targetRef.machineId,
      source: { kind: 'workspace', workspaceId: fixture.sourceRef.id, checkout: { serverId: fixture.serverId,
        workspaceId: fixture.sourceRef.id, machineId: fixture.sourceRef.machineId, rootPath: fixture.sourceRef.rootPath } },
      materialization: { kind: 'sync', targetPath: fixture.targetPath, workspaceAction } });
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'member-keep-updated-open',
      target: { kind: 'machine', machineId: fixture.targetRef.machineId }, input: request });
    // The member's own SOURCE Machine: its installed Account is the requester.
    const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
      installationId: fixture.controller.installationId, role: 'manage' as const, encryptionMode: 'plain' as const };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-member-open-root', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      accountEncryptionMode: 'plain', actionId: 'projects.open', machineId: fixture.targetRef.machineId,
      installationId: targetInstallation.installationId, custodianAccountId: targetOwner, requestId: envelope.requestId,
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
    const params = await socketRpcCodec.encodeParams(content, request, { method, callId: 'd'.repeat(32) });
    const sourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'member-open-packet', params,
      externalActionExecution: createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target },
        effectActionId: 'projects.open', installationId: targetInstallation.installationId, method,
        requestId: 'member-open-packet', params, workspaceSyncSourceRouting: routing,
        privateKey: Buffer.from(keys.secretKey).toString('base64url') }) });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'present_user',
      machineAdmission: admission, verifyMachineAdmissionCurrent: async () => true, callerInputAuthorization: authorization,
      originalActionEnvelope: envelope, workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: sourceExecution };
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
    const result = await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => receiver(request, context));
    expect(raw.filter(call => call.refused)).toEqual([]);
    if (scenario === 'no Use on the TARGET') {
      // Refused typed by Home at the first TARGET call, before any Account or TARGET effect.
      expect(result).toMatchObject({ kind: 'refused', code: RPC_ERROR_CODES.FORBIDDEN });
      expect(signed).toEqual([{ phase: 'preflight', refused: true }]);
      expect(rows.flatMap(row => {
        if (row.key.kind !== 'relationship-graph' || row.content === null) return [];
        const payload = cipher.open(row.key, row.content);
        return 'relationships' in payload.value ? payload.value.relationships : [];
      })).toEqual([]);
      return;
    }
    // Admitted at Use: preflight and prepare go signed with the admitted root, and the abort release
    // goes from the installed writer to the preflight's installation, never raw.
    expect(result, JSON.stringify({ settlement: settlement.mock.calls, targetResults }))
      .toMatchObject({ kind: 'refused', code: 'target_prepare_refused' });
    expect(signed).toEqual([{ phase: 'preflight' }, { phase: 'prepare' }, { phase: 'release', reason: 'abort' }]);
  });

  // HANDOFF-SYNC-CHILD-1124: a person with Manage on another Account's SOURCE hands a Session to their own
  // TARGET. Home shows that TARGET row only to Accounts that can see it, so the SOURCE owner's custody reads 404.
  it.each(['own TARGET', 'own TARGET, isolation on', "another Account's TARGET", 'no admitted requester'] as const)(
    'observes the handoff TARGET with the admitted requester custody and the bound SOURCE with its own (%s)', async scenario => {
    const person = 'target-owner';
    const personCredentials = { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: person })).toString('base64url'), 'fixture-signature',
    ].join('.'), encryption: null };
    const targetVisibleTo = scenario === "another Account's TARGET" ? 'third-account' : person;
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const machineReads: Array<Readonly<{ machineId: string; accountId: string | null }>> = [];
    let observing = false;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      separateTargetParent: true, targetCredentials: personCredentials,
      ...(scenario === 'own TARGET, isolation on' ? { agentIsolation: { managedHappierBinaryPath: '/opt/happier/cli/current/happier',
        read: () => ({ enabled: true, memberProvisioning: 'linuxUsersV1' as const,
          status: { kind: 'effective' as const, platform: 'linux' as const, agentUser: 'happier-agent' }, workspaceRoots: [] }) } } : {}),
      readAdditionalHttpPostResponse: async (url, body) => url.includes('/v1/account/project-rows/') ? http(url, body) : undefined,
      // Home's Machine row read: the TARGET row exists only for an Account that can see it.
      readAdditionalHttpResponse: async (url, config) => {
        const machineId = /\/v1\/machines\/([^/]+)$/u.exec(new URL(url).pathname)?.[1];
        if (!observing || !machineId) return undefined;
        const bearer = config?.headers?.Authorization;
        const accountId = typeof bearer === 'string' ? readAccountIdFromToken(bearer.replace(/^Bearer /u, '')) : null;
        machineReads.push({ machineId, accountId });
        if (machineId === 'target-parent' && accountId !== targetVisibleTo) {
          throw new AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined,
            { status: 404, statusText: 'Not Found', headers: {}, config: { headers: {} } as never, data: {} });
        }
        return undefined;
      },
    });
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const input = { operationId: 'manage-member-handoff', accountServerId: fixture.serverId,
      action: { kind: 'create_relationship' as const, mode: 'keep_both_in_sync' as const, contentPolicy, flushBeforeCommit: true as const },
      sourceMachineId: fixture.sourceRef.machineId, sourceWorkspaceRefId: fixture.sourceRef.id, sourceRootPath: fixture.sourceRef.rootPath,
      targetMachineId: fixture.targetRef.machineId, targetRootPath: fixture.targetPath };
    // The handoff coordinator's admitted requester: the person, on the bound SOURCE they hold Manage on.
    const requesterSessionBootstrap = { credentials: personCredentials, serverHttpBaseUrl: 'https://bind-child-home.invalid',
      attribution: { serverId: fixture.serverId, accountId: person, machineId: fixture.sourceRef.machineId,
        installationId: fixture.controller.installationId } } as unknown as AdmittedRequesterSessionBootstrap;
    const context: RpcHandlerContext | undefined = scenario === 'no admitted requester' ? undefined
      : { signal: new AbortController().signal, requesterSessionBootstrap };
    observing = true;
    const settled = await runWithServerHttpBaseUrl('https://bind-child-home.invalid',
      () => fixture.parent.handoffAdapter.prepare(input, undefined, context)).then(value => ({ value }), (error: unknown) => ({ error }));
    observing = false;
    const refusal = 'error' in settled && settled.error && typeof settled.error === 'object' ? settled.error : undefined;
    // The bound SOURCE is read with its own custody in every case.
    expect(machineReads.filter(read => read.machineId === 'source-parent').map(read => read.accountId)).toEqual(['owner']);
    if (scenario === 'no admitted requester') {
      // Parity: today's path reads both rows with the SOURCE custody, and the TARGET row is not there for it.
      expect(machineReads.filter(read => read.machineId === 'target-parent').map(read => read.accountId)).toEqual(['owner']);
    } else {
      // The person's TARGET is never read with the SOURCE owner's custody.
      expect(machineReads.filter(read => read.machineId === 'target-parent').map(read => read.accountId)).toEqual([person]);
    }
    if (scenario === 'own TARGET' || scenario === 'own TARGET, isolation on') {
      const code = scenario === 'own TARGET' ? 'workspace_sync_requester_link_unavailable' : 'agent_isolation_unavailable';
      // Past the Machine read. Until the person's own link owner exists for a handoff (ruling 23:16Z (a)),
      // the installed owner refuses before any effect, typed and phased, without naming isolation (off here).
      expect(refusal).toMatchObject({ code, failureCause: { phase: 'workspace_sync.relationship_owner.select', errorCode: code } });
      expect(rows.some(row => row.key.kind === 'relationship-graph')).toBe(false);
      return;
    }
    expect(refusal).toMatchObject({ code: 'workspace_sync_child_unavailable',
      failureCause: { phase: 'workspace_sync.endpoint_machine.read', errorCode: 'workspace_sync_child_unavailable' } });
  });

  // HANDOFF-LINK-OWNER-OPUS-1124, rulings 2026-11-24 23:16Z (a) and 23:56Z (3): the Sync link a person's handoff
  // creates from another Account's SOURCE is the PERSON's. It is written to their rows and prepared at their own
  // TARGET over the signed writer → target path, under the admitted session.handoff root and routed by the handoff's
  // operation id. On an owner TARGET, Home's admission of that root is the whole admission.
  it.each(['own TARGET', 'another handoff root', "SOURCE owner's own handoff", 'custody retired before finalize'] as const)(
    'creates the link a person hands off with in their own rows, signed with the handoff root (%s)', async scenario => {
    const person = scenario === "SOURCE owner's own handoff" ? 'owner' : 'target-owner';
    const token = (sub: string) => [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub })).toString('base64url'), 'fixture-signature'].join('.');
    const personCredentials = { token: token('target-owner'), encryption: null };
    const requesterCredentials = person === 'owner' ? { token: token('owner'), encryption: null } : personCredentials;
    const rows: ProjectAccountRowV1[] = [];
    const http = createProjectAccountRowsHttpBoundary(rows);
    const accountOf = (config?: { headers?: Record<string, unknown> }) => {
      const bearer = config?.headers?.Authorization;
      return typeof bearer === 'string' ? readAccountIdFromToken(bearer.replace(/^Bearer /u, '')) : null;
    };
    const graphWriters: Array<string | null> = [];
    const signed: Array<Readonly<{ phase: string; refused?: true }>> = [];
    const targetResults: unknown[] = [];
    const operationId = 'person-handoff-link';
    const targetInstallation = { machineId: 'target-parent', installationId: 'target-parent-installation',
      installationPublicKey: Buffer.from(tweetnacl.sign.keyPair().publicKey).toString('base64url') };
    const homeRefusal = () => createRpcCallError({ error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
    // The SOURCE daemon's own installation signs the writer → target calls.
    const installationStore = await import('@/daemon/identity/store');
    const writerKeys = tweetnacl.sign.keyPair();
    const identity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1, createdAt: 1,
      installationId: 'parent-installation', publicKey: Buffer.from(writerKeys.publicKey).toString('base64url'),
      privateKey: Buffer.from(writerKeys.secretKey).toString('base64url') });
    onTestFinished(() => identity.mockRestore());
    let current: Awaited<ReturnType<typeof composeBindChildSourcePhaseTestRuntime>> | undefined;
    let root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, projectRowsFromHttp: true,
      separateTargetParent: true, targetCredentials: personCredentials,
      requesterMachineAdmissionBoundary: { machineId: 'source-parent', daemonToken: 'source-daemon', isHomeCurrent: () => true,
        readInstallation: () => ({ installationId: 'parent-installation', privateKey: writerKeys.secretKey }) },
      readAdditionalHttpResponse: async (url, config) => {
        const accountId = accountOf(config);
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
          mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        return undefined;
      },
      readAdditionalHttpPostResponse: async (url, body, config) => {
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (!url.includes('/v1/account/project-rows/')) return undefined;
        if (!url.endsWith('/list') && !url.endsWith('/read')
          && JSON.stringify(body).includes('"relationship-graph"')) graphWriters.push(accountOf(config));
        return http(url, body);
      },
      // Home's writer → target admission of a session.handoff root (readCurrentWorkspaceSyncHandoffWriterTarget):
      // operation = the root's request, SOURCE = its signed handoff admission, TARGET = its signed TARGET; then the
      // TARGET daemon's own registered receiver under Home's routing for it.
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!current || !root) throw new Error('The TARGET runtime is not composed');
        const phase = descriptor.routing.phase;
        const writer = context.workspaceSyncSourceWriterTargetRouting;
        const source = writer?.source ?? context.workspaceSyncSourceRouting;
        const presented = context.callerInputAuthorization;
        const handoff = root.binding.handoffAdmission!;
        const claimed = source?.sourceContext?.machineAdmission;
        if (phase === 'release') {
          // Rootless cleanup: only the installed SOURCE writer, under its own custody.
          if (presented || writer?.target.phase !== 'release' || !descriptor.physicalEndpoint
            || context.machineAdmission?.actorAccountId !== 'owner' || context.machineAdmission.custodianAccountId !== 'owner') {
            signed.push({ phase, refused: true });
            throw homeRefusal();
          }
        } else if (!presented || presented.token !== root.token || presented.binding.actionId !== 'session.handoff'
          // The installed writer re-checks the person's Machine admission before any forwarded work (apiMachine).
          || !context.verifyMachineAdmissionCurrent || !await context.verifyMachineAdmissionCurrent()
          || source?.operationId !== presented.binding.requestId || source.sourceMachineId !== handoff.sourceMachineId
          || source.sourceSessionId !== handoff.sessionId || source.originalActionEnvelope
          || claimed?.installationId !== presented.binding.installationId
          || claimed.custodianAccountId !== presented.binding.custodianAccountId
          || claimed.actorAccountId !== presented.binding.accountId
          || descriptor.routing.targetMachineId !== handoff.targetMachineId || descriptor.machineId !== handoff.targetMachineId
          || presented.binding.requestId !== operationId) {
          signed.push({ phase, refused: true });
          throw homeRefusal();
        }
        signed.push({ phase });
        const receiver = current.targetParentRpcHandlers.get(descriptor.method);
        if (!receiver) throw new Error(`The TARGET receiver is not registered: ${descriptor.method}`);
        const targetAdmission = { actorAccountId: person, custodianAccountId: 'target-owner',
          machineId: targetInstallation.machineId, installationId: targetInstallation.installationId,
          role: 'manage' as const, encryptionMode: 'plain' as const };
        const incoming: RpcHandlerContext = phase === 'release'
          ? { signal: new AbortController().signal, callerAuthority: 'present_user', machineAdmission: context.machineAdmission,
              workspaceSyncSourceWriterTargetRouting: writer, verifyMachineAdmissionCurrent: async () => true }
          : { signal: new AbortController().signal, callerAuthority: source!.sourceContext!.callerAuthority,
              machineAdmission: targetAdmission, callerInputAuthorization: presented,
              // The installed TARGET receives the writer → target routing; its own ingress projects the target phase.
              workspaceSyncSourceWriterTargetRouting: { v: 1, sourceWriter: { machineId: current.sourceRef.machineId,
                installationId: 'parent-installation' }, source: source!, target: descriptor.routing },
              verifyMachineAdmissionCurrent: async () => true };
        await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
          credentials: personCredentials, serverId: current!.serverId, publication: 'installed' }));
        await current.settleProjects(targetInstallation.machineId);
        const result = await receiver(descriptor.request, incoming);
        targetResults.push({ phase, request: descriptor.request, routing: descriptor.routing, result });
        // The SOURCE client binds a TARGET-owned result to Home's verified destination.
        return phase === 'prepare' && result && typeof result === 'object' ? { ...result, physicalEndpoint: targetInstallation } : result;
      },
    });
    current = fixture;
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const key = { kind: 'workspace-ref' as const, serverId: fixture.serverId, id: fixture.sourceRef.id };
    rows.push(ProjectAccountRowV1Schema.parse({ key, revision: 0, content: cipher.seal({ key, value: fixture.sourceRef }) }));
    await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
      credentials: fixture.credentials, serverId: fixture.serverId, publication: 'installed' }));
    await fixture.settleProjects();
    const action = { kind: 'create_relationship' as const, mode: 'keep_both_in_sync' as const, contentPolicy, flushBeforeCommit: true as const };
    const input = { operationId, accountServerId: fixture.serverId, action,
      sourceMachineId: fixture.sourceRef.machineId, sourceWorkspaceRefId: fixture.sourceRef.id, sourceRootPath: fixture.sourceRef.rootPath,
      targetMachineId: fixture.targetRef.machineId, targetRootPath: fixture.targetPath };
    // The person on the bound SOURCE they hold Manage on, and the root Home admitted for their handoff.
    const admission = { actorAccountId: person, custodianAccountId: 'owner', machineId: fixture.sourceRef.machineId,
      installationId: 'parent-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-person-handoff-root', binding: {
      accountId: person, authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: fixture.serverId,
      accountEncryptionMode: 'plain', actionId: 'session.handoff', machineId: fixture.sourceRef.machineId,
      installationId: 'parent-installation', custodianAccountId: 'owner',
      requestId: scenario === 'another handoff root' ? 'another-handoff' : operationId,
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: fixture.sourceRef.machineId },
      handoffAdmission: { sessionId: 'person-session', sourceMachineId: fixture.sourceRef.machineId,
        sourceInstallationId: 'parent-installation', targetMachineId: fixture.targetRef.machineId,
        targetInstallationId: targetInstallation.installationId } } });
    const admittedRoot = root;
    // The Session custody the handoff borrowed; retiring it models the SOURCE runner that lent it ending.
    let sessionCustodyLive = true;
    const requesterSessionBootstrap = { credentials: requesterCredentials, serverHttpBaseUrl: 'https://bind-child-home.invalid',
      attribution: { serverId: fixture.serverId, accountId: person, machineId: fixture.sourceRef.machineId,
        installationId: 'parent-installation' }, isCurrent: async () => sessionCustodyLive,
      // The bootstrap's own capture facet: the real requester Account admission over the root.
      projectHandoffCaptureAccountContext: async (authorization: typeof admittedRoot) => await admitRequesterAccountActionContext({
        authorization, credentials: requesterCredentials, serverId: fixture.serverId, serverIdentityId: fixture.serverId,
        serverHttpBaseUrl: 'https://bind-child-home.invalid', isCurrent: async () => sessionCustodyLive,
        isRetainedCustodyCurrent: async () => sessionCustodyLive }),
    } as unknown as AdmittedRequesterSessionBootstrap;
    // The coordinator's context: its admitted root and the ingress's admission currentness ride only for
    // another person's handoff; the SOURCE owner's own handoff keeps today's context.
    const context: RpcHandlerContext = { signal: new AbortController().signal, requesterSessionBootstrap,
      machineAdmission: admission, ...(person === 'owner' ? {} : { verifyMachineAdmissionCurrent: async () => true,
        localActionContext: { externalActionExecutionAuthorization: admittedRoot } }) };
    const settled = await runWithServerHttpBaseUrl('https://bind-child-home.invalid',
      () => fixture.parent.handoffAdapter.prepare(input, undefined, context)).then(value => ({ value }), (error: unknown) => ({ error }));
    const refusal = 'error' in settled && settled.error && typeof settled.error === 'object' ? settled.error : undefined;
    const evidence = JSON.stringify({ refusal: refusal && { code: Reflect.get(refusal, 'code'), message: Reflect.get(refusal, 'message') },
      signed, graphWriters, targetResults });
    if (scenario === "SOURCE owner's own handoff") {
      // Parity: the SOURCE's own Account keeps today's installed-owner selection and never the signed path.
      expect(signed, evidence).toEqual([]);
      expect(graphWriters.filter(writer => writer !== 'owner'), evidence).toEqual([]);
      return;
    }
    // The link is never written into the SOURCE owner's rows.
    expect(graphWriters.filter(writer => writer !== person), evidence).toEqual([]);
    if (scenario === 'another handoff root') {
      // Home refuses a root for another handoff before the TARGET, and the staged link is withdrawn.
      expect(signed[0], evidence).toEqual({ phase: 'prepare', refused: true });
      expect(targetResults, evidence).toEqual([]);
      expect(refusal, evidence).toMatchObject({ code: RPC_ERROR_CODES.FORBIDDEN });
      return;
    }
    expect(refusal, evidence).toBeUndefined();
    expect(graphWriters.length, evidence).toBeGreaterThan(0);
    // The prepare is routed by the handoff operation, with the derived relationship as its bootstrap id,
    // and the person's own TARGET accepts it.
    expect(targetResults[0], evidence).toMatchObject({ phase: 'prepare', routing: { operationId },
      request: { bootstrapOperationId: deriveWorkspaceSyncRelationshipId(operationId),
        owner: { kind: 'relationship', relationshipId: deriveWorkspaceSyncRelationshipId(operationId) } } });
    expect(signed, evidence).toEqual([{ phase: 'prepare' }]);
    if (scenario !== 'custody retired before finalize' || !('value' in settled)) return;
    // The finalize transfer consumes the retained custody; once it is retired the person sees that step.
    sessionCustodyLive = false;
    // The link's transfer admission and the commit's row write each name their own step.
    const transfer = await fixture.parent.handoffAdapter.resolvePrivateExecution?.({ operationId })?.execution.assertTransferCurrent()
      .then(() => undefined, (error: unknown) => error);
    expect(transfer).toMatchObject({ code: 'project_requester_authority_unavailable',
      failureCause: { phase: 'workspace_sync.requester_custody.transfer' } });
    const finalized = await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => fixture.parent.handoffAdapter.finalize({
      operationId, prepared: settled.value })).then(() => undefined, (error: unknown) => error);
    expect(finalized).toMatchObject({ code: 'project_requester_authority_unavailable',
      failureCause: { phase: 'project_rows.requester_custody' } });
    // No further TARGET effect after the refusal; only the prepared bootstrap's cleanup release.
    expect(signed.filter(entry => entry.phase !== 'release'), evidence).toEqual([{ phase: 'prepare' }]);
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
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('non-owner-script'), sourceWorkspaceRefId: fixture.sourceRef.id,
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
    const result = await Promise.resolve(receiver({ sourceWorkspaceRefId: fixture.sourceRef.id, targetWorkspaceRefId: fixture.targetRef.id }, context))
      .then((value: unknown) => ({ kind: 'returned' as const, value }), (error: unknown) => ({ kind: 'refused' as const,
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
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('causal-clean'),
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
        workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId('two-link-clean'),
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
