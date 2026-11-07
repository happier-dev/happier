import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolLiteral,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

import {
    ConversationBindingIdV1ProtocolSchema,
    ConversationCollectionRowRevisionV1ProtocolSchema,
} from '../identity.js';
import type { ConversationActionDeclarationV1 } from '../actionDeclarations.js';

/** One exact Account Collection row revision witness; see its Protocol owner. */
const collectionRowRevision = ConversationCollectionRowRevisionV1ProtocolSchema;

export const ConversationSessionProjectionNoticeDismissInputV1Schema = defineProtocolObject({
    bindingId: ConversationBindingIdV1ProtocolSchema,
    expectedBindingRevision: collectionRowRevision,
    expectedFrontierRevision: collectionRowRevision,
}, { policy: 'closed' });
export type ConversationSessionProjectionNoticeDismissInputV1 = ReturnType<
    typeof ConversationSessionProjectionNoticeDismissInputV1Schema.parse
>;
export const ConversationSessionProjectionNoticeDismissInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationSessionProjectionNoticeDismissInputV1Schema.jsonSchema)();

export const ConversationSessionProjectionNoticeDismissResultV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('noticeDismissed'),
    bindingId: ConversationBindingIdV1ProtocolSchema,
    bindingRevision: collectionRowRevision,
    frontierRevision: collectionRowRevision,
}, { policy: 'closed' });
export type ConversationSessionProjectionNoticeDismissResultV1 = ReturnType<
    typeof ConversationSessionProjectionNoticeDismissResultV1Schema.parse
>;
export const ConversationSessionProjectionNoticeDismissResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationSessionProjectionNoticeDismissResultV1Schema.jsonSchema)();

export const ConversationSessionProjectionNoticeDismissManagementActionDeclarationV1:
    ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationSessionProjectionNoticeDismissInputV1JsonSchema,
    resultSchema: ConversationSessionProjectionNoticeDismissResultV1JsonSchema,
});
