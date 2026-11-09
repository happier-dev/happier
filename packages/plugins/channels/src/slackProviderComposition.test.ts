import {
  ConversationDeliveryInputV1Schema,
  ConversationProviderSetupResultV1Schema,
  ConversationProvidersContributionProtocolV1,
  countConversationTextUnits,
  type ConversationDeliveryInputV1,
} from '@happier-dev/channels-protocol/v1';
import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionSendRequest } from '@happier-dev/plugin-sdk/sessions';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { describe, expect, it } from 'vitest';

import { deliverSlackMessage, setupSlackChannels, testSlackConnection, SLACK_SETUP_INPUT_PROTOCOL_SCHEMA } from '../../channel-slack/src/slackActions.js';
import { mapSlackEventToIngress } from '../../channel-slack/src/slackObservation.js';
import { isChannelStateJsonRecord } from './accountLocalBindingPolicy.js';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_COLLECTION } from './collections.js';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { createConversationSessionProjectionFrontierRow } from './sessionProjection.js';
import { createChannelsJourneyFixture } from './testkit/channelsJourney.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';

const pluginId = 'happier.channel.slack';
const credentialRef = { service: { pluginId, localId: 'slack-bot' }, accountId: 'slack-test-account' };
const materialization = { pluginId, machineId: 'machine-1', materializationId: 'slack-composed-test' };
const identity = { teamId: 'T1', appId: 'A1', botUserId: 'UBOT', botId: 'B1', label: 'Happier' };
const rootTs = '1700000000.000001';
const endpoint = { kind: 'thread', audience: 'shared', id: `slack:T1:channel:C1:thread:${rootTs}`, parentId: 'slack:T1:channel:C1' } as const;
type UserTextRequest = Extract<SessionSendRequest, { kind: 'userText' }>;

function jsonResponse(value: unknown, finalUrl: string) {
  return { status: 200, finalUrl, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

/** Only Slack HTTP, credential materialization and host Session APIs are replaced. */
async function slackJourney(options: Readonly<{ rateLimited?: boolean; disableAfterFirstChunk?: boolean; wrongDeliveryHandler?: boolean }> = {}) {
  const nativeMessages: Record<string, JsonValue>[] = [];
  const consumed: ConversationDeliveryInputV1[] = [];
  const admissions: UserTextRequest[] = [];
  const eventTime = Math.floor(Date.now() / 1000);
  let answer: string | undefined;
  let answerSeq = 0;
  let core: Awaited<ReturnType<typeof createChannelsJourneyFixture>> | undefined;
  const sockets = new Set<PluginWebSocketConnection>();
  const http: PluginServices['http'] = createPluginHttpFixture({
    async openWebSocket() {
      let greeted = false;
      let close!: () => void;
      const closed = new Promise<Readonly<{ kind: 'local'; wasClean: true }>>(resolve => {
        close = () => resolve({ kind: 'local', wasClean: true });
      });
      const socket: PluginWebSocketConnection = {
        url: 'wss://wss.slack.com/link?ticket=fixture', protocol: '', closed,
        async send() { throw new Error('The readiness handshake cannot ACK a message'); },
        async receive() {
          if (greeted) throw new Error('Readiness must finish after the authenticated hello');
          greeted = true;
          return { kind: 'text', text: JSON.stringify({ type: 'hello', connection_info: { app_id: 'A1' } }) };
        }, close, dispose: close,
      };
      sockets.add(socket);
      return socket;
    },
    async request(request) {
      const method = new URL(request.url).pathname.split('/').at(-1);
      if (method === 'auth.test') return jsonResponse({ ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1', team: 'Fixture', user: 'happier' }, request.url);
      if (method === 'bots.info') return jsonResponse({ ok: true, bot: { id: 'B1', app_id: 'A1', user_id: 'UBOT', name: 'Happier' } }, request.url);
      if (method === 'apps.connections.open') return jsonResponse({ ok: true, url: 'wss://wss.slack.com/link?ticket=fixture' }, request.url);
      if (method === 'conversations.info') return jsonResponse({ ok: true, channel: {
        id: 'C1', name: 'deploys', is_im: false, is_mpim: false, is_private: false, is_archived: false, is_member: true,
      } }, request.url);
      if (method === 'chat.postMessage') {
        const payload: unknown = JSON.parse(new TextDecoder().decode(request.body));
        if (!isChannelStateJsonRecord(payload)) throw new Error('Slack requires a JSON message body');
        nativeMessages.push(payload);
        if (options.rateLimited) return { ...jsonResponse({ ok: false, error: 'ratelimited' }, request.url), status: 429, headers: { 'retry-after': '90' } };
        if (options.disableAfterFirstChunk && nativeMessages.length === 1) {
          const current = await core?.state.get('connection-1');
          if (!current || !isChannelStateJsonRecord(current.value.payload)) throw new Error('Expected the current connection');
          await core!.state.put({ ...current.value, payload: { ...current.value.payload, enabled: false,
            authorityEpoch: Number(current.value.payload.authorityEpoch) + 1 } }, { expectedRevision: current.revision });
        }
        return jsonResponse({ ok: true, channel: 'C1', ts: `1700000001.00000${nativeMessages.length}` }, request.url);
      }
      throw new Error(`Unexpected Slack HTTP request ${request.method} ${request.url}`);
    },
  });
  const roles = ConversationProvidersContributionProtocolV1.operations;
  const definition = definePlugin({ id: pluginId, version: '0.0.0', actions: {
    setup: { title: 'Native Slack setup', surfaces: roles.setup.declaration.surfaces, dangerLevel: roles.setup.declaration.dangerLevel,
      inputSchema: SLACK_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema, resultSchema: roles.setup.declaration.resultSchema.jsonSchema, run: setupSlackChannels },
    inspect: { title: 'Native Slack inspection', surfaces: roles.connectionTest.declaration.surfaces, dangerLevel: roles.connectionTest.declaration.dangerLevel,
      inputSchema: roles.connectionTest.declaration.input.schema.jsonSchema, resultSchema: roles.connectionTest.declaration.resultSchema.jsonSchema, run: testSlackConnection },
    deliver: { title: 'Native Slack delivery', surfaces: roles.messageDeliver.declaration.surfaces, dangerLevel: roles.messageDeliver.declaration.dangerLevel,
      inputSchema: roles.messageDeliver.declaration.input.schema.jsonSchema, resultSchema: roles.messageDeliver.declaration.resultSchema.jsonSchema,
      async run(input, context) {
        const request = ConversationDeliveryInputV1Schema.parse(input);
        consumed.push(request);
        return options.wrongDeliveryHandler ? testSlackConnection(request, context) : deliverSlackMessage(request, context);
      } },
  }, contributesTo: { 'happier.channels': { providers: { native: ConversationProvidersContributionProtocolV1.contribute({ descriptor: { v: 1, displayName: 'Native test' }, operations: {
    setup: roles.setup.bind('setup'), connectionTest: roles.connectionTest.bind('inspect'), messageDeliver: roles.messageDeliver.bind('deliver'),
  } }) } } } });
  // Credential materialization is a genuine host boundary; no credential owner is duplicated.
  const connectedAccounts = { materialize: async () => ({ kind: 'environment', env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }) } as unknown as PluginServices['connectedAccounts'];
  const provider = await createPluginTestkit({ manifest: definition.manifest, module: definition, services: { http, connectedAccounts },
    resolveCurrentPluginMaterializationRef: () => materialization });
  try {
    // The SDK test host stamps the real cross-plugin caller; Action input never supplies it.
    const setupDriver = definePlugin({ id: 'happier.channels', version: '0.0.0', actions: {
      prepare: { title: 'Prepare the Slack provider', surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: SLACK_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema, resultSchema: roles.setup.declaration.resultSchema.jsonSchema,
        run: (input, context) => context.services.actions.execute({ pluginId, localId: 'setup' }, input) },
    } });
    const setupCaller = await createPluginTestkit({ manifest: setupDriver.manifest, module: setupDriver, actionTargets: [provider] });
    const prepared = await (async () => {
      try { return ConversationProviderSetupResultV1Schema.parse(await setupCaller.invokeAction('prepare', { credentialRef }, { surface: 'plugin' })); }
      finally { await setupCaller.dispose(); }
    })();
    if (!prepared.outboundTextLimit) throw new Error('Slack setup must declare its native text bound');
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1', transport: { kind: 'socket' },
      overlapSafety: prepared.overlapSafety, replayContinuity: prepared.replayContinuity, outboundTextLimit: prepared.outboundTextLimit,
      authority: { providerPluginId: pluginId, providerContributionSelection: { contributionId: 'native' }, providerSetupInput: { credentialRef },
        credentialRef: prepared.credentialRef, transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: materialization },
        providerConnectionKey: prepared.providerConnectionKey, providerConfig: prepared.providerConfig,
        integrationPrincipal: prepared.integrationPrincipal, routingIdentityKey: 'r'.repeat(43), authorityEpoch: 1 } });
    const binding = { id: 'binding-1', 'record-kind': 'binding', v: 1, 'connection-id': connection.id, 'binding-id': 'binding-1',
      'created-at': 1, 'updated-at': 1, payload: { endpoint, authorityEpoch: 1, enabled: true, deletionState: 'none',
        target: { kind: 'session', sessionId: 'session-1', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
          approvals: { kind: 'off' }, newSession: { kind: 'off' } } }, allowedPrincipalIds: ['slack:T1:user:U1'], allowBotSenders: false,
        inputMode: 'directMentionsOnly', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off' } };
    // These are the Session process boundaries, beneath the actual Channels registration and projection.
    const sessions = { get: async (id: string) => id === 'session-1' ? {
      summary: async () => ({ id, state: 'idle', runtimeAvailability: { status: 'available' }, storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 }),
      async send(request: SessionSendRequest) {
        if (request.kind !== 'userText') throw new Error('Expected an admitted Slack user message');
        admissions.push(request);
        return { status: 'accepted', localId: 'slack-input-1' };
      },
    } : null } as unknown as PluginServices['sessions'];
    const actions = { async execute(action: string, input: JsonValue) {
      if (action === 'session.permission.remote.pending.list') return { requests: [], truncated: false, nextCursor: null };
      if (action !== 'session.transcript.get') throw new Error(`Unexpected host Action ${action}`);
      const source = admissions[0]?.source;
      const cursor = isChannelStateJsonRecord(input) ? Number(input.cursor ?? 0) : 0;
      return { ok: true, projection: 'externalShareableV1', sessionId: 'session-1', scannedThroughSeq: answerSeq,
        nextCursor: String(answerSeq), hasMore: false, items: answer === undefined || answerSeq <= cursor ? [] : [{
          kind: 'assistantText', sessionId: 'session-1', seq: answerSeq, itemId: `slack-answer-${answerSeq}`, turnId: `slack-turn-${answerSeq}`, final: 'completed', text: answer,
          consumedInputs: [{ localId: 'slack-input-1', origin: { v: 1, producer: 'pluginSession', actor: 'collaborator',
            sourceAuthority: { mediatorPluginId: 'happier.channels', sourceRef: source?.sourceRef, sourceRevisionOrEpoch: source?.sourceRevisionOrEpoch } } }],
        }] };
    } } as unknown as PluginServices['actions'];
    core = await createChannelsJourneyFixture({ provider, connection, binding, sessions, actions,
      resolveCurrentProviderExecutionOrigin: () => ({ serverIdentityId: 'srv_plugin_testkit', materializationRef: materialization }),
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: 'happier.channels', machineId: 'machine-1', materializationId: 'slack-core-test' }) });
    await core.state.put(createConversationSessionProjectionFrontierRow({ bindingId: 'binding-1', targetSessionId: 'session-1',
      transcriptCursor: null, lastScannedSeq: 0, revision: 1, now: Date.now() }), { expectedRevision: 'absent' });
    const journey = core;
    return { ...journey, prepared, admissions, nativeMessages, consumed, answer(text: string) { answer = text; answerSeq += 1; },
      async ingestSlack(eventId = 'Ev1', event: Readonly<Record<string, unknown>> = {}) {
        const normalized = mapSlackEventToIngress({ identity, channel: { id: 'C1', isIm: false, isMpim: false, isPrivate: false, isArchived: false },
          payload: { type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: eventId, event_time: eventTime,
            event: { type: 'message', user: 'U1', channel: 'C1', text: '<@UBOT> inspect this deployment',
              ts: `${eventTime}.000002`, thread_ts: rootTs, ...event } } });
        if (normalized === null) return;
        await journey.ingest({ connectionId: 'connection-1', authorityEpoch: 1, entry: { observation: normalized, eventCandidate: null } });
      },
      validateWrites() {
        for (const [collection, definition] of [[journey.state, CHANNEL_STATE_COLLECTION], [journey.deliveries, CHANNEL_DELIVERIES_COLLECTION]] as const) {
          const schema = compilePluginJsonSchema(definition.schema);
          for (const row of collection.rows.values()) if (!row.deleted) expect(isValidPluginJsonSchemaValue(schema, row.value), row.rowId).toBe(true);
        }
      },
      async dispose() { await journey.dispose(); for (const socket of sockets) socket.dispose(); await provider.dispose(); } };
  } catch (error) {
    await core?.dispose(); for (const socket of sockets) socket.dispose(); await provider.dispose(); throw error;
  }
}

describe('Slack through registered Channels ingress and Session projection', () => {
  it('dedupes a native event, filters unapproved senders, and sends split Session answers into the original Slack thread once', async () => {
    const journey = await slackJourney();
    try {
      await journey.ingestSlack();
      await journey.ingestSlack();
      await journey.ingestSlack('EvOther', { user: 'U2' });
      await journey.ingestSlack('EvBot', { user: 'U1', bot_id: 'OTHERBOT', subtype: 'bot_message' });
      expect(journey.admissions).toHaveLength(1);
      expect(journey.admissions[0]).toMatchObject({ kind: 'userText', text: '<@UBOT> inspect this deployment',
        source: { sourceRef: 'channels:binding:binding-1', externalActor: { kind: 'human' } } });
      const limit = journey.prepared.outboundTextLimit!;
      const text = 'x'.repeat(limit.maximum - 1) + '👋'.repeat(20) + '\n\nDeployment succeeded.';
      journey.answer(text);
      await journey.outward();
      expect(journey.consumed.length).toBeGreaterThan(1);
      expect(journey.nativeMessages.map(message => message.text).join('')).toBe(text);
      expect(journey.nativeMessages.every(message => message.channel === 'C1' && message.thread_ts === rootTs)).toBe(true);
      expect(journey.consumed.every(delivery => countConversationTextUnits(delivery.content.text, limit.unit) <= limit.maximum)).toBe(true);
      expect(journey.consumed.every(delivery => delivery.replyContext !== undefined && 'threadId' in delivery.replyContext
        && delivery.replyContext.threadId === endpoint.id)).toBe(true);
      const count = journey.nativeMessages.length;
      await journey.outward();
      expect(journey.nativeMessages).toHaveLength(count);
      expect([...journey.deliveries.rows.values()].some(row => isChannelStateJsonRecord(row.value.payload)
        && row.value.payload.state === 'delivered' && isChannelStateJsonRecord(row.value.payload.source)
        && row.value.payload.source.kind === 'sessionProjection')).toBe(true);
      journey.validateWrites();
    } finally { await journey.dispose(); }
  });

  it('retains Slack Retry-After in core custody without resending before it is due', async () => {
    const journey = await slackJourney({ rateLimited: true });
    try {
      await journey.ingestSlack(); journey.answer('Try this deployment again later.');
      const before = Date.now();
      await journey.outward();
      expect(journey.nativeMessages).toHaveLength(1);
      const custody = [...journey.deliveries.rows.values()].find(row => row.value['record-kind'] === 'outward-delivery');
      expect(custody?.value.payload).toMatchObject({ state: 'retryDue', providerMessageIds: [] });
      expect(Number(custody?.value['retry-not-before'])).toBeGreaterThanOrEqual(before + 90_000);
      await journey.outward();
      expect(journey.nativeMessages).toHaveLength(1);
      journey.validateWrites();
    } finally { await journey.dispose(); }
  });

  it('finishes claimed Slack chunks and stops the next delivery when the connection is disabled', async () => {
    const journey = await slackJourney({ disableAfterFirstChunk: true });
    try {
      const text = 'x'.repeat(journey.prepared.outboundTextLimit!.maximum + 1);
      await journey.ingestSlack(); journey.answer(text);
      await journey.outward();
      expect(journey.nativeMessages).toHaveLength(2);
      expect(journey.nativeMessages.map(message => message.text).join('')).toBe(text);
      const custody = [...journey.deliveries.rows.values()].find(row => row.value['record-kind'] === 'outward-delivery');
      expect(custody?.value.payload).toMatchObject({ state: 'delivered', providerMessageIds: ['1700000001.000001', '1700000001.000002'] });
      expect((await journey.state.get('connection-1'))?.value.payload).toMatchObject({ enabled: false });
      journey.answer('A distinct later reply must not be sent after disablement.');
      await journey.outward();
      expect(journey.nativeMessages).toHaveLength(2);
      journey.validateWrites();
    } finally { await journey.dispose(); }
  });

  it('cannot report delivery when the registered role is misbound to the real connection-test consumer', async () => {
    const journey = await slackJourney({ wrongDeliveryHandler: true });
    try {
      await journey.ingestSlack(); journey.answer('A strict consumer must refuse this miswired invocation.');
      await journey.outward();
      expect(journey.consumed).toHaveLength(1);
      expect(journey.nativeMessages).toEqual([]);
      const custody = [...journey.deliveries.rows.values()].find(row => row.value['record-kind'] === 'outward-delivery');
      expect(custody?.value.payload).toMatchObject({ state: 'outcomeUnknown', providerMessageIds: [] });
      journey.validateWrites();
    } finally { await journey.dispose(); }
  });
});
