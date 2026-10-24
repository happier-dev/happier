import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { AuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storageStore';
import { ScanAuthQrScreen } from './ScanAuthQrScreen';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios', select: (values: Record<string, unknown>) => values.ios ?? values.default } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-device', () => ({ isDevice: true }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-camera', () => ({
    CameraView: 'CameraView',
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));

describe('ScanAuthQrScreen connection warning', () => {
    beforeEach(() => {
        storage.setState({ socketStatus: 'connected', endpointStatus: 'online' });
    });

    it.each(['disconnected', 'connecting', 'error'] as const)(
        'warns while %s and clears the warning on reconnection without removing recovery actions',
        async (socketStatus) => {
            storage.setState({ socketStatus });
            const screen = await renderScreen(
                <AuthProvider initialCredentials={{ token: 'test-token', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }}>
                    <ScanAuthQrScreen testIDPrefix="auth-qr" />
                </AuthProvider>,
            );

            expect(screen.findByTestId('auth-qr-connection-warning')).not.toBeNull();
            expect(screen.findByTestId('auth-qr-camera')).not.toBeNull();
            expect(screen.findByTestId('auth-qr-enter-url')).not.toBeNull();

            await act(async () => {
                storage.setState({ socketStatus: 'connected' });
            });

            expect(screen.findByTestId('auth-qr-connection-warning')).toBeNull();
            expect(screen.findByTestId('auth-qr-camera')).not.toBeNull();
        },
    );

    it('warns when endpoint reachability is lost even before the socket status changes', async () => {
        storage.setState({ endpointStatus: 'offline' });
        const screen = await renderScreen(
            <AuthProvider initialCredentials={null}>
                <ScanAuthQrScreen testIDPrefix="auth-qr" />
            </AuthProvider>,
        );
        expect(screen.findByTestId('auth-qr-connection-warning')).not.toBeNull();
        await act(async () => {
            storage.setState({ endpointStatus: 'online' });
        });
        expect(screen.findByTestId('auth-qr-connection-warning')).toBeNull();
    });

    it('does not mistake signed-out recovery for a lost authenticated connection', async () => {
        storage.setState({ socketStatus: 'disconnected', endpointStatus: 'idle' });
        const screen = await renderScreen(
            <AuthProvider initialCredentials={null}>
                <ScanAuthQrScreen testIDPrefix="auth-qr" />
            </AuthProvider>,
        );
        expect(screen.findByTestId('auth-qr-connection-warning')).toBeNull();
        expect(screen.findByTestId('auth-qr-camera')).not.toBeNull();
    });
});
