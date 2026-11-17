import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import axios from 'axios';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const originalState = storage.getState();
const originalAxiosAdapter = axios.defaults.adapter;
afterEach(() => {
    standardCleanup();
    storage.setState(originalState, true);
    axios.defaults.adapter = originalAxiosAdapter;
    vi.unstubAllGlobals();
});

describe('theme library Account scope admission', () => {
    it('refuses explicit absent Account scope without borrowing the active library', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            await expect(sync.withThemeProfileLibrary(async () => 'admitted', { expectedScope: account.scope }))
                .resolves.toBe('admitted');
            await expect(sync.withThemeProfileLibrary(async () => 'borrowed current Account', { expectedScope: null }))
                .rejects.toThrow('Artifact Account scope changed');
        } finally {
            standardCleanup();
            await account.dispose();
        }
    });
});
