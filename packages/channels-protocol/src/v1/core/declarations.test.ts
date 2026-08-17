import { describe, expect, it } from 'vitest';

import {
    CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1,
} from './declarations.js';
import {
    CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
} from '../bounds.js';
import {
    ConversationProviderObservationIngestInputV1JsonSchema,
} from './ingress.js';
import {
    ConversationTransportFactReportInputV1JsonSchema,
    ConversationTransportFactReportResultV1JsonSchema,
} from './transportFacts.js';
import {
    ConversationProviderConnectionReadInputV1JsonSchema,
    ConversationProviderConnectionReadResultV1JsonSchema,
    ConversationProviderConnectionsListInputV1JsonSchema,
    ConversationProviderConnectionsListResultV1JsonSchema,
} from '../provider/connection.js';
import {
    AutomationResultDeliveryInputV1JsonSchema,
    AutomationResultDeliveryResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/automations';

describe('Channels V1 core provider Action declarations', () => {
    it('maps every provider-facing core Action exactly once to its canonical V1 schema contracts', () => {
        expect(CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1).toEqual({
            observationIngest: {
                inputSchema: ConversationProviderObservationIngestInputV1JsonSchema,
            },
            connectionsList: {
                inputSchema: ConversationProviderConnectionsListInputV1JsonSchema,
                resultSchema: ConversationProviderConnectionsListResultV1JsonSchema,
            },
            connectionRead: {
                inputSchema: ConversationProviderConnectionReadInputV1JsonSchema,
                resultSchema: ConversationProviderConnectionReadResultV1JsonSchema,
            },
            transportFactReport: {
                inputSchema: ConversationTransportFactReportInputV1JsonSchema,
                resultSchema: ConversationTransportFactReportResultV1JsonSchema,
            },
            automationResultDeliver: {
                inputSchema: AutomationResultDeliveryInputV1JsonSchema,
                resultSchema: AutomationResultDeliveryResultV1JsonSchema,
            },
        });
        expect(Object.keys(CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1).sort()).toEqual(
            Object.keys(CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1).sort(),
        );
        expect(new Set(Object.values(CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1)).size).toBe(
            Object.keys(CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1).length,
        );
    });
});
