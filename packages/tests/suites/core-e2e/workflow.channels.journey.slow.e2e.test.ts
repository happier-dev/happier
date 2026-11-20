import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { connectUiPersonActionClient, readUiChannelProviderProjection } from '@happier-tests/ui-action-client';
import { CONVERSATION_CORE_PLUGIN_ID_V1, CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationBindingCreateResultV1Schema, ConversationBindingResolveResultV1Schema,
  ConversationConnectionCreateResultV1Schema, ConversationConnectionListResultV1Schema } from '@happier-dev/channels-protocol/v1';
import { PluginTargetedContributionSelectionV1Schema } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { WorkflowTriggerWriteResultV1Schema } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';
import { WorkflowRunGetResultV1Schema, WorkflowRunListResultV1Schema, WorkflowRunWaitResultV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { sealQualifiedConnectedAccountContentEnvelope } from '@happier-dev/protocol/connect/qualifiedConnectedAccountContentEnvelope';
import { projectQualifiedConnectedAccountCredentialPlaintextV1 } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { QualifiedConnectedAccountCredentialMutationV4Schema, QualifiedConnectedAccountCredentialMutationSuccessV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountCredentialMutationV4';
import { CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 } from '@happier-dev/protocol/connect/pluginConnectedAccountAuthenticationV2';
import { startFinJourneyFixture, type FinJourneyFixture } from '../../src/testkit/finJourney';
import { startChannelTransportBoundary } from '../../src/testkit/providers/channelTransportBoundary';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'fin-channels' });
const prompt = `Return the Channels journey result ${randomUUID()}.`;
const slackSockets = new Set<WebSocket>();
const discordSockets = new Set<WebSocket>();
const slackEnvelopeAcks = new Set<string>();
let fixture: FinJourneyFixture | undefined;
let boundary: Awaited<ReturnType<typeof startChannelTransportBoundary>> | undefined;

beforeAll(async () => {
  boundary = await startChannelTransportBoundary({ testDir: run.testDir('transport'),
    connected(socket, request) {
      const slack = request.headers.host === 'socket.slack.com';
      const sockets = slack ? slackSockets : discordSockets;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      if (slack) {
        socket.on('message', bytes => {
          const frame = JSON.parse(String(bytes));
          if (typeof frame.envelope_id === 'string') slackEnvelopeAcks.add(frame.envelope_id);
        });
        socket.send(JSON.stringify({ type: 'hello', connection_info: { app_id: 'A1' } }));
      }
      else {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
        socket.on('message', bytes => {
          const frame = JSON.parse(String(bytes));
          if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }));
          if (frame.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: {
            v: 10, user: { id: '9000', bot: true, username: 'journey-bot' }, guilds: [{ id: '2000', unavailable: false }],
            session_id: 'fin-channel-session', resume_gateway_url: 'wss://gateway.discord.gg', application: { id: '8000', flags: 262144 },
          } }));
        });
      }
    },
    respond(request) {
      const url = new URL(request.path, `https://${request.host}`);
      if (request.host === 'slack.com') {
        const method = url.pathname.split('/').at(-1);
        if (method === 'auth.test') return { ok: true, team_id: 'T1', user_id: 'U0', bot_id: 'B1', user: 'journey-bot' };
        if (method === 'bots.info') return { ok: true, bot: { id: 'B1', user_id: 'U0', app_id: 'A1', name: 'journey-bot' } };
        if (method === 'apps.connections.open') return { ok: true, url: 'wss://socket.slack.com/journey' };
        if (method === 'conversations.info') return { ok: true, channel: { id: 'C1', name: 'journey', is_im: false,
          is_mpim: false, is_private: false, is_archived: false } };
        if (method === 'users.info') return { ok: true, user: { id: url.searchParams.get('user'), team_id: 'T1',
          is_bot: false, deleted: false, name: 'journey-sender' } };
        if (method === 'chat.postMessage') return { ok: true, channel: 'C1', ts: '1700000001.000001' };
      } else {
        const path = url.pathname.replace('/api/v10', '');
        if (path === '/oauth2/applications/@me') return { id: '8000', flags: 262144 };
        if (path === '/users/@me') return { id: '9000', bot: true, username: 'journey-bot' };
        if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 } };
        if (path === '/users/@me/guilds') return [{ id: '2000', name: 'Journey guild' }];
        if (path === '/guilds/2000/channels') return ['1002', '1001'].map(id => ({ id, guild_id: '2000', name: 'Support', type: 0, permission_overwrites: [] }));
        if (path === '/guilds/2000/threads/active') return { threads: [], members: [], has_more: false };
        if (path === '/guilds/2000/roles') return [{ id: '2000', permissions: '8' }];
        if (path.startsWith('/guilds/2000/members/')) return { user: { id: path.split('/').at(-1), bot: path.endsWith('/9000'), username: 'journey-sender' }, roles: [] };
        if (path === '/channels/1001') return { id: '1001', guild_id: '2000', name: 'Support', type: 0, permission_overwrites: [] };
        if (path === '/channels/1001/messages' && request.method === 'POST') return { id: '3002', channel_id: '1001' };
      }
      throw new Error(`Unexpected Channel provider operation ${request.method} ${url.pathname}`);
    },
  });
  fixture = await startFinJourneyFixture({ testDir: run.testDir('home'), serverEnv: { ...process.env,
    HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
});
afterAll(async () => { try { await fixture?.stop(); } finally { await boundary?.stop(); } });

const providers: ReadonlyArray<{ name: string; pluginId: string; serviceId: string; mode: string; values: Record<string, string>;
  query: string; endpointIds: readonly string[]; principal: string; principalId: string }> = [
    { name: 'Slack', pluginId: 'happier.channel.slack', serviceId: 'slack-bot', mode: 'bot-tokens',
      values: { botToken: 'xoxb-fin-test-only', appToken: 'xapp-fin-test-only' }, query: 'C1',
      endpointIds: ['slack:T1:channel:C1'], principal: 'U1', principalId: 'slack:T1:user:U1' },
    { name: 'Discord', pluginId: 'happier.channel.discord', serviceId: 'discord-bot', mode: 'bot-token',
      values: { token: 'fin-discord-test-only' }, query: 'support',
      endpointIds: ['discord:channel:1001', 'discord:channel:1002'], principal: '4000', principalId: 'discord:user:4000' },
  ];

for (const provider of providers) {
  describe(provider.name, () => {
    let prepared: Awaited<ReturnType<typeof prepareProvider>>;
    beforeAll(async () => { prepared = await prepareProvider(provider); });
    afterAll(async () => { await prepared?.ui.close(); });
    it(`J11 ${provider.name} binding delivers a Workflow text result`, () => exerciseProvider(provider, prepared));
  });
}

async function prepareProvider(provider: typeof providers[number]) {
  if (!fixture || !boundary) throw new Error('Channels journey did not start');
  const home = fixture;
  const transport = boundary;
  const actor = await home.createAccount(`channels-owner-${provider.name.toLowerCase()}`);
  const machine = await home.enrollDaemon(actor, { env: { ...process.env, ...transport.env,
    NODE_OPTIONS: `${home.sourceOptions} ${transport.env.NODE_OPTIONS}`,
    HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1', HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  const ui = await connectUiPersonActionClient({ serverUrl: home.actionServerApiUrl, accountSecret: actor.auth.accountSigningSeed });
  return { home, transport, actor, machine, ui };
}

async function exerciseProvider(provider: typeof providers[number], prepared: Awaited<ReturnType<typeof prepareProvider>>) {
  const { home, transport, actor, machine, ui } = prepared;
  const context = () => ({ surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
    serverId: ui.serverId, serverIdentityId: home.serverId, actionRequestId: randomUUID(),
    externalActionTarget: { kind: 'machine' as const, machineId: machine.target.machineId,
      project: { machineId: machine.target.machineId, directory: machine.workspaceDir } } });
  async function invoke(localId: string, input: unknown) {
    const response = await actor.execute('action.invoke',
      { action: { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, localId }, input },
      { ...context(), surface: 'cli', presentUserConfirmation: { actionId: 'action.invoke' } });
    if (!response.ok) throw new Error(response.errorCode);
    return response.result;
  }
  // enrollDaemon already waits for the real core RPC registration; this read
  // waits only for the UI's pushed Machine projection to observe that daemon.
  await waitFor(() => ui.isMachineActive(machine.target.machineId),
    { context: 'UI observes the already-ready daemon through the pushed Machine projection' });
  const ref = { service: { pluginId: provider.pluginId, localId: provider.serviceId }, accountId: randomUUID() };
  const metadata = { displayName: 'Constructed journey bot', scopes: [], providerIdentity: { accountId: ref.accountId } };
  const payload = projectQualifiedConnectedAccountCredentialPlaintextV1({ ref, authenticationModeId: provider.mode,
    payload: { v: 1, values: provider.values }, metadata, now: Date.now() });
  const content = sealQualifiedConnectedAccountContentEnvelope({ kind: 'credential', accountMode: 'e2ee',
    material: { type: 'dataKey', machineKey: actor.credentials.encryption.machineKey }, payload, randomBytes });
  const mutation = QualifiedConnectedAccountCredentialMutationV4Schema.parse({ ref, authenticationModeId: provider.mode,
    content, metadata, expectedCredentialRevision: null, directExportContract: CONNECTED_ACCOUNT_DIRECT_EXPORT_CONTRACT_V1 });
  const imported = await fetchJson<unknown>(`${home.server.baseUrl}/v4/connect/qualified/credential`, {
    method: 'POST', headers: { Authorization: `Bearer ${actor.credentials.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(mutation) });
  expect(imported.status).toBe(200);
  QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(imported.data);
  const projection = await readUiChannelProviderProjection(machine.target.machineId,
    { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, serverId: ui.serverId });
  if (!projection.supported || !('targetedContributions' in projection)) throw new Error('Channels provider projection unavailable');
  const observed = projection.targetedContributions;
  const operation = observed.points.flatMap(point => point.protocols.flatMap(protocol => protocol.contributions
    .filter(contribution => contribution.contributor.pluginId === provider.pluginId)
    .flatMap(contribution => contribution.operations))).find(operation => operation.role === 'setup');
  expect(operation, `${provider.pluginId} has a real admitted provider setup`).toBeDefined();
  if (!operation) throw new Error('Channels provider setup unavailable');
  const providerSelection = PluginTargetedContributionSelectionV1Schema.parse({
    target: { pluginId: observed.target.pluginId, sourceCustody: observed.target.sourceCustody }, point: operation.point,
    contributor: { pluginId: operation.contributor.pluginId, contributionId: operation.contributor.contributionId,
      sourceCustody: operation.contributor.sourceCustody },
  });
  const connection = ConversationConnectionCreateResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionCreate,
    { providerSelection, providerSetupInput: { credentialRef: ref }, credentialRef: ref, selectedTransport: 'socket' }));
  if (connection.kind !== 'created') throw new Error(`Channel connection refused: ${connection.kind}`);
  const connections = ConversationConnectionListResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionList, {}));
  const currentConnection = connections.connections.find(item => item.connectionId === connection.connectionId);
  if (!currentConnection) throw new Error('Created Channel connection is absent from the canonical Account list');
  const resolved = ConversationBindingResolveResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingResolve,
    { kind: 'endpoint', connectionId: connection.connectionId, expectedConnectionRevision: currentConnection.revision, query: provider.query }));
  if (resolved.kind !== 'endpointCandidates') throw new Error(`Channel lookup refused: ${resolved.kind}`);
  expect(resolved.candidates.map(candidate => candidate.id)).toEqual(provider.endpointIds);
  const endpoint = resolved.candidates[0]!;
  const workflow = await ui.executeConfirmed('workflow.trigger.add', {
    target: { kind: 'inline', definition: { version: 1, defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    }, blocks: [{ kind: 'step', id: 'answer', document: { text: prompt, references: [], attachments: [] }, result: { kind: 'text' } }],
    finalOutput: { kind: 'result', producer: { blockId: 'answer' }, path: [] } } },
    project: { machineId: machine.target.machineId, directory: machine.workspaceDir },
    trigger: { kind: 'schedule', enabled: true, schedule: { kind: 'cron', scheduleExpr: '0 0 1 1 *', everyMs: null, timezone: 'UTC' } },
  }, context());
  if (!workflow.ok) throw new Error(workflow.errorCode);
  const saved = WorkflowTriggerWriteResultV1Schema.parse(workflow.result);
  const binding = ConversationBindingCreateResultV1Schema.parse(await invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.bindingCreate,
    { connectionId: connection.connectionId, expectedConnectionRevision: currentConnection.revision,
      endpointSelection: { query: provider.query, selected: { kind: endpoint.kind, audience: endpoint.audience, id: endpoint.id } },
      principalSelection: { query: provider.principal, selected: [{ id: provider.principalId, kind: 'human' }] },
      target: { kind: 'automation', automationId: saved.set.automationId, policy: { resultDelivery: 'finalResult' } },
      inputMode: 'allAllowedMessages', enabled: true }));
  expect(binding.kind).toBe('created');
  const slack = provider.serviceId === 'slack-bot';
  const sockets = slack ? slackSockets : discordSockets;
  await waitFor(() => [...sockets].some(socket => socket.readyState === 1), { context: 'Saved connection has a real provider socket' });
  const socket = [...sockets].find(socket => socket.readyState === 1)!;
  const envelopeId = randomUUID();
  const sourceMessageId = slack ? (Date.now() / 1000).toFixed(3) : '3001';
  socket.send(JSON.stringify(slack ? { type: 'events_api', envelope_id: envelopeId, payload: {
    type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: randomUUID(), event: {
      type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'Run the saved Workflow', ts: sourceMessageId,
    },
  } } : { op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: sourceMessageId, channel_id: '1001', guild_id: '2000',
    author: { id: '4000', bot: false, username: 'journey-sender' }, content: 'Run the saved Workflow',
    timestamp: new Date().toISOString(), attachments: [], mentions: [] } }));
  if (slack) await waitFor(() => slackEnvelopeAcks.has(envelopeId),
    { context: 'Slack acknowledges the real Events API envelope after ingress admission' });
  let runId: string | undefined;
  await waitFor(async () => {
    const listed = await ui.executeConfirmed('workflow.run.list', { automationId: saved.set.automationId }, context());
    if (!listed.ok) throw new Error(listed.errorCode);
    runId = WorkflowRunListResultV1Schema.parse(listed.result).runs[0]?.id;
    return runId !== undefined;
  }, { context: `${provider.pluginId} message admits its saved Workflow Run` });
  if (!runId) throw new Error('Channel message did not admit a Workflow Run');
  const completed = await ui.executeConfirmed('workflow.run.wait', { runId, conditions: ['terminal'] }, context());
  if (!completed.ok) throw new Error(completed.errorCode);
  const { observation, run: completedRun } = WorkflowRunWaitResultV1Schema.parse(completed.result);
  expect({ observation, state: completedRun?.state }).toEqual({ observation: 'terminal', state: 'succeeded' });
  const opened = await ui.executeConfirmed('workflow.run.get', { runId }, context());
  if (!opened.ok) throw new Error(opened.errorCode);
  const finalText = WorkflowRunGetResultV1Schema.parse(opened.result).result;
  expect(typeof finalText).toBe('string');
  if (typeof finalText !== 'string') throw new Error('Channels Workflow did not retain a text result');
  expect(finalText.length).toBeGreaterThan(0);
  await waitFor(() => transport.requests().some(request => {
    if (request.method !== 'POST' || !(slack ? request.path === '/api/chat.postMessage' : request.path === '/api/v10/channels/1001/messages')) return false;
    const body = JSON.parse(request.body);
    return slack
      ? body.text === finalText && body.channel === 'C1' && body.thread_ts === sourceMessageId
      : body.content === finalText && body.message_reference?.message_id === sourceMessageId;
  }), { context: `${provider.pluginId} receives the actual Workflow text result in the originating conversation over HTTPS` });
}
