import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { QRAuthKeyPair } from './qrStart';
import { decryptBox } from '@/encryption/libsodium';
import { serverFetch } from '@/sync/http/client';

export interface AuthCredentials {
    secret: Uint8Array;
    token: string;
}

export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthCredentials | null> {
    let dots = 0;

    type Requested = { state: 'requested' };
    type AuthorizedV1 = { state: 'authorized'; token: string; response: string };
    type AuthorizedV2 = { state: 'authorized'; tokenEncrypted: string; response: string };
    type AuthPollResponse = Requested | AuthorizedV1 | AuthorizedV2;

    while (true) {
        if (shouldCancel && shouldCancel()) {
            return null;
        }

        try {
            let response = await serverFetch('/v2/auth/account/request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    publicKey: encodeBase64(keypair.publicKey),
                }),
            }, { includeAuth: false });
            if (response.status === 404) {
                response = await serverFetch('/v1/auth/account/request', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        publicKey: encodeBase64(keypair.publicKey),
                    }),
                }, { includeAuth: false });
            }
            if (!response.ok) {
                throw new Error(`Failed to poll auth request: ${response.status}`);
            }
            const data = await response.json() as AuthPollResponse;

            if (data.state === 'authorized') {
                const token =
                    'tokenEncrypted' in data
                        ? (() => {
                            const tokenEncrypted = decodeBase64(data.tokenEncrypted);
                            const decryptedTokenBytes = decryptBox(tokenEncrypted, keypair.secretKey);
                            if (!decryptedTokenBytes) {
                                return null;
                            }
                            return new TextDecoder().decode(decryptedTokenBytes);
                        })()
                        : data.token;
                if (!token) {
                    return null;
                }

                const encryptedResponse = decodeBase64(data.response);
                
                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (decrypted) {
                    return {
                        secret: decrypted,
                        token: token
                    };
                }
                return null;
            }
        } catch (error) {
            return null;
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        // Wait 1 second before next check
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
