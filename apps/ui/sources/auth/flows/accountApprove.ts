import { encodeBase64 } from "@/encryption/base64";
import { serverFetch } from '@/sync/http/client';

export async function authAccountApprove(token: string, publicKey: Uint8Array, answer: Uint8Array) {
    const response = await serverFetch('/v1/auth/account/response', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            publicKey: encodeBase64(publicKey),
            response: encodeBase64(answer)
        }),
    }, { includeAuth: false });
    if (!response.ok) {
        throw new Error(`Failed to approve account auth request: ${response.status}`);
    }
}
