import { encodeBase64 } from "@/encryption/base64";
import { serverFetch } from '@/sync/http/client';

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
    supportsV2: boolean;
    supportsTokenOnly?: boolean;
}

export type AuthApproveResult = 'approved' | 'already_authorized' | 'not_found';

/** The relay accepted the request but no response payload the caller offered was compatible. */
export class AuthApproveUnsupportedResponseError extends Error {
    constructor() {
        super('Failed to approve auth request: no compatible response payload available');
        this.name = 'AuthApproveUnsupportedResponseError';
    }
}

type AuthApproveAnswer = Uint8Array | (() => Uint8Array);

export type AuthApproveOptions = Readonly<{
    /** Offered only to terminals that explicitly advertise the token-only response variant. */
    answerTokenOnly?: AuthApproveAnswer;
    /**
     * Address both requests at this exact relay instead of the focused one. `serverFetch` refuses
     * an authenticated request whose origin differs from the active server, so a caller holding a
     * target-scoped token (desktop setup approval) fails closed rather than posting that token to
     * whichever relay happens to be focused.
     */
    endpointUrl?: string;
}>;

function resolveAuthRequestPath(path: string, endpointUrl: string | undefined): string {
    const base = String(endpointUrl ?? '').trim().replace(/\/+$/, '');
    return base ? `${base}${path}` : path;
}

export async function authApprove(
    token: string,
    publicKey: Uint8Array,
    answerV1: AuthApproveAnswer,
    answerV2: AuthApproveAnswer,
    options: AuthApproveOptions = {},
): Promise<AuthApproveResult> {
    const publicKeyBase64 = encodeBase64(publicKey);
    
    // First, check the auth request status
    const statusResponse = await serverFetch(resolveAuthRequestPath(`/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`, options.endpointUrl), {
        method: 'GET',
    }, { includeAuth: false });
    if (!statusResponse.ok) {
        throw new Error(`Failed to check auth status: ${statusResponse.status}`);
    }
    const statusData = await statusResponse.json() as AuthRequestStatus;
    
    const { status, supportsV2 } = statusData;
    
    // Handle different status cases
    if (status === 'not_found') {
        return 'not_found';
    }
    
    if (status === 'authorized') {
        return 'already_authorized';
    }
    
    // Handle pending status
    if (status === 'pending') {
        const resolve = (value: AuthApproveAnswer): Uint8Array => {
            if (typeof value === 'function') {
                return value();
            }
            return value;
        };

        let responsePayload: Uint8Array | null = null;
        if (supportsV2 && statusData.supportsTokenOnly === true && options.answerTokenOnly) {
            const tokenOnly = resolve(options.answerTokenOnly);
            if (tokenOnly.length > 0) responsePayload = tokenOnly;
        }
        if (!responsePayload && supportsV2) {
            const v2 = resolve(answerV2);
            if (v2.length > 0) {
                responsePayload = v2;
            }
        }
        if (!responsePayload) {
            const v1 = resolve(answerV1);
            if (v1.length > 0) {
                responsePayload = v1;
            }
        }

        if (!responsePayload) {
            throw new AuthApproveUnsupportedResponseError();
        }

        const response = await serverFetch(resolveAuthRequestPath('/v1/auth/response', options.endpointUrl), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
            publicKey: publicKeyBase64,
            response: encodeBase64(responsePayload),
            }),
        }, { includeAuth: false });
        if (!response.ok) {
            throw new Error(`Failed to approve auth request: ${response.status}`);
        }
    }

    return 'approved';
}
