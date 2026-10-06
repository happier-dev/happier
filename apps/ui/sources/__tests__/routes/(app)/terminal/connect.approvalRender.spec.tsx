import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let routeHash: string | undefined;
const globalWindow = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
const originalWindow = globalWindow.window;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) =>
                options.web ?? options.default ?? options.ios ?? options.android,
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        router: {
            back: vi.fn(),
            push: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
        pathname: '/terminal/connect',
        params: () => routeHash ? { '#': routeHash } : {},
    }).module;
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const authState = vi.hoisted(() => ({
    isAuthenticated: true,
    credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    refreshFromActiveServer: vi.fn(async () => {}),
}));
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => authState }));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>()),
    getActiveServerUrl: () => 'http://127.0.0.1:29785',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: vi.fn(async () => true),
}));

describe('TerminalConnectScreen approval render', () => {
    beforeEach(() => {
        vi.resetModules();
        routeHash = undefined;
        globalWindow.window = {
            location: {
                hash: '#key=dMuCgNDDm6evwo2KsBdJoLTGlW62vwlDxkDKsZAg00I&server=http%3A%2F%2F127.0.0.1%3A29785',
                pathname: '/terminal/connect',
                search: '',
                href: 'tauri://localhost/terminal/connect#key=dMuCgNDDm6evwo2KsBdJoLTGlW62vwlDxkDKsZAg00I&server=http%3A%2F%2F127.0.0.1%3A29785',
            },
            history: {
                replaceState: vi.fn(),
            },
        } as unknown as Window & typeof globalThis;
    });

    afterEach(() => {
        standardCleanup();
        if (originalWindow === undefined) {
            Reflect.deleteProperty(globalThis, 'window');
        } else {
            globalWindow.window = originalWindow;
        }
    });

    it('uses router pairing parameters before browser history reaches the terminal route', async () => {
        const location = globalWindow.window!.location;
        routeHash = location.hash.slice(1);
        Object.assign(location, { href: 'tauri://localhost/', pathname: '/', hash: '' });
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.findByTestId('terminal-connect-approve')).toBeTruthy();
        expect(screen.findByTestId('terminal-connect-reject')).toBeTruthy();
    });

    it('renders the approval actions for an authenticated terminal-connect link', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.findByTestId('terminal-connect-surface-card')).toBeTruthy();
        expect(screen.findByTestId('terminal-connect-approve')).toBeTruthy();
        expect(screen.findByTestId('terminal-connect-reject')).toBeTruthy();
    });
    it('replaces the displayed request when a second desktop link arrives on the same route', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        const screen = await renderScreen(<Screen />);
        expect(screen.getTextContent()).toContain('dMuCgNDDm6ev');
        routeHash = `key=${'B'.repeat(43)}&server=http%3A%2F%2F127.0.0.1%3A29785`;
        await screen.update(<Screen />);
        expect(screen.getTextContent()).toContain('BBBBBBBBBBBB');
        expect(screen.getTextContent()).not.toContain('dMuCgNDDm6ev');
    });

});
