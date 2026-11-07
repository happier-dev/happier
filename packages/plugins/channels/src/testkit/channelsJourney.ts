import { definePlugin, type JsonValue, type PluginInvocationContext, type PluginServices } from '@happier-dev/plugin-sdk';
import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ConversationProviderObservationIngestInputV1Schema, ConversationProviderConnectionReadInputV1Schema,
  ConversationProviderConnectionsListInputV1Schema, ConversationTransportFactReportInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { CHANNELS_PLUGIN, CHANNELS_PROVIDER_POINT_REF, PLUGIN_MANIFEST } from '../manifest.js';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from '../collections.js';
import { runConversationCheckpointedPollForInvocation, runConversationIngressDueWorkForInvocation,
  type ConversationCheckpointedPollRunResult } from '../ingress.js';
import { runConversationOutwardDeliveryCycle } from '../outwardDeliverySupervisor.js';
import { channelsTargetedContributionServices } from './operationOnlyTargetedContributionsFixture.js';
import { MemoryCollection } from './memoryCollection.js';
import type { ComposerAttachmentResolveRequestV1 } from '@happier-dev/plugin-sdk';
import { getPluginMachineExecutionRouting, PluginMachineExecutionOriginV1Schema, type PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';

/**
 * Public-SDK composition of the actual Channels activation and cycle owners.
 * Account persistence is the existing Collection boundary. Sessions and host
 * Actions are supplied by the consuming host test: this fixture never models
 * admission, transcript projection, spawn or turn control itself.
 */
export async function createChannelsJourneyFixture(input: Readonly<{
  provider: PluginTestkit;
  connection: Record<string, unknown>;
  binding: Record<string, unknown>;
  sessions: PluginServices['sessions'];
  actions: PluginServices['actions'];
  settings?: PluginServices['settings'];
  resolveCurrentPluginMaterializationRef?: Parameters<typeof createPluginTestkit>[0]['resolveCurrentPluginMaterializationRef'];
  /** Current provider identity supplied by the host fixture, independently of saved connection state. */
  resolveCurrentProviderExecutionOrigin?: () => PluginMachineExecutionOriginV1 | null;
  omitAttachmentRegistration?: boolean;
  logger?: PluginServices['logger'];
  state?: MemoryCollection;
  deliveries?: MemoryCollection;
}>) {
  const state = input.state ?? new MemoryCollection();
  const deliveries = input.deliveries ?? new MemoryCollection();
  if (input.state === undefined) {
    await state.put(input.connection, { expectedRevision: 'absent' });
    await state.put(input.binding, { expectedRevision: 'absent' });
  }
  const storage = { account: { collection: (definition: { id: string }) => {
    if (definition.id === CHANNEL_STATE_COLLECTION.id) return state;
    if (definition.id === CHANNEL_DELIVERIES_COLLECTION.id) return deliveries;
    throw new Error(`Unexpected Channels collection ${definition.id}`);
  } } } as unknown as PluginServices['storage'];
  let kit: PluginTestkit;
  function withProviderCaller(context: PluginInvocationContext, contribution?: PluginInvocationContext['contribution']): PluginInvocationContext {
    const entry = kit.readTargetedContributionFixture(CHANNELS_PROVIDER_POINT_REF).contributions[0];
    if (!entry) throw new Error('The activated provider contribution is absent');
    const executionOrigin = PluginMachineExecutionOriginV1Schema.parse(input.resolveCurrentProviderExecutionOrigin?.());
    // Caller identity is stamped at the host boundary, never from provider input.
    return { ...context, caller: { kind: 'plugin', pluginId: entry.contributor.pluginId,
      contribution: contribution ?? { id: 'poll', qualifiedId: `${entry.contributor.pluginId}/actions/poll` },
      occurrenceId: entry.contributor.occurrenceId, sourceCustody: entry.contributor.sourceCustody,
      ...('materializationRef' in executionOrigin ? { materialization: executionOrigin.materializationRef } : {}),
      executionOrigin } };
  }
  let attempt = 0;
  const pollResults: ConversationCheckpointedPollRunResult[] = [];
  const driver = definePlugin({ id: 'happier.channels', version: '0.0.0', actions: {
    'journey/resolve-attachments': { title: 'Resolve through the activated attachment runtime', scopes: ['session'], surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'], inputSchema: { type: 'object' }, resultSchema: { type: 'object' },
      async run(request, context) {
        const runtime = kit.registration('composerAttachments', 'channel-file');
        if (!runtime?.resolveForDispatch) throw new Error('Missing activated attachment runtime');
        // The fixture caller constructs the canonical typed request; this is the external host callback boundary.
        return await runtime.resolveForDispatch(request as unknown as ComposerAttachmentResolveRequestV1, context);
      } },
    'journey/poll': { title: 'Run the production ingress cycle', surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'],
      inputSchema: { type: 'object' }, resultSchema: { type: 'null' },
      async run(_request, context) {
        pollResults.push(await runConversationCheckpointedPollForInvocation({ connectionId: String(input.connection.id), waitMs: 0 }, context));
        return null;
      } },
    'journey/supervise': { title: 'Run the activated ingress background service', surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'],
      inputSchema: { type: 'object' }, resultSchema: { type: 'null' },
      async run(_request, context) {
        const runner = kit.registration('backgroundServices', 'ingress-supervisor');
        if (!runner) throw new Error('Missing activated ingress supervisor');
        await runner({ ...context, surface: 'background', session: undefined });
        return null;
      } },
    'journey/outward': { title: 'Run the production outward cycle', surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'],
      inputSchema: { type: 'object' }, resultSchema: { type: 'null' },
      async run(_request, context) {
        await runConversationOutwardDeliveryCycle({ context: context as BackgroundServiceContext,
          createAttemptId: () => `journey-attempt-${++attempt}` });
        return null;
      } },
    'journey/due': { title: 'Run deferred ingress through the production owner', surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'],
      inputSchema: { type: 'object' }, resultSchema: { type: 'null' },
      async run(_request, context) {
        await runConversationIngressDueWorkForInvocation({}, context);
        return null;
      } },
    'journey/ingest': { title: 'Invoke the activated ingress registration', surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage', 'bound-session'], inputSchema: ConversationProviderObservationIngestInputV1Schema,
      resultSchema: { type: 'null' }, async run(request, context) {
        const handler = kit.registration('actions', 'provider/observation-ingest-v1');
        if (!handler) throw new Error('The activated provider ingress handler is absent');
        await handler(request, withProviderCaller(context));
        return null;
      } },
    'journey/transport-fact': { title: 'Invoke the activated transport fact registration', surfaces: ['plugin'], dangerLevel: 'safe',
      hostAccess: ['account-storage'], inputSchema: ConversationTransportFactReportInputV1Schema,
      resultSchema: { type: 'null' }, async run(request, context) {
        const handler = kit.registration('actions', 'provider/transport-fact-report-v1');
        if (!handler) throw new Error('The activated transport fact handler is absent');
        await handler(request, withProviderCaller(context));
        return null;
      } },
  } });
  kit = await createPluginTestkit({
    manifest: { ...PLUGIN_MANIFEST, contributes: { ...PLUGIN_MANIFEST.contributes, actions: [
      ...(PLUGIN_MANIFEST.contributes?.actions ?? []), ...(driver.manifest.contributes?.actions ?? []),
    ] } },
    module: { async activate(api) {
      const disposeChannels = await CHANNELS_PLUGIN.activate(input.omitAttachmentRegistration ? {
        ...api, composerAttachments: { ...api.composerAttachments, register(id, runtime) {
          if (id !== 'channel-file') api.composerAttachments.register(id, runtime);
        } },
      } : api);
      const disposeDriver = await driver.activate(api);
      return async () => {
        if (typeof disposeDriver === 'function') await disposeDriver();
        if (typeof disposeChannels === 'function') await disposeChannels();
      };
    } },
    targetedContributionContributors: [input.provider],
    ...(input.resolveCurrentPluginMaterializationRef ? { resolveCurrentPluginMaterializationRef: input.resolveCurrentPluginMaterializationRef }
      : input.resolveCurrentProviderExecutionOrigin === undefined ? {} : {
        // The fixture host colocates core and provider by default. Tests may
        // explicitly place another core elsewhere; saved connection data is
        // never the host-identity source.
        resolveCurrentPluginMaterializationRef: () => {
          const origin = input.resolveCurrentProviderExecutionOrigin?.();
          return origin == null ? null : { pluginId: 'happier.channels',
            machineId: getPluginMachineExecutionRouting(origin).machineId, materializationId: 'channels-journey-core' };
        },
      }),
    services: { storage, sessions: input.sessions, actions: input.actions,
      ...(input.settings ? { settings: input.settings } : {}),
      logger: input.logger ?? { debug() {}, info() {}, warn() {}, error() {}, diagnostic() {} } },
  });
  async function invoke(action: string, value: JsonValue) {
    return await kit.invokeAction(action, value, { surface: action.startsWith('journey/') ? 'plugin' : 'cli',
      services: channelsTargetedContributionServices(kit) });
  }
  // The reverse plugin-to-core host transport boundary. Both schemas and
  // handlers are real; only host dispatch/caller/storage binding is supplied.
  async function executeProviderCoreAction(action: Readonly<{ pluginId: string; localId: string }>,
    value: unknown, context: PluginInvocationContext) {
    if (action.pluginId !== 'happier.channels') throw new Error('Unexpected core Action target');
    const schema = action.localId === 'provider/connection-read-v1' ? ConversationProviderConnectionReadInputV1Schema
      : action.localId === 'provider/connections-list-v1' ? ConversationProviderConnectionsListInputV1Schema
      : action.localId === 'provider/observation-ingest-v1' ? ConversationProviderObservationIngestInputV1Schema
      : action.localId === 'provider/transport-fact-report-v1' ? ConversationTransportFactReportInputV1Schema : undefined;
    const handler = kit.registration('actions', action.localId);
    if (schema === undefined || handler === undefined) throw new Error('Missing activated core Action');
    if (action.localId === 'provider/observation-ingest-v1') {
      // Use the existing host driver so downstream provider Event obligations
      // receive the SDK's real admitted-operation executor, not provider services.
      await kit.invokeAction('journey/ingest', schema.parse(value), { surface: 'plugin', signal: context.signal,
        services: channelsTargetedContributionServices(kit) });
      return;
    }
    return await handler(schema.parse(value), { ...withProviderCaller(context, context.contribution),
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: { id: action.localId, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${action.localId}` },
      services: { ...context.services, storage } });
  }
  return { kit, state, deliveries, invoke, executeProviderCoreAction,
    poll: async () => { await invoke('journey/poll', {}); return pollResults.at(-1); },
    pollResults, outward: () => invoke('journey/outward', {}),
    due: () => invoke('journey/due', {}),
    ingest: (value: JsonValue) => invoke('journey/ingest', value),
    resolveAttachments: (request: ComposerAttachmentResolveRequestV1) => kit.invokeAction('journey/resolve-attachments', request, {
      surface: 'plugin', sessionId: request.sessionId, services: channelsTargetedContributionServices(kit),
    }),
    dispose: () => kit.dispose() };
}
