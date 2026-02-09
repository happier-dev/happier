import { getRandomBytes } from '@/platform/cryptoRandom';
import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serverFetch } from '@/sync/http/client';

export interface QRAuthKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function generateAuthKeyPair(): QRAuthKeyPair {
    const secret = getRandomBytes(32);
    const keypair = sodium.crypto_box_seed_keypair(secret);
    return {
        publicKey: keypair.publicKey,
        secretKey: keypair.privateKey,
    };
}

export async function authQRStart(keypair: QRAuthKeyPair): Promise<boolean> {
    try {
        const serverUrl = getActiveServerSnapshot().serverUrl;
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log(`[AUTH DEBUG] Sending auth request to: ${serverUrl}/v1/auth/account/request`);
            console.log(`[AUTH DEBUG] Public key: ${encodeBase64(keypair.publicKey).substring(0, 20)}...`);
        }

        const response = await serverFetch('/v1/auth/account/request', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                publicKey: encodeBase64(keypair.publicKey),
            }),
        }, { includeAuth: false });
        if (!response.ok) {
            throw new Error(`Auth request failed: ${response.status}`);
        }

        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Auth request sent successfully');
        }
        return true;
    } catch (error) {
        if (process.env.EXPO_PUBLIC_DEBUG) {
            console.log('[AUTH DEBUG] Failed to send auth request:', error);
        }
        console.log('Failed to create authentication request, please try again later.');
        return false;
    }
}
