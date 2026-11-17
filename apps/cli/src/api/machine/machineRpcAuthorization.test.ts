import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { computeWorkspaceSyncPolicyDigest, DeploymentChildRpcV1Schema, projectDeploymentChildRoutingV1 } from '@happier-dev/protocol';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';

import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS,
  resolveSocketRpcSessionWriteAuthorizationMethod, type WorkspaceSyncSourceRoutingV1 } from '@happier-dev/protocol/socketRpc';

import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';
import { logger } from '@/ui/logger';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ACTION_SPECS } from '@happier-dev/protocol/actions/actionSpecs';
import { collectActionSpecRpcMethodsForScopes, SESSION_SPAWN_NEW_RPC_SCOPES,
  MACHINE_SESSION_LIFECYCLE_RPC_SCOPES } from '@/rpc/handlers/actionSpecRpcRegistration';
import { PRIVATE_SPAWN_SESSION_RPC_METHODS } from '@/rpc/handlers/spawnSessionOptionsContract';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema } from '@happier-dev/protocol/socketRpc';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '@/testkit/fs/tempDir';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerBashHandler } from '@/rpc/handlers/bash';
import { registerReadFileHandler } from '@/rpc/handlers/fileSystem/readFileHandler';
import { createFilesystemEffectAdmission, createFilesystemEffectRpcRegistrar } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { registerPathMutationHandlers } from '@/rpc/handlers/fileSystem/pathMutationHandlers';
import { registerMachineWorkspaceSyncRpcHandlers } from './rpcHandlers.workspaceSync';
import { createExternalActionSourceMachineRpcExecution } from '@/api/externalActionExecutionAuthorization';
import { ProjectServiceRelocateInputV1Schema } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { projectServiceMoveStartInput } from '@/daemon/local/services/actions/projectServiceMoveChildren';
import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import * as installationStore from '@/daemon/identity/store';
import { encodeStoredCredentials } from '@/persistence';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ScmWorkEvidenceAdmissionSchema } from '@happier-dev/protocol/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { registerScmHandlers } from '@/rpc/handlers/scm';

describe('authorizeMachineRpcRequest', () => {
  it('binds checkout deletion to Home admission for the exact decrypted Session, including targeted input', async () => {
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => true };
    for (const params of [{ sessionId: 'owned-session' }, { kind: 'targeted_action_rpc', v: 1,
      target: { kind: 'machine', machineId: 'machine' }, input: { sessionId: 'owned-session' } }]) {
      const request = { method: `machine:${SESSION_RPC_METHODS.SESSION_DELETE}`, params, machineAdmission };
      const authorization = { kind: 'session.write' as const, sessionId: 'owned-session' };
      expect(await authorizeMachineRpcRequest({ ...request, authorization }, boundary, 'authenticated_home_socket'))
        .toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest(request, boundary, 'authenticated_home_socket'))
        .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
      expect(await authorizeMachineRpcRequest({ ...request,
        authorization: { ...authorization, sessionId: 'another-session' } }, boundary, 'authenticated_home_socket'))
        .toMatchObject({ ok: false, admissionPredicate: 'session_target' });
      expect(await authorizeMachineRpcRequest({ ...request, authorization }, boundary))
        .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    }
  });

  it('accepts SCM work evidence stamps only through authenticated Home ingress with existing Machine admission', async () => {
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    // The Home permit verifier is the network boundary. Keep manager dispatch,
    // source admission, SCM registration and per-Session refusal handling real.
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async () => true };
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, boundary, source) });
    registerScmHandlers(rpc, process.cwd(), { machineId: 'machine',
      accessPolicy: { kind: 'restrictedRoots', roots: [process.cwd()] } });
    const request = { method: `machine:${RPC_METHODS.SCM_WORK_EVIDENCE_READ}`, machineAdmission,
      callerAuthority: 'present_user' as const,
      params: { sessions: [
        { sessionId: 'admitted-session', cwd: join(process.cwd(), '..'), turnIds: [] },
        { sessionId: 'session', cwd: process.cwd(), turnIds: [] },
      ] },
      authorization: ScmWorkEvidenceAdmissionSchema.parse({ kind: 'scm.workEvidence.admitted',
        admissions: [{ kind: 'session.write', sessionId: 'admitted-session' },
          { kind: 'refused', sessionId: 'session', errorCode: RPC_ERROR_CODES.FORBIDDEN }] }),
    };
    expect(await rpc.handleRequest(request, undefined, 'authenticated_home_socket')).toEqual({ sessions: [
      { sessionId: 'admitted-session', status: 'error', evidence: [], branchEvidence: [], errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH },
      { sessionId: 'session', status: 'error', evidence: [], branchEvidence: [], errorCode: RPC_ERROR_CODES.FORBIDDEN },
    ] });
    // A genuine Machine permit does not let a direct caller mint Session proofs.
    expect(await rpc.handleRequest(request)).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false });
    for (const authorization of [undefined, { kind: 'scm.workEvidence' as const, sessionIds: ['session'] },
      { kind: 'session.write' as const, sessionId: 'session' }]) {
      expect(await rpc.handleRequest({ ...request, authorization }, undefined, 'authenticated_home_socket'))
        .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false });
    }
    expect(await rpc.handleRequest({ ...request, machineAdmission: { ...machineAdmission, installationId: 'replaced' } },
      undefined, 'authenticated_home_socket')).toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN, effectAttempted: false });
  });

  it.each(['native', 'account-owned', 'other-installation', 'other-custodian'] as const)(
    'keeps managed installation socket custody native-only (%s)', async scenario => {
      const controller = scenario === 'account-owned' ? undefined
        : { machineId: 'controller', installationId: scenario === 'other-installation' ? 'other' : 'installation' };
      const params = { homeId: 'home', managedId: 'managed', requestId: 'request', operationId: 'operation', taskId: 'task',
        controller, expectedIntentRevision: 1,
        resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
        expectedPromptKind: 'ssh.trustHost' as const, answer: { accepted: true } };
      const result = await authorizeMachineRpcRequest({ method: `controller:${RPC_METHODS.CAPABILITIES_INVOKE}`,
        params: { id: 'tool.systemTasks', method: 'respond', params },
        authorization: { kind: 'machine.managedInstallation.serverOrigin', actorAccountId: 'owner', custodianAccountId: 'owner',
          purpose: { homeId: params.homeId, managedId: params.managedId, requestId: params.requestId,
            operationId: params.operationId, taskId: params.taskId, controller, expectedIntentRevision: params.expectedIntentRevision,
            resource: params.resource, expectedPromptKind: params.expectedPromptKind, phase: 'answer' } },
      }, { machineId: 'controller', resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => scenario === 'other-custodian' ? 'other' : 'owner',
        resolveHomeServerIdentityId: async () => 'home', verifyMachineAdmission: async () => true }, 'authenticated_home_socket');
      expect(result).toMatchObject({ ok: scenario === 'native' });
    });

  it('admits retained SOURCE Service Start to the installed payload finalizer before its child review', async () => {
    const keys = tweetnacl.sign.keyPair();
    const workspace = WorkspaceRefV1Schema.parse({ id: 'destination-workspace', serverId: 'home', machineId: 'worker',
      rootPath: '/worker/project', projectKey: 'project', createdAtMs: 1 });
    const move = ProjectServiceRelocateInputV1Schema.parse({ workspace: { serverId: 'home', refId: 'source-workspace' }, sourceMachineId: 'source',
      serviceName: 'web', requestId: 'move', currentTarget: { kind: 'managed_service', managedServiceId: 'incumbent',
        machineId: 'source', workspaceId: 'source-workspace', cwd: '/source/project',
        declaration: { workspaceRefId: 'source-workspace', selection: { kind: 'manifest', name: 'web' } } },
      selectedTarget: { machineId: 'worker' }, destination: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } },
      desiredPlacement: { workspace: { serverId: 'home', refId: 'source-workspace' }, serviceName: 'web',
        expectedRevision: 'absent', expected: { kind: 'absent' },
        value: { runsOn: { kind: 'workers', destination: { kind: 'machine', machineId: 'worker' } }, unavailable: 'fail' } } });
    const envelope = { v: 1 as const, requestId: 'reviewed-move', target: { kind: 'machine' as const, machineId: 'source' }, input: move };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'source-root', binding: {
      serverIdentityId: 'home', accountId: 'requester', custodianAccountId: 'requester',
      authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      actionId: 'projects.service.relocate', machineId: 'source', installationId: 'source-installation',
      target: envelope.target, requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
    const admission = { actorAccountId: 'requester', custodianAccountId: 'company', machineId: 'worker',
      installationId: 'worker-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const method = `worker:${RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_START}`;
    const params = projectServiceMoveStartInput(move, workspace);
    const execution = createExternalActionSourceMachineRpcExecution({ authorization: root, target: root.binding.target,
      sourceMachineId: 'source', sourceInstallationId: 'source-installation', effectActionId: 'localServices.launcher.start',
      method, requestId: 'child', params, privateKey: keys.secretKey });
    const source = WorkspaceSyncSourceExecutionV1Schema.parse({ method, params, requestId: 'child', originalActionEnvelope: envelope,
      externalActionExecution: execution });
    const request = { method, params, callerAuthority: 'present_user' as const, machineAdmission: admission,
      callerInputAuthorization: root, workspaceSyncSourceExecution: source };
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'worker', resolveInstallationId: () => 'worker-installation',
      resolveCustodianAccountId: async () => 'company', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: async received => sameStrictJsonValue(received.workspaceSyncSourceExecution, source) };
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    for (const machineAdmission of [{ ...admission, installationId: 'replacement' }, { ...admission, custodianAccountId: 'foreign' }]) {
      expect(await authorizeMachineRpcRequest({ ...request, machineAdmission }, boundary)).toMatchObject({ ok: false });
    }
  });
  it.each(['deploy', 'catalog create'] as const)('retains exact deployment child currentness for Home verification and RPC dispatch (%s root)', async rootKind => {
    const keys = tweetnacl.sign.keyPair();
    const controller = tweetnacl.sign.keyPair();
    const context = { actorAccountId: 'requester', custodianAccountId: 'company', machineId: 'member',
      installationId: 'member-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
      machineId: context.machineId, installationId: context.installationId, deploymentId: 'receipt', actionOperationId: 'operation', phase: 'activate', selectedDeploymentId: 'receipt', input: { serverId: 'home',
        environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1, expectedTargetLinkRevision: 1,
        requestKey: rootKind === 'catalog create' ? 'root-request' : 'deploy-request',
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    if (job.kind !== 'member') throw new Error('Expected member fixture');
    const target = { kind: 'machine' as const, machineId: 'controller' };
    const rootInput = rootKind === 'deploy' ? job.input : { serverId: 'home', projectSourceId: 'source',
      requestKey: 'catalog-allocation', name: 'Web', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
      definition: { from: 'catalogApp', templateRef: { sourceId: 'apps', itemId: 'web', version: '1',
        ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } } } };
    const rootActionId = rootKind === 'deploy' ? job.actionId : 'deployments.environments.create';
    const originalActionEnvelope = { v: 1 as const, requestId: 'root-request', target, input: rootInput };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'retained-deployment-root', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'company', serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation',
      actionId: rootActionId, requestId: originalActionEnvelope.requestId, target,
      deploymentChildRoot: true,
      ...(rootKind === 'catalog create' ? { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(rootActionId, rootInput) } : {}),
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(originalActionEnvelope),
    } });
    const method = `${context.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`;
    const requestId = '0123456789abcdef0123456789abcdef';
    const params = await socketRpcCodec.encodeParams({ mode: 'plain' }, job, { method, callId: requestId });
    const deploymentChildRouting = projectDeploymentChildRoutingV1(job);
    const reviewedChild = rootKind === 'catalog create' ? { actionId: job.actionId, role: 'template.deploy',
      inputDigest: computeActionInputApprovalDigestV1(job.actionId, job.input) } : undefined;
    const workspaceSyncSourceExecution = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId, params, originalActionEnvelope,
      externalActionExecution: { v: 1, authorization: root, effectActionId: job.actionId, target,
        installationId: root.binding.installationId, deploymentChildRouting, ...(reviewedChild ? { reviewedChild } : {}), machineSignature: signExternalActionMachineRpcRequestV1({
          authorizationToken: root.token, effectActionId: job.actionId, target, installationId: root.binding.installationId,
          method, requestId, params, deploymentChildRouting, ...(reviewedChild ? { reviewedChild } : {}), privateKey: controller.secretKey }) } });
    let status = 200;
    let expectedExecution = workspaceSyncSourceExecution;
    let expectedAuthorization = root;
    // Home HTTP is the external boundary; local packet admission and receiver signing stay real.
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(url).toBe('https://home.invalid/v1/machines/member/admission/verify');
      const body = raw as { context: typeof context; method: string; callerInputAuthorization: typeof root;
        workspaceSyncSourceExecution: typeof workspaceSyncSourceExecution; proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(context);
      expect(body.workspaceSyncSourceExecution).toEqual(expectedExecution);
      expect(body.callerInputAuthorization).toEqual(expectedAuthorization);
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: context.machineId,
        installationId: context.installationId, accountId: context.custodianAccountId,
        rpcAdmission: { context, method, callerInputAuthorization: expectedAuthorization, workspaceSyncSourceExecution: expectedExecution } },
        proof: body.proof, publicKey: keys.publicKey })).toBe(true);
      return { status, data: { v: 1, ok: true } };
    });
    const input = { context, method, callerInputAuthorization: root, workspaceSyncSourceExecution,
      privateKey: keys.secretKey, daemonToken: 'company-daemon', serverHttpBaseUrl: 'https://home.invalid' };
    try {
      const verified = await verifyMachineRpcAdmissionCurrent(input);
      expect({ verified, homeReads: network.mock.calls.length }).toEqual({ verified: true, homeReads: 1 });
      if (rootKind === 'catalog create') {
      const channel = await createRequesterCurrentnessSocketHarness();
      const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
        purpose: { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: job,
          recipient: { machineId: context.machineId, installationId: context.installationId } },
        credentials: encodeStoredCredentials({ token: 'requester-account', credentialProvenance: 'stored_session', encryption: null }),
        installationPublicKey: keys.publicKey, randomBytes: tweetnacl.randomBytes });
      expectedAuthorization = sealed;
      expectedExecution = { ...workspaceSyncSourceExecution, externalActionExecution: {
        ...workspaceSyncSourceExecution.externalActionExecution, authorization: sealed } };
      const installed = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
        installationId: context.installationId, createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
        privateKey: Buffer.from(keys.secretKey).toString('base64url') });
      const accountHttp = vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: 'requester' } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        throw new Error('Unexpected requester HTTP read');
      });
      try {
      const boundary: MachineRpcAdmissionBoundary = { machineId: context.machineId,
        resolveInstallationId: () => context.installationId, resolveCustodianAccountId: async () => context.custodianAccountId,
        resolveHomeServerIdentityId: async () => 'home',
        verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received,
          privateKey: keys.secretKey, daemonToken: input.daemonToken, serverHttpBaseUrl: input.serverHttpBaseUrl }) };
      const diagnostics: unknown[] = [];
      const rpc = new RpcHandlerManager({ scopePrefix: context.machineId, localMachineId: context.machineId,
        encryptionMode: 'plain', logger: (_message, data) => diagnostics.push(data),
        prepareRequesterAccountContext: input => prepareInstalledRequesterAccountActionContext({ ...input,
          purpose: input.purpose ?? { kind: 'external_action' },
          machineId: context.machineId, serverId: 'home', serverHttpBaseUrl: 'https://home.invalid',
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: context.machineId, serverIdentityId: 'home' }),
          createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()) }),
        authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, boundary, source) });
      rpc.registerHandler(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, async received => {
        expect(received).toEqual(job);
        return { deploymentId: job.deploymentId };
      });
      const result = await rpc.handleRequest({ method, params, requestId, callerAuthority: 'present_user',
        machineAdmission: context, callerInputAuthorization: sealed, workspaceSyncSourceExecution: expectedExecution, originalActionEnvelope });
      expect(await socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result }, requestId), JSON.stringify(diagnostics)).toEqual({ deploymentId: job.deploymentId });
      } finally { installed.mockRestore(); accountHttp.mockRestore(); await channel.close(); }
      }
      expectedExecution = workspaceSyncSourceExecution;
      expectedAuthorization = root;
      network.mockClear();
      status = 403;
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(network).toHaveBeenCalledTimes(1);
      network.mockClear();
      for (const refused of [
        { ...input, method: `another-member:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}` },
        { ...input, context: { ...context, actorAccountId: 'unrelated-account' } },
        { ...input, context: { ...context, installationId: 'replaced-installation' } },
        { ...input, workspaceSyncSourceExecution: { ...workspaceSyncSourceExecution, externalActionExecution: {
          ...workspaceSyncSourceExecution.externalActionExecution, effectActionId: 'deployments.rollback' as const } } },
      ]) expect(await verifyMachineRpcAdmissionCurrent(refused)).toBe(false);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it('keeps retained SOURCE roots bound to the exact current requester-owned TARGET admission', async () => {
    const machineAdmission = { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'target-child',
      installationId: 'target-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-retained-source-root', binding: {
      accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'requester', serverIdentityId: 'home', machineId: 'source-child', installationId: 'source-installation',
      actionId: 'session.handoff', requestId: 'move-target', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'source-child' }, handoffAdmission: { sessionId: 'source-session',
        sourceMachineId: 'source-child', sourceInstallationId: 'source-installation',
        targetMachineId: machineAdmission.machineId, targetInstallationId: machineAdmission.installationId },
    } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
      sourceWriter: { machineId: 'source-controller', installationId: 'source-controller-installation' },
      source: { v: 1, phase: 'prepare', operationId: root.binding.requestId, accountServerId: 'home',
        sourceMachineId: 'source-child', sourceRootPath: '/source/workspace', sourceSessionId: 'source-session',
        sourceContext: { machineAdmission: { ...machineAdmission, machineId: 'source-child', installationId: 'source-installation' },
          callerAuthority: 'present_user', workspaceWrites: 'allow' } },
      target: { v: 1, phase: 'preflight', operationId: root.binding.requestId, accountServerId: 'home',
        targetMachineId: machineAdmission.machineId, targetRootPath: '/target/workspace' },
    });
    const request = { method: `${machineAdmission.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
      params: { v: 1, operationId: root.binding.requestId, serverId: 'home', machineId: machineAdmission.machineId, targetPath: '/target/workspace' },
      callerAuthority: 'present_user' as const, machineAdmission, callerInputAuthorization: root, workspaceSyncSourceWriterTargetRouting: routing };
    let current = true;
    // Current Home verification is the network boundary; routing, signed-root
    // projection and requester identity remain the real admission owners.
    const boundary: MachineRpcAdmissionBoundary = { machineId: machineAdmission.machineId,
      resolveInstallationId: () => machineAdmission.installationId, resolveCustodianAccountId: async () => 'requester',
      resolveHomeServerIdentityId: async () => 'home', verifyMachineAdmission: async () => current };
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    const rejectedCases = [
      ['missing writer-target route', { ...request, workspaceSyncSourceWriterTargetRouting: undefined }],
      ['foreign target Machine', { ...request, machineAdmission: { ...machineAdmission, machineId: 'foreign-target' } }],
      ['foreign installation', { ...request, machineAdmission: { ...machineAdmission, installationId: 'foreign-installation' } }],
      ['foreign actor', { ...request, machineAdmission: { ...machineAdmission, actorAccountId: 'foreign-actor' } }],
      ['foreign SOURCE root binding', { ...request, callerInputAuthorization: { ...root, binding: { ...root.binding, machineId: 'foreign-source' } } }],
      ['foreign target root', { ...request, workspaceSyncSourceWriterTargetRouting: { ...routing, target: { ...routing.target, targetRootPath: '/foreign-root' } } }],
      ['wrong native phase', { ...request, workspaceSyncSourceWriterTargetRouting: { ...routing, target: { ...routing.target, phase: 'prepare' as const } } }],
      ['raw file method with retained route', { ...request, method: `${machineAdmission.machineId}:${RPC_METHODS.READ_FILE}`, params: { path: '/private' } }],
    ] as const;
    const targetRpc = new RpcHandlerManager({ scopePrefix: machineAdmission.machineId,
      localMachineId: machineAdmission.machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, boundary) });
    // Production registration remains real. No native service is installed:
    // malformed proof must be refused before any target effect can be reached.
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: targetRpc });
    registerReadFileHandler(targetRpc, { workingDirectory: '/target/workspace', accessPolicy: { kind: 'osUser' },
      getAdditionalAllowedReadDirs: () => [],
      effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) });
    for (const [index, [name, refused]] of rejectedCases.entries()) {
      expect(await targetRpc.handleRequest(refused), `Target admission negative ${index}: ${name}`)
        .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    }
    // Physical target ownership belongs to its native Workspace mapper after
    // the exact routed Home proof; it cannot mint unrestricted file authority.
    const physicalTarget = { ...boundary, resolveCustodianAccountId: async () => 'company' };
    expect(await authorizeMachineRpcRequest(request, physicalTarget)).toEqual({ ok: true });
    for (const method of [RPC_METHODS.READ_FILE, RPC_METHODS.BASH]) {
      expect(await authorizeMachineRpcRequest({ ...request, method: `${machineAdmission.machineId}:${method}`,
        params: { path: '/private', command: 'pwd' } }, physicalTarget)).toMatchObject({ ok: false });
    }
    current = false;
    expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, admissionPredicate: 'machine_currentness' });
  });
  it('preserves owned Account automation and native owner-Agent terminal admission without granting raw Session deputies', async () => {
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveHomeServerIdentityId: async () => 'home', resolveCustodianAccountId: async () => 'owner',
      verifyMachineAdmission: async () => true };
    const caller = { kind: 'session' as const, sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 };
    // Native filesystem/transfer and MCP effects decide custody at their
    // registered owners: see the file/no-port test below and the installed
    // rpcHandlers.filesystem.memberIdentity / rpcHandlers.mcpServers.*composed suites.
    for (const method of [RPC_METHODS.SCM_STATUS_SNAPSHOT, RPC_METHODS.SCM_WORKSPACE_WATCH, RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST,
      RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE, RPC_METHODS.DAEMON_TERMINAL_ENSURE, RPC_METHODS.PREVIEW_ENV]) {
      const request = { method: `machine:${method}`, params: {}, machineAdmission, callerAuthority: 'account_automation' as const };
      expect(await authorizeMachineRpcRequest(request, boundary), method).toEqual({ ok: true });
      // Member terminal placement and isolation are decided by the registered
      // terminal owner (rpcHandlers.terminal.test.ts member Use refusals).
      const memberRefusal = method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
        ? { ok: true } : { ok: false, errorCode: 'agent_isolation_unavailable' };
      // A person's local repository read reaches the SCM owner, which runs it whole in their
      // member process; other source control needs Manage (MEMBER-SCM-READ-1114, SEC-FORKC-1115F).
      const memberUse = method === RPC_METHODS.SCM_STATUS_SNAPSHOT ? { ok: true }
        : method === RPC_METHODS.SCM_DIFF_SUMMARY_RESULT_LIST || method === RPC_METHODS.SCM_DIFF_SUMMARY_GENERATE
          ? { ok: false, errorCode: 'machine_manage_required' } : memberRefusal;
      expect(await authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, actorAccountId: 'member', role: 'use' } }, boundary), method)
        .toMatchObject(memberUse);
      const ownerAgent = await authorizeMachineRpcRequest({ ...request, localActionContext: { actionCaller: caller } }, boundary);
      // Coordination's D1 ruling admits only the owner's native terminal open;
      // the installed receiver still owns placement and all control custody.
      expect(ownerAgent, method).toMatchObject(method === RPC_METHODS.DAEMON_TERMINAL_ENSURE
        ? { ok: true } : { ok: false, errorCode: 'agent_isolation_unavailable' });
      expect(await authorizeMachineRpcRequest({ ...request,
        machineAdmission: { ...machineAdmission, actorAccountId: 'member' }, localActionContext: { actionCaller: caller } }, boundary), method)
        .toMatchObject(memberRefusal);
    }
  });
  it('leaves native-finalized Project, Session and Manage Bash payloads to their registered owner, but refuses unowned deputies', async () => {
    const machineAdmission = { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveHomeServerIdentityId: async () => 'home', resolveCustodianAccountId: async () => 'owner',
      verifyMachineAdmission: async () => true };
    const nativeMethods = [RPC_METHODS.DAEMON_COMPUTER_PERSONAL_ACTION_EXECUTE, ...Object.values(PROJECT_FINITE_ACTION_RPC_METHODS_V1),
      ...collectActionSpecRpcMethodsForScopes(ACTION_SPECS, [...SESSION_SPAWN_NEW_RPC_SCOPES, ...MACHINE_SESSION_LIFECYCLE_RPC_SCOPES])];
    for (const method of nativeMethods) expect(await authorizeMachineRpcRequest({ method: `machine:${method}`,
      params: { sessionId: 'session', parentSessionId: 'session', replay: { previousSessionId: 'session' } }, machineAdmission, callerAuthority: 'account_automation',
      ...(resolveSocketRpcSessionWriteAuthorizationMethod(`machine:${method}`)
        ? { authorization: { kind: 'session.write' as const, sessionId: 'session' } } : {}),
    }, boundary), method).toEqual({ ok: true });
    expect(await authorizeMachineRpcRequest({ method: `machine:${RPC_METHODS.BASH}`, params: {},
      machineAdmission: { ...machineAdmission, role: 'manage' }, callerAuthority: 'account_automation' }, boundary))
      .toEqual({ ok: true });
    // A Use member's local repository read reaches the SCM owner (member process); forge reads stay refused.
    expect(await authorizeMachineRpcRequest({ method: `machine:${RPC_METHODS.SCM_STATUS_SNAPSHOT}`, params: {}, machineAdmission,
      callerAuthority: 'account_automation' }, boundary)).toEqual({ ok: true });
    expect(await authorizeMachineRpcRequest({ method: `machine:${RPC_METHODS.SCM_PULL_REQUEST_LIST}`, params: {}, machineAdmission,
      callerAuthority: 'account_automation' }, boundary)).toMatchObject({ ok: false, errorCode: 'machine_manage_required' });
    for (const method of Object.values(PRIVATE_SPAWN_SESSION_RPC_METHODS)) {
      const request = { method: `machine:${method}`, machineAdmission, callerAuthority: 'account_automation' as const };
      expect(await authorizeMachineRpcRequest({ ...request, params: { directory: '/workspace',
        type: 'resume-session', sessionId: 'session', backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } }, boundary), method)
        .toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ ...request, params: { directory: '/workspace',
        backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } } }, boundary), method)
        .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
    }
  });
  it.each([RPC_METHODS.READ_FILE, RPC_METHODS.BASH, RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE,
    RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ])('keeps requester isolation for Agent-scoped unrouted %s after genuine current Home proof', async method => {
    const admission = { actorAccountId: 'requester', custodianAccountId: 'company', machineId: 'controller',
      installationId: 'controller-installation', role: method === RPC_METHODS.BASH ? 'manage' as const : 'use' as const,
      encryptionMode: 'plain' as const };
    const key = tweetnacl.sign.keyPair();
    const network = vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
      const body = raw as { context: typeof admission; method: string;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(verifyMachineInstallationProof({ payload: { version: 1, machineId: admission.machineId,
        installationId: admission.installationId, accountId: 'company',
        rpcAdmission: { context: body.context, method: body.method } }, proof: body.proof, publicKey: key.publicKey })).toBe(true);
      return { status: 200, data: { v: 1, ok: true } };
    });
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'controller', resolveInstallationId: () => admission.installationId,
      resolveCustodianAccountId: async () => 'company', resolveHomeServerIdentityId: async () => 'home',
      verifyMachineAdmission: received => verifyMachineRpcAdmissionCurrent({ ...received, privateKey: key.secretKey,
        daemonToken: 'company-daemon', serverHttpBaseUrl: 'https://home.invalid' }) };
    try {
      const request = { method: `controller:${method}`, params: { path: '/private', command: 'pwd' },
        machineAdmission: admission, callerAuthority: 'present_user' as const,
        localActionContext: { actionCaller: { kind: 'session' as const, sessionId: 'requester-agent', starterDepth: 0, turnDepth: 0 } } };
      if (method === RPC_METHODS.READ_FILE || method === RPC_METHODS.BASH) {
        // Native filesystem and Bash owners consume the admitted identity.
        // Without their native port neither may fall back to daemon execution.
        const rpc = new RpcHandlerManager({ scopePrefix: 'controller', encryptionMode: 'plain', logger: () => {},
          authorizeRequest: incoming => authorizeMachineRpcRequest(incoming, boundary) });
        if (method === RPC_METHODS.BASH) registerBashHandler(rpc, '/private', { resolveHostHomeServerIdentityId: async () => 'home' });
        else registerReadFileHandler(rpc, { workingDirectory: '/private', accessPolicy: { kind: 'osUser' },
            getAdditionalAllowedReadDirs: () => [],
            effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) });
        // Host-private Agent context enters through local invocation, not wire DTO fields.
        expect(await rpc.invokeLocal(method, request.params, {
          rpcContext: { machineAdmission: admission, callerAuthority: request.callerAuthority },
          localActionContext: request.localActionContext,
        }))
          .toMatchObject({ success: false, errorCode: method === RPC_METHODS.BASH
            ? 'agent_isolation_unavailable' : 'filesystem_identity_custody_unavailable' });
      } else {
        expect(await authorizeMachineRpcRequest(request, boundary))
          .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      }
    } finally { network.mockRestore(); }
  });
  it('admits owner and Manage raw commands and file reads while protecting Use and Agent custody', async () => {
    await withTempDir('workspace-native-control-raw-deputies-', async root => {
      const path = join(root, 'synthetic-daemon-private.txt');
      const marker = 'synthetic-daemon-private-marker';
      await writeFile(path, marker, { mode: 0o600 });
      const admission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
      let current = true;
      // Current Home access is the external boundary. The actual manager,
      // identity selector, registered file owner and process launch stay real.
      const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
        resolveCustodianAccountId: async () => 'owner', resolveHomeServerIdentityId: async () => 'home',
        verifyMachineAdmission: async () => current };
      const rpc = new RpcHandlerManager({ scopePrefix: 'machine', encryptionMode: 'plain', logger: () => {},
        authorizeRequest: request => authorizeMachineRpcRequest(request, boundary) });
      registerReadFileHandler(rpc, { workingDirectory: root, accessPolicy: { kind: 'osUser' },
        getAdditionalAllowedReadDirs: () => [],
        effectAdmission: createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' }) });
      registerPathMutationHandlers(createFilesystemEffectRpcRegistrar(rpc,
        createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home' })), {
        workingDirectory: root, accessPolicy: { kind: 'osUser' },
        getAdditionalAllowedReadDirs: () => [], getAdditionalAllowedWriteDirs: () => [],
      });
      registerBashHandler(rpc, root, { resolveHostHomeServerIdentityId: async () => 'home' });
      const requests = [
        { method: `machine:${RPC_METHODS.READ_FILE}`, params: { path } },
        { method: `machine:${RPC_METHODS.DAEMON_FILESYSTEM_READ_FILE}`, params: { rootPath: root, path } },
        { method: `machine:${RPC_METHODS.BASH}`, params: { cwd: root, argv: [process.execPath, '-e',
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', path] } },
      ];
      for (const request of requests) {
        const nativeFileRead = !request.method.endsWith(RPC_METHODS.BASH);
        const owner = await rpc.handleRequest({ ...request, machineAdmission: admission, callerAuthority: 'present_user' });
        expect(owner, request.method).toMatchObject(request.method.endsWith(RPC_METHODS.BASH)
          ? { success: true, stdout: marker } : { success: true, content: Buffer.from(marker).toString('base64') });
        for (const role of ['use', 'manage'] as const) {
          const member = await rpc.handleRequest({ ...request, machineAdmission: { ...admission, actorAccountId: 'member', role },
            callerAuthority: 'present_user' });
          expect(member).toMatchObject(role === 'manage'
            ? nativeFileRead ? { success: true, content: Buffer.from(marker).toString('base64') } : { success: true, stdout: marker }
            : nativeFileRead ? { success: false, errorCode: 'filesystem_identity_custody_unavailable' }
              : { errorCode: 'agent_isolation_unavailable' });
        }
        expect(await rpc.handleRequest({ ...request, machineAdmission: { ...admission, actorAccountId: 'member', role: 'use' } }))
          .toMatchObject(nativeFileRead ? { success: false, errorCode: 'filesystem_identity_custody_unavailable' }
            : { errorCode: 'agent_isolation_unavailable' });
        expect(await rpc.handleRequest({ ...request, machineAdmission: admission, callerAuthority: 'present_user',
          sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'owner-agent', starterDepth: 0, turnDepth: 0 },
            sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'agent-private-deputy' } }))
          .toMatchObject({ errorCode: expect.stringMatching(/^(agent_isolation_unavailable|RPC_FORBIDDEN)$/u) });
      }
      expect(await rpc.handleRequest({ method: `machine:${RPC_METHODS.DAEMON_FILESYSTEM_DELETE}`,
        params: { rootPath: root, path, recursive: false },
        machineAdmission: { ...admission, actorAccountId: 'member', role: 'use' }, callerAuthority: 'present_user' }))
        .toMatchObject({ success: false, errorCode: 'filesystem_identity_custody_unavailable' });
      expect(await readFile(path, 'utf8')).toBe(marker);
      current = false;
      expect(await rpc.handleRequest({ ...requests[0]!, machineAdmission: admission, callerAuthority: 'present_user' }))
        .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    });
  });
  it('consumes exact current Machine admission without weakening Session writes', async () => {
    const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    let current = true;
    // The Home verification callback is the network boundary; local target,
    // installation, actor and method-scope checks remain real.
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveHomeServerIdentityId: async () => 'home',
      resolveCustodianAccountId: async () => 'alice', verifyMachineAdmission: async () => current };
    for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_STOP, SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
      SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1]) {
      const request = { method: `machine:${method}`, params: { runId: 'run' }, machineAdmission };
      expect(await authorizeMachineRpcRequest(request, boundary), method).toEqual({ ok: true });
      for (const refused of [
        { ...request, machineAdmission: undefined },
        { ...request, method: `other-machine:${method}` },
        { ...request, machineAdmission: { ...machineAdmission, installationId: 'replaced-installation' } },
        { ...request, authorization: { kind: 'session.write' as const, sessionId: 'session' } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary), method).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      current = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, admissionPredicate: 'machine_currentness' });
      current = true;
    }
    expect(await authorizeMachineRpcRequest({ method: `machine:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`,
      params: { sessionId: 'session' }, machineAdmission }, boundary))
      .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    expect(await authorizeMachineRpcRequest({ method: `session:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`,
      params: { sessionId: 'session', runId: 'run' }, authorization: { kind: 'session.write', sessionId: 'session' } }, boundary)).toEqual({ ok: true });
  });
  it('binds strict personal copy previews to either the controller or the physical target without widening other Machine requests', async () => {
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const params = { kind: 'preview', workspace: { serverId: 'home', refId: 'source' }, machineId: 'controller',
      targetMachineId: 'target', targetWorkspaceRefId: 'copy', expectedRelationship: {
        v: 1, relationshipId: 'copy-link', controllerMachineId: 'controller', alphaWorkspaceRefId: 'source',
        betaWorkspaceRefId: 'copy', mode: 'keep_synced', enabled: true, createdAtMs: 1, updatedAtMs: 2,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      } };
    let current = true;
    for (const machineId of ['controller', 'target']) {
      const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId,
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
      const boundary: MachineRpcAdmissionBoundary = { machineId, resolveInstallationId: () => 'installation',
        resolveHomeServerIdentityId: async () => 'home',
        resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async () => current };
      const request = { method: `${machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params, machineAdmission,
        callerAuthority: 'present_user' as const };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      for (const refused of [
        { ...request, machineAdmission: { ...machineAdmission, installationId: 'replaced-installation' } },
        { ...request, machineAdmission: { ...machineAdmission, custodianAccountId: 'foreign-owner' } },
        { ...request, method: `foreign-machine:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}` },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      if (machineId === 'target') {
        for (const refused of [
          { ...request, params: { ...params, targetMachineId: 'foreign-target' } },
          { ...request, params: { ...params, expectedRelationship: undefined } },
          { ...request, params: { ...params, rootPath: '/caller-selected-root' } },
          { ...request, params: { ...params, kind: 'remove' } },
          { ...request, method: `${machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE}` },
          { ...request, method: `${machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}` },
        ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      }
      current = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      current = true;
    }
  });
  it('distinguishes Home response, schema, transport and cancellation failures without logging credentials or payloads', async () => {
    const context = { actorAccountId: 'never-log-actor', custodianAccountId: 'never-log-owner', machineId: 'never-log-machine',
      installationId: 'never-log-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const key = tweetnacl.sign.keyPair();
    const record = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const network = vi.spyOn(axios, 'post');
    const input = { context, method: `${context.machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`,
      privateKey: key.secretKey, daemonToken: 'never-log-token', serverHttpBaseUrl: 'https://never-log-home.invalid' };
    try {
      network.mockResolvedValueOnce({ status: 429, data: { error: 'never-log-body' } });
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'response_status', status: 429,
      });
      network.mockResolvedValueOnce({ status: 200, data: { v: 1, ok: true, unexpected: 'never-log-value' } });
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'response_schema', status: 200,
      });
      network.mockRejectedValueOnce(new Error('never-log-transport-secret'));
      expect(await verifyMachineRpcAdmissionCurrent(input)).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'transport',
      });
      network.mockRejectedValueOnce(new axios.AxiosError('never-log-network-message', 'ECONNRESET'));
      expect(await verifyMachineRpcAdmissionCurrent({ ...input, method: 'never-log-machine:never-log-method' })).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: '<unregistered>', stage: 'transport', transportCode: 'ECONNRESET',
      });
      const controller = new AbortController();
      network.mockImplementationOnce(async () => {
        controller.abort();
        throw new axios.CanceledError('never-log-cancel-message');
      });
      expect(await verifyMachineRpcAdmissionCurrent({ ...input, signal: controller.signal })).toBe(false);
      expect(record).toHaveBeenLastCalledWith('[RPC] Machine admission verification failed', {
        method: RPC_METHODS.CAPABILITIES_DESCRIBE, stage: 'request_cancelled',
      });
      expect(JSON.stringify(record.mock.calls)).not.toContain('never-log');
    } finally { network.mockRestore(); record.mockRestore(); }
  });
  it('admits prepared Machine phases after current Home admission while retaining Session attachment admission', async () => {
    const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const signing = tweetnacl.sign.keyPair();
    // Only the Home HTTP boundary is substituted; the signing and admission owners remain real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    const boundary: MachineRpcAdmissionBoundary = { machineId: 'machine', resolveInstallationId: () => 'installation',
      resolveHomeServerIdentityId: async () => 'home',
      resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: input => verifyMachineRpcAdmissionCurrent({
        ...input, privateKey: signing.secretKey, daemonToken: 'daemon', serverHttpBaseUrl: 'https://home.invalid',
      }) };
    const request = { method: `machine:${RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT}`, machineAdmission,
      callerAuthority: 'account_automation' as const,
      params: { t: 'prepared_machine_transfer_v1', path: '/machine-transfers/direct/YmluYXJ5/open', httpMethod: 'POST',
        authorizationToken: 'prepared-token', recipientPublicKeyBase64: 'recipient' } };
    try {
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ ...request, params: { t: 'session_file_download_v1', path: '/private/file',
        recipientPublicKeyBase64: Buffer.from(tweetnacl.box.keyPair().publicKey).toString('base64') } }, boundary))
        .toEqual({ ok: true });
      for (const refused of [
        { ...request, machineAdmission: undefined },
        { ...request, method: `machine:${RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK}` },
        { ...request, params: { t: 'session_attachment_download_v1', attachmentHandle: { sessionId: 'session' } } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      network.mockResolvedValue({ status: 403, data: { v: 1, ok: false }, statusText: 'Forbidden',
        headers: {}, config: { headers: new AxiosHeaders() } });
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });
  it.each([RPC_METHODS.SESSION_FORK, RPC_METHODS.SESSION_FORK_PROVIDER_SAFE, RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY])(
    'binds %s to the source Session in the decrypted request', async method => {
      const params = method === RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY
        ? { replay: { previousSessionId: 'source-session' } }
        : { parentSessionId: 'source-session', sessionId: 'untrusted-selector' };
      const request = { method: `machine:${method}`, params,
        authorization: { kind: 'session.write' as const, sessionId: 'source-session' } };
      expect(await authorizeMachineRpcRequest(request)).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ ...request, authorization: undefined }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.write', sessionId: 'untrusted-selector' } }))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    },
  );
  it.each([RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ])(
    'admits %s through the connected Home regardless of caller-local labels, retaining Machine custody', async method => {
      const machineAdmission = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const };
      let current = true;
      let installationId = 'installation';
      const boundary = { machineId: 'machine', resolveInstallationId: () => installationId,
        resolveHomeServerIdentityId: async () => 'home',
        resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async () => current };
      const request = { method: `machine:${method}`, params: { serverId: 'browser-local-home', machineId: 'machine' }, machineAdmission };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      for (const refused of [
        { ...request, params: { ...request.params, machineId: 'another-machine' } },
        { ...request, machineAdmission: { ...machineAdmission, machineId: 'another-machine' } },
        { ...request, machineAdmission: { ...machineAdmission, custodianAccountId: 'another-owner' } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      installationId = 'replacement';
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      installationId = 'installation';
      current = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    },
  );
  it.each(['owner', 'requester'])('verifies physical TARGET preflight with parent custody independent of child Account %s', async childAccountId => {
    const machineAdmission = { actorAccountId: 'shared-actor', custodianAccountId: childAccountId, machineId: 'target-child',
      installationId: 'target-child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const receiver = { machineId: 'parent', installationId: 'parent-installation', accountId: 'owner' };
    const workspaceSyncTargetRouting = { v: 1 as const, phase: 'preflight' as const, operationId: 'move-target',
      accountServerId: 'home-1', targetMachineId: 'target-child', targetRootPath: '/child/workspace', targetContext: {
        machineAdmission, callerAuthority: 'account_automation' as const, workspaceWrites: 'deny' as const,
      } };
    const method = `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
    const params = { v: 1, operationId: 'move-target', serverId: 'home-1', machineId: 'target-child', targetPath: '/child/workspace' };
    const key = tweetnacl.sign.keyPair();
    let currentParentInstallation = receiver.installationId;
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      const signer = receiver;
      expect(url).toBe(`https://home.invalid/v1/machines/${signer.machineId}/admission/verify`);
      const body = raw as { context: typeof machineAdmission; method: string; workspaceSyncTargetRouting: typeof workspaceSyncTargetRouting;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(machineAdmission);
      expect(body.workspaceSyncTargetRouting).toEqual(workspaceSyncTargetRouting);
      const payload = { version: 1 as const, machineId: signer.machineId, installationId: signer.installationId, accountId: signer.accountId,
        rpcAdmission: { context: body.context, method: body.method, workspaceSyncTargetRouting: body.workspaceSyncTargetRouting } };
      expect(verifyMachineInstallationProof({ payload, proof: body.proof, publicKey: key.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission,
        workspaceSyncTargetRouting: { ...workspaceSyncTargetRouting, targetMachineId: 'foreign-child' } } },
        proof: body.proof, publicKey: key.publicKey })).toBe(false);
      return { status: currentParentInstallation === receiver.installationId ? 200 : 403, data: { v: 1, ok: true },
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const boundary = { machineId: 'parent', resolveInstallationId: () => currentParentInstallation,
      resolveHomeServerIdentityId: async () => 'home',
      resolveCustodianAccountId: async () => 'owner', verifyMachineAdmission: async (received) => {
        const verification = { ...received, workspaceSyncTargetReceiver: receiver, privateKey: key.secretKey,
          daemonToken: 'parent-custodian-token', serverHttpBaseUrl: 'https://home.invalid' };
        return await verifyMachineRpcAdmissionCurrent(verification);
      } } satisfies MachineRpcAdmissionBoundary;
    try {
      const request = { method, params, machineAdmission, workspaceSyncTargetRouting };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      network.mockClear();
      for (const refused of [
        { ...request, workspaceSyncTargetRouting: undefined },
        { ...request, method: 'parent:spawn-happy-session' },
        { ...request, workspaceSyncTargetRouting: { ...workspaceSyncTargetRouting, operationId: 'foreign-operation' } },
        { ...request, workspaceSyncTargetRouting: { ...workspaceSyncTargetRouting, targetMachineId: 'foreign-child' } },
        { ...request, params: { ...params, serverId: 'foreign-home' } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(network).not.toHaveBeenCalled();
      currentParentInstallation = 'replacement-installation';
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });

  it.each(['owner', 'requester'])('verifies physical SOURCE custody with parent custody independent of child Account %s', async childAccountId => {
    const machineAdmission = { actorAccountId: 'shared-actor', custodianAccountId: childAccountId, machineId: 'child',
      installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const receiver = { machineId: 'parent', installationId: 'parent-installation', accountId: 'owner' };
    const workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1 = { v: 1, phase: 'prepare', operationId: 'move-1',
      accountServerId: 'home-1', sourceMachineId: 'child', sourceRootPath: '/child/workspace', sourceSessionId: 'session-1',
      sourceContext: { machineAdmission, callerAuthority: 'present_user' } };
    const policyInput = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const contentPolicy = { ...policyInput, policyDigest: computeWorkspaceSyncPolicyDigest(policyInput) };
    const params = { v: 1 as const, phase: 'prepare' as const, input: {
      operationId: 'move-1', accountServerId: 'home-1', sourceSessionId: 'session-1', action: { kind: 'copy_once' as const, contentPolicy },
      sourceMachineId: 'child', sourceRootPath: '/child/workspace', targetMachineId: 'target', targetRootPath: '/target/workspace',
    } };
    const method = `parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`;
    const keyPair = tweetnacl.sign.keyPair();
    let parentInstallation = receiver.installationId;
    let sourceCurrent = true;
    const admittedProofs: unknown[] = [];
    // Only the Home HTTP boundary is substituted; the actual admission owner and signing are exercised.
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      const signer = receiver;
      expect(url).toBe(`https://home.invalid/v1/machines/${signer.machineId}/admission/verify`);
      const body = raw as { context: typeof machineAdmission; method: string; workspaceSyncSourceRouting: WorkspaceSyncSourceRoutingV1;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(body.context).toEqual(machineAdmission);
      expect(body.workspaceSyncSourceRouting.operationId).toBe('move-1');
      const payload = { version: 1 as const, machineId: signer.machineId, installationId: signer.installationId, accountId: signer.accountId,
        rpcAdmission: { context: body.context, method: body.method, workspaceSyncSourceRouting: body.workspaceSyncSourceRouting } };
      expect(verifyMachineInstallationProof({ payload, proof: body.proof, publicKey: keyPair.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload, rpcAdmission: { ...payload.rpcAdmission,
        workspaceSyncSourceRouting: { ...body.workspaceSyncSourceRouting, sourceRootPath: '/foreign' } } },
        proof: body.proof, publicKey: keyPair.publicKey })).toBe(false);
      admittedProofs.push(body);
      const cleanup = body.workspaceSyncSourceRouting.phase === 'abort' || body.workspaceSyncSourceRouting.phase === 'commit';
      const current = (sourceCurrent || cleanup) && parentInstallation === receiver.installationId;
      return { status: current ? 200 : 403, data: { v: 1, ok: current },
        statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
    });
    const boundary = { machineId: receiver.machineId, resolveCustodianAccountId: async () => 'owner',
      resolveHomeServerIdentityId: async () => 'home',
      resolveInstallationId: () => parentInstallation,
      verifyMachineAdmission: async (input) => {
        const verification = { ...input, workspaceSyncSourceReceiver: receiver, privateKey: keyPair.secretKey,
          daemonToken: 'parent-daemon-token', serverHttpBaseUrl: 'https://home.invalid' };
        return await verifyMachineRpcAdmissionCurrent(verification);
      } } satisfies MachineRpcAdmissionBoundary;
    try {
      const request = { method, params, machineAdmission, workspaceSyncSourceRouting, callerAuthority: 'present_user' as const };
      expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
      const admitted = admittedProofs.splice(0);
      expect(admitted).toHaveLength(1);
      admittedProofs.splice(0);
      for (const refused of [
        { ...request, workspaceSyncSourceRouting: undefined },
        { ...request, method: 'parent:spawn-happy-session' },
        { ...request, machineAdmission: { ...machineAdmission, machineId: 'foreign-child' } },
        { ...request, workspaceSyncSourceRouting: { ...workspaceSyncSourceRouting, operationId: 'foreign-operation' } },
        { ...request, params: { ...params, input: { ...params.input, sourceRootPath: '/foreign' } } },
        { ...request, params: { ...params, input: { ...params.input, sourceSessionId: 'foreign-session' } } },
      ]) expect(await authorizeMachineRpcRequest(refused, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(admittedProofs).toEqual([]);
      expect(await authorizeMachineRpcRequest({ ...request,
        workspaceSyncSourceRouting: { ...workspaceSyncSourceRouting, sourceContext: undefined } }, boundary))
        .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      admittedProofs.splice(0);
      sourceCurrent = false;
      expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      const abortRequest = { ...request, params: { ...params, phase: 'abort' as const },
        workspaceSyncSourceRouting: { ...workspaceSyncSourceRouting, phase: 'abort' as const } };
      expect(await authorizeMachineRpcRequest(abortRequest, boundary)).toEqual({ ok: true });
      parentInstallation = 'replacement-parent-installation';
      expect(await authorizeMachineRpcRequest(abortRequest, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    } finally { network.mockRestore(); }
  });
  it('binds protected current-service admission to the current installation without substituting the custodian actor', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
      installationId: 'installation-a', role: 'use' as const, encryptionMode: 'e2ee' as const };
    let current = true;
    let installationId = 'installation-a';
    const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => installationId, verifyMachineAdmission: async (input: {
        context: { actorAccountId: string; custodianAccountId: string };
      }) => current && input.context.actorAccountId === 'bob' && input.context.custodianAccountId === 'alice' };
    const request = { method: 'machine-a:daemon.localServices.preview.admission', params: { v: 1, kind: 'read' },
      machineAdmission, authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } };
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    const forgedRequest = { ...request, authorization: { ...request.authorization, forged: true } };
    expect(await authorizeMachineRpcRequest(forgedRequest, boundary))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = false;
    expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = true;
    installationId = 'replacement';
    expect(await authorizeMachineRpcRequest(request, boundary)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('refuses current-service admission without protected origin and current Machine admission', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-a',
      installationId: 'installation-a', role: 'use' as const, encryptionMode: 'e2ee' as const };
    const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => 'installation-a', verifyMachineAdmission: async () => true };
    const request = { method: 'machine-a:daemon.localServices.preview.admission', params: { v: 1, kind: 'read' } };
    for (const refused of [request, { ...request, machineAdmission },
      { ...request, machineAdmission, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN },
      { ...request, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION, machineAdmission,
        authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } },
      { ...request, method: `machine-a:other:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`, machineAdmission,
        authorization: { kind: 'localServices.preview.admission.serverOrigin' as const } }]) {
      expect(await authorizeMachineRpcRequest(refused, boundary))
        .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
    expect(await authorizeMachineRpcRequest({ ...request, machineAdmission,
      authorization: { kind: 'localServices.preview.admission.serverOrigin' } }))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('binds the strict access-loss subject to current Home verification', async () => {
    const machineAdmission = { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: 'machine-a',
      installationId: 'installation-a', role: 'manage' as const, encryptionMode: 'plain' as const };
    const boundary = { machineId: 'machine-a', resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => 'installation-a',
      // The Home service admits only the exact subject whose structural access remains lost.
      verifyMachineAdmission: async (input: { custodySubjectAccountId?: string }) => input.custodySubjectAccountId === 'bob' };
    const request = { method: `machine-a:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      params: { v: 1, subjectAccountId: 'bob' }, authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN, machineAdmission };
    expect(await authorizeMachineRpcRequest(request, boundary)).toEqual({ ok: true });
    expect(await authorizeMachineRpcRequest({ ...request, params: { ...request.params, serverId: 'forged' } }, boundary))
      .toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });
  it('keeps workspace SCM calls detached and accepts only the separately stamped Session scope', async () => {
    for (const method of ['scm.diffSummary.generate', 'scm.diffSummary.result.read']) {
      expect(await authorizeMachineRpcRequest({ method: `machine-1:${method}`, params: { sessionId: 'selector' } })).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ method: `machine-1:${method}`, params: {},
        authorization: { kind: 'session.write', sessionId: 'authorized-session' } })).toEqual({ ok: true });
      expect(await authorizeMachineRpcRequest({ method: `machine-1:${method}`, params: {},
        authorization: { kind: 'automation.replyHandoff.serverOrigin' } })).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    }
  });
  it('binds current verification to the custodian installation and exact original RPC method', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice',
      machineId: 'alice-machine', installationId: 'alice-installation',
      role: 'use' as const, encryptionMode: 'e2ee' as const };
    const method = 'alice-machine:spawn-happy-session';
    const keyPair = tweetnacl.sign.keyPair();
    // Axios is the Home network boundary; signing and admission remain real.
    const network = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { v: 1, ok: true },
      statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } });
    try {
      expect(await verifyMachineRpcAdmissionCurrent({ context: machineAdmission, method,
        privateKey: keyPair.secretKey, daemonToken: 'alice-daemon-token', serverHttpBaseUrl: 'https://home.invalid' })).toBe(true);
      const body = network.mock.calls[0]?.[1];
      const parsed = body as { context: typeof machineAdmission; method: string;
        proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      const payload = { version: 1 as const, installationId: machineAdmission.installationId,
        machineId: machineAdmission.machineId, accountId: machineAdmission.custodianAccountId,
        rpcAdmission: { context: parsed.context, method: parsed.method } };
      expect(verifyMachineInstallationProof({ payload, proof: parsed.proof, publicKey: keyPair.publicKey })).toBe(true);
      expect(verifyMachineInstallationProof({ payload: { ...payload,
        rpcAdmission: { context: { ...parsed.context, actorAccountId: 'alice' }, method } },
        proof: parsed.proof, publicKey: keyPair.publicKey })).toBe(false);
      network.mockResolvedValueOnce({ status: 403, data: { v: 1, ok: false, code: 'access_denied' },
        statusText: 'Forbidden', headers: {}, config: { headers: new AxiosHeaders() } });
      expect(await verifyMachineRpcAdmissionCurrent({ context: machineAdmission, method,
        privateKey: keyPair.secretKey, daemonToken: 'alice-daemon-token', serverHttpBaseUrl: 'https://home.invalid' })).toBe(false);
    } finally { network.mockRestore(); }
  });
  it('admits the authenticated actor on the exact custodian installation and refuses revoked admission', async () => {
    const machineAdmission = { actorAccountId: 'bob', custodianAccountId: 'alice',
      machineId: 'alice-machine', installationId: 'alice-installation',
      role: 'use' as const, encryptionMode: 'e2ee' as const };
    let current = true;
    const boundary = {
      machineId: 'alice-machine',
      resolveCustodianAccountId: async () => 'alice',
      resolveInstallationId: () => 'alice-installation',
      verifyMachineAdmission: async () => current,
    };
    const request = { method: `alice-machine:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`,
      params: { sessionId: 'bob-session' }, machineAdmission };
    await expect(authorizeMachineRpcRequest(request, boundary)).resolves.toEqual({ ok: true });
    current = false;
    await expect(authorizeMachineRpcRequest(request, boundary)).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    current = true;
    await expect(authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, installationId: 'replacement' } }, boundary))
      .resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
    await expect(authorizeMachineRpcRequest({ ...request, machineAdmission: { ...machineAdmission, custodianAccountId: 'bob' } }, boundary))
      .resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
  });

  it.each([RPC_METHODS.SESSION_CONTINUATION_INSPECT, RPC_METHODS.SESSION_CONTINUATION_INSPECT_BATCH,
    RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW])('binds continuation read authority to the decrypted Session: %s', async method => {
    const sessionField = method === RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW ? 'sessionId' : 'sourceSessionId';
    const request = { method: `machine-1:${method}`, params: { [sessionField]: 'own-session' } };
    expect(await authorizeMachineRpcRequest(request)).toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.write', sessionId: 'own-session' } }))
      .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.read', sessionId: 'other-session' } }))
      .toMatchObject({ ok: false, admissionPredicate: 'session_target' });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { kind: 'session.read', sessionId: 'own-session' } }))
      .toEqual({ ok: true });
  });

  it('allows machine RPC methods that do not require session-write authorization', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({ ok: true });
  });

  it('never spends a Session read proof on a mutation', async () => {
    expect(await authorizeMachineRpcRequest({ method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'own-session' }, authorization: { kind: 'session.read', sessionId: 'own-session' } }))
      .toMatchObject({ ok: false, admissionPredicate: 'session_authorization' });
  });

  it('rejects session-write RPCs without authorization', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('accepts the released server-v0.2.1 Stop shape without a server authorization envelope', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
      transportResponseEnvelopeVersion: undefined,
    })).resolves.toEqual({ ok: true });
  });

  it('keeps current Stop requests fail-closed when the server authorization proof is absent', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.STOP_SESSION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
      transportResponseEnvelopeVersion: 1,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('requires the same session-write authorization for recovery restart V2', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('rejects session-write RPCs when decrypted params target another session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_2' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_target',
    });
  });

  it('allows session-write RPCs when authorization and decrypted params target the same session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART}`,
      params: { sessionId: 'sess_1' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({ ok: true });
  });

  it('requires matching Session authorization for remote grant inventory and revocation', async () => {
    for (const method of [
      'session.permission.remote.grants.list',
      'session.permission.remote.grants.revoke',
    ]) {
      await expect(authorizeMachineRpcRequest({
        method: `sess_1:${method}`,
        params: { sessionId: 'sess_1' },
        authorization: undefined,
      })).resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
      await expect(authorizeMachineRpcRequest({
        method: `sess_1:${method}`,
        params: { sessionId: 'sess_1' },
        authorization: {
          kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
          sessionId: 'sess_1',
        },
      })).resolves.toEqual({ ok: true });
    }
  });

  it('rejects a Session Agent transition with no server-provided edit proof', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_1' },
      authorization: undefined,
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_authorization',
    });
  });

  it('rejects a Session Agent transition whose edit proof names another Session', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_2' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({
      ok: false,
      error: RPC_ERROR_MESSAGES.FORBIDDEN,
      errorCode: RPC_ERROR_CODES.FORBIDDEN,
      admissionPredicate: 'session_target',
    });
  });

  it('allows a Session Agent transition whose edit proof matches the decrypted request', async () => {
    await expect(authorizeMachineRpcRequest({
      method: `machine-1:${RPC_METHODS.SESSION_AGENT_TRANSITION}`,
      params: { sessionId: 'sess_1' },
      authorization: {
        kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE,
        sessionId: 'sess_1',
      },
    })).resolves.toEqual({ ok: true });
  });

});
