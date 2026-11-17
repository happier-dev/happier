import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import axios from 'axios';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { getBuiltInThemeLibraryEntries } from '@/theme/profiles/builtInThemeProfiles';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Appearance: { getColorScheme: () => 'light' },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-status-bar', () => ({ setStatusBarStyle: vi.fn() }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn(async () => {}) }));
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
    it('animates one visible library selection and preserves preferences changed before the effect', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        const { JSDOM } = await import('jsdom');
        const dom = new JSDOM('', { pretendToBeVisual: true });
        const reference = getBuiltInThemeLibraryEntries().find(entry => entry.mode === 'light')!.reference;
        const darkReference = getBuiltInThemeLibraryEntries().find(entry => entry.mode === 'dark')!.reference;
        const transition = vi.fn((update: () => Promise<void>) => {
            const committed = Promise.resolve().then(async () => {
                storage.getState().applyLocalSettings({ themePreference: 'dark', uiFontScale: 1.2,
                    themeProfileSelection: { light: null, dark: darkReference } });
                await update();
            });
            return { ready: committed, updateCallbackDone: committed };
        });
        Object.assign(dom.window.document.documentElement, { animate: vi.fn() });
        Object.assign(dom.window.document, { startViewTransition: transition });
        vi.stubGlobal('document', dom.window.document);
        try {
            await sync.awaitBootstrapForegroundAcquisition();
            storage.getState().applyLocalSettings({ themePreference: 'light', themeProfileSelection: { light: null, dark: null } });
            await sync.withThemeProfileLibrary(library => library.select({ mode: 'light', reference }), { expectedScope: account.scope });
            expect(transition).toHaveBeenCalledTimes(1);
            expect(storage.getState().localSettings).toMatchObject({ themePreference: 'dark', uiFontScale: 1.2,
                themeProfileSelection: { light: reference, dark: darkReference } });
            // An unchanged reference is a library no-op; changing the hidden mode does not paint.
            await sync.withThemeProfileLibrary(library => library.select({ mode: 'light', reference }), { expectedScope: account.scope });
            await sync.withThemeProfileLibrary(library => library.select({ mode: 'light', reference: null }), { expectedScope: account.scope });
            expect(transition).toHaveBeenCalledTimes(1);
            expect(storage.getState().localSettings.themeProfileSelection).toEqual({ light: null, dark: darkReference });
        } finally { standardCleanup(); await account.dispose(); vi.unstubAllGlobals(); dom.window.close(); }
    });

});
