import {
    SignedProviderBrokerRouteGrantV1Schema,
    ProviderBrokerRouteGrantPayloadV1Schema,
    createProviderBrokerRouteGrantSigningInputV1,
    type SignedProviderBrokerRouteGrantV1,
} from '@happier-dev/protocol';
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

/** Verifies the strict broker envelope against the current Home signing root. */
export function verifyProviderBrokerRouteGrantSignatureV1(input: Readonly<{
    authority: unknown;
    signingCapability: Readonly<{ keyId: string; publicKey: string; expiresAt: number | null }>;
    nowMs: number;
}>): boolean {
    const authority = SignedProviderBrokerRouteGrantV1Schema.safeParse(input.authority);
    if (!authority.success
        || authority.data.signature.keyId !== input.signingCapability.keyId
        || (input.signingCapability.expiresAt !== null && input.nowMs >= input.signingCapability.expiresAt)) return false;
    let publicKey: Uint8Array;
    let signature: Uint8Array;
    try {
        publicKey = Buffer.from(input.signingCapability.publicKey, 'base64url');
        signature = Buffer.from(authority.data.signature.valueBase64Url, 'base64url');
    } catch {
        return false;
    }
    if (publicKey.length !== tweetnacl.sign.publicKeyLength || signature.length !== tweetnacl.sign.signatureLength) {
        return false;
    }
    return tweetnacl.sign.detached.verify(
        Buffer.from(createProviderBrokerRouteGrantSigningInputV1(authority.data.payload)),
        signature,
        publicKey,
    );
}

export function verifyProviderBrokerRouteGrantSignatureV2(input: Parameters<typeof verifyProviderBrokerRouteGrantSignatureV1>[0]): boolean {
    const authority = SignedProviderBrokerRouteGrantV2Schema.safeParse(input.authority);
    if (!authority.success || authority.data.signature.keyId !== input.signingCapability.keyId
        || (input.signingCapability.expiresAt !== null && input.nowMs >= input.signingCapability.expiresAt)) return false;
    const publicKey = Buffer.from(input.signingCapability.publicKey, 'base64url');
    const signature = Buffer.from(authority.data.signature.valueBase64Url, 'base64url');
    if (publicKey.length !== tweetnacl.sign.publicKeyLength || signature.length !== tweetnacl.sign.signatureLength) return false;
    return tweetnacl.sign.detached.verify(Buffer.from(createProviderBrokerRouteGrantSigningInputV2(authority.data.payload)), signature, publicKey);
}
