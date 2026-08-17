import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const routeState = vi.hoisted(() => ({
    serviceId: 'github',
    profileId: undefined as string | undefined,
    groupId: undefined as string | undefined,
}));
const routerReplaceMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', () => ({
    useLocalSearchParams: () => ({ ...routeState }),
    useRouter: () => ({ replace: routerReplaceMock }),
}));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemList', props, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));
vi.mock('@/components/appShell/plugins/AppShellPluginUiProjection', () => ({
    useProjectedConnectedServicesRegistry: () => ({
        scopeKey: 'server-a',
        status: 'ready',
        entries: [{
            serviceId: 'github',
            service: {
                pluginId: 'happier.scm.forge.github',
                localId: 'github-account',
            },
            legacyServiceId: 'github',
            connectCommand: 'happier connect github',
            supportsOauth: true,
            executable: true,
        }, {
            serviceId: 'vault',
            service: {
                pluginId: 'acme.connected-accounts-conformance',
                localId: 'vault',
            },
            connectCommand: 'happier connect acme.connected-accounts-conformance/vault',
            supportsOauth: false,
            executable: true,
        }],
        errorReason: null,
    }),
}));

describe('ConnectedAccountLegacyRouteRedirect', () => {
    beforeEach(() => {
        routeState.serviceId = 'github';
        routeState.profileId = undefined;
        routeState.groupId = undefined;
        routerReplaceMock.mockReset();
    });

    it('preserves an exact legacy account focus while replacing the scalar route', async () => {
        routeState.profileId = 'work';
        const { ConnectedAccountLegacyRouteRedirect } = await import(
            './ConnectedAccountLegacyRouteRedirect'
        );
        await renderScreen(<ConnectedAccountLegacyRouteRedirect />);

        await vi.waitFor(() => {
            expect(routerReplaceMock).toHaveBeenCalledWith({
                pathname: '/(app)/settings/connected-services/account',
                params: {
                    pluginId: 'happier.scm.forge.github',
                    localId: 'github-account',
                    accountId: 'work',
                },
            });
        });
    });

    it('replaces a built-in scalar link with the exact projected qualified route', async () => {
        const { ConnectedAccountLegacyRouteRedirect } = await import(
            './ConnectedAccountLegacyRouteRedirect'
        );
        await renderScreen(<ConnectedAccountLegacyRouteRedirect />);

        await vi.waitFor(() => {
            expect(routerReplaceMock).toHaveBeenCalledWith({
                pathname: '/(app)/settings/connected-services/account',
                params: {
                    pluginId: 'happier.scm.forge.github',
                    localId: 'github-account',
                },
            });
        });
    });

    it.each(['vault', 'foreign', 'not a service'])(
        'does not treat malformed or novel scalar %s as a route authority',
        async (serviceId) => {
            routeState.serviceId = serviceId;
            const { ConnectedAccountLegacyRouteRedirect } = await import(
                './ConnectedAccountLegacyRouteRedirect'
            );
            const rendered = await renderScreen(<ConnectedAccountLegacyRouteRedirect />);

            expect(routerReplaceMock).not.toHaveBeenCalled();
            expect(rendered.tree.findByType('Item' as never).props.title).toBe(
                'connectedServices.detail.unknownService',
            );
        },
    );
});
