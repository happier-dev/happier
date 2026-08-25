import { describe, expect, it } from 'vitest';

import * as protocol from './v1/index.js';

describe('Channels public protocol atomic cutover', () => {
    it('publishes the V1 contribution point and replaces a caller-selected setup Action with the generic selection', () => {
        expect(protocol.ConversationProvidersContributionPointV1).toMatchObject({
            maxContributionsPerContributor: 1,
            protocols: [{
                id: 'happier.channels/providers',
                version: 1,
                operations: {
                    setup: {
                        required: true,
                        input: { kind: 'contributorDefined' },
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                    setupRemediation: {
                        required: false,
                        input: { kind: 'contributorDefined' },
                        action: { surface: 'plugin', dangerLevel: 'writesRemote' },
                    },
                    connectionTest: {
                        required: true,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                    endpointResolve: {
                        required: false,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                    principalResolve: {
                        required: false,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                    observationsPoll: {
                        required: false,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                    automationEventAdmit: {
                        required: false,
                        input: {
                            kind: 'protocolDefined',
                            schema: protocol.ConversationProviderAutomationEventAdmitInputV1JsonSchema,
                        },
                        resultSchema: protocol.ConversationProviderAutomationEventAdmitResultV1JsonSchema,
                        action: { surface: 'plugin', dangerLevel: 'writesRemote' },
                    },
                    messageDeliver: {
                        required: true,
                        action: { surface: 'plugin', dangerLevel: 'writesRemote' },
                    },
                    deliveryReconcile: {
                        required: false,
                        action: { surface: 'plugin', dangerLevel: 'safe' },
                    },
                    connectionStop: {
                        required: false,
                        action: { surface: 'plugin', dangerLevel: 'writesRemote' },
                    },
                },
            }],
        });
        const declaredProtocol = protocol.ConversationProvidersContributionPointV1.protocols[0];
        expect(protocol.ConversationProvidersContributionProtocolV1).not.toHaveProperty('descriptor');
        expect(declaredProtocol).not.toHaveProperty('descriptor');
        expect(protocol.ConversationProvidersContributionPointV1.maxContributionsPerContributor).toBe(1);
        expect(Object.keys(declaredProtocol?.operations ?? {}).sort()).toEqual([
            'automationEventAdmit',
            'connectionStop',
            'connectionTest',
            'deliveryReconcile',
            'endpointResolve',
            'messageDeliver',
            'observationsPoll',
            'principalResolve',
            'setup',
            'setupRemediation',
        ]);
        expect(declaredProtocol?.operations).not.toHaveProperty('webhookReceive');

        const selection = {
            target: {
                pluginId: 'happier.channels',
                immutableGenerationId: 'generation-channels-1',
            },
            point: {
                pointId: 'providers',
                protocol: { id: 'happier.channels/providers', version: 1 },
            },
            contributor: {
                pluginId: 'happier.channel.telegram',
                contributionId: 'provider',
                immutableGenerationId: 'generation-telegram-1',
            },
        } as const;
        const input = {
            providerSelection: selection,
            providerSetupInput: { botToken: 'opaque' },
            credentialRef: null,
        } as const;

        expect(protocol.ConversationConnectionPrepareInputV1Schema.parse(input)).toEqual(input);
        expect(protocol.ConversationConnectionPrepareInputV1Schema.safeParse({
            ...input,
            providerSetupAction: {
                pluginId: 'happier.channel.telegram',
                localId: 'channels/setup-v1',
            },
        }).success).toBe(false);
    });
});
