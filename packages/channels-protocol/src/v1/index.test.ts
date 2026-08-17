import { describe, expect, it } from 'vitest';
import {
    AutomationResultDeliveryInputV1JsonSchema,
    AutomationResultDeliveryResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/automations';
import type {
    ChannelSessionSpawnRecipeV1,
    ConversationJsonObjectV1,
    ConversationJsonValueV1,
    ConversationSessionBindingTargetV1,
} from './index.js';

import * as protocol from './index.js';

describe('Channels V1 public barrel', () => {
    it('publishes completed provider, core, and management contracts without leaking composition sources', () => {
        expect(protocol.ConversationDeliveryResultV1JsonSchema)
            .toBe(protocol.ConversationDeliveryResultV1Schema.jsonSchema);
        expect(protocol.ConversationProviderObservationIngestInputV1JsonSchema)
            .toBe(protocol.ConversationProviderObservationIngestInputV1Schema.jsonSchema);
        expect(protocol.ConversationConnectionPollRetryManagementActionDeclarationV1).toEqual({
            inputSchema: protocol.ConversationConnectionPollRetryInputV1JsonSchema,
            resultSchema: protocol.ConversationConnectionPollRetryResultV1JsonSchema,
        });
        expect(protocol.CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionPollRetry)
            .toBe(protocol.ConversationConnectionPollRetryManagementActionDeclarationV1);
        expect(protocol.CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.connectionCreate).toEqual({
            inputSchema: protocol.ConversationConnectionCreateInputV1JsonSchema,
            resultSchema: protocol.ConversationConnectionCreateResultV1JsonSchema,
        });
        expect(protocol.CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1.bindingRead).toEqual({
            inputSchema: protocol.ConversationBindingReadInputV1JsonSchema,
            resultSchema: protocol.ConversationBindingReadResultV1JsonSchema,
        });
        expect(protocol.CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1).toEqual({
            observationIngest: {
                inputSchema: protocol.ConversationProviderObservationIngestInputV1JsonSchema,
            },
            connectionsList: {
                inputSchema: protocol.ConversationProviderConnectionsListInputV1JsonSchema,
                resultSchema: protocol.ConversationProviderConnectionsListResultV1JsonSchema,
            },
            connectionRead: {
                inputSchema: protocol.ConversationProviderConnectionReadInputV1JsonSchema,
                resultSchema: protocol.ConversationProviderConnectionReadResultV1JsonSchema,
            },
            transportFactReport: {
                inputSchema: protocol.ConversationTransportFactReportInputV1JsonSchema,
                resultSchema: protocol.ConversationTransportFactReportResultV1JsonSchema,
            },
            automationResultDeliver: {
                inputSchema: AutomationResultDeliveryInputV1JsonSchema,
                resultSchema: AutomationResultDeliveryResultV1JsonSchema,
            },
        });
        expect(protocol.compareCanonicalConversationResolutionCandidatesV1(
            { id: '1', label: 'Ada' },
            { id: '2', label: 'Ada' },
        )).toBeLessThan(0);

        expect(protocol).not.toHaveProperty('ConversationEndpointDisplayLabelV1ProtocolSchema');
        expect(protocol).not.toHaveProperty('ConversationObservationV1ProtocolSchema');
        expect(protocol).not.toHaveProperty('ConversationConnectionPollRetryInputV1ProtocolSchema');
    });

    it('publishes the exact bounded JSON and Session-target types used by Channels consumers', () => {
        const recipe = {
            model: 'owner-approved',
            options: { retainHistory: true },
        } as const satisfies ChannelSessionSpawnRecipeV1;
        const jsonObject: ConversationJsonObjectV1 = recipe;
        const jsonValue: ConversationJsonValueV1 = jsonObject;
        const target = protocol.ConversationBindingTargetV1Schema.parse({
            kind: 'session',
            sessionId: 'session-1',
            policy: {
                deliveryMode: 'repliesOnly',
                permissionCeiling: 'read-only',
                approvals: { kind: 'off' },
                newSession: { kind: 'enabled', recipe },
            },
        });

        expect(jsonValue).toEqual(recipe);
        expect(target.kind).toBe('session');
        if (target.kind === 'session') {
            const sessionTarget: ConversationSessionBindingTargetV1 = target;
            expect(sessionTarget.policy.newSession).toEqual({ kind: 'enabled', recipe });
        }
    });
});
