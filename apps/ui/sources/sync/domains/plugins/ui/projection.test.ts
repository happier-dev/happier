import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';

import {
    normalizePluginUiProjection,
    resolvePluginUiProjectionState,
} from './projection';

function createProjection(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 12,
        installedPackagesById: {},
        providersById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        hooksById: {},
        resourcesById: {},
        uiDescriptorsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: {
                    'translations:acme.preview': {
                        id: 'translations:acme.preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'translations',
                        locales: ['en'],
                        bundles: {
                            en: {
                                title: 'Preview',
                            },
                        },
                    },
                    'structuredMessage:acme.preview:preview-card': {
                        id: 'structuredMessage:acme.preview:preview-card',
                        pluginId: 'acme.preview',
                        contributionKind: 'structuredMessage',
                        descriptorId: 'preview-card',
                        kind: 'acme.preview/preview-card.v1',
                        renderer: { kind: 'host', rendererId: 'summaryCard' },
                        display: { titleKey: 'title' },
                    },
                    'sessionSurface:acme.preview:preview-pane': {
                        id: 'sessionSurface:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionSurface',
                        descriptorId: 'preview-pane',
                        surfaceKind: 'previewPane',
                        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                        display: { titleKey: 'title' },
                    },
                    'sessionHeaderAction:acme.preview:open-preview': {
                        id: 'sessionHeaderAction:acme.preview:open-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionHeaderAction',
                        descriptorId: 'open-preview',
                        action: { id: 'open-preview', kind: 'openSurface', labelKey: 'title' },
                        display: { titleKey: 'title' },
                    },
                    'hostedWeb:acme.preview:preview-web': {
                        id: 'hostedWeb:acme.preview:preview-web',
                        pluginId: 'acme.preview',
                        contributionKind: 'hostedWeb',
                        contributionId: 'preview-web',
                        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                        fallback: { kind: 'unavailable' },
                    },
                    'reactNativeBundle:acme.preview:native-preview': {
                        id: 'reactNativeBundle:acme.preview:native-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'reactNativeBundle',
                        contributionId: 'native-preview',
                        compatibility: {
                            reactVersion: '19.0.0',
                            reactNativeVersion: '0.79.0',
                        },
                        fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                    },
                    'uiArtifact:acme.preview:native-preview-ios': {
                        id: 'uiArtifact:acme.preview:native-preview-ios',
                        pluginId: 'acme.preview',
                        contributionKind: 'uiArtifact',
                        artifactId: 'native-preview-ios',
                        integrity: { digest: 'sha256:bundle' },
                    },
                    'digest:acme.preview': {
                        id: 'digest:acme.preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'digest',
                        digest: 'sha256:projection',
                        families: {
                            structuredMessages: 'sha256:structured',
                        },
                    },
                    'unknown:acme.preview': {
                        id: 'unknown:acme.preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'futureUnknown',
                        payload: { ignored: true },
                    },
                },
            },
        },
        diagnostics: [],
    };
}

describe('plugin UI projection normalization', () => {
    it('normalizes pluginUi family entries into stable typed lookup maps and preserves unknown contribution kinds', () => {
        const model = normalizePluginUiProjection(createProjection());

        expect(model.generation).toBe(12);
        expect(model.translationsByPluginId['acme.preview']?.locales).toEqual(['en']);
        expect(model.structuredMessagesByKind['acme.preview/preview-card.v1']).toMatchObject({
            id: 'structuredMessage:acme.preview:preview-card',
            pluginId: 'acme.preview',
            descriptorId: 'preview-card',
        });
        expect(model.sessionSurfacesById['sessionSurface:acme.preview:preview-pane']).toMatchObject({
            surfaceKind: 'previewPane',
        });
        expect(model.sessionHeaderActionsById['sessionHeaderAction:acme.preview:open-preview']).toMatchObject({
            descriptorId: 'open-preview',
        });
        expect(model.hostedWebById['hostedWeb:acme.preview:preview-web']).toMatchObject({
            contributionId: 'preview-web',
        });
        expect(model.reactNativeBundlesById['reactNativeBundle:acme.preview:native-preview']).toMatchObject({
            fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
        });
        expect(model.uiArtifactsById['uiArtifact:acme.preview:native-preview-ios']).toMatchObject({
            integrity: { digest: 'sha256:bundle' },
        });
        expect(model.digestsByPluginId['acme.preview']).toMatchObject({
            digest: 'sha256:projection',
            families: { structuredMessages: 'sha256:structured' },
        });
        expect(model.unknownEntriesById['unknown:acme.preview']).toMatchObject({
            id: 'unknown:acme.preview',
            pluginId: 'acme.preview',
            contributionKind: 'futureUnknown',
        });
    });

    it('keeps the previous model while a projection refresh is unsupported or unresolved', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, null)).toBe(previous);
        expect(resolvePluginUiProjectionState(previous, { v: 1, providersById: {}, backendsById: {} })).toBe(previous);
    });
});
