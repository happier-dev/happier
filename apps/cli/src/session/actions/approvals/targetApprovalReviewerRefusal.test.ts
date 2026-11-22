import { afterEach, expect, it } from 'vitest';
import fastify from 'fastify';
import {
  ApprovalRequestV2Schema,
  FeaturesResponseSchema,
  TargetActionApprovalRequestV1Schema,
} from '@happier-dev/protocol';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function storedCredentials(kind: 'terminal' | 'account') {
  const claims = {
    sub: 'account-1',
    tokenEpoch: 7,
    provenance: {
      v: 1,
      kind,
      authority: kind === 'terminal' ? 'account_automation' : 'present_user',
    },
  };
  return {
    token: `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
    encryption: null,
    credentialProvenance: 'stored_session',
  } as const;
}

// Home is the network boundary: Artifact rows, Account mode and the mint route
// are fixtures; the deciding executor, Artifact codec and replay owner stay real.
async function startHome() {
  const app = fastify();
  const rows = new Map<string, Record<string, unknown>>();
  const posts: string[] = [];
  const features = FeaturesResponseSchema.parse({
    features: {},
    capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
  });
  app.get('/v1/features', async () => features);
  app.get('/v1/features/authenticated', async () => features);
  app.get('/v1/account/encryption', async () => ({
    mode: 'plain',
    updatedAt: 1,
  }));
  app.get('/v1/account/profile', async () => ({ id: 'account-1' }));
  app.get<{ Params: { id: string } }>(
    '/v1/artifacts/:id',
    async (request, reply) =>
      rows.get(request.params.id) ??
      reply.code(404).send({ error: 'not_found' }),
  );
  app.post<{ Body: { id: string } & Record<string, unknown> }>(
    '/v1/artifacts',
    async (request) => {
      const row = {
        ...request.body,
        ownerAccountId: 'account-1',
        access: 'owner',
        encryptionMode: 'plain',
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      rows.set(row.id, row);
      return row;
    },
  );
  app.addHook('onRequest', async (request) => {
    if (request.method !== 'GET')
      posts.push(`${request.method} ${request.url}`);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture Home');
  return { url: `http://127.0.0.1:${address.port}`, posts };
}

// A daemon-held contributed Ask (the #177 heartbeat rotate shape).
const request = TargetActionApprovalRequestV1Schema.parse({
  v: 1,
  kind: 'plugin_target_action',
  status: 'open',
  createdAtMs: 1,
  updatedAtMs: 1,
  createdBy: { surface: 'cli' },
  requestedSurface: 'cli',
  qualifiedActionId: 'happier.machine.services/actions/health/heartbeat/manage',
  input: {
    operation: 'rotate',
    sourceInstanceId: 'health:source',
    checkId: 'heartbeat',
    webhookEndpointId: 'wh_ep_1',
    expectedRevision: 1,
    idempotencyKey: 'rotate-1',
  },
  secretInputPaths: [],
  sourceCustody: {
    kind: 'development',
    registeredRootId: '/plugins/machine-services',
  },
  policyFingerprint: 'a'.repeat(64),
  subjectFingerprint: 'b'.repeat(64),
  replayPlacement: { serverId: 'server-1', machineId: 'machine-1' },
  executionOriginV1: {
    v: 1,
    authority: 'present_user',
    surface: 'cli',
    caller: { kind: 'host' },
    serverId: 'server-1',
    serverIdentityId: 'srv_home',
    accountId: 'account-1',
    machineId: 'machine-1',
    target: { kind: 'machine', machineId: 'machine-1' },
    actionId: 'action.invoke',
    requestId: 'rotate-request',
  },
  summary: 'Change this heartbeat address?',
});

it('refuses a terminal sign-in approving a daemon-held contributed Ask before minting a decision root', async () => {
  const home = await startHome();
  const credentials = storedCredentials('terminal');
  await runWithServerHttpBaseUrl(home.url, async () => {
    const store = createCliApprovalsArtifactStore({
      credentials,
      serverId: 'server-1',
      serverHttpBaseUrl: home.url,
    });
    const { artifactId } = await store.targetActionApprovalsCreate({ request });
    home.posts.length = 0;
    const executor = createCliActionExecutorFromCredentials({
      credentials,
      serverId: 'server-1',
      serverApiUrl: home.url,
      actionsSettingsProvider: createActionSettingsProvider(),
    });
    // Terminal credentials request Asks but never approve them (docs/actions.md):
    // the person is sent to an Account sign-in, and no root is minted.
    expect(
      await executor.execute(
        'approval.request.decide',
        { artifactId, decision: 'approve' },
        {
          surface: 'cli',
          authority: 'present_user',
          actionRequestId: 'decide-1',
        },
      ),
    ).toMatchObject({
      ok: false,
      errorCode: 'present_user_required',
      effectAttempted: false,
      details: { reason: 'approval_reviewer_required' },
    });
    expect(home.posts).toEqual([]);
    expect(await store.targetActionApprovalsGet({ artifactId })).toMatchObject({
      status: 'open',
    });
  });
});

// W21-A: a guest's own Agent asks to open the Browser in its Session on another
// person's Machine. The Ask is client-placed and forwarded from that Session, so the
// CLI replays it by minting a fresh decision root at Home, which a terminal can never hold.
function forwardedGuestBrowserAsk() {
  const target = { kind: 'machine' as const, machineId: 'owner-machine' };
  const input = { commandId: 'qa-browser-open', scopeId: 'home:session',
    target: { kind: 'externalUrl', targetId: 'qa-target-1', url: 'https://example.test/' } };
  const envelope = { v: 1 as const, requestId: 'guest-browser-open', target, input };
  const caller = { kind: 'session' as const, sessionId: 'guest-session', starterDepth: 0, turnDepth: 0 };
  return ApprovalRequestV2Schema.parse({ v: 2, actionId: 'browser.workspace.open', status: 'open',
    summary: 'Open a page in the Browser', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' },
    actionArgs: input,
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'agent', caller,
      callerPermissionMode: 'default',
      sessionInputSource: { sourceSessionId: caller.sessionId, sourceTurnId: 'guest-turn', via: 'action' },
      accountId: 'account-1', serverId: 'server-1', serverIdentityId: 'srv_home', target,
      actionId: 'browser.workspace.open', requestId: 'guest-browser-open', machineId: target.machineId,
      externalActionInputSignature: 'a'.repeat(86), originalActionEnvelope: envelope,
      externalActionExecutionAuthorization: { v: 1, token: 'home-signed-root', binding: {
        accountId: 'account-1', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
        accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId,
        installationId: 'owner-installation', actionId: 'browser.workspace.open', requestId: 'guest-browser-open',
        target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        sessionActionSource: { machineId: target.machineId, installationId: 'owner-installation' },
        sessionActionOrigin: { v: 1, caller, sourceTurnId: 'guest-turn', callerPermissionMode: 'default',
          requestId: envelope.requestId } } } },
  });
}

it.each(['terminal', 'account'] as const)(
  'answers a %s sign-in approving a guest Session\'s forwarded Browser Ask by its reviewer rule', async (kind) => {
  const home = await startHome();
  const credentials = storedCredentials(kind);
  await runWithServerHttpBaseUrl(home.url, async () => {
    const store = createCliApprovalsArtifactStore({ credentials, serverId: 'server-1', serverHttpBaseUrl: home.url });
    const { artifactId } = await store.approvalsCreate({ request: forwardedGuestBrowserAsk(), serverId: 'server-1' });
    home.posts.length = 0;
    const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'server-1',
      serverApiUrl: home.url, actionsSettingsProvider: createActionSettingsProvider() });
    const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
      { surface: 'cli', authority: 'present_user', actionRequestId: `decide-${kind}` });
    if (kind === 'terminal') {
      // The person reads its cause and is sent to the app; Home sees nothing and the Ask stays open.
      expect(decided).toMatchObject({ ok: false, errorCode: 'present_user_required', effectAttempted: false,
        details: { reason: 'approval_reviewer_required' } });
      expect(home.posts).toEqual([]);
      expect(await store.approvalsGet({ artifactId, serverId: 'server-1' })).toMatchObject({ status: 'open' });
    } else {
      // A person's sign-in is not refused by the terminal rule: it records consent and reaches Home.
      expect(decided).not.toMatchObject({ errorCode: 'present_user_required' });
      expect(home.posts.length).toBeGreaterThan(0);
    }
  });
});
