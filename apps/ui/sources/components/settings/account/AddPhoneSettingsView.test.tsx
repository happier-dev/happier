import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from '../../account/accountTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.spyOn(globalThis, 'setInterval').mockImplementation(() => 0 as any);
vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

installAccountCommonModuleMocks();

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async (_value: string) => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

const modalMocks = vi.hoisted(() => ({
    alertAsync: vi.fn(async () => {}),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: modalMocks,
    }).module;
});

vi.mock('@/components/qr/QRCode', () => ({
    QRCode: 'QRCode',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

const AUTH_FIXTURE = Object.freeze({
    isAuthenticated: true,
    credentials: Object.freeze({ token: 't', secret: 's' }),
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => AUTH_FIXTURE,
}));

let featureState: 'enabled' | 'disabled' | 'unknown' = 'enabled';
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: featureState }),
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: () => new Uint8Array(32).fill(7),
}));

vi.mock('@/platform/digest', () => ({
    digest: vi.fn(async () => new Uint8Array(32).fill(1)),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => activeServerUrl,
}));

let activeServerUrl = 'https://stack.example.test';
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'srv-test', serverUrl: activeServerUrl, generation: 0 }),
}));

vi.mock('@/sync/api/capabilities/serverFeaturesClient', () => ({
    getCachedServerFeaturesSnapshot: () => null,
}));

const serverFetchSpy = vi.fn(async (path: string, _init?: any, _options?: any) => {
    if (path === '/v1/auth/pairing/start') {
        return {
            ok: true,
            status: 200,
            json: async () => ({ pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
    }
    if (path.startsWith('/v1/auth/pairing/status')) {
        return pairingStatusResponse;
    }
    throw new Error(`Unexpected serverFetch path: ${path}`);
});

let pairingStatusResponse: any = {
    ok: true,
    status: 200,
    json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
} as any;

vi.mock('@/sync/http/client', () => ({
    serverFetch: (path: string, init?: any, options?: any) => serverFetchSpy(path, init, options),
}));

describe('AddPhoneSettingsView', () => {
    afterEach(() => {
        clipboardMocks.setStringAsync.mockClear();
        modalMocks.alertAsync.mockClear();
    });

    it('renders a pairing QR code after starting a session', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        const qrContainer = screen.findByTestId('add-phone-qr');
        if (!qrContainer) throw new Error('Expected QR container');
        const qr = qrContainer.findByType('QRCode');
        expect(String(qr.props.data)).toContain('happier:///pair?v=1');
        expect(String(qr.props.data)).toContain('pairId=pair_123');
    });

    it('clears the QR code when the pairing session expires', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: false,
            status: 404,
            json: async () => ({ error: 'not_found' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await flushHookEffects({ cycles: 1 });

        const qrContainer = screen.findByTestId('add-phone-qr');
        expect(qrContainer?.findAllByType('QRCode') ?? []).toHaveLength(0);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('connect.pairingQrExpired');
    });

    it('does not show a sign-in prompt when the feature is disabled', async () => {
        featureState = 'disabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('common.unavailable');
        expect(textContent).not.toContain('modals.pleaseSignInFirst');
    });

    it('shows a server reachability hint when the QR code cannot embed localhost', async () => {
        featureState = 'enabled';
        activeServerUrl = 'http://localhost:53288';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);

        const textContent = screen.getTextContent();
        expect(textContent).toContain('connect.serverUrlNotEmbeddedTitle');
        expect(textContent).toContain('connect.serverUrlNotEmbeddedBody');
    });

    it('copies the pairing link without opening a success modal', async () => {
        featureState = 'enabled';
        activeServerUrl = 'https://stack.example.test';
        pairingStatusResponse = {
            ok: true,
            status: 200,
            json: async () => ({ state: 'pending', pairId: 'pair_123', expiresAt: '2026-02-23T00:00:00.000Z' }),
        } as any;
        const { AddPhoneSettingsView } = await import('./AddPhoneSettingsView');

        const screen = await renderScreen(<AddPhoneSettingsView />);
        await screen.pressByTestIdAsync('add-phone-pairing-link');

        expect(clipboardMocks.setStringAsync).toHaveBeenCalledTimes(1);
        expect(String(clipboardMocks.setStringAsync.mock.calls[0]?.[0])).toContain('happier:///pair?v=1');
        expect(modalMocks.alertAsync).not.toHaveBeenCalledWith('common.success', 'common.copied');
        expect(screen.findByTestId('add-phone-pairing-link-copy-feedback')).toBeTruthy();
    });
});
