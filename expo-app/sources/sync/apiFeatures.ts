import { getServerUrl } from './serverConfig';

export type ServerFeatures = {
    features: {
        sessionSharing: boolean;
        publicSharing: boolean;
        contentKeys: boolean;
    };
};

let cached: { value: ServerFeatures | null; at: number } | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseServerFeatures(raw: unknown): ServerFeatures | null {
    if (!isPlainObject(raw)) return null;
    const features = raw.features;
    if (!isPlainObject(features)) return null;

    const sessionSharing = features.sessionSharing;
    const publicSharing = features.publicSharing;
    const contentKeys = features.contentKeys;

    if (typeof sessionSharing !== 'boolean') return null;
    if (typeof publicSharing !== 'boolean') return null;
    if (typeof contentKeys !== 'boolean') return null;

    return {
        features: {
            sessionSharing,
            publicSharing,
            contentKeys,
        },
    };
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

export async function isSessionSharingSupported(params?: { timeoutMs?: number }): Promise<boolean> {
    const features = await getServerFeatures({ timeoutMs: params?.timeoutMs });
    return features?.features.sessionSharing === true;
}

