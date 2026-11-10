import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { ApprovalRequestV2Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { SessionSendUserTextInputSchema } from '@happier-dev/protocol/actions/specs/session/messages';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createCliActionDeps } from '../createCliActionDeps';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// #117 retained a requester cause on each deferred agent approval. That makes
// its host-produced result protected input even for a plain Account.
it.each([
  { actionId: 'deployments.environments.create', actionArgs: { requestKey: 'create', contentArtifactId: 'definition',
    contentHeaderVersion: 1, contentBodyVersion: 1, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.templates.instantiate', actionArgs: { mode: 'apply', machineId: 'machine',
    projectSourceId: 'source', templateRef: { sourceId: 'data-services', itemId: 'redis', version: '0.0.0' } }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.domains.add', actionArgs: { environmentId: 'environment', domainId: 'app.invalid',
    expectedRevision: 2, requestKey: 'domain', content: { hostname: 'app.invalid', target: { service: 'web', containerPort: 80 } } }, failed: true, restrictedCredential: false },
  { actionId: 'projects.sources.update', actionArgs: { sourceId: 'source', expectedRevision: 1, patch: { name: 'Edited' } }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.teardown', actionArgs: { environmentId: 'environment', requestKey: 'teardown', removeEnvironment: true }, failed: false, restrictedCredential: false },
  { actionId: 'deployments.environments.create', actionArgs: { requestKey: 'restricted-create', contentArtifactId: 'definition',
    contentHeaderVersion: 1, contentBodyVersion: 1 }, failed: false, restrictedCredential: true },
] as const)('settles $actionId delivery with its own credential custody ($restrictedCredential)', async scenario => {
  const { actionId, actionArgs, failed } = scenario;
  const canRelay = !scenario.restrictedCredential;
  const accountId = 'owner', serverId = 'home', machineId = 'machine', sessionId = 'cmv3approvaldeliveryaaaa';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null, credentialProvenance: canRelay ? 'stored_session' as const : 'api_token' as const };
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json(FeaturesResponseSchema.parse({ features: {},
    capabilities: { serverIdentity: { serverIdentityId: serverId }, encryption: {
      storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }))));
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (url.endsWith('/v1/artifacts/approval')) return { status: 200, data: artifact };
    if (url.includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'plain', machineId, metadata: JSON.stringify({ machineId }) }) } };
    throw new Error(`Unexpected HTTP path: ${new URL(url).pathname}`);
  });
  const delivered = new Set<string>();
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (url.endsWith('/v1/artifacts/read')) return { status: 200, data: artifactReadResponse(body,
      id => id === artifact.id ? artifact : null).data };
    expect(new URL(url).pathname).toBe('/v1/actions/session.message.send');
    const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
    if (envelope.v !== 1) throw new Error('Plain Account fixture');
    expect(envelope.target).toEqual({ kind: 'session', sessionId });
    const input = SessionSendUserTextInputSchema.parse(envelope.input);
    expect(input).toMatchObject({ sessionId, localId: 'approval-result:approval', reply: 'none' });
    if (typeof input.message !== 'string') throw new Error('Missing approval outcome');
    expect(JSON.parse(input.message)).toMatchObject({ actionId, status: failed ? 'failed' : 'executed' });
    if (!input.localId) throw new Error('Missing stable outcome identity');
    const status = delivered.has(input.localId) ? 'alreadyAccepted' : 'accepted';
    delivered.add(input.localId);
    return { status: 200, data: { v: 1, actionId: 'session.message.send', requestId: envelope.requestId,
      execution: { ok: true, result: { status, localId: input.localId } } } };
  });
  const status = failed ? 'failed' : 'executed';
  const stored = ApprovalRequestV2Schema.parse({ v: 2, status, createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'agent' }, requestedSurface: 'agent', approval: { flow: 'deferred', result: 'required' },
    actionId, actionArgs, summary: 'Reviewed deployment change',
    decision: { kind: 'approve', decidedAtMs: 1, authority: 'present_user' },
    execution: failed ? { executedAtMs: 2, ok: false, errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable' }
      : { executedAtMs: 2, ok: true, result: { ok: true } },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', accountId, serverId, serverIdentityId: serverId,
      sessionId, machineId, caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      actionId, requestId: 'original', actionRequestAttributionV1: {
        requestRef: 'original-person-input', requester: { serverId, accountId }, persona: { serverId, sessionId }, origin: null } } });
  const artifact = { id: 'approval', ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(stored)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(stored) }),
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 2 };
  const deps = createCliActionDeps({ credentials, token, mode: 'plain', ctx: null, sessionId: '', serverId,
    serverIdentityId: serverId, serverHttpBaseUrl: 'https://approval-home.test' });
  const executor = createActionExecutor(deps);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await executor.execute('approval.request.decide', {
      artifactId: 'approval', decision: 'approve' }, { surface: 'cli', authority: 'present_user', runtimeAccountId: accountId,
      serverId, serverIdentityId: serverId });
    expect(result, JSON.stringify(result)).toMatchObject(canRelay
      ? { ok: true, result: { status } }
      : { ok: false, errorCode: 'session_input_target_unavailable' });
  }
  expect([...delivered]).toEqual(canRelay ? ['approval-result:approval'] : []);
});
