import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IModal } from '@/modal';
import type { ActiveServerSwitchResult } from '@/sync/domains/server/activeServerSwitch';

import { renderScreen } from '@/dev/testkit';
import { installBrowserClipboardBoundary } from '@/dev/testkit/harness/browserClipboardBoundary';
import { t } from '@/text';
// Resolve the real component graph during collection, not inside the first timed assertion.
import './RestoreQrView';

const descriptor = Object.freeze({
    v: 1 as const,
    homeServerIdentityId: 'known-home',
    canonicalServerUrl: 'https://known-home.example.test',
    revision: 1,
    endpoints: [{ kind: 'https' as const, url: 'https://known-home.example.test' }],
});

const state = vi.hoisted(() => ({
    presentation: { phase: 'generating' } as Record<string, unknown>,
    canCancel: true,
    cancel: vi.fn(),
    start: vi.fn(async () => {}),
    copy: vi.fn<(value: string) => Promise<boolean>>(async () => true),
    preventRemove: vi.fn(),
    switchHome: vi.fn<(params: unknown) => Promise<ActiveServerSwitchResult>>(async () => 'switched'),
    alertAsync: vi.fn<IModal['alertAsync']>(async () => {}),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});

const routerSpies = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('expo-router', async () => (
    await import('@/dev/testkit/mocks/router')
).createExpoRouterMock({ params: {}, router: { replace: routerSpies.replace } }).module);

vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation'))
    .createReactNavigationNativeMock({ usePreventRemove: (locked) => state.preventRemove(locked) }));

vi.mock('@/hooks/auth/useReversePairingSession', () => ({
    useReversePairingSession: () => ({
        presentation: state.presentation,
        canCancel: state.canCancel,
        cancel: state.cancel,
        start: state.start,
    }),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: (value: string) => state.copy(value),
}));

vi.mock('@/components/qr/QRCode', () => ({ QRCode: 'QRCode' }));
vi.mock('@/components/ui/buttons/RoundButton', () => ({ RoundButton: 'RoundButton' }));
vi.mock('@/utils/platform/qrScannerSupport', () => ({ canUseCurrentDeviceQrScanner: () => true }));
vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({ getReadyServerFeatures: vi.fn(async () => null) }));
vi.mock('@/utils/system/fireAndForget', () => ({ fireAndForget: (promise: Promise<unknown>) => void promise }));
vi.mock('@/auth/providers/registry', () => ({ getAuthProvider: () => null }));
const authRefresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: authRefresh }),
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: (params: unknown) => state.switchHome(params),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: state.alertAsync } }).module;
});

describe('RestoreQrView known-target requester QR', () => {
    beforeEach(() => {
        state.presentation = {
            phase: 'ready',
            invite: {},
            link: 'happier:///pair?v=2&payload=opaque-secret',
            qrAvailable: true,
            descriptor,
        };
        state.canCancel = true;
        state.cancel.mockClear();
        state.start.mockClear();
        state.copy.mockClear();
        installBrowserClipboardBoundary(async value => { await state.copy(value); });
        state.preventRemove.mockClear();
        state.switchHome.mockReset();
        state.switchHome.mockResolvedValue('switched');
        state.alertAsync.mockReset();
        state.alertAsync.mockResolvedValue(undefined);
        routerSpies.replace.mockClear();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders the exact known-target requester QR with no code or approval controls', async () => {
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(<RestoreQrView embedded entryIntent="enter_home" />);

        expect(screen.findByTestId('restore-requester-qr')?.findByType('QRCode').props.data)
            .toBe('happier:///pair?v=2&payload=opaque-secret');
        expect(screen.getTextContent()).toContain('known-home.example.test');
        expect(screen.findByTestId('restore-scan-confirm-code')).toBeNull();
        expect(screen.findByTestId('restore-approve')).toBeNull();
        expect(screen.findByTestId('restore-reject')).toBeNull();
    });

    it('keeps the secret-bearing link behind explicit warned disclosure, then copies the exact value', async () => {
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(<RestoreQrView embedded entryIntent="enter_home" />);

        expect(screen.getTextContent()).not.toContain(t('connect.pairingLinkSecurityWarning'));
        expect(screen.findByTestId('restore-requester-link-value')).toBeNull();
        expect(screen.findByTestId('restore-copy-requester-link')).toBeNull();

        const details = screen.findByTestId('restore-requester-link-details');
        expect(details?.props.accessibilityState).toMatchObject({ expanded: false });
        await act(async () => details?.props.onPress());
        expect(screen.getTextContent()).toContain(t('connect.pairingLinkSecurityWarning'));
        expect(screen.findByTestId('restore-requester-link-value')?.props.children)
            .toBe('happier:///pair?v=2&payload=opaque-secret');
        await act(async () => screen.findByTestId('restore-requester-link-copy')?.props.action());
        expect(state.copy).toHaveBeenCalledWith('happier:///pair?v=2&payload=opaque-secret');
    });

    it('keeps the exact live link row when only QR encoding is unavailable', async () => {
        state.presentation = { ...state.presentation, qrAvailable: false };
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(<RestoreQrView embedded entryIntent="enter_home" />);

        expect(screen.findByTestId('restore-requester-qr')?.findAllByType('QRCode')).toHaveLength(0);
        expect(screen.getTextContent()).toContain(t('connect.pairingQrTooLargeBody'));
        await act(async () => screen.findByTestId('restore-requester-link-details')?.props.onPress());
        expect(screen.findByTestId('restore-requester-link-value')?.props.children)
            .toBe('happier:///pair?v=2&payload=opaque-secret');
    });

    it('removes the secret-bearing disclosure after terminal success', async () => {
        state.presentation = { phase: 'succeeded', descriptor, profileId: 'known-profile' };
        state.canCancel = false;
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(<RestoreQrView embedded entryIntent="add_home" />);

        expect(screen.findByTestId('restore-requester-link-details')).toBeNull();
        expect(screen.findByTestId('restore-requester-link')).toBeNull();
        expect(screen.getTextContent()).toContain(t('connect.homeAddedPreservedFocusBody'));
    });

    it('locks route removal only after trusted completion reaches credential adoption', async () => {
        state.presentation = { phase: 'adding', descriptor, expiresAtMs: Date.now() + 60_000 };
        state.canCancel = false;
        const onBack = vi.fn();
        const onOpenScanQr = vi.fn();
        const onNavigationLockChange = vi.fn();
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(
            <RestoreQrView
                entryIntent="enter_home"
                embedded
                onBack={onBack}
                onOpenScanQr={onOpenScanQr}
                onNavigationLockChange={onNavigationLockChange}
            />,
        );

        expect(state.preventRemove).toHaveBeenLastCalledWith(true);
        expect(onNavigationLockChange).toHaveBeenCalledWith(true);
        expect(screen.findByTestId('restore-requester-cancel')).toBeNull();
        expect(screen.findByTestId('restore-open-scan-qr')).toBeNull();
        expect(screen.findByTestId('restore-open-manual')).toBeNull();
    });

    it('routes the embedded scanner action through its owner before any claim exists', async () => {
        const onOpenScanQr = vi.fn();
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(
            <RestoreQrView embedded entryIntent="enter_home" onOpenScanQr={onOpenScanQr} />,
        );

        await act(async () => screen.findByTestId('restore-open-scan-qr')?.props.onPress());
        expect(onOpenScanQr).toHaveBeenCalledOnce();
    });

    it('keeps pairing-link entry reachable from the requester QR surface', async () => {
        const onOpenPairingLinkEntry = vi.fn();
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(
            <RestoreQrView
                embedded
                entryIntent="enter_home"
                onOpenPairingLinkEntry={onOpenPairingLinkEntry}
            />,
        );

        await screen.pressByTestIdAsync('restore-enter-pairing-link');
        expect(onOpenPairingLinkEntry).toHaveBeenCalledOnce();
    });

    it('starts a fresh requester invite when the presentation requires a new QR', async () => {
        state.presentation = { phase: 'expired', descriptor };
        state.canCancel = false;
        const { RestoreQrView } = await import('./RestoreQrView');
        const screen = await renderScreen(<RestoreQrView embedded entryIntent="enter_home" />);

        const createNewQr = screen.findByTestId('restore-requester-create-new-qr');
        expect(createNewQr).toBeTruthy();
        await act(async () => createNewQr?.props.action());
        expect(state.start).toHaveBeenCalledOnce();
        expect(screen.findByTestId('restore-requester-retry')).toBeNull();
    });

    it('opens the exact adopted Home and enters the shell for enter_home', async () => {
        state.presentation = { phase: 'succeeded', descriptor, profileId: 'known-profile' };
        state.canCancel = false;
        const { RestoreQrView } = await import('./RestoreQrView');
        await renderScreen(<RestoreQrView embedded entryIntent="enter_home" />);

        await vi.waitFor(() => expect(state.switchHome).toHaveBeenCalledWith({
            serverId: 'known-profile',
            scope: 'tab',
            refreshAuth: authRefresh,
            requireExactProfile: true,
        }));
        expect(routerSpies.replace).toHaveBeenCalledWith('/');
        expect(state.preventRemove).toHaveBeenLastCalledWith(false);
        expect(state.preventRemove.mock.invocationCallOrder.at(-1)!)
            .toBeLessThan(routerSpies.replace.mock.invocationCallOrder[0]!);
    });

    it('retries the exact retained profile when opening enter_home is initially blocked', async () => {
        state.presentation = { phase: 'succeeded', descriptor, profileId: 'known-profile' };
        state.canCancel = false;
        state.switchHome
            .mockResolvedValueOnce('blocked')
            .mockResolvedValueOnce('switched');
        state.alertAsync.mockImplementationOnce(async (_title, _message, buttons) => {
            buttons?.find((button) => button.style !== 'cancel')?.onPress?.();
        });
        const { RestoreQrView } = await import('./RestoreQrView');
        await renderScreen(<RestoreQrView embedded entryIntent="enter_home" />);

        await vi.waitFor(() => expect(state.switchHome).toHaveBeenCalledTimes(2));
        expect(state.switchHome).toHaveBeenNthCalledWith(2, expect.objectContaining({
            serverId: 'known-profile',
            scope: 'tab',
        }));
        expect(routerSpies.replace).toHaveBeenCalledWith('/');
    });

    it('returns to the shell without switching focus for add_home', async () => {
        state.presentation = { phase: 'succeeded', descriptor, profileId: 'known-profile' };
        state.canCancel = false;
        const { RestoreQrView } = await import('./RestoreQrView');
        await renderScreen(<RestoreQrView embedded entryIntent="add_home" />);

        expect(state.switchHome).not.toHaveBeenCalled();
        expect(routerSpies.replace).not.toHaveBeenCalled();
    });
});
