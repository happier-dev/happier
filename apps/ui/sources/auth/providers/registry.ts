import { authProviderModules } from '@/auth/providers/providerModules';
import type { AuthProvider } from '@/auth/providers/types';
import { createExternalOAuthProvider } from '@/auth/providers/externalOAuthProvider';
import type { AuthProviderId } from '@happier-dev/protocol/auth/providers';

export type { AuthProvider } from '@/auth/providers/types';

export const authProviderRegistry: readonly AuthProvider[] = Object.freeze([
    ...authProviderModules,
]);

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

export function getAuthProvider(
    id: string,
    presentation?: Readonly<{
        displayName: string;
        badgeIconName?: string;
        /** The Home projects `null` when a provider declares no colour. */
        connectButtonColor?: string | null;
        supportsProfileBadge?: boolean;
    }>,
): AuthProvider | null {
    const normalized = normalizeProviderId(id);
    if (!normalized) return null;
    for (const provider of authProviderRegistry) {
        if (normalizeProviderId(provider.id) === normalized) return provider;
    }

    return createExternalOAuthProvider({
        id: normalized as AuthProviderId,
        displayName: presentation?.displayName ?? defaultDisplayNameFromId(normalized),
        ...(presentation?.badgeIconName ? { badgeIconName: presentation.badgeIconName } : {}),
        ...(presentation?.connectButtonColor ? { connectButtonColor: presentation.connectButtonColor } : {}),
        supportsProfileBadge: presentation?.supportsProfileBadge === true,
    });
}
