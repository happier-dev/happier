import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { readProjectAccountRows, getActiveProjectAccountRowsSnapshot, withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import axios from 'axios';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { composeBindChildSourcePhaseTestRuntime } from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit';
import * as productionWorkspaceSync from '@/daemon/startup/createProductionDaemonWorkspaceSyncRuntime';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { SocketRpcMachineAdmissionContextV1Schema, WorkspaceSyncSourceRoutingV1Schema,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { MachineInstallationProofV1Schema, MachineInstallationPublicIdentityV1Schema, verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import tweetnacl from 'tweetnacl';
import { ApiMachineClient } from '@/api/apiMachine';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import * as installationStore from '@/daemon/identity/store';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SOCKET_RPC_EVENTS, WorkspaceSyncTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';

const socketIo = vi.hoisted(() => vi.fn());
// Genuine transport boundary; the exact-Machine codec and managed observation reader remain real.
vi.mock('socket.io-client', () => ({ io: socketIo }));

import {
  computeWorkspaceSyncPolicyDigest,
  deriveWorkspaceSyncConflictOperationId,
  type WorkspaceSyncTargetBootstrapPrepareV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { registerMachineWorkspaceSyncRpcHandlers, type MachineWorkspaceSyncRpcService } from '@/api/machine/rpcHandlers.workspaceSync';
import type { RpcHandler, RpcHandlerRegistrar, RpcHandlerContext } from '@/api/rpc/types';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createScmBackendRegistry } from '@/scm/registry';
import { deriveWorkspaceSyncRelationshipId } from './workspaceSyncRelationshipIdentity';
import { createWorkspaceRootOwnershipManager, type WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import { createWorkspaceSyncTargetAuthority, readWorkspaceSyncChildMachineFacts } from './workspaceSyncTargetAuthority';
import { prepareWorkspaceSyncBetween } from './workspaceSyncPreparation';
import {
  discoverNativeConfinedWorkspaceSyncRecovery,
  runNativeConfinedWorkspaceSyncApply,
  runNativeConfinedWorkspaceSyncRecover,
} from './workspaceSyncNativeConfinedFileSystem';
import { recoverWorkspaceSyncEntryReplacementAtRoot } from './workspaceSyncConflicts';
import { computeWorkspaceSyncRootFingerprint, workspaceSyncMaterializationReceiptPath, workspaceSyncTargetBootstrap } from './workspaceSyncTargetBootstrap';
import { materializeLocalWorkspaceSyncSeed } from './workspaceSyncSeedTransfer';
import { deriveWorkspaceSyncConflictAsidePaths } from '@happier-dev/protocol';
import {
  beginWorkspaceTargetMaterialization,
  inspectCommittedWorkspaceTargetMaterialization,
  rehydrateWorkspaceTargetMaterializationFromReceiptPath,
} from '@/scm/workspace/workspaceExportMaterialization';

/**
 * A destructive replacement proof is stamped for the handoff operation, while
 * the relationship it bootstraps is named by the canonical derivation of that
 * operation. Fixtures must use the real rule, or they would prove only that a
 * caller can repeat one id back to the target.
 */
const handoffOperationId = 'handoff-op-1';
const relationshipId = deriveWorkspaceSyncRelationshipId(handoffOperationId);

describe('bind-child replacement approval at the physical target owner', () => {
  it('qualifies an independent installed Project target from its own row without a Parent route', async () => {
    const [project, actionHeaders, signing, execution, socketSchemas, installedContent] = await Promise.all([
      import('@happier-dev/protocol/projects/openProjectV1'), import('@happier-dev/protocol/actions/externalActionApi'),
      import('@happier-dev/protocol/actions/externalActionExecutionAuthorization'), import('@/api/externalActionExecutionAuthorization'),
      import('@happier-dev/protocol/socketRpc'),
      import('@/api/rpc/workspaceSyncTargetContent'),
    ]);
    const installed = tweetnacl.sign.keyPair();
    const installedWriter = tweetnacl.sign.keyPair();
    const targetCredentials = { token: ['header', Buffer.from(JSON.stringify({ sub: 'target-owner' })).toString('base64url'),
      'fixture-signature'].join('.'), encryption: null };
    let binding: Readonly<{ root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
      routing: ReturnType<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse>;
      packet: ReturnType<typeof socketSchemas.WorkspaceSyncSourceExecutionV1Schema.parse>;
      admission: ReturnType<typeof SocketRpcMachineAdmissionContextV1Schema.parse>; machineId: string; installationId: string;
      method: string }> | undefined;
    let current = true;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true, targetCredentials,
      readAdditionalHttpPostResponse: async (url, raw) => {
        if (!url.endsWith('/admission/verify')) return undefined;
        if (!binding || !raw || typeof raw !== 'object' || !('proof' in raw)) throw new Error('Missing installed admission proof');
        const isWriter = url === `https://bind-child-home.invalid/v1/machines/${binding.routing.sourceWriter.machineId}/admission/verify`;
        const proofMachineId = isWriter ? binding.routing.sourceWriter.machineId : binding.machineId;
        const proofInstallationId = isWriter ? binding.routing.sourceWriter.installationId : binding.installationId;
        const proofAdmission = isWriter ? binding.routing.source.sourceContext.machineAdmission : binding.admission;
        expect(url).toBe(`https://bind-child-home.invalid/v1/machines/${proofMachineId}/admission/verify`);
        expect(raw).toMatchObject({ method: binding.method, context: proofAdmission, callerInputAuthorization: binding.root,
          workspaceSyncSourceWriterTargetRouting: binding.routing, workspaceSyncSourceExecution: binding.packet });
        expect(raw).not.toHaveProperty('workspaceSyncTargetRouting');
        expect(verifyMachineInstallationProof({ publicKey: isWriter ? installedWriter.publicKey : installed.publicKey,
          proof: MachineInstallationProofV1Schema.parse(raw.proof), payload: { version: 1,
            machineId: proofMachineId, installationId: proofInstallationId, accountId: isWriter ? 'owner' : 'target-owner',
            rpcAdmission: { context: proofAdmission, method: binding.method, callerInputAuthorization: binding.root,
              workspaceSyncSourceWriterTargetRouting: binding.routing, workspaceSyncSourceExecution: binding.packet } } })).toBe(true);
        return current ? { status: 200, data: { v: 1, ok: true, ...(isWriter ? { destinationInstallation: {
          machineId: binding.machineId, installationId: binding.installationId,
          installationPublicKey: Buffer.from(installed.publicKey).toString('base64url') } } : {}) } }
          : { status: 403, data: { error: 'access_denied' } };
      } });
    if (!fixture.targetParent) throw new Error('Independent target runtime was not composed');
    const machineId = fixture.targetRef.machineId;
    const installationId = fixture.managedTargetChild.controller.installationId;
    const operationId = 'independent-project-target-preflight';
    const input = project.OpenProjectInputV1Schema.parse({ serverId: fixture.serverId, machineId,
      source: { kind: 'workspace', workspaceId: fixture.childRef.id, checkout: { serverId: fixture.serverId,
        workspaceId: fixture.childRef.id, machineId: fixture.childRef.machineId, rootPath: fixture.childRef.rootPath } },
      materialization: { kind: 'sync', targetPath: fixture.targetPath, workspaceAction: fixture.prepareInput.action } });
    const envelope = actionHeaders.ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'original-independent-project',
      target: { kind: 'machine', machineId }, input });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-verified-independent-project', binding: {
      accountId: 'borrower', principalId: 'borrower', credentialId: 'independent-project-pat', grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: 'target-owner', serverIdentityId: fixture.serverId, machineId, installationId,
      actionId: 'projects.open', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: signing.computeExternalActionRequestEnvelopeDigestV1(envelope) } });
    const source = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId,
      accountServerId: fixture.serverId, sourceMachineId: fixture.childRef.machineId, sourceRootPath: fixture.childRef.rootPath,
      originalActionEnvelope: envelope, sourceContext: { callerAuthority: 'account_automation', workspaceWrites: 'allow',
        callerInputConstraints: { models: API_TOKEN_FULL_GRANT_V1.models, permissionModes: API_TOKEN_FULL_GRANT_V1.permissionModes },
        machineAdmission: { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
          installationId: fixture.childInstallationId, role: 'use', encryptionMode: 'plain' } } });
    const method = `${machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
    const packetMethod = `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`;
    const content = installedContent.createWorkspaceSyncTargetContent({ destination: { machineId: fixture.sourceRef.machineId,
      installationId: fixture.controller.installationId,
      installationPublicKey: Buffer.from(installedWriter.publicKey).toString('base64url') }, method: packetMethod, routing: source });
    const packetParams = await socketRpcCodec.encodeParams(content, input, { method: packetMethod, callId: 'a'.repeat(32) });
    const packet = socketSchemas.WorkspaceSyncSourceExecutionV1Schema.parse({ method: packetMethod, requestId: 'independent-source-packet',
      params: packetParams, externalActionExecution: execution.createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: root, externalActionTarget: root.binding.target }, effectActionId: 'projects.open',
        installationId, method: packetMethod, requestId: 'independent-source-packet', params: packetParams,
        workspaceSyncSourceRouting: source, privateKey: installed.secretKey }) });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, sourceWriter: fixture.controller, source,
      target: { v: 1, phase: 'preflight', operationId, accountServerId: fixture.serverId,
        targetMachineId: machineId, targetRootPath: fixture.targetPath } });
    const admission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'borrower', custodianAccountId: 'target-owner',
      machineId, installationId, role: 'use', encryptionMode: 'plain' });
    binding = { root, routing, packet, admission, machineId, installationId, method };
    const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId, resolveCustodianAccountId: async () => 'target-owner',
        resolveInstallationId: () => installationId, verifyMachineAdmission: admitted => verifyMachineRpcAdmissionCurrent({ ...admitted,
          workspaceSyncSourceWriterTargetReceiver: { machineId, installationId, accountId: 'target-owner' },
          privateKey: installed.secretKey, daemonToken: targetCredentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid' }) }) });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: fixture.targetParent.workspaceSync });
    const request = { method, params: { v: 1, operationId, serverId: fixture.serverId, machineId,
      targetPath: fixture.targetPath, destinationIntent: 'materialize_from_source_workspace' }, machineAdmission: admission,
      callerInputAuthorization: root, callerAuthority: 'account_automation' as const,
      callerInputConstraints: source.sourceContext!.callerInputConstraints,
      workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncSourceExecution: packet };
    // This signed Home-response boundary is not a claim that the issuer ran.
    const response = await rpc.handleRequest(request);
    expect(response).toMatchObject({ type: 'not_required', targetWorkspace: fixture.targetRef });
    const identity = (writer: boolean) => ({ version: 1 as const, createdAt: 1,
      installationId: writer ? fixture.controller.installationId : installationId,
      publicKey: Buffer.from((writer ? installedWriter : installed).publicKey).toString('base64url'),
      privateKey: Buffer.from((writer ? installedWriter : installed).secretKey).toString('base64url') });
    const osIdentity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity(true));
    onTestFinished(() => osIdentity.mockRestore());
    const writer = runWithServerHttpBaseUrl('https://bind-child-home.invalid', () =>
      new ApiMachineClient(fixture.credentials.token, { id: fixture.sourceRef.machineId, encryptionMode: 'plain',
        encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy', metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0 }));
    Reflect.set(writer, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string'
        || !('requestId' in raw) || typeof raw.requestId !== 'string' || !('params' in raw) || !('externalActionExecution' in raw)) {
        throw new Error('The installed SOURCE writer did not sign the chosen target request');
      }
      const signed = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
      expect(raw.method).toBe(method);
      expect(raw).toMatchObject({ workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncSourceExecution: packet });
      expect(raw).not.toHaveProperty('workspaceSyncTargetRouting');
      expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: 'projects.open',
        target: root.binding.target, installationId: fixture.controller.installationId, event: SOCKET_RPC_EVENTS.CALL,
        method, requestId: raw.requestId, params: raw.params, workspaceSyncSourceWriterTargetRouting: routing,
        publicKey: installedWriter.publicKey, signature: signed.machineSignature })).toBe(true);
      osIdentity.mockReturnValue(identity(false));
      try { return { ok: true, result: await rpc.handleRequest({ ...raw, machineAdmission: admission, callerInputAuthorization: root,
        callerAuthority: 'account_automation', callerInputConstraints: source.sourceContext!.callerInputConstraints }) }; }
      finally { osIdentity.mockReturnValue(identity(true)); }
    } }));
    const throughWriter = await writer.callWorkspaceSyncTargetPhase({ machineId,
      method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, request: request.params, routing: routing.target,
      credentials: fixture.credentials, context: buildActionExecutorContextForRpc({ callerInputAuthorization: root,
        callerAuthority: 'account_automation', callerInputConstraints: source.sourceContext!.callerInputConstraints,
        machineAdmission: source.sourceContext!.machineAdmission, workspaceSyncSourceRouting: source,
        workspaceSyncSourceExecution: packet, signal: new AbortController().signal, serverId: fixture.serverId,
        verifyMachineAdmissionCurrent: async () => await verifyMachineRpcAdmissionCurrent({ context: source.sourceContext!.machineAdmission,
          method, workspaceSyncSourceWriterTargetRouting: routing, workspaceSyncSourceExecution: packet, callerInputAuthorization: root,
          workspaceSyncSourceWriterTargetReceiver: { machineId: fixture.sourceRef.machineId,
            installationId: fixture.controller.installationId, accountId: 'owner', destinationMachineId: machineId },
          privateKey: installedWriter.secretKey, daemonToken: fixture.credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid' }) }) });
    expect(throughWriter).toMatchObject({ type: 'not_required', targetWorkspace: fixture.targetRef, physicalEndpoint: {
      machineId, installationId, installationPublicKey: Buffer.from(installed.publicKey).toString('base64url') } });
    const loan = await fixture.probeTarget();
    expect(loan).not.toHaveProperty('kind');
    if (!('kind' in loan)) await loan.release();
    expect(await rpc.handleRequest({ ...request, params: { ...request.params, targetPath: `${fixture.targetPath}-other` } }))
      .toMatchObject({ error: expect.any(String) });
    current = false;
    expect(await rpc.handleRequest(request)).toMatchObject({ error: expect.any(String) });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    current = true;
    const prepareRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...routing,
      target: { ...routing.target, phase: 'prepare' } });
    const prepareMethod = `${machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`;
    binding = { ...binding, routing: prepareRouting, method: prepareMethod };
    const prepared = await rpc.handleRequest({ ...request, method: prepareMethod,
      workspaceSyncSourceWriterTargetRouting: prepareRouting,
      params: { v: 1, bootstrapOperationId: operationId,
        owner: { kind: 'copy_once', operation: { v: 1, operationId,
          controllerMachineId: fixture.sourceRef.machineId, alphaWorkspaceRefId: fixture.sourceRef.id,
          betaWorkspaceRefId: fixture.targetRef.id, contentPolicy: fixture.prepareInput.action.contentPolicy } },
        targetWorkspaceRefId: fixture.targetRef.id, endpointRole: 'beta',
        policyDigest: fixture.prepareInput.action.contentPolicy.policyDigest, createIfMissing: true,
        targetBootstrap: 'materialize_from_source_workspace' } });
    expect(prepared).toMatchObject({ state: 'ready', targetWorkspaceRefId: fixture.targetRef.id,
      targetWorkspace: fixture.targetRef });
    expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
  });

  it.each([
    { title: 'prepares through the original chosen TARGET owner without reading its rows from the SOURCE writer', lostAcknowledgement: false },
    { title: 'releases cross-custodian target custody from the preflight endpoint after a completed prepare acknowledgement is lost', lostAcknowledgement: true },
  ])('$title', async ({ lostAcknowledgement }) => {
    const sourceKey = tweetnacl.sign.keyPair();
    const childKey = tweetnacl.sign.keyPair();
    const parentKey = tweetnacl.sign.keyPair();
    let chosenClient: ApiMachineClient | undefined;
    let binding: Readonly<{
      root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
      routing: ReturnType<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse>;
      targetRouting: ReturnType<typeof WorkspaceSyncTargetRoutingV1Schema.parse>;
    }> | undefined;
    let physicalHomeVerified = false;
    let wrongPhysicalDestination = false;
    let targetRetired = false;
    let releaseRouting: ReturnType<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse> | undefined;
    const writerCustody = { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'source-parent',
      installationId: 'parent-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    const targetCredentials = lostAcknowledgement ? { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'target-owner' })).toString('base64url'),
      'fixture-signature',
    ].join('.'), encryption: null } : undefined;
    const targetCustodianAccountId = targetCredentials ? 'target-owner' : 'owner';
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true, withTargetChildRuntime: true,
      ...(targetCredentials ? { targetCredentials } : {}),
      callWorkspaceTargetPhase: async (descriptor, context) => {
        if (!chosenClient) throw new Error('The actual chosen target client was not installed');
        return await chosenClient.callWorkspaceSyncTargetPhase({ ...descriptor, credentials: fixture.targetCredentials,
          context: buildActionExecutorContextForRpc({ ...context, serverId: fixture.serverId }) });
      },
      readAdditionalHttpPostResponse: async (url, raw) => {
        if (targetRetired && !url.endsWith('/admission/verify')) throw new Error('Cleanup reacquired retired target/native authority');
        if (url.endsWith('/v1/account/project-rows/list')) {
          const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
          // P1 owns its physical source and child namespace rows. D/P2's rows
          // belong to the receiving owner, never a borrower box at P1.
          return { status: 200, data: { status: 'listed', coverage: 'complete', rows:
            [fixture.sourceRef, fixture.childRef].map(value => {
              const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
              return { key, revision: 0, content: cipher.seal({ key, value }) };
            }) } };
        }
        if (!url.endsWith('/admission/verify')) return undefined;
        const receivingMachineId = new URL(url).pathname.split('/')[3];
        if (releaseRouting && receivingMachineId === fixture.sourceRef.machineId) {
          throw new Error('Rootless cleanup must not invent a source key-discovery purpose');
        }
        if (releaseRouting && receivingMachineId === fixture.targetRef.machineId) {
          if (!raw || typeof raw !== 'object' || !('context' in raw) || !('proof' in raw) || !('method' in raw)
            || !('workspaceSyncSourceWriterTargetRouting' in raw)) throw new Error('Missing installed cleanup proof');
          expect(raw).not.toHaveProperty('callerInputAuthorization');
          expect(raw).not.toHaveProperty('workspaceSyncTargetRouting');
          expect(raw.context).toEqual(writerCustody);
          expect(raw.workspaceSyncSourceWriterTargetRouting).toEqual(releaseRouting);
          expect(raw.method).toBe(`target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`);
          expect(releaseRouting.sourceWriter).toEqual(fixture.controller);
          expect(verifyMachineInstallationProof({ publicKey: parentKey.publicKey,
            proof: MachineInstallationProofV1Schema.parse(raw.proof), payload: { version: 1, machineId: receivingMachineId,
              installationId: 'target-parent-installation', accountId: targetCustodianAccountId,
              rpcAdmission: { context: writerCustody, method: String(raw.method),
                workspaceSyncSourceWriterTargetRouting: releaseRouting } } })).toBe(true);
          return { status: 200, data: { v: 1, ok: true } };
        }
        if (receivingMachineId === fixture.sourceRef.machineId) {
          if (!binding || !raw || typeof raw !== 'object' || !('context' in raw) || !('method' in raw)
            || !('proof' in raw) || !('callerInputAuthorization' in raw)) {
            throw new Error('Missing original physical SOURCE admission proof');
          }
          expect(raw.context).toEqual(binding.routing.source.sourceContext.machineAdmission);
          expect(raw.callerInputAuthorization).toEqual(binding.root);
          const writerTargetProof = 'workspaceSyncSourceWriterTargetRouting' in raw;
          if (writerTargetProof) expect(raw.workspaceSyncSourceWriterTargetRouting).toEqual(binding.routing);
          else {
            if (!('workspaceSyncSourceRouting' in raw)) throw new Error('Missing physical SOURCE routing');
            expect(raw.workspaceSyncSourceRouting).toEqual(binding.routing.source);
          }
          expect(verifyMachineInstallationProof({ publicKey: sourceKey.publicKey,
            proof: MachineInstallationProofV1Schema.parse(raw.proof), payload: { version: 1,
              ...fixture.controller, accountId: 'owner', rpcAdmission: { context: binding.routing.source.sourceContext.machineAdmission,
                method: String(raw.method), callerInputAuthorization: binding.root,
                ...(writerTargetProof ? { workspaceSyncSourceWriterTargetRouting: binding.routing }
                  : { workspaceSyncSourceRouting: binding.routing.source }) } } })).toBe(true);
          return { status: 200, data: { v: 1, ok: true, ...(writerTargetProof ? { destinationInstallation: {
            machineId: 'target-child', installationId: 'target-child-installation',
            installationPublicKey: Buffer.from(childKey.publicKey).toString('base64url') } } : {}) } };
        }
        if (!binding || !raw || typeof raw !== 'object' || !('context' in raw) || !('method' in raw)
          || !('proof' in raw) || !('callerInputAuthorization' in raw) || !('workspaceSyncSourceWriterTargetRouting' in raw)) {
          throw new Error('Missing original SOURCE target proof');
        }
        const physical = receivingMachineId === 'target-parent';
        expect(receivingMachineId).toBe(physical ? 'target-parent' : 'target-child');
        expect(ExternalActionExecutionAuthorizationV1Schema.parse(raw.callerInputAuthorization)).toEqual(binding.root);
        expect(WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(raw.workspaceSyncSourceWriterTargetRouting)).toEqual(binding.routing);
        expect(SocketRpcMachineAdmissionContextV1Schema.parse(raw.context)).toEqual(binding.targetRouting.targetContext.machineAdmission);
        const paired = 'workspaceSyncTargetRouting' in raw;
        if (paired) expect(WorkspaceSyncTargetRoutingV1Schema.parse(raw.workspaceSyncTargetRouting)).toEqual(binding.targetRouting);
        const targetMethod = binding.routing.target.phase === 'prepare'
          ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
          : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
        expect([`target-child:${targetMethod}`, `target-parent:${targetMethod}`]).toContain(raw.method);
        expect(verifyMachineInstallationProof({ publicKey: physical ? parentKey.publicKey : childKey.publicKey,
          proof: MachineInstallationProofV1Schema.parse(raw.proof), payload: {
            version: 1, machineId: receivingMachineId,
            installationId: physical ? 'target-parent-installation' : 'target-child-installation', accountId: targetCustodianAccountId,
            rpcAdmission: { context: binding.targetRouting.targetContext.machineAdmission, method: String(raw.method),
              callerInputAuthorization: binding.root, workspaceSyncSourceWriterTargetRouting: binding.routing,
              ...(paired ? { workspaceSyncTargetRouting: binding.targetRouting } : {}) },
          } })).toBe(true);
        physicalHomeVerified ||= physical;
        const destinationIsPhysical = raw.method === `target-parent:${targetMethod}`;
        return { status: 200, data: { v: 1, ok: true, destinationInstallation: {
          machineId: destinationIsPhysical && wrongPhysicalDestination ? 'another-physical-machine'
            : destinationIsPhysical ? 'target-parent' : 'target-child',
          installationId: destinationIsPhysical ? 'target-parent-installation' : 'target-child-installation',
          installationPublicKey: Buffer.from(destinationIsPhysical ? parentKey.publicKey : childKey.publicKey).toString('base64url'),
        } } };
      } });
    if (!fixture.targetParent || !fixture.targetChild) throw new Error('Actual target child and physical Production owners were not composed');
    const operationId = 'chosen-target-original-source-preflight';
    const sourceAdmission = { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
      installationId: fixture.childInstallationId, role: 'use' as const, encryptionMode: 'plain' as const };
    const admission = { ...sourceAdmission, custodianAccountId: targetCustodianAccountId,
      machineId: fixture.targetChildRef.machineId, installationId: fixture.targetChildInstallationId };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-source-chosen-target-preflight', binding: {
      accountId: 'borrower', principalId: 'borrower', credentialId: 'source-pat', grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: 'owner', serverIdentityId: fixture.serverId, machineId: sourceAdmission.machineId,
      installationId: sourceAdmission.installationId, actionId: 'session.handoff', requestId: operationId,
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: sourceAdmission.machineId },
      handoffAdmission: { sessionId: 'source-session', sourceMachineId: sourceAdmission.machineId,
        sourceInstallationId: sourceAdmission.installationId, targetMachineId: admission.machineId,
        targetInstallationId: admission.installationId },
    } });
    const source = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId, accountServerId: fixture.serverId,
      sourceMachineId: sourceAdmission.machineId, sourceRootPath: fixture.childRef.rootPath, sourceSessionId: 'source-session',
      sourceContext: { machineAdmission: sourceAdmission, callerAuthority: 'account_automation',
        callerInputConstraints: { models: null, permissionModes: null }, workspaceWrites: 'allow' } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, source, sourceWriter: fixture.controller,
      target: { v: 1, phase: 'preflight', operationId, accountServerId: fixture.serverId,
        targetMachineId: admission.machineId, targetRootPath: fixture.targetChildRef.rootPath } });
    const targetRouting = WorkspaceSyncTargetRoutingV1Schema.parse({ ...routing.target,
      targetContext: { ...source.sourceContext, machineAdmission: admission } });
    binding = { root, routing, targetRouting };
    const identity = (physical: boolean) => ({ version: 1 as const, createdAt: 1,
      installationId: physical ? fixture.managedTargetChild.controller.installationId : admission.installationId,
      publicKey: Buffer.from(physical ? parentKey.publicKey : childKey.publicKey).toString('base64url'),
      privateKey: Buffer.from(physical ? parentKey.secretKey : childKey.secretKey).toString('base64url') });
    const osIdentity = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity(false));
    const receiving = (physical: boolean) => new RpcHandlerManager({
      scopePrefix: physical ? fixture.targetRef.machineId : admission.machineId,
      localMachineId: physical ? fixture.targetRef.machineId : admission.machineId, encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: physical ? fixture.targetRef.machineId : admission.machineId, resolveCustodianAccountId: async () => targetCustodianAccountId,
        resolveInstallationId: () => identity(physical).installationId,
        verifyMachineAdmission: admitted => verifyMachineRpcAdmissionCurrent({ ...admitted,
          ...(admitted.workspaceSyncTargetRouting
            ? { workspaceSyncTargetReceiver: { machineId: fixture.targetRef.machineId, installationId: identity(true).installationId } }
            : { workspaceSyncSourceWriterTargetReceiver: { machineId: physical ? fixture.targetRef.machineId : admission.machineId,
              installationId: identity(physical).installationId, accountId: targetCustodianAccountId } }),
          privateKey: physical ? parentKey.secretKey : childKey.secretKey, daemonToken: fixture.targetCredentials.token,
          serverHttpBaseUrl: 'https://bind-child-home.invalid' }),
      }) });
    const chosen = receiving(false);
    const physical = receiving(true);
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: chosen, service: fixture.targetChild.workspaceSync });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: physical, service: fixture.targetParent.workspaceSync });
    chosenClient = new ApiMachineClient(fixture.targetCredentials.token, { id: admission.machineId, encryptionMode: 'plain',
      encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy', metadata: null, metadataVersion: 0,
      daemonState: null, daemonStateVersion: 0 });
    let forwarded = false;
    Reflect.set(chosenClient, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
      if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)
        || !('requestId' in raw) || typeof raw.requestId !== 'string' || !('externalActionExecution' in raw)) {
        throw new Error('The installed target child did not sign its physical preflight');
      }
      if (!binding) throw new Error('Target phase correlation was not retained');
      const currentMethod = binding.routing.target.phase === 'prepare'
        ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
      expect(raw.method).toBe(`${fixture.targetRef.machineId}:${currentMethod}`);
      expect(raw).toMatchObject({ workspaceSyncSourceWriterTargetRouting: binding.routing, workspaceSyncTargetRouting: binding.targetRouting });
      const signed = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
      expect(signed).toMatchObject({ authorization: root, installationId: admission.installationId });
      expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: signed.effectActionId,
        target: signed.target, installationId: signed.installationId, event: SOCKET_RPC_EVENTS.CALL,
        method: raw.method, requestId: raw.requestId, params: raw.params, workspaceSyncSourceWriterTargetRouting: binding.routing,
        publicKey: childKey.publicKey, signature: signed.machineSignature })).toBe(true);
      forwarded = true;
      osIdentity.mockReturnValue(identity(true));
      try {
        return { ok: true, result: await physical.handleRequest({ ...raw, machineAdmission: admission,
          callerInputAuthorization: root, callerAuthority: 'account_automation',
          callerInputConstraints: source.sourceContext!.callerInputConstraints }) };
      } finally { osIdentity.mockReturnValue(identity(false)); }
    } }));
    try {
      const response = await chosen.handleRequest({
        method: `${admission.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
        params: { v: 1, operationId, serverId: fixture.serverId, machineId: admission.machineId, targetPath: fixture.targetChildRef.rootPath },
        machineAdmission: admission, callerInputAuthorization: root, callerAuthority: 'account_automation',
        callerInputConstraints: source.sourceContext!.callerInputConstraints, workspaceSyncSourceWriterTargetRouting: routing,
      });
      expect(response, `Chosen-target physical preflight result: ${JSON.stringify(response)}`).toEqual({ type: 'not_required',
        physicalEndpoint: { machineId: fixture.targetRef.machineId, installationId: identity(true).installationId,
          installationPublicKey: identity(true).publicKey } });
      expect(forwarded).toBe(true);
      expect(physicalHomeVerified).toBe(true);
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      const loan = await fixture.probeTarget();
      expect(loan).not.toHaveProperty('kind');
      if (!('kind' in loan)) await loan.release();
      wrongPhysicalDestination = true;
      forwarded = false;
      physicalHomeVerified = false;
      const wrongRecipient = await chosen.handleRequest({
        method: `${admission.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
        params: { v: 1, operationId, serverId: fixture.serverId, machineId: admission.machineId, targetPath: fixture.targetChildRef.rootPath },
        machineAdmission: admission, callerInputAuthorization: root, callerAuthority: 'account_automation',
        callerInputConstraints: source.sourceContext!.callerInputConstraints, workspaceSyncSourceWriterTargetRouting: routing,
      });
      expect(wrongRecipient).toMatchObject({ errorCode: 'peer_unavailable' });
      expect(forwarded).toBe(false);
      expect(physicalHomeVerified).toBe(false);
      await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
      const refusedLoan = await fixture.probeTarget();
      expect(refusedLoan).not.toHaveProperty('kind');
      if (!('kind' in refusedLoan)) await refusedLoan.release();
      wrongPhysicalDestination = false;
      await runWithServerHttpBaseUrl('https://bind-child-home.invalid', () => readProjectAccountRows({
        credentials: fixture.credentials, serverId: fixture.serverId }));
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([fixture.sourceRef, fixture.childRef]);
      const prepareRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...routing,
        target: { ...routing.target, phase: 'prepare' } });
      const sourceIdentity = { version: 1 as const, createdAt: 1, installationId: fixture.controller.installationId,
        publicKey: Buffer.from(sourceKey.publicKey).toString('base64url'), privateKey: Buffer.from(sourceKey.secretKey).toString('base64url') };
      const sourceClient = new ApiMachineClient(fixture.credentials.token, { id: fixture.sourceRef.machineId, encryptionMode: 'plain',
        encryptionKey: new Uint8Array(32).fill(1), encryptionVariant: 'legacy', metadata: null, metadataVersion: 0,
        daemonState: null, daemonStateVersion: 0 });
      let prepareReachedChosenOwner = false;
      let completedTargetPreparation = false;
      const workAbort = new AbortController();
      Reflect.set(sourceClient, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
        if (targetRetired) {
          if (!releaseRouting || !raw || typeof raw !== 'object' || !('method' in raw) || !('requestId' in raw)
            || typeof raw.requestId !== 'string' || !('params' in raw)) throw new Error('Missing retained cleanup request');
          expect(raw.method).toBe(`target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE}`);
          expect(raw).toMatchObject({ workspaceSyncSourceWriterTargetRouting: releaseRouting });
          expect(raw).not.toHaveProperty('externalActionExecution');
          expect(raw).not.toHaveProperty('workspaceSyncTargetRouting');
          osIdentity.mockReturnValue(identity(true));
          try { return { ok: true, result: await physical.handleRequest({ ...raw,
            machineAdmission: writerCustody, callerAuthority: 'present_user' }) }; }
          finally { osIdentity.mockReturnValue(sourceIdentity); }
        }
        if (!raw || typeof raw !== 'object' || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)
          || !('requestId' in raw) || typeof raw.requestId !== 'string' || !('externalActionExecution' in raw)) {
          throw new Error('The actual SOURCE writer did not send the chosen TARGET purpose');
        }
        if (!binding) throw new Error('The original target operation was not retained');
        const currentRouting = binding.routing;
        const currentMethod = currentRouting.target.phase === 'prepare' ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE
          : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
        expect(raw.method).toBe(`${admission.machineId}:${currentMethod}`);
        expect(raw).toMatchObject({ workspaceSyncSourceWriterTargetRouting: currentRouting });
        const signed = ExternalActionMachineRpcExecutionV1Schema.parse(raw.externalActionExecution);
        expect(signed).toMatchObject({ authorization: root, installationId: fixture.controller.installationId });
        expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: root.token, effectActionId: signed.effectActionId,
          target: signed.target, installationId: signed.installationId, event: SOCKET_RPC_EVENTS.CALL,
          method: raw.method, requestId: raw.requestId, params: raw.params, workspaceSyncSourceWriterTargetRouting: currentRouting,
          publicKey: sourceKey.publicKey, signature: signed.machineSignature })).toBe(true);
        prepareReachedChosenOwner ||= currentRouting.target.phase === 'prepare';
        osIdentity.mockReturnValue(identity(false));
        try {
          // The receiver completes on its own RPC lifetime, never the sender's signal.
          const result = await chosen.handleRequest({ ...raw, machineAdmission: admission,
            callerInputAuthorization: root, callerAuthority: 'account_automation', callerInputConstraints: source.sourceContext!.callerInputConstraints });
          if (lostAcknowledgement && currentRouting.target.phase === 'prepare') {
            // The real Manager returns the installed-key encrypted response;
            // only P1's per-call reply key could open it. Custody and the actual
            // prepared root establish completion without bypassing that codec.
            expect(typeof result).toBe('string');
            expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
            expect(await readdir(fixture.targetPath)).toEqual([]);
            completedTargetPreparation = true;
            targetRetired = true;
            fixture.retireTargetChild();
            if (!chosenClient) throw new Error('The completed target receiver was not installed');
            Reflect.set(chosenClient, 'socket', createApiSessionSocketStub({ connected: false }));
            workAbort.abort();
            // The completed receiver has no live handler for the later CANCEL.
            return await new Promise<never>(() => {});
          }
          return { ok: true, result };
        } finally { osIdentity.mockReturnValue(sourceIdentity); }
      } }));
      const sourceAuthority = createWorkspaceSyncTargetAuthority({ localServerId: fixture.serverId, localMachineId: fixture.sourceRef.machineId,
        callMachineRpc: async () => { throw new Error('Original target preparation must not borrow a physical parent Account transport'); },
        callWorkspaceTargetPhase: async (descriptor, context) => await sourceClient.callWorkspaceSyncTargetPhase({ ...descriptor,
          credentials: fixture.credentials, context: buildActionExecutorContextForRpc({ ...context, serverId: fixture.serverId }) }),
        bootstrap: { materializationDirectory: join(fixture.sourcePath, 'target-materialization'),
          rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(fixture.sourcePath, 'target-custody') }) } });
      onTestFinished(async () => { await sourceAuthority.releaseAllRetainedBootstraps(); withdrawActiveProjectAccountRowsSnapshot(); });
      const sourceContext: RpcHandlerContext = { signal: new AbortController().signal,
        machineAdmission: sourceAdmission, callerAuthority: source.sourceContext!.callerAuthority,
        callerInputAuthorization: root, callerInputConstraints: source.sourceContext!.callerInputConstraints,
        workspaceSyncSourceRouting: source,
        verifyMachineAdmissionCurrent: async () => await verifyMachineRpcAdmissionCurrent({ context: sourceAdmission,
          method: `${fixture.sourceRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`,
          workspaceSyncSourceRouting: source, callerInputAuthorization: root,
          workspaceSyncSourceReceiver: fixture.controller, privateKey: sourceKey.secretKey,
          daemonToken: fixture.credentials.token, serverHttpBaseUrl: 'https://bind-child-home.invalid' }) };
      osIdentity.mockReturnValue(sourceIdentity);
      binding = { root, routing, targetRouting };
      const witnessedPreflight = await sourceClient.callWorkspaceSyncTargetPhase({ machineId: admission.machineId,
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
        request: { v: 1, operationId, serverId: fixture.serverId, machineId: admission.machineId,
          targetPath: fixture.targetChildRef.rootPath }, routing: routing.target,
        credentials: fixture.credentials, context: buildActionExecutorContextForRpc({ ...sourceContext, serverId: fixture.serverId }) });
      if (!witnessedPreflight || typeof witnessedPreflight !== 'object' || !('physicalEndpoint' in witnessedPreflight)) {
        throw new Error('The real preflight did not publish its verified physical recipient');
      }
      const physicalEndpoint = MachineInstallationPublicIdentityV1Schema.parse(witnessedPreflight.physicalEndpoint);
      expect(physicalEndpoint).toEqual({ machineId: fixture.targetRef.machineId, installationId: identity(true).installationId,
        installationPublicKey: identity(true).publicKey });
      binding = { root, routing: prepareRouting, targetRouting: WorkspaceSyncTargetRoutingV1Schema.parse({
        ...prepareRouting.target, targetContext: targetRouting.targetContext }) };
      const preparation = sourceAuthority.prepareBootstrapAtTarget({ v: 1, bootstrapOperationId: operationId,
        owner: { kind: 'copy_once', operation: { v: 1, operationId, controllerMachineId: fixture.sourceRef.machineId,
          alphaWorkspaceRefId: fixture.sourceRef.id, betaWorkspaceRefId: fixture.targetChildRef.id, contentPolicy } },
        targetWorkspaceRefId: fixture.targetChildRef.id, targetMachineId: admission.machineId,
        admittedTarget: { machineId: admission.machineId, rootPath: fixture.targetChildRef.rootPath },
        endpointRole: 'beta', policyDigest: contentPolicy.policyDigest, createIfMissing: true,
        targetBootstrap: 'materialize_from_source_workspace', ...(lostAcknowledgement ? { signal: workAbort.signal } : {}) }, sourceContext);
      if (lostAcknowledgement) {
        await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
        expect(completedTargetPreparation).toBe(true);
        expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
        osIdentity.mockReturnValue(sourceIdentity);
        releaseRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...prepareRouting,
          target: { ...prepareRouting.target, phase: 'release' } });
        const cleanupContext = buildActionExecutorContextForRpc({ machineAdmission: writerCustody,
          callerAuthority: 'present_user', workspaceSyncSourceWriterTargetRouting: releaseRouting,
          serverId: fixture.serverId });
        const cleanup = { machineId: physicalEndpoint.machineId,
          method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
          request: { v: 1 as const, bootstrapOperationId: operationId, targetWorkspaceRefId: fixture.targetChildRef.id, reason: 'abort' as const },
          routing: releaseRouting.target, physicalEndpoint, credentials: fixture.credentials, context: cleanupContext,
          signal: new AbortController().signal } satisfies Parameters<ApiMachineClient['callWorkspaceSyncTargetPhase']>[0]
            & Readonly<{ physicalEndpoint: typeof physicalEndpoint }>;
        for (const request of [
          { ...cleanup.request, targetWorkspaceRefId: 'another-logical-target' },
          { ...cleanup.request, bootstrapOperationId: 'another-prepared-operation' },
        ]) {
          await expect(sourceClient.callWorkspaceSyncTargetPhase({ ...cleanup, request })).rejects.toBeInstanceOf(Error);
          expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
        }
        const retainedRouting = releaseRouting;
        for (const changed of [
          { ...retainedRouting, sourceWriter: { machineId: 'third-source-writer', installationId: 'third-installation' } },
          { ...retainedRouting, source: { ...retainedRouting.source,
            sourceContext: { ...retainedRouting.source.sourceContext,
              machineAdmission: { ...retainedRouting.source.sourceContext.machineAdmission, actorAccountId: 'another-borrower' } } } },
          { ...retainedRouting, source: { ...retainedRouting.source,
            sourceContext: { ...retainedRouting.source.sourceContext, workspaceWrites: 'deny' as const } } },
          { ...retainedRouting, target: { ...retainedRouting.target, targetRootPath: '/another/target' } },
        ]) {
          releaseRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(changed);
          await expect(sourceClient.callWorkspaceSyncTargetPhase({ ...cleanup, routing: releaseRouting.target,
            context: buildActionExecutorContextForRpc({ machineAdmission: writerCustody, callerAuthority: 'present_user',
              workspaceSyncSourceWriterTargetRouting: releaseRouting, serverId: fixture.serverId }) })).rejects.toBeInstanceOf(Error);
          expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
        }
        releaseRouting = retainedRouting;
        expect(await sourceClient.callWorkspaceSyncTargetPhase(cleanup)).toEqual({ ok: true, released: true });
        await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
        const releasedLoan = await fixture.probeTarget();
        expect(releasedLoan).not.toHaveProperty('kind');
        if (!('kind' in releasedLoan)) await releasedLoan.release();
        expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
        return;
      }
      const prepared = await preparation;
      expect(prepared).toMatchObject({ state: 'ready', targetWorkspaceRefId: fixture.targetRef.id,
        physicalEndpoint: { machineId: fixture.targetRef.machineId, installationId: identity(true).installationId,
          installationPublicKey: identity(true).publicKey } });
      expect(prepareReachedChosenOwner).toBe(true);
      expect(await fixture.probeTarget()).toMatchObject({ kind: 'overlap' });
      expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([fixture.sourceRef, fixture.childRef]);
    } finally { osIdentity.mockRestore(); }
  });

  it('derives the admitted target context at the real physical preflight from the verified original SOURCE carrier', async () => {
    const installedTarget = tweetnacl.sign.keyPair();
    let proofBinding: Readonly<{
      root: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse>;
      routing: ReturnType<typeof WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse>;
      admission: ReturnType<typeof SocketRpcMachineAdmissionContextV1Schema.parse>;
      machineId: string;
      installationId: string;
      method: string;
    }> | undefined;
    let independentlyVerified = false;
    let homeAdmitted = true;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, separateTargetParent: true,
      readAdditionalHttpPostResponse: async (url, raw) => {
        if (!url.endsWith('/admission/verify')) return undefined;
        if (!proofBinding || !raw || typeof raw !== 'object' || !('context' in raw)
          || !('proof' in raw) || !('callerInputAuthorization' in raw)
          || !('workspaceSyncSourceWriterTargetRouting' in raw) || !('method' in raw)) {
          throw new Error('Missing original Root target admission proof');
        }
        expect(url).toBe(`https://bind-child-home.invalid/v1/machines/${proofBinding.machineId}/admission/verify`);
        expect(SocketRpcMachineAdmissionContextV1Schema.parse(raw.context)).toEqual(proofBinding.admission);
        expect(ExternalActionExecutionAuthorizationV1Schema.parse(raw.callerInputAuthorization)).toEqual(proofBinding.root);
        expect(WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(raw.workspaceSyncSourceWriterTargetRouting)).toEqual(proofBinding.routing);
        expect(raw.method).toBe(proofBinding.method);
        expect(raw).not.toHaveProperty('workspaceSyncTargetRouting');
        expect(verifyMachineInstallationProof({ publicKey: installedTarget.publicKey,
          proof: MachineInstallationProofV1Schema.parse(raw.proof), payload: {
            version: 1, machineId: proofBinding.machineId, installationId: proofBinding.installationId,
            accountId: 'owner', rpcAdmission: { context: proofBinding.admission, method: proofBinding.method,
              callerInputAuthorization: proofBinding.root, workspaceSyncSourceWriterTargetRouting: proofBinding.routing },
          } })).toBe(true);
        independentlyVerified = true;
        return homeAdmitted ? { status: 200, data: { v: 1, ok: true } }
          : { status: 403, data: { error: 'access_denied' } };
      } });
    if (!fixture.targetParent) throw new Error('Physical target Production owner was not composed');
    const operationId = 'original-source-physical-preflight';
    const sourceAdmission = { actorAccountId: 'borrower', custodianAccountId: 'owner', machineId: fixture.childRef.machineId,
      installationId: fixture.childInstallationId, role: 'use' as const, encryptionMode: 'plain' as const };
    const targetAdmission = { ...sourceAdmission, machineId: fixture.targetChildRef.machineId,
      installationId: fixture.targetChildInstallationId };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-original-source-preflight', binding: {
      accountId: 'borrower', principalId: 'borrower', credentialId: 'original-source-pat', grant: API_TOKEN_FULL_GRANT_V1,
      custodianAccountId: 'owner', serverIdentityId: fixture.serverId, machineId: sourceAdmission.machineId,
      installationId: sourceAdmission.installationId, actionId: 'session.handoff', requestId: operationId,
      requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: sourceAdmission.machineId },
      handoffAdmission: { sessionId: 'original-source-session', sourceMachineId: sourceAdmission.machineId,
        sourceInstallationId: sourceAdmission.installationId, targetMachineId: targetAdmission.machineId,
        targetInstallationId: targetAdmission.installationId },
    } });
    const source = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId,
      accountServerId: fixture.serverId, sourceMachineId: sourceAdmission.machineId,
      sourceRootPath: fixture.childRef.rootPath, sourceSessionId: 'original-source-session',
      sourceContext: { machineAdmission: sourceAdmission, callerAuthority: 'account_automation',
        callerInputConstraints: { models: null, permissionModes: null }, workspaceWrites: 'allow' } });
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1, sourceWriter: fixture.controller, source,
      target: { v: 1, phase: 'preflight', operationId, accountServerId: fixture.serverId,
        targetMachineId: targetAdmission.machineId, targetRootPath: fixture.targetChildRef.rootPath } });
    const installationId = fixture.managedTargetChild.controller.installationId;
    const method = `${fixture.targetRef.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
    proofBinding = { root, routing, admission: targetAdmission, machineId: fixture.targetRef.machineId, installationId, method };
    const rpc = new RpcHandlerManager({ scopePrefix: fixture.targetRef.machineId, localMachineId: fixture.targetRef.machineId,
      encryptionMode: 'plain', logger: () => {}, authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: fixture.targetRef.machineId, resolveCustodianAccountId: async () => 'owner', resolveInstallationId: () => installationId,
        verifyMachineAdmission: admitted => verifyMachineRpcAdmissionCurrent({ ...admitted,
          workspaceSyncSourceWriterTargetReceiver: { machineId: fixture.targetRef.machineId, installationId, accountId: 'owner' },
          privateKey: installedTarget.secretKey, daemonToken: fixture.credentials.token,
          serverHttpBaseUrl: 'https://bind-child-home.invalid' }),
      }) });
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: fixture.targetParent.workspaceSync });
    const params = { v: 1, operationId, serverId: fixture.serverId,
      machineId: targetAdmission.machineId, targetPath: fixture.targetChildRef.rootPath };
    const incoming = { method, params, machineAdmission: targetAdmission, callerInputAuthorization: root,
      callerAuthority: 'account_automation' as const, callerInputConstraints: source.sourceContext!.callerInputConstraints,
      workspaceSyncSourceWriterTargetRouting: routing };
    // No private requester snapshot is needed for this passive preflight. The real native mapper
    // must resolve D's root to P2 using only the admitted context derived after Home verification.
    const response = await rpc.handleRequest(incoming);
    expect(independentlyVerified).toBe(true);
    expect(response, `Physical preflight result: ${JSON.stringify(response)}`).toEqual({ type: 'not_required' });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const loan = await fixture.probeTarget();
    expect(loan).not.toHaveProperty('kind');
    if (!('kind' in loan)) await loan.release();
    expect(await rpc.handleRequest({ ...incoming, params: { ...params, targetPath: '/unrelated/target' } }))
      .toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    homeAdmitted = false;
    independentlyVerified = false;
    expect(await rpc.handleRequest(incoming)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(independentlyVerified).toBe(true);
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(fixture.sourcePath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    const deniedLoan = await fixture.probeTarget();
    expect(deniedLoan).not.toHaveProperty('kind');
    if (!('kind' in deniedLoan)) await deniedLoan.release();
    homeAdmitted = true;
    fixture.driftTargetNativeRoot();
    expect(await rpc.handleRequest(incoming)).toMatchObject({ errorCode: 'workspace_sync_child_unavailable' });
    await expect(stat(fixture.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains the approved child identity through physical replacement and refuses fresh native drift before replay', async () => {
    let phase = 'fixture composition';
    onTestFinished(() => {
      if (phase !== 'completed') console.error('Incomplete approved child replacement test', { phase });
    });
    const receiptId = 'bind-child-target-replacement-receipt';
    let approvalArtifact: ReturnType<typeof ApprovalRequestV2Schema.parse> | undefined;
    const fixture = await composeBindChildSourcePhaseTestRuntime({ socketIo, withScmRuntime: true,
      onCompositionPhase: current => { phase = current; },
      readAdditionalHttpResponse: async url => {
        if (!url.endsWith(`/v1/artifacts/${receiptId}`)) return undefined;
        if (!approvalArtifact) throw new Error('Replacement was requested before the executing approval existed');
        return { status: 200, data: {
          id: receiptId, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approvalArtifact)),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(approvalArtifact) }),
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2,
        } };
      },
    });
    if (fixture.projection.observation.storage.kind !== 'bind') throw new Error('Expected a native bind observation');
    // Both retained row and ordinary Machine publish this exact observed bind; the native probe shares it until explicit drift.
    fixture.projection.observation.storage.hostPath = fixture.targetPath;
    await mkdir(fixture.targetPath);
    await writeFile(join(fixture.targetPath, 'existing.txt'), 'reviewed child target contents');
    const operationId = 'bind-child-target-replacement';
    const originalActionInput = {
      sessionId: 'source-session-for-target-review', targetMachineId: fixture.childRef.machineId,
      targetPath: fixture.childRef.rootPath, workspaceAction: fixture.prepareInput.action,
    };
    const preflightInput = { v: 1 as const, serverId: fixture.serverId, machineId: fixture.childRef.machineId,
      targetPath: fixture.childRef.rootPath, operationId, destinationIntent: 'materialize_from_source_workspace' as const };
    phase = 'replacement preflight';
    const preflight = await fixture.parent.workspaceSync.preflightHandoffTargetReplacement(preflightInput);
    expect(preflight).toMatchObject({ type: 'approval_required', approval: {
      machineId: fixture.childRef.machineId, canonicalRoot: fixture.childRef.rootPath,
      serverId: fixture.serverId, operationId, consequences: ['replace_nonempty_workspace_target'],
    } });
    if (preflight.type !== 'approval_required') throw new Error('Existing child target must require replacement approval');
    expect(preflight.approval.rootFingerprint).toBe(await computeWorkspaceSyncRootFingerprint(fixture.targetPath));
    approvalArtifact = ApprovalRequestV2Schema.parse({
      v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'cli' },
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        serverId: fixture.serverId, sessionId: originalActionInput.sessionId, machineId: fixture.sourceRef.machineId,
        actionId: 'session.handoff', requestId: operationId },
      approval: { flow: 'deferred', result: 'required' }, actionId: 'session.handoff', actionArgs: originalActionInput,
      summary: 'Replace the reviewed child workspace', handoffTargetReplacementApproval: preflight.approval,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const prepareInput = { operationId, accountServerId: fixture.serverId, action: fixture.prepareInput.action,
      sourceMachineId: fixture.sourceRef.machineId, sourceWorkspaceRefId: fixture.sourceRef.id, sourceRootPath: fixture.sourcePath,
      targetMachineId: fixture.childRef.machineId, targetWorkspaceRefId: fixture.childRef.id, targetRootPath: fixture.childRef.rootPath,
      targetReplacementApproval: preflight.approval, targetReplacementApprovalReceiptId: receiptId,
      targetReplacementApprovalActionInput: originalActionInput };
    // Real parent preparation supplies source custody/seed authorization and consumes the unchanged child receipt at its target owner.
    phase = 'approved replacement preparation';
    const prepared = await fixture.parent.handoffAdapter.prepare(prepareInput);
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
    await expect(readFile(join(fixture.targetPath, 'existing.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    phase = 'approved replacement finalization';
    await fixture.parent.handoffAdapter.finalize({ operationId, prepared });
    phase = 'approved replacement commit';
    await fixture.parent.handoffAdapter.commit({ operationId, prepared });
    expect(approvalArtifact.actionArgs).toEqual(originalActionInput);
    expect(approvalArtifact.handoffTargetReplacementApproval).toEqual(preflight.approval);
    const installedContents = await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8');
    fixture.driftNativeRoot();
    phase = 'native drift preflight refusal';
    await expect(fixture.parent.workspaceSync.preflightHandoffTargetReplacement(preflightInput))
      .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    phase = 'native drift replay refusal';
    await expect(fixture.parent.handoffAdapter.prepare(prepareInput))
      .rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
    expect(await readFile(join(fixture.targetPath, 'payload.txt'), 'utf8')).toBe(installedContents);
    await expect(readFile(join(fixture.targetPath, 'existing.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    phase = 'completed';
  });
});

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

describe('private requester finite target bootstrap', () => {
  it('uses current requester rows for local READY custody without replacing the daemon snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-private-sync-target-'));
    const sourceRoot = join(root, 'source'); const targetRoot = join(root, 'target');
    await mkdir(sourceRoot); await mkdir(targetRoot);
    const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
    const ref = (id: string, rootPath: string) => ({ id, serverId: 'server-1', machineId: 'machine-b', rootPath, createdAtMs: 1 });
    const aliceRef = ref('alice-target', targetRoot);
    const sourceRef = ref('bob-source', sourceRoot); const targetRef = ref('bob-target', targetRoot);
    const rows = (refs: readonly ReturnType<typeof ref>[]) => refs.map(value => {
      const key = { kind: 'workspace-ref' as const, serverId: value.serverId, id: value.id };
      return { key, revision: 0, content: cipher.seal({ key, value }) };
    });
    const aliceToken = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
      expect(url).toBe('https://home.test/v1/account/project-rows/list');
      const isRequester = config?.headers?.['x-requester-proof'] === 'bob';
      if (isRequester) expect(config?.headers).not.toHaveProperty('Authorization');
      else expect(config?.headers).toMatchObject({ Authorization: `Bearer ${aliceToken}` });
      return { status: 200, data: { status: 'listed', coverage: 'complete', rows: rows(isRequester ? [sourceRef, targetRef] : [aliceRef]) } };
    });
    await runWithServerHttpBaseUrl('https://home.test', () => readProjectAccountRows({ credentials: { token: aliceToken, encryption: null }, serverId: 'server-1' }));
    let current = true;
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-project-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home-identity',
      machineId: 'machine-b', custodianAccountId: 'alice', installationId: 'target-installation', actionId: 'projects.open',
      requestId: 'private-target-open', requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'machine-b' }, accountEncryptionMode: 'plain',
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: 'server-1', accountEncryptionMode: 'plain',
      projectAccountRowCipher: cipher, isCurrent: async () => current, readArtifact: async () => null } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: 'server-1', serverIdentityId: 'home-identity',
      serverHttpBaseUrl: 'https://home.test', accountEncryptionMode: 'plain', isCurrent: async () => current,
      createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
    const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation', callerInputAuthorization: authorization,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine-b', installationId: 'target-installation',
        role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const authority = createWorkspaceSyncTargetAuthority({ localServerId: 'server-1', localMachineId: 'machine-b',
      refreshProjectSnapshot: signal => readProjectAccountRows({ authorization, effectActionId: 'projects.open', serverId: 'server-1', signal }),
      callMachineRpc: async () => { throw new Error('This local READY must not use another Machine'); },
      bootstrap: { materializationDirectory: join(root, 'materialization'), rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory: join(root, 'locks') }) } });
    onTestFinished(async () => { await authority.releaseAllRetainedBootstraps(); withdrawActiveProjectAccountRowsSnapshot();
      get.mockRestore(); post.mockRestore(); await rm(root, { recursive: true, force: true }); });
    const request = { v: 1 as const, bootstrapOperationId: 'private-target-open',
      owner: { kind: 'copy_once' as const, operation: { v: 1 as const, operationId: 'private-target-open', controllerMachineId: 'machine-b',
        alphaWorkspaceRefId: sourceRef.id, betaWorkspaceRefId: targetRef.id, contentPolicy } }, targetMachineId: 'machine-b',
      targetWorkspaceRefId: targetRef.id, endpointRole: 'beta' as const, policyDigest: contentPolicy.policyDigest,
      createIfMissing: true, targetBootstrap: 'use_existing' as const };
    const prepare: (request: Parameters<typeof authority.prepareBootstrapAtTarget>[0], context?: RpcHandlerContext)
      => ReturnType<typeof authority.prepareBootstrapAtTarget> = authority.prepareBootstrapAtTarget;
    expect(await prepare(request, context)).toMatchObject({ state: 'ready', targetWorkspaceRefId: targetRef.id });
    expect(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([aliceRef]);
    current = false;
    await expect(prepare({ ...request, bootstrapOperationId: 'retired-target-open' }, context)).rejects.toMatchObject({ code: 'project_requester_authority_unavailable' });
    expect(await authority.releaseBootstrapAtTarget({ v: 1, bootstrapOperationId: request.bootstrapOperationId,
      targetMachineId: 'machine-b', targetWorkspaceRefId: targetRef.id, reason: 'copy_committed' }, context))
      .toEqual({ ok: true, released: true });
  });
});
const gitContentPolicyInput = {
  ...contentPolicyInput,
  selection: 'git_worktree' as const,
};
const gitContentPolicy = {
  ...gitContentPolicyInput,
  policyDigest: computeWorkspaceSyncPolicyDigest(gitContentPolicyInput),
};

function snapshot(
  alphaRoot: string,
  betaRoot: string,
  options: Readonly<{
    relationshipEnabled?: boolean;
    includeRelationship?: boolean;
    mode?: 'keep_synced' | 'mirror_exactly' | 'keep_both_in_sync';
    betaServerId?: string;
    betaMachineId?: string;
    extraRefs?: ReadonlyArray<{ id: string; machineId: string; rootPath: string }>;
    contentPolicy?: typeof contentPolicy | typeof gitContentPolicy;
  }> = {},
): ActiveProjectAccountRowsSnapshot {
  const relationshipEnabled = options.relationshipEnabled ?? true;
  const includeRelationship = options.includeRelationship ?? true;
  return {
    source: 'network',
    workspaceRefs: [
        { id: 'workspace-alpha', serverId: 'server-1', machineId: 'machine-a', rootPath: alphaRoot, createdAtMs: 1 },
        { id: 'workspace-beta', serverId: options.betaServerId ?? 'server-1', machineId: options.betaMachineId ?? 'machine-b', rootPath: betaRoot, createdAtMs: 1 },
        ...(options.extraRefs ?? []).map((ref) => ({ serverId: 'server-1', createdAtMs: 1, ...ref })),
      ],
    relationships: includeRelationship ? [{
        v: 1,
        relationshipId,
        controllerMachineId: 'machine-a',
        alphaWorkspaceRefId: 'workspace-alpha',
        betaWorkspaceRefId: 'workspace-beta',
        mode: options.mode ?? 'keep_both_in_sync',
        contentPolicy: options.contentPolicy ?? contentPolicy,
        enabled: relationshipEnabled,
        createdAtMs: 1,
        updatedAtMs: 1,
      }] : [],
    graphRevision: 1,
    organizations: [],
    rows: [],
    loadedAtMs: 1,
    scopeKey: 'account-1',
  };
}

type AuthorityHarness = Readonly<{
  authority: ReturnType<typeof createWorkspaceSyncTargetAuthority>;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  materializationDirectory: string;
  resolutionDirectory: string;
  lockDirectory: string;
  cleanup(): Promise<void>;
}>;

let harnessCounter = 0;

describe('current child storage at the Sync authority', () => {
  it('requires passive native presence before flushing the parent writer despite unchanged retained Machine facts', async () => {
    const homeId = 'srv_sync_native_home';
    const child = { id: 'child-workspace', serverId: homeId, machineId: 'child', rootPath: '/child/project', createdAtMs: 1 };
    const observation = { nativeResourceId: 'native-current', user: 'coder', workspaceFolder: child.rootPath,
      storage: { kind: 'bind' as const, hostPath: '/parent/project', childPath: child.rootPath } };
    const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const, parentMachineId: 'machine-a' }, observation };
    const retained: ManagedMachineV1 = { id: 'managed-child', homeId, custodianAccountId: 'account',
      controller: { machineId: 'machine-a', installationId: 'parent-installation' },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, value: {}, devcontainerObservation: observation },
      allocation: 'bound', creationState: 'active', enrolledMachineId: 'child', desired: 'start', desiredWhen: 'now', intentRevision: 1,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
    let nativeAvailability: 'present' | 'absent' | 'unavailable' = 'present';
    let inspectedObservation = observation;
    const nativeCalls: unknown[] = [];
    socketIo.mockImplementation(() => createApiSessionSocketStub({ emitWithAck: async (_event, payload) => {
      if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Invalid RPC boundary');
      const content = { mode: 'plain' as const };
      const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
      nativeCalls.push({ method: payload.method, params: decoded.params });
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, { machine: { ...retained,
        resource: { ...retained.resource!, devcontainerObservation: inspectedObservation },
        observation: { availability: nativeAvailability, observedAt: 1 } } }, decoded.callId) };
    } }));
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const id = url.slice(url.lastIndexOf('/') + 1);
      return { status: 200, data: { machine: { id, active: true,
        devcontainerChild: id === 'child' ? projection : null,
        installationId: id === 'machine-a' ? 'parent-installation' : `${id}-installation`,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/coder', username: 'coder',
          happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier', ...(id === 'child' ? { devcontainerChild: projection } : {}) }) } } };
    });
    const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (url.endsWith('/machines/managed/actions/get')) return { status: 200, data: retained };
      throw new Error(`Unexpected boundary: ${url}`);
    });
    const initial = snapshot('/parent/project', '/peer/project');
    const current = { ...initial, workspaceRefs: initial.workspaceRefs.map(ref => ({ ...ref, serverId: homeId })) };
    const homeObservation = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== 'https://home.example/v1/features') throw new Error(`Unexpected Home boundary: ${url}`);
      return new Response(JSON.stringify({ features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const flushed: string[] = [];
    const input = { serverId: homeId, sourceWorkspaceRefId: child.id, targetWorkspaceRefId: 'workspace-beta',
      readCurrent: async () => ({ workspaceRefs: [...current.workspaceRefs, child], relationships: current.relationships,
        childMachines: await readWorkspaceSyncChildMachineFacts({ serverId: homeId, serverHttpBaseUrl: 'https://home.example',
          localProfileId: 'native-test-profile',
          credentials: { token: 'token', encryption: null }, machineIds: ['child', 'machine-b'] }) }),
      flush: async (id: string) => { flushed.push(id); return { relationshipId: id, controllerMachineId: 'machine-a', state: 'watching' as const,
        alphaPath: '/parent/project', betaPath: '/peer/project', mode: 'keep_both_in_sync' as const, conflictCount: 0, lastCycleObservedAtMs: null,
        endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 },
          beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } } }; } };
    try {
      await expect(prepareWorkspaceSyncBetween(input)).resolves.toMatchObject({ ok: true, traversed: [{ relationshipId }] });
      expect(flushed).toEqual([relationshipId]);
      for (const unavailable of ['absent', 'unavailable'] as const) {
        nativeAvailability = unavailable;
        flushed.length = 0;
        await expect(prepareWorkspaceSyncBetween(input)).rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
        expect(flushed).toEqual([]);
      }
      nativeAvailability = 'present';
      inspectedObservation = { ...observation, nativeResourceId: 'external-replacement' };
      await expect(prepareWorkspaceSyncBetween(input)).rejects.toMatchObject({ code: 'workspace_sync_child_unavailable' });
      expect(flushed).toEqual([]);
      expect(nativeCalls).toEqual(expect.arrayContaining([expect.objectContaining({ method: 'machine-a:machines.managed.inspect',
        params: { homeId, managedId: 'managed-child' } })]));
    } finally { get.mockRestore(); post.mockRestore(); homeObservation.mockRestore(); socketIo.mockReset(); }
  });
});

describe('committed-copy retirement at the target authority', () => {
  it.each(['initial', 'rehydrate'] as const)('does not abort or relabel an interrupted ordinary materialization when Home rows claim worker creation (%s)', async phase => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'interrupted-ordinary-worker-copy-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    const ordinary = snapshot(source, target, { relationshipEnabled: phase === 'rehydrate' });
    const marked = { ...ordinary.relationships[0]!, provenance: {
      kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta',
    } };
    const current: ActiveProjectAccountRowsSnapshot = { ...ordinary, relationships: [marked] };
    const receiver = createAuthorityHarness({ getProjectSnapshot: () => current, materializeRemoteSeed: false });
    try {
      await mkdir(receiver.materializationDirectory, { recursive: true });
      const receiptPath = workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'beta');
      const pending = await beginWorkspaceTargetMaterialization({ targetPath: target,
        backupDirectoryPrefix: '.happier-sync-backup', receiptPath });
      await mkdir(target);
      await writeFile(join(target, 'pending.txt'), 'ordinary pending bytes');
      await pending.custody.bindPromotedTarget();
      const receiptBytes = await readFile(receiptPath, 'utf8');
      const request = phase === 'initial'
        ? prepareRequest({ transientRelationship: { ...marked, enabled: true } })
        : prepareRequest({ transientRelationship: undefined, targetBootstrap: undefined });
      const failure = await receiver.authority.prepareBootstrapHere(request).catch((error: unknown) => error);
      expect(await readFile(join(target, 'pending.txt'), 'utf8')).toBe('ordinary pending bytes');
      expect(await readFile(receiptPath, 'utf8')).toBe(receiptBytes);
      if (phase === 'initial') expect(failure).toMatchObject({ code: 'workspace_copy_not_worker' });
      else expect(failure).toBeInstanceOf(Error);
    } finally {
      await receiver.authority.releaseAllRetainedBootstraps();
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it.each(['stored', 'transient'] as const)('records original worker-copy creation only from current Home rows and retains it on recovery (%s)', async markerOrigin => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'worker-copy-creation-receipt-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    const ordinary = snapshot(source, target, { relationshipEnabled: false });
    const marked = { ...ordinary.relationships[0]!, provenance: {
      kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta',
    } };
    let current: ActiveProjectAccountRowsSnapshot = { ...ordinary,
      relationships: markerOrigin === 'stored' ? [marked] : ordinary.relationships };
    const receiver = createAuthorityHarness({ getProjectSnapshot: () => current, materializeRemoteSeed: false });
    try {
      // A missing all-files target is physically created by the actual target custodian;
      // the OS write below stands for content arriving through the subsequent Sync flush.
      const prepared = await receiver.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: { ...marked, enabled: true },
      }));
      await writeFile(join(target, 'copy.txt'), 'created copy');
      // Controller commit enables the already-staged row, without adding provenance.
      current = { ...current, relationships: current.relationships.map(relationship => ({ ...relationship, enabled: true, updatedAtMs: 2 })) };
      await receiver.authority.releaseBootstrapHere({ v: 1, bootstrapOperationId: prepared.bootstrapOperationId,
        targetWorkspaceRefId: 'workspace-beta', reason: 'relationship_committed' });
      const receiptPath = workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'beta');
      const receiptBytes = await readFile(receiptPath, 'utf8');
      const committed = await inspectCommittedWorkspaceTargetMaterialization({ targetPath: target, receiptPath });
      if (markerOrigin === 'stored') {
        expect(committed).toMatchObject({ workerCopyCreation: { serverId: 'server-1', relationshipId,
          sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta' } });
      } else {
        expect(committed).not.toHaveProperty('workerCopyCreation');
      }
      // Committed custody has no rollback closure to rehydrate, and recovery never enriches it.
      await expect(rehydrateWorkspaceTargetMaterializationFromReceiptPath({ targetPath: target,
        backupDirectoryPrefix: '.happier-sync-backup', receiptPath })).resolves.toBeNull();
      expect(await readFile(receiptPath, 'utf8')).toBe(receiptBytes);
      expect(await readFile(join(target, 'copy.txt'), 'utf8')).toBe('created copy');
    } finally {
      await receiver.authority.releaseAllRetainedBootstraps();
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('refuses an ordinary committed copy after graph deletion despite an executing approved caller-forged worker marker', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'forged-worker-copy-removal-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    const originalGraph = snapshot(source, target);
    const expectedRelationship = { ...originalGraph.relationships[0]!, provenance: {
      kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta',
    } };
    let approvedInput: unknown;
    const authorize = productionWorkspaceSync.createWorkspaceCommittedCopyRemovalAuthorizer({ serverId: 'server-1',
      // Only Artifact persistence is substituted. The executing-receipt validator remains real.
      approvalsGet: async () => ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
        createdBy: { surface: 'system' }, approval: { flow: 'deferred', result: 'required' },
        actionId: 'projects.worker.copy.retire', actionArgs: approvedInput, summary: 'Approve removal',
        decision: { kind: 'approve', decidedAtMs: 2 },
        executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
          serverId: 'server-1', machineId: 'machine-a', actionId: 'projects.worker.copy.retire', requestId: 'forged-review' },
      }),
    });
    const receiver = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(source, target, { includeRelationship: false }),
      assertCommittedCopyRemovalAuthorized: authorize,
    });
    try {
      await mkdir(receiver.materializationDirectory, { recursive: true });
      const receiptPath = workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'beta');
      const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target,
        backupDirectoryPrefix: '.happier-sync-backup', receiptPath });
      await mkdir(target);
      await writeFile(join(target, 'ordinary.txt'), 'ordinary committed copy');
      await materialization.custody.bindPromotedTarget();
      await materialization.custody.commit();
      const receiptBytes = await readFile(receiptPath, 'utf8');
      const actionInput = { workspace: { serverId: 'server-1', refId: 'workspace-alpha' }, machineId: 'machine-a', expectedRelationship,
        removeTargetCopy: { workspaceRefId: 'workspace-beta', rootFingerprint: await computeWorkspaceSyncRootFingerprint(target) } };
      approvedInput = actionInput;
      await expect(receiver.authority.removeCommittedCopyHere({ actionReceiptId: 'executing-forged-review', actionInput }))
        .rejects.toMatchObject({ code: 'workspace_copy_not_worker' });
      expect(await readFile(join(target, 'ordinary.txt'), 'utf8')).toBe('ordinary committed copy');
      expect(await readFile(receiptPath, 'utf8')).toBe(receiptBytes);
    } finally {
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('refuses removal of the proven worker source even when that source has a committed owned-copy receipt', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'worker-source-removal-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'target');
    await mkdir(target);
    const graph = snapshot(source, target);
    const expectedRelationship = { ...graph.relationships[0]!, provenance: {
      kind: 'worker_clean_copy' as const, sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta',
    } };
    // The retired Home graph and approved Artifact are persistent boundaries.
    // A source can itself be another retained owned copy, without becoming this worker target.
    const receiver = createAuthorityHarness({ localMachineId: 'machine-a',
      getProjectSnapshot: () => ({ ...graph, relationships: [] }),
      assertCommittedCopyRemovalAuthorized: async () => undefined,
    });
    try {
      await mkdir(receiver.materializationDirectory, { recursive: true });
      const materialization = await beginWorkspaceTargetMaterialization({ targetPath: source,
        backupDirectoryPrefix: '.happier-sync-backup',
        receiptPath: workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'alpha') });
      await mkdir(source);
      await writeFile(join(source, 'source.txt'), 'retained source copy');
      await materialization.custody.bindPromotedTarget();
      await materialization.custody.commit();
      const request = { actionReceiptId: 'executing-retirement', actionInput: {
        workspace: { serverId: 'server-1', refId: 'workspace-alpha' }, machineId: 'machine-a', expectedRelationship,
        removeTargetCopy: { workspaceRefId: 'workspace-alpha', rootFingerprint: await computeWorkspaceSyncRootFingerprint(source) },
      } };
      await expect(receiver.authority.removeCommittedCopyHere(request)).rejects.toMatchObject({ code: 'workspace_unavailable' });
      expect(await readFile(join(source, 'source.txt'), 'utf8')).toBe('retained source copy');
    } finally {
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not treat a committed ordinary Sync receipt as worker-copy removal authority', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'ordinary-sync-removal-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    let current = snapshot(source, target);
    const expectedRelationship = current.relationships[0]!;
    const receiver = createAuthorityHarness({ getProjectSnapshot: () => current,
      // Artifact persistence may still hold an executing receipt from before this guard.
      assertCommittedCopyRemovalAuthorized: async () => undefined,
    });
    try {
      await mkdir(receiver.materializationDirectory, { recursive: true });
      const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target,
        backupDirectoryPrefix: '.happier-sync-backup',
        receiptPath: workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'beta') });
      await mkdir(target);
      await writeFile(join(target, 'ordinary.txt'), 'ordinary Sync bytes');
      await materialization.custody.bindPromotedTarget();
      await materialization.custody.commit();
      const request = { actionReceiptId: 'older-executing-retirement', actionInput: {
        workspace: { serverId: 'server-1', refId: 'workspace-beta' }, machineId: 'machine-a', expectedRelationship,
        removeTargetCopy: { workspaceRefId: 'workspace-beta', rootFingerprint: await computeWorkspaceSyncRootFingerprint(target) },
      } };
      await expect(receiver.authority.inspectCommittedCopyHere(request)).rejects.toMatchObject({ code: 'workspace_copy_not_worker' });
      current = snapshot(source, target, { includeRelationship: false });
      await expect(receiver.authority.removeCommittedCopyHere(request)).rejects.toMatchObject({ code: 'workspace_copy_not_worker' });
      expect(await readFile(join(target, 'ordinary.txt'), 'utf8')).toBe('ordinary Sync bytes');
    } finally {
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('refreshes Home rows before preview and before disclosure instead of trusting an unchanged cached relationship', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-copy-preview-rows-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    const cached = snapshot(source, target);
    const changed = { ...cached, relationships: [{ ...cached.relationships[0]!, updatedAtMs: 2 }] };
    // The Home row-read boundary and the daemon's cached snapshot are deliberately
    // independent: a retired relationship must not remain readable from old cache.
    let homeAnswers: ActiveProjectAccountRowsSnapshot[] = [changed];
    const receiver = createAuthorityHarness({ getProjectSnapshot: () => cached,
      refreshProjectSnapshot: async () => homeAnswers.shift() ?? changed,
    });
    const request = { kind: 'preview' as const, workspace: { serverId: 'server-1', refId: 'workspace-alpha' },
      machineId: 'machine-a', expectedRelationship: cached.relationships[0]!,
      targetMachineId: 'machine-b', targetWorkspaceRefId: 'workspace-beta' };
    try {
      await mkdir(receiver.materializationDirectory, { recursive: true });
      const receiptPath = workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'beta');
      const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target,
        backupDirectoryPrefix: '.happier-sync-backup', receiptPath });
      await mkdir(target);
      await writeFile(join(target, 'copy.txt'), 'owned copy');
      await materialization.custody.bindPromotedTarget();
      await materialization.custody.commit();
      const receiptBytes = await readFile(receiptPath, 'utf8');
      await expect(receiver.authority.previewCommittedCopyHere(request))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      homeAnswers = [cached, changed];
      await expect(receiver.authority.previewCommittedCopyHere(request))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      expect(await readFile(receiptPath, 'utf8')).toBe(receiptBytes);
      expect(await readFile(join(target, 'copy.txt'), 'utf8')).toBe('owned copy');
    } finally {
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('discovers the owned-copy review fingerprint through current personal ingress without an approval or filesystem writes', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-copy-preview-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    let current = snapshot(source, target);
    let credentialCurrent = true;
    let retireDuringRead = false;
    const receiver = createAuthorityHarness({ getProjectSnapshot: () => {
      // The Project row persistence boundary may settle after this runtime's credential retires.
      if (retireDuringRead) credentialCurrent = false;
      return current;
    } });
    const credentials = { token: [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url'),
      'fixture-signature',
    ].join('.'), encryption: null };
    const machineAdmission = { actorAccountId: 'account-1', custodianAccountId: 'account-1', machineId: 'machine-b',
      installationId: 'target-installation', role: 'manage' as const, encryptionMode: 'plain' as const };
    let ingressCurrent = true;
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-b', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, {
        machineId: 'machine-b', resolveCustodianAccountId: async () => 'account-1',
        resolveInstallationId: () => 'target-installation',
        // Current Home access verification is the genuine external boundary.
        verifyMachineAdmission: async () => ingressCurrent,
      }),
    });
    const service = {
      inspectCommittedCopyHere: async (request, signal, context) => {
        if (!('kind' in request)) throw new Error('Preview fixture never executes an approved removal');
        const assertCurrent = async () => await productionWorkspaceSync.assertCurrentPersonalWorkspaceCopyPreview({
          request, context, serverId: 'server-1', machineId: 'machine-b', credentials,
          isCurrent: async () => credentialCurrent,
        });
        await assertCurrent();
        const result = await receiver.authority.previewCommittedCopyAtTarget({ ...request, ...(signal ? { signal } : {}) });
        await assertCurrent();
        return result;
      },
    } satisfies Pick<MachineWorkspaceSyncRpcService, 'inspectCommittedCopyHere'>;
    // Only transport and persistent rows are fixtures: manager, authorization, registration,
    // runtime guard, target resolution, receipt verification and filesystem identity are real.
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager: rpc, service: service as MachineWorkspaceSyncRpcService });
    const request = { kind: 'preview' as const, workspace: { serverId: 'server-1', refId: 'workspace-alpha' },
      machineId: 'machine-a', expectedRelationship: current.relationships[0]!,
      targetMachineId: 'machine-b', targetWorkspaceRefId: 'workspace-beta' };
    const inspect = (params: unknown = request, admission = machineAdmission) => rpc.handleRequest({
      method: `machine-b:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params, machineAdmission: admission,
    });
    try {
      await mkdir(receiver.materializationDirectory, { recursive: true });
      const receiptPath = workspaceSyncMaterializationReceiptPath(receiver.materializationDirectory, relationshipId, 'beta');
      const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target,
        backupDirectoryPrefix: '.happier-sync-backup', receiptPath });
      await mkdir(target);
      await writeFile(join(target, 'copy.txt'), 'owned copy');
      await materialization.custody.bindPromotedTarget();
      await materialization.custody.commit();
      const receiptBytes = await readFile(receiptPath, 'utf8');
      const fingerprint = await computeWorkspaceSyncRootFingerprint(target);
      await mkdir(join(target, '.cache', 'compiler'), { recursive: true });
      await writeFile(join(target, '.cache', 'compiler', 'warm.bin'), Buffer.alloc(17));
      const outside = join(fixture, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'private.bin'), Buffer.alloc(4096));
      await symlink(outside, join(target, 'outside-directory'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(inspect()).resolves.toEqual({ ok: true, preview: {
        targetMachineId: 'machine-b', workspaceRefId: 'workspace-beta', rootFingerprint: fingerprint, sizeBytes: 27,
      } });
      await expect(inspect(request, { ...machineAdmission, actorAccountId: 'foreign-account' }))
        .resolves.toMatchObject({ errorCode: 'forbidden' });
      await expect(rpc.handleRequest({ method: `machine-b:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`, params: request }))
        .resolves.toMatchObject({ errorCode: 'forbidden' });
      ingressCurrent = false;
      await expect(inspect()).resolves.toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      ingressCurrent = true;
      retireDuringRead = true;
      await expect(inspect()).resolves.toMatchObject({ errorCode: 'forbidden' });
      retireDuringRead = false;
      credentialCurrent = true;
      await expect(inspect({ ...request, workspace: { ...request.workspace, serverId: 'other-home' } }))
        .resolves.toMatchObject({ errorCode: 'forbidden' });
      await expect(inspect({ ...request, targetMachineId: 'other-machine' })).resolves.toMatchObject({ errorCode: 'forbidden' });
      await expect(inspect({ ...request, targetWorkspaceRefId: 'workspace-alpha' })).resolves.toMatchObject({ errorCode: 'root_mismatch' });
      current = { ...current, relationships: [{ ...request.expectedRelationship, updatedAtMs: 2 }] };
      await expect(inspect()).resolves.toMatchObject({ errorCode: 'bootstrap_definition_conflict' });
      current = snapshot(source, target);
      // A directory alone is not owned evidence; removing the fixture receipt must not
      // cause the read to mint another receipt or compute an unowned fingerprint.
      const retainedReceiptPath = join(receiver.materializationDirectory, 'retained-receipt.json');
      await rename(receiptPath, retainedReceiptPath);
      await expect(inspect()).resolves.toEqual({ ok: false, errorCode: 'workspace_copy_not_owned' });
      await expect(stat(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await rename(retainedReceiptPath, receiptPath);
      await expect(readFile(receiptPath, 'utf8')).resolves.toBe(receiptBytes);
      await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('owned copy');
      await rename(target, join(fixture, 'retained-copy'));
      await mkdir(target);
      await writeFile(join(target, 'user.txt'), 'replacement user root');
      await expect(inspect()).resolves.toMatchObject({ errorCode: 'workspace_target_materialization_manual_recovery' });
      await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('replacement user root');
      await expect(readFile(join(fixture, 'retained-copy', 'copy.txt'), 'utf8')).resolves.toBe('owned copy');
      await expect(readFile(receiptPath, 'utf8')).resolves.toBe(receiptBytes);
      expect(await readdir(receiver.lockDirectory).catch(() => [])).toEqual([]);
    } finally {
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('routes reviewed removal to the physical target and refuses an unapproved receipt before changing bytes', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-target-authority-route-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    const initialRows = snapshot(source, target, { relationshipEnabled: false });
    let current: ActiveProjectAccountRowsSnapshot = { ...initialRows, relationships: initialRows.relationships.map(relationship => ({
      ...relationship, provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta' },
    })) };
    const expectedRelationship = { ...current.relationships[0]!, enabled: true };
    const admission = createProjectWorkerAdmission({ machineId: 'machine-b', admissionDrain: createDaemonAdmissionDrain(),
      readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: 1 }, source: 'default', metadataVersion: 1 }),
    });
    let finishWork!: () => void;
    const processBoundary = new Promise<void>((resolve) => { finishWork = resolve; });
    let reserved!: () => void;
    const reservation = new Promise<void>((resolve) => { reserved = resolve; });
    const work = admission.execute({ operationId: 'dependent-copy', workspaceRefId: 'workspace-beta', relationshipId,
      signal: new AbortController().signal, accept: () => {}, onReserved: reserved,
      run: async () => { await processBoundary; return { kind: 'no_launch', result: { ok: true, result: null } }; },
    });
    const receiver = createAuthorityHarness({ getProjectSnapshot: () => current,
      materializeRemoteSeed: false,
      readCommittedCopyDependencies: async (input) => admission.dependencies({ workspaceRefId: input.removeTargetCopy?.workspaceRefId }),
      assertCommittedCopyRemovalAuthorized: async (receiptId) => {
        if (receiptId !== 'approved-retirement') throw Object.assign(new Error('Not approved'), { code: 'approval_required' });
      },
    });
    const handlers = new Map<string, (request: unknown, context?: RpcHandlerContext) => Promise<unknown>>();
    const rpcHandlerManager = { registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
      // Machine transport is the external boundary; every registered handler and target owner stays real.
      handlers.set(method, async (request, context) => await handler(request as TRequest, context));
    } } satisfies RpcHandlerRegistrar;
    const receiverService = {
      inspectCommittedCopyHere: async (request, signal) => {
        if ('kind' in request) throw new Error('This fixture only exercises approved removal');
        await receiver.authority.inspectCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) });
        return { ok: true as const };
      },
      removeCommittedCopyHere: async (request, signal) => {
        await receiver.authority.removeCommittedCopyHere({ ...request, ...(signal ? { signal } : {}) });
        return { ok: true as const };
      },
    } satisfies Pick<MachineWorkspaceSyncRpcService, 'inspectCommittedCopyHere' | 'removeCommittedCopyHere'>;
    // This ingress fixture binds only real target adapters; unrelated controller handlers are never invoked.
    registerMachineWorkspaceSyncRpcHandlers({ rpcHandlerManager, service: receiverService as MachineWorkspaceSyncRpcService });
    const controller = createAuthorityHarness({ localMachineId: 'machine-a', getProjectSnapshot: () => current,
      callMachineRpc: async ({ machineId, method, request, signal }) => {
        expect(machineId).toBe('machine-b');
        const handler = handlers.get(method);
        if (!handler) throw new Error('Receiver method not registered');
        return await handler(request, signal ? { signal } : undefined);
      },
    });
    try {
      const prepared = await receiver.authority.prepareBootstrapHere(prepareRequest({ transientRelationship: expectedRelationship }));
      await writeFile(join(target, 'copy.txt'), 'copy');
      current = { ...current, relationships: [expectedRelationship] };
      await receiver.authority.releaseBootstrapHere({ v: 1, bootstrapOperationId: prepared.bootstrapOperationId,
        targetWorkspaceRefId: 'workspace-beta', reason: 'relationship_committed' });
      const actionInput = { workspace: { serverId: 'server-1', refId: 'workspace-alpha' }, machineId: 'machine-a',
        expectedRelationship, removeTargetCopy: { workspaceRefId: 'workspace-beta', rootFingerprint: await computeWorkspaceSyncRootFingerprint(target) } };
      await reservation;
      await expect(controller.authority.inspectCommittedCopyAtTarget({ actionReceiptId: 'approved-retirement', actionInput }))
        .rejects.toMatchObject({ code: 'workspace_sync_relationship_in_use', dependencies: admission.dependencies() });
      await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('copy');
      finishWork();
      await work;
      await controller.authority.inspectCommittedCopyAtTarget({ actionReceiptId: 'approved-retirement', actionInput });
      current = snapshot(source, target, { includeRelationship: false });
      const forgedEnvelope = { actionReceiptId: 'approved-retirement', actionInput, workspaceRefId: 'workspace-alpha' };
      await expect(receiver.authority.removeCommittedCopyHere(forgedEnvelope))
        .rejects.toMatchObject({ name: 'ZodError' });
      await expect(controller.authority.removeCommittedCopyAtTarget({ actionReceiptId: 'forged', actionInput })).rejects.toMatchObject({ code: 'approval_required' });
      await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('copy');
      await controller.authority.removeCommittedCopyAtTarget({ actionReceiptId: 'approved-retirement', actionInput });
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(source)).resolves.toBeDefined();
    } finally {
      finishWork();
      await work;
      await controller.cleanup();
      await receiver.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('requires definition termination first and then removes the exact materialized copy through root custody', async () => {
    const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-target-authority-retirement-')));
    const source = join(fixture, 'source');
    const target = join(fixture, 'copy');
    await mkdir(source);
    const initialRows = snapshot(source, target, { relationshipEnabled: false });
    let current: ActiveProjectAccountRowsSnapshot = { ...initialRows, relationships: initialRows.relationships.map(relationship => ({
      ...relationship, provenance: { kind: 'worker_clean_copy', sourceWorkspaceRefId: 'workspace-alpha', targetWorkspaceRefId: 'workspace-beta' },
    })) };
    const expectedRelationship = { ...current.relationships[0]!, enabled: true };
    const harness = createAuthorityHarness({ getProjectSnapshot: () => current,
      materializeRemoteSeed: false,
      assertCommittedCopyRemovalAuthorized: async (receiptId) => {
        // Persisted Action-Artifact authorization is the genuine external boundary here.
        if (receiptId !== 'approved-retirement') throw Object.assign(new Error('Not approved'), { code: 'approval_required' });
      },
    });
    try {
      const prepared = await harness.authority.prepareBootstrapHere(prepareRequest({ transientRelationship: expectedRelationship }));
      await writeFile(join(target, 'copy.txt'), 'copy');
      current = { ...current, relationships: [expectedRelationship] };
      await harness.authority.releaseBootstrapHere({ v: 1, bootstrapOperationId: prepared.bootstrapOperationId,
        targetWorkspaceRefId: 'workspace-beta', reason: 'relationship_committed' });
      const request = { actionReceiptId: 'approved-retirement', actionInput: {
        workspace: { serverId: 'server-1', refId: 'workspace-alpha' }, machineId: 'machine-a', expectedRelationship,
        removeTargetCopy: { workspaceRefId: 'workspace-beta', rootFingerprint: await computeWorkspaceSyncRootFingerprint(target) },
      } };
      await harness.authority.inspectCommittedCopyHere(request);
      await expect(harness.authority.removeCommittedCopyHere(request)).rejects.toMatchObject({ code: 'workspace_root_in_use' });
      await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('copy');
      current = snapshot(source, target, { includeRelationship: false });
      await harness.authority.removeCommittedCopyHere(request);
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(source)).resolves.toBeDefined();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

function ownedRootedAgent(stream = new PassThrough()) {
  return {
    stream,
    stop: vi.fn(async () => { stream.destroy(); }),
  };
}

function createAuthorityHarness(options: Readonly<{
  localMachineId?: string;
  getProjectSnapshot: () => ActiveProjectAccountRowsSnapshot | null;
  refreshProjectSnapshot?: (signal?: AbortSignal) => Promise<ActiveProjectAccountRowsSnapshot>;
  callMachineRpc?: (input: Readonly<{ machineId: string; method: string; request: unknown; signal?: AbortSignal }>) => Promise<unknown>;
  openRootedAgent?: (input: Readonly<{ operationId: string; role: 'alpha' | 'beta'; workspaceRefId: string; canonicalRoot: string; signal?: AbortSignal }>) => Promise<ReturnType<typeof ownedRootedAgent>>;
  materializeRemoteSeed?: false | NonNullable<NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['bootstrap']>['materializeRemoteSeed']>;
  materializeLocalSeed?: NonNullable<NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['bootstrap']>['materializeLocalSeed']>;
  writeReadyFact?: NonNullable<NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['bootstrap']>['writeReadyFact']>;
  rehydrateMaterializationFromReceiptPath?: NonNullable<NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['bootstrap']>['rehydrateMaterializationFromReceiptPath']>;
  prepareGitTarget?: NonNullable<NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['bootstrap']>['prepareGitTarget']>;
  assertConflictResolutionAuthorized?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['assertConflictResolutionAuthorized']>;
  assertTargetReplacementAuthorized?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['assertTargetReplacementAuthorized']>;
  assertCommittedCopyRemovalAuthorized?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['assertCommittedCopyRemovalAuthorized']>;
  readCommittedCopyDependencies?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['readCommittedCopyDependencies']>;
  discoverConflictRecovery?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['discoverConflictRecovery']>;
  recoverConflictEntry?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['recoverConflictEntry']>;
  resolveLocalResolutionEndpoint?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['resolveLocalResolutionEndpoint']>;
  requestResolutionExport?: NonNullable<Parameters<typeof createWorkspaceSyncTargetAuthority>[0]['requestResolutionExport']>;
}>): AuthorityHarness {
  const suffix = `${process.pid}-${++harnessCounter}-${Math.random().toString(36).slice(2)}`;
  const materializationDirectory = join(tmpdir(), `workspace-sync-authority-staging-${suffix}`);
  const resolutionDirectory = join(tmpdir(), `workspace-sync-authority-resolution-${suffix}`);
  const lockDirectory = join(tmpdir(), `workspace-sync-authority-locks-${suffix}`);
  const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory });
  const admission = createProjectWorkerAdmission({ machineId: options.localMachineId ?? 'machine-b', admissionDrain: createDaemonAdmissionDrain(),
    readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default', metadataVersion: 1 }),
  });
  const authority = createWorkspaceSyncTargetAuthority({
    localServerId: 'server-1',
    localMachineId: options.localMachineId ?? 'machine-b',
    getProjectSnapshot: options.getProjectSnapshot,
    refreshProjectSnapshot: options.refreshProjectSnapshot ?? (async () => {
      const current = options.getProjectSnapshot();
      if (!current) throw new Error('Fixture Home rows are unavailable');
      return current;
    }),
    callMachineRpc: options.callMachineRpc ?? (async () => { throw new Error('unexpected machine RPC'); }),
    assertConflictResolutionAuthorized: options.assertConflictResolutionAuthorized ?? (async () => undefined),
    assertTargetReplacementAuthorized: options.assertTargetReplacementAuthorized ?? (async () => undefined),
    ...(options.assertCommittedCopyRemovalAuthorized ? { assertCommittedCopyRemovalAuthorized: options.assertCommittedCopyRemovalAuthorized } : {}),
    readCommittedCopyDependencies: options.readCommittedCopyDependencies ?? (async (input) => admission.dependencies({ workspaceRefId: input.removeTargetCopy?.workspaceRefId })),
    resolutionMaterialDirectory: resolutionDirectory,
    ...(options.discoverConflictRecovery ? { discoverConflictRecovery: options.discoverConflictRecovery } : {}),
    ...(options.recoverConflictEntry ? { recoverConflictEntry: options.recoverConflictEntry } : {}),
    ...(options.resolveLocalResolutionEndpoint ? { resolveLocalResolutionEndpoint: options.resolveLocalResolutionEndpoint } : {}),
    ...(options.requestResolutionExport ? { requestResolutionExport: options.requestResolutionExport } : {}),
    ...(options.openRootedAgent ? { openRootedAgent: options.openRootedAgent } : {}),
    bootstrap: {
      materializationDirectory,
      rootOwnershipManager,
      ...(options.materializeRemoteSeed === false
        ? {}
        : {
            materializeRemoteSeed: options.materializeRemoteSeed ?? (async () => ({
              receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null },
              bindPromotedTarget: async () => undefined,
              commit: async () => undefined,
              abort: async () => undefined,
            })),
          }),
      ...(options.materializeLocalSeed ? { materializeLocalSeed: options.materializeLocalSeed } : {}),
      ...(options.writeReadyFact ? { writeReadyFact: options.writeReadyFact } : {}),
      ...(options.rehydrateMaterializationFromReceiptPath
        ? { rehydrateMaterializationFromReceiptPath: options.rehydrateMaterializationFromReceiptPath }
        : {}),
      ...(options.prepareGitTarget ? { prepareGitTarget: options.prepareGitTarget } : {}),
    },
  });
  return {
    authority,
    rootOwnershipManager,
    materializationDirectory,
    resolutionDirectory,
    lockDirectory,
    cleanup: async () => {
      await rm(materializationDirectory, { recursive: true, force: true });
      await rm(resolutionDirectory, { recursive: true, force: true });
      await rm(lockDirectory, { recursive: true, force: true });
    },
  };
}

function prepareRequest(overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    bootstrapOperationId: relationshipId,
    owner: { kind: 'relationship' as const, relationshipId },
    transientRelationship: {
      v: 1 as const, relationshipId, controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta',
      mode: 'keep_both_in_sync' as const, contentPolicy, enabled: true,
      createdAtMs: 1, updatedAtMs: 1,
    },
    targetWorkspaceRefId: 'workspace-beta',
    endpointRole: 'beta' as const,
    policyDigest: contentPolicy.policyDigest,
    createIfMissing: true,
    targetBootstrap: 'materialize_from_source_workspace' as const,
    ...overrides,
  };
}

function copyOncePrepareRequest(overrides: Record<string, unknown> = {}) {
  return prepareRequest({
    bootstrapOperationId: 'bootstrap-op-1',
    transientRelationship: undefined,
    owner: {
      kind: 'copy_once' as const,
      operation: {
        v: 1,
        operationId: 'copy-op-1',
        controllerMachineId: 'machine-a',
        alphaWorkspaceRefId: 'workspace-alpha',
        betaWorkspaceRefId: 'workspace-beta',
        contentPolicy,
      },
    },
    targetBootstrap: 'materialize_from_source_workspace',
    ...overrides,
  });
}

function existingRelationshipPrepareRequest(overrides: Record<string, unknown> = {}) {
  return prepareRequest({
    bootstrapOperationId: 'existing-handoff',
    transientRelationship: undefined,
    targetBootstrap: undefined,
    ...overrides,
  });
}

async function approvedPrepareRequest(
  harness: AuthorityHarness,
  targetPath: string,
  overrides: Record<string, unknown> = {},
) {
  const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
    v: 1,
    serverId: 'server-1',
    machineId: 'machine-b',
    operationId: handoffOperationId,
    targetPath,
  });
  if (preflight.type !== 'approval_required') throw new Error('expected target replacement approval');
  return prepareRequest({
    ...approvalBinding(preflight.approval),
    ...overrides,
  });
}

function approvalBinding(approval: import('@happier-dev/protocol').HandoffTargetReplacementApprovalV1) {
  return {
    targetReplacementApproval: approval,
    targetReplacementApprovalReceiptId: 'handoff-target-approval-1',
    targetReplacementApprovalActionInput: {
      sessionId: 'session-1',
      targetMachineId: approval.machineId,
      targetPath: approval.canonicalRoot,
    },
  };
}

async function waitForCondition(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition was not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('workspace sync target authority', () => {
  it('refuses unavailable Project rows before reading or contacting a target', async () => {
    const callMachineRpc = vi.fn(async () => { throw new Error('Unexpected target RPC'); });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => null, callMachineRpc });
    try {
      await expect(harness.authority.readFileAtTarget({
        relationshipId, targetMachineId: 'machine-b', targetWorkspaceRefId: 'workspace-beta',
        path: 'file.txt', maxBytes: 10,
      })).rejects.toMatchObject({ code: 'project_account_rows_unavailable' });
      expect(callMachineRpc).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
    }
  });

  it('stages an approved alternative from its original path and discards the exact aside effect', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-aside-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(alphaRoot, 'reviewed.txt'), 'old-hub');
    await writeFile(join(betaRoot, 'reviewed.txt'), 'new-beta');
    const original = { kind: 'file' as const, digest: createHash('sha1').update('old-hub').digest('hex'), executable: false, size: 7 };
    const selected = { kind: 'file' as const, digest: createHash('sha1').update('new-beta').digest('hex'), executable: false, size: 8 };
    const asidePath = deriveWorkspaceSyncConflictAsidePaths('reviewed.txt', original)[0];
    let authority: ReturnType<typeof createWorkspaceSyncTargetAuthority>;
    const harness = createAuthorityHarness({
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { betaMachineId: 'machine-a' }),
      resolveLocalResolutionEndpoint: async (_relationshipId, workspaceRefId) => ({
        canonicalRoot: workspaceRefId === 'workspace-alpha' ? alphaRoot : betaRoot,
        assertCurrentAuthority: async () => undefined,
      }),
      requestResolutionExport: async (request) => {
        const exported = await authority.prepareConflictResolutionExport(request);
        return {
          requestPayload: async ({ transferId, destinationPath }) => {
            const payload = transferId === request.operationId
              ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: {} });
            if (payload.kind === 'buffer') await writeFile(destinationPath, payload.payload);
            else await copyFile(payload.filePath, destinationPath);
          },
          release: async () => await exported.payloadSource.dispose?.(),
        };
      },
    });
    authority = harness.authority;
    const actionInput = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-alpha', path: 'reviewed.txt',
      source: { workspaceRefId: 'workspace-beta', expected: selected },
      targets: [{ workspaceRefId: 'workspace-alpha', expected: original }],
      relationshipIds: [relationshipId], strategy: 'keep_both' as const,
      alternatives: [{
        source: { workspaceRefId: 'workspace-alpha', expected: original },
        destination: { workspaceRefId: 'workspace-alpha', path: asidePath, expected: { kind: 'missing' as const } },
        consequence: { propagatingToWorkspaceRefIds: ['workspace-beta'] },
      }],
    };
    const request = {
      actionReceiptId: 'approved-aside', actionInput,
      operationId: deriveWorkspaceSyncConflictOperationId({
        actionReceiptId: 'approved-aside', kind: 'alternative', workspaceRefId: 'workspace-alpha',
        path: asidePath, alternativeIndex: 0,
      }),
      alternativeIndex: 0, relationshipId, sourceRelationshipId: relationshipId,
      sourceMachineId: 'machine-a', sourceWorkspaceRefId: 'workspace-alpha', sourceExpected: original,
      targetMachineId: 'machine-a', targetWorkspaceRefId: 'workspace-alpha', targetExpected: { kind: 'missing' as const },
      path: asidePath,
    };
    try {
      await authority.stageConflictResolutionHere(request);
      const [stagingName] = (await readdir(harness.resolutionDirectory)).filter((name) => name.startsWith('stage-'));
      expect(stagingName).toBeDefined();
      await expect(readFile(join(harness.resolutionDirectory, stagingName!, 'entry'), 'utf8')).resolves.toBe('old-hub');
      const applyRequest = {
        actionReceiptId: request.actionReceiptId, actionInput: request.actionInput,
        operationId: request.operationId, alternativeIndex: request.alternativeIndex,
        relationshipId: request.relationshipId, targetMachineId: request.targetMachineId,
        targetWorkspaceRefId: request.targetWorkspaceRefId, path: request.path,
      };
      await authority.discardStagedConflictResolutionHere(applyRequest);
      expect((await readdir(harness.resolutionDirectory)).filter((name) => name.startsWith('stage-'))).toEqual([]);
      await expect(readFile(join(alphaRoot, 'reviewed.txt'), 'utf8')).resolves.toBe('old-hub');
      await authority.releaseConflictResolutionCaptureHere({
        actionReceiptId: request.actionReceiptId, actionInput,
        operationId: request.actionReceiptId, sourceMachineId: 'machine-a', sourceWorkspaceRefId: 'workspace-alpha',
      });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('removes an orphaned successful stage on fresh authority initialization without touching roots or native recovery material', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-stage-restart-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(alphaRoot, 'reviewed.bin'), 'chosen');
    await writeFile(join(betaRoot, 'reviewed.bin'), 'original');
    const selected = { kind: 'file' as const, digest: createHash('sha1').update('chosen').digest('hex'), executable: false, size: 6 };
    const original = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
    let authority: ReturnType<typeof createWorkspaceSyncTargetAuthority>;
    const getProjectSnapshot = () => snapshot(alphaRoot, betaRoot, { betaMachineId: 'machine-a' });
    const harness = createAuthorityHarness({
      localMachineId: 'machine-a', getProjectSnapshot,
      resolveLocalResolutionEndpoint: async (_relationshipId, workspaceRefId) => ({
        canonicalRoot: workspaceRefId === 'workspace-alpha' ? alphaRoot : betaRoot,
        assertCurrentAuthority: async () => undefined,
      }),
      requestResolutionExport: async (request) => {
        const exported = await authority.prepareConflictResolutionExport(request);
        return {
          requestPayload: async ({ transferId, destinationPath }) => {
            const payload = transferId === request.operationId
              ? exported.payloadSource
              : await exported.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: {} });
            if (payload.kind === 'buffer') await writeFile(destinationPath, payload.payload);
            else await copyFile(payload.filePath, destinationPath);
          },
          release: async () => await exported.payloadSource.dispose?.(),
        };
      },
    });
    authority = harness.authority;
    const actionInput = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-alpha', path: 'reviewed.bin',
      source: { workspaceRefId: 'workspace-alpha', expected: selected },
      targets: [{ workspaceRefId: 'workspace-beta', expected: original }],
      relationshipIds: [relationshipId], strategy: 'use_source' as const,
    };
    const actionReceiptId = 'approved-stage-restart';
    const request = {
      actionReceiptId, actionInput,
      operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId, kind: 'selected', workspaceRefId: 'workspace-beta', path: 'reviewed.bin' }),
      alternativeIndex: null, relationshipId, sourceRelationshipId: relationshipId,
      sourceMachineId: 'machine-a', sourceWorkspaceRefId: 'workspace-alpha', sourceExpected: selected,
      targetMachineId: 'machine-a', targetWorkspaceRefId: 'workspace-beta', targetExpected: original,
      path: 'reviewed.bin',
    };
    try {
      await authority.stageConflictResolutionHere(request);
      const stagedBefore = (await readdir(harness.resolutionDirectory)).filter((name) => name.startsWith('stage-'));
      expect(stagedBefore).toHaveLength(1);
      await expect(readFile(join(harness.resolutionDirectory, stagedBefore[0]!, 'entry'), 'utf8')).resolves.toBe('chosen');
      await writeFile(join(harness.resolutionDirectory, 'workspace-recovery-sentinel.json'), 'record');
      await writeFile(join(harness.resolutionDirectory, 'stage-regular-file'), 'unowned file');
      await mkdir(join(harness.resolutionDirectory, 'native-candidate-sentinel'));
      await writeFile(join(harness.resolutionDirectory, 'native-candidate-sentinel', 'entry'), 'candidate');
      // The old daemon has ended; its process-local staged map cannot be adopted.
      await authority.releaseAllRetainedBootstraps();
      const fresh = createWorkspaceSyncTargetAuthority({
        localServerId: 'server-1', localMachineId: 'machine-a', getProjectSnapshot,
        callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
        resolutionMaterialDirectory: harness.resolutionDirectory,
        discoverConflictRecovery: async () => [],
      });
      await expect(fresh.recoverConflictResolutionHere({
        relationshipId, targetMachineId: 'machine-a', targetWorkspaceRefId: 'workspace-beta',
      })).resolves.toEqual({ status: 'settled' });
      const remaining = await readdir(harness.resolutionDirectory);
      expect(remaining.some((name) => name.startsWith('stage-') && name !== 'stage-regular-file')).toBe(false);
      expect(remaining.some((name) => name.startsWith('capture-'))).toBe(false);
      await expect(readFile(join(harness.resolutionDirectory, 'workspace-recovery-sentinel.json'), 'utf8')).resolves.toBe('record');
      await expect(readFile(join(harness.resolutionDirectory, 'stage-regular-file'), 'utf8')).resolves.toBe('unowned file');
      await expect(readFile(join(harness.resolutionDirectory, 'native-candidate-sentinel', 'entry'), 'utf8')).resolves.toBe('candidate');
      await expect(readFile(join(alphaRoot, 'reviewed.bin'), 'utf8')).resolves.toBe('chosen');
      await expect(readFile(join(betaRoot, 'reviewed.bin'), 'utf8')).resolves.toBe('original');
      await fresh.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it.runIf(process.platform === 'linux' && Boolean(process.env.HAPPIER_PROCESS_CUSTODY_LIVE_BIN))(
    'retains native recovery across orphan-stage cleanup and settles the public entry after restart',
    async () => {
      const executable = process.env.HAPPIER_PROCESS_CUSTODY_LIVE_BIN!;
      const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-native-restart-'));
      const alphaRoot = join(fixture, 'alpha');
      const betaRoot = join(fixture, 'beta');
      const recoveryDirectory = await mkdtemp(join(fixture, 'resolution-'));
      await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
      await writeFile(join(betaRoot, 'reviewed.bin'), 'original');
      const stagedDirectory = await mkdtemp(join(recoveryDirectory, 'stage-'));
      const materialPath = join(stagedDirectory, 'entry');
      await writeFile(materialPath, 'selected');
      const expectedDestination = { kind: 'file' as const, digest: createHash('sha1').update('original').digest('hex'), executable: false, size: 8 };
      const selectedExpectation = { kind: 'file' as const, digest: createHash('sha1').update('selected').digest('hex'), executable: false, size: 8 };
      const operationId = deriveWorkspaceSyncConflictOperationId({
        actionReceiptId: 'native-stage-restart', kind: 'selected', workspaceRefId: 'workspace-beta', path: 'reviewed.bin',
      });
      try {
        const outcome = await runNativeConfinedWorkspaceSyncApply({
          rootPath: betaRoot, relativePath: 'reviewed.bin', expectedDestination,
          selectedExpectation, materialPath, recoveryDirectory, operationId,
          // Prepared native handles remain valid, but candidate creation fails
          // after its recovery record is durable while this root is read-only.
          assertCurrentAuthority: async () => await chmod(betaRoot, 0o500),
        }, { resolveExecutable: () => executable });
        await chmod(betaRoot, 0o700);
        expect(outcome.status).toBe('recovery_needed');
        await expect(readFile(join(betaRoot, 'reviewed.bin'), 'utf8')).resolves.toBe('original');
        expect(await readdir(recoveryDirectory)).toContain(`workspace-recovery-${operationId}.json`);

        const fresh = createWorkspaceSyncTargetAuthority({
          localServerId: 'server-1', localMachineId: 'machine-a',
          getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { betaMachineId: 'machine-a' }),
          callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
          resolutionMaterialDirectory: recoveryDirectory,
          resolveLocalResolutionEndpoint: async () => ({ canonicalRoot: betaRoot, assertCurrentAuthority: async () => undefined }),
          discoverConflictRecovery: async (input) => await discoverNativeConfinedWorkspaceSyncRecovery(input, { resolveExecutable: () => executable }),
          recoverConflictEntry: async (input) => await recoverWorkspaceSyncEntryReplacementAtRoot(input, {
            runNativeConfinedRecover: async (nativeInput) => await runNativeConfinedWorkspaceSyncRecover(nativeInput, { resolveExecutable: () => executable }),
          }),
        });
        await expect(fresh.recoverConflictResolutionHere({
          relationshipId, targetMachineId: 'machine-a', targetWorkspaceRefId: 'workspace-beta',
        })).resolves.toEqual({ status: 'settled' });
        await expect(fresh.recoverConflictResolutionHere({
          relationshipId, targetMachineId: 'machine-a', targetWorkspaceRefId: 'workspace-beta',
        })).resolves.toEqual({ status: 'settled' });
        expect((await readdir(recoveryDirectory)).some((name) => name.startsWith('stage-') || name.startsWith('workspace-recovery-'))).toBe(false);
        await expect(readFile(join(betaRoot, 'reviewed.bin'), 'utf8')).resolves.toBe('original');
        await fresh.releaseAllRetainedBootstraps();
      } finally {
        await chmod(betaRoot, 0o700).catch(() => undefined);
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );
  it('exports one captured source for two reviewed linked destinations even after a source edit', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-capture-once-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const gammaRoot = join(fixture, 'gamma');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot), mkdir(gammaRoot)]);
    await writeFile(join(alphaRoot, 'selected.bin'), 'chosen');
    const secondRelationshipId = 'linked-gamma';
    const getProjectSnapshot = () => {
      const original = snapshot(alphaRoot, betaRoot, {
        extraRefs: [{ id: 'workspace-gamma', machineId: 'machine-c', rootPath: gammaRoot }],
      });
      return {
        ...original,
        relationships: [
          ...original.relationships,
          { ...original.relationships[0]!, relationshipId: secondRelationshipId,
            betaWorkspaceRefId: 'workspace-gamma' },
        ],
      };
    };
    const harness = createAuthorityHarness({
      localMachineId: 'machine-a', getProjectSnapshot,
      resolveLocalResolutionEndpoint: async () => ({ canonicalRoot: alphaRoot, assertCurrentAuthority: async () => undefined }),
    });
    const selected = { kind: 'file' as const, digest: createHash('sha1').update('chosen').digest('hex'), executable: false, size: 6 };
    const actionInput = {
      controllerMachineId: 'machine-a', hubWorkspaceRefId: 'workspace-alpha', path: 'selected.bin',
      source: { workspaceRefId: 'workspace-alpha', expected: selected },
      targets: [{ workspaceRefId: 'workspace-beta', expected: { kind: 'missing' as const } },
        { workspaceRefId: 'workspace-gamma', expected: { kind: 'missing' as const } }],
      relationshipIds: [relationshipId, secondRelationshipId], strategy: 'use_source' as const,
    };
    const base = {
      actionReceiptId: 'approved-capture-once', actionInput,
      alternativeIndex: null,
      sourceRelationshipId: relationshipId, sourceMachineId: 'machine-a', sourceWorkspaceRefId: 'workspace-alpha',
      sourceExpected: selected, targetExpected: { kind: 'missing' as const }, path: 'selected.bin',
    };
    try {
      const first = await harness.authority.prepareConflictResolutionExport({
        ...base,
        operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId: base.actionReceiptId, kind: 'selected', workspaceRefId: 'workspace-beta', path: base.path }),
        relationshipId, targetMachineId: 'machine-b', targetWorkspaceRefId: 'workspace-beta',
      });
      await first.payloadSource.dispose?.();
      await writeFile(join(alphaRoot, 'selected.bin'), 'edited');
      const second = await harness.authority.prepareConflictResolutionExport({
        ...base,
        operationId: deriveWorkspaceSyncConflictOperationId({ actionReceiptId: base.actionReceiptId, kind: 'selected', workspaceRefId: 'workspace-gamma', path: base.path }),
        relationshipId: secondRelationshipId, targetMachineId: 'machine-c', targetWorkspaceRefId: 'workspace-gamma',
      });
      expect(second.payloadSource).toMatchObject({ kind: 'buffer' });
      const transferId = `${deriveWorkspaceSyncConflictOperationId({ actionReceiptId: base.actionReceiptId, kind: 'selected', workspaceRefId: 'workspace-gamma', path: base.path })}:entry-blob:${createHash('sha256').update(selected.digest).digest('hex')}`;
      const blob = await second.onDemandScope.resolvePayloadSourceOnOpen({ transferId, requestBody: {} });
      if (!blob || blob.kind !== 'file') throw new Error('expected captured file transfer');
      await expect(readFile(blob.filePath, 'utf8')).resolves.toBe('chosen');
      await second.payloadSource.dispose?.();
      await harness.authority.releaseConflictResolutionCaptureHere({
        actionReceiptId: base.actionReceiptId,
        actionInput,
        operationId: base.actionReceiptId,
        sourceMachineId: base.sourceMachineId,
        sourceWorkspaceRefId: base.sourceWorkspaceRefId,
      });
      await expect(readFile(blob.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('keeps a reviewed target blocked until its confined replacement record settles', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-recovery-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    let pending = true;
    const recoverConflictEntry = vi.fn(async () => pending
      ? { status: 'recovery_needed' as const, recoveryPath: join(fixture, 'displaced') }
      : { status: 'settled' as const });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      discoverConflictRecovery: async () => pending ? [{
        operationId: 'reviewed', rootPath: betaRoot, recoveryPath: join(fixture, 'record.json'),
      }] : [],
      recoverConflictEntry,
    });
    const request = {
      relationshipId, targetMachineId: 'machine-b', targetWorkspaceRefId: 'workspace-beta',
    };
    try {
      await expect(harness.authority.recoverConflictResolutionHere(request)).resolves.toEqual({
        status: 'recovery_needed', recoveryPath: join(fixture, 'displaced'),
      });
      expect(recoverConflictEntry).toHaveBeenCalledWith(expect.objectContaining({
        rootPath: betaRoot, operationId: 'reviewed', recoveryDirectory: harness.resolutionDirectory,
      }));
      pending = false;
      await expect(harness.authority.recoverConflictResolutionHere(request)).resolves.toEqual({ status: 'settled' });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('settles every retained bootstrap during shutdown and preserves failed custody for retry', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-sweep-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const gammaRoot = join(fixture, 'gamma');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot), mkdir(gammaRoot)]);
    await Promise.all([
      writeFile(join(betaRoot, 'existing.txt'), 'beta'),
      writeFile(join(gammaRoot, 'existing.txt'), 'gamma'),
    ]);
    const firstFailure = new Error('first materialization abort failed');
    const firstAbort = vi.fn()
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(undefined);
    const secondAbort = vi.fn(async () => undefined);
    let materializationIndex = 0;
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, {
        includeRelationship: false,
        extraRefs: [{ id: 'workspace-gamma', machineId: 'machine-b', rootPath: gammaRoot }],
      }),
      materializeRemoteSeed: async () => ({
        receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null },
        bindPromotedTarget: async () => undefined,
        commit: async () => undefined,
        abort: materializationIndex++ === 0 ? firstAbort : secondAbort,
      }),
    });
    try {
      const betaPreflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-1', targetPath: betaRoot,
      });
      if (betaPreflight.type !== 'approval_required') throw new Error('expected beta approval');
      const gammaPreflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-2', targetPath: gammaRoot,
      });
      if (gammaPreflight.type !== 'approval_required') throw new Error('expected gamma approval');
      await harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        ...approvalBinding(betaPreflight.approval),
      }));
      await harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        bootstrapOperationId: 'bootstrap-op-2',
        owner: {
          kind: 'copy_once',
          operation: {
            v: 1,
            operationId: 'copy-op-2',
            controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'workspace-alpha',
            betaWorkspaceRefId: 'workspace-gamma',
            contentPolicy,
          },
        },
        targetWorkspaceRefId: 'workspace-gamma',
        ...approvalBinding(gammaPreflight.approval),
      }));

      await expect(harness.authority.releaseAllRetainedBootstraps()).rejects.toBe(firstFailure);
      expect(firstAbort).toHaveBeenCalledOnce();
      expect(secondAbort).toHaveBeenCalledOnce();
      const betaOwnership = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'post-sweep-beta', canonicalRoot: await realpath(betaRoot), operation: 'handoff',
      });
      expect('kind' in betaOwnership).toBe(false);
      if (!('kind' in betaOwnership)) await betaOwnership.release();
      const gammaOwnership = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'post-sweep-gamma', canonicalRoot: await realpath(gammaRoot), operation: 'handoff',
      });
      expect('kind' in gammaOwnership).toBe(false);
      if (!('kind' in gammaOwnership)) await gammaOwnership.release();

      await expect(harness.authority.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      expect(firstAbort).toHaveBeenCalledTimes(2);
      expect(secondAbort).toHaveBeenCalledOnce();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('externalizes manual materialization recovery instead of retrying destructive cleanup', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-manual-recovery-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'beta');
    const recoveryError = Object.assign(new Error('manual recovery required'), {
      code: 'workspace_target_materialization_manual_recovery',
    });
    const abort = vi.fn(async () => { throw recoveryError; });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { includeRelationship: false }),
      materializeRemoteSeed: async () => ({
        receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null },
        bindPromotedTarget: async () => undefined,
        commit: async () => undefined,
        abort,
      }),
    });
    try {
      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-1', targetPath: betaRoot,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected approval');
      await harness.authority.prepareBootstrapHere(copyOncePrepareRequest(approvalBinding(preflight.approval)));

      await expect(harness.authority.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      await expect(harness.authority.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      expect(abort).toHaveBeenCalledOnce();
      const ownership = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'post-externalization', canonicalRoot: await realpath(betaRoot), operation: 'handoff',
      });
      expect('kind' in ownership).toBe(false);
      if (!('kind' in ownership)) await ownership.release();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('stamps a non-empty handoff target proof under arbitration and releases before returning', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-target-preflight-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'preserve');
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
    });
    try {
      const result = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: 'handoff-action-1',
        targetPath: betaRoot,
      });
      expect(result).toMatchObject({
        type: 'approval_required',
        approval: {
          consequences: ['replace_nonempty_workspace_target'],
          serverId: 'server-1',
          machineId: 'machine-b',
          canonicalRoot: await realpath(betaRoot),
          operationId: 'handoff-action-1',
        },
      });
      const reacquired = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'probe-after-human-wait',
        canonicalRoot: await realpath(betaRoot),
        operation: 'handoff',
      });
      expect('kind' in reacquired).toBe(false);
      if (!('kind' in reacquired)) await reacquired.release();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('asks exactly once for every destructive consequence the handoff target decision carries', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-target-consequences-'));
    const alphaRoot = join(fixture, 'alpha');
    const emptyRoot = join(fixture, 'empty');
    const missingRoot = join(fixture, 'missing');
    const filledRoot = join(fixture, 'filled');
    await Promise.all([mkdir(alphaRoot), mkdir(emptyRoot), mkdir(filledRoot)]);
    await writeFile(join(filledRoot, 'existing.txt'), 'preserve');
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, filledRoot),
    });
    const preflight = async (targetPath: string, activatesExactMirror: boolean) => (
      await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: 'handoff-action-1',
        targetPath,
        ...(activatesExactMirror ? { activatesExactMirror: true } : {}),
      })
    );
    try {
      // Nothing to lose and no deletion semantics: no approval at all.
      expect(await preflight(missingRoot, false)).toEqual({ type: 'not_required' });
      expect(await preflight(emptyRoot, false)).toEqual({ type: 'not_required' });

      // Exact mirroring authorizes future target-only deletion even when the
      // destination is missing or empty today.
      expect(await preflight(missingRoot, true)).toMatchObject({
        type: 'approval_required',
        approval: { consequences: ['delete_target_only_files_during_exact_mirror'] },
      });
      expect(await preflight(emptyRoot, true)).toMatchObject({
        type: 'approval_required',
        approval: {
          consequences: ['delete_target_only_files_during_exact_mirror'],
          canonicalRoot: await realpath(emptyRoot),
        },
      });

      // Both consequences apply to one destination decision, so they are bound
      // to one proof rather than two prompts.
      expect(await preflight(filledRoot, true)).toMatchObject({
        type: 'approval_required',
        approval: {
          consequences: [
            'replace_nonempty_workspace_target',
            'delete_target_only_files_during_exact_mirror',
          ],
          canonicalRoot: await realpath(filledRoot),
        },
      });
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not call attaching an existing folder a replacement, and still asks before exact mirroring it', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-target-attach-'));
    const alphaRoot = join(fixture, 'alpha');
    const filledRoot = join(fixture, 'filled');
    await Promise.all([mkdir(alphaRoot), mkdir(filledRoot)]);
    await writeFile(join(filledRoot, 'existing.txt'), 'preserve');
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, filledRoot),
    });
    const preflight = async (overrides: Record<string, unknown>) => (
      await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: 'handoff-action-1',
        targetPath: filledRoot,
        ...overrides,
      })
    );
    try {
      // `use_existing` preserves what is already there, so a non-empty
      // destination is not a replacement and needs no destructive approval.
      expect(await preflight({ destinationIntent: 'use_existing' })).toEqual({ type: 'not_required' });

      // The same folder with the materializing intent still does replace it.
      expect(await preflight({ destinationIntent: 'materialize_from_source_workspace' })).toMatchObject({
        type: 'approval_required',
        approval: { consequences: ['replace_nonempty_workspace_target'] },
      });

      // Attaching is non-destructive today, but exact mirroring will delete the
      // folder's target-only files on the next reconciliation.
      expect(await preflight({ destinationIntent: 'use_existing', activatesExactMirror: true })).toMatchObject({
        type: 'approval_required',
        approval: { consequences: ['delete_target_only_files_during_exact_mirror'] },
      });
      await expect(readFile(join(filledRoot, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('requires the exact-mirror consequence when an existing folder is attached as an exact replica', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-attach-mirror-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'preserve');
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { mode: 'mirror_exactly' }),
      materializeRemoteSeed: async () => { throw new Error('must not materialize an attached folder'); },
    });
    const mirrorRelationship = {
      v: 1 as const, relationshipId, controllerMachineId: 'machine-a',
      alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta',
      mode: 'mirror_exactly' as const, contentPolicy, enabled: true,
      createdAtMs: 1, updatedAtMs: 1,
    };
    try {
      // Attaching alone cannot activate an unapproved exact replica.
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: mirrorRelationship,
        targetBootstrap: 'use_existing' as const,
      }))).rejects.toMatchObject({ code: 'approval_stale' });

      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId,
        targetPath: betaRoot, activatesExactMirror: true, destinationIntent: 'use_existing',
      });
      if (preflight.type !== 'approval_required') throw new Error('expected mirror approval');
      expect(preflight.approval.consequences).toEqual(['delete_target_only_files_during_exact_mirror']);

      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: mirrorRelationship,
        targetBootstrap: 'use_existing' as const,
        ...approvalBinding(preflight.approval),
      }))).resolves.toMatchObject({ state: 'ready' });
      // The approved consequence is future deletion, not deletion now.
      await expect(readFile(join(betaRoot, 'existing.txt'), 'utf8')).resolves.toBe('preserve');
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('keeps destructive materialization custody until the release outcome is known', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-custody-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(alphaRoot, 'from-source.txt'), 'new');
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    let materialization: Awaited<ReturnType<typeof materializeLocalWorkspaceSyncSeed>> | null = null;
    const commit = vi.fn(async () => await materialization?.commit());
    const abort = vi.fn(async () => await materialization?.abort());
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { relationshipEnabled: false }),
      materializeRemoteSeed: async ({ operationId, canonicalRoot }) => {
        materialization = await materializeLocalWorkspaceSyncSeed({
          operationId,
          activeServerDir: fixture,
          sourcePath: alphaRoot,
          targetPath: canonicalRoot,
          workspaceTransfer: { includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: [] },
          registry: createScmBackendRegistry([]),
        });
        return {
          receipt: materialization.receipt,
          bindPromotedTarget: async () => await materialization?.bindPromotedTarget(),
          commit,
          abort,
        };
      },
    });
    try {
      await harness.authority.prepareBootstrapHere(await approvedPrepareRequest(harness, betaRoot));
      expect(commit).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();

      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'abort',
      })).resolves.toEqual({ ok: true, released: true });
      expect(abort).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      await expect(readFile(join(betaRoot, 'existing.txt'), 'utf8')).resolves.toBe('existing');
      await expect(readFile(join(betaRoot, 'from-source.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not delete rollback custody when READY publication fails', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ready-failure-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const commit = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const readyFailure = new Error('injected READY publication failure');
    const writeReadyFact = vi.fn().mockRejectedValueOnce(readyFailure).mockResolvedValue(undefined);
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { includeRelationship: false }),
      writeReadyFact,
      materializeRemoteSeed: async () => ({
        receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null },
        bindPromotedTarget: async () => undefined,
        commit,
        abort,
      }),
    });
    try {
      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-1', targetPath: betaRoot,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected approval');
      await harness.authority.prepareBootstrapHere(copyOncePrepareRequest(approvalBinding(preflight.approval)));

      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: 'bootstrap-op-1',
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'copy_committed',
      })).rejects.toBe(readyFailure);
      expect(writeReadyFact).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
      const overlap = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'ready-failure-probe', canonicalRoot: await realpath(betaRoot), operation: 'handoff',
      });
      expect(overlap).toMatchObject({ kind: 'overlap' });
      if (!('kind' in overlap)) await overlap.release();

      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: 'bootstrap-op-1',
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'copy_committed',
      })).resolves.toEqual({ ok: true, released: true });
      expect(writeReadyFact).toHaveBeenCalledTimes(2);
      expect(commit).toHaveBeenCalledOnce();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('keeps committed READY custody fenced and retries cleanup instead of aborting it', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ready-cleanup-retry-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const cleanupFailure = new Error('injected committed custody cleanup failure');
    const commit = vi.fn().mockRejectedValueOnce(cleanupFailure).mockResolvedValue(undefined);
    const abort = vi.fn(async () => undefined);
    const writeReadyFact = vi.fn(async () => undefined);
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { includeRelationship: false }),
      writeReadyFact,
      materializeRemoteSeed: async () => ({
        receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null },
        bindPromotedTarget: async () => undefined,
        commit,
        abort,
      }),
    });
    try {
      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-1', targetPath: betaRoot,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected approval');
      await harness.authority.prepareBootstrapHere(copyOncePrepareRequest(approvalBinding(preflight.approval)));

      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: 'bootstrap-op-1',
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'copy_committed',
      })).rejects.toBe(cleanupFailure);
      expect(writeReadyFact).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
      const overlap = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'ready-cleanup-failure-probe', canonicalRoot: await realpath(betaRoot), operation: 'handoff',
      });
      expect(overlap).toMatchObject({ kind: 'overlap' });
      if (!('kind' in overlap)) await overlap.release();

      await expect(harness.authority.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      expect(writeReadyFact).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledTimes(2);
      expect(abort).not.toHaveBeenCalled();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('commits destructive materialization custody while retaining the enabled relationship fence', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-custody-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const commit = vi.fn(async () => undefined);
    const abort = vi.fn(async () => undefined);
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { relationshipEnabled: true }),
      materializeRemoteSeed: async () => ({ receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null }, bindPromotedTarget: async () => undefined, commit, abort }),
    });
    try {
      await harness.authority.prepareBootstrapHere(await approvedPrepareRequest(harness, betaRoot));
      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'relationship_committed',
      })).resolves.toEqual({ ok: true, released: false });
      expect(commit).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });



  it('rejects a conflict preview when the retained target root object changed', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-preview-root-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest({
        createIfMissing: false,
        targetBootstrap: 'use_existing',
      }));
      await rm(betaRoot, { recursive: true, force: true });
      await mkdir(betaRoot, { recursive: true });
      await writeFile(join(betaRoot, 'secret.txt'), 'unrelated replacement bytes');

      // Disclosure must be bound to the same retained root object as deletion:
      // a replacement tree at the granted pathname is not the granted root.
      await expect(harness.authority.readFileHere({
        relationshipId,
        workspaceRefId: 'workspace-beta',
        path: 'secret.txt',
        maxBytes: 1024,
      })).rejects.toMatchObject({ code: 'root_changed' });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('observes one target entry under current retained relationship custody', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-observe-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    await writeFile(join(betaRoot, 'file.txt'), 'target bytes');
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest({
        createIfMissing: false,
        targetBootstrap: 'use_existing',
      }));
      await expect(harness.authority.observeEntryHere({
        relationshipId, workspaceRefId: 'workspace-beta', path: 'file.txt',
      })).resolves.toEqual({
        kind: 'file', digest: createHash('sha1').update('target bytes').digest('hex'),
        executable: false, size: 12,
      });
      await expect(harness.authority.observeEntryHere({
        relationshipId, workspaceRefId: 'workspace-other', path: 'file.txt',
      })).rejects.toMatchObject({ code: 'relationship_not_ready' });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('routes target entry observation by current WorkspaceRef placement without accepting roots', async () => {
    const callMachineRpc = vi.fn(async () => ({ kind: 'missing' as const }));
    const authority = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1', localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot('/alpha', '/beta'), callMachineRpc,
    });
    await expect(authority.observeEntryAtTarget({
      relationshipId, targetMachineId: 'machine-b', targetWorkspaceRefId: 'workspace-beta', path: 'src/index.ts',
    })).resolves.toEqual({ kind: 'missing' });
    expect(callMachineRpc).toHaveBeenCalledWith({
      machineId: 'machine-b', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_ENTRY_OBSERVE,
      request: { relationshipId, workspaceRefId: 'workspace-beta', path: 'src/index.ts' },
    });
  });

  it('forwards a bounded preview to the selected machine without a caller root', async () => {
    const callMachineRpc = vi.fn(async () => ({
      status: 'text', text: 'hello', digest: 'a'.repeat(40), size: 5,
    }));
    const authority = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot('/alpha', '/beta'),
      callMachineRpc,
    });

    await expect(authority.readFileAtTarget({
      relationshipId,
      targetMachineId: 'machine-b',
      targetWorkspaceRefId: 'workspace-beta',
      path: 'src/index.ts',
      maxBytes: 1024,
    })).resolves.toMatchObject({ status: 'text', text: 'hello' });
    expect(callMachineRpc).toHaveBeenCalledWith({
      machineId: 'machine-b',
      method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_FILE_READ,
      request: {
        relationshipId, workspaceRefId: 'workspace-beta',
        path: 'src/index.ts', maxBytes: 1024,
      },
    });
  });

  it('rejects a workspace ref outside the relationship and a mismatched target machine', async () => {
    const authority = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot('/alpha', '/beta'),
      callMachineRpc: vi.fn(),
    });
    await expect(authority.readFileHere({
      relationshipId, workspaceRefId: 'workspace-other', path: 'file.txt', maxBytes: 10,
    })).rejects.toMatchObject({ code: 'relationship_not_ready' });
    await expect(authority.readFileAtTarget({
      relationshipId, targetMachineId: 'machine-c', targetWorkspaceRefId: 'workspace-beta',
      path: 'file.txt', maxBytes: 10,
    })).rejects.toMatchObject({ code: 'peer_unavailable' });
  });

  it('fail-closes local mutations, routed target calls and ingress with the exact typed legacy-state code', async () => {
    for (const code of ['legacy_workspace_sync_state_unsupported', 'legacy_workspace_sync_state_unknown'] as const) {
      const callMachineRpc = vi.fn(async () => undefined);
      const authority = createWorkspaceSyncTargetAuthority({
        localServerId: 'server-1',
        localMachineId: 'machine-b',
        getProjectSnapshot: () => snapshot('/alpha', '/beta'),
        callMachineRpc,
        assertLegacyStateAvailable: () => { throw Object.assign(new Error('legacy workspace sync state'), { code }); },
      });
      const expectTyped = (run: Promise<unknown>) => expect(run).rejects.toMatchObject({ code });
      await expectTyped(authority.readFileHere({
        relationshipId, workspaceRefId: 'workspace-beta', path: 'src/x.ts', maxBytes: 64,
      }));
      await expectTyped(authority.prepareBootstrapHere({
        v: 1, bootstrapOperationId: 'boot-op-1',
        owner: { kind: 'relationship', relationshipId },
        targetWorkspaceRefId: 'workspace-beta', endpointRole: 'beta',
        policyDigest: contentPolicy.policyDigest, createIfMissing: true,
      }));
      await expectTyped(authority.readFileAtTarget({
        relationshipId, targetMachineId: 'machine-c', targetWorkspaceRefId: 'workspace-beta',
        path: 'src/x.ts', maxBytes: 64,
      }));
      await expectTyped(authority.prepareBootstrapAtTarget({
        v: 1, bootstrapOperationId: 'boot-op-1',
        owner: { kind: 'relationship', relationshipId },
        targetWorkspaceRefId: 'workspace-beta', targetMachineId: 'machine-b', endpointRole: 'beta',
        policyDigest: contentPolicy.policyDigest, createIfMissing: true,
      }));
      await expectTyped(authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId, sourceMachineId: 'machine-a', targetMachineId: 'machine-b',
      }));
      // Safe cleanup/release paths stay available, and no machine RPC was reached.
      await expect(authority.releaseBootstrapHere({
        v: 1, bootstrapOperationId: 'boot-op-1', targetWorkspaceRefId: 'workspace-beta', reason: 'abort',
      })).resolves.toMatchObject({ ok: true, released: false });
      expect(callMachineRpc).not.toHaveBeenCalled();
    }
  });
});

describe('workspace sync target bootstrap authority', () => {
  it('keeps a linked spoke fence alive for a source-only copy loan after its relationship stops', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-spoke-source-loan-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    let current = snapshot(alphaRoot, betaRoot);
    const harness = createAuthorityHarness({ getProjectSnapshot: () => current });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest({ targetBootstrap: 'use_existing' }));
      expect(harness.authority.activity.read()).toMatchObject({ coverage: 'complete', items: [
        { category: 'sync', state: 'active' },
      ] });
      await harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'relationship_committed',
      });
      const loan = await harness.authority.borrowSourceRootForCopy({
        operationId: 'copy-from-spoke',
        workspaceRefId: 'workspace-beta',
      });
      expect(loan).not.toBeNull();
      expect(harness.authority.activity.read()).toMatchObject({ coverage: 'complete', items: [
        { category: 'sync', state: 'active' },
      ] });
      expect(loan?.handle.owner.canonicalRoot).toBe(await realpath(betaRoot));

      current = snapshot(alphaRoot, betaRoot, { includeRelationship: false });
      await harness.authority.reconcileRetainedBootstraps();
      const held = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'unrelated-target', canonicalRoot: betaRoot, operation: 'handoff',
      });
      expect(held).toMatchObject({ kind: 'overlap' });

      await loan?.release();
      expect(harness.authority.activity.read()).toEqual({ coverage: 'complete', items: [] });
      const available = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'unrelated-target', canonicalRoot: betaRoot, operation: 'handoff',
      });
      expect(available).not.toHaveProperty('kind');
      if (!('kind' in available)) await available.release();
      let closingEdges = 0;
      const unsubscribe = harness.authority.activity.subscribe(() => { closingEdges += 1; });
      try {
        await harness.authority.releaseAllRetainedBootstraps();
        expect(harness.authority.activity.read()).toEqual({ coverage: 'unknown', items: [] });
        expect(closingEdges).toBeGreaterThan(0);
      } finally { unsubscribe(); }
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
  it('rejects target preparation when the selected workspace belongs to another Home', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-home-placement-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const materializeRemoteSeed = vi.fn();
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { betaServerId: 'server-2' }),
      materializeRemoteSeed,
    });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest()))
        .rejects.toMatchObject({ code: 'peer_unavailable' });
      expect(materializeRemoteSeed).not.toHaveBeenCalled();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('prepares a relationship-owned target locally without accepting a caller path', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-bootstrap-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      const result = await harness.authority.prepareBootstrapHere(prepareRequest());
      expect(result).toEqual({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        state: 'ready',
        created: true,
        rootFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        policyDigest: contentPolicy.policyDigest,
      });
      expect(Object.keys(result).sort()).toEqual([
        'bootstrapOperationId', 'created', 'policyDigest', 'rootFingerprint', 'state', 'targetWorkspaceRefId', 'v',
      ]);
      await expect(stat(betaRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect(await readdir(betaRoot)).toEqual([]);
      // A caller-supplied path is not part of the wire contract and never reaches the local root owner.
      const missingRoot = join(fixture, 'never-created');
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        bootstrapOperationId: 'bootstrap-op-poison',
        rootPath: missingRoot,
      }))).rejects.toThrow();
      await expect(stat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('restores a missing all-files use-existing target to absence on authority abort', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-missing-use-existing-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { relationshipEnabled: false }),
    });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        targetBootstrap: 'use_existing',
      }))).resolves.toMatchObject({ created: true, state: 'ready' });
      await expect(stat(betaRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await writeFile(join(betaRoot, 'partially-synced.txt'), 'transient');

      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'abort',
      })).resolves.toEqual({ ok: true, released: true });
      await expect(stat(betaRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('treats an exact duplicate prepare as idempotent and a differing one as a definition conflict', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-dup-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      const first = await harness.authority.prepareBootstrapHere(prepareRequest());
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toEqual(first);
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        targetBootstrap: 'use_existing',
      })))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      await expect(harness.authority.prepareBootstrapHere(existingRelationshipPrepareRequest({ createIfMissing: false })))
        .resolves.toMatchObject({ bootstrapOperationId: 'existing-handoff', created: false });
      await expect(harness.authority.prepareBootstrapHere(existingRelationshipPrepareRequest({ policyDigest: 'b'.repeat(64) })))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        bootstrapOperationId: 'existing-handoff',
        transientRelationship: undefined,
        owner: { kind: 'copy_once', operation: {
          v: 1, operationId: 'copy-op-1', controllerMachineId: 'machine-a',
          alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta', contentPolicy,
        } },
      }))).rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('adopts the exact retained transient relationship when settings publication re-enters with the same operation', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-persisted-reentry-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    let currentSnapshot = snapshot(alphaRoot, betaRoot, { includeRelationship: false });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => currentSnapshot,
    });
    try {
      const prepared = await harness.authority.prepareBootstrapHere(prepareRequest());
      currentSnapshot = snapshot(alphaRoot, betaRoot);

      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: undefined,
        targetBootstrap: undefined,
        targetReplacementApproval: undefined,
      }))).resolves.toEqual(prepared);

      currentSnapshot = {
        ...currentSnapshot,
        relationships: currentSnapshot.relationships.map((relationship) => ({
          ...relationship,
          mode: 'keep_synced' as const,
        })),
      };
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: undefined,
        targetBootstrap: undefined,
        targetReplacementApproval: undefined,
      }))).rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });

      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('refuses a destructive approval stamped for another operation without touching the target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-approval-operation-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { includeRelationship: false }),
      materializeRemoteSeed: async () => { throw new Error('must not materialize'); },
    });
    try {
      // A proof this target minted for a different handoff operation is replayed
      // against the still-unchanged target of the requesting operation.
      const otherOperation = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-other', targetPath: betaRoot,
      });
      if (otherOperation.type !== 'approval_required') throw new Error('expected approval');

      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        ...approvalBinding(otherOperation.approval),
      }))).rejects.toMatchObject({ code: 'approval_stale' });

      // The same replay against a relationship endpoint: this relationship is
      // named by `handoffOperationId`, so a proof minted for any other handoff
      // operation cannot authorize its destructive bootstrap either.
      const relationshipHarness = createAuthorityHarness({
        getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
        materializeRemoteSeed: async () => { throw new Error('must not materialize'); },
      });
      try {
        const otherHandoff = await relationshipHarness.authority.preflightHandoffTargetReplacementHere({
          v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'handoff-op-other', targetPath: betaRoot,
        });
        if (otherHandoff.type !== 'approval_required') throw new Error('expected approval');
        await expect(relationshipHarness.authority.prepareBootstrapHere(prepareRequest({
          ...approvalBinding(otherHandoff.approval),
        }))).rejects.toMatchObject({ code: 'approval_stale' });
        await expect(readdir(relationshipHarness.materializationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await relationshipHarness.authority.releaseAllRetainedBootstraps();
        await relationshipHarness.cleanup();
      }

      await expect(readFile(join(betaRoot, 'existing.txt'), 'utf8')).resolves.toBe('existing');
      await expect(readdir(harness.materializationDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      const free = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'post-refusal', canonicalRoot: await realpath(betaRoot), operation: 'handoff',
      });
      expect('kind' in free).toBe(false);
      if (!('kind' in free)) await free.release();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('requires the exact approved Action receipt before accepting a structural replacement proof', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-action-receipt-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const assertTargetReplacementAuthorized = vi.fn(async () => undefined);
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { includeRelationship: false }),
      assertTargetReplacementAuthorized,
    });
    try {
      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: 'copy-op-1', targetPath: betaRoot,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected approval');

      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        targetReplacementApproval: preflight.approval,
      }))).rejects.toThrow();
      expect(assertTargetReplacementAuthorized).not.toHaveBeenCalled();
      await expect(readFile(join(betaRoot, 'existing.txt'), 'utf8')).resolves.toBe('existing');

      const request: WorkspaceSyncTargetBootstrapPrepareV1 = copyOncePrepareRequest(approvalBinding(preflight.approval));
      await expect(harness.authority.prepareBootstrapHere(request)).resolves.toMatchObject({ state: 'ready' });
      expect(assertTargetReplacementAuthorized).toHaveBeenCalledWith(
        request.targetReplacementApprovalReceiptId,
        request.targetReplacementApprovalActionInput,
        preflight.approval,
      );
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('requires exactly the mirror-deletion consequence when exact mirroring activates on an empty target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-mirror-consequence-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { mode: 'mirror_exactly' }),
    });
    try {
      // Nothing is replaced today, but activating exact mirroring authorizes
      // deleting target-only files for the life of the relationship.
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: {
          v: 1 as const, relationshipId, controllerMachineId: 'machine-a',
          alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta',
          mode: 'mirror_exactly' as const, contentPolicy, enabled: true,
          createdAtMs: 1, updatedAtMs: 1,
        },
      }))).rejects.toMatchObject({ code: 'approval_stale' });

      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId,
        targetPath: betaRoot, activatesExactMirror: true,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected mirror approval');
      expect(preflight.approval.consequences).toEqual(['delete_target_only_files_during_exact_mirror']);

      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: {
          v: 1 as const, relationshipId, controllerMachineId: 'machine-a',
          alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta',
          mode: 'mirror_exactly' as const, contentPolicy, enabled: true,
          createdAtMs: 1, updatedAtMs: 1,
        },
        ...approvalBinding(preflight.approval),
      }))).resolves.toMatchObject({ state: 'ready' });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('refuses an approval carrying a consequence this relationship mode does not authorize', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-extra-consequence-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    await mkdir(betaRoot, { recursive: true });
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      materializeRemoteSeed: async () => { throw new Error('must not materialize'); },
    });
    try {
      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId,
        targetPath: betaRoot, activatesExactMirror: true,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected approval');
      expect(preflight.approval.consequences).toEqual([
        'replace_nonempty_workspace_target',
        'delete_target_only_files_during_exact_mirror',
      ]);

      // The retained relationship is not mirroring, so the mirror consequence is
      // an extra proof the target must not honour.
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        ...approvalBinding(preflight.approval),
      }))).rejects.toMatchObject({ code: 'approval_stale' });
      await expect(readFile(join(betaRoot, 'existing.txt'), 'utf8')).resolves.toBe('existing');
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects wrong machine, unknown ref, role/ref drift, wrong policy and stale relationships without touching the root', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-reject-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      const missingRoot = join(fixture, 'never-created');
      const rejectsAndLeavesRoot = async (request: WorkspaceSyncTargetBootstrapPrepareV1, code: string, localMachineId?: string) => {
        const target = createAuthorityHarness({
          localMachineId,
          getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
        });
        try {
          await expect(target.authority.prepareBootstrapHere(request)).rejects.toMatchObject({ code });
          await expect(stat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
          await target.cleanup();
        }
      };
      await rejectsAndLeavesRoot(existingRelationshipPrepareRequest(), 'workspace_machine_not_enrolled', 'machine-c');
      await rejectsAndLeavesRoot(existingRelationshipPrepareRequest({ targetWorkspaceRefId: 'workspace-missing' }), 'peer_unavailable');
      await rejectsAndLeavesRoot(existingRelationshipPrepareRequest({ targetWorkspaceRefId: 'workspace-alpha' }), 'relationship_not_ready');
      await rejectsAndLeavesRoot(existingRelationshipPrepareRequest({ policyDigest: 'b'.repeat(64) }), 'bootstrap_definition_conflict');
      const stale = createAuthorityHarness({
        getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { relationshipEnabled: false }),
      });
      try {
        await expect(stale.authority.prepareBootstrapHere(existingRelationshipPrepareRequest())).rejects.toMatchObject({ code: 'relationship_not_ready' });
        await expect(stat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await stale.cleanup();
      }
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('admits an established two-way reverse direction before recovery but rejects the same one-way direction', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-reverse-direction-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(betaRoot, { recursive: true });
    const reverseRequest = existingRelationshipPrepareRequest({
      targetWorkspaceRefId: 'workspace-alpha',
      endpointRole: 'alpha',
    });
    const twoWay = createAuthorityHarness({
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
    });
    try {
      await expect(twoWay.authority.prepareBootstrapHere(reverseRequest))
        .rejects.toMatchObject({ code: 'root_changed' });
    } finally {
      await twoWay.cleanup();
    }

    const oneWay = createAuthorityHarness({
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { mode: 'keep_synced' }),
    });
    try {
      await expect(oneWay.authority.prepareBootstrapHere(reverseRequest))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
    } finally {
      await oneWay.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('prepares and releases a copy_once target and refuses target, role, policy and source drift', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-copy-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      const result = await harness.authority.prepareBootstrapHere(copyOncePrepareRequest());
      expect(result).toMatchObject({ state: 'ready', targetWorkspaceRefId: 'workspace-beta', bootstrapOperationId: 'bootstrap-op-1' });
      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({ targetWorkspaceRefId: 'workspace-alpha' })))
        .rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        owner: {
          kind: 'copy_once',
          operation: {
            v: 1, operationId: 'copy-op-2', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta',
            contentPolicy: {
              v: 1,
              selection: 'git_worktree' as const,
              extraIgnorePatterns: [],
              extraIncludePatterns: [],
              policyDigest: computeWorkspaceSyncPolicyDigest({
                v: 1, selection: 'git_worktree', extraIgnorePatterns: [], extraIncludePatterns: [],
              }),
            },
          },
        },
      }))).rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        bootstrapOperationId: 'bootstrap-op-3',
        owner: {
          kind: 'copy_once',
          operation: {
            v: 1, operationId: 'copy-op-3', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'workspace-missing', betaWorkspaceRefId: 'workspace-beta', contentPolicy,
          },
        },
      }))).rejects.toMatchObject({ code: 'peer_unavailable' });
      await expect(harness.authority.releaseBootstrapHere({
        v: 1, bootstrapOperationId: 'bootstrap-op-1', targetWorkspaceRefId: 'workspace-other', reason: 'abort',
      })).rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      await expect(harness.authority.releaseBootstrapHere({
        v: 1, bootstrapOperationId: 'bootstrap-op-1', targetWorkspaceRefId: 'workspace-beta', reason: 'abort',
      })).resolves.toEqual({ ok: true, released: true });
      await expect(harness.authority.releaseBootstrapHere({
        v: 1, bootstrapOperationId: 'bootstrap-op-1', targetWorkspaceRefId: 'workspace-beta', reason: 'abort',
      })).resolves.toEqual({ ok: true, released: false });
      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        bootstrapOperationId: 'bootstrap-op-controller-drift',
        owner: {
          kind: 'copy_once',
          operation: {
            v: 1, operationId: 'copy-op-controller-drift', controllerMachineId: 'machine-c',
            alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-beta', contentPolicy,
          },
        },
      }))).rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
      // The fence is really gone: the same root can be re-acquired by a fresh operation.
      const probe = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'probe', canonicalRoot: betaRoot, operation: 'bootstrap', deferRootIdentityBinding: true,
      });
      if ('kind' in probe) throw new Error('copy_once release did not free the root ownership fence');
      await probe.release();
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rehydrates an exact copy_once target from persisted intent and the canonical materialization owner after restart', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-copy-restart-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const currentSnapshot = () => snapshot(alphaRoot, betaRoot, { includeRelationship: false });
    const create = () => createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-b',
      getProjectSnapshot: currentSnapshot,
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      bootstrap: {
        materializationDirectory,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
        materializeRemoteSeed: async () => ({ receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null }, bindPromotedTarget: async () => undefined, commit: async () => undefined, abort: async () => undefined }),
      },
    });
    const first = create();
    try {
      await first.prepareBootstrapHere(copyOncePrepareRequest());
      await first.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: 'bootstrap-op-1',
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'copy_committed',
      });
      await first.releaseAllRetainedBootstraps();

      const restarted = create();
      await expect(restarted.prepareBootstrapHere(copyOncePrepareRequest({
        bootstrapOperationId: 'copy-op-1',
        createIfMissing: false,
        targetBootstrap: undefined,
      }))).resolves.toMatchObject({
        bootstrapOperationId: 'copy-op-1',
        targetWorkspaceRefId: 'workspace-beta',
        state: 'ready',
        created: false,
        policyDigest: contentPolicy.policyDigest,
      });
      await restarted.releaseAllRetainedBootstraps();
    } finally {
      await first.releaseAllRetainedBootstraps();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not compare identical path strings that belong to different machines', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-cross-machine-path-'));
    const sharedPathText = join(fixture, 'workspace');
    await mkdir(sharedPathText, { recursive: true });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(sharedPathText, sharedPathText),
    });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toMatchObject({
        state: 'ready',
        targetWorkspaceRefId: 'workspace-beta',
      });
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('leaves an empty remote all-files relationship target for the initial Mutagen cycle', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-remote-seed-'));
    const alphaRoot = join(fixture, 'source');
    const betaRoot = join(fixture, 'target');
    await mkdir(alphaRoot, { recursive: true });
    const materializeRemoteSeed = vi.fn(async ({ canonicalRoot }: { canonicalRoot: string }) => {
      await writeFile(join(canonicalRoot, 'from-source.txt'), 'seeded');
      return {
        receipt: { v: 1 as const, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null },
        bindPromotedTarget: async () => undefined,
        commit: async () => undefined,
        abort: async () => undefined,
      };
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      materializeRemoteSeed,
    });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toMatchObject({
        state: 'ready',
        created: true,
      });
      expect(materializeRemoteSeed).not.toHaveBeenCalled();
      expect(await readdir(betaRoot)).toEqual([]);
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('materializes an all-files seed when both endpoints belong to this daemon', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-local-seed-'));
    const alphaRoot = join(fixture, 'source');
    const betaRoot = join(fixture, 'target');
    await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);
    await writeFile(join(alphaRoot, 'from-local-source.txt'), 'seeded');
    await writeFile(join(betaRoot, 'old-target.txt'), 'old');
    const current = snapshot(alphaRoot, betaRoot);
    const localSnapshot: ActiveProjectAccountRowsSnapshot = {
      ...current,
      workspaceRefs: current.workspaceRefs.map((ref) => ({ ...ref, machineId: 'machine-b' })),
      relationships: current.relationships.map((relationship) => ({
        ...relationship,
        controllerMachineId: 'machine-b',
      })),
    };
    const materializeLocalSeed = vi.fn(async ({ operationId, sourcePath, canonicalRoot }: {
      operationId: string;
      sourcePath: string;
      canonicalRoot: string;
    }) => await materializeLocalWorkspaceSyncSeed({
      operationId,
      activeServerDir: fixture,
      sourcePath,
      targetPath: canonicalRoot,
      workspaceTransfer: { includeIgnoredMode: 'include_selected', ignoredIncludeGlobs: [] },
      registry: createScmBackendRegistry([]),
    }));
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => localSnapshot,
      materializeRemoteSeed: false,
      materializeLocalSeed,
    });
    try {
      await harness.authority.prepareBootstrapHere(await approvedPrepareRequest(harness, betaRoot, {
        transientRelationship: {
          ...current.relationships[0]!,
          controllerMachineId: 'machine-b',
        },
      }));
      expect(materializeLocalSeed).toHaveBeenCalledWith(expect.objectContaining({
        operationId: relationshipId,
        sourcePath: alphaRoot,
        canonicalRoot: await realpath(betaRoot),
        // The authority hands the seed the complete bounded policy plus the
        // receipt facts it needs, not a reduced selection hint.
        contentPolicy,
        materializationReceiptPath: expect.any(String),
        originalTargetExists: true,
      }));
      await harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'relationship_committed',
      });
      await harness.authority.releaseAllRetainedBootstraps();
      await expect(readFile(join(betaRoot, 'from-local-source.txt'), 'utf8')).resolves.toBe('seeded');
      await expect(readFile(join(betaRoot, 'old-target.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(fixture)).some((name) => name.startsWith('.happier-sync-backup.'))).toBe(false);
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains a relationship fence on abort while the enabled relationship still owns the endpoint', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-retain-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    let current = snapshot(alphaRoot, betaRoot);
    const harness = createAuthorityHarness({ getProjectSnapshot: () => current });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toMatchObject({ state: 'ready' });
      await expect(harness.authority.releaseBootstrapHere({
        v: 1, bootstrapOperationId: relationshipId, targetWorkspaceRefId: 'workspace-beta', reason: 'abort',
      })).resolves.toEqual({ ok: true, released: false });
      // The persistent relationship still owns the endpoint: the fence must survive the abort.
      const overlap = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'probe', canonicalRoot: betaRoot, operation: 'bootstrap',
      });
      expect(overlap).toMatchObject({ kind: 'overlap' });
      if (!('kind' in overlap)) await overlap.release();
      // Once the relationship is disabled the same abort release is free to release.
      current = snapshot(alphaRoot, betaRoot, { relationshipEnabled: false });
      await expect(harness.authority.releaseBootstrapHere({
        v: 1, bootstrapOperationId: relationshipId, targetWorkspaceRefId: 'workspace-beta', reason: 'abort',
      })).resolves.toEqual({ ok: true, released: true });
      const probe = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'probe', canonicalRoot: betaRoot, operation: 'bootstrap', deferRootIdentityBinding: true,
      });
      if ('kind' in probe) throw new Error('disabled relationship abort did not release the fence');
      await probe.release();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('lets the exact admitted handoff operation re-enter an enabled relationship target without competing with its retained fence', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-handoff-replay-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const otherRoot = join(fixture, 'other');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(otherRoot, { recursive: true })]);
    await writeFile(join(alphaRoot, 'source.txt'), 'source');
    await writeFile(join(otherRoot, 'existing.txt'), 'preserve');
    let current = snapshot(alphaRoot, betaRoot);
    const harness = createAuthorityHarness({ getProjectSnapshot: () => current });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toMatchObject({ state: 'ready' });

      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: handoffOperationId,
        targetPath: betaRoot,
      })).resolves.toEqual({ type: 'not_required' });

      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: 'different-handoff-operation',
        targetPath: betaRoot,
      })).rejects.toMatchObject({ code: 'workspace_root_in_use' });

      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: handoffOperationId,
        targetPath: otherRoot,
      })).resolves.toMatchObject({
        type: 'approval_required',
        approval: { consequences: ['replace_nonempty_workspace_target'] },
      });

      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: handoffOperationId,
        targetPath: alphaRoot,
      })).resolves.toMatchObject({
        type: 'approval_required',
        approval: { consequences: ['replace_nonempty_workspace_target'] },
      });

      current = snapshot(alphaRoot, betaRoot, { relationshipEnabled: false });
      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId, targetPath: betaRoot,
      })).rejects.toMatchObject({ code: 'workspace_root_in_use' });

      current = snapshot(alphaRoot, betaRoot, { includeRelationship: false });
      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId, targetPath: betaRoot,
      })).rejects.toMatchObject({ code: 'workspace_root_in_use' });

      const duplicatedRef = snapshot(alphaRoot, betaRoot);
      const betaRef = duplicatedRef.workspaceRefs.find((workspace) => workspace.id === 'workspace-beta')!;
      current = {
        ...duplicatedRef,
        workspaceRefs: [...duplicatedRef.workspaceRefs, { ...betaRef }],
      };
      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId, targetPath: betaRoot,
      })).rejects.toMatchObject({ code: 'workspace_root_in_use' });

      current = snapshot(alphaRoot, betaRoot, {
        extraRefs: [{ id: 'workspace-other', machineId: 'machine-b', rootPath: otherRoot }],
      });
      current = {
        ...current,
        relationships: current.relationships.map((relationship) => ({
          ...relationship,
          betaWorkspaceRefId: 'workspace-other',
        })),
      };
      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId, targetPath: betaRoot,
      })).rejects.toMatchObject({ code: 'workspace_root_in_use' });

      current = snapshot(alphaRoot, betaRoot, { mode: 'mirror_exactly' });
      await expect(harness.authority.preflightHandoffTargetReplacementHere({
        v: 1, serverId: 'server-1', machineId: 'machine-b', operationId: handoffOperationId, targetPath: betaRoot,
      })).resolves.toEqual({ type: 'not_required' });
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: undefined,
        targetBootstrap: undefined,
        targetReplacementApproval: undefined,
      }))).rejects.toMatchObject({ code: 'bootstrap_definition_conflict' });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('drops retained ownership when reconciliation detects root identity loss', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-bind-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => snapshot(alphaRoot, betaRoot) });
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toMatchObject({ state: 'ready' });
      const canonical = await realpath(betaRoot);
      await rm(betaRoot, { recursive: true, force: true });
      await mkdir(betaRoot, { recursive: true });
      await expect(harness.authority.reconcileRetainedBootstraps()).resolves.toBeUndefined();
      const probe = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'probe', canonicalRoot: canonical, operation: 'bootstrap',
      });
      expect('kind' in probe).toBe(false);
      if (!('kind' in probe)) await probe.release();
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('reconciles disabled relationships and releases every retained handle on shutdown', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-reconcile-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const gammaRoot = join(fixture, 'gamma');
    await mkdir(alphaRoot, { recursive: true });
    let current = snapshot(alphaRoot, betaRoot, {
      extraRefs: [{ id: 'workspace-gamma', machineId: 'machine-b', rootPath: gammaRoot }],
    });
    const harness = createAuthorityHarness({ getProjectSnapshot: () => current });
    const probeRoot = async (rootPath: string): Promise<boolean> => {
      const probe = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'probe', canonicalRoot: rootPath, operation: 'bootstrap', deferRootIdentityBinding: true,
      });
      if ('kind' in probe) return false;
      await probe.release();
      return true;
    };
    try {
      await expect(harness.authority.prepareBootstrapHere(prepareRequest())).resolves.toMatchObject({ state: 'ready' });
      await expect(harness.authority.prepareBootstrapHere(copyOncePrepareRequest({
        bootstrapOperationId: 'bootstrap-op-gamma',
        owner: {
          kind: 'copy_once',
          operation: {
            v: 1, operationId: 'copy-op-gamma', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'workspace-alpha', betaWorkspaceRefId: 'workspace-gamma', contentPolicy,
          },
        },
        targetWorkspaceRefId: 'workspace-gamma',
      }))).resolves.toMatchObject({ state: 'ready' });
      await expect(probeRoot(betaRoot)).resolves.toBe(false);
      await expect(probeRoot(gammaRoot)).resolves.toBe(false);
      current = snapshot(alphaRoot, betaRoot, {
        relationshipEnabled: false,
        extraRefs: [{ id: 'workspace-gamma', machineId: 'machine-b', rootPath: gammaRoot }],
      });
      await harness.authority.reconcileRetainedBootstraps();
      await expect(probeRoot(betaRoot)).resolves.toBe(true);
      await expect(probeRoot(gammaRoot)).resolves.toBe(false);
      await harness.authority.releaseAllRetainedBootstraps();
      await expect(probeRoot(gammaRoot)).resolves.toBe(true);
      await harness.authority.releaseAllRetainedBootstraps();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('acquires one loopback ingress only for the retained target owner and moves raw bytes to its rooted agent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const rootedAgents: PassThrough[] = [];
    const rootedAgentStops: Array<ReturnType<typeof vi.fn>> = [];
    const openRootedAgent = vi.fn(async () => {
      const agent = new PassThrough();
      rootedAgents.push(agent);
      const owned = ownedRootedAgent(agent);
      rootedAgentStops.push(owned.stop);
      return owned;
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      const ingress = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      expect(ingress).toMatchObject({
        port: expect.any(Number),
        localCapability: expect.stringMatching(/^[0-9a-f]{64}$/),
        close: expect.any(Function),
      });
      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'peer_unavailable' });
      expect(openRootedAgent).toHaveBeenCalledTimes(1);

      const scanner = connect({ host: '127.0.0.1', port: ingress.port });
      await once(scanner, 'connect');
      scanner.end('unauthorized-local-process');
      await once(scanner, 'close');
      expect(openRootedAgent).toHaveBeenCalledTimes(1);

      await waitForCondition(() => rootedAgents[0]?.destroyed === true);
      expect(rootedAgentStops[0]).toHaveBeenCalledOnce();
      const rejectedAfterFirstAttach = connect({ host: '127.0.0.1', port: ingress.port });
      await expect(once(rejectedAfterFirstAttach, 'error')).resolves.toBeDefined();
      rejectedAfterFirstAttach.destroy();

      const retryIngress = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });

      const client = connect({ host: '127.0.0.1', port: retryIngress.port });
      await once(client, 'connect');
      const response = once(client, 'data') as Promise<[Buffer]>;
      client.write(retryIngress.localCapability);
      client.write(Buffer.from('native-machine-carrier-bytes'));
      await expect(response).resolves.toEqual([Buffer.from('native-machine-carrier-bytes')]);
      expect(openRootedAgent).toHaveBeenCalledWith({
        operationId: relationshipId, role: 'beta', workspaceRefId: 'workspace-beta',
        canonicalRoot: await realpath(betaRoot), signal: expect.any(AbortSignal),
      });
      client.destroy();

      const duplicate = connect({ host: '127.0.0.1', port: retryIngress.port });
      const duplicateOutcome = await new Promise<'connected' | 'refused'>((resolve) => {
        duplicate.once('connect', () => resolve('connected'));
        duplicate.once('error', () => resolve('refused'));
      });
      if (duplicateOutcome === 'connected') {
        duplicate.end(retryIngress.localCapability);
        await once(duplicate, 'close');
      }
      expect(openRootedAgent).toHaveBeenCalledTimes(2);
      await retryIngress.close();
      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-c',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'peer_unavailable' });

      const pendingIngress = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      const partialCapabilityClient = connect({ host: '127.0.0.1', port: pendingIngress.port });
      await once(partialCapabilityClient, 'connect');
      const partialCapabilityClosed = new Promise<void>((resolve) => {
        partialCapabilityClient.once('close', () => resolve());
      });
      partialCapabilityClient.on('error', () => undefined);
      partialCapabilityClient.write('0');
      await expect(harness.authority.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      await expect(partialCapabilityClosed).resolves.toBeUndefined();
      expect(rootedAgents[1]?.destroyed).toBe(true);
      const rejectedClient = connect({ host: '127.0.0.1', port: pendingIngress.port });
      await expect(once(rejectedClient, 'error')).resolves.toBeDefined();
      rejectedClient.destroy();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('cancels rooted-agent acquisition and permits an immediate ingress retry', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-cancel-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    let attempts = 0;
    const openRootedAgent = vi.fn(async (input: Readonly<{ signal?: AbortSignal }>) => {
      attempts += 1;
      if (attempts > 1) return ownedRootedAgent();
      return await new Promise<ReturnType<typeof ownedRootedAgent>>((_resolve, reject) => {
        input.signal?.addEventListener('abort', () => reject(input.signal?.reason), { once: true });
      });
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      const abort = new AbortController();
      const cancelled = harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
        signal: abort.signal,
      });
      await vi.waitFor(() => expect(openRootedAgent).toHaveBeenCalledOnce());
      abort.abort(Object.assign(new Error('request disconnected'), { code: 'cancelled' }));
      await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });

      const retry = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      expect(openRootedAgent).toHaveBeenCalledTimes(2);
      await retry.close();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains the target root fence until rooted-agent shutdown succeeds', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-fence-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const cleanupFailure = new Error('rooted agent stop failed');
    let failStop = true;
    const stop = vi.fn(async () => {
      if (failStop) throw cleanupFailure;
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent: async () => ({ stream: new PassThrough(), stop }),
    });
    const canAcquireTargetRoot = async (): Promise<boolean> => {
      const probe = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'fence-probe',
        canonicalRoot: betaRoot,
        operation: 'handoff',
      });
      if ('kind' in probe) return false;
      await probe.release();
      return true;
    };
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });

      await expect(harness.authority.releaseAllRetainedBootstraps()).rejects.toBe(cleanupFailure);
      await expect(canAcquireTargetRoot()).resolves.toBe(false);

      failStop = false;
      await expect(harness.authority.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(2);
      await expect(canAcquireTargetRoot()).resolves.toBe(true);
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('consumes an event-driven ingress close rejection while the explicit closer stays retryable', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-close-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const agentStreams: PassThrough[] = [];
    let failAgentStop = true;
    const stop = vi.fn(async () => {
      if (failAgentStop) throw new Error('rooted agent stop failed');
      for (const agentStream of agentStreams) agentStream.destroy();
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent: async () => {
        const stream = new PassThrough();
        agentStreams.push(stream);
        return { stream, stop };
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      const ingress = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });

      const client = connect({ host: '127.0.0.1', port: ingress.port });
      await once(client, 'connect');
      const response = once(client, 'data') as Promise<[Buffer]>;
      client.write(ingress.localCapability);
      client.write(Buffer.from('carrier-bytes'));
      await expect(response).resolves.toEqual([Buffer.from('carrier-bytes')]);

      // The peer disappears: the socket close event drives cleanup, and the
      // rooted agent stop fails. A daemon must not die of an unhandled
      // rejection because an ingress could not be stopped.
      client.destroy();
      await vi.waitFor(() => expect(stop).toHaveBeenCalled());
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      // Custody stayed with the explicit closer: it still reports the failure
      // and still retries it.
      await expect(ingress.close()).rejects.toThrow('rooted agent stop failed');
      failAgentStop = false;
      await expect(ingress.close()).resolves.toBeUndefined();
      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).resolves.toMatchObject({ port: expect.any(Number) });
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('owns the machine attach deadline and cancels it after authenticated attachment', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-attach-expiry-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const agents: ReturnType<typeof ownedRootedAgent>[] = [];
    let firstAgentStopped!: () => void;
    const firstStop = new Promise<void>(resolve => { firstAgentStopped = resolve; });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent: async () => {
        const agent = ownedRootedAgent();
        const first = agents.length === 0;
        agent.stop.mockImplementation(async () => {
          agent.stream.destroy();
          if (first) firstAgentStopped();
        });
        agents.push(agent);
        return agent;
      },
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      // Only the clock is controlled; listening sockets, capability authentication
      // and the rooted-agent stream remain the real ingress path.
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const expired = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
        expiresAtMs: Date.now() + 50,
      });
      await vi.advanceTimersByTimeAsync(49);
      expect(agents[0]?.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await firstStop;
      expect(agents[0]?.stop).toHaveBeenCalledOnce();
      const afterExpiry = connect({ host: '127.0.0.1', port: expired.port });
      await expect(once(afterExpiry, 'error')).resolves.toBeDefined();
      afterExpiry.destroy();

      const attached = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
        expiresAtMs: Date.now() + 100,
      });
      const client = connect({ host: '127.0.0.1', port: attached.port });
      const connectionError = vi.fn();
      client.on('error', connectionError);
      await once(client, 'connect');
      const authenticatedBytes = once(agents[1]!.stream, 'data');
      client.write(Buffer.concat([Buffer.from(attached.localCapability), Buffer.from('authenticated')]));
      await expect(authenticatedBytes).resolves.toEqual([Buffer.from('authenticated')]);
      await vi.advanceTimersByTimeAsync(175);
      expect(agents[1]?.stop).not.toHaveBeenCalled();
      expect(connectionError).not.toHaveBeenCalled();

      client.destroy();
      await attached.close();
    } finally {
      vi.useRealTimers();
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('closes ingress admission and joins an in-flight acquisition before shutdown releases custody', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-shutdown-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const openRootedAgent = vi.fn(async (input: Readonly<{ signal?: AbortSignal }>) => (
      await new Promise<ReturnType<typeof ownedRootedAgent>>((_resolve, reject) => {
        const signal = input.signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    ));
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      const acquisition = harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      await vi.waitFor(() => expect(openRootedAgent).toHaveBeenCalledOnce());
      const release = harness.authority.releaseAllRetainedBootstraps();
      await expect(acquisition).rejects.toBeDefined();
      await expect(release).resolves.toBeUndefined();
      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'peer_unavailable' });
      expect(openRootedAgent).toHaveBeenCalledOnce();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does not launch retained relationship ingress after the relationship is disabled', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-disabled-before-launch-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    let current = snapshot(alphaRoot, betaRoot);
    const openRootedAgent = vi.fn(async () => ownedRootedAgent());
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => current,
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      current = snapshot(alphaRoot, betaRoot, { relationshipEnabled: false });

      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'relationship_not_ready' });
      expect(openRootedAgent).not.toHaveBeenCalled();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('closes a late rooted agent instead of publishing ingress after the relationship is disabled', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-disabled-after-agent-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    let current = snapshot(alphaRoot, betaRoot);
    const lateAgent = ownedRootedAgent();
    let resolveAgent!: (value: ReturnType<typeof ownedRootedAgent>) => void;
    const openRootedAgent = vi.fn(async () => await new Promise<ReturnType<typeof ownedRootedAgent>>((resolve) => {
      resolveAgent = resolve;
    }));
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => current,
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      const acquisition = harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      await vi.waitFor(() => expect(openRootedAgent).toHaveBeenCalledOnce());
      current = snapshot(alphaRoot, betaRoot, { relationshipEnabled: false });
      resolveAgent(lateAgent);

      await expect(acquisition).rejects.toMatchObject({ code: 'relationship_not_ready' });
      expect(lateAgent.stop).toHaveBeenCalledOnce();
      expect(lateAgent.stream.destroyed).toBe(true);
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains root custody while reconciliation waits for an aborted opener and closes its late agent', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-reconcile-pending-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    let current = snapshot(alphaRoot, betaRoot);
    const lateAgent = ownedRootedAgent();
    let openerSignal: AbortSignal | undefined;
    let resolveAgent!: (value: ReturnType<typeof ownedRootedAgent>) => void;
    const openRootedAgent = vi.fn(async (input: Readonly<{ signal?: AbortSignal }>) => {
      openerSignal = input.signal;
      return await new Promise<ReturnType<typeof ownedRootedAgent>>((resolve) => {
        resolveAgent = resolve;
      });
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => current,
      openRootedAgent,
    });
    let acquisition: ReturnType<typeof harness.authority.acquireWorkspaceSyncMachineIngress> | null = null;
    const canAcquireTargetRoot = async (): Promise<boolean> => {
      const probe = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'reconciliation-fence-probe',
        canonicalRoot: betaRoot,
        operation: 'handoff',
      });
      if ('kind' in probe) return false;
      await probe.release();
      return true;
    };
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      acquisition = harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      await vi.waitFor(() => expect(openRootedAgent).toHaveBeenCalledOnce());
      current = snapshot(alphaRoot, betaRoot, { relationshipEnabled: false });
      let reconciliationSettled = false;
      const reconciliation = harness.authority.reconcileRetainedBootstraps()
        .finally(() => { reconciliationSettled = true; });

      await vi.waitFor(() => expect(openerSignal?.aborted).toBe(true));
      const earlyReconciliationOutcome = await Promise.race([
        reconciliation.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 250)),
      ]);
      expect(earlyReconciliationOutcome).toBe('pending');
      expect(reconciliationSettled).toBe(false);
      await expect(canAcquireTargetRoot()).resolves.toBe(false);

      resolveAgent(lateAgent);
      await expect(acquisition).rejects.toMatchObject({ code: 'peer_unavailable' });
      await expect(reconciliation).resolves.toBeUndefined();
      expect(lateAgent.stream.destroyed).toBe(true);
      expect(lateAgent.stop).toHaveBeenCalledOnce();
      await expect(canAcquireTargetRoot()).resolves.toBe(true);
    } finally {
      if (typeof resolveAgent === 'function') resolveAgent(lateAgent);
      await acquisition?.catch(() => undefined);
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rebinds repeated handoffs to one retained relationship endpoint authority', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-rebind-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const openRootedAgent = vi.fn(async () => ownedRootedAgent());
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      await harness.authority.prepareBootstrapHere(prepareRequest({ bootstrapOperationId: 'handoff-1', transientRelationship: undefined, targetBootstrap: undefined }));
      await harness.authority.prepareBootstrapHere(prepareRequest({ bootstrapOperationId: 'handoff-2', transientRelationship: undefined, targetBootstrap: undefined }));

      const ingress = await harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      expect(openRootedAgent).toHaveBeenCalledTimes(1);
      await ingress.close();
      await expect(harness.authority.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: 'handoff-1',
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'abort',
      })).resolves.toEqual({ ok: true, released: false });
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rehydrates retained relationship ingress from settings and the exact final READY fact after restart', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-restart-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const currentSnapshot = () => snapshot(alphaRoot, betaRoot);
    const first = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-b',
      getProjectSnapshot: currentSnapshot,
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      openRootedAgent: async () => ownedRootedAgent(),
      bootstrap: {
        materializationDirectory,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
        materializeRemoteSeed: async () => ({ receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null }, bindPromotedTarget: async () => undefined, commit: async () => undefined, abort: async () => undefined }),
      },
    });
    try {
      await first.prepareBootstrapHere(prepareRequest());
      await first.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'relationship_committed',
      });
      await first.releaseAllRetainedBootstraps();

      const openRootedAgent = vi.fn(async () => ownedRootedAgent());
      const restarted = createWorkspaceSyncTargetAuthority({
        localServerId: 'server-1',
        localMachineId: 'machine-b',
        getProjectSnapshot: currentSnapshot,
        assertConflictResolutionAuthorized: async () => undefined,
        callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
        openRootedAgent,
        bootstrap: {
          materializationDirectory,
          rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
        },
      });
      await restarted.reconcileRetainedBootstraps();
      const ingress = await restarted.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      });
      expect(openRootedAgent).toHaveBeenCalledWith({
        operationId: relationshipId,
        role: 'beta',
        workspaceRefId: 'workspace-beta',
        canonicalRoot: await realpath(betaRoot),
        signal: expect.any(AbortSignal),
      });
      await ingress.close();
      await restarted.releaseAllRetainedBootstraps();
    } finally {
      await first.releaseAllRetainedBootstraps();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('retains the restart fence when READY cleanup fails and retries commit without aborting', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-restart-cleanup-retry-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await mkdir(alphaRoot, { recursive: true });
    const rootOwnershipManager = createWorkspaceRootOwnershipManager({ lockDirectory });
    const prepared = await workspaceSyncTargetBootstrap({
      rootPath: betaRoot,
      relationshipId,
      endpointRole: 'beta',
      targetWorkspaceRefId: 'workspace-beta',
      policyDigest: contentPolicy.policyDigest,
      contentSelection: 'all_files',
      materializationDirectory,
      rootOwnershipManager,
      createIfMissing: true,
      targetBootstrap: 'materialize_from_source_workspace',
      materializeSeed: async () => undefined,
    });
    await prepared.publishReady();
    await prepared.release();

    const cleanupFailure = new Error('injected restart cleanup failure');
    const commit = vi.fn();
    const abort = vi.fn();
    const restarted = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-b',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      openRootedAgent: async () => ownedRootedAgent(),
      bootstrap: {
        materializationDirectory,
        rootOwnershipManager,
        rehydrateMaterializationFromReceiptPath: async (input) => {
          const custody = await rehydrateWorkspaceTargetMaterializationFromReceiptPath(input);
          if (!custody) return null;
          return {
            receipt: custody.receipt,
            bindPromotedTarget: custody.bindPromotedTarget,
            commit: async () => {
              commit();
              if (commit.mock.calls.length === 1) throw cleanupFailure;
              await custody.commit();
            },
            abort: async () => {
              abort();
              await custody.abort();
            },
          };
        },
      },
    });
    try {
      await expect(restarted.reconcileRetainedBootstraps()).rejects.toBe(cleanupFailure);
      expect(commit).toHaveBeenCalledOnce();
      expect(abort).not.toHaveBeenCalled();

      const overlap = await rootOwnershipManager.tryAcquire({
        ownerId: 'restart-cleanup-overlap-probe',
        canonicalRoot: await realpath(betaRoot),
        operation: 'handoff',
      });
      expect(overlap).toMatchObject({ kind: 'overlap' });
      if (!('kind' in overlap)) await overlap.release();

      await expect(restarted.reconcileRetainedBootstraps()).resolves.toBeUndefined();
      expect(commit).toHaveBeenCalledTimes(2);
      expect(abort).not.toHaveBeenCalled();
      await expect(readdir(materializationDirectory)).resolves.toEqual([
        expect.stringMatching(/^[a-f0-9]{64}\.json$/u),
        expect.stringMatching(/\.ready\.json$/u),
      ]);
      await expect(restarted.releaseAllRetainedBootstraps()).resolves.toBeUndefined();
      expect(abort).not.toHaveBeenCalled();
    } finally {
      await restarted.releaseAllRetainedBootstraps().catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('uses nested use_existing for an exact READY Git retry instead of rematerializing from an unavailable source', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ready-git-retry-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    await writeFile(join(betaRoot, 'existing.txt'), 'existing');
    const prepareGitTarget = vi.fn(async ({ targetBootstrap }: { targetBootstrap: 'use_existing' | 'materialize_from_source_workspace' }) => {
      expect(targetBootstrap).toBe('use_existing');
    });
    const materializeRemoteSeed = vi.fn(async () => {
      throw Object.assign(new Error('source is unavailable'), { code: 'target_bootstrap_offline' });
    });
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { contentPolicy: gitContentPolicy }),
      prepareGitTarget,
      materializeRemoteSeed,
    });
    try {
      const prepared = await workspaceSyncTargetBootstrap({
        rootPath: betaRoot,
        relationshipId,
        endpointRole: 'beta',
        targetWorkspaceRefId: 'workspace-beta',
        policyDigest: gitContentPolicy.policyDigest,
        contentSelection: 'all_files',
        materializationDirectory: harness.materializationDirectory,
        rootOwnershipManager: harness.rootOwnershipManager,
        targetBootstrap: 'materialize_from_source_workspace',
        targetReplacementApproval: {
          v: 1,
          consequences: ['replace_nonempty_workspace_target'],
          serverId: 'server-1',
          machineId: 'machine-b',
          canonicalRoot: await realpath(betaRoot),
          rootFingerprint: await computeWorkspaceSyncRootFingerprint(await realpath(betaRoot)),
          operationId: handoffOperationId,
        },
        materializeSeed: async ({ canonicalRoot, materializationReceiptPath, originalTargetExists }) => {
          const materialization = await beginWorkspaceTargetMaterialization({
            targetPath: canonicalRoot,
            backupDirectoryPrefix: '.happier-sync-backup',
            receiptPath: materializationReceiptPath,
            originalTargetExists,
          });
          await mkdir(canonicalRoot);
          await writeFile(join(canonicalRoot, 'ready.txt'), 'committed');
          await materialization.custody.bindPromotedTarget();
          return materialization.custody;
        },
      });
      await prepared.publishReady();
      await prepared.release();

      const preflight = await harness.authority.preflightHandoffTargetReplacementHere({
        v: 1,
        serverId: 'server-1',
        machineId: 'machine-b',
        operationId: handoffOperationId,
        targetPath: betaRoot,
      });
      if (preflight.type !== 'approval_required') throw new Error('expected target replacement approval');
      await expect(harness.authority.prepareBootstrapHere(prepareRequest({
        transientRelationship: {
          v: 1,
          relationshipId,
          controllerMachineId: 'machine-a',
          alphaWorkspaceRefId: 'workspace-alpha',
          betaWorkspaceRefId: 'workspace-beta',
          mode: 'keep_both_in_sync',
          contentPolicy: gitContentPolicy,
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        policyDigest: gitContentPolicy.policyDigest,
        ...approvalBinding(preflight.approval),
      }))).resolves.toMatchObject({ state: 'ready' });

      expect(prepareGitTarget).toHaveBeenCalledOnce();
      expect(materializeRemoteSeed).not.toHaveBeenCalled();
      await expect(readFile(join(betaRoot, 'ready.txt'), 'utf8')).resolves.toBe('committed');
      await expect(readFile(join(betaRoot, 'existing.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readdir(harness.materializationDirectory)).resolves.toEqual([
        expect.stringMatching(/^[a-f0-9]{64}\.json$/u),
        expect.stringMatching(/\.ready\.json$/u),
      ]);
    } finally {
      await harness.authority.releaseAllRetainedBootstraps().catch(() => undefined);
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rolls back rehydrated materialization custody that has no exact final READY fact', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-restart-custody-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    await writeFile(join(betaRoot, 'original.txt'), 'original');
    const operationKey = createHash('sha256')
      .update('workspace-sync-bootstrap-v1\0')
      .update(relationshipId)
      .update('\0beta')
      .digest('hex');
    const materialization = await beginWorkspaceTargetMaterialization({
      targetPath: betaRoot,
      backupDirectoryPrefix: '.happier-sync-backup',
      receiptPath: join(materializationDirectory, `${operationKey}.json`),
      originalTargetExists: true,
    });
    await mkdir(betaRoot);
    await writeFile(join(betaRoot, 'promoted.txt'), 'promoted');
    await materialization.custody.bindPromotedTarget();

    const restarted = createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-b',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      bootstrap: {
        materializationDirectory,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
      },
    });
    try {
      await restarted.reconcileRetainedBootstraps();
      await expect(restarted.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: `rehydrated:${relationshipId}:beta`,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'relationship_committed',
      })).resolves.toEqual({ ok: true, released: false });
      await expect(readFile(join(betaRoot, 'promoted.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(betaRoot, 'original.txt'), 'utf8')).resolves.toBe('original');
      await expect(readFile(join(materializationDirectory, `${operationKey}.json`), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await restarted.releaseAllRetainedBootstraps().catch(() => undefined);
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects marker-based ingress rehydration when the workspace is no longer enrolled in this Home', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-restart-home-placement-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    const materializationDirectory = join(fixture, 'staging');
    const lockDirectory = join(fixture, 'locks');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    let betaServerId = 'server-1';
    const currentSnapshot = () => snapshot(alphaRoot, betaRoot, { betaServerId });
    const create = (openRootedAgent = vi.fn(async () => ownedRootedAgent())) => createWorkspaceSyncTargetAuthority({
      localServerId: 'server-1',
      localMachineId: 'machine-b',
      getProjectSnapshot: currentSnapshot,
      callMachineRpc: async () => { throw new Error('unexpected machine RPC'); },
      openRootedAgent,
      bootstrap: {
        materializationDirectory,
        rootOwnershipManager: createWorkspaceRootOwnershipManager({ lockDirectory }),
        materializeRemoteSeed: async () => ({ receipt: { v: 1, previousTargetName: null, originalTargetIdentity: null, promotedTargetIdentity: null, expectedBackupIdentity: null }, bindPromotedTarget: async () => undefined, commit: async () => undefined, abort: async () => undefined }),
      },
    });
    const first = create();
    try {
      await first.prepareBootstrapHere(prepareRequest());
      await first.releaseBootstrapHere({
        v: 1,
        bootstrapOperationId: relationshipId,
        targetWorkspaceRefId: 'workspace-beta',
        reason: 'relationship_committed',
      });
      await first.releaseAllRetainedBootstraps();
      betaServerId = 'server-2';
      const openRootedAgent = vi.fn(async () => ownedRootedAgent());
      const restarted = create(openRootedAgent);

      await expect(restarted.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'peer_unavailable' });
      expect(openRootedAgent).not.toHaveBeenCalled();
      await restarted.releaseAllRetainedBootstraps();
    } finally {
      await first.releaseAllRetainedBootstraps();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects retained ingress when the workspace enrollment moves to another Home', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-ingress-home-placement-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    let betaServerId = 'server-1';
    const openRootedAgent = vi.fn(async () => ownedRootedAgent());
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { betaServerId }),
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      betaServerId = 'server-2';

      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'peer_unavailable' });
      expect(openRootedAgent).not.toHaveBeenCalled();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('rejects ingress when the target root was replaced at the same path after bootstrap', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-root-replaced-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const openRootedAgent = vi.fn(async () => ownedRootedAgent());
    const harness = createAuthorityHarness({
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      openRootedAgent,
    });
    try {
      await harness.authority.prepareBootstrapHere(prepareRequest());
      await rm(betaRoot, { recursive: true, force: true });
      await mkdir(betaRoot, { recursive: true });

      await expect(harness.authority.acquireWorkspaceSyncMachineIngress({
        operationId: relationshipId,
        sourceMachineId: 'machine-a',
        targetMachineId: 'machine-b',
      })).rejects.toMatchObject({ code: 'root_changed' });
      expect(openRootedAgent).not.toHaveBeenCalled();
    } finally {
      await harness.authority.releaseAllRetainedBootstraps();
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('dispatches remote prepare/release through the machine RPC boundary and parses strict responses', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-remote-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await mkdir(alphaRoot, { recursive: true });
    const readyResult = {
      v: 1,
      bootstrapOperationId: 'bootstrap-op-1',
      targetWorkspaceRefId: 'workspace-beta',
      state: 'ready',
      created: true,
      rootFingerprint: 'b'.repeat(64),
      policyDigest: contentPolicy.policyDigest,
    };
    const callMachineRpc = vi.fn(async (input: Readonly<{ method: string }>) => (
      input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE
        ? { ok: true, released: true }
        : readyResult
    ));
    const harness = createAuthorityHarness({
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot),
      callMachineRpc,
    });
    try {
      const prepare = prepareRequest();
      await expect(harness.authority.prepareBootstrapAtTarget({ ...prepare, targetMachineId: 'machine-b' }))
        .resolves.toEqual(readyResult);
      expect(callMachineRpc).toHaveBeenCalledWith({
        machineId: 'machine-b',
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE,
        request: prepare,
      });
      await expect(harness.authority.releaseBootstrapAtTarget({
        v: 1, bootstrapOperationId: 'bootstrap-op-1', targetWorkspaceRefId: 'workspace-beta', reason: 'copy_committed',
        targetMachineId: 'machine-b',
      })).resolves.toEqual({ ok: true, released: true });
      expect(callMachineRpc).toHaveBeenCalledWith({
        machineId: 'machine-b',
        method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE,
        request: { v: 1, bootstrapOperationId: 'bootstrap-op-1', targetWorkspaceRefId: 'workspace-beta', reason: 'copy_committed' },
      });
      // A leaked path in a remote response is rejected by the strict result contract.
      callMachineRpc.mockImplementationOnce(async () => ({ ...readyResult, rootPath: '/leaked' }));
      await expect(harness.authority.prepareBootstrapAtTarget({ ...prepare, targetMachineId: 'machine-b' }))
        .rejects.toThrow();
      // A target machine that does not own the ref never reaches the transport.
      await expect(harness.authority.prepareBootstrapAtTarget({ ...prepare, targetMachineId: 'machine-c' }))
        .rejects.toMatchObject({ code: 'peer_unavailable' });
      expect(callMachineRpc).toHaveBeenCalledTimes(3);
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('serves a same-machine bootstrap prepare through the local authority', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'workspace-sync-authority-same-'));
    const alphaRoot = join(fixture, 'alpha');
    const betaRoot = join(fixture, 'beta');
    await Promise.all([mkdir(alphaRoot, { recursive: true }), mkdir(betaRoot, { recursive: true })]);
    const callMachineRpc = vi.fn(async () => {
      throw new Error('same-machine bootstrap must not use the machine RPC boundary');
    });
    const harness = createAuthorityHarness({
      localMachineId: 'machine-a',
      getProjectSnapshot: () => snapshot(alphaRoot, betaRoot, { betaMachineId: 'machine-a' }),
      callMachineRpc,
    });
    try {
      const prepared = await harness.authority.prepareBootstrapAtTarget({
        ...prepareRequest({ targetWorkspaceRefId: 'workspace-beta', endpointRole: 'beta', targetBootstrap: 'use_existing' }),
        targetMachineId: 'machine-a',
      });
      expect(prepared).toMatchObject({
        state: 'ready',
        targetWorkspaceRefId: 'workspace-beta',
        ownershipHandles: [expect.objectContaining({
          owner: expect.objectContaining({ ownerId: relationshipId, operation: 'bootstrap' }),
        })],
      });
      await expect(harness.rootOwnershipManager.tryAcquire({
        ownerId: relationshipId, canonicalRoot: betaRoot, operation: 'sync',
      })).resolves.toMatchObject({ kind: 'overlap', existing: { ownerId: relationshipId } });
      await expect(stat(betaRoot)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      expect(callMachineRpc).not.toHaveBeenCalled();
      await harness.authority.releaseAllRetainedBootstraps();
      const replacement = await harness.rootOwnershipManager.tryAcquire({
        ownerId: 'replacement', canonicalRoot: betaRoot, operation: 'sync',
      });
      expect('kind' in replacement).toBe(false);
      if (!('kind' in replacement)) await replacement.release();
    } finally {
      await harness.cleanup();
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
