import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import * as owner from './externalActionExecutionAuthorization';

afterEach(() => vi.restoreAllMocks());

it('continues the admitted Session leaf with its exact child, requester and installed source proof', async () => {
  const keys = nacl.sign.keyPair();
  const caller = { kind: 'session' as const, sessionId: 'leaf-session', starterDepth: 2, turnDepth: 3 };
  const attribution = { requestRef: 'original-input', requester: { serverId: 'home', accountId: 'requester' },
    persona: { serverId: 'home', sessionId: 'origin-session' }, origin: null };
  const sessionLeaf = { accountId: 'bob', runId: 'run', invocationId: 'leaf-invocation', sessionId: caller.sessionId,
    authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
    actionRequestAttributionV1: attribution };
  const context = { surface: 'agent' as const, authority: 'account_automation' as const,
    actionCaller: caller, actionRequestId: 'fresh-child', executionRunWorkflowRunId: 'run', workspaceWrites: 'deny' as const };
  const target = { kind: 'machine' as const, machineId: 'publisher' };
  const actionId = 'workflow.definition.create';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
    updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null } });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
    if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(raw);
    expect(request.workflowActionOrigin).toEqual({ runId: 'run', requestId: 'fresh-child', sessionLeaf: {
      invocationId: 'leaf-invocation', caller, authorization: sessionLeaf.authorization,
      workspaceWrites: 'deny', actionRequestAttributionV1: attribution } });
    expect(request.envelope).toMatchObject({ v: 1, input: { definition: 'child-input' } });
    expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: request.installationProof!, payload: {
      version: 1, machineId: 'publisher', installationId: 'installed', accountId: 'bob', externalActionOrigin: {
        homeId: 'srv_home', actionId, requestId: 'fresh-child', origin: request.workflowActionOrigin!,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } })).toBe(true);
    return { status: 200, data: { v: 1, token: 'home-proof', binding: { accountId: 'bob', custodianAccountId: 'bob',
      authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain', serverIdentityId: 'srv_home',
      machineId: 'publisher', installationId: 'installed', actionId, requestId: 'fresh-child', target,
      workflowActionOrigin: request.workflowActionOrigin,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) } } };
  });
  const input = { credentials: { token, encryption: null }, context, sessionLeaf, actionId,
    input: { definition: 'child-input' }, target, machineId: 'publisher', serverId: 'home', serverIdentityId: 'srv_home',
    serverHttpBaseUrl: 'https://home.test', installationId: 'installed', privateKey: keys.secretKey };
  const prepared = await owner.prepareInstalledWorkflowActionAuthorizationWithEnvelope(input);
  expect(prepared?.envelope).toMatchObject({ requestId: 'fresh-child', target, input: input.input });
  const result = prepared?.authorization;
  expect(result).toMatchObject({ binding: { workflowActionOrigin: { sessionLeaf: { caller, actionRequestAttributionV1: attribution } } } });
  expect(get).toHaveBeenCalledTimes(1);
  for (const sessionLeaf of [{ ...input.sessionLeaf, sessionId: 'wrong-session' },
    { ...input.sessionLeaf, runId: 'unadmitted-run' }, { ...input.sessionLeaf, accountId: 'foreign-account' }]) {
    expect(await owner.prepareInstalledWorkflowActionAuthorization({ ...input, sessionLeaf })).toBeNull();
  }
  expect(get).toHaveBeenCalledTimes(1);
  // Refusals settle before the existing Home boundary, without a second Run admission.
  expect(post.mock.calls.filter(([url]) => !String(url).endsWith('/verify'))).toHaveLength(1);
});
