import { MMKV } from 'react-native-mmkv';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';

/** Seeds the device persistence boundary; the real profile reader normalizes and publishes it. */
export async function seedPersistedHomeProfilesForTests(input: Readonly<{
    profiles: readonly ServerProfile[];
    activeServerId: string;
    activeServerIdIsExplicit?: boolean;
    /** Select the actual browser Storage boundary for a web-profile fixture. */
    browserStorage?: Storage;
}>) {
    const storageId = scopedStorageId('server-profiles', readStorageScopeFromEnv());
    const value = JSON.stringify({
        activeServerId: input.activeServerId,
        activeServerIdIsExplicit: input.activeServerIdIsExplicit ?? true,
        servers: Object.fromEntries(input.profiles.map(profile => [profile.id, profile])),
    });
    if (input.browserStorage) input.browserStorage.setItem(`${storageId}:server-state-v1`, value);
    else new MMKV({ id: storageId }).set('server-state-v1', value);
    const { resetServerProfilesRuntimeForTests } = await import('@/sync/domains/server/serverProfiles');
    resetServerProfilesRuntimeForTests();
}

/**
 * Saves and selects one Home through the real profile owner. Unconfigured
 * source builds (the test build) seed no default Home, so suites that read
 * the ambient active Home must select one explicitly.
 */
export async function selectActiveTestHomeForTests(serverUrl = 'https://active-test-home.test'): Promise<ServerProfile> {
    const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const profile = await upsertServerProfile({ serverUrl, name: 'Test Home' });
    await setActiveServerId(profile.id);
    return profile;
}
