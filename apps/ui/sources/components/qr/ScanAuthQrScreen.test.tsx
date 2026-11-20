import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { IModal } from '@/modal/types';
import { getStorage } from '@/sync/domains/state/storageStore';

const boundary = vi.hoisted(() => ({
    alertAsync: vi.fn<IModal['alertAsync']>(async () => undefined),
    back: vi.fn(),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { back: boundary.back, canGoBack: () => true } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: boundary.alertAsync } }).module;
});
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('expo-camera', () => ({
    CameraView: 'CameraView',
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));

const { ScanAuthQrScreen } = await import('./ScanAuthQrScreen');

function renderScanner(credentials: AuthCredentials | null = null) {
    return renderScreen(<InjectedAuthProvider credentials={credentials}><ScanAuthQrScreen
        allowedUrlKind="account"
        homeQrEntryIntent="add_home"
        fallbackHref="/"
        title="Scan"
        subtitle="Scan a Home QR"
        permissionRequiredMessage="Camera permission required"
        manualEntryTitle="Enter link"
        manualEntrySubmitText="Continue"
        testIDPrefix="auth-qr"
    /></InjectedAuthProvider>);
}

describe('ScanAuthQrScreen recovery', () => {
    beforeEach(() => {
        boundary.alertAsync.mockReset();
        boundary.alertAsync.mockResolvedValue(undefined);
        boundary.back.mockClear();
    });

    it('resumes live scanning when the person chooses Scan a new QR after a released V1 link', async () => {
        boundary.alertAsync.mockImplementationOnce(async (_title, _body, buttons) => {
            buttons?.[0]?.onPress?.();
        });
        const screen = await renderScanner();
        await act(async () => {
            await screen.findByTestId('auth-qr-camera')!.props.onBarcodeScanned({
                data: 'happier-dev:///pair?v=1&pairId=pid123&secret=sec_abc&server=https%3A%2F%2Fstack.example.test',
            });
        });

        expect(screen.findAllHostsByTestId('auth-qr-camera')).toHaveLength(1);
        expect(screen.findByTestId('auth-qr-scan-again')).toBeNull();
    });

    it.each(['happier-dev:///account?abc123', 'not-a-pairing-link'])(
        'pauses the camera after a declined or invalid link and resumes only on Scan again (%s)',
        async (data) => {
            const screen = await renderScanner();
            await act(async () => {
                await screen.findByTestId('auth-qr-camera')!.props.onBarcodeScanned({ data });
            });

            expect(screen.findAllHostsByTestId('auth-qr-camera')).toHaveLength(0);
            expect(screen.findByTestId('auth-qr-scan-again')).not.toBeNull();
            expect(screen.findByTestId('auth-qr-enter-url')).not.toBeNull();
            expect(boundary.back).not.toHaveBeenCalled();

            await screen.pressByTestIdAsync('auth-qr-scan-again');
            expect(screen.findAllHostsByTestId('auth-qr-camera')).toHaveLength(1);
            await act(async () => {
                await screen.findByTestId('auth-qr-camera')!.props.onBarcodeScanned({ data });
            });
            expect(screen.findAllHostsByTestId('auth-qr-camera')).toHaveLength(0);
        },
    );

    it('keeps the camera paused when processing throws and still offers recovery', async () => {
        boundary.alertAsync.mockRejectedValueOnce(new Error('presentation unavailable'));
        const screen = await renderScanner();
        await act(async () => {
            await screen.findByTestId('auth-qr-camera')!.props.onBarcodeScanned({ data: 'invalid' }).catch(() => undefined);
        });
        expect(screen.findAllHostsByTestId('auth-qr-camera')).toHaveLength(0);
        await screen.pressByTestIdAsync('auth-qr-scan-again');
        expect(screen.findAllHostsByTestId('auth-qr-camera')).toHaveLength(1);
    });
});


describe('ScanAuthQrScreen connection warning', () => {
    beforeEach(() => {
        getStorage().setState({ socketStatus: 'connected', endpointStatus: 'online' });
    });

    it.each(['disconnected', 'connecting', 'error'] as const)(
        'warns while %s and clears on reconnection while preserving scanner and paste recovery',
        async (socketStatus) => {
            getStorage().setState({ socketStatus });
            const screen = await renderScanner({ token: 'test-token', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
            expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).not.toHaveLength(0);
            expect(screen.findByTestId('auth-qr-camera')).not.toBeNull();

            await screen.pressByTestIdAsync('auth-qr-enter-url');
            expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).not.toHaveLength(0);
            expect(screen.findByTestId('restore-pairing-link-input')).not.toBeNull();
            await act(async () => {
                screen.changeTextByTestId('restore-pairing-link-input', 'unfinished-pairing-link');
            });

            await act(async () => {
                getStorage().setState({ socketStatus: 'connected' });
            });
            expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).toHaveLength(0);
            expect(screen.findByTestId('restore-pairing-link-input')!.props.value).toBe('unfinished-pairing-link');
        },
    );

    it('does not warn while the socket is paused on purpose (hidden or backgrounded) and resuming', async () => {
        getStorage().setState({ socketStatus: 'paused' });
        const screen = await renderScanner({ token: 'test-token', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
        expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).toHaveLength(0);
        await act(async () => {
            getStorage().setState({ socketStatus: 'error' });
        });
        expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).not.toHaveLength(0);
    });

    it('warns on endpoint loss even before the socket status changes', async () => {
        getStorage().setState({ endpointStatus: 'offline' });
        const screen = await renderScanner();
        expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).not.toHaveLength(0);
        await act(async () => {
            getStorage().setState({ endpointStatus: 'online' });
        });
        expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).toHaveLength(0);
    });

    it('does not mistake signed-out Home recovery for a lost authenticated connection', async () => {
        getStorage().setState({ socketStatus: 'disconnected', endpointStatus: 'idle' });
        const screen = await renderScanner();
        expect(screen.findAllHostsByTestId('auth-qr-connection-warning')).toHaveLength(0);
        expect(screen.findByTestId('auth-qr-camera')).not.toBeNull();
    });
});
