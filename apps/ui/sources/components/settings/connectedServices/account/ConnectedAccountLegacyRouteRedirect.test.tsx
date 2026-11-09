import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { ConnectedAccountLegacyRouteRedirect } from './ConnectedAccountLegacyRouteRedirect';

const routeState = vi.hoisted(() => ({
    serviceId: 'github',
    profileId: undefined as string | undefined,
    groupId: undefined as string | undefined,
    add: undefined as string | undefined,
}));
const replace = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// This route journey does not render Markdown; fail if the unavailable third-party export is used.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in account routing'); },
}));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => ({ ...routeState }),
    router: { replace },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(standardCleanup);

describe('ConnectedAccountLegacyRouteRedirect', () => {
    beforeEach(() => {
        routeState.serviceId = 'github';
        routeState.profileId = undefined;
        routeState.groupId = undefined;
        routeState.add = undefined;
        replace.mockReset();
        // Use the real projection owner and its released built-in fallback, not a hook mock.
        installConnectedAccountDescriptorProjection({
            scopeKey: getActiveServerSnapshot().serverId,
            status: 'ready', descriptors: [], conflicts: [], errorReason: null,
        });
    });

    it('preserves an exact legacy account focus while replacing the scalar route', async () => {
        routeState.profileId = 'work';
        await renderScreen(<ConnectedAccountLegacyRouteRedirect />);
        expect(replace).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services/account',
            params: { pluginId: 'happier.scm.forge.github', localId: 'github-account', accountId: 'work' },
        });
    });

    it('replaces a service-only scalar link with the Collection', async () => {
        await renderScreen(<ConnectedAccountLegacyRouteRedirect />);
        expect(replace).toHaveBeenCalledWith({
            pathname: '/(app)/settings/connected-services', params: {},
        });
    });

    it.each(['vault', 'foreign', 'not a service'])('rejects novel or malformed scalar %s', async (serviceId) => {
        routeState.serviceId = serviceId;
        const screen = await renderScreen(<ConnectedAccountLegacyRouteRedirect />);
        expect(replace).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('connectedServices.detail.unknownService');
    });
});
