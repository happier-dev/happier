import * as React from 'react';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const surfaceContext: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    surfaceId: 'surface_1',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'ios',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

describe('PluginReactNativeSurface loader integration', () => {
    it('loads installed artifacts through the loader policy and passes only host API plus surface context', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createPluginReactNativeHostApiAdapter } = await import('./hostApi');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const acknowledgeHostRuntime = vi.fn();
        const load = vi.fn(async () => ({ renderSurface, acknowledgeHostRuntime }));
        const hostApiAdapter = createPluginReactNativeHostApiAdapter({
            surface: surfaceContext,
            requestIdPrefix: 'rn:test',
            handleRequest: vi.fn(async () => ({ accepted: true })),
        });

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            surface={surfaceContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            hostApi={hostApiAdapter.api}
            load={load}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_1"
            loadTimeoutMs={1000}
        />);
        await flushHookEffects();

        expect(load).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
        expect(renderSurface).toHaveBeenCalledWith({
            hostApi: expect.objectContaining({
                requestSessionResource: expect.any(Function),
                dispatchAction: expect.any(Function),
            }),
            surface: surfaceContext,
        });
        expect(acknowledgeHostRuntime).toHaveBeenCalledWith({
            surfaceId: 'surface_1',
            cacheKey: 'cache_1',
        });
    });

    it('preserves a Re.Pack module runtime acknowledgment through the installed-artifact loader', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { createPluginReactNativeBundleCache } = await import('./bundleCache');
        const {
            createRepackInstalledArtifactModuleLoader,
            createRepackScriptManagerBackendFromClient,
            loadPluginReactNativeBundleModule,
        } = await import('./loader');
        const renderSurface = vi.fn(() =>
            React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' })
        );
        const acknowledgeHostRuntime = vi.fn();
        const identity = {
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'ios',
            channel: 'internal',
            nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            projectionGeneration: 12,
        } as const;
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({
            identity,
            bytes: new TextEncoder().encode('// installed Re.Pack container'),
            format: 'plainJs',
        });
        const backend = createRepackScriptManagerBackendFromClient({
            client: {
                ScriptManager: {
                    shared: {
                        addResolver: vi.fn(),
                        removeResolver: vi.fn(),
                        loadScript: vi.fn(async () => undefined),
                    },
                },
                Federated: {
                    importModule: vi.fn(async () => ({
                        renderSurface,
                        acknowledgeHostRuntime,
                    })),
                },
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/ios.bundle.js'),
            }),
        });
        const load = vi.fn(async () => {
            const result = await loadPluginReactNativeBundleModule({
                cache,
                identity,
                backend,
            });
            if (!result.ok) {
                throw result;
            }
            return result.module;
        });

        const screen = await renderScreen(<PluginReactNativeSurface
            surfaceId="surface_1"
            surface={surfaceContext}
            decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
            load={load}
            loadPolicy={{ source: 'installedArtifact' }}
            cacheKey="cache_ack_1"
            loadTimeoutMs={1000}
        />);
        await flushHookEffects();

        expect(load).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
        expect(acknowledgeHostRuntime).toHaveBeenCalledWith({
            surfaceId: 'surface_1',
            cacheKey: 'cache_ack_1',
        });
    });
});
