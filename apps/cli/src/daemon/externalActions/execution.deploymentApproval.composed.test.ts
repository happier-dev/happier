import axios from 'axios';
import * as syncClient from '@happier-dev/sync-client';
import { z } from 'zod/mini';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { OwnServerDeploymentInputBasisV1Schema, createDeploymentReceiptArtifactHeaderV1,
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { ApprovalRequestV2Schema, DeploymentChildRpcV1Schema, DeploymentReceiptResultV1Schema } from '@happier-dev/protocol';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, createDeploymentCandidatePublicationV1,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); resetServerFeaturesClientForTests(); });

it.each(['missing candidate', 'admitted receipt'] as const)('replays private native deployment with its original admission: %s', async scenario => {
  const homeId = 'srv_portableHome';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const h = await createHarness('deployments.deploy', 'ask', false, homeId);
  onTestFinished(installAxiosRequestMethodAdapter());
  try {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const input = { serverId: homeId, environmentId: 'environment-staging', targetLinkId: 'target-link',
      expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'original-deploy',
      contentArtifactId: 'artifact-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const envelope = { v: 1 as const, requestId: 'original-deploy', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-deployment-admission', binding: {
      serverIdentityId: homeId, accountId: 'account', custodianAccountId: 'account',
      authentication: { kind: 'account', tokenEpoch: 1 }, admittedMachineRole: 'manage',
      accountEncryptionMode: 'plain', actionId: 'deployments.deploy', requestId: envelope.requestId, deploymentChildRoot: true,
      machineId: 'machine', installationId: h.installation.installationId, target, environmentId: input.environmentId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'account', serverIdentityId: homeId,
        actionId: 'deployments.deploy', requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        environmentId: input.environmentId, source: { id: 'source-app', revision: 1 } }) } });
    const origin = buildApprovalExecutionOriginV1({ actionId: 'deployments.deploy', input, admittedInput: input, targetSessionId: null,
      context: { surface: 'ui', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'srv_n2', serverIdentityId: homeId, runtimeAccountId: 'account',
        actionRequestId: envelope.requestId, externalActionTarget: target,
        externalActionExecutionAuthorization: authorization, originalActionEnvelope: envelope,
        signExternalActionApprovalInput: ({ actionId, input, target, authorization: root }) =>
          signExternalActionApprovalInputV1({ authorizationToken: root.token, actionId, input, target,
            privateKey: Buffer.from(h.installation.privateKey, 'base64url') }) } });
    const store = createCliApprovalsArtifactStore({ credentials: { token, encryption: null }, serverId: 'srv_n2',
      serverHttpBaseUrl: 'https://home.example.test' });
    await store.approvalsCreate!({ request: ApprovalRequestV2Schema.parse({ v: 2, status: 'open',
      createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'system' }, actionId: 'deployments.deploy',
      actionArgs: input, summary: 'Deploy', executionOriginV1: origin }) });
    const privateRequest = await h.approval();
    expect(privateRequest.executionOriginV1.externalActionExecutionAuthorization?.token === authorization.token).toBe(true);
    expect(privateRequest.executionOriginV1.originalActionEnvelope).toEqual(envelope);
    const environment = createDeploymentEnvironmentDetailV1();
    environment.environment = { ...environment.environment, serverId: homeId, controllerMachineId: 'machine', buildMachineId: 'machine',
      owner: { kind: 'account', accountId: 'account' } };
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['runtime'];
    link.members = [{ machineId: 'runtime', installationId: 'runtime-installation', state: 'active' }];
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = { ...receipt.deployment, state: 'queued', requestedByAccountId: 'account',
      startedAtMs: undefined, settledAtMs: undefined, requestKey: input.requestKey,
      acceptedExecution: { v: 1, controller: { machineId: 'machine', installationId: h.installation.installationId },
        builder: { machineId: 'machine', installationId: h.installation.installationId } } };
    const memberBasis = OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
      environmentId: input.environmentId, environmentRevision: 1, targetLinkId: input.targetLinkId, targetLinkRevision: 1,
      sourceIntent: receipt.content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [],
      physicalProjectName: 'approved-deploy', toolVersion: '2.40.1', services: ['app'], profiles: [], bindings: [],
      images: receipt.content.images, ownServer: environment.content.ownServer,
      members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })) });
    receipt.content = { ...receipt.content, machines: ['runtime'], buildMachineId: 'machine', machineResults: [],
      ownServer: { approvedInputBasis: { ...memberBasis, runtimeProjections: [{ machineId: 'runtime', installationId: 'runtime-installation',
        manifestFingerprint: memberBasis.manifestFingerprint, configInputDigests: memberBasis.configInputDigests,
        physicalProjectName: memberBasis.physicalProjectName, toolVersion: memberBasis.toolVersion,
        services: memberBasis.services, profiles: memberBasis.profiles, platform: 'linux/amd64' }] } } };
    const documents = new Map<string, Record<string, unknown>>();
    const put = (id: string, header: Record<string, unknown>, content: unknown) => documents.set(id, {
      id, ownerAccountId: 'account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(header),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    put(environment.environment.contentArtifactId, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }, environment.content);
    put(link.contentArtifactId, { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Runtime' }, {});
    put(input.contentArtifactId, createDeploymentReceiptArtifactHeaderV1('Deploy', receipt.content), receipt.content);
    put(receipt.deployment.contentArtifactId, createDeploymentReceiptArtifactHeaderV1('Deploy', receipt.content), receipt.content);
    const reads: boolean[] = [];
    let admittedReceipt: ReturnType<typeof DeploymentReceiptResultV1Schema.parse> | undefined;
    let originalAdmissionAtDeploy = false;
    let signedDeploy = false;
    const baseGet = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === '/v1/deployments/environments/environment-staging/deployments') {
        expect(args[1]?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
        return { status: 200, data: { ok: true, items: [], nextCursor: null } };
      }
      if (path === '/v1/deployments/environments/environment-staging') {
        return { status: 200, data: { ok: true, environment: environment.environment,
          targetLinks: environment.targetLinks.map(item => item.targetLink) } };
      }
      if (path.endsWith(`/receipts/${receipt.deployment.id}`)) return { status: 200,
        data: { ok: true, deployment: receipt.deployment } };
      if (path === '/v1/machines/runtime') return { status: 200, data: { machine: { id: 'runtime', kind: 'persistent', active: true,
        revokedAt: null, replacedByMachineId: null, storageMode: 'plain', installationId: 'runtime-installation',
        installationPublicKey: Buffer.from(h.installation.publicKey, 'base64url').toString('base64'),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
      if (path === '/v1/artifacts/artifact-candidate') {
        reads.push(args[1]?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === authorization.token);
        if (scenario === 'missing candidate') return { status: 404, data: { error: 'not_found' } };
      }
      if (path.startsWith('/v1/artifacts/') && documents.has(path.split('/').at(-1)!))
        return { status: 200, data: documents.get(path.split('/').at(-1)!) };
      return baseGet(...args);
    });
    const basePost = vi.mocked(axios.post).getMockImplementation()!;
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path.endsWith('/deploy')) {
        const headers = args[2]?.headers;
        originalAdmissionAtDeploy = headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === authorization.token;
        signedDeploy = verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'deployments.deploy', target,
          installationId: h.installation.installationId, requestId: envelope.requestId, method: 'POST', path, body: args[1],
          signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]), publicKey: Buffer.from(h.installation.publicKey, 'base64url') });
        admittedReceipt = DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: input.environmentId,
          deploymentId: receipt.deployment.id, revision: 1, deploymentRevision: 1, state: 'queued' });
        return { status: 200, data: admittedReceipt };
      }
      return basePost(...args);
    });
    const createSocket = vi.mocked(syncClient.createHappierSocket).getMockImplementation()!;
    vi.mocked(syncClient.createHappierSocket).mockImplementation(params => {
      const connection = createSocket(params);
      const acknowledge = connection.socket.emitWithAck.bind(connection.socket);
      // Only the remote native Machine reply is substituted; local native
      // preparation, private approval replay and deployment admission stay real.
      vi.spyOn(connection.socket, 'emitWithAck').mockImplementation(async (event, ...args) => {
        if (event === SOCKET_RPC_EVENTS.CALL) {
          const packet = z.object({ method: z.string(), params: z.unknown() }).parse(args[0]);
          if (packet.method === `runtime:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`) {
            expect(DeploymentChildRpcV1Schema.parse(packet.params).kind).toBe('review');
            return { ok: true, result: { inputBasis: memberBasis, reviewedEffect: { machineId: 'runtime' }, runtimePlatform: 'linux/amd64' } };
          }
        }
        return acknowledge(event, ...args);
      });
      return connection;
    });
    await h.decide('approve');
    const settled = await h.approval();
    expect(reads.length, JSON.stringify(settled.execution)).toBeGreaterThan(0);
    expect(reads.every(Boolean)).toBe(true);
    if (scenario === 'admitted receipt') {
      expect(admittedReceipt, JSON.stringify(settled.execution)).toMatchObject({ ok: true, deploymentId: receipt.deployment.id });
      expect(originalAdmissionAtDeploy).toBe(true);
      expect(signedDeploy).toBe(true);
      // Admission is proven independently of the deliberately absent operation owner.
      expect(settled.execution).toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
    }
  } finally { await h.close(); }
}, 120_000);
