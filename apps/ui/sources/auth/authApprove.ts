
import { encodeBase64 } from "../encryption/base64";
import { serverFetch } from '@/sync/http/client';

interface AuthRequestStatus {
    status: 'not_found' | 'pending' | 'authorized';
    supportsV2: boolean;
}

export async function authApprove(token: string, publicKey: Uint8Array, answerV1: Uint8Array, answerV2: Uint8Array) {
    const publicKeyBase64 = encodeBase64(publicKey);
    
    // First, check the auth request status
    const statusResponse = await serverFetch(`/v1/auth/request/status?publicKey=${encodeURIComponent(publicKeyBase64)}`, {
        method: 'GET',
    }, { includeAuth: false });
    if (!statusResponse.ok) {
        throw new Error(`Failed to check auth status: ${statusResponse.status}`);
    }
    const statusData = await statusResponse.json() as AuthRequestStatus;
    
    const { status, supportsV2 } = statusData;
    
    // Handle different status cases
    if (status === 'not_found') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized or not found');
        return;
    }
    
    if (status === 'authorized') {
        // Already authorized, no need to approve again
        console.log('Auth request already authorized');
        return;
    }
    
    // Handle pending status
    if (status === 'pending') {
        const response = await serverFetch('/v1/auth/response', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
            publicKey: publicKeyBase64,
            response: supportsV2 ? encodeBase64(answerV2) : encodeBase64(answerV1)
            }),
        }, { includeAuth: false });
        if (!response.ok) {
            throw new Error(`Failed to approve auth request: ${response.status}`);
        }
    }
}
