import React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';
import { installServerRouteCommonModuleMocks } from './serverRouteTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installServerRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            KeyboardAvoidingView: 'KeyboardAvoidingView',
            Platform: {
                OS: 'web',
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    surface: '#fff',
                    groupped: { background: '#fff' },
                    text: '#000',
                    textSecondary: '#666',
                    textDestructive: '#f00',
                    input: { background: '#fff', text: '#000', placeholder: '#999' },
                    status: { connecting: '#00f', connected: '#0f0' },
                    divider: '#ccc',
                    button: { secondary: { tint: '#333' } },
                    deleteAction: '#f00',
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) => React.createElement('Ionicons', props),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => null),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => null),
    },
    isLegacyAuthCredentials: (credentials: unknown) => Boolean(credentials),
}));

describe('ServerConfigScreen (web row actions)', () => {
    it('adds per-row device switch action for server rows on web', async () => {
        const { upsertServerProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const company = upsertServerProfile({ serverUrl: 'https://company.example.test', name: 'Company' });
        setActiveServerId(company.id, { scope: 'device' });

        const Screen = (await import('@/app/(app)/settings/server')).default;
        const screen = await renderScreen(React.createElement(Screen));

        const companyRow = findTestInstanceByTypeWithProps(screen.tree, 'ItemRowActions' as any, { title: 'Company' }) as any;
        expect(companyRow).toBeTruthy();
        const actionIds = new Set((companyRow?.props?.actions ?? []).map((a: any) => a.id));
        expect(actionIds.has('switch-device')).toBe(true);
        expect(actionIds.has('switch-tab')).toBe(false);
    }, 40_000);
});
