import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, pressTestInstanceAsync } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { ConnectionStatusControl } from './ConnectionStatusControl';

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
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

describe('ConnectionStatusControl retry progress', () => {
    it('follows live connection progress and the retry schedule while the popover stays open', async () => {
        const retryAt = Date.now() + 60_000;
        storage.setState({ socketStatus: 'disconnected', endpointStatus: 'offline', endpointNextRetryAt: retryAt });
        const screen = await renderScreen(
            <AuthProvider initialCredentials={null}>
                <ConnectionStatusControl variant="sidebar" />
            </AuthProvider>,
        );
        await act(async () => {
            await pressTestInstanceAsync(screen.findByProps({ accessibilityRole: 'button' }));
        });

        expect(screen.findByTestId('connection-popover-health-status')).not.toBeNull();
        expect(screen.findByTestId('connection-popover-next-retry')).not.toBeNull();
        expect(screen.findByTestId('connection-popover-retry-progress')).toBeNull();

        await act(async () => {
            storage.setState({ endpointStatus: 'connecting', endpointNextRetryAt: null });
        });
        expect(screen.findByTestId('connection-popover-retry-progress')).not.toBeNull();
        expect(screen.findByTestId('connection-popover-retry')?.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
        expect(screen.findByTestId('connection-popover-next-retry')).toBeNull();

        await act(async () => {
            storage.setState({ endpointStatus: 'offline', endpointNextRetryAt: retryAt });
        });
        expect(screen.findByTestId('connection-popover-retry-progress')).toBeNull();
        expect(screen.findByTestId('connection-popover-next-retry')).not.toBeNull();

        await act(async () => {
            storage.setState({ endpointStatus: 'online', endpointNextRetryAt: null, socketStatus: 'connected' });
        });
        expect(screen.findByTestId('connection-popover-retry')).toBeNull();
        expect(screen.findByTestId('connection-popover-next-retry')).toBeNull();
    });
});
