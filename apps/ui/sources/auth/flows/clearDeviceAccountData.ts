import { TokenStorage } from '@/auth/storage/tokenStorage';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { clearPersistence, loadLocalSettings, saveLocalSettings } from '@/sync/domains/state/persistence';
import { storage } from '@/sync/domains/state/storageStore';
import { trackLogout } from '@/track';

/**
 * Removes the signed-in account's data from this device: cached state, persistence and stored
 * credentials for every server. Shared by sign-out and the app lock's "Sign out" escape hatch.
 */
export async function clearDeviceAccountData(): Promise<void> {
    trackLogout();
    storage.setState({ sessionArchiveOperations: {} });
    // Preserve device-local flags across logout — the user is signing out of
    // an account but the device itself has still seen the brand hero and
    // still has prior auth experience. Clearing these would force returning
    // users back into the first-time welcome copy after every logout.
    const { brandHeroSeenAt, hasCompletedAuthOnce } = loadLocalSettings();
    await clearPersistence();
    if (brandHeroSeenAt != null || hasCompletedAuthOnce) {
        saveLocalSettings({
            ...localSettingsDefaults,
            brandHeroSeenAt,
            hasCompletedAuthOnce,
        });
    }
    await TokenStorage.removeCredentials();
}
