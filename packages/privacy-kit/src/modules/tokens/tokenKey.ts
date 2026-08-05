import { ed25519 } from '@noble/curves/ed25519';
import * as jose from 'jose';

import { deriveSecureKey } from '../crypto/deriveSecureKey';
import { encodeBase64 } from '../formats/base64';
import type { Bytes } from '../../types';

interface TokenKeyMaterial {
    privateKey: Bytes;
    publicKey: Bytes;
}

export async function deriveTokenKeyMaterial(opts: {
    service: string;
    seed: string;
    lifetime: 'Ephemeral' | 'Persistent';
}): Promise<TokenKeyMaterial> {
    const privateKey = (await deriveSecureKey({
        key: opts.seed,
        usage: `${opts.service} ${opts.lifetime} Token`,
    })).subarray(0, 32);

    return {
        privateKey,
        publicKey: Uint8Array.from(ed25519.getPublicKey(privateKey)) as Bytes,
    };
}

export async function importEd25519PrivateJwk(keyMaterial: TokenKeyMaterial) {
    return await jose.importJWK({
        kty: 'OKP',
        crv: 'Ed25519',
        d: jose.base64url.encode(keyMaterial.privateKey),
        x: jose.base64url.encode(keyMaterial.publicKey),
        alg: 'EdDSA',
    }, 'EdDSA');
}

export async function importEd25519PublicJwk(publicKey: Bytes) {
    return await jose.importJWK({
        kty: 'OKP',
        crv: 'Ed25519',
        x: jose.base64url.encode(publicKey),
        alg: 'EdDSA',
    }, 'EdDSA');
}

/**
 * Reproduces the private-JWK acceptance rule used by Bun 1.3.5 when
 * privacy-kit encoded Ed25519 JWK fields with standard Base64.
 *
 * Bun decoded only `d` for this private import. privacy-kit 0.0.25 already
 * encoded the separate verifier's `x` field as Base64URL, so legacy server
 * initialization depended only on `d`. Keep this predicate limited to
 * historical key lookup; new JWKs always use canonical Base64URL encoding.
 */
export function wasLegacyBunStandardBase64PrivateJwkAccepted(privateKey: Bytes): boolean {
    return !/[+/]/.test(encodeBase64(privateKey));
}
