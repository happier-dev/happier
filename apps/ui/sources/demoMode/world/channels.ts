import { CONVERSATION_CORE_PLUGIN_ID_V1,
    CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1, CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1,
    CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1 } from '@happier-dev/channels-protocol/v1';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import type { ChannelsBinding, ChannelsConnection } from '../../../../../packages/plugins/channels/src/ui/conversationRows';
import { SLACK_PLUGIN_ID } from '../../../../../packages/plugins/channel-slack/src/slackPluginConstants';
import { DISCORD_PLUGIN_ID } from '../../../../../packages/plugins/channel-discord/src/discordPluginConstants';
import { EMAIL_CHANNEL_PLUGIN_ID } from '../../../../../packages/plugins/channel-email/src/constants';
import { TELEGRAM_CHANNEL_PLUGIN_ID } from '../../../../../packages/plugins/channel-telegram/src/constants';
import { DEMO_MACHINE_ID, DEMO_RICH_SESSION_ID } from './constants';

/** Public management projections only: no connected-account credentials or provider routing data. */
export function buildDemoChannelsWorld(): Readonly<{
    connections: readonly ChannelsConnection[];
    bindings: readonly ChannelsBinding[];
    targetedContributions: NonNullable<SurfaceContext['targetedContributions']>;
}> {
    const services = [
        { id: 'slack', pluginId: SLACK_PLUGIN_ID, label: 'Slack · Northstar Studio', endpoint: '#launch-room', summary: 'Northstar launch', transport: 'socket' },
        { id: 'email', pluginId: EMAIL_CHANNEL_PLUGIN_ID, label: 'Email · Northstar Studio', endpoint: 'support@example.test', summary: 'Customer support', transport: 'checkpointedPull' },
        { id: 'discord', pluginId: DISCORD_PLUGIN_ID, label: 'Discord · Northstar Studio', endpoint: '#product-feedback', summary: 'Product feedback', transport: 'socket' },
        { id: 'telegram', pluginId: TELEGRAM_CHANNEL_PLUGIN_ID, label: 'Telegram · Maya', endpoint: 'Maya’s assistant', summary: 'Daily companion', transport: 'checkpointedPull' },
    ] as const;
    return {
        targetedContributions: {
            target: { pluginId: CONVERSATION_CORE_PLUGIN_ID_V1, occurrenceId: 'demo-channels',
                sourceCustody: { kind: 'development', registeredRootId: 'demo-world' } },
            points: [{ pointId: CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1, protocols: [{
                protocol: { id: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1, version: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1 },
                contributions: services.map(service => ({ contributor: { pluginId: service.pluginId, contributionId: `${service.id}-provider`,
                    occurrenceId: `demo-${service.id}`, sourceCustody: { kind: 'development', registeredRootId: 'demo-world' } },
                    protocol: { id: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1, version: CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1 },
                    descriptor: { v: 1, displayName: service.label.split(' · ')[0] }, operations: [], surfaces: [] })),
            }] }],
        },
        connections: services.map(service => ({
            connectionId: service.id, revision: 1, providerPluginId: service.pluginId,
            selectedMachineId: DEMO_MACHINE_ID, selectedTransport: service.transport,
            integrationPrincipalLabel: service.label, authorityEpoch: 1, enabled: true,
            deletionState: 'none',
            attention: { historyGap: null, providerReadiness: null, ingressConflict: null, pollFailure: null,
                bestEffortBeforeDurableAdmission: false, oldTransportStopUnconfirmed: false,
                endpointRetargetOwed: false, acceptedPossibleLoss: false,
                outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false, archiveRecovery: false } },
        })),
        bindings: services.map(service => ({
            bindingId: `${service.id}-launch`, revision: 1, connectionId: service.id,
            endpoint: { audience: service.id === 'telegram' ? 'direct' : 'shared', label: service.endpoint },
            target: { kind: 'session', sessionId: DEMO_RICH_SESSION_ID, summary: service.summary },
            inputMode: 'addressedMessages', deliveryMode: 'repliesOnly', approval: { kind: 'enabled', maximumScope: 'request' },
            enabled: true, deletionState: 'none',
        })),
    };
}
