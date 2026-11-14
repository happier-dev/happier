import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import { ConversationDeliveryNewThreadV1Schema } from './delivery.js';
import { ConversationResolutionQueryV1ProtocolSchema, ConversationResolvedEndpointV1Schema } from './resolution.js';

/** Saved addressing only. Connection configuration and credentials remain with Channels. */
export const ConversationNotificationDestinationV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    endpoint: ConversationResolvedEndpointV1Schema,
    newThread: ConversationDeliveryNewThreadV1Schema.optional(),
}, { policy: 'closed' });
export type ConversationNotificationDestinationV1 = ReturnType<typeof ConversationNotificationDestinationV1Schema.parse>;

/** The Channels-owned picker returns saved addressing, never connection secrets. */
export const NOTIFICATION_DESTINATION_INPUT_TYPE_V1 = { pluginId: 'happier.channels', localId: 'notification-destination' } as const;
export const NotificationDestinationSelectionV1Schema = defineProtocolObject({
    channelId: defineProtocolString({ minLength: 1 }),
    destination: ConversationNotificationDestinationV1Schema.optional(),
}, { policy: 'closed' });

/** Resolution may read the provider; inspection only reads current connection configuration. Neither sends. */
export const ConversationNotificationDestinationSetupInputV1Schema = defineProtocolUnion([
    defineProtocolObject({ connectionId: ConversationConnectionIdV1ProtocolSchema,
        query: ConversationResolutionQueryV1ProtocolSchema }, { policy: 'closed' }),
    defineProtocolObject({ destination: ConversationNotificationDestinationV1Schema }, { policy: 'closed' }),
]);
export type ConversationNotificationDestinationSetupInputV1 = ReturnType<typeof ConversationNotificationDestinationSetupInputV1Schema.parse>;
export const ConversationNotificationDestinationSetupResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('resolved'),
        destinations: defineProtocolArray(ConversationNotificationDestinationV1Schema) }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('ready') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), reason: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' }),
]);
export type ConversationNotificationDestinationSetupResultV1 = ReturnType<typeof ConversationNotificationDestinationSetupResultV1Schema.parse>;
