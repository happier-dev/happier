import { describe, expect, it } from 'vitest';

import type { PluginProjectionV2 } from '@happier-dev/protocol';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    normalizePluginUiProjection,
    resolvePluginUiProjectionState,
} from './projection';
import { resolvePluginUiText } from './i18n';

function createProjection(): PluginProjectionV2 {
    return {
        v: 2,
        generation: 12,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {
            'acme.preview/open-preview': {
                id: 'open-preview',
                pluginId: 'acme.preview',
                title: 'Open preview',
                scopes: ['session'],
                surfaces: ['ui'],
                placement: 'detailsPanel',
                dangerLevel: 'safe',
                available: true,
            },
        },
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            voiceProviders: {
                family: 'voiceProviders',
                entriesById: {
                    'acme.preview/conversation': {
                        id: 'acme.preview/conversation', pluginId: 'acme.preview', generation: 12,
                        contributionKey: 'acme.preview/conversation',
                        definition: {
                            id: 'conversation', title: 'Conversation', kind: 'conversation',
                            roles: ['realtime_conversation'], platforms: ['web'],
                            capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: true, bargeIn: true } },
                            client: { artifactId: 'voice-runtime', modulePath: './voiceRuntime', exportName: 'activate' },
                        },
                    },
                    'acme.preview/stale': {
                        id: 'acme.preview/stale', pluginId: 'acme.preview', generation: 11,
                        contributionKey: 'acme.preview/stale',
                        definition: {
                            id: 'stale', title: 'Stale', kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
                            capabilities: { readiness: { requirements: [] }, turn: { cancelResponse: false, bargeIn: false } },
                            client: { artifactId: 'voice-runtime', modulePath: './voiceRuntime', exportName: 'activate' },
                        },
                    },
                },
            },
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
                        fallback: { kind: 'summary', template: 'Preview unavailable' },
                    },
                    'surfacePlacement:acme.preview:preview-pane': {
                        id: 'surfacePlacement:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'preview-pane',
                        placement: 'session.preview',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                        display: { titleKey: 'title' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    },
                    'sessionHeaderAction:acme.preview:open-preview': {
                        id: 'sessionHeaderAction:acme.preview:open-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionHeaderAction',
                        descriptorId: 'open-preview',
                        title: { key: 'title', fallback: 'Open preview' },
                        action: 'open-preview',
                    },
                    'hostedWeb:acme.preview:preview-web': {
                        id: 'hostedWeb:acme.preview:preview-web',
                        pluginId: 'acme.preview',
                        contributionKind: 'hostedWeb',
                        contributionId: 'preview-web',
                        service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
                        security: {
                            allowedConnectOrigins: ['https://api.example.test'],
                        },
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
                    'surfacePlacement:acme.preview:workspace-preview': {
                        id: 'surfacePlacement:acme.preview:workspace-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'workspace-preview',
                        placement: 'workspace.details',
                        target: { kind: 'workspace', workspaceRefIdPath: '/workspace/refId' },
                        renderer: { kind: 'hostedWeb', contributionId: 'preview-web' },
                        display: { titleKey: 'title' },
                        order: 10,
                        availability: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['feature_disabled'],
                        },
                    },
                    'surfacePlacement:acme.preview:browser-inspector': {
                        id: 'surfacePlacement:acme.preview:browser-inspector',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'browser-inspector',
                        placement: 'browser.panel',
                        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
                        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                        display: { titleKey: 'title' },
                        order: 20,
                        hostActions: [{
                            actionId: 'browser.inspect.readTitle',
                            placement: 'browser.panel',
                            policyOwner: 'BRW-2',
                            effect: 'readOnly',
                            scope: { kind: 'browserView', browserViewIdPath: '/browser/viewId' },
                        }],
                        availability: {
                            state: 'available',
                            reason: 'available',
                            diagnostics: [],
                        },
                    },
                    'surfacePlacement:acme.preview:session-review-tab': {
                        id: 'surfacePlacement:acme.preview:session-review-tab',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'session-review-tab',
                        placement: 'session.rightSidebarTab',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        renderer: { kind: 'host', rendererId: 'reviewHost' },
                        display: {
                            titleKey: 'plugins.acme.review.title',
                            developerFallback: 'Review',
                            iconToken: 'preview',
                        },
                        order: 25,
                        rightSidebar: {
                            tabId: 'review',
                            scope: 'session',
                            section: 'plugin',
                            order: 25,
                            mobile: { enabled: true, surface: 'pluginTab' },
                            lifecycle: {
                                retention: 'unmountOnDisable',
                                unmountOnGenerationChange: true,
                            },
                            disabledPolicy: 'disable',
                            collisionPolicy: 'reject',
                        },
                        availability: {
                            state: 'available',
                            reason: 'available',
                            diagnostics: [],
                        },
                    },
                    'surfacePlacement:acme.preview:service-inspector': {
                        id: 'surfacePlacement:acme.preview:service-inspector',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'service-inspector',
                        placement: 'services.panel',
                        target: { kind: 'services', machineIdPath: '/machine/id', serverIdPath: '/server/id' },
                        renderer: { kind: 'host', rendererId: 'serviceInspector' },
                        display: { titleKey: 'title' },
                        order: 5,
                        availability: {
                            state: 'available',
                            reason: 'available',
                            diagnostics: [],
                        },
                    },
                    'uiArtifact:acme.preview:native-preview-ios': {
                        id: 'uiArtifact:acme.preview:native-preview-ios',
                        pluginId: 'acme.preview',
                        contributionKind: 'uiArtifact',
                        artifactId: 'native-preview-ios',
                        integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
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
        const conversation = model.voiceProvidersById['acme.preview/conversation']?.definition;
        expect(conversation?.kind).toBe('conversation');
        if (conversation?.kind !== 'conversation') throw new Error('expected conversation Voice projection');
        expect(conversation.client.exportName).toBe('activate');
        expect(model.voiceProvidersById['acme.preview/stale']).toBeUndefined();
        expect(model.translationsByPluginId['acme.preview']?.locales).toEqual(['en']);
        expect(resolvePluginUiText({
            projection: model,
            pluginId: 'acme.preview',
            key: 'title',
            locale: 'en',
            fallback: 'Developer fallback',
        })).toBe('Preview');
        expect(model.structuredMessagesByKind['acme.preview/preview-card.v1']).toMatchObject({
            id: 'structuredMessage:acme.preview:preview-card',
            pluginId: 'acme.preview',
            descriptorId: 'preview-card',
        });
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:preview-pane']).toMatchObject({
            placement: 'session.preview',
            availability: { state: 'available', reason: 'available' },
        });
        expect(model.sessionHeaderActionsById['sessionHeaderAction:acme.preview:open-preview']).toMatchObject({
            descriptorId: 'open-preview',
        });
        expect(model.hostedWebById['hostedWeb:acme.preview:preview-web']).toMatchObject({
            contributionId: 'preview-web',
            security: {
                allowedConnectOrigins: ['https://api.example.test'],
            },
        });
        expect(model.reactNativeBundlesById['reactNativeBundle:acme.preview:native-preview']).toMatchObject({
            fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
        });
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:workspace-preview']).toMatchObject({
            placement: 'workspace.details',
            availability: {
                reason: 'feature_disabled',
            },
        });
        expect(model.surfacePlacementsByPlacement['browser.panel']?.[0]).toMatchObject({
            id: 'surfacePlacement:acme.preview:browser-inspector',
            hostActions: [{
                actionId: 'browser.inspect.readTitle',
                policyOwner: 'BRW-2',
            }],
        });
        expect(model.surfacePlacementsByPlacement['session.rightSidebarTab']?.[0]).toMatchObject({
            id: 'surfacePlacement:acme.preview:session-review-tab',
            rightSidebar: {
                tabId: 'review',
                scope: 'session',
                mobile: { enabled: true, surface: 'pluginTab' },
                lifecycle: { retention: 'unmountOnDisable' },
            },
        });
        expect(model.surfacePlacementsByPlacement['services.panel']?.[0]).toMatchObject({
            id: 'surfacePlacement:acme.preview:service-inspector',
            target: { kind: 'services', machineIdPath: '/machine/id' },
        });
        expect(model.uiArtifactsById['uiArtifact:acme.preview:native-preview-ios']).toMatchObject({
            integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
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

    it('fails closed when multiple plugins project the same structured-message kind', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        entries['structuredMessage:other.preview:preview-card'] = {
            id: 'structuredMessage:other.preview:preview-card',
            pluginId: 'other.preview',
            contributionKind: 'structuredMessage',
            descriptorId: 'preview-card',
            kind: 'acme.preview/preview-card.v1',
            fallback: { kind: 'summary', template: 'Other preview unavailable' },
        };

        const model = normalizePluginUiProjection(projection);

        expect(model.structuredMessagesByKind['acme.preview/preview-card.v1']).toBeUndefined();
    });

    it('keeps the previous model while a projection refresh is unresolved', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, null)).toBe(previous);
    });

    it('keeps the current model when the same authoritative generation is republished', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, createProjection())).toBe(previous);
    });

    it('clears the previous model when an authoritative projection refresh is non-v2', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, { v: 1, agentsById: {}, backendsById: {} })).toBe(EMPTY_PLUGIN_UI_PROJECTION);
    });
});
