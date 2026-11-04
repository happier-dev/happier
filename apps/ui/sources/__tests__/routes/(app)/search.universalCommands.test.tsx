import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';

const harness = vi.hoisted(() => ({
    controllerProps: null as Record<string, unknown> | null,
    platformOs: 'ios' as 'ios' | 'web',
    routerReplace: vi.fn(),
    routerBack: vi.fn(),
    canGoBack: false,
    params: {} as Record<string, string>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock();
    // The route's one platform decision reads `Platform.OS`; the rest of the web mock stays real.
    Object.defineProperty(native.Platform, 'OS', { configurable: true, get: () => harness.platformOs });
    return native;
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        params: () => harness.params,
        router: { replace: harness.routerReplace, back: harness.routerBack, canGoBack: () => harness.canGoBack },
    }).module;
});

vi.mock('@/components/appShell/search/UniversalSearchController', () => ({
    UniversalSearchController: (props: Record<string, unknown>) => {
        harness.controllerProps = props;
        return React.createElement('UniversalSearchController', props);
    },
}));

afterEach(() => {
    harness.controllerProps = null;
    harness.platformOs = 'ios';
    harness.canGoBack = false;
    harness.params = { q: 'needle', sessionId: 'captured-session', serverId: 'home-a', accountId: 'account-a' };
    harness.routerReplace.mockClear();
    harness.routerBack.mockClear();
    standardCleanup();
});
harness.params = { q: 'needle', sessionId: 'captured-session', serverId: 'home-a', accountId: 'account-a' };

describe('/search Universal Search command context', () => {
    it('builds native route commands for the Session captured by the Search invocation', async () => {
        const buildCommands = vi.fn(() => [{
            id: 'session-only-command',
            title: 'Session-only command',
            action: vi.fn(),
        }]);
        const Route = (await import('@/app/(app)/search')).default;

        await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open: vi.fn(), buildCommands }}>
                <Route />
            </UniversalSearchRuntimeProvider>,
        );

        expect(buildCommands).toHaveBeenCalledWith('captured-session', expect.objectContaining({
            sessionId: 'captured-session',
            serverId: 'home-a',
        }), undefined);
        expect(harness.controllerProps?.commands).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'session-only-command' }),
        ]));
    });

    it('opens the one Search modal from a web link, carrying its query and scope, and draws no page of its own', async () => {
        harness.platformOs = 'web';
        harness.params = { q: 'needle', source: 'fileContent', replace: '1', sessionId: 'captured-session', serverId: 'home-a', accountId: 'account-a' };
        const open = vi.fn();
        const Route = (await import('@/app/(app)/search')).default;

        const screen = await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open, buildCommands: vi.fn(() => []) }}>
                <Route />
            </UniversalSearchRuntimeProvider>,
        );

        expect(open).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledWith('needle', expect.objectContaining({ sessionId: 'captured-session', serverId: 'home-a', accountId: 'account-a' }),
            expect.objectContaining({ source: 'fileContent', replace: true }));
        expect(harness.controllerProps).toBeNull();
        expect(screen.root.findAll((node) => node.props?.testID === 'universal-search-route-page')).toHaveLength(0);
        // The link is spent: a direct visit lands on the shell, so closing Search leaves the person there.
        expect(harness.routerReplace).toHaveBeenCalledWith('/');
        expect(harness.routerBack).not.toHaveBeenCalled();
    });

    it('returns to the page the person came from when a web link arrives inside the app', async () => {
        harness.platformOs = 'web';
        harness.canGoBack = true;
        harness.params = {};
        const open = vi.fn();
        const Route = (await import('@/app/(app)/search')).default;

        await renderScreen(
            <UniversalSearchRuntimeProvider value={{ open, buildCommands: vi.fn(() => []) }}>
                <Route />
            </UniversalSearchRuntimeProvider>,
        );

        expect(open).toHaveBeenCalledWith(undefined, undefined, {});
        expect(harness.routerBack).toHaveBeenCalledTimes(1);
        expect(harness.routerReplace).not.toHaveBeenCalled();
    });
});
