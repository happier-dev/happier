import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createMountedCurrentUiContextWrapper } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentRouteLocationProvider, useCurrentRouteSegments } from '@/components/appShell/workspace/currentRouteLocation';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useOptionalCurrentUiContextReader, type CurrentUiContextReader } from './CurrentUiContextProvider';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/workflows/runs/private-run-id', segments: () => ['(app)', 'workflows', 'runs', '[runId]'],
}).module);

let home: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
});

describe('current UI route composition', () => {
    it.each([
        { pathname: '/workflows/new', route: 'workflows/new' },
        { pathname: '/workflows/private-definition-id', route: 'workflows/:id' },
    ])('follows the workspace editor route $route while Expo still mirrors a run', async ({ pathname, route }) => {
        home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://editor-route.test', accountId: 'account-a' }] });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        const Wrapper = await createMountedCurrentUiContextWrapper();
        const observed: { reader: CurrentUiContextReader | null } = { reader: null };
        function ObserveReader() { observed.reader = useOptionalCurrentUiContextReader(); return null; }
        await renderScreen(<CurrentRouteLocationProvider value={{ pathname, params: {} }}>
            <Wrapper><ObserveReader /></Wrapper>
        </CurrentRouteLocationProvider>);
        expect(observed.reader?.readCurrentUiContext()?.navigation.screen).toBe(route);
        expect(JSON.stringify(observed.reader?.readCurrentUiContext())).not.toMatch(/private-definition-id|private-run-id/);
    });

    it('keeps route-pattern readers local to pathname changes rather than pane query writes', async () => {
        let renders = 0;
        let segments: readonly string[] = [];
        function RouteReader() { segments = useCurrentRouteSegments(); renders += 1; return null; }
        const reader = <RouteReader />;
        const tree = (pathname: string, right: string) => <CurrentRouteLocationProvider value={{ pathname, params: { right } }}>
            {reader}
        </CurrentRouteLocationProvider>;
        const screen = await renderScreen(tree('/workflows/new', 'files'));
        expect(segments).toEqual(['workflows', 'new']);
        const before = renders;
        for (const right of ['review', 'terminal']) await screen.update(tree('/workflows/new', right));
        expect(renders).toBe(before);
        await screen.update(tree('/workflows/private-definition-id', 'terminal'));
        expect(segments).toEqual(['workflows', '[id]']);
    });
});
