import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { profileDefaults, type Profile } from '@/sync/domains/profiles/profile';
import { installAccountSettingsRouteModuleMocks } from './accountSettingsRouteTestHelpers';
import 'fake-indexeddb/auto';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const boundary = vi.hoisted(() => ({
    clipboard: [] as string[],
    profile: null as unknown as Profile,
    encryptionMode: 'plain' as 'plain' | 'e2ee',
    holdSecurityRead: false,
    securityRequests: [] as string[],
}));

installAccountSettingsRouteModuleMocks({ storageModule: (importOriginal) => importOriginal() });
installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('expo-camera', () => ({ useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: { isModernBarcodeScannerAvailable: false, onModernBarcodeScanned: () => ({ remove() {} }), launchScanner() {}, dismissScanner: async () => {} } }));
vi.mock('@more-tech/react-native-libsodium', () => import('libsodium-wrappers'));
vi.mock('@/platform/cryptoRandom', () => import('@/platform/cryptoRandom.node'));
vi.mock('@/platform/digest', () => import('@/platform/digest.node'));
vi.mock('@/platform/hmacSha512', () => import('@/platform/hmacSha512.node'));
vi.mock('@/platform/randomUUID', () => import('@/platform/randomUUID.node'));
await loadSyncSingletonForTests();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | undefined;
let restoreExecutor: (() => void) | undefined;

vi.mock('expo-image', () => ({ Image: 'Image' }));

vi.mock('expo-clipboard', () => ({
    setStringAsync: async (value: string) => { boundary.clipboard.push(value); },
}));

async function renderAccount() {
    await account?.dispose();
    restoreExecutor?.();
    account = await createSecretSettingsTestHarness({ mode: boundary.encryptionMode });
    restoreExecutor = await installRealActionExecutorModuleLoader();
    const originalRequest = account.request.getMockImplementation()!;
    account.request.mockImplementation(async (input, init) => {
        if (new URL(String(input)).pathname === '/v1/account/security') {
            boundary.securityRequests.push('/v1/account/security');
            if (boundary.holdSecurityRead) return await new Promise<Response>(() => {});
            return Response.json({ v: 1, encryptionMode: boundary.encryptionMode, terminalPresentUserPolicy: 'allowed',
                nativeEmail: 'lee@example.test', password: { status: 'enrolled', revision: 1 } });
        }
        return originalRequest(input, init);
    });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().applyProfile(boundary.profile);
    storage.setState({ isDataReady: true, profileScope: account.scope });
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { default: AccountScreen } = await import('@/app/(app)/settings/account');
    // Retained device key presence is deliberately independent of the Home's
    // authoritative mode. No Account material is fabricated for the plain Sync.
    const credentials = boundary.encryptionMode === 'plain'
        ? { ...account.credentials, secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }
        : account.credentials;
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AccountScreen /></InjectedAuthProvider>);
    await vi.waitFor(() => expect(boundary.securityRequests).toContain('/v1/account/security'));
    return screen;
}

type RenderedNode = Readonly<{ children: readonly (RenderedNode | string)[]; props: Record<string, unknown> }>;

function renderedText(node: RenderedNode | string | null | undefined): string {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    return node.children.map((child) => renderedText(child)).join(' ');
}

/** The header's title, and the text of its facts line as rendered. */
function identityHeader(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const header = screen.findAll((node) => node.props.testID === 'settings-account-identity'
        && typeof node.props.title === 'string')[0];
    expect(header).toBeTruthy();
    const meta = screen.findAll((node) => node.props.testID === 'settings-account-identity-meta')[0];
    return {
        title: header!.props.title as string,
        facts: renderedText(meta as unknown as RenderedNode | undefined),
        text: renderedText(header as unknown as RenderedNode),
    };
}

describe('Settings → Account identity header', () => {
    afterEach(async () => {
        boundary.securityRequests = [];
        boundary.holdSecurityRead = false;
        boundary.encryptionMode = 'plain';
        standardCleanup();
        await account?.dispose();
        account = undefined;
        restoreExecutor?.();
        restoreExecutor = undefined;
    });

    it('names the person through the canonical display name when there is no first name', async () => {
        boundary.profile = { ...profileDefaults, id: 'prof_1', firstName: null, lastName: null, username: 'lee' };
        boundary.encryptionMode = 'plain';

        const screen = await renderAccount();
        const header = identityHeader(screen);

        expect(header.title).toBe('lee');
        expect(header.facts).toContain('@lee');
    });

    it('states end-to-end encryption from the Account encryption mode, not from a held key', async () => {
        boundary.profile = { ...profileDefaults, id: 'prof_1', firstName: 'Lee', username: 'lee' };
        boundary.encryptionMode = 'plain';
        const plain = await renderAccount();
        await vi.waitFor(() => expect(plain.findByTestId('settings-account-email-password')?.props.subtitle)
            .toContain('lee@example.test'));
        expect(identityHeader(plain).facts).not.toContain('settingsAccount.endToEndEncrypted');
        expect(plain.findByTestId('settings-account-signin-recovery-key')).toBeNull();
        standardCleanup();

        boundary.securityRequests = [];
        boundary.encryptionMode = 'e2ee';
        const encrypted = await renderAccount();
        await vi.waitFor(() => expect(identityHeader(encrypted).facts).toContain('settingsAccount.endToEndEncrypted'));
        expect(encrypted.findByTestId('settings-account-signin-recovery-key')).not.toBeNull();
    });

    it('shows the Account ID this device is signed in with and copies it', async () => {
        boundary.profile = { ...profileDefaults, id: 'prof_1', firstName: 'Lee' };
        boundary.encryptionMode = 'plain';
        boundary.clipboard = [];
        const screen = await renderAccount();

        const accountId = screen.findByTestId('settings-account-id');
        expect(accountId).not.toBeNull();
        expect(screen.getTextContent()).toContain('account-a');
        await screen.pressByTestIdAsync('settings-account-id-copy');
        expect(boundary.clipboard).toEqual(['account-a']);
    });

    it('reserves the encryption fact and the recovery-key row while the Account facts are loading', async () => {
        boundary.profile = { ...profileDefaults, id: 'prof_1', firstName: 'Lee', username: null };
        boundary.holdSecurityRead = true;
        const screen = await renderAccount();

        // Reserved by a quiet placeholder announced as busy; no row prints a "Loading…" value.
        expect(screen.findHostByTestId('settings-account-recovery-key-loading')?.props.accessibilityState).toEqual({ busy: true });
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(identityHeader(screen).facts).not.toContain('ndToEndEncrypted');
    });

    it('states the encryption mode for a plaintext Account too, so the fact never appears or vanishes', async () => {
        boundary.profile = { ...profileDefaults, id: 'prof_1', firstName: 'Lee', username: null };
        boundary.encryptionMode = 'plain';
        const screen = await renderAccount();

        await vi.waitFor(() => expect(identityHeader(screen).facts).toContain('settingsAccount.notEndToEndEncrypted'));
        expect(screen.findByTestId('settings-account-recovery-key-loading')).toBeNull();
    });

    it('puts the encryption fact, with its lock, directly under the Account ID', async () => {
        boundary.profile = { ...profileDefaults, id: 'prof_1', firstName: 'Lee', username: null };
        boundary.encryptionMode = 'e2ee';
        const screen = await renderAccount();

        await vi.waitFor(() => expect(identityHeader(screen).facts).toContain('settingsAccount.endToEndEncrypted'));
        const { text } = identityHeader(screen);
        expect(text.indexOf('account-a')).toBeGreaterThan(-1);
        expect(text.indexOf('account-a')).toBeLessThan(text.indexOf('settingsAccount.endToEndEncrypted'));
        const fact = screen.findByTestId('settings-account-encryption-fact');
        expect(fact?.findAll((node) => node.props.name === 'lock').length).toBeGreaterThan(0);
    });
});
