import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { PendingTerminalConnect } from '@/sync/domains/pending/pendingTerminalConnect.shared';
import { installTerminalRouteCommonModuleMocks } from './terminalRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const getPendingTerminalConnectMock = vi.fn<() => PendingTerminalConnect | null>(() => null);
const globalWindow = globalThis as unknown as { window?: Window };
const originalWindow = globalWindow.window;

installTerminalRouteCommonModuleMocks();

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    setPendingTerminalConnect: vi.fn(),
    clearPendingTerminalConnect: vi.fn(),
    getPendingTerminalConnect: getPendingTerminalConnectMock,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://api.happier.dev',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    normalizeServerUrl: (value: string) => String(value ?? '').trim().replace(/\/+$/, ''),
    upsertActivateAndSwitchServer: vi.fn(async () => true),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ processAuthUrl: vi.fn(async () => {}), isLoading: false }),
}));

describe('TerminalConnectScreen hash parsing', () => {
    beforeEach(() => {
        vi.resetModules();
        getPendingTerminalConnectMock.mockReset();
        globalWindow.window = {
            location: {
                hash: '#server=https%3A%2F%2Fexample.test&key=abcdefghijklmnop',
                pathname: '/terminal/connect',
                search: '',
                href: 'https://ui.example.test/terminal/connect#server=https%3A%2F%2Fexample.test&key=abcdefghijklmnop',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;
    });

    afterEach(() => {
        standardCleanup();
        if (originalWindow === undefined) {
            Reflect.deleteProperty(globalThis, 'window');
        } else {
            globalWindow.window = originalWindow;
        }
    });

    it('parses key even when it is not the first hash parameter', async () => {
        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const renderedItems = screen.findAllByType('Item' as any);
        const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
        expect(publicKeyItem).toBeTruthy();
        expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
        expect(globalWindow.window?.history.replaceState).toHaveBeenCalled();
    });

    it('shows invalid-link state when hash contains no key parameter', async () => {
        globalWindow.window = {
            location: {
                hash: '#server=https%3A%2F%2Fexample.test',
                pathname: '/terminal/connect',
                search: '',
                href: 'https://ui.example.test/terminal/connect#server=https%3A%2F%2Fexample.test',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;

        const Screen = (await import('@/app/(app)/terminal/connect')).default;
        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        expect(screen.getTextContent()).toContain('terminal.invalidConnectionLink');
    });

    it('restores key from pending terminal connect when hash is empty (dev strict-mode remount safety)', async () => {
        getPendingTerminalConnectMock.mockReturnValue({
            publicKeyB64Url: 'abcdefghijklmnop',
            serverUrl: 'https://example.test',
        });

        globalWindow.window = {
            location: {
                hash: '',
                pathname: '/terminal/connect',
                search: '',
                href: 'https://ui.example.test/terminal/connect',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;

        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const renderedItems = screen.findAllByType('Item' as any);
        const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
        expect(publicKeyItem).toBeTruthy();
        expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
    });

    it('parses key from the query string when hash is empty', async () => {
        globalWindow.window = {
            location: {
                hash: '',
                pathname: '/terminal/connect',
                search: '?server=https%3A%2F%2Fexample.test&key=abcdefghijklmnop',
                href: 'https://ui.example.test/terminal/connect?server=https%3A%2F%2Fexample.test&key=abcdefghijklmnop',
            },
            history: { replaceState: vi.fn() },
        } as unknown as Window;

        const Screen = (await import('@/app/(app)/terminal/connect')).default;

        const screen = await renderScreen(<Screen />);
        await act(async () => {});

        const renderedItems = screen.findAllByType('Item' as any);
        const publicKeyItem = renderedItems.find((item) => item.props?.title === 'terminal.publicKey');
        expect(publicKeyItem).toBeTruthy();
        expect(publicKeyItem?.props?.detail).toBe('abcdefghijkl...');
    });
});
