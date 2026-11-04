import { ConversationProvidersContributionPointV1 } from '@happier-dev/channels-protocol/v1';
import { assertEmailTransportContributionV1 } from '@happier-dev/email-transports-protocol/testing/v1';
import { definePlugin, type JsonValue, type PluginInvocationContext, type PluginServices, type TargetedContributionSnapshot } from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/plugin-sdk/host/registration';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { emailPlugin } from '../src/plugin.js';
import { channelsOperationOnlyTargetedContributionsFixture } from '../../channels/src/testkit/operationOnlyTargetedContributionsFixture.js';
import { CHANNELS_PLUGIN } from '../../channels/src/manifest.js';
import { CHANNEL_STATE_COLLECTION } from '../../channels/src/collections.js';
import { MemoryCollection } from '../../channels/src/testkit/memoryCollection.js';
import { createCurrentConversationConnectionFixture } from '../../channels/src/testkit/currentConnectionFixture.js';
import { createConversationOutwardDeliveryCollectionStore, type ConversationOutwardDeliveryObligation } from '../../channels/src/outwardDelivery.js';
import { deliverConversationOutwardDeliveryThroughProviderAction, reconcileConversationOutwardDeliveryAttemptThroughProviderAction } from '../../channels/src/outwardDeliveryProviderActions.js';
import { EmailTransportsContributionProtocolV1 as protocol, EmailTransportFetchRawInputV1Schema,
  EmailTransportSubmitRawInputV1Schema, EmailTransportFindSentInputV1Schema,
  type EmailTransportSubmitRawInputV1 } from '../src/transports.js';
import { ConversationTransportFactReportInputV1Schema, type ConversationTransportFactReportInputV1,
  type ConversationResolvedEndpointV1 } from '@happier-dev/channels-protocol/v1';

export const mailbox = 'wilson@example.com';
export const incoming = Buffer.from(['From: Alice <alice@example.com>', 'Message-ID: <incoming@example.com>',
  'References: <root@example.com>', 'Authentication-Results: mx.example.com; dmarc=pass header.from=example.com',
  'Reply-To: attacker@outside.com', 'Cc: other@example.com',
  'Subject: Re: Question', 'Content-Type: text/plain; charset=utf-8', '', 'ANSWER',
  'On Monday, Alice wrote:', '> HISTORY'].join('\r\n'));

export async function createEmailTransportFixture(options: { findSent?: boolean } = {}) {
  const sent = new Map<string, Uint8Array>();
  const submissions: EmailTransportSubmitRawInputV1[] = [];
  const messages = new Map<string, Uint8Array>([['opaque-incoming', incoming], ['<incoming@example.com>', incoming]]);
  const facts: ConversationTransportFactReportInputV1[] = [];
  let refs = ['opaque-incoming'];
  let forceNotFound = false;
  let retainedCatalog: ReturnType<PluginTestkit['readTargetedContributionFixture']> | undefined;
  let ambiguous = false;
  let lookupOverride: Uint8Array | undefined;
  let invokedAtMs = Date.now();
  const receivedAtMs = 1_792_000_000_000;
  function transportAction(role: keyof typeof protocol.operations, run: ActionHandler) {
    const d = protocol.operations[role].declaration;
    return { title: role, inputSchema: d.input.schema.jsonSchema, resultSchema: d.resultSchema.jsonSchema,
      surfaces: role === 'fetchRaw' ? [...d.surfaces, 'cli' as const] : d.surfaces, dangerLevel: d.dangerLevel, run };
  }
  const transportPlugin = definePlugin({ id: 'acme.email.fixture', version: '0.0.0', actions: {
    list: transportAction('listSince', async () => ({ kind: 'batch', refs, checkpointAfterBatch: { position: refs.length === 0 ? 0 : 1 } })),
    fetch: transportAction('fetchRaw', async (input): Promise<JsonValue> => {
      const { ref } = EmailTransportFetchRawInputV1Schema.parse(input);
      const raw = lookupOverride ?? messages.get(ref) ?? sent.get(ref);
      return raw ? { kind: 'raw', mimeBase64: Buffer.from(raw).toString('base64'), receivedAtMs } : { kind: 'notReady', reason: 'unsupported' };
    }),
    submit: transportAction('submitRaw', async (input): Promise<JsonValue> => {
      const request = EmailTransportSubmitRawInputV1Schema.parse(input);
      submissions.push(request);
      sent.set(request.messageId, Buffer.from(request.mimeBase64, 'base64'));
      return ambiguous ? { kind: 'outcomeUnknown' } : { kind: 'delivered', providerMessageIds: [request.messageId] };
    }),
    test: transportAction('connectionTest', async () => ({ kind: 'ready', mailbox })),
    ...(options.findSent === false ? {} : { find: transportAction('findSent', async (input): Promise<JsonValue> => {
      const { messageId } = EmailTransportFindSentInputV1Schema.parse(input);
      return !forceNotFound && sent.has(messageId) ? { kind: 'found', messageId } : { kind: 'notFound' };
    }) }),
  }, contributesTo: { 'happier.channel.email': { transports: { fixture: protocol.contribute({ operations: {
    listSince: protocol.operations.listSince.bind('list'), fetchRaw: protocol.operations.fetchRaw.bind('fetch'),
    submitRaw: protocol.operations.submitRaw.bind('submit'), connectionTest: protocol.operations.connectionTest.bind('test'),
    ...(options.findSent === false ? {} : { findSent: protocol.operations.findSent.bind('find') }),
  } }) } } } });
  assertEmailTransportContributionV1(transportPlugin.manifest);
  const transport = await createPluginTestkit({ manifest: transportPlugin.manifest, module: transportPlugin });
  const state = new MemoryCollection<Record<string, JsonValue>>();
  // Account transport loss after SMTP acceptance leaves the durable attempt open.
  let loseSettlement = false;
  const deliveries = new MemoryCollection();
  const putDelivery = deliveries.put.bind(deliveries);
  deliveries.put = async (value, options) => {
    const payload = value.payload;
    if (loseSettlement && payload !== null && typeof payload === 'object' && 'state' in payload && payload.state === 'delivered') {
      loseSettlement = false;
      throw new Error('Account storage disconnected before settlement');
    }
    return putDelivery(value, options);
  };
  let reconciliationHandlerMissing = false;
  const materializationRef = { pluginId: emailPlugin.manifest.id, machineId: 'fixture-machine', materializationId: 'fixture-email' };
  await state.put(createCurrentConversationConnectionFixture({ connectionId: connection.connectionId, authority: {
    providerPluginId: emailPlugin.manifest.id, providerContributionSelection: { contributionId: 'email-provider' },
    providerSetupInput: { ...config, credentialRef: null }, credentialRef: null, providerConfig: config,
    providerConnectionKey: connection.providerConnectionKey, routingIdentityKey: 'e'.repeat(43),
    transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef }, integrationPrincipal: { id: mailbox }, authorityEpoch: 1,
  } }), { expectedRevision: 'absent' });
  await state.put({ id: 'fixture-binding', 'record-kind': 'binding', 'binding-id': 'fixture-binding', 'connection-id': connection.connectionId,
    v: 1, 'created-at': 1, 'updated-at': 1, payload: { endpoint: thread,
      target: { kind: 'session', sessionId: 'fixture-session', policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only',
        approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
      allowedPrincipalIds: ['alice@example.com'], allowBotSenders: false, inputMode: 'allAllowedMessages', inboundDebounceMs: 0,
      linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: true, deletionState: 'none',
    } }, { expectedRevision: 'absent' });
  const storage = { account: { collection(definition: { id: string }) {
    if (definition.id !== CHANNEL_STATE_COLLECTION.id) throw new Error('Unexpected readiness Collection');
    return state;
  } } } as unknown as PluginServices['storage'];
  const coreFacts = await createPluginTestkit({ manifest: CHANNELS_PLUGIN.manifest, services: { storage },
    module: { activate(api) { return CHANNELS_PLUGIN.activate({ ...api, actions: { ...api.actions, register(id, run) {
      return api.actions.register(id, async (input: Parameters<typeof run>[0], context) => {
        const result = await run(input, context);
        if (id === 'provider/transport-fact-report-v1' && result !== null && typeof result === 'object'
          && 'kind' in result && (result.kind === 'recorded' || result.kind === 'rejoined')) {
          const { senderEligibility: _candidate, ...publicFact } = ConversationTransportFactReportInputV1Schema.parse(input);
          facts.push(publicFact);
        }
        return result;
      });
    } } }); } } });
  let email: PluginTestkit;
  // The testkit provides structural admission and real opaque Action handles,
  // but deliberately has no production catalog observer. Adapt that host boundary only.
  function withCatalog(context: PluginInvocationContext): PluginInvocationContext {
    const catalog = channelsOperationOnlyTargetedContributionsFixture(email, emailPlugin.contributionPoints.transports);
    return { ...context, invokedAtMs, services: { ...context.services, targetedContributions: {
      observeForSelf: <T>(point: TargetedContributionPointRef<T>, options: { onInvalidated: () => void }) => {
        const observation = catalog.observeForSelf<T>(point, options);
        return { ...observation, readCurrent: async () => retainedCatalog
          ? retainedCatalog as unknown as TargetedContributionSnapshot<T> : observation.readCurrent() };
      },
    } } };
  }
  email = await createPluginTestkit({ manifest: emailPlugin.manifest, targetedContributionContributors: [transport],
    actionTargets: [coreFacts], resolveCurrentPluginMaterializationRef: () => materializationRef,
    module: { activate(api) {
      return emailPlugin.activate({ ...api, actions: { ...api.actions,
        register: (id, run) => api.actions.register(id, (input: Parameters<typeof run>[0], context) => run(input, withCatalog(context))),
      } });
    } } });
  let channels: PluginTestkit;
  const channelsPlugin = definePlugin({ id: 'happier.channels', version: '0.0.0',
    contributionPoints: { providers: ConversationProvidersContributionPointV1 }, actions: {
    custody: { title: 'Exercise Email custody recovery', surfaces: ['cli'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Exercise fixture custody?' },
      async run(input, context) {
        if (input === null || typeof input !== 'object' || Array.isArray(input)
          || !('item' in input) || typeof input.item !== 'string') throw new Error('Expected fixture item');
        const obligation: ConversationOutwardDeliveryObligation = {
          connectionId: connection.connectionId, bindingId: 'fixture-binding',
          routeAuthority: { connectionAuthorityEpoch: 1, bindingRevision: 1, bindingAuthorityEpoch: 1 },
          source: { kind: 'sessionProjection', sessionId: 'fixture-session', semanticItemId: input.item },
          endpoint: thread, content: { text: 'Reply' }, deliveryKey: `fixture-reply:${input.item}`,
          replyContext: { replyToMessageId: '<incoming@example.com>' }, mentionPolicy: 'suppress', linkPreviewPolicy: 'suppress',
        };
        const store = createConversationOutwardDeliveryCollectionStore({ stateCollection: state,
          deliveriesCollection: deliveries as unknown as Parameters<typeof createConversationOutwardDeliveryCollectionStore>[0]['deliveriesCollection'],
          signal: context.signal, now: () => invokedAtMs });
        // Only the host transport boundary is faulted; catalog, registration,
        // Email core, raw transport, custody parsing and CAS all stay real.
        const actions = new Proxy({ ...context.services.actions }, { get(target, property, receiver) {
          if (property !== 'executeAdmittedTargetedOperationWithExecutionOrigin') return Reflect.get(target, property, receiver);
          return (...args: Parameters<typeof target.executeAdmittedTargetedOperationWithExecutionOrigin>) => {
            if (reconciliationHandlerMissing && args[0].identity.role === 'deliveryReconcile') {
              throw createPluginActionHandlerNotStartedError({ code: 'plugin_action_handler_missing', message: 'Recovery handler unavailable' });
            }
            return target.executeAdmittedTargetedOperationWithExecutionOrigin(...args);
          };
        } });
        const common = { stateCollection: state, targetedContributions: channelsOperationOnlyTargetedContributionsFixture(channels),
          actions, store, signal: context.signal, now: () => invokedAtMs };
        if ('recover' in input && input.recover === true) {
          const lookup = await store.lookup(obligation);
          if (lookup.kind !== 'rejoined') throw new Error('Expected retained custody');
          return defineProtocolJsonValue().parse(await reconcileConversationOutwardDeliveryAttemptThroughProviderAction({
            ...common, record: lookup.record, recoveryAttemptId: `recovery:${invokedAtMs}`, staleAfterMs: 0,
          }));
        }
        return defineProtocolJsonValue().parse(await deliverConversationOutwardDeliveryThroughProviderAction({
          ...common, obligation, attemptId: `attempt:${invokedAtMs}`,
        }));
      } },
    invoke: { title: 'Invoke email provider', surfaces: ['cli'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Invoke fixture provider?' },
      run: (input, context) => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid fixture invocation');
        // Array.isArray does not narrow readonly JSON arrays; the fixture's Action boundary has rejected them above.
        const request = input as Readonly<Record<string, JsonValue>>;
        if (typeof request.action !== 'string') throw new Error('Invalid fixture invocation');
        return context.services.actions.execute({ pluginId: emailPlugin.manifest.id, localId: request.action }, request.input ?? null);
      } },
  } });
  channels = await createPluginTestkit({ manifest: channelsPlugin.manifest, module: channelsPlugin, actionTargets: [email],
    targetedContributionContributors: [email] });
  return { sent, submissions, facts, receivedAtMs, email, state, materializationRef, setInvocationTime(value: number) { invokedAtMs = value; },
    setAmbiguous(value: boolean) { ambiguous = value; }, replaceFetched(raw: Uint8Array) { lookupOverride = raw; },
    setMessages(values: readonly (readonly [string, Uint8Array])[]) { for (const [ref, raw] of values) messages.set(ref, raw); refs = values.map(([ref]) => ref); },
    addMessage(ref: string, raw: Uint8Array) { messages.set(ref, raw); },
    setNotFound() { forceNotFound = true; },
    loseNextSettlement() { loseSettlement = true; },
    setReconciliationHandlerMissing(value: boolean) { reconciliationHandlerMissing = value; },
    custody: (item: string, recover = false) => channels.invokeAction('custody', { item, recover }),
    retainCatalog() { retainedCatalog = email.readTargetedContributionFixture(emailPlugin.contributionPoints.transports); return retainedCatalog; },
    releaseCatalog() { retainedCatalog = undefined; },
    retireTransport: () => transport.dispose(),
    invoke: (action: string, input: JsonValue) => channels.invokeAction('invoke', { action, input }),
    dispose: async () => { await channels.dispose(); await email.dispose(); await transport.dispose(); await coreFacts.dispose(); } };
}

export const config = { mailbox, transport: { pluginId: 'acme.email.fixture', contributionId: 'fixture' }, transportConfig: {},
  trustStrategy: { kind: 'authenticationResults', authservId: 'mx.example.com' }, allowedDomains: ['example.com'] };
export const connection = { v: 1, connectionId: 'email-fixture', providerConnectionKey: `email:${mailbox}`,
  providerConfigVersion: 1, providerConfig: config, credentialRef: null };
export const thread = { kind: 'thread', audience: 'direct', id: '<root@example.com>', parentId: mailbox } satisfies ConversationResolvedEndpointV1;
export const delivery = { ...connection, endpoint: thread, content: { text: 'Reply' }, deliveryKey: 'fixture-reply',
  replyContext: { replyToMessageId: '<incoming@example.com>' }, mentionPolicy: 'suppress', linkPreviewPolicy: 'providerDefault' };
