import { getServerUrl } from './serverConfig';

import { FeaturesResponseSchema, type FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

let cached: { value: ServerFeatures | null; at: number } | null = null;

function parseServerFeatures(raw: unknown): ServerFeatures | null {
    const parsed = FeaturesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

export async function getServerFeatures(params?: { timeoutMs?: number; force?: boolean }): Promise<ServerFeatures | null> {
    const force = params?.force ?? false;
    const timeoutMs = params?.timeoutMs ?? 800;

    if (!force && cached) {
        // Cache for 10 minutes.
        if (Date.now() - cached.at < 10 * 60 * 1000) {
            return cached.value;
        }
    }

    const url = `${getServerUrl()}/v1/features`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
        });

        if (!response.ok) {
            cached = { value: null, at: Date.now() };
            return null;
        }

        const json = await response.json();
        const parsed = parseServerFeatures(json);
        cached = { value: parsed, at: Date.now() };
        return parsed;
    } catch {
        cached = { value: null, at: Date.now() };
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function getCachedServerFeatures(): ServerFeatures | null {
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
