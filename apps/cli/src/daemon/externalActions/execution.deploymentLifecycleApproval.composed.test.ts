import axios from 'axios';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { createHarness, resetFilesystemApprovalSocketBoundary } from './executeExternalAction.filesystemApprovals.testkit';

afterEach(() => { vi.restoreAllMocks(); resetFilesystemApprovalSocketBoundary(); resetServerFeaturesClientForTests(); });

it.each(['deployments.environments.delete', 'deployments.targets.unlink', 'deployments.environments.controller.set'] as const)(
  'public signed approval decides %s with the original requester HTTP custody', async actionId => {
  const homeId = 'srv_portableHome';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const h = await createHarness(actionId, 'ask', false, homeId);
  onTestFinished(installAxiosRequestMethodAdapter());
  try {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const input = { serverId: homeId, environmentId: 'environment-staging', expectedRevision: 4,
      ...(actionId === 'deployments.environments.controller.set' ? { controllerMachineId: 'machine' }
        : { requestKey: 'dispose-environment', detachKeepRunning: true,
            ...(actionId === 'deployments.targets.unlink' ? { targetLinkId: 'target-staging', expectedTargetLinkRevision: 1 } : {}) }) };
    const envelope = { v: 1 as const, requestId: 'original-delete', target, input };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-delete-admission', binding: {
      serverIdentityId: homeId, accountId: 'account', custodianAccountId: 'account',
      authentication: { kind: 'terminal', tokenEpoch: 1 }, admittedMachineRole: 'manage',
      accountEncryptionMode: 'plain', actionId, requestId: envelope.requestId,
      machineId: 'machine', installationId: h.installation.installationId, target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
    const origin = buildApprovalExecutionOriginV1({ actionId, input, admittedInput: input, targetSessionId: null,
      context: { surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
        serverId: 'srv_n2', serverIdentityId: homeId, runtimeAccountId: 'account', actionRequestId: envelope.requestId,
        externalActionTarget: target, externalActionExecutionAuthorization: authorization, originalActionEnvelope: envelope,
        signExternalActionApprovalInput: ({ actionId, input, target, authorization: root }) =>
          signExternalActionApprovalInputV1({ authorizationToken: root.token, actionId, input, target,
            privateKey: Buffer.from(h.installation.privateKey, 'base64url') }) } });
    const store = createCliApprovalsArtifactStore({ credentials: { token, encryption: null }, serverId: 'srv_n2',
      serverHttpBaseUrl: 'https://home.example.test' });
    const created = await store.approvalsCreate!({ request: ApprovalRequestV2Schema.parse({ v: 2, status: 'open',
      createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId,
      actionArgs: input, summary: 'Delete', executionOriginV1: origin }) });
    const basePost = vi.mocked(axios.post).getMockImplementation()!;
    const baseGet = vi.mocked(axios.get).getMockImplementation()!;
    const environment = createDeploymentEnvironmentDetailV1();
    vi.mocked(axios.get).mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === `/v1/deployments/environments/${input.environmentId}`) {
        return { status: 200, data: { ok: true, environment: { ...environment.environment, id: input.environmentId },
          targetLinks: environment.targetLinks.map(item => item.targetLink) } };
      }
      return baseGet(...args);
    });
    let signedEffect = false;
    const spec = getActionSpec(actionId);
    if (!spec.serverTransport) throw new Error('Missing lifecycle HTTP transport');
    const mutationPath = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
      inputSchema: spec.inputSchema, input }).path;
    const result = { ok: true, environmentId: input.environmentId, revision: 5,
      ...(actionId === 'deployments.environments.controller.set' ? {} : { detached: true }),
      ...(actionId === 'deployments.targets.unlink' ? { targetLinkId: 'target-staging', targetLinkRevision: 2 } : {}) };
    vi.mocked(axios.post).mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === mutationPath) {
        const headers = args[2]?.headers;
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
        signedEffect = verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: actionId,
          target, installationId: h.installation.installationId, requestId: envelope.requestId, method: 'POST', path,
          body: args[1], signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]),
          publicKey: Buffer.from(h.installation.publicKey, 'base64url') });
        return { status: 200, data: result };
      }
      return basePost(...args);
    });
    const decided = await h.run({ artifactId: created.artifactId, decision: 'approve', serverIdentityId: homeId,
      originServerId: 'srv_n2' }, 'ui', false, 'present_user', 'approval.request.decide', 'public-delete-decision');
    const settled = await h.approval();
    expect(settled, JSON.stringify(decided)).toMatchObject({ status: 'executed', execution: { ok: true, result } });
    expect(signedEffect).toBe(true);
  } finally { await h.close(); }
}, 120_000);


it.each([false, true])('settles a Source refusal using its producer effect evidence (attempted=%s)', async producerAttempted => {
  const h = await createHarness('projects.sources.delete', 'ask');
  try {
    const pending = await h.run({ serverId: 'srv_n2', sourceId: 'source', expectedRevision: 2 }, 'ui');
    expect(pending).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const before = vi.mocked(axios.request).getMockImplementation()!;
    let refusedRequests = 0;
    // Home HTTP is the boundary: this is the real Source DELETE route's
    // schema-valid 404 after another request has deleted the reviewed Source.
    vi.mocked(axios.request).mockImplementation(async (...args) => {
      const request = args[0];
      if (typeof request !== 'string' && request.method === 'DELETE'
        && new URL(request.url!).pathname === '/v1/projects/sources/source') {
        refusedRequests++;
        return { status: 404, data: { ok: false, error: 'source_unavailable',
          ...(producerAttempted ? { effectAttempted: true } : {}) } };
      }
      return before(...args);
    });
    const expected = { status: 'failed', execution: { ok: false, errorCode: 'source_unavailable', effectAttempted: producerAttempted } };
    expect(await h.decide('approve')).toMatchObject({ ok: true, result: expected });
    expect(await h.approval()).toMatchObject(expected);
    // Repeated approval consumes the same typed receipt, without another DELETE.
    expect(await h.decide('approve')).toMatchObject({ ok: true, result: expected });
    expect(refusedRequests).toBe(1);
  } finally { await h.close(); }
}, 120_000);
