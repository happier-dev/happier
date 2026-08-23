import { jwtVerify, SignJWT } from 'jose';
import type { Bytes } from '../../types';
import {
    deriveTokenKeyMaterial,
    importEd25519PrivateJwk,
    importEd25519PublicJwk,
} from './tokenKey';

export async function createEphemeralTokenGenerator(opts: {
    service: string,
    seed: string,
    ttl: number
}) {

    const keyMaterial = await deriveTokenKeyMaterial({
        service: opts.service,
        seed: opts.seed,
        lifetime: 'Ephemeral',
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
                .setExpirationTime(Math.ceil((Date.now() + opts.ttl) / 1000))
                .setIssuer(opts.service)
                .setJti(crypto.randomUUID())
                .sign(key);
            return signed;
        },
        publicKey: keyMaterial.publicKey
    };
}

export async function createEphemeralTokenVerifier(opts: {
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

export const ephemeralToken = {
    generator: createEphemeralTokenGenerator,
    verifier: createEphemeralTokenVerifier
}
