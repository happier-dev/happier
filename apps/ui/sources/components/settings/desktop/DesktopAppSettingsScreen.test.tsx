/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { createSecretSettingsTestHarness, type SecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { renderSettingsView, standardCleanup } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storage';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DesktopAppSettingsScreen } = await import('./DesktopAppSettingsScreen');
const originalState = storage.getState();
const originalAuth = getCurrentAuth();

describe('DesktopAppSettingsScreen', () => {
    let account: SecretSettingsTestHarness;
    beforeEach(async () => {
        const secureStorage = createDesktopSecureStorageBoundary();
        let callbackId = 0;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_host_get_availability') return Promise.resolve({
                activity: { kind: 'available' }, pet: { kind: 'available' }, windows: { kind: 'available' },
            });
            if (command === 'plugin:event|listen') return Promise.resolve(++callbackId);
            return secureStorage.invoke(command, args);
        }, transformCallback: () => ++callbackId });
        vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
        account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        storage.setState({ localSettings: { ...localSettingsDefaults, desktopOverlayEnabled: true } });
    });
    afterEach(async () => {
        standardCleanup();
        await account?.dispose();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        setCurrentAuth(originalAuth);
        storage.setState(originalState, true);
    });
    const render = () => renderSettingsView(<InjectedAuthProvider credentials={account.credentials}>
        <DesktopAppSettingsScreen />
    </InjectedAuthProvider>);

    it('keeps startup settings beside the enabled Notch controls', async () => {
        const screen = await render();
        expect(screen.findByTestId('settings-desktop-autostart-enabled')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-visibility-mode')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-dock')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-display')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-idle')).toBeTruthy();
        expect(screen.findRow('settings-desktop-bot-conversation-presentation')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-compact-style')).toBeNull();
    });

    it('says where these settings live when opened outside the desktop app', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        const screen = await render();
        expect(screen.findRow('settings-desktop-unavailable')).toBeTruthy();
        expect(screen.findRow('settings-desktop-overlay-enabled')).toBeNull();
        expect(screen.findRow('settings-desktop-autostart-enabled')).toBeNull();
    });
});
