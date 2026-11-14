import { SignedProviderBrokerActionRouteGrantV3Schema, ProviderBrokerActionRouteGrantPayloadV3Schema, createProviderBrokerActionRouteGrantSigningInputV3, type SignedProviderBrokerActionRouteGrantV3 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { SignedProviderBrokerRouteGrantV1Schema, ProviderBrokerRouteGrantPayloadV1Schema, createProviderBrokerRouteGrantSigningInputV1, type SignedProviderBrokerRouteGrantV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import tweetnacl from 'tweetnacl';
import { signRouteGrantPayload } from './mintDirectRouteGrantV1';
import { SignedProviderBrokerRouteGrantV2Schema, createProviderBrokerRouteGrantSigningInputV2 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

/** Signs only a strict payload. The Home resource admission producer must derive
 * every identity and the carrier admission lifetime before calling this owner.
 * This function does not establish resource permission or select signing keys.
 */
export function signProviderBrokerRouteGrantV1(input: Readonly<{
    payload: unknown;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
}>): SignedProviderBrokerRouteGrantV1 {
    const payload = ProviderBrokerRouteGrantPayloadV1Schema.parse(input.payload);
    return SignedProviderBrokerRouteGrantV1Schema.parse({
        payload,
        signature: signRouteGrantPayload({
            signingInput: createProviderBrokerRouteGrantSigningInputV1(payload),
            signingKey: input.signingKey,
        }),
    });
}

type ProviderBrokerSignatureVerificationInput = Readonly<{
    authority: unknown;
    signingCapability: Readonly<{ keyId: string; publicKey: string; expiresAt: number | null }>;
    nowMs: number;
}>;

function verifyProviderBrokerSignature(input: Omit<ProviderBrokerSignatureVerificationInput, 'authority'> & Readonly<{
    signature: Readonly<{ keyId: string; valueBase64Url: string }>;
    signingInput: string;
}>): boolean {
    if (input.signature.keyId !== input.signingCapability.keyId
        || (input.signingCapability.expiresAt !== null && input.nowMs >= input.signingCapability.expiresAt)) return false;
    const publicKey = Buffer.from(input.signingCapability.publicKey, 'base64url');
    const signature = Buffer.from(input.signature.valueBase64Url, 'base64url');
    if (publicKey.length !== tweetnacl.sign.publicKeyLength || signature.length !== tweetnacl.sign.signatureLength) return false;
    return tweetnacl.sign.detached.verify(Buffer.from(input.signingInput), signature, publicKey);
}

/** Verifies each closed epoch through the same Home signature authority. */
export function verifyProviderBrokerRouteGrantSignatureV1(input: ProviderBrokerSignatureVerificationInput): boolean {
    const parsed = SignedProviderBrokerRouteGrantV1Schema.safeParse(input.authority);
    return parsed.success && verifyProviderBrokerSignature({ ...input, signature: parsed.data.signature,
        signingInput: createProviderBrokerRouteGrantSigningInputV1(parsed.data.payload) });
}

export function verifyProviderBrokerRouteGrantSignatureV2(input: ProviderBrokerSignatureVerificationInput): boolean {
    const parsed = SignedProviderBrokerRouteGrantV2Schema.safeParse(input.authority);
    return parsed.success && verifyProviderBrokerSignature({ ...input, signature: parsed.data.signature,
        signingInput: createProviderBrokerRouteGrantSigningInputV2(parsed.data.payload) });
}

export function signProviderBrokerActionRouteGrantV3(input: Readonly<{
    payload: unknown;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
}>): SignedProviderBrokerActionRouteGrantV3 {
    const payload = ProviderBrokerActionRouteGrantPayloadV3Schema.parse(input.payload);
    return SignedProviderBrokerActionRouteGrantV3Schema.parse({ payload, signature: signRouteGrantPayload({
        signingInput: createProviderBrokerActionRouteGrantSigningInputV3(payload), signingKey: input.signingKey,
    }) });
}

export function verifyProviderBrokerActionRouteGrantSignatureV3(input: ProviderBrokerSignatureVerificationInput): boolean {
    const parsed = SignedProviderBrokerActionRouteGrantV3Schema.safeParse(input.authority);
    return parsed.success && verifyProviderBrokerSignature({ ...input, signature: parsed.data.signature,
        signingInput: createProviderBrokerActionRouteGrantSigningInputV3(parsed.data.payload) });
}
