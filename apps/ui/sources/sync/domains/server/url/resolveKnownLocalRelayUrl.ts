import { canonicalizeServerUrl } from './serverUrlCanonical';
import { isLocalishServerUrl } from './serverUrlClassification';
import { HAPPIER_CLOUD_SERVER_URL } from '../serverProfiles';

function normalizeRelayUrl(rawUrl: string | null | undefined): string | null {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    return value.length > 0 ? value : null;
}

export function resolveKnownLocalRelayUrl(params: Readonly<{
    activeServerUrl: string | null | undefined;
    activeLocalRelayUrl?: string | null | undefined;
}>): string | null {
    const activeServerUrl = normalizeRelayUrl(params.activeServerUrl);
    const normalizedServerUrl = activeServerUrl ? canonicalizeServerUrl(activeServerUrl) : null;
    const normalizedCloudUrl = canonicalizeServerUrl(HAPPIER_CLOUD_SERVER_URL);
    if (normalizedServerUrl && normalizedServerUrl === normalizedCloudUrl) {
        return null;
    }

    const activeLocalRelayUrl = normalizeRelayUrl(params.activeLocalRelayUrl);
    if (activeLocalRelayUrl && isLocalishServerUrl(activeLocalRelayUrl)) {
        return activeLocalRelayUrl;
    }

    if (!activeServerUrl) {
        return null;
    }

    return isLocalishServerUrl(activeServerUrl) ? activeServerUrl : null;
}
