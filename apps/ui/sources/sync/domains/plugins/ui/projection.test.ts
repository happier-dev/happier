import { describe, expect, it } from 'vitest';

import {
    PluginProjectionV2Schema,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import {
    normalizePluginUiDestinationBindingV1,
    normalizePluginUiInlineSurfaceBindingV1,
    PluginUiDestinationBindingV1Schema,
    PluginUiInlineSurfaceBindingV1Schema,
} from '@happier-dev/protocol/plugins/ui';

import {
    EMPTY_PLUGIN_UI_PROJECTION,
    createPluginUiProjectedActionResolver,
    normalizePluginUiProjection,
    resolvePluginUiProjectionState,
} from './projection';
import { resolvePluginUiText } from './i18n';

function binding(input: Parameters<typeof normalizePluginUiDestinationBindingV1>[0]) {
    const normalized = normalizePluginUiDestinationBindingV1(input);
    if (!normalized) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    // The registry owns destination admission before projection. Retain the
    // parsed producer boundary instead of widening the projection fixture type.
    return PluginUiDestinationBindingV1Schema.parse(normalized);
}

function inlineBinding(input: Parameters<typeof normalizePluginUiInlineSurfaceBindingV1>[0]) {
    const normalized = normalizePluginUiInlineSurfaceBindingV1(input);
    if (!normalized) {
        throw new Error('test fixture must use an admitted V2 inline surface binding');
    }
    return PluginUiInlineSurfaceBindingV1Schema.parse(normalized);
}

function parsePluginUiEntry(
    id: string,
    entry: Readonly<Record<string, unknown>>,
) {
    const projection = PluginProjectionV2Schema.parse({
        v: 2,
        generation: 0,
        installedPackagesById: {},
        agentsById: {},
        backendsById: {},
        actionsById: {},
        toolsById: {},
        commandsById: {},
        resourcesById: {},
        settingsById: {},
        familiesById: {
            pluginUi: {
                family: 'pluginUi',
                entriesById: { [id]: entry },
            },
        },
        diagnostics: [],
    });
    const parsedEntry = projection.familiesById.pluginUi?.entriesById[id];
    if (!parsedEntry) {
        throw new Error('test fixture must produce one canonical plugin UI entry');
    }
    return parsedEntry;
}

function createProjection(): PluginProjectionV2 {
    const previewPaneBinding = binding({
        pluginId: 'acme.preview',
        destinationId: 'preview-pane',
        rendererId: 'preview-placeholder',
        container: 'detailsTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    const projectPreviewBinding = binding({
        pluginId: 'acme.preview',
        destinationId: 'project-preview',
        rendererId: 'preview-web',
        container: 'detailsPane',
        target: { kind: 'project', projectIdPath: '/project/id' },
    });
    const browserInspectorBinding = binding({
        pluginId: 'acme.preview',
        destinationId: 'browser-inspector',
        rendererId: 'descriptor-panel',
        container: 'browserPanel',
        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    });
    const sessionReviewBinding = binding({
        pluginId: 'acme.preview',
        destinationId: 'session-review-tab',
        rendererId: 'review-host',
        container: 'rightSidebarTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    const serviceInspectorBinding = binding({
        pluginId: 'acme.preview',
        destinationId: 'service-inspector',
        rendererId: 'service-inspector',
        container: 'servicesPanel',
        target: { kind: 'services', machineIdPath: '/machine/id', serverIdPath: '/server/id' },
    });
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
                icon: 'open-outline',
                scopes: ['session'],
                surfaces: ['ui'],
                execution: { target: 'daemon' },
                placementBindings: ['detailsPanel'],
                priority: 0,
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
                            capabilities: { turn: { cancelResponse: true, bargeIn: true } },
                            credentials: {
                                slot: {
                                    id: 'api_key',
                                    purpose: 'voice.client-auth',
                                    title: 'Voice credential',
                                },
                                requirement: { kind: 'always' },
                                sources: [{
                                    kind: 'savedSecret',
                                    secretKinds: ['apiKey'],
                                    rawGrants: [{
                                        realm: 'web',
                                        phase: 'prepare',
                                        request: {
                                            kind: 'httpHeaders',
                                            origin: 'https://voice.example.test',
                                            headerNames: ['authorization'],
                                        },
                                    }],
                                }],
                            },
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
                    'surfacePlacement:acme.preview:preview-pane': {
                        id: 'surfacePlacement:acme.preview:preview-pane',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'preview-pane',
                        binding: previewPaneBinding,
                        target: previewPaneBinding.target,
                        renderer: { kind: 'declarative', contributionId: 'preview-placeholder' },
                        display: { titleKey: 'title' },
                        availability: { state: 'available', reason: 'available', diagnostics: [] },
                    },
                    'sessionHeaderAction:acme.preview:open-preview': {
                        id: 'sessionHeaderAction:acme.preview:open-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'sessionHeaderAction',
                        descriptorId: 'open-preview',
                        title: { key: 'title', fallback: 'Open preview' },
                        command: {
                            kind: 'executeAction',
                            action: { pluginId: 'acme.preview', localId: 'open-preview' },
                        },
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
                    'surfacePlacement:acme.preview:project-preview': {
                        id: 'surfacePlacement:acme.preview:project-preview',
                        pluginId: 'acme.preview',
                        contributionKind: 'surfacePlacement',
                        descriptorId: 'project-preview',
                        binding: projectPreviewBinding,
                        target: projectPreviewBinding.target,
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
                        binding: browserInspectorBinding,
                        target: browserInspectorBinding.target,
                        renderer: { kind: 'declarative', contributionId: 'descriptor-panel' },
                        display: { titleKey: 'title' },
                        order: 20,
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
                        binding: sessionReviewBinding,
                        target: sessionReviewBinding.target,
                        renderer: { kind: 'declarative', contributionId: 'review-host' },
                        display: {
                            titleKey: 'plugins.acme.review.title',
                            developerFallback: 'Review',
                            iconToken: 'preview',
                        },
                        order: 25,
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
                        binding: serviceInspectorBinding,
                        target: serviceInspectorBinding.target,
                        renderer: { kind: 'declarative', contributionId: 'service-inspector' },
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
    it('projects the three independent static Composer families without depending on a generic pluginUi declaration', () => {
        const projection = createProjection();
        delete projection.familiesById.pluginUi;
        projection.familiesById.composerAttachments = {
            family: 'composerAttachments',
            entriesById: {
                'acme.preview/issue': {
                    id: 'acme.preview/issue',
                    pluginId: 'acme.preview',
                    identity: { pluginId: 'acme.preview', localId: 'issue' },
                    immutableGenerationId: 'preview-generation-42',
                    definition: {
                        id: 'issue',
                        title: 'Issue',
                        icon: 'file',
                        cardinality: 'one',
                        valueSchema: { type: 'object' },
                        display: { kind: 'badge' },
                    },
                },
            },
        };
        projection.familiesById.composerControls = {
            family: 'composerControls',
            entriesById: {
                'acme.preview/add-issue': {
                    id: 'acme.preview/add-issue',
                    pluginId: 'acme.preview',
                    identity: { pluginId: 'acme.preview', localId: 'add-issue' },
                    immutableGenerationId: 'preview-generation-42',
                    definition: {
                        id: 'add-issue',
                        label: 'Add issue',
                        icon: 'add',
                        scopes: ['session'],
                        interaction: {
                            kind: 'attachmentPicker',
                            attachment: 'issue',
                            presentation: 'popover',
                            layout: 'list',
                        },
                    },
                },
            },
        };
        projection.familiesById.composerRegions = {
            family: 'composerRegions',
            entriesById: {
                'acme.preview/issue-summary': {
                    id: 'acme.preview/issue-summary',
                    pluginId: 'acme.preview',
                    identity: { pluginId: 'acme.preview', localId: 'issue-summary' },
                    immutableGenerationId: 'preview-generation-42',
                    definition: {
                        id: 'issue-summary',
                        placement: 'afterComposer',
                        renderer: { renderer: 'issue-summary' },
                        scopes: ['session'],
                    },
                },
            },
        };

        const model = normalizePluginUiProjection(projection);

        expect(model.composerAttachmentsById['acme.preview/issue']).toMatchObject({
            identity: { pluginId: 'acme.preview', localId: 'issue' },
            immutableGenerationId: 'preview-generation-42',
            definition: { display: { kind: 'badge' } },
        });
        expect(model.composerControlsById['acme.preview/add-issue']).toMatchObject({
            identity: { pluginId: 'acme.preview', localId: 'add-issue' },
            definition: { interaction: { kind: 'attachmentPicker', attachment: 'issue' } },
        });
        expect(model.composerRegionsById['acme.preview/issue-summary']).toMatchObject({
            identity: { pluginId: 'acme.preview', localId: 'issue-summary' },
            definition: { placement: 'afterComposer', renderer: { renderer: 'issue-summary' } },
        });
    });

    it('retains the daemon-admitted package brand fact for the presentation host', () => {
        const projection = createProjection();
        projection.installedPackagesById = {
            'acme.preview': {
                id: 'acme.preview',
                displayName: 'Preview Inspector',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'bundled', locator: 'acme.preview' },
                brand: {
                    state: 'available',
                    resource: { pluginId: 'acme.preview', localId: 'brand-mark' },
                    width: 64,
                    height: 64,
                    digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                },
            },
        };

        const model = normalizePluginUiProjection(projection);

        // Presentation consumes the package owner's already-admitted identity;
        // it must not recreate this from a plugin id, filename, or remote URL.
        expect(model.installedPackagesById['acme.preview']).toMatchObject({
            displayName: 'Preview Inspector',
            brand: {
                state: 'available',
                resource: { pluginId: 'acme.preview', localId: 'brand-mark' },
            },
        });
    });

    it('retains only the daemon-committed immutable package generation for a mounted target', () => {
        const projection = createProjection();
        projection.installedPackagesById = {
            'acme.preview': {
                id: 'acme.preview',
                displayName: 'Preview Inspector',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'bundled', locator: 'acme.preview' },
                immutableGenerationId: 'preview-generation-42',
                brand: { state: 'missing' },
            },
        };

        const model = normalizePluginUiProjection(projection);

        // The mount can request a cold contribution snapshot only with this
        // producer-owned identity. It must not derive a target from the coarse
        // projection generation, package version, or artifact identity.
        expect(model.installedPackagesById['acme.preview']).toMatchObject({
            immutableGenerationId: 'preview-generation-42',
        });
    });

    it('rejects a projected surface whose renderer chain is malformed instead of reconstructing a local binding', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        const malformedBinding = binding({
            pluginId: 'acme.preview',
            destinationId: 'preview-pane',
            rendererId: 'preview-placeholder',
            container: 'detailsTab',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        });
        entries['surfacePlacement:acme.preview:preview-pane'] = {
            id: 'surfacePlacement:acme.preview:preview-pane',
            pluginId: 'acme.preview',
            contributionKind: 'surfacePlacement',
            descriptorId: 'preview-pane',
            binding: {
                ...malformedBinding,
                rendererChain: [],
            },
            target: malformedBinding.target,
            renderer: { kind: 'declarative', contributionId: 'preview-placeholder' },
            display: { titleKey: 'title' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };

        expect(normalizePluginUiProjection(projection)
            .surfacePlacementsById['surfacePlacement:acme.preview:preview-pane']).toBeUndefined();
    });

    it('admits a daemon-projected openable-content viewer without reconstructing its declaration', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        entries['openableContentViewer:acme.preview:markdown'] = parsePluginUiEntry(
            'openableContentViewer:acme.preview:markdown',
            {
            id: 'openableContentViewer:acme.preview:markdown',
            pluginId: 'acme.preview',
            contributionKind: 'openableContentViewer',
            descriptorId: 'markdown',
            identity: { pluginId: 'acme.preview', localId: 'markdown' },
            viewer: {
                contentClasses: ['text'],
                mimeTypes: ['text/markdown'],
                extensions: ['.md'],
            },
            destination: { pluginId: 'acme.preview', localId: 'preview-pane' },
            },
        );

        const model = normalizePluginUiProjection(projection);

        expect(model.openableContentViewersById['openableContentViewer:acme.preview:markdown']).toMatchObject({
            identity: { pluginId: 'acme.preview', localId: 'markdown' },
            viewer: {
                contentClasses: ['text'],
                mimeTypes: ['text/markdown'],
                extensions: ['.md'],
            },
            destination: { pluginId: 'acme.preview', localId: 'preview-pane' },
        });
        expect(model.unknownEntriesById['openableContentViewer:acme.preview:markdown']).toBeUndefined();
    });

    it('admits generated Settings groups and pages as typed projections rather than unknown entries', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        const settingsBinding = binding({
            pluginId: 'acme.preview',
            destinationId: 'review-settings',
            rendererId: 'settings-panel',
            container: 'settingsPage',
            target: { kind: 'app' },
        });
        entries['settingsGroup:acme.preview:review'] = parsePluginUiEntry(
            'settingsGroup:acme.preview:review',
            {
            id: 'settingsGroup:acme.preview:review',
            pluginId: 'acme.preview',
            contributionKind: 'settingsGroup',
            group: {
                id: { pluginId: 'acme.preview', localId: 'review' },
                title: { key: 'settings.review.title', fallback: 'Review' },
                icon: 'settings',
                defaultRank: 20,
            },
            },
        );
        entries['settingsPage:acme.preview:review-settings'] = parsePluginUiEntry(
            'settingsPage:acme.preview:review-settings',
            {
            id: 'settingsPage:acme.preview:review-settings',
            pluginId: 'acme.preview',
            contributionKind: 'settingsPage',
            descriptorId: 'review-settings',
            page: {
                id: { pluginId: 'acme.preview', localId: 'review-settings' },
                group: { kind: 'plugin', id: { pluginId: 'acme.preview', localId: 'review' } },
                title: { key: 'settings.review.page.title', fallback: 'Review settings' },
                subtitle: 'Configure review defaults',
                keywords: ['review', 'pull requests'],
                icon: 'settings',
                defaultRank: 10,
            },
            binding: settingsBinding,
            renderer: {
                kind: 'declarative',
                model: {
                    identity: { pluginId: 'acme.preview', generation: '12' },
                    visible: true,
                    root: { kind: 'text', text: 'Settings panel' },
                },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
        );

        const model = normalizePluginUiProjection(projection);

        expect(model.settingsGroupsById['settingsGroup:acme.preview:review']).toMatchObject({
            group: {
                id: { pluginId: 'acme.preview', localId: 'review' },
                defaultRank: 20,
            },
        });
        expect(model.settingsPagesById['settingsPage:acme.preview:review-settings']).toMatchObject({
            descriptorId: 'review-settings',
            binding: settingsBinding,
            page: {
                group: { kind: 'plugin', id: { pluginId: 'acme.preview', localId: 'review' } },
                keywords: ['review', 'pull requests'],
            },
        });
        expect(model.unknownEntriesById['settingsGroup:acme.preview:review']).toBeUndefined();
        expect(model.unknownEntriesById['settingsPage:acme.preview:review-settings']).toBeUndefined();
    });

    it('keeps a generated V2 surface with its canonical binding when no legacy placement exists', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        const normalizedBinding = normalizePluginUiDestinationBindingV1({
            pluginId: 'acme.generated',
            destinationId: 'review',
            rendererId: 'review-renderer',
            container: 'rightSidebarTab',
            target: { kind: 'session' },
        });
        if (!normalizedBinding) throw new Error('generated binding is required');
        const binding = PluginUiDestinationBindingV1Schema.parse(normalizedBinding);
        const generatedEntry = parsePluginUiEntry('surfacePlacement:acme.generated:review', {
            id: 'surfacePlacement:acme.generated:review',
            pluginId: 'acme.generated',
            contributionKind: 'surfacePlacement',
            descriptorId: 'review',
            container: binding.container,
            target: binding.target,
            binding,
            renderer: { kind: 'hostedWeb', contributionId: 'review-renderer' },
            display: { developerFallback: 'Review' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        });
        if (!generatedEntry.binding) throw new Error('generated surface binding is required');
        entries['surfacePlacement:acme.generated:review'] = generatedEntry;

        const model = normalizePluginUiProjection(projection);

        const entry = model.surfacePlacementsById['surfacePlacement:acme.generated:review'];
        expect(entry).toBeDefined();
        expect(entry?.binding).toBe(generatedEntry.binding);
        expect(entry?.placement).toBeUndefined();
    });

    it('normalizes pluginUi family entries into stable typed lookup maps and preserves unknown contribution kinds', () => {
        const model = normalizePluginUiProjection(createProjection());

        expect(model.generation).toBe(12);
        // Actions are daemon-admitted projection facts. The UI executable
        // compositor must consume this exact map rather than reconstructing
        // client targets from Voice declarations or issuing another fetch.
        expect(model.actionsById['acme.preview/open-preview']).toMatchObject({
            id: 'open-preview',
            pluginId: 'acme.preview',
            surfaces: ['ui'],
            execution: { target: 'daemon' },
            available: true,
        });
        const conversation = model.voiceProvidersById['acme.preview/conversation']?.definition;
        expect(conversation?.kind).toBe('conversation');
        if (conversation?.kind !== 'conversation') throw new Error('expected conversation Voice projection');
        expect(conversation.client.exportName).toBe('activate');
        expect(conversation.credentials?.sources[0]?.rawGrants?.[0]?.phase).toBe('prepare');
        expect(model.voiceProvidersById['acme.preview/stale']).toBeUndefined();
        expect(model.translationsByPluginId['acme.preview']?.locales).toEqual(['en']);
        expect(resolvePluginUiText({
            projection: model,
            pluginId: 'acme.preview',
            key: 'title',
            locale: 'en',
            fallback: 'Developer fallback',
        })).toBe('Preview');
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:preview-pane']).toMatchObject({
            binding: {
                container: 'detailsTab',
                targetKind: 'session',
                destination: { pluginId: 'acme.preview', localId: 'preview-pane' },
            },
            availability: { state: 'available', reason: 'available' },
        });
        expect(model.sessionHeaderActionsById['sessionHeaderAction:acme.preview:open-preview']).toMatchObject({
            descriptorId: 'open-preview',
            command: {
                kind: 'executeAction',
                action: { pluginId: 'acme.preview', localId: 'open-preview' },
            },
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
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:project-preview']).toMatchObject({
            binding: {
                container: 'detailsPane',
                targetKind: 'project',
                destination: { pluginId: 'acme.preview', localId: 'project-preview' },
            },
            availability: {
                reason: 'feature_disabled',
            },
        });
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:browser-inspector']).toMatchObject({
            id: 'surfacePlacement:acme.preview:browser-inspector',
            binding: { container: 'browserPanel', targetKind: 'browser' },
        });
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:session-review-tab']).toMatchObject({
            id: 'surfacePlacement:acme.preview:session-review-tab',
            binding: { container: 'rightSidebarTab', targetKind: 'session' },
        });
        expect(model.surfacePlacementsById['surfacePlacement:acme.preview:service-inspector']).toMatchObject({
            id: 'surfacePlacement:acme.preview:service-inspector',
            binding: { container: 'servicesPanel', targetKind: 'services' },
            target: { kind: 'services', machineIdPath: '/machine/id' },
        });
        expect(model).not.toHaveProperty('uiArtifactsById');
        expect(model.unknownEntriesById['uiArtifact:acme.preview:native-preview-ios']).toMatchObject({
            contributionKind: 'uiArtifact',
            artifactId: 'native-preview-ios',
        });
        expect(model).not.toHaveProperty('digestsByPluginId');
        expect(model.unknownEntriesById['unknown:acme.preview']).toMatchObject({
            id: 'unknown:acme.preview',
            pluginId: 'acme.preview',
            contributionKind: 'futureUnknown',
        });
    });

    it('resolves a raw Action only by its exact qualified identity', () => {
        const model = normalizePluginUiProjection(createProjection());
        const action = model.actionsById['acme.preview/open-preview'];
        if (!action) throw new Error('action fixture is required');

        const resolveAction = createPluginUiProjectedActionResolver(model.actionsById);
        expect(resolveAction({ pluginId: 'acme.preview', localId: 'open-preview' })).toBe(action);
        expect(resolveAction({ pluginId: 'acme.preview', localId: 'other-action' })).toBeNull();

        // A malformed map entry must not let a key substitute another raw
        // descriptor. The dispatcher can therefore trust this as its target
        // source without accepting a stale/cross-plugin projection value.
        const mismatchedEntryResolver = createPluginUiProjectedActionResolver({
            'acme.other/open-preview': action,
        });
        expect(mismatchedEntryResolver({
            pluginId: 'acme.other',
            localId: 'open-preview',
        })).toBeNull();
    });

    it('does not project structured-message descriptors even when multiple plugins claim a kind', () => {
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

        expect(model.unknownEntriesById['structuredMessage:other.preview:preview-card']).toBeDefined();
    });

    it('retains a compiled session-header action without re-admitting its Action target in UI', () => {
        const projection = createProjection();
        delete projection.actionsById['acme.preview/open-preview'];

        // Action availability/currentness is owned by the compiled producer and
        // canonical dispatcher. Re-checking this adjacent catalog here would
        // restore a competing UI admission owner and reject a valid compiled
        // semantic action before the owner can return its typed outcome.
        expect(normalizePluginUiProjection(projection)
            .sessionHeaderActionsById['sessionHeaderAction:acme.preview:open-preview'])
            .toMatchObject({
                descriptorId: 'open-preview',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.preview', localId: 'open-preview' },
                },
            });
    });

    it('retains only a same-plugin qualified transcript activity profile', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        entries['transcriptActivity:acme.preview:import-progress-card'] = {
            id: 'transcriptActivity:acme.preview:import-progress-card',
            pluginId: 'acme.preview',
            contributionKind: 'transcriptActivity',
            descriptorId: 'import-progress-card',
            resource: { pluginId: 'acme.preview', localId: 'import-progress' },
            actions: [{ pluginId: 'acme.preview', localId: 'open-preview' }],
        };
        entries['transcriptActivity:acme.preview:cross-plugin'] = {
            id: 'transcriptActivity:acme.preview:cross-plugin',
            pluginId: 'acme.preview',
            contributionKind: 'transcriptActivity',
            descriptorId: 'cross-plugin',
            resource: { pluginId: 'other.plugin', localId: 'import-progress' },
            actions: [],
        };

        const model = normalizePluginUiProjection(projection);

        expect(model.transcriptActivitiesById).toEqual({
            'transcriptActivity:acme.preview:import-progress-card': expect.objectContaining({
                descriptorId: 'import-progress-card',
                resource: { pluginId: 'acme.preview', localId: 'import-progress' },
                actions: [{ pluginId: 'acme.preview', localId: 'open-preview' }],
            }),
        });
    });

    it('retains a daemon-admitted session-info section with its declarative renderer', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        const sessionInfoBinding = inlineBinding({
            pluginId: 'acme.preview',
            surfaceId: 'overview',
            rendererId: 'session-info-overview',
            fallbackRendererIds: [],
            availableRendererIds: ['session-info-overview'],
            role: 'sessionInfoSection',
            target: { kind: 'session' },
        });
        entries['sessionInfoSection:acme.preview:overview'] = {
            id: 'sessionInfoSection:acme.preview:overview',
            pluginId: 'acme.preview',
            pluginVersion: '1.0.0',
            contributionKind: 'sessionInfoSection',
            descriptorId: 'overview',
            order: 25,
            resource: { pluginId: 'acme.preview', localId: 'session-overview' },
            actions: [{ pluginId: 'acme.preview', localId: 'open-preview' }],
            renderer: {
                kind: 'declarative',
                contributionId: 'session-info-overview',
                documentSource: { kind: 'resource', resourceId: 'session-overview' },
            },
            runtime: { resource: { available: true } },
            placement: {
                id: 'sessionInfoSectionPlacement:acme.preview:overview',
                pluginId: 'acme.preview',
                contributionKind: 'surfacePlacement',
                descriptorId: 'overview',
                binding: sessionInfoBinding,
                target: sessionInfoBinding.target,
                renderer: {
                    kind: 'declarative',
                    contributionId: 'session-info-overview',
                    documentSource: { kind: 'resource', resourceId: 'session-overview' },
                },
                display: {},
                availability: { state: 'available', reason: 'available', diagnostics: [] },
                headerActions: [],
                runtime: { resource: { available: true } },
            },
        };

        expect(normalizePluginUiProjection(projection).sessionInfoSectionsById).toEqual({
            'sessionInfoSection:acme.preview:overview': expect.objectContaining({
                descriptorId: 'overview',
                order: 25,
                resource: { pluginId: 'acme.preview', localId: 'session-overview' },
                actions: [{ pluginId: 'acme.preview', localId: 'open-preview' }],
                renderer: expect.objectContaining({ contributionId: 'session-info-overview' }),
                placement: expect.objectContaining({
                    binding: expect.objectContaining({
                        kind: 'inline',
                        role: 'sessionInfoSection',
                        surface: { pluginId: 'acme.preview', localId: 'overview' },
                    }),
                }),
            }),
        });
    });

    it('rejects a Session-info section whose nested physical placement targets another container', () => {
        const projection = createProjection();
        const entries = projection.familiesById.pluginUi?.entriesById;
        if (!entries) throw new Error('pluginUi fixture family is required');
        const wrongPlacement = entries['surfacePlacement:acme.preview:preview-pane'];
        if (!wrongPlacement) throw new Error('surface placement fixture is required');
        entries['sessionInfoSection:acme.preview:wrong-container'] = {
            id: 'sessionInfoSection:acme.preview:wrong-container',
            pluginId: 'acme.preview',
            pluginVersion: '1.0.0',
            contributionKind: 'sessionInfoSection',
            descriptorId: 'wrong-container',
            resource: { pluginId: 'acme.preview', localId: 'session-overview' },
            actions: [],
            renderer: { kind: 'declarative', contributionId: 'session-info-wrong-container' },
            placement: wrongPlacement,
        };

        expect(normalizePluginUiProjection(projection)
            .sessionInfoSectionsById['sessionInfoSection:acme.preview:wrong-container'])
            .toBeUndefined();
    });

    it('keeps the previous model while a projection refresh is unresolved', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, null)).toBe(previous);
    });

    it('keeps the current model when the same authoritative generation is republished', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, createProjection(), {
            reuseSameGeneration: true,
        })).toBe(previous);
    });

    it('does not reuse an equal generation without current authority proof', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, createProjection())).not.toBe(previous);
    });

    it('clears the previous model when an authoritative projection refresh is non-v2', () => {
        const previous = normalizePluginUiProjection(createProjection());

        expect(resolvePluginUiProjectionState(previous, { v: 1, agentsById: {}, backendsById: {} })).toBe(EMPTY_PLUGIN_UI_PROJECTION);
    });
});
