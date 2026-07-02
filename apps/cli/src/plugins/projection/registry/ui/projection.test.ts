import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '../projection/v2';
import type { ResolvedContributionRegistry } from '../types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        providers: [],
        backends: [],
        actions: [],
        tools: [],
        commands: [],
        resources: [],
        uiDescriptors: [],
        activationTargets: [],
        hookRegistrations: [],
        lifecycleHandlers: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
        uiDescriptorsById: new Map(),
        lifecycleHandlersById: new Map(),
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: {},
        providerDefinitionsById: new Map(),
        backendDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

const display = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
};

describe('plugin UI projection family', () => {
    it('projects descriptor, hosted web, executable bundle, translation, and artifact metadata through one host-owned family', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiTranslations: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        locales: {
                            en: {
                                title: 'Preview',
                                description: 'Open preview',
                            },
                        },
                    },
                },
            ],
            structuredMessages: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-card',
                        kind: 'acme.preview/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: { kind: 'host', rendererId: 'summaryCard' },
                        display,
                    },
                },
            ],
            sessionSurfaces: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-pane',
                        surfaceKind: 'previewPane',
                        target: { kind: 'localService', idPath: '/previewId' },
                        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                        display,
                    },
                },
            ],
            sessionHeaderActions: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'open-preview',
                        action: {
                            id: 'open-preview',
                            labelKey: 'title',
                            kind: 'openSurface',
                            target: { surfaceId: 'preview-pane' },
                        },
                        display,
                    },
                },
            ],
            hostedWeb: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-web',
                        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                        entry: { routeMode: 'hostOrigin', path: '/' },
                        bridge: { allowedMessages: ['ready'] },
                        sandbox: { scripts: true },
                        fallback: { kind: 'unavailable' },
                        display,
                    },
                },
            ],
            reactNativeBundles: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'native-preview',
                        bundle: {
                            platform: 'ios',
                            channel: 'internal',
                            integrity: { digest: 'sha256:bundle' },
                        },
                        entry: { exportName: 'renderSurface' },
                        compatibility: {
                            hostUiApiVersion: '1.0.0',
                            reactVersion: '19.0.0',
                            reactNativeVersion: '0.79.0',
                            supportedPlatforms: ['ios'],
                            supportedChannels: ['internal'],
                        },
                        hostApi: { minVersion: '1.0.0' },
                        fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                        display,
                    },
                },
            ],
            uiArtifacts: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'native-preview-ios',
                        contributionId: 'native-preview',
                        contributionFamily: 'reactNativeBundles',
                        artifactKind: 'reactNativeBundle',
                        platform: 'ios',
                        channel: 'internal',
                        integrity: { digest: 'sha256:bundle' },
                        compatibility: {
                            hostUiApiVersion: '1.0.0',
                            reactVersion: '19.0.0',
                            reactNativeVersion: '0.79.0',
                        },
                        byteSize: 1024,
                        contentType: 'application/javascript',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 8 });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['structuredMessage:acme.preview:preview-card']).toMatchObject({
            id: 'structuredMessage:acme.preview:preview-card',
            pluginId: 'acme.preview',
            contributionKind: 'structuredMessage',
            kind: 'acme.preview/preview-card.v1',
            renderer: { kind: 'host', rendererId: 'summaryCard' },
        });
        expect(entries['sessionSurface:acme.preview:preview-pane']).toMatchObject({
            contributionKind: 'sessionSurface',
            surfaceKind: 'previewPane',
        });
        expect(entries['sessionHeaderAction:acme.preview:open-preview']).toMatchObject({
            contributionKind: 'sessionHeaderAction',
            action: expect.objectContaining({ kind: 'openSurface' }),
        });
        expect(entries['hostedWeb:acme.preview:preview-web']).toMatchObject({
            contributionKind: 'hostedWeb',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            fallback: { kind: 'unavailable' },
        });
        expect(entries['reactNativeBundle:acme.preview:native-preview']).toMatchObject({
            contributionKind: 'reactNativeBundle',
            compatibility: expect.objectContaining({
                reactVersion: '19.0.0',
                reactNativeVersion: '0.79.0',
            }),
            fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
        });
        expect(entries['uiArtifact:acme.preview:native-preview-ios']).toMatchObject({
            contributionKind: 'uiArtifact',
            artifactKind: 'reactNativeBundle',
            integrity: { digest: 'sha256:bundle' },
        });
        expect(entries['translations:acme.preview']).toMatchObject({
            contributionKind: 'translations',
            locales: ['en'],
        });
        expect(entries['digest:acme.preview']).toMatchObject({
            contributionKind: 'digest',
            digest: expect.stringMatching(/^sha256:/u),
        });
    });
});
