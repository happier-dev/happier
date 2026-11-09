// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { createCanonicalPluginReactNativeHostApiAdapter } from '../reactNative/hostApi';
import { createPluginSurfaceHostApi } from '../surfaces/createPluginSurfaceHostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { useUiSurfaceOwnerLifetime } from './useUiSurfaceOwnerLifetime';

it('retains the current API through StrictMode replay and fences only the exact replaced or unmounted adapter', async () => {
    const requestSurface = {
        pluginId: 'acme.detail', contributionId: 'detail', surfaceId: 'detail', sessionId: 'session-1', placement: 'sessionPane' as const,
        platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [],
    };
    const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface });
    expect(host.installedMethods).toContain('context');
    const createAdapter = () => createCanonicalPluginReactNativeHostApiAdapter({
        surface: createPluginSurfaceContextFixture(), requestSurface,
        handleRequest: host.handleRequest, installedMethods: host.installedMethods,
    });
    const first = createAdapter();
    const second = createAdapter();
    function Owner(props: Readonly<{ adapter: ReturnType<typeof createAdapter> }>) {
        useUiSurfaceOwnerLifetime(props.adapter);
        return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await React.act(async () => { root.render(<React.StrictMode><Owner adapter={first} /></React.StrictMode>); });
        await expect(first.api.context()).resolves.toMatchObject({ target: expect.any(Object) });
        await React.act(async () => { root.render(<React.StrictMode><Owner adapter={second} /></React.StrictMode>); });
        await expect(first.api.context()).rejects.toMatchObject({ code: 'stale_surface' });
        await expect(second.api.context()).resolves.toMatchObject({ target: expect.any(Object) });
    } finally {
        await React.act(async () => { root.unmount(); });
        container.remove();
    }
    await expect(second.api.context()).rejects.toMatchObject({ code: 'stale_surface' });
});
