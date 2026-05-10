import type { ExternalSessionsSource } from '@happier-dev/protocol';

import { validateOpenCodeExternalSessionsSource } from './validateOpenCodeExternalSessionsSource';

function normalizeBaseUrl(raw: string): string {
    return raw.trim().replace(/\/+$/, '');
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, `${baseUrl}/`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (typeof value === 'string' && value.length > 0) {
                url.searchParams.set(key, value);
            }
        }
    }
    return url.toString();
}

async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`OpenCode HTTP GET ${url} failed: ${response.status} ${response.statusText}${text ? `\n${text}` : ''}`);
    }
    return (await response.json()) as T;
}

export type OpenCodeDirectClient = Readonly<{
    sessionList: () => Promise<unknown[]>;
    sessionGet: (opts: Readonly<{ sessionId: string }>) => Promise<unknown>;
    sessionStatusList: () => Promise<Record<string, { type?: string }>>;
    sessionMessagesList: (opts: Readonly<{ sessionId: string }>) => Promise<unknown[]>;
    dispose: () => Promise<void>;
}>;

function resolveBaseUrlOrThrow(source: ExternalSessionsSource): string {
    if (source.kind !== 'opencodeServer') {
        throw new Error('OpenCode direct client requires an opencodeServer source');
    }
    const raw = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
    if (!raw) {
        throw new Error('OpenCode direct client requires source.baseUrl or HAPPIER_OPENCODE_SERVER_URL');
    }
    return normalizeBaseUrl(raw);
}

function resolveDirectory(source: ExternalSessionsSource): string {
    if (source.kind !== 'opencodeServer') return '';
    return typeof source.directory === 'string' && source.directory.trim().length > 0 ? source.directory.trim() : '';
}

export async function createOpenCodeDirectClient(source: ExternalSessionsSource): Promise<OpenCodeDirectClient> {
    // Ensure the same validation rules as the RPC boundary (env overrides, etc.).
    const validated = validateOpenCodeExternalSessionsSource({ source, env: process.env });
    if (!validated.ok) {
        throw new Error(validated.error);
    }

    const baseUrl = resolveBaseUrlOrThrow(validated.source);
    const directory = resolveDirectory(validated.source);

    return {
        sessionList: async () => {
            const raw = await fetchJson<unknown>(buildUrl(baseUrl, '/session', { ...(directory ? { directory } : {}) }));
            return Array.isArray(raw) ? raw : [];
        },
        sessionGet: async ({ sessionId }) => {
            return await fetchJson<unknown>(buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}`, { ...(directory ? { directory } : {}) }));
        },
        sessionStatusList: async () => {
            const raw = await fetchJson<unknown>(buildUrl(baseUrl, '/session/status', { ...(directory ? { directory } : {}) }));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
            return raw as Record<string, { type?: string }>;
        },
        sessionMessagesList: async ({ sessionId }) => {
            const raw = await fetchJson<unknown>(buildUrl(baseUrl, `/session/${encodeURIComponent(sessionId)}/message`, { ...(directory ? { directory } : {}) }));
            return Array.isArray(raw) ? raw : [];
        },
        dispose: async () => {},
    };
}
