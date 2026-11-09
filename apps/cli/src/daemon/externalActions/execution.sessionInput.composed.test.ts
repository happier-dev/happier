import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { configuration } from '@/configuration';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { readCompleteActionSpecV1 } from '@happier-dev/protocol/actions/actionSpecSections';
import { supportsSessionMessageInputJsonSchema } from '@happier-dev/protocol/actions/actionInputJsonSchemaValidation';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The private HTTP listener is an OS boundary; installed Action composition,
// attachment admission and Session input routing remain real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
  boundary.control = input;
  return { port: 43129, stop: async () => {} };
} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

it.each(['local', 'signed', 'forbidden', 'target-forbidden', 'network'] as const)('settles receipt input immediately after chooser start without a Session Agent input handler (%s)', async scenario => {
  const signed = scenario !== 'local';
  const home = `srv_${'a'.repeat(32)}`;
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, {
    manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: {
      agents: [{ id: 'agent', title: 'Agent', runtime: { kind: 'custom' }, primary: 'sessions',
        capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }],
      composerAttachments: [{ id: 'entry', title: 'Receipt', icon: 'file', cardinality: 'many',
        valueSchema: { type: 'object', additionalProperties: true } }],
    } }),
    files: { 'agent.mjs': `export function factory() { return { sessions: { open() { throw new Error('Agent is not open yet'); } } }; }`,
      'daemon.mjs': `import { factory } from './agent.mjs'; export function activate(api) {
        api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } });
      }` },
  }, undefined, { credentials, accountActionCredentials: credentials, requesterCredentials: credentials,
    externalActionAccountId: 'requester', ordinaryAccountSession: true, machineAccess: { custodianAccountId: 'requester', role: 'manage' },
    homeServerIdentityId: home,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home, machineId: 'machine' }) });
  const sessionId = 'cmw0gvvts006bmcns1nf9ttnd';
  // A successful chooser start has committed this exact Session and controller;
  // the Agent child has not mounted a Session RPC handler. Home is the genuine
  // persistence boundary, not a mocked Session sender or attachment owner.
  const originalGet = vi.mocked(axios.get).getMockImplementation()!;
  vi.mocked(axios.get).mockImplementation(async (...args) => {
    const path = new URL(String(args[0])).pathname;
    if (signed && (path === `/v2/sessions/${sessionId}` || path.endsWith('/pending') || path.includes('/messages/by-local-id/'))
      && !args[1]?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
      throw new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined,
        { status: 401, statusText: 'Unauthorized', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: { error: 'Unauthorized' } });
    }
    if ((scenario === 'forbidden' || scenario === 'network') && path.endsWith('/pending')
      || scenario === 'target-forbidden' && path === `/v2/sessions/${sessionId}`) {
      throw new axios.AxiosError('Replay custody unavailable', scenario === 'network' ? 'ECONNRESET' : 'ERR_BAD_REQUEST', undefined, undefined,
        scenario === 'network' ? undefined : { status: 403, statusText: 'Forbidden', headers: {},
          config: { headers: new axios.AxiosHeaders() }, data: { error: 'access_denied' } });
    }
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: V2SessionByIdResponseSchema.parse({ session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'plain', dataEncryptionKey: null, share: null,
      metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: { machineId: 'machine', path: h.cwd } }),
    }) }) };
    if (path === `/v2/sessions/${sessionId}/pending`) return { status: 200, data: { pending: [] } };
    if (path.includes(`/sessions/${sessionId}/messages/by-local-id/`)) throw new axios.AxiosError('Not found', 'ERR_BAD_REQUEST', undefined, undefined,
      { status: 404, statusText: 'Not found', headers: {}, config: { headers: new axios.AxiosHeaders() }, data: { error: 'Message not found' } });
    return originalGet(...args);
  });
  const writes: unknown[] = [];
  // The authenticated Machine socket is the durable enqueue boundary. No
  // Session Agent handler is present and no HTTP sender substitutes for it.
  Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, raw) => {
    const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
    expect(request.sessionId).toBe(sessionId);
    writes.push(request);
    return { v: 1, result: { status: 'accepted', localId: request.localId } };
  } }));
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed Action owner');
  const subject = { kind: 'deploymentReceipt', serverId: configuration.activeServerId,
    environmentId: 'cmvx1tgtc002fmc8mtjxkne1x', deploymentId: 'cmvxxre5g002tmckmlx5bfap7' };
  const input = {
    sessionId, message: 'Investigate this failed receipt.', idempotencyKey: 'receipt-handoff',
    attachments: [{ attachmentLocalId: 'entry', value: { key: 'receipt-identity', presentation: { label: 'Selected evidence' }, value: {
      v: 1, forgeEvidence: { v: 1, items: [{ source: { kind: 'alert', label: 'Failure reference' },
        author: { kind: 'process' }, text: JSON.stringify({ subject, read: { actionId: 'deployments.receipts.get',
          input: { serverId: subject.serverId, environmentId: subject.environmentId, deploymentId: subject.deploymentId } } }) }] },
    } } }],
  };
  const target = { kind: 'session' as const, sessionId };
  const envelope = { v: 1 as const, requestId: 'receipt-handoff', target, input };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'receipt-send-admission', binding: {
    accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'terminal', tokenEpoch: 0 },
    serverIdentityId: home, machineId: 'machine', installationId: h.f.installation.installationId,
    actionId: 'session.message.send', requestId: envelope.requestId, target,
    accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  // The UI discovers the native input contract before dispatching the receipt.
  // Going straight to session.message.send misses a refusal before any enqueue.
  const advertised = await readCompleteActionSpecV1({ actionId: 'session.message.send', read: async schemaInput => {
    const discovered = await owner.executor.execute('action.spec.get', schemaInput, {
      surface: 'plugin', authority: 'account_automation', serverId: configuration.activeServerId,
      actionCaller: { kind: 'plugin', pluginId: 'acme.project-launch', contributionLocalId: 'sessions/investigate' },
    });
    expect(discovered).toMatchObject({ ok: true });
    if (!discovered.ok) throw new Error(discovered.errorCode);
    return discovered.result;
  } });
  expect(supportsSessionMessageInputJsonSchema(advertised.inputSchema, input)).toBe(true);
  expect(writes).toEqual([]);
  const result = await owner.executor.execute('session.message.send', input,
    { surface: 'plugin', authority: 'account_automation', serverId: configuration.activeServerId,
    ...(signed ? { externalActionExecutionAuthorization: authorization, externalActionTarget: target,
      actionRequestId: envelope.requestId, originalActionEnvelope: envelope } : {}),
    actionCaller: { kind: 'plugin', pluginId: 'acme.project-launch', contributionLocalId: 'sessions/investigate' } })
    .finally(() => { vi.mocked(axios.get).mockImplementation(originalGet); });
  if (scenario === 'forbidden' || scenario === 'target-forbidden' || scenario === 'network') {
    expect(result).toMatchObject({ ok: true, result: scenario === 'network'
      ? { status: 'outcomeUnknown', code: 'session_input_rejoin_unavailable' }
      : { status: 'rejected', code: 'session_input_unauthorized' } });
    expect(writes).toEqual([]);
    return;
  }
  expect(result, JSON.stringify({ result, writes })).toMatchObject({ ok: true, result: { status: 'accepted' } });
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes)).toContain('cmvxxre5g002tmckmlx5bfap7');
});
