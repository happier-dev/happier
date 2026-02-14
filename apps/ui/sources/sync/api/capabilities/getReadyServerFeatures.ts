import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

import { getCachedServerFeaturesSnapshot, getServerFeaturesSnapshot } from './serverFeaturesClient';

export async function getReadyServerFeatures(params?: {
    timeoutMs?: number;
    force?: boolean;
    serverId?: string;
}): Promise<ServerFeatures | null> {
    const snapshot = await getServerFeaturesSnapshot({
        timeoutMs: params?.timeoutMs,
        force: params?.force,
        serverId: params?.serverId,
    });
    return snapshot.status === 'ready' ? snapshot.features : null;
}

export function getCachedReadyServerFeatures(params?: { serverId?: string }): ServerFeatures | null {
    const cached = getCachedServerFeaturesSnapshot({ serverId: params?.serverId });
    return cached?.status === 'ready' ? cached.features : null;
}

