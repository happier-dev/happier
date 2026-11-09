import { describe, expect, it } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionSendRequest, SessionSummary } from '@happier-dev/plugin-sdk/sessions';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate as activateTelegram, PLUGIN_MANIFEST as telegramManifest } from '@happier-dev/plugins-channel-telegram';
import { activate as activateDiscord, PLUGIN_MANIFEST as discordManifest } from '@happier-dev/plugins-channel-discord';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { parseDiscordMessageDispatch } from '../../channel-discord/src/discordMessage.js';
import { mapDiscordMessageToSocketIngress } from '../../channel-discord/src/discordObservation.js';
import { createDiscordSetupResult } from '../../channel-discord/src/discordSetup.js';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_COLLECTION } from './collections.js';
import { isChannelStateJsonRecord } from './accountLocalBindingPolicy.js';
import { createChannelsJourneyFixture } from './testkit/channelsJourney.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';

function response(value: unknown, finalUrl: string) {
  return { status: 200, finalUrl, headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)) };
}

describe('registered native conversation starts', () => {
  it.each([
    { kind: 'Telegram', inputMode: 'directMentionsOnly' },
    { kind: 'Telegram', inputMode: 'addressedMessages' },
    { kind: 'Discord', inputMode: 'directMentionsOnly' },
    { kind: 'Discord', inputMode: 'addressedMessages' },
  ] as const)(
    '$kind starts once through custody, binds the child and admits its reply to the named Session ($inputMode)', async ({ kind, inputMode }) => {
      const telegram = kind === 'Telegram';
      const manifest = telegram ? telegramManifest : discordManifest;
      const machineId = 'conversation-start-machine';
      const placement = { serverIdentityId: 'srv_plugin_testkit', materializationRef: {
        pluginId: manifest.id, machineId, materializationId: 'native-start-fixture',
      } };
      const credentialRef = { service: { pluginId: manifest.id, localId: telegram ? 'telegram-bot' : 'discord-bot' }, accountId: 'fixture' };
      const parent = telegram ? { kind: 'shared', audience: 'shared', id: '-100456' } as const
        : { kind: 'shared', audience: 'shared', id: 'discord:channel:parent-1' } as const;
      const child = telegram ? { kind: 'thread', audience: 'shared', id: '-100456:17', parentId: '-100456' } as const
        : { kind: 'thread', audience: 'shared', id: 'discord:channel:thread-1', parentId: 'discord:channel:parent-1' } as const;
      const principal = telegram ? '42' : 'discord:user:human-1';
      const nativeMessages: Record<string, unknown>[] = [];
      let creates = 0;
      let updates: JsonValue[] = [];
      const http = createPluginHttpFixture({ async request(request) {
        const path = new URL(request.url).pathname;
        if (telegram) {
          if (path.endsWith('/getMe')) return response({ ok: true, result: {
            id: 123, is_bot: true, first_name: 'Happier', username: 'HappierBot', can_read_all_group_messages: false,
          } }, request.url);
          if (path.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '', pending_update_count: 0 } }, request.url);
          if (path.endsWith('/getChat')) return response({ ok: true, result: { id: -100456, type: 'supergroup', is_forum: true } }, request.url);
          if (path.endsWith('/getUpdates')) return response({ ok: true, result: updates }, request.url);
          if (path.endsWith('/createForumTopic')) {
            creates++;
            return response({ ok: true, result: { message_thread_id: 17, name: 'Brief' } }, request.url);
          }
          if (path.endsWith('/sendMessage')) {
            nativeMessages.push(JSON.parse(new TextDecoder().decode(request.body)));
            return response({ ok: true, result: { message_id: 70 + nativeMessages.length } }, request.url);
          }
        } else {
          if (path.endsWith('/oauth2/applications/@me')) return response({ id: 'app-1' }, request.url);
          if (path.endsWith('/users/@me')) return response({ id: 'bot-1', username: 'Happier', bot: true }, request.url);
          if (path.endsWith('/channels/parent-1')) return response({ id: 'parent-1', type: 0 }, request.url);
          if (path.endsWith('/channels/thread-1')) return response({ id: 'thread-1', type: 11, parent_id: 'parent-1' }, request.url);
          if (path.endsWith('/channels/parent-1/threads')) {
            creates++;
            return response({ id: 'thread-1', type: 11, parent_id: 'parent-1' }, request.url);
          }
          if (path.endsWith('/channels/thread-1/messages')) {
            nativeMessages.push(JSON.parse(new TextDecoder().decode(request.body)));
            return response({ id: `message-${nativeMessages.length}`, channel_id: 'thread-1' }, request.url);
          }
        }
        throw new Error(`Unexpected fixture request ${path}`);
      } });
      // Host credentials, Account storage and Session transport are genuine external boundaries.
      const connectedAccounts = { async materialize() { return { kind: 'environment', env: telegram
        ? { TELEGRAM_BOT_TOKEN: '123:fixture' } : { DISCORD_BOT_TOKEN: 'fixture' } }; } } as unknown as PluginServices['connectedAccounts'];
      const provider = await createPluginTestkit({ manifest, module: { activate: telegram ? activateTelegram : activateDiscord },
        services: { http, connectedAccounts, actions: { async execute(action: string) {
          if (action === 'automation.event.sources.list') return { kind: 'page', definitions: [], nextCursor: null, revision: '1' };
          throw new Error(`Unexpected provider host Action ${action}`);
        } } as unknown as PluginServices['actions'] }, resolveCurrentPluginMaterializationRef: () => placement.materializationRef });
      const connection = createCurrentConversationConnectionFixture({ connectionId: 'start-connection',
        transport: { kind: telegram ? 'checkpointedPull' : 'socket' }, replayContinuity: telegram ? 'checkpointed' : 'sessionBound',
        outboundTextLimit: { maximum: telegram ? 4096 : 2000, unit: 'unicodeCodePoints' }, sharedEndpointInputModes: ['directMentionsOnly', 'addressedMessages'],
        authority: { providerPluginId: manifest.id, providerContributionSelection: { contributionId: telegram ? 'telegram-provider' : 'discord-provider' },
          providerSetupInput: { credentialRef }, credentialRef, transportOrigin: placement,
          providerConnectionKey: telegram ? 'telegram-bot:123' : 'discord:application:app-1',
          providerConfig: telegram ? { botUsername: 'HappierBot', canReadAllGroupMessages: false } : { applicationId: 'app-1', botUserId: 'bot-1' },
          integrationPrincipal: telegram ? { id: '123' }
            : createDiscordSetupResult({ applicationId: 'app-1', botUserId: 'bot-1' }, credentialRef).integrationPrincipal,
          routingIdentityKey: 'a'.repeat(43), authorityEpoch: 1 } });
      const binding = { id: 'start-router', 'record-kind': 'binding', v: 1, 'connection-id': 'start-connection', 'binding-id': 'start-router',
        'created-at': 1, 'updated-at': 1, payload: {
          endpoint: parent, authorityEpoch: 1, enabled: true, deletionState: 'none',
          target: { kind: 'threadRouter', principalGroups: [{ id: 'brief', principalIds: [principal] }], routes: [] },
          allowedPrincipalIds: [principal], allowBotSenders: false, inputMode,
          inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
        } };
      const admissions: { sessionId: string; request: SessionSendRequest }[] = [];
      const summary = { id: 'named-session', machineId, hasAttestedContext: false, state: 'idle',
        runtimeAvailability: { status: 'available' }, storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 } satisfies SessionSummary;
      const sessions = { async get(id: string) { return id === summary.id ? {
        async summary() { return summary; }, async send(request: SessionSendRequest) {
          admissions.push({ sessionId: id, request }); return { status: 'accepted', localId: 'reply-1' };
        },
      } : null; } } as unknown as PluginServices['sessions'];
      const actions = { async execute(action: string) {
        if (action === 'session.permission.remote.pending.list') return { requests: [], truncated: false, nextCursor: null };
        if (action === 'session.transcript.get') return { ok: true, projection: 'externalShareableV1', sessionId: summary.id,
          scannedThroughSeq: 0, nextCursor: '0', hasMore: false, items: [] };
        throw new Error(`Unexpected host Action ${action}: a started conversation must not spawn another Session`);
      } } as unknown as PluginServices['actions'];
      let journey: Awaited<ReturnType<typeof createChannelsJourneyFixture>> | undefined;
      try {
        journey = await createChannelsJourneyFixture({ provider, connection, binding, sessions, actions,
          resolveCurrentProviderExecutionOrigin: () => placement });
        if (telegram) await journey.poll();
        const text = 'x'.repeat(70_000);
        const accepted = await journey.invoke('conversation/start-v1', { routerBindingId: 'start-router', audienceGroupId: 'brief',
          subject: 'Brief', content: { text, html: '<p>Not sent natively</p>' }, sessionId: summary.id });
        expect(accepted).toMatchObject({ kind: 'accepted' });
        await journey.outward();
        await journey.outward();
        const children = [...journey.state.rows.values()].filter(row => !row.deleted && isChannelStateJsonRecord(row.value.payload)
          && row.value.payload.parentBindingId === 'start-router');
        expect(children).toHaveLength(1);
        expect(children[0]?.value.payload).toMatchObject({ endpoint: child, inputMode,
          allowedPrincipalIds: [principal], target: { kind: 'session', sessionId: summary.id } });
        expect(creates).toBe(1);
        expect(nativeMessages.map(message => telegram ? message.text : message.content).join('')).toBe(text);
        expect(nativeMessages).toHaveLength(Math.ceil(text.length / (telegram ? 4096 : 2000)));
        expect([...journey.deliveries.rows.values()].filter(row => !row.deleted)).toHaveLength(1);
        expect([...journey.deliveries.rows.values()][0]?.value.payload).toMatchObject({
          state: 'delivered', deliveryEndpoint: child, threadBindingPending: false,
        });
        const now = Date.now();
        if (telegram) {
          updates = [{ update_id: 2, message: { message_id: 1000, date: Math.floor(now / 1000),
            message_thread_id: 17, is_topic_message: true, chat: { id: -100456, type: 'supergroup', is_forum: true },
            from: { id: 42, is_bot: false },
            text: inputMode === 'directMentionsOnly' ? '@HappierBot Continue the brief' : 'Continue the brief',
            ...(inputMode === 'directMentionsOnly' ? { entities: [{ type: 'mention', offset: 0, length: 11 }] } : {}),
            reply_to_message: { message_id: 71, from: { id: 123, is_bot: true } },
          } }];
          await journey.poll();
        } else {
          const parsed = parseDiscordMessageDispatch({ event: 'MESSAGE_CREATE', channel: {
            kind: 'thread', channelId: 'thread-1', parentChannelId: 'parent-1',
          }, context: { botUserId: 'bot-1', applicationId: 'app-1', botRoleIds: [], messageContentIntentEnabled: true }, payload: {
            id: 'reply-message', channel_id: 'thread-1', timestamp: new Date(now).toISOString(), type: 19,
            author: { id: 'human-1', bot: false },
            content: inputMode === 'directMentionsOnly' ? '<@bot-1> Continue the brief' : 'Continue the brief',
            mentions: inputMode === 'directMentionsOnly' ? [{ id: 'bot-1' }] : [], attachments: [],
            message_reference: { message_id: 'message-1', channel_id: 'thread-1' },
            referenced_message: { id: 'message-1', author: { id: 'bot-1', bot: true } },
          } });
          const observation = mapDiscordMessageToSocketIngress({ parsed });
          if (observation === null) throw new Error('Native reply must produce ingress');
          await journey.ingest({ connectionId: 'start-connection', authorityEpoch: 1, entry: { observation, eventCandidate: null } });
        }
        expect(admissions).toHaveLength(1);
        expect(admissions[0]).toMatchObject({ sessionId: summary.id, request: { kind: 'userText', text: expect.stringContaining('Continue the brief') } });
        expect(creates).toBe(1);
        for (const [collection, definition] of [[journey.state, CHANNEL_STATE_COLLECTION], [journey.deliveries, CHANNEL_DELIVERIES_COLLECTION]] as const) {
          const schema = compilePluginJsonSchema(definition.schema);
          for (const row of collection.rows.values()) if (!row.deleted) expect(isValidPluginJsonSchemaValue(schema, row.value), row.rowId).toBe(true);
        }
      } finally { await journey?.dispose(); await provider.dispose(); }
    },
  );
});
