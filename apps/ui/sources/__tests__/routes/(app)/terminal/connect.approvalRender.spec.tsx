import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installTerminalRouteCommonModuleMocks } from './terminalRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let routeHash: string | undefined;
const globalWindow = globalThis as typeof globalThis & { window?: Window & typeof globalThis };
const originalWindow = globalWindow.window;

installTerminalRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: '/terminal/connect',
        params: () => routeHash ? { '#': routeHash } : {},
    }).module,
});

const authState = vi.hoisted(() => ({
    isAuthenticated: true,
    credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    refreshFromActiveServer: vi.fn(async () => {}),
}));
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => authState, useOptionalAuth: () => authState }));

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

    it('replaces the displayed request when a second desktop link arrives on the same route', async () => {
        routeHash = globalWindow.window!.location.hash.slice(1);
        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        const screen = await renderScreen(<Screen />);
        expect(screen.findByTestId('terminal-connect-approve')).toBeTruthy();
        expect(screen.getTextContent()).toContain('127.0.0.1:29785');
        routeHash = `key=${'B'.repeat(43)}&server=https%3A%2F%2Fother-home.example.test`;
        await screen.update(<Screen />);
        expect(screen.findByTestId('terminal-connect-approve')).toBeTruthy();
        expect(screen.getTextContent()).toContain('other-home.example.test');
        expect(screen.getTextContent()).not.toContain('127.0.0.1:29785');
    });

});
