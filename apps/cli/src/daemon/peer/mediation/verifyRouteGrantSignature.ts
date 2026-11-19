import { ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS } from '@happier-dev/protocol';
import tweetnacl from 'tweetnacl';

export type DirectRouteGrantTrustRoot = Readonly<{
    keyId: string;
    publicKey: string;
    expiresAt?: number | null;
}>;

export function isRouteGrantIssuedTooFarInFuture(issuedAtMs: number, nowMs: number): boolean {
    return issuedAtMs > nowMs + ACCOUNT_DIRECTORY_ASSERTION_CLOCK_SKEW_MS;
}

export function decodeRouteGrantBase64Url(value: string): Uint8Array | null {
    try {
        return Buffer.from(value, 'base64url');
    } catch {
        return null;
    }
}

export function findRouteGrantTrustRoot(
    roots: readonly DirectRouteGrantTrustRoot[],
    keyId: string,
    nowMs: number,
): Uint8Array | null {
    const root = roots.find((entry) => entry.keyId === keyId);
    if (!root || (root.expiresAt != null && nowMs >= root.expiresAt)) return null;
    const publicKey = decodeRouteGrantBase64Url(root.publicKey);
    if (!publicKey || publicKey.length !== tweetnacl.sign.publicKeyLength) return null;
    return publicKey;
}

/** Shared Ed25519 verification; callers own their strict payload and authority checks. */
export function verifyRouteGrantSignature(input: Readonly<{
    signingInput: string;
    signatureBase64Url: string;
    publicKey: Uint8Array;
}>): boolean {
    const signature = decodeRouteGrantBase64Url(input.signatureBase64Url);
    return signature !== null && signature.length === tweetnacl.sign.signatureLength
        && tweetnacl.sign.detached.verify(Buffer.from(input.signingInput, 'utf8'), signature, input.publicKey);
}
