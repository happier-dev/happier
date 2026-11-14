import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedPersistedHomeProfilesForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { homeProfileForTests, installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';
import { installLocalStorageMock } from './tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('token_storage_home_contexts_desktop');

/** Desktop secure storage is a host IPC boundary: each read is one awaited round trip. */
const desktop = vi.hoisted(() => ({
    values: new Map<string, string>(),
    reads: 0,
    inFlight: 0,
    maxInFlight: 0,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => 'tauri',
    isDesktopHost: () => true,
    invokeDesktopHost: async (command: string, args?: Record<string, unknown>) => {
        const key = String(args?.key ?? '');
        if (command === 'desktop_secure_storage_read') {
            desktop.reads += 1;
            desktop.inFlight += 1;
            desktop.maxInFlight = Math.max(desktop.maxInFlight, desktop.inFlight);
            await new Promise(resolve => setTimeout(resolve, 5));
            desktop.inFlight -= 1;
            return desktop.values.get(key) ?? null;
        }
        if (command === 'desktop_secure_storage_write') { desktop.values.set(key, String(args?.value ?? '')); return null; }
        if (command === 'desktop_secure_storage_remove') { desktop.values.delete(key); return null; }
        throw new Error(`Unexpected Desktop command: ${command}`);
    },
}));

const { TokenStorage } = await import('./tokenStorage');

describe('Desktop Home credential contexts', () => {
    let restoreLocalStorage: (() => void) | null = null;
    beforeEach(() => {
        desktop.values.clear();
        desktop.reads = 0;
        desktop.inFlight = 0;
        desktop.maxInFlight = 0;
        restoreLocalStorage = installLocalStorageMock().restore;
    });
    afterEach(() => {
        restoreLocalStorage?.();
        restoreLocalStorage = null;
    });

    it('reads every known Home credential in one round of host reads, not one Home after another', async () => {
        const HOMES = 4;
        const profiles = Array.from({ length: HOMES }, (_, index) =>
            homeProfileForTests(`home-${index}`, `https://home-${index}.example.test`));
        await seedPersistedHomeProfilesForTests({ profiles, activeServerId: profiles[0]!.id });

        const contexts = await TokenStorage.listHomeCredentialContexts();

        expect(contexts.map(context => context.serverId)).toHaveLength(HOMES);
        expect(desktop.reads).toBeGreaterThanOrEqual(HOMES);
        // Every Home's read is issued before the first answers (one IPC round, not HOMES sequential rounds).
        expect(desktop.maxInFlight).toBeGreaterThanOrEqual(HOMES);
    });
});
