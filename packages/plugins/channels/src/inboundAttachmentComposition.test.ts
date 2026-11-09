import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import type { SessionSendRequest, SessionSummary } from '@happier-dev/plugin-sdk/sessions';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate as activateTelegram, PLUGIN_MANIFEST as telegramManifest } from '@happier-dev/plugins-channel-telegram';
import { activate as activateDiscord, PLUGIN_MANIFEST as discordManifest } from '@happier-dev/plugins-channel-discord';
import { createDiscordGatewaySession } from '../../channel-discord/src/discordGateway.js';
import { parseDiscordMessageDispatch } from '../../channel-discord/src/discordMessage.js';
import { mapDiscordMessageToSocketIngress } from '../../channel-discord/src/discordObservation.js';
import { ChannelFileValueV1Schema } from './channelAttachment.js';
import { createChannelsJourneyFixture } from './testkit/channelsJourney.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';

type Provider = 'Telegram' | 'Discord';
type Failure = 'network' | 'expired' | 'overLimit';
const fileBytes = new TextEncoder().encode('A lead the agent can read.');
const connectionId = 'attachment-connection';
const sessionId = 'attachment-session';
const machineId = 'attachment-machine';

function jsonResponse(value: unknown, finalUrl: string) {
  return { status: 200, finalUrl, headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)) };
}

async function attachmentJourney(kind: Provider, options: { failure?: Failure; text?: string; omitRegistration?: boolean } = {}) {
  const manifest = kind === 'Telegram' ? telegramManifest : discordManifest;
  const text = options.text ?? 'Please inspect this lead';
  const receivedAt = Date.now();
  const placement = { serverIdentityId: 'srv_plugin_testkit', materializationRef: {
    pluginId: manifest.id, machineId, materializationId: `${kind}-attachment-fixture`,
  } };
  const credentialRef = { service: { pluginId: manifest.id, localId: kind === 'Telegram' ? 'telegram-bot' : 'discord-bot' }, accountId: 'fixture' };
  let updates: JsonValue[] = [];
  let metadataReads = 0;
  const downloads: string[] = [];
  const byteLength = options.failure === 'overLimit' ? 20 * 1024 * 1024 + 1 : fileBytes.byteLength;
  const nativeDiscordFile = { id: 'file-1', filename: 'lead.txt', content_type: 'text/plain', size: byteLength,
    url: 'https://cdn.discordapp.com/attachments/channel-1/file-1/lead.txt?ex=old&hm=old' };
  const http: PluginServices['http'] = createPluginHttpFixture({
    async openWebSocket() { throw new Error('This native-frame fixture does not open a live socket'); },
    async request(request) {
      const url = new URL(request.url);
      if (url.hostname === 'cdn.discordapp.com' || url.pathname.startsWith('/file/')) {
        downloads.push(request.url);
        expect(request.redirect).toBe('error');
        if (kind === 'Discord') expect(request.headers?.authorization).toBeUndefined();
        if (options.failure === 'network') throw new Error('Provider HTTP connection failed');
        return { status: options.failure === 'expired' ? 403 : 200, finalUrl: request.url,
          headers: { 'content-type': 'text/plain' }, body: options.failure === 'expired' ? new Uint8Array() : fileBytes };
      }
      if (kind === 'Telegram') {
        let result: JsonValue;
        if (url.pathname.endsWith('/getMe')) result = { id: 123, is_bot: true, first_name: 'Happier', username: 'HappierBot' };
        else if (url.pathname.endsWith('/getWebhookInfo')) result = { url: '', pending_update_count: 0 };
        else if (url.pathname.endsWith('/getUpdates')) result = updates;
        else if (url.pathname.endsWith('/getFile')) {
          metadataReads += 1;
          result = { file_id: 'telegram-file', file_unique_id: 'telegram-unique', file_size: byteLength,
            file_path: `documents/renewed-${metadataReads}.txt` };
        } else throw new Error(`Unexpected Telegram method ${url.pathname.split('/').at(-1)}`);
        return jsonResponse({ ok: true, result }, request.url);
      }
      if (url.pathname.endsWith('/oauth2/applications/@me')) return jsonResponse({ id: 'app-1', name: 'Happier' }, request.url);
      if (url.pathname.endsWith('/users/@me')) return jsonResponse({ id: 'bot-1', bot: true, username: 'Happier' }, request.url);
      if (url.pathname.endsWith('/channels/channel-1/messages/message-1')) {
        metadataReads += 1;
        return jsonResponse({ id: 'message-1', channel_id: 'channel-1', attachments: [
          { ...nativeDiscordFile, url: `https://cdn.discordapp.com/attachments/channel-1/file-1/lead.txt?ex=renewed-${metadataReads}&hm=fresh` },
        ] }, request.url);
      }
      throw new Error(`Unexpected Discord HTTP path ${url.pathname}`);
    },
  });
  // Credential materialization is the real host boundary; no stored credentials are read.
  const connectedAccounts = { async materialize() { return { kind: 'environment', env: kind === 'Telegram'
    ? { TELEGRAM_BOT_TOKEN: '123:fixture' } : { DISCORD_BOT_TOKEN: 'fixture' } }; } } as unknown as PluginServices['connectedAccounts'];
  const provider = await createPluginTestkit({ manifest, module: { activate: kind === 'Telegram' ? activateTelegram : activateDiscord },
    services: { http, connectedAccounts }, resolveCurrentPluginMaterializationRef: () => placement.materializationRef });
  const endpoint = kind === 'Telegram'
    ? { kind: 'direct', audience: 'direct', id: '456' } as const
    : { kind: 'direct', audience: 'direct', id: 'discord:channel:channel-1' } as const;
  const connection = createCurrentConversationConnectionFixture({ connectionId,
    ...(kind === 'Discord' ? { transport: { kind: 'socket' } as const, replayContinuity: 'sessionBound' as const } : {}),
    authority: { providerPluginId: manifest.id, providerContributionSelection: { contributionId: kind === 'Telegram' ? 'telegram-provider' : 'discord-provider' },
      providerSetupInput: { credentialRef }, credentialRef, transportOrigin: placement,
      providerConnectionKey: kind === 'Telegram' ? 'telegram-bot:123' : 'discord:application:app-1',
      providerConfig: kind === 'Telegram' ? { botUsername: 'HappierBot', canReadAllGroupMessages: false } : { applicationId: 'app-1', botUserId: 'bot-1' },
      integrationPrincipal: { id: kind === 'Telegram' ? '123' : 'bot-1' }, routingIdentityKey: 'a'.repeat(43), authorityEpoch: 1 } });
  const admissions: Extract<SessionSendRequest, { kind: 'userText' }>[] = [];
  const transferred: { name: string; bytes: Uint8Array; stagedPath: string }[] = [];
  const summary = { id: sessionId, machineId, state: 'idle', runtimeAvailability: { status: 'available' },
    storagePolicy: 'optional', encryptionMode: 'plain', updatedAtMs: 1 } satisfies SessionSummary;
  // Session transport/filesystem effects are host boundaries. The real core creates the attachment values and stages the bytes.
  const sessions = { async get(id: string) {
    if (id !== sessionId) return null;
    return { async summary() { return summary; }, async send(request: SessionSendRequest) {
      if (request.kind !== 'userText') throw new Error('Expected a user input');
      admissions.push(request);
      return { status: 'accepted', localId: 'input-1' };
    }, async materializeAttachment(request: { sourcePath: string; name: string }) {
      transferred.push({ name: request.name, bytes: await readFile(request.sourcePath), stagedPath: request.sourcePath });
      return { path: `/managed/attachments/${request.name}` };
    } };
  } } as unknown as PluginServices['sessions'];
  const actions = { async execute() { throw new Error('Attachment admission must not spawn or write through an alternate host Action'); } } as unknown as PluginServices['actions'];
  const binding = { id: 'attachment-binding', 'record-kind': 'binding', v: 1, 'connection-id': connectionId,
    'binding-id': 'attachment-binding', 'created-at': 1, 'updated-at': 1, payload: {
      endpoint, authorityEpoch: 1, enabled: true, deletionState: 'none',
      target: { kind: 'session', sessionId, policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
        approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
      allowedPrincipalIds: [kind === 'Telegram' ? '42' : 'discord:user:human-1'], allowBotSenders: false,
      inputMode: 'allAllowedMessages', inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
    } };
  const journey = await createChannelsJourneyFixture({ provider, connection, binding, sessions, actions,
    resolveCurrentProviderExecutionOrigin: () => placement, omitAttachmentRegistration: options.omitRegistration })
    .catch(async error => { await provider.dispose(); throw error; });
  if (kind === 'Telegram') await journey.poll();
  const gateway = kind === 'Discord' ? createDiscordGatewaySession({ token: 'fixture', intents: 4608,
    sessionStartLimit: { total: 1000, remaining: 999, resetAfterMs: 86_400_000, maxConcurrency: 1, observedAtMs: receivedAt },
    resume: { sessionId: 'fixture', resumeGatewayUrl: 'wss://gateway.discord.gg', lastDispatchSequence: 1 } }) : undefined;
  let sequence = 1;
  return { admissions, transferred, downloads, metadataReads: () => metadataReads,
    async receive() {
      if (kind === 'Telegram') {
        updates = [{ update_id: 2, message: { message_id: 10, date: Math.floor(receivedAt / 1000),
          chat: { id: 456, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Human' },
          ...(text ? { caption: text } : {}), document: { file_id: 'telegram-file', file_unique_id: 'telegram-unique',
            file_name: 'lead.txt', mime_type: 'text/plain', file_size: byteLength } } }];
        await journey.poll();
        return;
      }
      const dispatch = gateway!.onFrame({ op: 0, t: 'MESSAGE_CREATE', s: ++sequence, d: {
        id: 'message-1', channel_id: 'channel-1', timestamp: new Date(receivedAt).toISOString(), type: 0, content: text,
        author: { id: 'human-1', bot: false }, attachments: [nativeDiscordFile], embeds: [],
      } }, receivedAt).find(effect => effect.kind === 'dispatch');
      if (dispatch?.kind !== 'dispatch') throw new Error('Expected native Gateway dispatch');
      const parsed = parseDiscordMessageDispatch({ event: 'MESSAGE_CREATE', payload: dispatch.payload,
        channel: { kind: 'direct', channelId: 'channel-1' },
        context: { botUserId: 'bot-1', applicationId: 'app-1', botRoleIds: [], messageContentIntentEnabled: true } });
      const observation = mapDiscordMessageToSocketIngress({ parsed });
      if (!observation) throw new Error('Missing native observation');
      await journey.ingest({ connectionId, authorityEpoch: 1, entry: { observation, eventCandidate: null } });
    },
    async resolve() {
      const attachments = admissions[0]?.attachments;
      expect(attachments).toHaveLength(1);
      return await journey.resolveAttachments({ sessionId, localId: 'input-1', attachments: attachments!.map((attachment, index) => {
        if (typeof attachment.value.key !== 'string') throw new Error('Missing canonical attachment key');
        return { instanceId: `file-${index}`, key: attachment.value.key, value: ChannelFileValueV1Schema.parse(attachment.value.value) };
      }) });
    },
    async dispose() { await journey.dispose(); await provider.dispose(); },
  };
}

describe.each<Provider>(['Telegram', 'Discord'])('%s native inbound file composition', (provider) => {
  it('admits content and descriptors once, then materializes through the activated channel-file runtime', async () => {
    const fixture = await attachmentJourney(provider);
    try {
      await fixture.receive();
      expect(fixture.admissions).toHaveLength(1);
      expect(fixture.admissions[0]?.text).toBe('Please inspect this lead');
      expect(fixture.metadataReads()).toBe(0);
      expect(fixture.downloads).toEqual([]);
      expect(fixture.transferred).toEqual([]);
      const descriptor = ChannelFileValueV1Schema.parse(fixture.admissions[0]!.attachments![0]!.value.value).descriptor;
      expect(descriptor).toMatchObject({ name: 'lead.txt', mediaType: 'text/plain', byteLength: fileBytes.byteLength });
      expect(descriptor.attachmentId).not.toContain('hm=old');
      const result = await fixture.resolve();
      expect(result).toMatchObject({ attachments: [{ instanceId: 'file-0', status: 'ready', context: expect.stringContaining('A lead the agent can read.') }] });
      expect(fixture.transferred).toHaveLength(1);
      expect(fixture.transferred[0]?.bytes).toEqual(Buffer.from(fileBytes));
      await expect(stat(fixture.transferred[0]!.stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await fixture.receive();
      expect(fixture.admissions).toHaveLength(1);
      await fixture.resolve();
      expect(fixture.metadataReads()).toBe(2);
      expect(fixture.downloads[0]).not.toEqual(fixture.downloads[1]);
      expect(fixture.downloads.every(url => !url.includes('hm=old'))).toBe(true);
    } finally { await fixture.dispose(); }
  });

  it('admits a file-only message without manufacturing caption text', async () => {
    const fixture = await attachmentJourney(provider, { text: '' });
    try {
      await fixture.receive();
      expect(fixture.admissions).toHaveLength(1);
      expect(fixture.admissions[0]?.text).toBe('');
      expect(await fixture.resolve()).toMatchObject({ attachments: [{ status: 'ready' }] });
    } finally { await fixture.dispose(); }
  });

  it('reports unavailable bytes explicitly while retaining the admitted file and message', async () => {
    const fixture = await attachmentJourney(provider, { failure: 'network' });
    try {
      await fixture.receive();
      expect(fixture.admissions).toHaveLength(1);
      expect(await fixture.resolve()).toMatchObject({ attachments: [{ instanceId: 'file-0', status: 'unavailable', retryable: true }] });
      expect(fixture.transferred).toEqual([]);
    } finally { await fixture.dispose(); }
  });
});

it('retains a Telegram file beyond the documented cloud download limit as explicitly unavailable', async () => {
  const fixture = await attachmentJourney('Telegram', { failure: 'overLimit' });
  try {
    await fixture.receive();
    expect(fixture.admissions).toHaveLength(1);
    expect(await fixture.resolve()).toMatchObject({ attachments: [{ instanceId: 'file-0', status: 'unavailable', retryable: false }] });
    expect(fixture.downloads).toEqual([]);
    expect(fixture.transferred).toEqual([]);
  } finally { await fixture.dispose(); }
});

it('keeps an expired Discord CDN response unavailable without materializing an empty file', async () => {
  const fixture = await attachmentJourney('Discord', { failure: 'expired' });
  try {
    await fixture.receive();
    expect(fixture.admissions).toHaveLength(1);
    expect(await fixture.resolve()).toMatchObject({ attachments: [{ instanceId: 'file-0', status: 'unavailable', retryable: false }] });
    expect(fixture.transferred).toEqual([]);
  } finally { await fixture.dispose(); }
});

it('requires the production channel-file registration to materialize provider attachments', async () => {
  // The manifest declares composerAttachments/channel-file, so activation
  // refuses a plugin that omits its registration before any file is fetched.
  await expect(attachmentJourney('Telegram', { omitRegistration: true }))
    .rejects.toThrow("activation is missing registration 'composerAttachments/channel-file'");
});
