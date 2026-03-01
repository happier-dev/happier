import { getRandomBytes } from '@/platform/cryptoRandom';
import sodium from '@/encryption/libsodium.lib';
import { encodeBase64 } from '@/encryption/base64';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { serverFetch } from '@/sync/http/client';
import { ServerFetchAbortedForServerSwitchError } from '@/sync/http/client';

const AUTH_QR_START_SERVER_SWITCH_ABORT_MAX_ATTEMPTS = 4;
const AUTH_QR_START_SERVER_SWITCH_ABORT_RETRY_DELAY_MS = 150;

async function delayMs(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const publicKey = encodeBase64(keypair.publicKey);
    const publicKeyPreview = publicKey.substring(0, 20);

    for (let attempt = 0; attempt < AUTH_QR_START_SERVER_SWITCH_ABORT_MAX_ATTEMPTS; attempt += 1) {
        try {
            const serverUrl = getActiveServerSnapshot().serverUrl;
            if (process.env.EXPO_PUBLIC_DEBUG) {
                console.log(`[AUTH DEBUG] Sending auth request to: ${serverUrl}/v1/auth/account/request`);
                console.log(`[AUTH DEBUG] Public key: ${publicKeyPreview}...`);
            }

            const response = await serverFetch(
                '/v1/auth/account/request',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        publicKey,
                    }),
                },
                { includeAuth: false },
            );
            if (!response.ok) {
                throw new Error(`Auth request failed: ${response.status}`);
            }

            if (process.env.EXPO_PUBLIC_DEBUG) {
                console.log('[AUTH DEBUG] Auth request sent successfully');
            }
            return true;
        } catch (error) {
            const shouldRetry =
                error instanceof ServerFetchAbortedForServerSwitchError
                && attempt < AUTH_QR_START_SERVER_SWITCH_ABORT_MAX_ATTEMPTS - 1;

            if (process.env.EXPO_PUBLIC_DEBUG) {
                console.log('[AUTH DEBUG] Failed to send auth request:', error);
            }

            if (!shouldRetry) {
                return false;
            }

            const retryDelayMs = AUTH_QR_START_SERVER_SWITCH_ABORT_RETRY_DELAY_MS * (attempt + 1);
            await delayMs(retryDelayMs);
        }
    }

    return false;
}
