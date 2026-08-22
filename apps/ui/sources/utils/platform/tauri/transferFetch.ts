import type { RuntimeFetch } from '@/utils/system/runtimeFetch';

import { isDesktopHost } from '../desktopHost';

let cachedTauriRuntimeFetch: RuntimeFetch | null | undefined;

function normalizeRequestUrl(input: RequestInfo | URL): string | null {
    if (input instanceof URL) {
        return input.toString();
    }

    if (typeof input === 'string') {
        const value = input.trim();
        return value ? value : null;
    }

    if (typeof Request !== 'undefined' && input instanceof Request) {
        const value = input.url.trim();
        return value ? value : null;
    }

    return null;
}

export function shouldUseTauriRuntimeFetch(input: RequestInfo | URL): boolean {
    const rawUrl = normalizeRequestUrl(input);
    if (!rawUrl) {
        return false;
    }

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        return true;
    }

    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

async function loadTauriRuntimeFetch(): Promise<RuntimeFetch | null> {
    if (!isDesktopHost()) {
        return null;
    }

    try {
        const mod = await import('@tauri-apps/plugin-http');
        const pluginFetch = mod.fetch;
        return typeof pluginFetch === 'function' ? (pluginFetch as RuntimeFetch) : null;
    } catch {
        return null;
    }
}

export async function resolveTauriRuntimeFetch(input: RequestInfo | URL): Promise<RuntimeFetch | null> {
    if (!shouldUseTauriRuntimeFetch(input)) {
        return null;
    }

    if (cachedTauriRuntimeFetch !== undefined) {
        return cachedTauriRuntimeFetch;
    }

    cachedTauriRuntimeFetch = await loadTauriRuntimeFetch();
    return cachedTauriRuntimeFetch;
}
