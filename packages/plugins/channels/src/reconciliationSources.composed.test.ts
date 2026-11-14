import { describe, expect, it } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, PLUGIN_MANIFEST } from '@happier-dev/plugins-channel-discord';
import { PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS } from './targetedContributions.js';
import { listConversationProviderConnectionsForInvocation, readConversationProviderConnectionForInvocation } from './reconciliation.js';
import { channelsTargetedContributionServices } from './testkit/operationOnlyTargetedContributionsFixture.js';
import { createCurrentConversationConnectionFixture } from './testkit/currentConnectionFixture.js';
import { MemoryCollection } from './testkit/memoryCollection.js';

describe('Channels armed message source demand', () => {
  it('projects provider-scoped armed sources without bindings, releases them on disarm, and reads the catalog once per provider census', async () => {
    const providerId = PLUGIN_MANIFEST.id;
    const materialization = { pluginId: providerId, machineId: 'machine-1', materializationId: 'discord-1' };
    let armed = false;
    let available = true;
    let catalogReads = 0;
    const definition = {
      automationId: '11111111-1111-4111-8111-111111111111', triggerId: 'trigger-1', triggerRevision: 1,
      eventRef: { pluginId: providerId, localId: 'automation/channel-message-observed-v1' },
      sourceInstanceId: 'discord:application:123:channel:456', sourceSelectorId: '22222222-2222-4222-8222-222222222222',
      sourceContractVersion: 1, sourceConfig: { v: 1, applicationId: '123', channelId: '456' },
      observationTransport: { kind: 'socket', watcherMaterializationRef: materialization }, filter: null, maximumObservationAgeMs: null,
    };
    // Host Action transport and Collection persistence are boundaries; parsing and contribution dispatch stay real.
    const provider = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate },
      resolveCurrentPluginMaterializationRef: () => materialization,
      services: { actions: { async execute(action: string) {
        if (action !== 'automation.event.sources.list') throw new Error(`Unexpected host Action ${action}`);
        if (!available) throw new Error('Host source catalog unavailable');
        catalogReads += 1;
        return { kind: 'page', revision: String(catalogReads), definitions: armed ? [definition] : [], nextCursor: null };
      } } as unknown as PluginServices['actions'] },
    });
    const collection = new MemoryCollection();
    for (const applicationId of ['123', '789']) {
      await collection.put(createCurrentConversationConnectionFixture({ connectionId: `connection-${applicationId}`,
        authority: { providerPluginId: providerId, providerContributionSelection: { contributionId: 'discord-provider' },
          providerSetupInput: {}, credentialRef: null, transportOrigin: { serverIdentityId: 'srv_plugin_testkit', materializationRef: materialization },
          providerConnectionKey: `discord:application:${applicationId}`, providerConfig: { applicationId },
          routingIdentityKey: 'r'.repeat(43), integrationPrincipal: { id: applicationId }, authorityEpoch: 1 },
        transport: { kind: 'socket' } }), { expectedRevision: 'absent' });
    }
    const host = definePlugin({ id: 'happier.channels', version: '0.0.0', contributionPoints: PLUGIN_TARGETED_CONTRIBUTION_POINT_DEFINITIONS,
      actions: { probe: { title: 'Read source demand', surfaces: ['plugin'], inputSchema: { type: 'object' }, resultSchema: { type: 'object' },
        async run(input, context) {
          const request = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
          const invocation = { ...context, caller: { kind: 'plugin' as const, pluginId: providerId,
            contribution: { id: 'gateway', qualifiedId: `${providerId}/backgroundServices/gateway` },
            occurrenceId: 'discord-1', sourceCustody: { kind: 'development' as const, registeredRootId: 'discord-root' }, materialization,
            executionOrigin: { serverIdentityId: 'ineligible' in request && request.ineligible === true ? 'srv_other_home' : 'srv_plugin_testkit', materializationRef: materialization } } };
          return 'exact' in request && request.exact === true
            ? await readConversationProviderConnectionForInvocation({ connectionId: 'connection-123' }, invocation)
            : await listConversationProviderConnectionsForInvocation({}, invocation);
        } } } });
    const kit = await createPluginTestkit({ manifest: host.manifest, module: { activate: host.activate },
      targetedContributionContributors: [provider], services: { storage: { account: { collection: () => collection } } as unknown as PluginServices['storage'] } });
    const read = (exact = false) => kit.invokeAction('probe', { exact }, { surface: 'plugin', services: channelsTargetedContributionServices(kit) });
    try {
      expect(await kit.invokeAction('probe', { ineligible: true }, { surface: 'plugin', services: channelsTargetedContributionServices(kit) })).toEqual({});
      expect(catalogReads).toBe(0);
      expect(await read()).toMatchObject({ 'connection-123': { requiresFullSharedMessageContent: false } });
      armed = true;
      const before = catalogReads;
      expect(await read()).toMatchObject({ 'connection-123': { requiresFullSharedMessageContent: true },
        'connection-789': { requiresFullSharedMessageContent: false } });
      expect(catalogReads - before).toBe(1);
      expect(await read(true)).toMatchObject({ 'connection-123': { requiresFullSharedMessageContent: true } });
      available = false;
      await expect(read()).rejects.toMatchObject({ code: 'automation_event_adopted_definitions_unavailable' });
      available = true;
      expect(await read()).toMatchObject({ 'connection-123': { requiresFullSharedMessageContent: true } });
      armed = false;
      expect(await read()).toMatchObject({ 'connection-123': { requiresFullSharedMessageContent: false } });
    } finally { await kit.dispose(); await provider.dispose(); }
  });
});
