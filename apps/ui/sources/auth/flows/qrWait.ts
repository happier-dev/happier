import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { QRAuthKeyPair } from './qrStart';
import { decryptBox } from '@/encryption/libsodium';
import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { delay } from '@/utils/timing/time';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';

export type { AuthCredentials } from '@/auth/storage/tokenStorage';

export async function authQRWait(keypair: QRAuthKeyPair, onProgress?: (dots: number) => void, shouldCancel?: () => boolean): Promise<AuthCredentials | null> {
    let dots = 0;

    type Requested = { state: 'requested' };
    type AuthorizedV1 = { state: 'authorized'; token: string; response: string; serverIdentityId?: string | null };
    type AuthorizedV2 = { state: 'authorized'; tokenEncrypted: string; response: string; serverIdentityId?: string | null };
    type AuthPollResponse = Requested | AuthorizedV1 | AuthorizedV2;

    while (true) {
        if (shouldCancel && shouldCancel()) {
            return null;
        }

        if (!isRuntimeActive()) {
            await delay(1000);
            continue;
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

                if (data.serverIdentityId) {
                    // Direct QR responses predate HomeConnectionDescriptorV1 and only carry
                    // the Home identity. Converge them through the canonical adoption owner by
                    // binding that identity to the currently connected stable HTTPS origin.
                    const active = getActiveServerSnapshot();
                    const canonicalServerUrl = active.canonicalServerUrl ?? active.serverUrl;
                    try {
                        await adoptHomeProfile({
                            descriptor: {
                                v: 1,
                                homeServerIdentityId: data.serverIdentityId,
                                canonicalServerUrl,
                                revision: 1,
                                endpoints: [{ kind: 'https', url: canonicalServerUrl }],
                            },
                            source: 'qr',
                            preserveUserLabel: true,
                        });
                    } catch {
                        // Identity conflicts fail closed; do not return credentials for an
                        // ambiguous Home association.
                        return null;
                    }
                }

                const encryptedResponse = decodeBase64(data.response);
                const decrypted = decryptBox(encryptedResponse, keypair.secretKey);
                if (decrypted) {
                    const text = new TextDecoder().decode(decrypted);
                    try {
                        const material = JSON.parse(text) as {
                            type?: unknown;
                            publicKey?: unknown;
                            machineKey?: unknown;
                        };
                        if (material.type === 'tokenOnly') return { token };
                        if (
                            material.type === 'dataKey'
                            && typeof material.publicKey === 'string'
                            && typeof material.machineKey === 'string'
                        ) {
                            return {
                                token,
                                encryption: {
                                    publicKey: material.publicKey,
                                    machineKey: material.machineKey,
                                },
                            };
                        }
                    } catch {
                        // Released V1 readers carry raw legacy secret bytes.
                    }
                    return { secret: encodeBase64(decrypted, 'base64url'), token };
                }
                return null;
            }
        } catch (error) {
            // Polling is long-lived; transient transport failures must not discard
            // an otherwise valid pairing. Malformed/cryptographically invalid
            // responses remain terminal and fail closed.
            const message = error instanceof Error ? error.message : String(error);
            if (!/network|fetch|timeout|aborted|temporar|connection|\b5\d\d\b/i.test(message)) {
                return null;
            }
        }

        // Call progress callback if provided
        if (onProgress) {
            onProgress(dots);
        }
        dots++;

        // Wait 1 second before next check
        await delay(1000);
    }
}
