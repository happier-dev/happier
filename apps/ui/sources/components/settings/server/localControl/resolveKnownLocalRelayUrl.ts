import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';

function normalizeRelayUrl(rawUrl: string | null | undefined): string | null {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    return value.length > 0 ? value : null;
}

export function resolveKnownLocalRelayUrl(params: Readonly<{
    activeServerUrl: string | null | undefined;
    activeLocalRelayUrl?: string | null | undefined;
}>): string | null {
    const activeLocalRelayUrl = normalizeRelayUrl(params.activeLocalRelayUrl);
    if (activeLocalRelayUrl) {
        return activeLocalRelayUrl;
    }

    const activeServerUrl = normalizeRelayUrl(params.activeServerUrl);
    if (!activeServerUrl) {
        return null;
    }

    return isLocalishServerUrl(activeServerUrl) ? activeServerUrl : null;
}
