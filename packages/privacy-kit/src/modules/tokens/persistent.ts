import { jwtVerify, SignJWT } from 'jose';
import type { Bytes } from '../../types';
import {
    deriveTokenKeyMaterial,
    importEd25519PrivateJwk,
    importEd25519PublicJwk,
    wasLegacyBunStandardBase64PrivateJwkAccepted,
} from './tokenKey';

export async function createPersistentTokenGenerator(opts: {
    service: string,
    seed: string
}) {

    const keyMaterial = await deriveTokenKeyMaterial({
        service: opts.service,
        seed: opts.seed,
        lifetime: 'Persistent',
    });
    const key = await importEd25519PrivateJwk(keyMaterial);

    // Create token
    return {
        new: async (d: {
            user?: string,
            extras?: Record<string, unknown>
        }) => {
            const signed = await new SignJWT({ sub: d.user, ...d.extras })
                .setProtectedHeader({ alg: 'EdDSA' })
                .setIssuedAt()
                .setNotBefore('0s')
                .setIssuer(opts.service)
                .setJti(crypto.randomUUID())
                .sign(key);
            return signed;
        },
        publicKey: keyMaterial.publicKey
    };
}

/**
 * Finds the public key selected by privacy-kit 0.0.25's standard-Base64 JWK
 * import under Bun 1.3.5. This is a read-only compatibility path for tokens
 * already issued by that implementation; it must never select a new signer.
 */
export async function resolveLegacyBunStandardBase64PersistentTokenPublicKey(opts: {
    service: string;
    seedCandidates: readonly string[];
}): Promise<{ candidateIndex: number; publicKey: Bytes } | null> {
    for (let candidateIndex = 0; candidateIndex < opts.seedCandidates.length; candidateIndex += 1) {
        const seed = opts.seedCandidates[candidateIndex];
        if (seed === undefined) {
            continue;
        }
        const keyMaterial = await deriveTokenKeyMaterial({
            service: opts.service,
            seed,
            lifetime: 'Persistent',
        });
        if (wasLegacyBunStandardBase64PrivateJwkAccepted(keyMaterial.privateKey)) {
            return { candidateIndex, publicKey: keyMaterial.publicKey };
        }
    }

    return null;
}

export async function createPersistentTokenVerifier(opts: {
    service: string,
    publicKey: Bytes
}) {

    const key = await importEd25519PublicJwk(opts.publicKey);

    return {
        verify: async (token: string) => {
            try {
                const { payload } = await jwtVerify(token, key);
                if (payload.iss !== opts.service) {
                    return null;
                }
                const { iss, sub, aud, jti, nbf, exp, iat, ...extras } = payload;
                return {
                    user: sub ?? null,
                    uuid: jti ?? null,
                    extras: extras ?? {}
                }
            } catch (e) {
                return null;
            }
        }
    }
}

export const persistentToken = {
    generator: createPersistentTokenGenerator,
    verifier: createPersistentTokenVerifier
}
