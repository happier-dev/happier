import type { CreateSessionShareRequest, ShareAccessLevel } from '@/sync/domains/social/sharingTypes';

export function buildCreateSessionShareRequest(params: {
    sessionEncryptionMode: 'e2ee' | 'plain' | undefined;
    userId: string;
    accessLevel: ShareAccessLevel;
    canApprovePermissions?: boolean;
    encryptedDataKey?: string;
}): CreateSessionShareRequest {
    const { sessionEncryptionMode, userId, accessLevel, canApprovePermissions } = params;

    const base: CreateSessionShareRequest = {
        userId,
        accessLevel,
        ...(canApprovePermissions !== undefined ? { canApprovePermissions } : {}),
    };

    if (sessionEncryptionMode === 'plain') {
        return base;
    }

    const encryptedDataKey = params.encryptedDataKey;
    if (typeof encryptedDataKey !== 'string' || encryptedDataKey.length === 0) {
        throw new Error('encryptedDataKey required');
    }
    return { ...base, encryptedDataKey };
}

