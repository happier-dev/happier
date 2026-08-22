import * as React from 'react';
import {
    PLUGIN_UI_HOST_METHODS_V1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { createCanonicalPluginReactNativeHostApiAdapter } from './hostApi';

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

function createCanonicalRenderContextFixture(): Readonly<{
    renderContext: RenderContext;
    dispose(): void;
}> {
    const surface = createPluginSurfaceContextFixture({
        target: { kind: 'session', sessionId: 'session-1' },
    });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface,
        requestSurface: surfaceContext,
        requestIdPrefix: 'rn:loader-test',
        handleRequest: async () => ({ accepted: true }),
        installedMethods: PLUGIN_UI_HOST_METHODS_V1,
    });
    return Object.freeze({
        renderContext: Object.freeze({
            plugin: Object.freeze({ id: 'acme.preview', version: '2.1.0' }),
            surface,
            hostApi: adapter.api,
            signal: new AbortController().signal,
        }) satisfies RenderContext,
        dispose: () => adapter.dispose(),
    });
}

describe('PluginReactNativeSurface loader integration', () => {
    it('loads installed artifacts through the loader policy and passes the canonical render context', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const renderSurface = vi.fn(() => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }));
        const load = vi.fn(async () => ({ renderSurface }));
        const canonical = createCanonicalRenderContextFixture();

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                renderContext={canonical.renderContext}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_1"
                loadTimeoutMs={1000}
            />);
            await flushHookEffects();

            expect(load).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
            expect(renderSurface).toHaveBeenCalledWith(expect.objectContaining({
                plugin: canonical.renderContext.plugin,
                surface: canonical.renderContext.surface,
                hostApi: canonical.renderContext.hostApi,
                signal: canonical.renderContext.signal,
            }));
        } finally {
            canonical.dispose();
        }
    });

    it('names the plugin, the surface and the thrown error when an artifact load fails', async () => {
        const { PluginReactNativeSurface } = await import('./PluginReactNativeSurface');
        const { log } = await import('@/log');
        const logged = vi.spyOn(log, 'log').mockImplementation(() => undefined);
        const load = vi.fn(async () => {
            throw new Error('happier plugin host runtime "react" is not installed');
        });
        const canonical = createCanonicalRenderContextFixture();

        try {
            await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                renderContext={canonical.renderContext}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_load_failure_1"
                loadTimeoutMs={1000}
            />);
            await flushHookEffects();

            expect(load).toHaveBeenCalledTimes(1);
            const messages = logged.mock.calls.map(([message]) => String(message));
            const reported = messages.find((message) => message.includes('load_error'));
            expect(reported).toBeDefined();
            expect(reported).toContain('acme.preview');
            expect(reported).toContain('surface_1');
            expect(reported).toContain('happier plugin host runtime');
        } finally {
            logged.mockRestore();
            canonical.dispose();
        }
    });

    it('projects a Re.Pack surface through the installed-artifact loader without a sibling startup protocol', async () => {
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
                    })),
                },
            },
            loadInstalledBundle: createRepackInstalledArtifactModuleLoader({
                resolveInstalledArtifactFileUrl: vi.fn(async () => 'file:///cache/ios.bundle'),
            }),
        });
        const loaded = await loadPluginReactNativeBundleModule({
            cache,
            identity,
            backend,
        });
        if (!loaded.ok) throw loaded;
        expect(Object.keys(loaded.module)).toEqual(['renderSurface']);
        const load = vi.fn(async () => loaded.module);
        const canonical = createCanonicalRenderContextFixture();

        try {
            const screen = await renderScreen(<PluginReactNativeSurface
                surfaceId="surface_1"
                decision={{ state: 'load', reason: 'compatible', diagnostics: [] }}
                renderContext={canonical.renderContext}
                load={load}
                loadPolicy={{ source: 'installedArtifact' }}
                cacheKey="cache_ack_1"
                loadTimeoutMs={1000}
            />);
            await flushHookEffects();

            expect(load).toHaveBeenCalledTimes(1);
            expect(screen.findByTestId('plugin-native-surface')).toBeTruthy();
        } finally {
            canonical.dispose();
        }
    });
});
