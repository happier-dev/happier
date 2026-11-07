import fastify from 'fastify';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ApprovalRequestV2Schema, encodeBase64, encodePlainArtifactStoredContent,
  projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { encryptWithDataKey } from '@/api/encryption';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { prepareExternalActionRequesterAccountAuthorizationWithEnvelope } from '@/api/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { registerAccountArtifactRoutes, registerAccountHomeHttp } from './widgetApproval.testkit';

afterEach(() => vi.restoreAllMocks());

it.each(['plain', 'e2ee'] as const)('projects a supplied signed Session-agent origin into a %s update preview and approval Artifact', async mode => {
  const app = fastify();
  const endpoint = 'http://template-update-approval.test';
  const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
  const accountId = 'update-owner';
  const homeId = 'srv_template_update';
  const machineId = 'update-machine';
  const installationId = 'update-installation';
  // This test supplies the signed origin and signer. It exercises projection
  // and approval storage, not the runner that produces that authority.
  const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
  const machine = { id: machineId, kind: 'persistent', active: true,
    revokedAt: null, replacedByMachineId: null, installationId,
    installationPublicKey: encodeBase64(keys.publicKey),
    access: { custodian: { accountId, displayName: 'Template owner' }, role: 'manage', resourceMode: mode, accessState: 'ready' } };
  app.get(`/v1/machines/${machineId}`, async () => ({ machine }));
  app.get('/v1/machines', async () => [machine]);
  const sessionId = 'c000000000000000000000011';
  const sourceId = '80f7dabe-1f05-44b7-8e44-d98f2127f523';
  const baseId = '70f7dabe-1f05-44b7-8e44-d98f2127f523';
  const requests: string[] = [];
  app.addHook('onRequest', async request => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method !== 'GET' || ![sourceId, baseId].some(id => request.url === `/v1/artifacts/${id}`)) return;
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBeUndefined();
    expect(request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]).toBeUndefined();
  });
  const machineKey = new Uint8Array(32).fill(26);
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 7,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: mode === 'plain' ? null : { type: 'dataKey' as const,
    machineKey, publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
  const resource = await createResourceDataKey({ credentials, mode });
  const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
    : encodeBase64(encryptWithDataKey(value, resource.dataKey));
  const features = registerAccountHomeHttp(app, { accountId, serverId: homeId, encryptionMode: mode });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ...features,
    features: { ...features.features, bots: { enabled: true } } }));
  const artifacts = registerAccountArtifactRoutes(app, accountId, { encryptionMode: mode });
  const base: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: '', releasedAtMs: 1,
    content: { v: 1, identity: { name: 'Helper', description: '' }, instructions: { markdown: 'original' },
      memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
  const upstream: BotTemplateReleaseV1 = { ...base, version: '1.1.0',
    content: { ...base.content, instructions: { markdown: 'updated instructions' } } };
  for (const [id, release] of [[baseId, base], [sourceId, upstream]] as const) {
    const content = { v: 1 as const, state: 'released' as const, release };
    artifacts.seed(id, encode(projectBotTemplateArtifactHeaderV1(content)), encode({ body: JSON.stringify(content) }),
      resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
      id === sourceId ? { ownerAccountId: 'upstream-author', access: 'view' } : undefined);
  }
  const metadata = createTestMetadata({ machineId, work: { templateInstance: { v: 1,
    source: { kind: 'artifact', serverId: homeId, artifactId: sourceId }, acceptedVersion: base.version,
    acceptedBase: { serverId: homeId, artifactId: baseId }, skillIds: {}, mcpServerIds: {}, follow: true } } });
  app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({ id: sessionId,
    encryptionMode: mode, metadata: resource.mode === 'plain' ? JSON.stringify(metadata) : encode(metadata),
    dataEncryptionKey: resource.mode === 'plain' ? null : resource.dataEncryptionKey,
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } }) }));
  const input = { sessionRef: { serverId: homeId, sessionId }, expectedVersion: upstream.version,
    expectedRevision: { headerVersion: 1, bodyVersion: 1 },
  };
  const target = { kind: 'machine' as const, machineId };
  const requestId = `agent-update-${mode}`;
  const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 }, sourceTurnId: 'update-turn',
    callerPermissionMode: 'default', causalPermissionAuthority: null, requestId });
  const authentication = { kind: 'account' as const, tokenEpoch: 7 };
  let wire = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `signed-update-${mode}`, binding: {
    accountId, authentication, serverIdentityId: homeId,
    machineId, custodianAccountId: accountId, installationId, actionId: 'template.updates.apply', admittedMachineRole: 'manage',
    requestId, target, accountEncryptionMode: mode, sessionActionOrigin,
    sessionActionSource: { machineId, installationId }, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  app.post(bindExternalActionExecutionAuthorizationVerifyHttpPathV1('template.updates.apply'), async () => ({ ok: true }));
  app.post('/v1/actions/template.updates.apply/execution-authorization', async request => {
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.body);
    wire = ExternalActionExecutionAuthorizationV1Schema.parse({ ...wire, binding: { ...wire.binding,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope) } });
    return wire;
  });
  const lifetime = new AbortController();
  try {
    const prepared = await prepareExternalActionRequesterAccountAuthorizationWithEnvelope({
      actionId: 'template.updates.apply', input, requestId, target, machineId, sourceMachineId: machineId,
      accountId, accountEncryptionMode: mode, tokenEpochHint: 7, token,
      ...(resource.mode === 'e2ee' ? { material: { type: 'dataKey' as const, machineKey } } : {}),
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, installationId,
      privateKey: keys.secretKey, sessionActionOrigin, signal: lifetime.signal });
    const authorization = prepared?.authorization;
    const envelope = prepared?.envelope;
    expect(authorization?.requesterAccountProjection).toBeUndefined();
    if (!authorization || !envelope) throw new Error('requester_authorization_unavailable');
    const policy = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {
      'template.updates.apply': { approvalRequiredSurfaces: ['agent'] } } }), getAccountSettings: () => ({}) };
    const { executor } = createCliActionExecutorHarness({ token, credentials, sessionId,
      ...(resource.mode === 'plain' ? { mode: 'plain' as const, ctx: null }
        : { mode: 'e2ee' as const, ctx: { encryptionKey: resource.dataKey, encryptionVariant: 'dataKey' as const } }),
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: endpoint, actionsSettingsProvider: policy,
      externalActionMachineRequestPrivateKey: keys.secretKey, externalActionMachineInstallationId: installationId,
    });
    const result = await runWithServerHttpBaseUrl(endpoint, () => executor.execute('template.updates.apply', input, {
      surface: 'agent', authority: 'account_automation', actionCaller: sessionActionOrigin.caller,
      defaultSessionId: sessionId, serverId: homeId, serverIdentityId: homeId, runtimeAccountId: accountId,
      callerPermissionMode: 'default', causalPermissionAuthority: null,
      sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' },
      actionRequestId: envelope.requestId, externalActionExecutionAuthorization: authorization,
      externalActionTarget: target, originalActionEnvelope: envelope, signal: lifetime.signal,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, input: args.input, target: args.target, privateKey: keys.secretKey,
        requesterConfirmation: args.requesterConfirmation, sessionTargetsV1: args.sessionTargetsV1 }),
    }));
    expect(result.ok, JSON.stringify({ result, requests })).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const { artifactId: approvalId } = ActionApprovalRequestCreatedResultSchema.parse(result.result);
    const stored = await runWithServerHttpBaseUrl(endpoint, () => createCredentialedAccountArtifactStore(credentials)
      .read(approvalId, { prepareRecipients: false, includeSharedAudience: false }));
    const approval = ApprovalRequestV2Schema.parse(JSON.parse(stored!.body as string));
    expect(approval).toMatchObject({ actionId: 'template.updates.apply', createdBy: { surface: 'agent', sessionId } });
    expect(approval.preview).toMatchObject({ hostReviewedContent: { offer: 'available',
      upstream: { release: { version: '1.1.0' } }, instance: { acceptedVersion: '1.0.0' },
    } });
  } finally { lifetime.abort(); restore(); await app.close(); }
});
