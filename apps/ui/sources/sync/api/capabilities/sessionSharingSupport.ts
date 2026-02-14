import { getReadyServerFeatures } from './getReadyServerFeatures';

export async function isSessionSharingSupported(params?: { timeoutMs?: number; serverId?: string }): Promise<boolean> {
    const features = await getReadyServerFeatures({ timeoutMs: params?.timeoutMs, serverId: params?.serverId });
    return features?.features?.sharing?.session?.enabled === true;
}

