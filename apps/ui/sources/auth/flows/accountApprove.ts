import { encodeBase64 } from "@/encryption/base64";
import { serverFetch } from '@/sync/http/client';
import { HappyError } from '@/utils/errors/errors';

const ACCOUNT_LINK_REQUEST_NOT_FOUND = 'account_link_request_not_found';

export function getAccountApproveErrorMessageKey(error: unknown): 'modals.deviceLinkRequestNotFound' | null {
    return error instanceof HappyError && error.code === ACCOUNT_LINK_REQUEST_NOT_FOUND
        ? 'modals.deviceLinkRequestNotFound'
        : null;
}

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
        if (response.status === 404) {
            throw new HappyError('Account linking request not found', false, {
                status: response.status,
                code: ACCOUNT_LINK_REQUEST_NOT_FOUND,
            });
        }
        throw new Error(`Failed to approve account auth request: ${response.status}`);
    }
}
