import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

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

describe('plugin session surface registry', () => {
    it('routes host preview placeholders with local-service browser targets through the preview pane', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        } as const;
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview-1.preview.happier.test/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Dashboard', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const node = renderPluginSessionSurfaceTab({
            tab: {
                ...tab,
                resource: {
                    ...tab.resource,
                    browserTarget,
                },
            },
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                sessionSurfacesById: {
                    'sessionSurface:acme.preview:preview-pane': {
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionSurface',
                        descriptorId: 'preview-pane',
                        surfaceKind: 'previewPane',
                        target: { kind: 'localService', idPath: '/previewId' },
                        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                        display: { titleKey: 'title' },
                    },
                },
            },
            localServicePreviewState: previewState,
            platform: 'web',
            nowMs: () => 1_000,
        } as never);

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('local-service-preview-pane-frame')).toBeTruthy();
    });

    it('routes hosted-web renderer references through the hosted-web fallback pane', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const {
            applyLocalServicePreviewSnapshot,
            createLocalServicePreviewState,
        } = await import('@/sync/domains/local/services/preview/store');
        const browserTarget = {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
        } as const;
        const previewState = applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            previews: [{
                previewId: 'preview_1',
                accessUrl: 'https://preview-1.preview.happier.test/plugin/acme/',
                expiresAt: 2_000,
                diagnostics: [],
                resource: {
                    previewId: 'preview_1',
                    sessionId: 'session_1',
                    machineId: 'machine_1',
                    owner: { kind: 'session', id: 'session_1' },
                    target: { scheme: 'http', host: '127.0.0.1', port: 5173 },
                    initialPath: { pathname: '/', search: '' },
                    display: { title: 'Plugin UI', addressLabel: 'localhost:5173' },
                    originMode: 'host',
                    browserTarget,
                },
            }],
            diagnostics: [],
        });
        const node = renderPluginSessionSurfaceTab({
            tab: {
                ...tab,
                resource: {
                    ...tab.resource,
                    browserTarget,
                },
            },
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                hostedWebById: {
                    'hostedWeb:acme.preview:preview-web': {
                        id: 'hostedWeb:acme.preview:preview-web',
                        pluginId: 'acme.preview',
                        contributionKind: 'hostedWeb',
                        contributionId: 'preview-web',
                        sandbox: { scripts: true },
                    },
                },
                sessionSurfacesById: {
                    'sessionSurface:acme.preview:preview-pane': {
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionSurface',
                        descriptorId: 'preview-pane',
                        surfaceKind: 'previewPane',
                        browserTarget,
                        renderer: { kind: 'hostedWeb', contributionId: 'hostedWeb:acme.preview:preview-web' },
                        display: { titleKey: 'title' },
                    },
                },
            },
            localServicePreviewState: previewState,
            platform: 'web',
            nowMs: () => 1_000,
        });

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('plugin-hosted-web-frame')?.props.src).toBe(
            'https://preview-1.preview.happier.test/plugin/acme/',
        );
    });

    it('routes React Native renderer references through the RN compatibility fallback', async () => {
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
                    },
                },
                sessionSurfacesById: {
                    'sessionSurface:acme.preview:preview-pane': {
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionSurface',
                        descriptorId: 'preview-pane',
                        surfaceKind: 'previewPane',
                        renderer: { kind: 'reactNativeBundle', contributionId: 'reactNativeBundle:acme.preview:native-preview' },
                        display: { titleKey: 'title' },
                    },
                },
            },
        });

        const screen = await renderScreen(<>{node}</>);

        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });

    it('does not render plugin session surfaces with deferred policy until the host can evaluate it', async () => {
        const { renderPluginSessionSurfaceTab } = await import('./sessionSurfaces');
        const node = renderPluginSessionSurfaceTab({
            tab,
            pluginUiProjection: {
                ...EMPTY_PLUGIN_UI_PROJECTION,
                sessionSurfacesById: {
                    'sessionSurface:acme.preview:preview-pane': {
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionSurface',
                        descriptorId: 'preview-pane',
                        surfaceKind: 'previewPane',
                        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                        display: { titleKey: 'title' },
                        visibility: { operand: 'platform.is', value: 'web' },
                    },
                },
            },
        });

        expect(node).toBeNull();
    });
});
