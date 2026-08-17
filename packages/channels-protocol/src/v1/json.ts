import type {
    ProtocolJsonValue,
} from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolJsonValue,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_CONVERSATION_CHECKPOINT_UTF8_BYTES,
    MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES,
} from './bounds.js';

/**
 * The public Channels wire projection for opaque provider-owned JSON values.
 * The SDK remains the sole owner of strict JSON acceptance, copying, and its
 * ordinary-JSON structural rules; this declaration prevents that
 * private implementation type from leaking through our public declarations.
 */
export type ConversationJsonValueV1 = ProtocolJsonValue;

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationJsonValueV1ProtocolSchema =
    defineProtocolJsonValue<ConversationJsonValueV1>();

/** @internal One feature-owned aggregate-byte JSON leaf for every provider-config carrier. */
export const ConversationProviderConfigV1ProtocolSchema =
    defineProtocolJsonValue<ConversationJsonValueV1>({
        maxSerializedUtf8Bytes: MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES,
    });

/** @internal One feature-owned aggregate-byte JSON leaf for every checkpoint carrier. */
export const ConversationCheckpointV1ProtocolSchema =
    defineProtocolJsonValue<ConversationJsonValueV1>({
        maxSerializedUtf8Bytes: MAX_CONVERSATION_CHECKPOINT_UTF8_BYTES,
    });
export type ConversationJsonObjectV1 = Readonly<Record<string, ConversationJsonValueV1>>;

/** @internal Relative-only schema for a JSON object with canonical JSON leaves. */
export const ConversationJsonObjectV1ProtocolSchema = defineProtocolObject(
    {},
    {
        policy: 'additive-open/preserve',
        additionalProperties: ConversationJsonValueV1ProtocolSchema,
    },
);
