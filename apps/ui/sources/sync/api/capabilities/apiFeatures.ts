import { serverFetch } from '@/sync/http/client';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { FeaturesResponseSchema, type FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

type CacheEntry = { value: ServerFeatures | null; at: number };
const cachedByServerId = new Map<string, CacheEntry>();

function parseServerFeatures(raw: unknown): ServerFeatures | null {
    const parsed = FeaturesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export async function getServerFeatures(params?: { timeoutMs?: number; force?: boolean }): Promise<ServerFeatures | null> {
    const force = params?.force ?? false;
    const timeoutMs = params?.timeoutMs ?? 800;
    const snapshot = getActiveServerSnapshot();
    const cacheKey = snapshot.serverId;

    if (!force) {
        const cached = cachedByServerId.get(cacheKey) ?? null;
        // Cache for 10 minutes.
        if (cached && Date.now() - cached.at < 10 * 60 * 1000) {
            return cached.value;
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await serverFetch('/v1/features', {
            method: 'GET',
            signal: controller.signal,
        }, { includeAuth: false });

        if (!response.ok) {
            cachedByServerId.set(cacheKey, { value: null, at: Date.now() });
            return null;
        }

        const json = await response.json();
        const parsed = parseServerFeatures(json);
        cachedByServerId.set(cacheKey, { value: parsed, at: Date.now() });
        return parsed;
    } catch {
        cachedByServerId.set(cacheKey, { value: null, at: Date.now() });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function getCachedServerFeatures(): ServerFeatures | null {
    const snapshot = getActiveServerSnapshot();
    const cached = cachedByServerId.get(snapshot.serverId) ?? null;
    return cached?.value ?? null;
}

export async function isSessionSharingSupported(params?: { timeoutMs?: number }): Promise<boolean> {
    const features = await getServerFeatures({ timeoutMs: params?.timeoutMs });
    return features?.features?.sharing?.session?.enabled === true;
}

export async function isHappierVoiceSupported(params?: { timeoutMs?: number }): Promise<boolean> {
    const features = await getServerFeatures({ timeoutMs: params?.timeoutMs });
    return features?.features?.voice?.enabled === true;
}
