import { PLUGIN_SURFACE_REGISTRY } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '../projection/v2';
import { isUiMountedSurfacePlacementKind } from './projection';
import type {
    ResolvedContributionRegistry,
    ResolvedHostedWebContribution,
    ResolvedSurfacePlacementContribution,
} from '../types';

const display = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
} as const;

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
                actions: [],
        tools: [],
        commands: [],
        resources: [],
        activationTargets: [],
        actionsById: new Map(),
        toolsById: new Map(),
        commandsById: new Map(),
        resourcesById: new Map(),
                catalogEntriesById: {},
        agentDefinitionsById: new Map(),
                pluginDiagnosticsByPluginId: {},
    };
}

const hostedWebContribution = {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.preview',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    definition: {
        id: 'preview-web',
        service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
        entry: { routeMode: 'hostOrigin', path: '/' },
        bridge: { allowedMessages: ['ready'] },
        sandbox: {
            scripts: true,
            sameOrigin: false,
            popups: false,
            topNavigation: false,
            mixedContent: false,
        },
        security: {
            allowedConnectOrigins: ['https://api.example.test'],
            allowedNavigationOrigins: [],
            allowedCallbackOrigins: [],
            csp: {
                scriptSrc: 'selfOnly',
                styleSrc: 'selfOnly',
                imgSrc: 'selfOnly',
                fontSrc: 'selfOnly',
                connectSrc: 'declaredOrigins',
                allowDataUrls: false,
                allowBlobUrls: false,
                allowInlineStyles: false,
                allowEval: false,
            },
            sourceMaps: 'disabled',
            mixedContent: 'deny',
        },
        fallback: { kind: 'unavailable' },
        display,
    },
} satisfies ResolvedHostedWebContribution;

const surfacePlacements = [{
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.preview',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    definition: {
        id: 'workspace-preview',
        placement: 'workspace.details',
        target: {
            kind: 'workspace',
            workspaceRefIdPath: '/workspace/refId',
            machineIdPath: '/machine/id',
        },
        renderer: {
            kind: 'hostedWeb',
            contributionId: 'preview-web',
            fallback: { kind: 'descriptor', descriptorId: 'workspace-preview-fallback' },
        },
        display,
        order: 10,
        actions: [],
        hostActions: [],
    },
}, {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.preview',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    definition: {
        id: 'browser-inspector',
        placement: 'browser.panel',
        target: {
            kind: 'browser',
            browserViewIdPath: '/browser/viewId',
            sessionIdPath: '/session/id',
        },
        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
        hostActions: [{
            actionId: 'browser.automation.snapshot',
            placement: 'browser.panel',
            policyOwner: 'BRW-2',
            effect: 'readOnly',
            scope: {
                kind: 'browserView',
                browserViewIdPath: '/browser/viewId',
                sessionIdPath: '/session/id',
            },
            requiredFeatureIds: ['browser.shell'],
            requiredPermissionIds: [],
        }],
        display,
        order: 20,
        actions: [],
    },
}] satisfies readonly ResolvedSurfacePlacementContribution[];

describe('supported-placement gate derives from the surface registry (DR-1)', () => {
    it('treats exactly the registry surface descriptors that bind a renderer host as mounted', () => {
        // The gate is the registry, not a hand-maintained list: every descriptor with a
        // live renderer host is mounted, and the registry is the only source consulted.
        for (const descriptor of PLUGIN_SURFACE_REGISTRY.list()) {
            const bindsRendererHost = Object.keys(descriptor.rendererSet).length > 0;
            expect(
                isUiMountedSurfacePlacementKind(descriptor.id),
                `${descriptor.id} mount gate must follow its registry rendererSet`,
            ).toBe(bindsRendererHost);
        }
    });

    it('gates a placement kind the registry does not back as unmounted (no silent drop)', () => {
        expect(PLUGIN_SURFACE_REGISTRY.get('session.unmounted')).toBeUndefined();
        expect(isUiMountedSurfacePlacementKind('session.unmounted')).toBe(false);
    });
});

describe('plugin UI surface placement projection', () => {
    it('projects generic placements with fail-closed executable renderer availability', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            hostedWeb: [hostedWebContribution],
            surfacePlacements,
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 9,
            pluginUiHostRuntime: {
                hostedWeb: { featureEnabled: false },
            },
        });

        const entries = projection.familiesById.pluginUi?.entriesById ?? {};
        expect(entries['surfacePlacement:acme.preview:workspace-preview']).toMatchObject({
            contributionKind: 'surfacePlacement',
            placement: 'workspace.details',
            renderer: { kind: 'hostedWeb', contributionId: 'preview-web' },
            availability: {
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            },
        });
        expect(entries['surfacePlacement:acme.preview:browser-inspector']).toMatchObject({
            placement: 'browser.panel',
            hostActions: [{
                actionId: 'browser.automation.snapshot',
                policyOwner: 'BRW-2',
                effect: 'readOnly',
                scope: {
                    kind: 'browserView',
                    browserViewIdPath: '/browser/viewId',
                    sessionIdPath: '/session/id',
                },
            }],
        });
    });

    it('mounts the migrated session-pane placement kinds through the canonical surfacePlacement path (Phase 2.1)', () => {
        // Phase 2.1 (W2-PHASE2B): the legacy `sessionSurfaces` family is replaced
        // by `surfacePlacement` contributions on the `session.details/preview/tool/
        // side` placement kinds. They are now MOUNTED (the UI render path reads
        // `surfacePlacementsById`), so the supported-placement gate no longer
        // rejects them — a renderable host renderer id reaches `available`.
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: (['session.details', 'session.preview', 'session.tool', 'session.side'] as const).map((placement) => ({
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: `session-${placement}`,
                    placement,
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                    // A renderable host renderer id (one of the unified session-surface
                    // renderer ids) — the placement now reaches renderer availability.
                    renderer: { kind: 'host', rendererId: 'markdownDetails' },
                    display,
                    order: 1,
                    actions: [],
                    hostActions: [],
                },
            })) satisfies readonly ResolvedSurfacePlacementContribution[],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 11,
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        for (const placement of ['session.details', 'session.preview', 'session.tool', 'session.side'] as const) {
            expect(entries[`surfacePlacement:acme.review:session-${placement}`]).toMatchObject({
                placement,
                availability: {
                    state: 'available',
                    reason: 'available',
                },
            });
        }
    });

    it('keeps mounted placement kinds reaching renderer availability (gate does not over-reject)', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'mounted-services',
                    placement: 'services.panel',
                    target: { kind: 'services', machineIdPath: '/machine/id' },
                    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                    display,
                    order: 5,
                    actions: [],
                    hostActions: [],
                },
            }] satisfies readonly ResolvedSurfacePlacementContribution[],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 12,
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.review:mounted-services']).toMatchObject({
            placement: 'services.panel',
            availability: { state: 'available', reason: 'available' },
        });
    });

    it('projects right-sidebar and services placement metadata without shadowing built-in tab ids', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'review-tab',
                    placement: 'session.rightSidebarTab',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                    // A renderable host renderer id (PR-12): availability reports
                    // `available` only when the id is in the renderable protocol set.
                    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                    display: {
                        titleKey: 'plugins.acme.review.title',
                        developerFallback: 'Review',
                        iconToken: 'preview',
                    },
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
                    order: 25,
                    actions: [],
                    hostActions: [],
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'reserved-browser-tab',
                    placement: 'project.rightSidebarTab',
                    target: { kind: 'project', projectIdPath: '/project/id' },
                    renderer: { kind: 'host', rendererId: 'reservedBrowserHost' },
                    display,
                    rightSidebar: {
                        tabId: 'browser',
                        scope: 'project',
                        section: 'plugin',
                        order: 30,
                        mobile: { enabled: true, surface: 'pluginTab' },
                        lifecycle: {
                            retention: 'unmountOnDisable',
                            unmountOnGenerationChange: true,
                        },
                        disabledPolicy: 'disable',
                        collisionPolicy: 'reject',
                    },
                    order: 30,
                    actions: [],
                    hostActions: [],
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'service-inspector',
                    placement: 'services.panel',
                    target: { kind: 'services', machineIdPath: '/machine/id', serverIdPath: '/server/id' },
                    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                    display,
                    order: 5,
                    actions: [],
                    hostActions: [],
                },
            }],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 10,
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.review:review-tab']).toMatchObject({
            placement: 'session.rightSidebarTab',
            rightSidebar: {
                tabId: 'review',
                scope: 'session',
                mobile: { enabled: true, surface: 'pluginTab' },
                lifecycle: { retention: 'unmountOnDisable' },
            },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['surfacePlacement:acme.review:reserved-browser-tab']).toMatchObject({
            placement: 'project.rightSidebarTab',
            rightSidebar: { tabId: 'browser', scope: 'project' },
            availability: {
                state: 'disabled',
                reason: 'right_sidebar_tab_id_reserved',
            },
        });
        expect(entries['surfacePlacement:acme.review:service-inspector']).toMatchObject({
            placement: 'services.panel',
            target: { kind: 'services', machineIdPath: '/machine/id' },
            availability: { state: 'available', reason: 'available' },
        });
    });

    it('disables same-plugin right-sidebar tab slug collisions before UI projection', () => {
        const registry: ResolvedContributionRegistry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'review-tab-a',
                    placement: 'session.rightSidebarTab',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                    renderer: { kind: 'host', rendererId: 'reviewHostA' },
                    display,
                    rightSidebar: {
                        tabId: 'review',
                        scope: 'session',
                        section: 'plugin',
                        order: 20,
                        disabledPolicy: 'disable',
                        collisionPolicy: 'reject',
                        lifecycle: {
                            retention: 'unmountOnDisable',
                            unmountOnGenerationChange: true,
                        },
                    },
                    order: 20,
                    actions: [],
                    hostActions: [],
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.review',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'review-tab-b',
                    placement: 'session.rightSidebarTab',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                    renderer: { kind: 'host', rendererId: 'reviewHostB' },
                    display,
                    rightSidebar: {
                        tabId: 'review',
                        scope: 'session',
                        section: 'plugin',
                        order: 21,
                        disabledPolicy: 'disable',
                        collisionPolicy: 'reject',
                        lifecycle: {
                            retention: 'unmountOnDisable',
                            unmountOnGenerationChange: true,
                        },
                    },
                    order: 21,
                    actions: [],
                    hostActions: [],
                },
            }],
        };

        const projection = buildPluginProjectionV2({
            registry,
            generation: 10,
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.review:review-tab-a']).toMatchObject({
            placement: 'session.rightSidebarTab',
            availability: {
                state: 'disabled',
                reason: 'right_sidebar_tab_id_duplicate',
                diagnostics: ['right_sidebar_tab_id_duplicate'],
            },
        });
        expect(entries['surfacePlacement:acme.review:review-tab-b']).toMatchObject({
            placement: 'session.rightSidebarTab',
            availability: {
                state: 'disabled',
                reason: 'right_sidebar_tab_id_duplicate',
                diagnostics: ['right_sidebar_tab_id_duplicate'],
            },
        });
    });
});
