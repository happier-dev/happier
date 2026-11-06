import { getStorage } from '@/sync/domains/state/storageStore';

/**
 * Captures the Account an organization operation started under. Its replies carry that Account's
 * content and version, so they only reach the store while that Account is still the signed-in one;
 * a token refresh keeps it, sign-out or another Account ends it.
 */
export function captureOrganizationAccount(): () => boolean {
    const accountId = getStorage().getState().profileScope?.accountId ?? null;
    return () => (getStorage().getState().profileScope?.accountId ?? null) === accountId;
}
