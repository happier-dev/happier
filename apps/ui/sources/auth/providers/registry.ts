import { authProviderModules } from '@/auth/providers/providerModules';
import type { AuthProvider } from '@/auth/providers/types';
import { createExternalOAuthProvider } from '@/auth/providers/externalOAuthProvider';
import { getCachedReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import type { AuthProviderId } from '@happier-dev/protocol';

export type { AuthProvider } from '@/auth/providers/types';

export const authProviderRegistry: readonly AuthProvider[] = Object.freeze([
    ...authProviderModules,
]);

const fallbackProviders = new Map<string, AuthProvider>();

function defaultDisplayNameFromId(id: string): string {
    const normalized = id.trim();
    if (!normalized) return 'OAuth';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function normalizeProviderId(id: unknown): string | null {
    if (typeof id !== 'string') return null;
    const normalized = id.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

export function getAuthProvider(id: string): AuthProvider | null {
    const normalized = normalizeProviderId(id);
    if (!normalized) return null;
    for (const provider of authProviderRegistry) {
        if (normalizeProviderId(provider.id) === normalized) return provider;
    }

    const existing = fallbackProviders.get(normalized);
    if (existing) return existing;

    const features = getCachedReadyServerFeatures();
    const ui = features?.capabilities?.auth?.providers?.[normalized]?.ui;
    const displayName = ui?.displayName ? String(ui.displayName) : defaultDisplayNameFromId(normalized);

    const fallback = createExternalOAuthProvider({
        id: normalized as AuthProviderId,
        displayName,
        badgeIconName: ui?.badgeIconName ? String(ui.badgeIconName) : undefined,
        supportsProfileBadge: ui?.supportsProfileBadge === true,
        connectButtonColor: ui?.connectButtonColor ? String(ui.connectButtonColor) : undefined,
    });
    fallbackProviders.set(normalized, fallback);
    return fallback;
}
