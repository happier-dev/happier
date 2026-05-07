import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';

function encodeKeyPart(value: string): string {
    return `${value.length}:${value}`;
}

export function normalizePendingServerUrl(raw: unknown): string | null {
    const normalized = canonicalizeServerUrl(String(raw ?? '').trim());
    return normalized ? normalized : null;
}

export function getActivePendingServerUrl(): string | null {
    return normalizePendingServerUrl(getActiveServerSnapshot().serverUrl);
}

export function pendingServerScopedKey(prefix: string, serverUrl: string): string {
    const normalized = normalizePendingServerUrl(serverUrl);
    if (!normalized) {
        throw new Error('A server URL is required for pending server scoped storage');
    }
    return `${prefix}:${encodeKeyPart(normalized)}`;
}

export function isPendingServerUrlActive(serverUrl: unknown): boolean {
    const active = getActivePendingServerUrl();
    const target = normalizePendingServerUrl(serverUrl);
    if (!active || !target) return false;
    return createServerUrlComparableKey(active) === createServerUrlComparableKey(target);
}
