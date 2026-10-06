import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { AccountProfileSchema } from '@happier-dev/protocol';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installAccountSettingsRouteModuleMocks } from './accountSettingsRouteTestHelpers';
import { createAccountFeaturesResponse } from './account.testHelpers';

installAccountSettingsRouteModuleMocks({ storageModule: (importOriginal) => importOriginal() });
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 2, fontScale: 1 }),
    Dimensions: { get: () => ({ width: 1440, height: 900, scale: 2, fontScale: 1 }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('expo-camera', () => ({ useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: { isModernBarcodeScannerAvailable: false, onModernBarcodeScanned: () => ({ remove() {} }), launchScanner() {}, dismissScanner: async () => {} } }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();

let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let restoreExecutor: (() => void) | undefined;
afterEach(async () => {
    standardCleanup();
    await account?.dispose();
    account = undefined;
    restoreExecutor?.();
    restoreExecutor = undefined;
    vi.restoreAllMocks();
});

describe('Settings → Account desktop shell', () => {
    it('renders the account route inside the desktop settings shell without crashing', async () => {
        account = await createSecretSettingsTestHarness();
        restoreExecutor = await installRealActionExecutorModuleLoader();
        const originalRequest = account.request.getMockImplementation()!;
        account.request.mockImplementation(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createAccountFeaturesResponse());
            if (path === '/v1/account/security') return Response.json({ v: 1, encryptionMode: 'plain', terminalPresentUserPolicy: 'allowed',
                nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            return originalRequest(input, init);
        });
        const { storage } = await import('@/sync/domains/state/storage');
        const { localSettingsParse } = await import('@/sync/domains/settings/localSettings');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.getState().applyProfile(AccountProfileSchema.parse({ ...profileDefaults, id: 'desktop-profile', linkedProviders: [], connectedServices: [],
            connectedServicesV2: ['openai-codex', 'anthropic', 'gemini'].map((serviceId) => ({ serviceId, groups: [], profiles: [{
                profileId: 'work', status: 'connected' as const, kind: 'oauth' as const, providerEmail: null,
                providerAccountId: null, expiresAt: null, lastUsedAt: null, health: null,
            }] })) }));
        storage.setState({ isDataReady: true, profileScope: account.scope,
            localSettings: localSettingsParse({ settingsNavSidebarEnabled: true, settingsNavSidebarWidthPx: 230, settingsNavSidebarWidthBasisPx: 1200 }) });
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<InjectedAuthProvider credentials={account.credentials}>
            <SettingsShell><AccountScreen /></SettingsShell>
        </InjectedAuthProvider>);

        expect(screen.findByTestId('settings-sidebar')).toBeTruthy();
        expect(screen.findByTestId('settings-account-identity')).toBeTruthy();
        const text = screen.getTextContent();
        expect(text).not.toContain('connectedServices.serviceNames.openaiCodex');
        expect(text).not.toContain('connectedServices.serviceNames.anthropic');
        expect(text).not.toContain('connectedServices.serviceNames.gemini');
        expect(text).toContain('settings.connectedServices');
    });
});
