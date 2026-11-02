import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    encodeBase64,
    decodeBase64,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import { ConversationProviderConnectionInputV1Fields } from './connection.js';

/** One portable encoding for provider-native references; no paths, URLs or bytes in observations. */
export function createConversationAttachmentIdV1(providerId: string, parts: readonly (string | number | null)[]): string {
    return `${providerId}-file:v1:${encodeBase64(new TextEncoder().encode(JSON.stringify(parts)), 'base64url')}`;
}

export function readConversationAttachmentIdV1(value: string, providerId: string): readonly (string | number | null)[] | null {
    const prefix = `${providerId}-file:v1:`;
    if (!value.startsWith(prefix)) return null;
    const encoded = value.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
        const bytes = decodeBase64(encoded, 'base64url');
        if (encodeBase64(bytes, 'base64url') !== encoded) return null;
        const parts: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return Array.isArray(parts) && parts.every(part => part === null || typeof part === 'string'
            || (typeof part === 'number' && Number.isSafeInteger(part))) ? parts : null;
    } catch { return null; }
}

/**
 * dd247000f8 changed Email's slash-joined MIME part paths to the portable
 * codec without changing native identity. Retained censuses (including keyed
 * replay digests) and pending inputs can contain either representation.
 * Keep the part sequence exact; never alias arbitrary provider-native refs.
 */
export function getConversationAttachmentIdRepresentationsV1(value: string): readonly [string, ...string[]] {
    const decoded = readConversationAttachmentIdV1(value, 'email');
    const parts = decoded ?? value.split('/');
    if (parts.length === 0 || !parts.every((part): part is string =>
        typeof part === 'string' && /^mime:[0-9]+(?:\.[0-9]+)*$/.test(part))) return [value];
    return [createConversationAttachmentIdV1('email', parts), parts.join('/')];
}

/** The existing fetch wire carries padded base64, independently of descriptor identities. */
export function encodeConversationAttachmentBytesV1(bytes: Uint8Array): string {
    return encodeBase64(bytes);
}

/** Provider-local immutable file identity; observations never carry file bytes or paths. */
export const ConversationMessageAttachmentV1Schema = defineProtocolObject({
    attachmentId: defineProtocolString({ minLength: 1 }),
    name: defineProtocolString({ minLength: 1 }),
    mediaType: defineProtocolString({ minLength: 1 }),
    byteLength: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }).optional(),
}, { policy: 'closed' });
export type ConversationMessageAttachmentV1 = ReturnType<typeof ConversationMessageAttachmentV1Schema.parse>;
export const ConversationMessageAttachmentV1JsonSchema = /* @__PURE__ */ (() => ConversationMessageAttachmentV1Schema.jsonSchema)();

/** One consuming operation fetches its referenced files from one admitted message. */
export const ConversationAttachmentFetchInputV1Schema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    messageId: defineProtocolString({ minLength: 1 }),
    attachmentIds: defineProtocolArray(defineProtocolString({ minLength: 1 }), { minItems: 1 }),
}, { policy: 'closed' });
export type ConversationAttachmentFetchInputV1 = ReturnType<typeof ConversationAttachmentFetchInputV1Schema.parse>;
export const ConversationAttachmentFetchInputV1JsonSchema = /* @__PURE__ */ (() => ConversationAttachmentFetchInputV1Schema.jsonSchema)();

/** Live bytes only: the consumer owns temporary files until Session transfer completes. */
export const ConversationAttachmentFetchResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('fetched'),
        attachments: defineProtocolArray(defineProtocolObject({
            attachmentId: defineProtocolString({ minLength: 1 }),
            base64: defineProtocolString(),
        }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    ConversationProviderFailureV1ProtocolSchema,
]);
export type ConversationAttachmentFetchResultV1 = ReturnType<typeof ConversationAttachmentFetchResultV1Schema.parse>;
export const ConversationAttachmentFetchResultV1JsonSchema = /* @__PURE__ */ (() => ConversationAttachmentFetchResultV1Schema.jsonSchema)();
