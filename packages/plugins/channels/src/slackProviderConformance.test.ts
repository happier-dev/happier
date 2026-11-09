import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginWebSocketConnection, PluginWebSocketMessage } from '@happier-dev/plugin-sdk/http';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ConversationOutboundTextLimitV1Schema } from '@happier-dev/channels-protocol/v1';

import { activate, PLUGIN_MANIFEST } from '../../channel-slack/src/index.js';
import { createSlackApi } from '../../channel-slack/src/slackApi.js';
import { SLACK_MAX_MESSAGE_CODE_POINTS } from '../../channel-slack/src/slackDelivery.js';
import { SLACK_CHANNEL_PROVIDER_CONTRIBUTION_ID } from '../../channel-slack/src/slackPluginConstants.js';
import { startSlackSocketWorker, type SlackSocketWorker } from '../../channel-slack/src/slackSocketWorker.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { defineProviderConformanceJourneys, type ProviderConformanceAdapter,
  type ProviderConformanceNativeSend } from './testkit/providerConformance.js';

const connectionId = 'conformance-connection';
const observedAtSeconds = Math.floor(Date.now() / 1000);
const rootTs = `${observedAtSeconds}.000001`;
const messageTs = (id: number) => `${observedAtSeconds}.${String(id).padStart(6, '0')}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Native fixture IDs retain their provider timestamps across redelivery.
  // Keep the clock boundary at that arrival time so suite duration cannot age them out.
  vi.setSystemTime(observedAtSeconds * 1_000);
});
afterEach(() => { vi.useRealTimers(); });
const parent = { kind: 'shared', audience: 'shared', id: 'slack:T1:channel:C1' } as const;
const endpoint = { kind: 'thread', audience: 'shared', id: `${parent.id}:thread:${rootTs}`, parentId: parent.id } as const;
const identity = { teamId: 'T1', appId: 'A1', botUserId: 'UBOT', botId: 'B1', label: 'Happier' };

function response(value: unknown, url: string) {
  return { status: 200, finalUrl: url, headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function record(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a native Slack object');
  return value as Record<string, JsonValue>;
}

/** Only the host WebSocket boundary is replaced; the real Socket Mode worker consumes every frame. */
function socketBoundary(frames: readonly unknown[]) {
  const queue = frames.map(frame => ({ kind: 'text' as const, text: JSON.stringify(frame) }));
  let close!: () => void;
  const closed = new Promise<Readonly<{ kind: 'local'; wasClean: true }>>(resolve => {
    close = () => resolve({ kind: 'local', wasClean: true });
  });
  let acknowledge!: (message: PluginWebSocketMessage) => void;
  const acknowledged = new Promise<PluginWebSocketMessage>(resolve => { acknowledge = resolve; });
  const socket: PluginWebSocketConnection = {
    url: 'wss://wss.slack.com/link?ticket=fixture', protocol: '', closed,
    async send(message) { acknowledge(message); },
    async receive(options) {
      if (options?.signal?.aborted) throw options.signal.reason;
      const frame = queue.shift();
      if (frame) return frame;
      return await new Promise((resolve, reject) => {
        const aborted = () => { options?.signal?.removeEventListener('abort', aborted); reject(options?.signal?.reason); };
        options?.signal?.addEventListener('abort', aborted, { once: true });
        void closed.then(value => { options?.signal?.removeEventListener('abort', aborted); resolve({ kind: 'closed', close: value }); });
      });
    },
    close, dispose: close,
  };
  return { socket, acknowledged };
}

async function slackAdapter(): Promise<ProviderConformanceAdapter> {
  const pluginId = PLUGIN_MANIFEST.id;
  const placement = { serverIdentityId: 'srv_plugin_testkit', materializationRef: {
    pluginId, machineId: 'conformance-machine', materializationId: 'slack-conformance' } };
  const credentialRef = { service: { pluginId, localId: 'slack-bot' }, accountId: 'fixture' };
  const credentials = { botToken: 'xoxb-fixture', appToken: 'xapp-fixture' };
  const sent: ProviderConformanceNativeSend[] = [];
  let afterSend: (() => Promise<void>) | undefined;
  let worker: SlackSocketWorker | undefined;
  let topic: string | undefined;
  const sockets = new Set<PluginWebSocketConnection>();
  const hello = { type: 'hello', connection_info: { app_id: identity.appId } };
  const http: PluginServices['http'] = createPluginHttpFixture({
    async openWebSocket() {
      const boundary = socketBoundary([hello]);
      sockets.add(boundary.socket);
      return boundary.socket;
    },
    async request(request) {
      const method = new URL(request.url).pathname.split('/').at(-1);
      if (method === 'auth.test') return response({ ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'B1' }, request.url);
      if (method === 'bots.info') return response({ ok: true, bot: { id: 'B1', app_id: 'A1', user_id: 'UBOT', name: 'Happier' } }, request.url);
      if (method === 'apps.connections.open') return response({ ok: true, url: 'wss://wss.slack.com/link?ticket=fixture' }, request.url);
      if (method === 'conversations.info') {
        const channelId = new URL(request.url).searchParams.get('channel');
        return response({ ok: true, channel: { id: channelId, name: 'conformance', is_im: channelId === 'D1',
          is_mpim: false, is_private: channelId === 'D1', is_archived: false, is_member: true } }, request.url);
      }
      if (method === 'chat.postMessage') {
        const payload = record(JSON.parse(new TextDecoder().decode(request.body)));
        sent.push({ text: String(payload.text), address: { channel: payload.channel!,
          ...(payload.thread_ts === undefined ? {} : { thread_ts: payload.thread_ts }) },
          // Slack's reply relation is the native thread root, including replies to a thread member.
          ...(payload.thread_ts === undefined ? {} : { replyTo: String(payload.thread_ts) }),
          mentionsSuppressed: payload.mrkdwn === false && payload.parse === 'none' && payload.link_names === false
            && !/<(?:@|!|#)/u.test(String(payload.text)) });
        if (sent.length === 1) await afterSend?.();
        return response({ ok: true, channel: payload.channel, ts: `${observedAtSeconds + 1}.${String(sent.length).padStart(6, '0')}` }, request.url);
      }
      throw new Error(`Unexpected native Slack request ${method}`);
    },
  });
  const connectedAccounts = { async materialize() {
    return { kind: 'environment', env: { SLACK_BOT_TOKEN: credentials.botToken, SLACK_APP_TOKEN: credentials.appToken } };
  } } as unknown as PluginServices['connectedAccounts'];
  const provider = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: { http, connectedAccounts },
    resolveCurrentPluginMaterializationRef: () => placement.materializationRef });
  try {
    const connection = createCurrentConversationConnectionFixture({ connectionId, transport: { kind: 'socket' },
      overlapSafety: 'safe', replayContinuity: 'sessionBound',
      outboundTextLimit: ConversationOutboundTextLimitV1Schema.parse({ maximum: SLACK_MAX_MESSAGE_CODE_POINTS,
        unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' }),
      authority: { providerPluginId: pluginId, providerContributionSelection: { contributionId: SLACK_CHANNEL_PROVIDER_CONTRIBUTION_ID },
        providerSetupInput: { credentialRef }, credentialRef, transportOrigin: placement, providerConnectionKey: 'slack:team:T1:app:A1',
        providerConfig: identity, integrationPrincipal: { id: 'slack:T1:user:UBOT' }, routingIdentityKey: 's'.repeat(43), authorityEpoch: 1 } });
    const api = createSlackApi({ credentials, http });
    return { provider, connection, origin: () => placement, endpoint, parent,
      allowedPrincipals: ['slack:T1:user:UHUMAN', 'slack:T1:user:UOTHERBOT', 'slack:T1:user:UBOT'],
      nativeLimit: SLACK_MAX_MESSAGE_CODE_POINTS, expectedAddress: { channel: 'C1', thread_ts: rootTs }, sent,
      messageId: messageTs, replyMessageId: id => topic === 'channel' || topic === 'direct' ? messageTs(id) : rootTs,
      replyOnLaterChunks: true, forwardedInput: 'unsupportedContent',
      expectedText: text => text.replace(/<(?=[@!#])/gu, '‹'), afterSend(effect) { afterSend = effect; }, baseline: async () => {},
      async receive(journey, message) {
        topic = message.topic;
        const channelId = message.topic === 'direct' ? 'D1' : 'C1';
        const boundary = socketBoundary([hello, { type: 'events_api', envelope_id: `envelope-${message.id}`, payload: {
          type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: `Ev${message.id}`, event_time: observedAtSeconds,
          event: { type: 'message', channel: channelId, user: message.actor === 'self' ? 'UBOT'
            : message.actor === 'bot' ? 'UOTHERBOT' : message.actor === 'stranger' ? 'USTRANGER' : 'UHUMAN',
          ...(message.actor === 'bot' ? { bot_id: 'BOTHER', subtype: 'bot_message' } : {}),
          ...(message.actor === 'self' ? { bot_id: 'B1', subtype: 'bot_message' } : {}),
          text: message.text, ts: messageTs(message.id),
          ...(message.topic === 'channel' || message.topic === 'direct' ? {} : { thread_ts: rootTs }),
          // Slack documents attachments, but no stable authenticated forwarding discriminator.
          ...(message.forwarded ? { attachments: [{ fallback: message.text, text: message.text }] } : {}),
        } } }]);
        sockets.add(boundary.socket);
        let ingressFailure: unknown;
        worker = startSlackSocketWorker({ connection: { connectionId, authorityEpoch: 1, identity }, api,
          webSockets: { openWebSocket: async () => boundary.socket }, signal: new AbortController().signal,
          admitObservation: async input => {
            try { await journey.ingest(input); } catch (error) { ingressFailure = error; throw error; }
          } });
        try {
          // Durable composed ingress shares the containing test's deadline;
          // Socket Mode does not impose a shorter local admission deadline.
          const acknowledgement = await Promise.race([boundary.acknowledged, worker.result.then(result => {
            if (ingressFailure) throw ingressFailure;
            throw new Error(`Slack worker stopped before ACK: ${JSON.stringify(result)}`);
          })]);
          expect(acknowledgement).toEqual({ kind: 'text', text: JSON.stringify({ envelope_id: `envelope-${message.id}` }) });
        } finally { worker.stop(); await worker.result; worker = undefined; }
      },
      async gap(journey) {
        const boundary = socketBoundary([hello]);
        sockets.add(boundary.socket);
        worker = startSlackSocketWorker({ connection: { connectionId, authorityEpoch: 1, identity }, api,
          webSockets: { openWebSocket: async () => boundary.socket }, signal: new AbortController().signal,
          admitObservation: async input => { await journey.ingest(input); } });
        // Lose the transport after its buffered HELLO, without a graceful
        // refresh request or explicit worker stop.
        boundary.socket.close();
        const result = await worker.result;
        worker = undefined;
        expect(result).toEqual({ kind: 'historyGap', reason: 'providerHistoryUnavailable' });
        await journey.invoke('journey/transport-fact', { connectionId, authorityEpoch: 1,
          fact: { kind: 'historyGap', reason: 'providerHistoryUnavailable' } });
      },
      async recover(journey) {
        const current = await journey.state.get(connectionId);
        const revision = record(current?.value.payload).configurationRevision;
        expect(await journey.invoke('stream/notice-dismiss-v1', { connectionId, expectedRevision: revision! })).toMatchObject({ kind: 'noticeDismissed' });
      },
      async dispose() {
        worker?.stop(); await worker?.result;
        for (const socket of sockets) socket.dispose();
        await provider.dispose();
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.dispose();
    await provider.dispose(); throw error;
  }
}

defineProviderConformanceJourneys({ name: 'Slack', create: slackAdapter, topics: [
  { name: 'parent channel', topic: 'channel', endpoint: parent, address: { channel: 'C1', thread_ts: messageTs(10) } },
  { name: 'direct conversation', topic: 'direct', endpoint: { kind: 'direct', audience: 'direct', id: 'slack:T1:channel:D1' },
    address: { channel: 'D1', thread_ts: messageTs(10) } },
] });
