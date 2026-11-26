import { afterEach, expect, it, vi, onTestFinished } from 'vitest';
import axios from 'axios';
import { FeaturesResponseSchema, computeExternalActionRequestEnvelopeDigestV1,
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionExecutionAuthorizationV1Schema,
  parseExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { DEPLOY_SUGGESTION_INSTRUCTIONS_V1, DeploySuggestionV1Schema } from '@happier-dev/protocol/deployments/suggestions/deploySuggestionsV1';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import type { RpcHandler } from '@/api/rpc/types';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createDaemonControlApp, type startDaemonControlServer } from '@/daemon/controlServer';
import { writeDaemonState } from '@/persistence';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// OS listener publication only; installed ingress, executor, custody and Run handlers stay real.
vi.mock('@/daemon/controlServer', async original => ({ ...await original<typeof import('@/daemon/controlServer')>(),
  startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input; return { port: 43129, stop: async () => {} };
  } }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });

it('admits own browser Describe standalone Run through external dispatch', async () => {
  const homeId = 'srv_own_describe';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 0,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`, encryption: null };
  const features = { status: 'ready' as const, features: FeaturesResponseSchema.parse({ features: { execution: { runs: { enabled: true } } } }) };
  const nativeFetch = globalThis.fetch;
  const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, {
    manifest: createPluginManifestV2Fixture({ id: 'acme.project-launch', contributes: { agents: [{ id: 'agent', title: 'Describe fixture',
      runtime: { kind: 'custom' }, primary: 'sessions', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true,
        executionRunContext: { versions: [1] } } } }] } }),
    files: { 'daemon.mjs': `import { factory } from './agent.mjs'; export function activate(api) {
      api.agents.register('agent', factory, { sessionRunnerFactory: { module: './agent.mjs', export: 'factory', runtimeApiVersion: 1 } }); }`,
      'agent.mjs': `import { createExecutionRunHostBackendFromConversationRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
      async function openConversation() { let listener; return {
        watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
        async send(input) { const turnId = input.delivery.turnId;
          listener?.({ kind: 'input-accepted', inputIds: input.inputIds, delivery: input.delivery });
          listener?.({ kind: 'turn-start', turnId, startedBy: 'host' });
          listener?.({ kind: 'message-delta', turnId, channel: 'assistant', text: '{"recommendations":[]}' });
          listener?.({ kind: 'turn-complete', turnId }); return { status: 'admitted' }; },
        async cancel() { return { status: 'notRunning' }; }, async dispose() { listener = undefined; }
      }; }
      export function factory() { return { sessions: { async open() { throw new Error('Detached Run only'); },
        executionRunContextV1: { openConversation, async open(request, context) {
          return createExecutionRunHostBackendFromConversationRuntime({ request, readCheckpointId: () => null,
            openConversation: () => openConversation(request, context) });
        } }
      } }; }` },
  }, undefined, {
    credentials, accountActionCredentials: credentials, requesterCredentials: credentials, ordinaryAccountSession: true,
    externalActionAccountId: 'requester', homeServerIdentityId: homeId,
    machineAccess: { custodianAccountId: 'requester', role: 'manage' }, resolveServerFeaturesSnapshot: () => features,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
  });
  const owner = h.daemon.externalActionIngressOwner;
  if (!owner) throw new Error('Missing installed external Action owner');
  const homeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', ((input, init) => new URL(input instanceof Request ? input.url : String(input)).hostname === '127.0.0.1'
    ? nativeFetch(input, init) : homeFetch(input, init)) satisfies typeof fetch);
  h.machine.setRPCHandlers({ spawnSession: h.daemon.spawnSession, stopSession: h.daemon.stopSession, requestShutdown() {} }, {
    externalActionIngressOwner: owner, getServerFeaturesSnapshot: () => features, resolveServerFeaturesSnapshot: () => features,
  });
  if (!boundary.control) throw new Error('Missing daemon control owner');
  const app = createDaemonControlApp(boundary.control);
  await app.listen({ host: '127.0.0.1', port: 0 });
  onTestFinished(() => app.close());
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing daemon listener');
  writeDaemonState({ pid: process.pid, startedAt: Date.now(), startedWithCliVersion: 'test',
    httpPort: address.port, controlToken: boundary.control.controlToken, machineId: 'machine', accountId: 'requester' });
  const post = vi.mocked(axios.post).getMockImplementation()!;
  vi.mocked(axios.post).mockImplementation(async (url, ...args) => {
    if (String(url).includes('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
    if (String(url).endsWith('/v1/machines/managed/actions/list')) return { status: 200, data: { machines: [] } };
    return post(url, ...args);
  });
  const handlers = new Map<string, RpcHandler>();
  registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
    ...owner, machineId: 'machine', resolveAccountId: async () => 'requester',
    resolveInstallationId: () => h.f.installation.installationId, verifyExecutionAuthorization: async () => true,
  });
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const envelope = { v: 1 as const, requestId: 'describe-own-browser', target, input: {
    sessionId: null, cwd: h.cwd, intent: 'task', instructions: DEPLOY_SUGGESTION_INSTRUCTIONS_V1,
    intentInput: { input: { description: 'Describe a bakery website', catalog: {
      starters: [], apps: [], targets: [], machines: [{ machineId: 'machine', online: true, homeDir: h.cwd, readiness: 'ready' }],
      stores: [], forges: [],
    } }, resultSchema: zodSchemaToJsonSchemaObject(DeploySuggestionV1Schema, { target: 'draft-7' }) },
    backendTarget: { kind: 'agent', identity: { pluginId: 'acme.project-launch', localId: 'agent' } },
    permissionMode: 'no_tools', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', waitForCompletion: true,
  } };
  const authentication = { kind: 'account' as const, tokenEpoch: 0 };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-browser', binding: {
    accountId: 'requester', custodianAccountId: 'requester', authentication, serverIdentityId: homeId,
    machineId: 'machine', installationId: h.f.installation.installationId, admittedMachineRole: 'manage', accountEncryptionMode: 'plain',
    actionId: 'execution.run.start', requestId: envelope.requestId, target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const result = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!({ actionId: 'execution.run.start', envelope,
    placement: { machineId: 'machine', target }, principal: { accountId: 'requester', authentication, authority: 'present_user' },
    executionAuthorization: authorization }, { signal: new AbortController().signal, authorization: ACTION_API_SERVER_ORIGIN,
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', machineId: 'machine',
      installationId: h.f.installation.installationId, role: 'manage', encryptionMode: 'plain' } });
  const decoded = parseExternalActionDaemonDispatchResultV1(result);
  expect(decoded, JSON.stringify(decoded)).toMatchObject({ kind: 'response', prepared: { response: { execution: { ok: true, result: { runId: expect.any(String) } } } } });
});
