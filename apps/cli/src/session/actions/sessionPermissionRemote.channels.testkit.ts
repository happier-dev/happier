import assert from 'node:assert/strict';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import { ConversationBindingV1Schema, ConversationProviderObservationIngestInputV1Schema } from '@happier-dev/channels-protocol/v1';
import { activate as activateTelegram, PLUGIN_MANIFEST as telegramManifest } from '@happier-dev/plugins-channel-telegram';
import { TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID } from '../../../../../packages/plugins/channel-telegram/src/constants';
import { withChannelStateSessionIdentity } from '../../../../../packages/plugins/channels/src/collectionMigrations';
import { createCurrentConversationConnectionFixture } from '../../../../../packages/plugins/channels/src/testkit/currentConnectionFixture';
import { createChannelsJourneyFixture } from '../../../../../packages/plugins/channels/src/testkit/channelsJourney';

/** Only Account persistence and the provider's host-stamped invocation are fixtures. */
export async function createSeparateProcessChannelsIngress(input: Readonly<{
    sessionId: string;
    machineId: string;
    actions: ActionsService;
    signal: AbortSignal;
}>) {
    const providerPluginId = 'happier.channel.telegram';
    const origin = { serverIdentityId: 'srv_permission_process', materializationRef: {
        pluginId: providerPluginId, machineId: input.machineId, materializationId: 'provider-current',
    } };
    const connection = createCurrentConversationConnectionFixture({ connectionId: 'connection-1',
        authority: { providerPluginId, providerContributionSelection: { contributionId: TELEGRAM_CHANNEL_PROVIDER_CONTRIBUTION_ID },
            providerSetupInput: {}, credentialRef: null, transportOrigin: origin,
            providerConnectionKey: 'fixture-connection', providerConfig: {}, routingIdentityKey: 'r'.repeat(43),
            integrationPrincipal: { id: 'telegram:bot:1' }, authorityEpoch: 1 },
        transport: { kind: 'socket' }, replayContinuity: 'none' });
    const binding = ConversationBindingV1Schema.parse({ v: 1, id: 'binding-1', connectionId: connection.id,
        endpoint: { kind: 'direct', audience: 'direct', id: 'telegram:chat:100' },
        target: { kind: 'session', sessionId: input.sessionId, policy: { deliveryMode: 'repliesOnly',
            permissionCeiling: 'default', approvals: { kind: 'enabled', maximumScope: 'request' }, newSession: { kind: 'off' } } },
        allowedPrincipalIds: ['telegram:user:42'], allowBotSenders: false, inputMode: 'directMentionsOnly',
        inboundDebounceMs: 0, linkPreviewPolicy: 'suppress', senderFeedback: 'off',
        authorityEpoch: 1, enabled: true, deletionState: 'none', createdAt: 1, updatedAt: 1 });
    const { id, connectionId, v, createdAt, updatedAt, ...payload } = binding;
    const unexpected = () => { throw new Error('Permission commands must not reach unrelated host services'); };
    const provider = await createPluginTestkit({ manifest: telegramManifest, module: { activate: activateTelegram },
        resolveCurrentPluginMaterializationRef: () => origin.materializationRef });
    const journey = await createChannelsJourneyFixture({ provider, connection,
        binding: withChannelStateSessionIdentity({ id, v, 'record-kind': 'binding',
            'binding-id': id, 'connection-id': connectionId, 'created-at': createdAt, 'updated-at': updatedAt, payload }, binding.target),
        actions: input.actions, sessions: { get: unexpected } as unknown as PluginServices['sessions'],
        resolveCurrentProviderExecutionOrigin: () => origin,
    }).catch(async error => { await provider.dispose(); throw error; });
    const { state } = journey;
    const settledCount = (disposition: string) => [...state.rows.values()].filter(row => {
        if (row.value['record-kind'] !== 'ingress-obligation') return false;
        const value = row.value.payload;
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            && Reflect.get(value, 'disposition') === disposition;
    }).length;
    return Object.assign(async (text: string, messageId: string, disposition: 'approvalConsumed' | 'userActionConsumed') => {
        const before = settledCount(disposition);
        const now = Date.now();
        input.signal.throwIfAborted();
        await journey.ingest(ConversationProviderObservationIngestInputV1Schema.parse({
            connectionId, entry: { eventCandidate: null, observation: { kind: 'fullText', observation: {
                v: 1, occurrenceId: messageId, occurredAt: now, transport: { kind: 'socket' }, endpoint: binding.endpoint,
                actor: { principalId: 'telegram:user:42', label: 'Ada', kind: 'human', isIntegrationSelf: false },
                message: { id: messageId, revision: messageId, text, addressingEvidence: 'none', contentProvenance: 'original', providerTimestamp: now },
            } } },
        }));
        assert.equal(settledCount(disposition), before + 1, `The real Channels command must settle as ${disposition}`);
    }, { async dispose() { await journey.dispose(); await provider.dispose(); } });
}
