import { createHash } from "node:crypto";

const VOICE_PROVIDER_CONVERSATION_KEY_DOMAIN = "happier.voice.provider-conversation.v1\0";
const MAX_UINT32 = 0xffffffff;

export type VoiceProviderConversationIdentity = Readonly<{
    providerId: string;
    providerConversationId: string;
    providerConversationKey: string;
}>;

export class VoiceProviderConversationIdentityCollisionError extends Error {
    constructor() {
        super("voice_provider_conversation_identity_collision");
        this.name = "VoiceProviderConversationIdentityCollisionError";
    }
}

function encodeUint32BigEndian(value: number): Buffer {
    const encoded = Buffer.allocUnsafe(4);
    encoded.writeUInt32BE(value, 0);
    return encoded;
}

function encodeIdentityComponent(value: string): readonly [Buffer, Buffer] {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.byteLength > MAX_UINT32) {
        throw new RangeError("voice_provider_conversation_identity_component_too_large");
    }
    return [encodeUint32BigEndian(bytes.byteLength), bytes];
}

export function deriveVoiceProviderConversationKey(params: Readonly<{
    providerId: string;
    providerConversationId: string;
}>): string {
    const [providerIdLength, providerIdBytes] = encodeIdentityComponent(params.providerId);
    const [conversationIdLength, conversationIdBytes] = encodeIdentityComponent(params.providerConversationId);
    return createHash("sha256")
        .update(VOICE_PROVIDER_CONVERSATION_KEY_DOMAIN, "utf8")
        .update(providerIdLength)
        .update(providerIdBytes)
        .update(conversationIdLength)
        .update(conversationIdBytes)
        .digest("hex");
}

export function createVoiceProviderConversationIdentity(params: Readonly<{
    providerId: string;
    providerConversationId: string;
}>): VoiceProviderConversationIdentity {
    return {
        ...params,
        providerConversationKey: deriveVoiceProviderConversationKey(params),
    };
}

/**
 * Key lookups are never accepted without comparing the provider-issued raw values.
 * This keeps an improbable SHA-256 collision fail-closed instead of aliasing billing ownership.
 */
export function assertVoiceProviderConversationIdentityExactMatch(params: Readonly<{
    expected: VoiceProviderConversationIdentity;
    stored: VoiceProviderConversationIdentity;
}>): void {
    if (
        params.stored.providerConversationKey !== params.expected.providerConversationKey ||
        params.stored.providerId !== params.expected.providerId ||
        params.stored.providerConversationId !== params.expected.providerConversationId
    ) {
        throw new VoiceProviderConversationIdentityCollisionError();
    }
}
