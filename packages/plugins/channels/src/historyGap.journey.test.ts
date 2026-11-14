import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { PluginWebSocketConnection } from '@happier-dev/plugin-sdk/http';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1, CONVERSATION_MANAGEMENT_ACTION_IDS_V1,
  ConversationPairingCreateResultV1Schema, ConversationPairingReadResultV1Schema,
  ConversationProviderConnectionReconciliationSnapshotV1Schema } from '@happier-dev/channels-protocol/v1';
import { activate as activateDiscord, PLUGIN_MANIFEST as DISCORD_MANIFEST } from '@happier-dev/plugins-channel-discord';
import { createDiscordGatewaySupervisor } from '../../channel-discord/src/discordGatewaySupervisor.js';
import { DISCORD_GATEWAY_BACKGROUND_SERVICE_ID, DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID,
  createDiscordChannelEndpointId } from '../../channel-discord/src/discordPluginConstants.js';
import { DISCORD_MESSAGE_CONTENT_INTENT } from '../../channel-discord/src/discordSetup.js';
import { createChannelsJourneyFixture } from './testkit/channelsJourney.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';

type Received = Awaited<ReturnType<PluginWebSocketConnection['receive']>>;

/** Discord is the external boundary; HELLO, READY and dispatches enter the real worker. */
function gatewaySocket(sessionId: string) {
  const frames: Received[] = [];
  let receiver: ((frame: Received) => void) | undefined;
  let sequence = 1;
  let resolveClosed!: (close: { kind: 'generationRetired'; wasClean: true }) => void;
  const intents: number[] = [];
  function push(frame: Received) {
    if (receiver === undefined) frames.push(frame);
    else { const resolve = receiver; receiver = undefined; resolve(frame); }
  }
  function dispatch(event: string, payload: unknown) {
    push({ kind: 'text', text: JSON.stringify({ op: 0, s: sequence++, t: event, d: payload }) });
  }
  push({ kind: 'text', text: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
  const close = vi.fn(() => {
    const close = { kind: 'generationRetired', wasClean: true } as const;
    push({ kind: 'closed', close });
    resolveClosed(close);
  });
  const socket: PluginWebSocketConnection = {
    url: 'wss://gateway.discord.gg/?v=10&encoding=json', protocol: '',
    closed: new Promise(resolve => { resolveClosed = resolve; }),
    async send(frame) {
      if (frame.kind !== 'text') return;
      const payload = JSON.parse(frame.text) as { op: number; d?: { intents?: number } };
      if (payload.op === 2) {
        intents.push(payload.d?.intents ?? 0);
        dispatch('READY', { session_id: sessionId, resume_gateway_url: 'wss://gateway.discord.gg' });
      }
      if (payload.op === 1) push({ kind: 'text', text: JSON.stringify({ op: 11, d: null }) });
    },
    async receive() { return frames.shift() ?? await new Promise<Received>(resolve => { receiver = resolve; }); },
    close, async dispose() {},
  };
  return { socket, dispatch, intents, close };
}

describe('Channels pairing across Discord history notices', () => {
  it('replaces a READY Gateway for shared proof and finalizes exactly the selected authenticated sender while retaining its gap notice', async () => {
    const providerId = DISCORD_MANIFEST.id;
    const materialization = { pluginId: providerId, machineId: 'pairing-machine', materializationId: 'discord-pairing-journey' };
    const origin = { serverIdentityId: 'srv_plugin_testkit', materializationRef: materialization };
    const credentialRef = { service: { pluginId: providerId, localId: 'discord-bot' }, accountId: 'journey-bot' };
    const selectedEndpoint = { kind: 'shared', audience: 'shared', id: createDiscordChannelEndpointId('101') } as const;
    const first = gatewaySocket('first-session');
    const successor = gatewaySocket('successor-session');
    const opened: typeof first[] = [];
    const http = createPluginHttpFixture({
      async openWebSocket() {
        const next = opened.length === 0 ? first : successor;
        opened.push(next);
        return next.socket;
      },
      async request(request) {
        const path = new URL(request.url).pathname.replace('/api/v10', '');
        const body = path === '/oauth2/applications/@me' ? { id: 'application-1', flags: 1 << 18 }
          : path === '/users/@me' ? { id: 'bot-1', username: 'Journey Bot', bot: true }
          : path === '/gateway/bot' ? { url: 'wss://gateway.discord.gg', session_start_limit: {
            total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 } }
          : /^\/channels\/(?:101|202)$/.test(path) ? { id: path.split('/').at(-1), type: 0, guild_id: 'guild-1',
            name: 'Pairing room', permission_overwrites: [] }
          : path === '/guilds/guild-1/members/bot-1' ? { roles: [] }
          : path === '/guilds/guild-1/roles' ? [{ id: 'guild-1', permissions: '8' }]
          : undefined;
        if (body === undefined) throw new Error(`Unexpected Discord boundary path: ${path}`);
        return { status: 200, finalUrl: request.url, headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(body)) };
      },
    });
    const materialize = vi.fn(async (_purpose: string, _request: unknown, options?: { expectedAccount?: unknown }) => {
      // The chosen Connected Account remains canonical through every real provider call.
      expect(options?.expectedAccount).toEqual(credentialRef);
      return { kind: 'environment', env: { DISCORD_BOT_TOKEN: 'journey-only-bot-token' } };
    });
    // Connected Accounts is the genuine host credential boundary.
    const connectedAccounts = { materialize } as unknown as PluginServices['connectedAccounts'];
    async function executeHostAction(action: string): Promise<JsonValue> {
      if (action === 'session.transcript.get') return { sessionId: 'paired-session', items: [], hasMore: false, scannedThroughSeq: 0 };
      if (action === 'automation.event.sources.list') return {
        kind: 'page', revision: '1', definitions: [], nextCursor: null,
      } satisfies PluginActionResultById['automation.event.sources.list'];
      if (action === 'automation.event.source.status.report') return {};
      throw new Error(`Unexpected host Action: ${action}`);
    }
    const provider = await createPluginTestkit({ manifest: DISCORD_MANIFEST, module: { activate: activateDiscord },
      resolveCurrentPluginMaterializationRef: () => materialization, services: { http, connectedAccounts,
        // The empty Automation catalog is a real host/API boundary; its SDK
        // consumer and Discord's stateless Event bridge remain real.
        actions: { execute: executeHostAction } as unknown as PluginServices['actions'] } });
    const state = new MemoryCollection();
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-pairing-journey',
      authority: { providerPluginId: providerId, providerContributionSelection: { contributionId: 'discord-provider' },
        providerSetupInput: {}, credentialRef, transportOrigin: origin, providerConnectionKey: 'discord:application:application-1',
        providerConfig: { applicationId: 'application-1', botUserId: 'bot-1' }, routingIdentityKey: 'r'.repeat(43),
        integrationPrincipal: { id: 'discord:bot:bot-1' }, authorityEpoch: 1 },
      transport: { kind: 'socket' }, replayContinuity: 'sessionBound', createdAt: Date.now() });
    await state.put(connection, { expectedRevision: 'absent' });
    const supervisor = createDiscordGatewaySupervisor();
    const controller = new AbortController();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), diagnostic: vi.fn() };
    let journey!: Awaited<ReturnType<typeof createChannelsJourneyFixture>>;
    let background!: BackgroundServiceContext;
    const admissions: unknown[] = [];
    const actions = { async getCurrentExecutionRouting() {
      return { serverIdentityId: origin.serverIdentityId, machineId: materialization.machineId, pluginId: 'happier.channels' };
    }, async execute(action: string | { pluginId: string; localId: string }, input: unknown,
      options?: { signal?: AbortSignal }) {
      if (typeof action === 'string') return await executeHostAction(action);
      if (action.pluginId === providerId && action.localId === DISCORD_GATEWAY_WORKER_ATTEMPT_ACTION_ID) {
        await supervisor.runWorkerAttempt(ConversationProviderConnectionReconciliationSnapshotV1Schema.parse(input), {
          ...background, surface: 'plugin', signal: options?.signal ?? controller.signal,
          contribution: { id: action.localId, qualifiedId: `${providerId}/actions/${action.localId}` },
          caller: { kind: 'plugin', pluginId: providerId, occurrenceId: 'discord-journey-generation',
            sourceCustody: { kind: 'development', registeredRootId: 'discord-journey-root' },
            materialization, executionOrigin: origin, contribution: background.contribution, originSurface: 'background' },
        });
        return;
      }
      const result = await journey.executeProviderCoreAction(action, input, { ...background,
        signal: options?.signal ?? controller.signal, surface: 'plugin' });
      if (action.localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.observationIngest) admissions.push(result);
      return result;
    } } as unknown as PluginServices['actions'];
    journey = await createChannelsJourneyFixture({ provider, connection, binding: {}, state,
      sessions: {} as PluginServices['sessions'], actions, resolveCurrentProviderExecutionOrigin: () => origin });
    background = { plugin: { id: providerId, version: '0.0.0' },
      contribution: { id: DISCORD_GATEWAY_BACKGROUND_SERVICE_ID,
        qualifiedId: `${providerId}/backgroundServices/${DISCORD_GATEWAY_BACKGROUND_SERVICE_ID}` },
      surface: 'background', invokedAtMs: Date.now(), signal: controller.signal,
      services: { actions, connectedAccounts, http, logger } as unknown as PluginServices };
    const reconcileRead = async (localId: string) => await journey.executeProviderCoreAction(
      { pluginId: 'happier.channels', localId }, localId === CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList
        ? {} : { connectionId: connection.id }, { ...background, surface: 'plugin' });
    try {
      await supervisor.reconcile(background);
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith('[Discord Gateway] Session ready', expect.anything()));
      expect(first.intents).toHaveLength(1);
      expect(first.intents[0]! & DISCORD_MESSAGE_CONTENT_INTENT).toBe(0);
      const challenge = ConversationPairingCreateResultV1Schema.parse(await journey.invoke(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingCreate, {
          connectionId: connection.id, expectedConnectionRevision: 1, pairingRequestId: 'composed-pairing',
          endpointSelection: { query: '101', selected: selectedEndpoint },
          proofEndpointSelection: { query: '101', selected: selectedEndpoint },
          target: { kind: 'session', sessionId: 'paired-session', policy: { deliveryMode: 'repliesOnly',
            permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
        }));
      expect(challenge.kind).toBe('created');
      if (challenge.kind !== 'created') throw new Error('The real pairing Action did not create a challenge');
      expect(await reconcileRead(CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead))
        .toMatchObject({ [connection.id]: { requiresFullSharedMessageContent: true, credentialRef } });

      await supervisor.reconcile(background);
      await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith('[Discord Gateway] Worker settled',
        expect.objectContaining({ intent: 'reconcile', resultKind: 'stopped' })));
      expect(first.close).toHaveBeenCalled();
      await supervisor.reconcile(background);
      const notice = (await state.get(connection.id))?.value.payload;
      expect(notice).toMatchObject({ historyGap: { reason: 'providerHistoryUnavailable' } });
      // This assertion is the deciding RED: a real reported gap must remain visible
      // without removing an enabled connection from the provider's authority read.
      for (const action of [CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionsList,
        CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.connectionRead]) {
        expect(await reconcileRead(action)).toMatchObject({ [connection.id]: {
          enabled: true, requiresFullSharedMessageContent: true, credentialRef } });
      }
      await supervisor.reconcile(background);
      await vi.waitFor(() => expect(successor.intents).toHaveLength(1), { timeout: 8000 });
      expect(successor.intents[0]! & DISCORD_MESSAGE_CONTENT_INTENT).toBe(DISCORD_MESSAGE_CONTENT_INTENT);
      await vi.waitFor(() => expect(logger.info.mock.calls.filter(([message]) => message === '[Discord Gateway] Session ready')).toHaveLength(2));
      const readPairing = async () => ConversationPairingReadResultV1Schema.parse(await journey.invoke(
        CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingRead, { connectionId: connection.id,
          generationId: challenge.generationId, challengeId: challenge.challengeId }));
      const message = (id: string, channelId: string, bot = false) => ({ id, channel_id: channelId, guild_id: 'guild-1',
        type: 0, content: `/pair ${challenge.manualToken}`, timestamp: new Date().toISOString(),
        author: { id: 'human-1', username: 'Human', bot }, mentions: [], mention_roles: [], attachments: [], embeds: [] });
      successor.dispatch('MESSAGE_CREATE', message('wrong-room-proof', '202'));
      await vi.waitFor(() => expect(admissions).toHaveLength(1));
      expect(await readPairing()).toMatchObject({ kind: 'ready', pairing: { proposals: [] } });
      successor.dispatch('MESSAGE_CREATE', message('bot-proof', '101', true));
      await vi.waitFor(() => expect(admissions).toHaveLength(2));
      expect(await readPairing()).toMatchObject({ kind: 'ready', pairing: { proposals: [] } });
      successor.dispatch('MESSAGE_CREATE', message('selected-room-proof', '101'));
      await vi.waitFor(() => expect(admissions).toHaveLength(3));
      const proved = await readPairing();
      expect(proved).toMatchObject({ kind: 'ready', pairing: { proposals: [{ principalId: 'discord:user:human-1',
        proofEndpoint: selectedEndpoint }] } });
      if (proved.kind !== 'ready') throw new Error('The admitted proof did not create a proposal');
      expect(proved.pairing.proposals).toHaveLength(1);
      expect([...state.rows.values()].filter(row => row.value['record-kind'] === 'ingress-census')).toHaveLength(0);
      const finalizeInput = { connectionId: connection.id,
        generationId: challenge.generationId, proposalId: proved.pairing.proposals[0]!.proposalId,
        finalizeIdempotencyKey: 'composed-finalize' };
      expect(await journey.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize, finalizeInput))
        .toMatchObject({ kind: 'created', binding: { endpoint: selectedEndpoint, enabled: false,
          allowedPrincipalIds: ['discord:user:human-1'], target: { kind: 'session', sessionId: 'paired-session' } } });
      expect(await journey.invoke(CONVERSATION_MANAGEMENT_ACTION_IDS_V1.connectionPairingFinalize, finalizeInput))
        .toMatchObject({ kind: 'rejoined' });
      expect([...state.rows.values()].filter(row => row.value['record-kind'] === 'binding')).toHaveLength(1);
      expect((await state.get(connection.id))?.value.payload).toMatchObject({ historyGap: (notice as { historyGap: unknown }).historyGap });
      expect(opened).toHaveLength(2);
      expect(materialize).toHaveBeenCalled();
    } finally {
      controller.abort();
      await supervisor.dispose();
      await journey.dispose();
      await provider.dispose();
    }
  });
});
