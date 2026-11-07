import {
  ConversationDeliveryContentV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryResultV1Schema,
  ConversationConnectionTestInputV1Schema,
  ConversationProviderSetupResultV1Schema,
  ConversationProvidersContributionPointV1,
  ConversationProvidersContributionProtocolV1,
  countConversationTextUnits,
  type ConversationDeliveryInputV1,
  type ConversationDeliveryResultV1,
} from '@happier-dev/channels-protocol/v1';
import { definePlugin, type JsonValue, type PluginServices } from '@happier-dev/plugin-sdk';
import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { defineProtocolJsonValue, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { createPluginHttpFixture, createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import { describe, expect, it } from 'vitest';

import {
  deliverTelegramMessage, setupTelegramChannels, testTelegramConnection,
  TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA,
} from '../../channel-telegram/src/channelActions.js';
import {
  deliverDiscordMessage, setupDiscordChannels, testDiscordConnection,
  DISCORD_SETUP_INPUT_PROTOCOL_SCHEMA,
} from '../../channel-discord/src/discordActions.js';
import { deliverGithubChannelMessage, setupGithubChannels, testGithubChannelConnection } from '../../scm-github/src/githubChannelActions.js';
import { GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../scm-github/src/observations/githubProviderContracts.js';
import { retestConversationConnectionForInvocation } from './management.js';
import { CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_COLLECTION } from './collections.js';
import { CHANNELS_PROVIDER_POINT_REF } from './manifest.js';
import { createConversationOutwardDeliveryCollectionStore } from './outwardDelivery.js';
import { deliverConversationOutwardDeliveryThroughProviderAction } from './outwardDeliveryProviderActions.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { channelsOperationOnlyTargetedContributionsFixture } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';
import { isChannelStateJsonRecord } from './accountLocalBindingPolicy.js';

const operations = ConversationProvidersContributionProtocolV1.operations;
const fixtureJsonSchema = defineProtocolObject({}, {
  policy: 'additive-open/preserve', additionalProperties: defineProtocolJsonValue(),
});

/** The real Account DB boundary, with every production write schema-checked. */
function collectionBoundary(schema: Parameters<typeof compilePluginJsonSchema>[0]) {
  const compiled = compilePluginJsonSchema(schema);
  const collection = new MemoryCollection<Record<string, JsonValue>>();
  const writes: Record<string, JsonValue>[] = [];
  const put = collection.put.bind(collection);
  const batch = collection.batch.bind(collection);
  function validated(value: unknown) {
    expect(isValidPluginJsonSchemaValue(compiled, value)).toBe(true);
    const parsed = fixtureJsonSchema.parse(value);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected an Account row');
    return parsed;
  }
  return Object.assign(collection, {
    writes,
    async put(value: Record<string, unknown>, options: { expectedRevision: number | 'absent' }) {
      const parsed = validated(value);
      const row = await put(parsed, options);
      writes.push(parsed);
      return row;
    },
    async batch(operations: readonly Readonly<Record<string, unknown>>[]) {
      const values = operations.filter(operation => operation.kind === 'put').map(operation => validated(operation.value));
      const result = await batch(operations);
      if (result.status === 'updated') writes.push(...values);
      return result;
    },
  });
}

function response(value: unknown, finalUrl: string) {
  return { status: 200, finalUrl, headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(value)) };
}

describe('Channels chunk producer to registered native-handler fixture seam', () => {
  it.each([
    { wrongSetupHandler: false, nativeLogin: false },
    { wrongSetupHandler: true, nativeLogin: false },
    { wrongSetupHandler: false, nativeLogin: true },
  ])('retests an old GitHub row and splits a 70k reply through the refreshed native setup limit (wrong setup handler: $wrongSetupHandler, native login: $nativeLogin)', async ({ wrongSetupHandler, nativeLogin }) => {
    const pluginId = GITHUB_CONNECTED_ACCOUNT_SERVICE.pluginId;
    const credentialRef = nativeLogin ? null : { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'native-github-account' };
    const materialization = { pluginId, machineId: 'seam-machine', materializationId: 'github-native-seam' };
    const setupInput: JsonValue = nativeLogin ? { repository: 'acme/widgets' } : { credentialRef, repository: 'acme/widgets' };
    const comments: string[] = [];
    const consumed: ConversationDeliveryInputV1[] = [];
    let miswired = false;
    const http: PluginServices['http'] = createPluginHttpFixture({
      async openWebSocket() { throw new Error('GitHub Channels uses HTTP'); },
      async request(request) {
        const url = new URL(request.url);
        if (url.pathname === '/user') return response({ id: 99, login: 'happier-bot' }, request.url);
        if (url.pathname === '/repos/acme/widgets') return response({ id: 77, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } }, request.url);
        if (url.pathname === '/repos/acme/widgets/issues/comments') return response([], request.url);
        if (url.pathname === '/repos/acme/widgets/issues/1') return response({ id: 5, number: 1, title: 'Question', state: 'open' }, request.url);
        if (url.pathname === '/repos/acme/widgets/issues/1/comments' && request.method === 'POST') {
          const body = fixtureJsonSchema.parse(JSON.parse(new TextDecoder().decode(request.body)));
          if (body === null || Array.isArray(body) || typeof body !== 'object' || typeof body.body !== 'string') throw new Error('Invalid GitHub POST');
          comments.push(body.body);
          return { ...response({ id: 100 + comments.length }, request.url), status: 201 };
        }
        throw new Error(`Unexpected GitHub native request ${request.method} ${request.url}`);
      },
    });
    const provider = definePlugin({ id: pluginId, version: '0.0.0', actions: {
      setup: { title: 'Native setup', surfaces: ['plugin'], dangerLevel: 'safe',
        resultSchema: operations.setup.declaration.resultSchema.jsonSchema,
        run: (input, context) => miswired ? testGithubChannelConnection(input, context) : setupGithubChannels(input, context) },
      test: { title: 'Native test', surfaces: ['plugin'], dangerLevel: 'safe',
        inputSchema: operations.connectionTest.declaration.input.schema.jsonSchema,
        resultSchema: operations.connectionTest.declaration.resultSchema.jsonSchema, run: testGithubChannelConnection },
      deliver: { title: 'Native delivery', surfaces: ['plugin'], dangerLevel: 'writesRemote',
        inputSchema: ConversationDeliveryInputV1Schema.jsonSchema, resultSchema: ConversationDeliveryResultV1Schema.jsonSchema,
        run(input, context) { const parsed = ConversationDeliveryInputV1Schema.parse(input); consumed.push(parsed); return deliverGithubChannelMessage(parsed, context); } },
    }, contributesTo: { 'happier.channels': { providers: { native: ConversationProvidersContributionProtocolV1.contribute({ descriptor: { v: 1, displayName: 'Native test' }, operations: {
      setup: operations.setup.bind('setup'), connectionTest: operations.connectionTest.bind('test'), messageDeliver: operations.messageDeliver.bind('deliver'),
    } }) } } } });
    const connectedAccounts = { async getBinding() { return null; },
      async materialize() { return { kind: 'httpHeaders', headers: { Authorization: 'Bearer native-fixture' } }; } } as unknown as PluginServices['connectedAccounts'];
    const providerKit = await createPluginTestkit({ manifest: provider.manifest, module: provider,
      services: { http: { ...http, ...createPluginHttpFixture({ request: http.request }) }, connectedAccounts },
      resolveCurrentPluginMaterializationRef: () => materialization });
    const state = collectionBoundary(CHANNEL_STATE_COLLECTION.schema);
    const deliveries = collectionBoundary(CHANNEL_DELIVERIES_COLLECTION.schema);
    let coreKit: PluginTestkit;
    let setupOrigin: PluginMachineExecutionOriginV1 | undefined;
    const core = definePlugin({ id: 'happier.channels', version: '0.0.0', contributionPoints: { providers: ConversationProvidersContributionPointV1 }, actions: {
      setup: { title: 'Setup via declared role', surfaces: ['cli'], dangerLevel: 'safe',
        async run(_input, context) {
          const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(coreKit.issueAdmittedTargetedOperation({
            point: CHANNELS_PROVIDER_POINT_REF, contributor: { testkit: providerKit, contributionId: 'native' }, role: 'setup',
          }), setupInput);
          setupOrigin = execution.executionOrigin;
          return execution.result;
        } },
      retest: { title: 'Retest saved row', surfaces: ['cli'], dangerLevel: 'safe',
        async run(_input, context) {
          return fixtureJsonSchema.parse(await retestConversationConnectionForInvocation({ connectionId: 'github-legacy', expectedRevision: 1, authorityEpoch: 1 }, {
            ...context, services: { ...context.services,
              targetedContributions: channelsOperationOnlyTargetedContributionsFixture(coreKit),
              storage: { ...context.services.storage, account: { collection: () => state } as unknown as PluginServices['storage']['account'] },
            },
          }));
        } },
      deliver: { title: 'Deliver via custody', surfaces: ['cli'], dangerLevel: 'writesRemote',
        confirmation: { title: 'Deliver this fixture message?' },
        async run(input, context) {
          const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state,
            deliveriesCollection: deliveries as unknown as Parameters<typeof createConversationOutwardDeliveryCollectionStore>[0]['deliveriesCollection'],
            now: () => 1700000000000, signal: context.signal });
          return fixtureJsonSchema.parse(await deliverConversationOutwardDeliveryThroughProviderAction({
            stateCollection: state, targetedContributions: channelsOperationOnlyTargetedContributionsFixture(coreKit), actions: context.services.actions,
            store, attemptId: 'github-native-seam-attempt', now: () => 1700000000000, signal: context.signal,
            obligation: { connectionId: 'github-legacy', routeAuthority: { connectionAuthorityEpoch: 1 },
              source: { kind: 'controlResponse', controlId: 'github-native-seam', controlKind: 'recovery' },
              endpoint: { kind: 'githubIssue', audience: 'shared', id: 'github:repository:77:issue:5:number:1', parentId: '77' },
              content: ConversationDeliveryContentV1Schema.parse(input), deliveryKey: 'github-native-seam-delivery',
              replyContext: { replyToMessageId: 'original-comment' },  linkPreviewPolicy: 'suppress' },
          }));
        } },
    } });
    coreKit = await createPluginTestkit({ manifest: core.manifest, module: core, targetedContributionContributors: [providerKit],
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: 'happier.channels', machineId: 'seam-machine', materializationId: 'core-native-seam' }) });
    try {
      const setup = ConversationProviderSetupResultV1Schema.parse(await coreKit.invokeAction('setup', null));
      expect(setup.credentialRef).toEqual(credentialRef);
      if (setupOrigin === undefined || !('materializationRef' in setupOrigin)) throw new Error('Native setup must produce materialized transport authority');
      const initial = createCurrentConversationConnectionFixture({ connectionId: 'github-legacy',
        authority: { providerPluginId: pluginId, providerContributionSelection: { contributionId: 'native' }, providerSetupInput: setupInput,
          credentialRef, transportOrigin: setupOrigin,
          providerConnectionKey: setup.providerConnectionKey, providerConfig: setup.providerConfig, integrationPrincipal: setup.integrationPrincipal,
          routingIdentityKey: 'a'.repeat(43), authorityEpoch: 1 } });
      const { outboundTextLimit: _oldLimit, ...oldPayload } = initial.payload;
      await state.put({ ...initial, payload: oldPayload }, { expectedRevision: 'absent' });
      miswired = wrongSetupHandler;
      if (wrongSetupHandler) {
        await expect(coreKit.invokeAction('retest', null)).rejects.toBeInstanceOf(Error);
        expect((await state.get('github-legacy'))?.revision).toBe(1);
        expect(comments).toEqual([]);
        expect(deliveries.writes).toEqual([]);
        return;
      }
      await expect(coreKit.invokeAction('retest', null)).resolves.toMatchObject({ kind: 'ready' });
      const refreshed = (await state.get('github-legacy'))?.value.payload;
      expect(refreshed).toMatchObject({ outboundTextLimit: setup.outboundTextLimit,
        });
      const text = 'x'.repeat(70_000);
      await expect(coreKit.invokeAction('deliver', { text })).resolves.toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
      expect(comments).toHaveLength(2);
      expect(comments.join('')).toBe(text);
      expect(consumed.every(request => request.content.text.length <= 65_536)).toBe(true);
      expect(new Set(consumed.map(request => request.deliveryKey)).size).toBe(2);
      expect(deliveries.writes.at(-1)?.payload).toMatchObject({ state: 'delivered', providerMessageIds: ['101', '102'] });
    } finally { await coreKit.dispose(); await providerKit.dispose(); }
  });
  // These narrow authored fixtures do not claim first-party cold manifest
  // admission, covered separately by firstPartyProviderComposition.test.ts.
  // Native setup/delivery/adapters and the SDK executor stay real.
  it.each([
    { kind: 'telegram', handlerRole: 'deliver', rateLimited: false },
    { kind: 'discord', handlerRole: 'deliver', rateLimited: false },
    { kind: 'telegram', handlerRole: 'inspect', rateLimited: false },
    { kind: 'discord', handlerRole: 'inspect', rateLimited: false },
    { kind: 'telegram', handlerRole: 'deliver', rateLimited: true },
  ] as const)('routes structured 70k content to registered $kind $handlerRole (rate limited: $rateLimited) and retains only real native receipts', async ({ kind, handlerRole, rateLimited }) => {
    const telegram = kind === 'telegram';
    const pluginId = `happier.channel.${kind}`;
    const credentialRef = {
      service: { pluginId, localId: `${kind}-bot` },
      accountId: telegram ? 'bot:123' : 'bot:discord-bot-1',
    };
    const providerMaterialization = { pluginId, machineId: 'seam-machine', materializationId: `${kind}-seam` };
    const nativeMessages: Record<string, JsonValue>[] = [];
    const consumed: ConversationDeliveryInputV1[] = [];
    const nativeResults: ConversationDeliveryResultV1[] = [];
    const consumerRefusals: unknown[] = [];
    const http: PluginServices['http'] = createPluginHttpFixture({
      async openWebSocket() { throw new Error('Delivery does not open a Gateway'); },
      async request(request) {
        const url = request.url;
        if (telegram) {
          if (url.endsWith('/getMe')) return response({ ok: true, result: {
            id: 123, is_bot: true, first_name: 'Happier', username: 'HappierBot', can_read_all_group_messages: false,
          } }, url);
          if (url.endsWith('/getWebhookInfo')) return response({ ok: true, result: { url: '', pending_update_count: 0 } }, url);
          if (url.endsWith('/getChat')) return response({ ok: true, result: { id: -100456, type: 'supergroup', title: 'Deploys', is_forum: true } }, url);
          if (url.endsWith('/sendMessage')) {
            const payload = fixtureJsonSchema.parse(JSON.parse(new TextDecoder().decode(request.body)));
            if (payload === null || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Expected Telegram native message');
            nativeMessages.push(payload);
            if (rateLimited) return response({ ok: false, error_code: 429,
              description: 'Too Many Requests', parameters: { retry_after: 90_000 } }, url);
            return response({ ok: true, result: { message_id: nativeMessages.length + 70 } }, url);
          }
        } else {
          if (url.endsWith('/oauth2/applications/@me')) return response({ id: 'application-1', name: 'Happier' }, url);
          if (url.endsWith('/users/@me')) return response({ id: 'discord-bot-1', username: 'Happier', bot: true }, url);
          if (url.endsWith('/gateway/bot')) return response({ url: 'wss://gateway.discord.gg', session_start_limit: {
            total: 1000, remaining: 999, reset_after: 86400000, max_concurrency: 1,
          } }, url);
          if (url.endsWith('/channels/thread-1')) return response({ id: 'thread-1', type: 11, parent_id: 'parent-1',
            name: 'Deploys', thread_metadata: { archived: false, locked: false } }, url);
          if (url.endsWith('/channels/thread-1/messages')) {
            const payload = fixtureJsonSchema.parse(JSON.parse(new TextDecoder().decode(request.body)));
            if (payload === null || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Expected Discord native message');
            nativeMessages.push(payload);
            return response({ id: `message-${nativeMessages.length}`, channel_id: 'thread-1' }, url);
          }
        }
        throw new Error(`Unexpected native request ${request.method} ${url}`);
      },
    });
    // Credential materialization is the other genuine external host boundary.
    const materialize: PluginServices['connectedAccounts']['materialize'] = async (_purpose, _request, options): ReturnType<PluginServices['connectedAccounts']['materialize']> => {
      expect(options?.expectedAccount).toEqual(credentialRef);
      if (telegram) return { kind: 'environment', env: { TELEGRAM_BOT_TOKEN: '123:bot-token' } };
      return { kind: 'environment', env: { DISCORD_BOT_TOKEN: 'discord-token' } };
    };
    const connectedAccounts = { materialize } as unknown as PluginServices['connectedAccounts'];
    const setup = telegram ? setupTelegramChannels : setupDiscordChannels;
    const inspect = telegram ? testTelegramConnection : testDiscordConnection;
    const deliver = telegram ? deliverTelegramMessage : deliverDiscordMessage;
    const provider = definePlugin({
      id: pluginId, version: '0.0.0',
      actions: {
        prepare: { title: 'Native setup fixture', surfaces: operations.setup.declaration.surfaces,
          dangerLevel: operations.setup.declaration.dangerLevel,
          inputSchema: telegram ? TELEGRAM_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema : DISCORD_SETUP_INPUT_PROTOCOL_SCHEMA.jsonSchema,
          resultSchema: operations.setup.declaration.resultSchema.jsonSchema, run: setup },
        inspect: { title: 'Native inspection fixture', surfaces: operations.connectionTest.declaration.surfaces,
          dangerLevel: operations.connectionTest.declaration.dangerLevel,
          inputSchema: operations.connectionTest.declaration.input.schema.jsonSchema,
          resultSchema: operations.connectionTest.declaration.resultSchema.jsonSchema, run: inspect },
        deliver: { title: 'Native delivery fixture', surfaces: operations.messageDeliver.declaration.surfaces,
          dangerLevel: operations.messageDeliver.declaration.dangerLevel,
          inputSchema: ConversationDeliveryInputV1Schema.jsonSchema,
          resultSchema: ConversationDeliveryResultV1Schema.jsonSchema,
          async run(input, context) {
            const request = ConversationDeliveryInputV1Schema.parse(input);
            consumed.push(request);
            try {
              // Permanent negative control: registration binds the wrong real
              // native handler, whose exact strict consumer refuses delivery.
              const result = handlerRole === 'inspect'
                ? await inspect(request, context) : await deliver(request, context);
              const parsed = ConversationDeliveryResultV1Schema.parse(result);
              nativeResults.push(parsed);
              return parsed;
            } catch (error) {
              consumerRefusals.push(error);
              throw error;
            }
          } },
      },
      contributesTo: { 'happier.channels': { providers: {
        native: ConversationProvidersContributionProtocolV1.contribute({ descriptor: { v: 1, displayName: 'Native test' }, operations: {
          setup: operations.setup.bind('prepare'), connectionTest: operations.connectionTest.bind('inspect'),
          messageDeliver: operations.messageDeliver.bind('deliver'),
        } }),
      } } },
    });
    const providerKit = await createPluginTestkit({ manifest: provider.manifest, module: provider,
      services: { http, connectedAccounts }, resolveCurrentPluginMaterializationRef: () => providerMaterialization });
    const state = collectionBoundary(CHANNEL_STATE_COLLECTION.schema);
    const deliveries = collectionBoundary(CHANNEL_DELIVERIES_COLLECTION.schema);
    let coreKit: PluginTestkit;
    let setupOrigin: PluginMachineExecutionOriginV1 | undefined;
    const core = definePlugin({
      id: 'happier.channels', version: '0.0.0',
      contributionPoints: { providers: ConversationProvidersContributionPointV1 },
      actions: {
        prepare: { title: 'Compose native setup', surfaces: ['cli'], dangerLevel: 'safe',
          async run(_input, context) {
            const operation = coreKit.issueAdmittedTargetedOperation({ point: CHANNELS_PROVIDER_POINT_REF,
              contributor: { testkit: providerKit, contributionId: 'native' }, role: 'setup' });
            const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(operation, { credentialRef });
            setupOrigin = execution.executionOrigin;
            return execution.result;
          } },
        deliver: { title: 'Compose outward core delivery', surfaces: ['cli'], dangerLevel: 'writesRemote',
          confirmation: { title: 'Deliver this fixture message?' },
          inputSchema: ConversationDeliveryContentV1Schema.jsonSchema,
          async run(input, context) {
            // Only the DB boundary is synthetic; the custody writer, retained
            // reader, currentness, chunker and registered executor stay real.
            const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state,
              deliveriesCollection: deliveries as unknown as Parameters<typeof createConversationOutwardDeliveryCollectionStore>[0]['deliveriesCollection'],
              now: () => 1700000000000, signal: context.signal });
            return fixtureJsonSchema.parse(await deliverConversationOutwardDeliveryThroughProviderAction({
              stateCollection: state, targetedContributions: channelsOperationOnlyTargetedContributionsFixture(coreKit),
              actions: context.services.actions, store, attemptId: 'native-seam-attempt', now: () => 1700000000000,
              signal: context.signal,
              obligation: { connectionId: 'native-seam-connection', routeAuthority: { connectionAuthorityEpoch: 1 },
                source: { kind: 'controlResponse', controlId: 'native-seam', controlKind: 'recovery' },
                endpoint: telegram ? { kind: 'thread', audience: 'shared', id: '-100456:17', parentId: '-100456' }
                  : { kind: 'thread', audience: 'shared', id: 'discord:channel:thread-1', parentId: 'discord:channel:parent-1' },
                content: ConversationDeliveryContentV1Schema.parse(input), deliveryKey: 'native-seam-delivery',
                replyContext: { replyToMessageId: telegram ? '7' : 'original-message', threadId: telegram ? '17' : 'thread-1' },
                 linkPreviewPolicy: 'suppress' },
            }));
          } },
      },
    });
    coreKit = await createPluginTestkit({ manifest: core.manifest, module: core,
      targetedContributionContributors: [providerKit],
      resolveCurrentPluginMaterializationRef: () => ({ pluginId: 'happier.channels', machineId: 'seam-machine', materializationId: 'core-seam' }) });
    try {
      const prepared = ConversationProviderSetupResultV1Schema.parse(await coreKit.invokeAction('prepare', null));
      if (setupOrigin === undefined || !('materializationRef' in setupOrigin)) throw new Error('Native setup must produce materialized transport authority');
      const limit = prepared.outboundTextLimit;
      if (limit?.unit !== 'unicodeCodePoints') throw new Error('Native setup must supply its real code-point ceiling');
      await state.put(createCurrentConversationConnectionFixture({ connectionId: 'native-seam-connection',
        authority: { providerPluginId: pluginId, providerContributionSelection: { contributionId: 'native' },
          providerSetupInput: { credentialRef }, credentialRef: prepared.credentialRef,
          transportOrigin: setupOrigin,
          providerConnectionKey: prepared.providerConnectionKey, providerConfig: prepared.providerConfig,
          routingIdentityKey: 'a'.repeat(43), integrationPrincipal: prepared.integrationPrincipal, authorityEpoch: 1 },
        outboundTextLimit: limit, transport: { kind: prepared.recommendedTransport === 'socket' ? 'socket' : 'checkpointedPull' },
        replayContinuity: prepared.replayContinuity, overlapSafety: prepared.overlapSafety,
      }), { expectedRevision: 'absent' });
      const family = '👨‍👩‍👧‍👦';
      const text = 'x'.repeat(limit.maximum - 2) + family + 'e\u0301'.repeat(35000);
      const content = ConversationDeliveryContentV1Schema.parse({ text, html: '<p>Retained structured body</p>' });
      const result = await coreKit.invokeAction('deliver', content);
      if (handlerRole === 'inspect') {
        expect(result).toMatchObject({ kind: 'settled', custody: { state: 'outcomeUnknown', providerMessageIds: [] } });
        expect(consumed).toHaveLength(1);
        expect(ConversationConnectionTestInputV1Schema.safeParse(consumed[0]).success).toBe(false);
        expect(consumerRefusals).toHaveLength(1);
        expect(nativeMessages).toEqual([]);
        expect(nativeResults).toEqual([]);
        expect(deliveries.writes.at(-1)?.payload).toMatchObject({ state: 'outcomeUnknown', providerMessageIds: [] });
        return;
      }
      if (rateLimited) {
        const retryNotBefore = 1_700_000_000_000 + 90_000_000;
        expect(nativeResults).toEqual([{ kind: 'notDelivered', retry: 'after', retryAfterMs: 90_000_000 }]);
        expect(result).toMatchObject({ kind: 'settled', custody: { state: 'retryDue', retryNotBefore } });
        expect(deliveries.writes.at(-1)).toMatchObject({ payload: { state: 'retryDue' }, 'retry-not-before': retryNotBefore });
        expect(nativeMessages).toHaveLength(1);
        expect(consumerRefusals).toEqual([]);
        return;
      }
      expect(result).toMatchObject({ kind: 'settled', custody: { state: 'delivered' } });
      expect(consumerRefusals).toEqual([]);
      expect(consumed.length).toBeGreaterThan(1);
      expect(consumed.map(value => value.content.text).join('')).toBe(text);
      expect(consumed.map(value => value.chunkIndex)).toEqual(consumed.map((_value, index) => index));
      expect(consumed.every(value => value.content.html === content.html)).toBe(true);
      expect(consumed.filter(value => value.content.text.includes(family))).toHaveLength(1);
      expect(consumed.every(value => countConversationTextUnits(value.content.text, limit.unit) <= limit.maximum)).toBe(true);
      expect(new Set(consumed.map(value => value.deliveryKey)).size).toBe(consumed.length);
      expect(nativeResults).toHaveLength(consumed.length);
      expect(nativeMessages.map(value => telegram ? value.text : value.content).join('')).toBe(text);
      if (telegram) {
        expect(nativeMessages.every(value => value.message_thread_id === 17)).toBe(true);
        expect(nativeMessages[0]?.reply_parameters).toMatchObject({ message_id: 7 });
        expect(nativeMessages.slice(1).every(value => value.reply_parameters === undefined)).toBe(true);
      } else {
        expect(nativeMessages.every(value => isChannelStateJsonRecord(value.message_reference)
          && value.message_reference.message_id === 'original-message')).toBe(true);
      }
      expect(deliveries.writes.some(value => isChannelStateJsonRecord(value.payload) && value.payload.state === 'attempting'
        && isChannelStateJsonRecord(value.payload.content) && value.payload.content.html === content.html)).toBe(true);
      const last = deliveries.writes.at(-1);
      expect(last?.payload).toMatchObject({ state: 'delivered', providerMessageIds: nativeResults.flatMap(value =>
        value.kind === 'delivered' ? value.providerMessageIds : []) });
    } finally {
      await coreKit.dispose();
      await providerKit.dispose();
    }
  });
});
