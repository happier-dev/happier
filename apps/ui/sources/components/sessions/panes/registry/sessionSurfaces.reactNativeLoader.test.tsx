import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { encodeBase64 } from '@/encryption/base64';
import { renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reactNativeSurfaceProps: unknown[] = [];
const fetchReactNativeInstalledArtifactBytesViaMachineRpcMock = vi.hoisted(() => vi.fn());
const loadInstalledBundleMock = vi.hoisted(() => vi.fn(async () => () => null));
const reportReactNativeCrashDisableViaMachineRpcMock = vi.hoisted(() => vi.fn(async () => ({
    ok: true,
    disabled: true,
})));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', () => ({
    PluginReactNativeSurface: (props: Record<string, unknown>) => {
        reactNativeSurfaceProps.push(props);
        return React.createElement('PluginReactNativeSurfaceMock', { testID: 'plugin-rn-surface' });
    },
}));

vi.mock('@/components/plugins/reactNative/bundleCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/plugins/reactNative/bundleCache')>();
    return {
        ...actual,
        fetchReactNativeInstalledArtifactBytesViaMachineRpc: fetchReactNativeInstalledArtifactBytesViaMachineRpcMock,
    };
});

vi.mock('@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend', () => ({
    resolveDefaultReactNativeLoaderBackend: () => ({
        backendId: 'repackScriptManager',
        available: true,
        loadInstalledBundle: loadInstalledBundleMock,
    }),
}));

vi.mock('@/sync/domains/plugins/ui/reactNativeCrashReports', () => ({
    reportReactNativeCrashDisableViaMachineRpc: reportReactNativeCrashDisableViaMachineRpcMock,
}));

const tab = {
    key: 'plugin:preview',
    kind: 'pluginSessionSurface',
    title: 'Preview',
    isPinned: true,
    isPreview: false,
    resource: {
        kind: 'pluginSessionSurface',
        surfaceId: 'sessionSurface:acme.preview:preview-pane',
    },
} as const;

describe('plugin session surface React Native loader routing', () => {
    beforeEach(() => {
        reactNativeSurfaceProps.length = 0;
        fetchReactNativeInstalledArtifactBytesViaMachineRpcMock.mockReset();
        loadInstalledBundleMock.mockClear();
        reportReactNativeCrashDisableViaMachineRpcMock.mockClear();
    });

    it('routes loadable RN projections to the loader-backed surface instead of permanent unavailable diagnostics', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderPluginSessionSurfaceTab({
            tab,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                reactNativeBundlesById: {
                    'reactNativeBundle:acme.preview:native-preview': {
                        id: 'reactNativeBundle:acme.preview:native-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'reactNativeBundle',
                        contributionId: 'native-preview',
                        runtime: {
                            state: 'loadable',
                            decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                            loadPolicy: { source: 'installedArtifact', featureEnabled: true, loaderBackendAvailable: true },
                            cacheKey: 'cache_1',
                            cacheIdentity: {
                                pluginId: 'acme.preview',
                                contributionId: 'native-preview',
                                artifactDigest: 'sha256:bundle',
                                hostAppVersion: '2.0.0',
                                hostUiApiVersion: '1.0.0',
                                reactVersion: '19.0.0',
                                reactNativeVersion: '0.83.4',
                                platform: 'ios',
                                channel: 'internal',
                                nativeCapabilitiesDigest: 'sha256:native-capabilities',
                                projectionGeneration: 12,
                            },
                        },
                    },
                },
                surfacePlacementsByPlacement: {
                    'session.preview': [{
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'preview-pane',
                        placement: 'session.preview',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        renderer: { kind: 'reactNative', contributionId: 'reactNativeBundle:acme.preview:native-preview' },
                        display: { titleKey: 'title' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    }],
                },
            },
        });

        const screen = await renderScreen(<>{node}</>);
        const props = reactNativeSurfaceProps.at(-1) as {
            decision: { state: string; diagnostics: readonly string[] };
            loadPolicy: { source: string };
            cacheKey: string;
            cacheIdentity: unknown;
            onCrashDisable?: (event: unknown) => Promise<void> | void;
            load?: () => Promise<unknown>;
        };

        expect(await screen.findByTestId('plugin-rn-surface')).toBeTruthy();
        expect(props.decision.state).toBe('load');
        expect(props.decision.diagnostics).not.toContain('react_native_loader_unavailable');
        expect(props.loadPolicy).toEqual({
            source: 'installedArtifact',
        });
        expect(props.cacheKey).toBe('cache_1');
        expect(props.cacheIdentity).toEqual({
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: 'sha256:bundle',
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'ios',
            channel: 'internal',
            nativeCapabilitiesDigest: 'sha256:native-capabilities',
            projectionGeneration: 12,
        });
        expect(props.onCrashDisable).toBeUndefined();
        expect(typeof props.load).toBe('function');
    });

    it('preloads installed RN artifact bytes from the owning machine before loading the cached module', async () => {
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const entryPath = 'react-native/native-preview/ios.bundle.js';
        const entryDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const digest = computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: entryPath, bytes }]);
        const artifactGraph = {
            contributionId: 'native-artifact',
            tier: 'reactNative' as const,
            platform: 'ios' as const,
            entry: entryPath,
            files: [{
                relativePath: entryPath,
                digest: entryDigest,
                byteSize: bytes.byteLength,
            }],
            digest,
            builtWith: { bundler: 'repack' as const, version: '5.2.5' },
            repack: {
                containerName: 'acme_preview_native',
                modulePath: './renderSurface',
                exportName: 'renderSurface',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.0.0', reactNative: '0.83.4' },
        };
        const cacheIdentity = {
            pluginId: 'acme.preview',
            contributionId: 'native-preview',
            artifactDigest: digest,
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            platform: 'ios',
            channel: 'internal',
            nativeCapabilitiesDigest: `sha256:${'c'.repeat(64)}`,
            projectionGeneration: 12,
        } as const;
        fetchReactNativeInstalledArtifactBytesViaMachineRpcMock.mockResolvedValueOnce({
            ok: true,
            cacheIdentity,
            artifact: {
                pluginId: 'acme.preview',
                contributionId: 'native-preview',
                artifactKind: 'reactNativeBundle',
                digest,
                format: 'plainJs',
                byteSize: bytes.byteLength,
            },
            bytesBase64: encodeBase64(bytes),
            files: [{
                relativePath: entryPath,
                digest: entryDigest,
                byteSize: bytes.byteLength,
                bytesBase64: encodeBase64(bytes),
            }],
        });

        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderPluginSessionSurfaceTab({
            tab,
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'ios',
            nowMs: () => 1234,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                generation: 12,
                reactNativeBundlesById: {
                    'reactNativeBundle:acme.preview:native-preview': {
                        id: 'reactNativeBundle:acme.preview:native-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'reactNativeBundle',
                        contributionId: 'native-preview',
                        generatedV2: true,
                        artifactGraph,
                        runtime: {
                            state: 'loadable',
                            decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                            loadPolicy: { source: 'installedArtifact', featureEnabled: true, loaderBackendAvailable: true },
                            cacheKey: 'cache_1',
                            cacheIdentity,
                        },
                    },
                },
                surfacePlacementsByPlacement: {
                    'session.preview': [{
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'preview-pane',
                        placement: 'session.preview',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        renderer: { kind: 'reactNative', contributionId: 'reactNativeBundle:acme.preview:native-preview' },
                        display: { titleKey: 'title' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    }],
                },
            },
        });

        await renderScreen(<>{node}</>);
        const props = reactNativeSurfaceProps.at(-1) as {
            cacheIdentity: unknown;
            onCrashDisable?: (event: unknown) => Promise<void> | void;
            load?: () => Promise<unknown>;
        };

        await expect(props.load?.()).resolves.toMatchObject({
            renderSurface: expect.any(Function),
        });
        expect(props.cacheIdentity).toEqual(cacheIdentity);
        expect(props.onCrashDisable).toEqual(expect.any(Function));
        await props.onCrashDisable?.({
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            cacheKey: 'cache_1',
            cacheIdentity,
            disabledReason: 'render_error_threshold',
            crashCount: 2,
            startupFailureCount: 0,
        });
        expect(reportReactNativeCrashDisableViaMachineRpcMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            surfaceId: 'sessionSurface:acme.preview:preview-pane',
            cacheIdentity,
            disabledReason: 'render_error_threshold',
            crashCount: 2,
            startupFailureCount: 0,
            observedAtMs: 1234,
            diagnostics: ['render_error_threshold'],
        });
        expect(fetchReactNativeInstalledArtifactBytesViaMachineRpcMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-1',
            identity: cacheIdentity,
        });
        expect(loadInstalledBundleMock).toHaveBeenCalledWith({
            identity: cacheIdentity,
            bytes,
            files: [expect.objectContaining({
                relativePath: entryPath,
                digest: entryDigest,
                byteSize: bytes.byteLength,
                bytes,
            })],
            entryRelativePath: entryPath,
            moduleReference: artifactGraph.repack,
        });
    });
});
