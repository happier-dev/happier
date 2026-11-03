import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageSourceEntryLocalRefV1Schema, TriageTextV1ProtocolSchema, TriageEntryLocatorV1Schema } from './identity.js';
import {
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    TriageConfiguredSourceCredentialInstanceV1Schema,
    TriageConfiguredSourceInstanceV1Schema,
} from './instances.js';

function linkInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1),
        instance,
        localRef: TriageSourceEntryLocalRefV1Schema,
        sessionId: SessionIdSchema,
        linked: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
    }, { policy: 'closed' });
}

function readInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1),
        instance,
        localRef: TriageSourceEntryLocalRefV1Schema.optional(),
        sessionId: SessionIdSchema.optional(),
    }, { policy: 'closed' });
}

/** Source-owned relationships stay within the invocation's current Account and Home. */
export const TriageSourceLinkSessionInputV1Schema = linkInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageSourceLinkSessionConnectedAccountInputV1Schema = linkInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageSourceReadSessionLinksInputV1Schema = readInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageSourceReadSessionLinksConnectedAccountInputV1Schema = readInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageSourceLinkSessionCredentialInputV1Schema = linkInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export const TriageSourceReadSessionLinksCredentialInputV1Schema = readInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export type TriageSourceLinkSessionInputV1 = ReturnType<typeof TriageSourceLinkSessionInputV1Schema.parse>;
export type TriageSourceReadSessionLinksInputV1 = ReturnType<typeof TriageSourceReadSessionLinksInputV1Schema.parse>;

export const TriageSourceLinkSessionResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ status: defineProtocolLiteral('linked') }, { policy: 'closed' }),
    defineProtocolObject({ status: defineProtocolLiteral('unlinked') }, { policy: 'closed' }),
    defineProtocolObject({ status: defineProtocolLiteral('failed') }, { policy: 'closed' }),
]);
export type TriageSourceLinkSessionResultV1 = ReturnType<typeof TriageSourceLinkSessionResultV1Schema.parse>;

const sourceSessionLinks = defineProtocolArray(defineProtocolObject({
    localRef: TriageSourceEntryLocalRefV1Schema,
    sessionId: SessionIdSchema,
    linkedAtMs: defineProtocolNumber({ integer: true }),
    displayPath: TriageTextV1ProtocolSchema,
    locator: TriageEntryLocatorV1Schema.optional(),
}, { policy: 'closed' }));

export const TriageSourceReadSessionLinksResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('complete'), links: sourceSessionLinks }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('partial'), links: sourceSessionLinks,
        /** Only these entries are unreadable; omission elsewhere establishes absence. */
        unavailableRefs: defineProtocolArray(TriageSourceEntryLocalRefV1Schema, { minItems: 1 }),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type TriageSourceReadSessionLinksResultV1 = ReturnType<typeof TriageSourceReadSessionLinksResultV1Schema.parse>;
