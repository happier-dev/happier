import {
    AutomationResultDeliveryInputV1JsonSchema,
    AutomationResultDeliveryResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/automations';
import type { ConversationCoreProviderActionDeclarationsV1 } from '../actionDeclarations.js';

import {
    ConversationProviderConnectionReadInputV1JsonSchema,
    ConversationProviderConnectionReadResultV1JsonSchema,
    ConversationProviderConnectionsListInputV1JsonSchema,
    ConversationProviderConnectionsListResultV1JsonSchema,
} from '../provider/connection.js';
import {
    ConversationProviderObservationIngestInputV1JsonSchema,
} from './ingress.js';
import {
    ConversationTransportFactReportInputV1JsonSchema,
    ConversationTransportFactReportResultV1JsonSchema,
} from './transportFacts.js';

/**
 * Schema declarations for the finite core Actions that provider callers may
 * invoke. The Channels manifest owns Action id, surface, and danger facts;
 * this protocol projection owns only their exact input/result contracts.
 */
export const CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1: ConversationCoreProviderActionDeclarationsV1 = Object.freeze({
    observationIngest: Object.freeze({
        inputSchema: ConversationProviderObservationIngestInputV1JsonSchema,
    }),
    connectionsList: Object.freeze({
        inputSchema: ConversationProviderConnectionsListInputV1JsonSchema,
        resultSchema: ConversationProviderConnectionsListResultV1JsonSchema,
    }),
    connectionRead: Object.freeze({
        inputSchema: ConversationProviderConnectionReadInputV1JsonSchema,
        resultSchema: ConversationProviderConnectionReadResultV1JsonSchema,
    }),
    transportFactReport: Object.freeze({
        inputSchema: ConversationTransportFactReportInputV1JsonSchema,
        resultSchema: ConversationTransportFactReportResultV1JsonSchema,
    }),
    automationResultDeliver: Object.freeze({
        inputSchema: AutomationResultDeliveryInputV1JsonSchema,
        resultSchema: AutomationResultDeliveryResultV1JsonSchema,
    }),
});
