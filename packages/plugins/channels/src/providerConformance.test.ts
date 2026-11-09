import { expect } from 'vitest';
import { simpleParser } from 'mailparser';
import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { activate as activateTelegram, PLUGIN_MANIFEST as telegramManifest } from '@happier-dev/plugins-channel-telegram';
import { activate as activateDiscord, PLUGIN_MANIFEST as discordManifest } from '@happier-dev/plugins-channel-discord';
import { TELEGRAM_MAX_MESSAGE_CODE_POINTS } from '../../channel-telegram/src/telegramBotApi.js';
import { TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID } from '../../channel-telegram/src/constants.js';
import { DISCORD_MESSAGE_MAXIMUM_CODE_POINTS } from '../../channel-discord/src/discordDelivery.js';
import { createDiscordGatewaySession, type DiscordGatewaySession } from '../../channel-discord/src/discordGateway.js';
import { parseDiscordMessageDispatch } from '../../channel-discord/src/discordMessage.js';
import { mapDiscordMessageToSocketIngress } from '../../channel-discord/src/discordObservation.js';
import { emailPlugin } from '../../channel-email/src/plugin.js';
import { EmailTransportsContributionProtocolV1 as emailProtocol, EmailTransportFetchRawInputV1Schema,
  EmailTransportSubmitRawInputV1Schema, type EmailTransportListSinceResultV1 } from '../../channel-email/src/transports.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { channelsOperationOnlyTargetedContributionsFixture } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { defineProviderConformanceJourneys, type ChannelsJourney, type ProviderConformanceAdapter,
  type ProviderConformanceNativeSend } from './testkit/providerConformance.js';

const connectionId = 'conformance-connection';
const thread = { kind: 'thread', audience: 'shared', id: '-100456:7', parentId: '-100456' } as const;
const parent = { kind: 'shared', audience: 'shared', id: '-100456' } as const;

function response(value: unknown, url: string) {
  return { status: 200, finalUrl: url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
}
function record(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a native JSON object');
  return value as Record<string, JsonValue>;
}
function body(request: Parameters<PluginServices['http']['request']>[0]) { return record(JSON.parse(new TextDecoder().decode(request.body))); }
function origin(pluginId: string) {
  return { serverIdentityId: 'srv_plugin_testkit', materializationRef: { pluginId, machineId: 'conformance-machine', materializationId: `${pluginId}-fixture` } };
}
const unusedSocket = async (): Promise<PluginWebSocketConnection> => { throw new Error('This provider fixture does not open a network socket'); };

async function baselineReset(journey: ChannelsJourney) {
  const row = await journey.state.get(connectionId);
  if (!row) throw new Error('Missing gap connection');
  const revision = record(row.value.payload).configurationRevision;
  if (typeof revision !== 'number') throw new Error('Missing logical connection revision');
  expect(await journey.invoke('stream/notice-dismiss-v1', { connectionId, expectedRevision: revision })).toMatchObject({ kind: 'noticeDismissed' });
}

async function telegramAdapter(): Promise<ProviderConformanceAdapter> {
  const receivedAtMs = Date.now();
  const pluginId = telegramManifest.id;
  const placement = origin(pluginId);
  const credentialRef = { service: { pluginId, localId: 'telegram-bot' }, accountId: 'fixture' };
  const sent: ProviderConformanceNativeSend[] = [];
  let afterSend: (() => Promise<void>) | undefined;
  let updates: JsonValue[] = [];
  const http: PluginServices['http'] = createPluginHttpFixture({ openWebSocket: unusedSocket, async request(request) {
    let result: JsonValue;
    if (request.url.endsWith('/getMe')) result = { id: 123, is_bot: true, first_name: 'Happier', username: 'HappierBot',
      can_read_all_group_messages: true, has_topics_enabled: true };
    else if (request.url.endsWith('/getWebhookInfo')) result = { url: '', pending_update_count: 0 };
    else if (request.url.endsWith('/getUpdates')) result = updates;
    else if (request.url.endsWith('/getChat')) {
      const id = String(body(request).chat_id);
      result = id === '456' ? { id: 456, type: 'private', first_name: 'Human' }
        : { id: -100456, type: 'supergroup', title: 'Forum', is_forum: true };
    } else if (request.url.endsWith('/sendMessage')) {
      const payload = body(request);
      const reply = payload.reply_parameters === undefined ? undefined : String(record(payload.reply_parameters).message_id);
      sent.push({ text: String(payload.text), address: { chat_id: payload.chat_id!,
        ...(payload.message_thread_id === undefined ? {} : { message_thread_id: payload.message_thread_id }) },
        ...(reply === undefined ? {} : { replyTo: reply }), mentionsSuppressed: !String(payload.text).includes('@') });
      if (sent.length === 1) await afterSend?.();
      result = { message_id: 100 + sent.length };
    } else throw new Error(`Unexpected Telegram fixture request: ${new URL(request.url).pathname.split('/').at(-1)}`);
    return response({ ok: true, result }, request.url);
  } });
  const connectedAccounts = { async materialize() { return { kind: 'environment', env: { TELEGRAM_BOT_TOKEN: '123:fixture' } }; } } as unknown as PluginServices['connectedAccounts'];
  const provider = await createPluginTestkit({ manifest: telegramManifest, module: { activate: activateTelegram }, services: { http, connectedAccounts },
    resolveCurrentPluginMaterializationRef: () => placement.materializationRef });
  const connection = createCurrentConversationConnectionFixture({ connectionId, outboundTextLimit: { maximum: TELEGRAM_MAX_MESSAGE_CODE_POINTS, unit: 'unicodeCodePoints' },
    authority: { providerPluginId: pluginId, providerContributionSelection: { contributionId: TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID },
      providerSetupInput: { credentialRef }, credentialRef, transportOrigin: placement, providerConnectionKey: 'telegram-bot:123',
      providerConfig: { botUsername: 'HappierBot', canReadAllGroupMessages: true }, integrationPrincipal: { id: '123' }, routingIdentityKey: 't'.repeat(43), authorityEpoch: 1 } });
  return { provider, connection, origin: () => placement, endpoint: thread, parent, allowedPrincipals: ['42', '43', '123'],
    nativeLimit: TELEGRAM_MAX_MESSAGE_CODE_POINTS, expectedAddress: { chat_id: '-100456', message_thread_id: 7 }, sent,
    messageId: String, expectedText: text => text.replaceAll('@', '＠'), afterSend(effect) { afterSend = effect; },
    baseline: async journey => { await journey.poll(); },
    async receive(journey, message) {
      const privateTopic = message.topic === 'private';
      const plainReply = message.topic === 'ordinary';
      const general = message.topic === 'general';
      updates = [{ update_id: message.id, message: { message_id: message.id, date: Math.floor(receivedAtMs / 1000),
        chat: privateTopic ? { id: 456, type: 'private' } : { id: -100456, type: 'supergroup', is_forum: !plainReply },
        message_thread_id: plainReply ? 11 : general ? 1 : privateTopic ? 3 : 7,
        is_topic_message: !(plainReply || general),
        from: { id: message.actor === 'self' ? 123 : message.actor === 'bot' ? 43 : message.actor === 'stranger' ? 99 : 42,
          is_bot: message.actor === 'bot' || message.actor === 'self', first_name: 'Actor' }, text: message.text,
        ...(plainReply ? { reply_to_message: { message_id: 9, from: { id: 123, is_bot: true, first_name: 'Happier' } } } : {}),
        ...(message.forwarded ? { forward_origin: { type: 'user', date: 1, sender_user: { id: 99, is_bot: false, first_name: 'Original' } } } : {}),
      } }];
      await journey.poll();
    },
    async gap(journey) {
      updates = [];
      const checkpoint = [...journey.state.rows.values()].find(row => row.value['record-kind'] === 'checkpoint');
      if (!checkpoint) throw new Error('Missing Telegram checkpoint');
      const payload = record(checkpoint.value.payload);
      await journey.state.put({ ...checkpoint.value, payload: { ...payload, opaqueToken: { ...record(payload.opaqueToken), caughtUpAtMs: 0 } } },
        { expectedRevision: checkpoint.revision });
      await journey.poll();
    },
    recover: baselineReset, dispose: () => provider.dispose(),
  };
}

async function discordAdapter(): Promise<ProviderConformanceAdapter> {
  const receivedAtMs = Date.now();
  const pluginId = discordManifest.id;
  const placement = origin(pluginId);
  const credentialRef = { service: { pluginId, localId: 'discord-bot' }, accountId: 'fixture' };
  const sent: ProviderConformanceNativeSend[] = [];
  let afterSend: (() => Promise<void>) | undefined;
  const http: PluginServices['http'] = createPluginHttpFixture({ openWebSocket: unusedSocket, async request(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/users/@me')) return response({ id: 'bot-1', username: 'Happier', bot: true }, request.url);
    if (path.endsWith('/oauth2/applications/@me')) return response({ id: 'app-1', name: 'Happier' }, request.url);
    if (path.endsWith('/channels/thread-1')) return response({ id: 'thread-1', type: 11, parent_id: 'parent-1', name: 'Thread', thread_metadata: { archived: false, locked: false } }, request.url);
    if (path.endsWith('/channels/thread-1/messages')) {
      const payload = body(request);
      const mentions = record(payload.allowed_mentions);
      const reply = payload.message_reference === undefined ? undefined : String(record(payload.message_reference).message_id);
      sent.push({ text: String(payload.content), address: { channel_id: 'thread-1' }, ...(reply === undefined ? {} : { replyTo: reply }),
        mentionsSuppressed: Array.isArray(mentions.parse) && mentions.parse.length === 0 });
      if (sent.length === 1) await afterSend?.();
      return response({ id: `accepted-${sent.length}`, channel_id: 'thread-1' }, request.url);
    }
    throw new Error(`Unexpected Discord fixture request: ${path}`);
  } });
  const connectedAccounts = { async materialize() { return { kind: 'environment', env: { DISCORD_BOT_TOKEN: 'fixture' } }; } } as unknown as PluginServices['connectedAccounts'];
  const provider = await createPluginTestkit({ manifest: discordManifest, module: { activate: activateDiscord }, services: { http, connectedAccounts },
    resolveCurrentPluginMaterializationRef: () => placement.materializationRef });
  const endpoint = { kind: 'thread', audience: 'shared', id: 'discord:channel:thread-1', parentId: 'discord:channel:parent-1' } as const;
  const connection = createCurrentConversationConnectionFixture({ connectionId, transport: { kind: 'socket' }, replayContinuity: 'sessionBound',
    outboundTextLimit: { maximum: DISCORD_MESSAGE_MAXIMUM_CODE_POINTS, unit: 'unicodeCodePoints' },
    authority: { providerPluginId: pluginId, providerContributionSelection: { contributionId: 'discord-provider' }, providerSetupInput: { credentialRef }, credentialRef,
      transportOrigin: placement, providerConnectionKey: 'discord:application:app-1', providerConfig: { applicationId: 'app-1', botUserId: 'bot-1' },
      integrationPrincipal: { id: 'bot-1' }, routingIdentityKey: 'd'.repeat(43), authorityEpoch: 1 } });
  function gateway(): DiscordGatewaySession {
    return createDiscordGatewaySession({ token: 'fixture', intents: 4608, sessionStartLimit: {
      total: 1000, remaining: 999, resetAfterMs: 86400000, maxConcurrency: 1, observedAtMs: Date.now() },
      resume: { sessionId: 'fixture-session', resumeGatewayUrl: 'wss://gateway.discord.gg', lastDispatchSequence: 1 } });
  }
  let session = gateway();
  let sequence = 1;
  return { provider, connection, origin: () => placement, endpoint, parent: { kind: 'shared', audience: 'shared', id: endpoint.parentId },
    allowedPrincipals: ['discord:user:human-1', 'discord:user:other-bot', 'discord:user:bot-1'], nativeLimit: DISCORD_MESSAGE_MAXIMUM_CODE_POINTS,
    expectedAddress: { channel_id: 'thread-1' }, sent, messageId: id => `message-${id}`, replyOnLaterChunks: true, expectedText: text => text,
    afterSend(effect) { afterSend = effect; }, baseline: async () => {},
    async receive(journey, message) {
      const frames = session.onFrame({ op: 0, t: 'MESSAGE_CREATE', s: ++sequence, d: { id: `message-${message.id}`, channel_id: 'thread-1',
        timestamp: new Date(receivedAtMs).toISOString(), type: 0, content: message.text,
        author: { id: message.actor === 'self' ? 'bot-1' : message.actor === 'bot' ? 'other-bot' : message.actor === 'stranger' ? 'stranger' : 'human-1',
          bot: message.actor === 'bot' || message.actor === 'self' },
        ...(message.forwarded ? { message_reference: { type: 1, message_id: 'source', channel_id: 'elsewhere' },
          message_snapshots: [{ message: { type: 0, content: message.text, attachments: [], embeds: [] } }] } : {}),
      } }, Date.now());
      const dispatch = frames.find(effect => effect.kind === 'dispatch');
      if (!dispatch || dispatch.kind !== 'dispatch') throw new Error('Expected native Gateway Dispatch');
      const parsed = parseDiscordMessageDispatch({ event: 'MESSAGE_CREATE', payload: dispatch.payload,
        channel: { kind: 'thread', channelId: 'thread-1', parentChannelId: 'parent-1' },
        context: { botUserId: 'bot-1', applicationId: 'app-1', botRoleIds: [], messageContentIntentEnabled: true } });
      const normalized = mapDiscordMessageToSocketIngress({ parsed });
      if (!normalized) throw new Error('Expected native Discord observation');
      await journey.ingest({ connectionId, authorityEpoch: 1, entry: { observation: normalized, eventCandidate: null } });
    },
    async gap(journey) {
      const fact = session.onFrame({ op: 9, d: false }, Date.now()).find(effect => effect.kind === 'historyGap');
      if (!fact || fact.kind !== 'historyGap') throw new Error('Native non-resumable session must report a gap');
      await journey.invoke('journey/transport-fact', { connectionId, authorityEpoch: 1, fact });
    },
    async recover(journey) { await baselineReset(journey); session = gateway(); }, dispose: () => provider.dispose(),
  };
}

async function emailAdapter(): Promise<ProviderConformanceAdapter> {
  const receivedAtMs = Date.now();
  const mailbox = 'happier@example.com';
  const human = 'human@example.com';
  const placement = origin(emailPlugin.manifest.id);
  const sent: ProviderConformanceNativeSend[] = [];
  const messages = new Map<string, string>();
  let replyText = '';
  let refs: string[] = [];
  let generation = 1;
  let activeJourney: ChannelsJourney;
  const ops = emailProtocol.operations;
  const transportDefinition = definePlugin({ id: 'example.conformance-mail', version: '0.0.0', actions: {
    list: { title: 'List mail', surfaces: ops.listSince.declaration.surfaces, dangerLevel: ops.listSince.declaration.dangerLevel, inputSchema: ops.listSince.declaration.input.schema.jsonSchema,
      resultSchema: ops.listSince.declaration.resultSchema.jsonSchema, run: async (input): Promise<EmailTransportListSinceResultV1> => {
        const checkpoint = record(input).checkpoint;
        if (checkpoint !== null && record(checkpoint).generation !== generation) return { kind: 'historyGap', reason: 'providerHistoryUnavailable' };
        return { kind: 'batch', refs: checkpoint === null ? [] : refs, checkpointAfterBatch: { generation } };
      } },
    fetch: { title: 'Fetch raw mail', surfaces: ops.fetchRaw.declaration.surfaces, dangerLevel: ops.fetchRaw.declaration.dangerLevel, inputSchema: ops.fetchRaw.declaration.input.schema.jsonSchema,
      resultSchema: ops.fetchRaw.declaration.resultSchema.jsonSchema, run: async input => {
        const { ref } = EmailTransportFetchRawInputV1Schema.parse(input);
        const raw = messages.get(ref);
        if (raw === undefined) throw new Error('Missing native MIME fixture');
        return { kind: 'raw', mimeBase64: Buffer.from(raw).toString('base64'), receivedAtMs };
      } },
    submit: { title: 'Submit raw mail', surfaces: ops.submitRaw.declaration.surfaces, dangerLevel: ops.submitRaw.declaration.dangerLevel, inputSchema: ops.submitRaw.declaration.input.schema.jsonSchema,
      resultSchema: ops.submitRaw.declaration.resultSchema.jsonSchema, run: async input => {
        const request = EmailTransportSubmitRawInputV1Schema.parse(input);
        // Inspect the native text alternative without reapplying inbound HTML shaping.
        const mime = await simpleParser(Buffer.from(request.mimeBase64, 'base64'), { skipHtmlToText: true, skipTextToHtml: true });
        if (mime.text === undefined) throw new Error('The native Email reply must include its text alternative');
        sent.push({ text: mime.text.replace(/\r\n/g, '\n').trimEnd(), address: { from: request.envelope.from, to: [...request.envelope.to] },
          ...(mime.inReplyTo === undefined ? {} : { replyTo: mime.inReplyTo }),
          // MIME has no chat-mention primitive; recipients remain exact native envelope principals.
          mentionsSuppressed: request.envelope.to.length === 1 && request.envelope.to[0] === human });
        return { kind: 'delivered', providerMessageIds: [request.messageId] };
      } },
    test: { title: 'Test mail', surfaces: ops.connectionTest.declaration.surfaces, dangerLevel: ops.connectionTest.declaration.dangerLevel, inputSchema: ops.connectionTest.declaration.input.schema.jsonSchema,
      resultSchema: ops.connectionTest.declaration.resultSchema.jsonSchema, run: async () => ({ kind: 'ready', mailbox }) },
  }, contributesTo: { 'happier.channel.email': { transports: { fixture: emailProtocol.contribute({ operations: {
    listSince: ops.listSince.bind('list'), fetchRaw: ops.fetchRaw.bind('fetch'), submitRaw: ops.submitRaw.bind('submit'), connectionTest: ops.connectionTest.bind('test'),
  } }) } } } });
  const transport = await createPluginTestkit({ manifest: transportDefinition.manifest, module: transportDefinition });
  let provider: PluginTestkit;
  provider = await createPluginTestkit({ manifest: emailPlugin.manifest, targetedContributionContributors: [transport],
    resolveCurrentPluginMaterializationRef: () => placement.materializationRef,
    module: { activate(api) { return emailPlugin.activate({ ...api, actions: { ...api.actions,
      register: (id, run) => api.actions.register(id, (input: Parameters<typeof run>[0], context) => {
        // Host dispatch is substituted; the registered core reader and schemas stay real.
        const executeCore = async (action: { pluginId: string; localId: string }, value: unknown) =>
          activeJourney.executeProviderCoreAction(action, value, context);
        return run(input, { ...context, services: { ...context.services,
          actions: { ...context.services.actions, execute: executeCore as PluginServices['actions']['execute'] },
          targetedContributions: channelsOperationOnlyTargetedContributionsFixture(provider, emailPlugin.contributionPoints.transports) } });
      }),
    } }); } } });
  const config = { mailbox, transport: { pluginId: transportDefinition.manifest.id, contributionId: 'fixture' }, transportConfig: {},
    trustStrategy: { kind: 'authenticationResults', authservId: 'mx.example.com' }, quotedHistory: 'never', stripSignatures: false, bodyFormat: 'text' };
  const base = createCurrentConversationConnectionFixture({ connectionId, authority: { providerPluginId: emailPlugin.manifest.id,
    providerContributionSelection: { contributionId: 'email-provider' }, providerSetupInput: {}, credentialRef: null, transportOrigin: placement,
    providerConnectionKey: `email:${mailbox}`, providerConfig: config, integrationPrincipal: { id: mailbox }, routingIdentityKey: 'e'.repeat(43), authorityEpoch: 1 } });
  const { outboundTextLimit: _fixtureDefault, ...payload } = base.payload;
  return { provider, connection: { ...base, payload }, origin: () => placement,
    endpoint: { kind: 'thread', audience: 'direct', id: '<root@example.com>', parentId: mailbox }, parent: { kind: 'direct', audience: 'direct', id: mailbox },
    allowedPrincipals: [human, 'bot@example.com', mailbox], sent, expectedAddress: { from: mailbox, to: [human] },
    messageId: id => `<message-${id}@example.com>`, expectedText: text => `${text}\n\n> ${replyText}`, baseline: async journey => { activeJourney = journey; await journey.poll(); },
    async receive(journey, message) {
      replyText = message.text;
      const id = `<message-${message.id}@example.com>`;
      const from = message.actor === 'self' ? mailbox : message.actor === 'bot' ? 'bot@example.com' : message.actor === 'stranger' ? 'stranger@example.com' : human;
      const raw = [`From: ${from}`, `To: ${mailbox}`, `Message-ID: ${id}`, 'References: <root@example.com>',
        message.forwarded ? 'Subject: Fwd: Question' : 'Subject: Question', 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
        ...(message.actor === 'bot' ? ['Auto-Submitted: auto-replied'] : []),
        'Content-Type: text/plain; charset=utf-8', '', message.text].join('\r\n');
      messages.set(id, raw); refs = [id]; await journey.poll();
    },
    async gap(journey) { generation += 1; refs = []; await journey.poll(); }, recover: baselineReset,
    async dispose() { await provider.dispose(); await transport.dispose(); },
  };
}

defineProviderConformanceJourneys({ name: 'Telegram', create: telegramAdapter, topics: [
  { name: 'forum topic', topic: 'forum', endpoint: thread, address: { chat_id: '-100456', message_thread_id: 7 } },
  { name: 'ordinary group reply', topic: 'ordinary', endpoint: parent, address: { chat_id: '-100456' } },
  { name: 'forum General', topic: 'general', endpoint: parent, address: { chat_id: '-100456' } },
  { name: 'private topic', topic: 'private', endpoint: { kind: 'thread', audience: 'direct', id: '456:3', parentId: '456' }, address: { chat_id: '456', message_thread_id: 3 } },
] });
defineProviderConformanceJourneys({ name: 'Discord', create: discordAdapter, topics: [
  { name: 'thread channel', topic: 'thread', endpoint: { kind: 'thread', audience: 'shared', id: 'discord:channel:thread-1', parentId: 'discord:channel:parent-1' }, address: { channel_id: 'thread-1' } },
] });
defineProviderConformanceJourneys({ name: 'Email', create: emailAdapter });
