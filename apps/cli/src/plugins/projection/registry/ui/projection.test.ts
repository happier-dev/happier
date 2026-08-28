import { readFileSync } from 'node:fs';

import {
    PluginOpenableContentViewerContributionV1Schema,
    PluginUiViewV2Schema,
} from '@happier-dev/protocol';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '../projection/v2';
import type {
    ResolvedContributionRegistry,
    ResolvedOpenableContentViewerContribution,
    ResolvedUiViewV2Contribution,
} from '../types';
import type { StablePluginDeclarativeModel } from '@/plugins/runtime/invocation/services/declarativeModel';

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

const display = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
};

const emptyDeclarativeInventory = Object.freeze({
    actions: Object.freeze([]),
    destinations: Object.freeze([]),
    settings: Object.freeze([]),
    uiQueries: Object.freeze([]),
}) satisfies StablePluginDeclarativeModel['declarativeInventory'];

describe('plugin UI projection family', () => {
    it('stamps every UI entry with the exact current materialization rather than a coarse machine identity', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.materialized',
                identity: { pluginId: 'acme.materialized', localId: 'renderer' },
                manifestPath: '/plugins/acme-materialized/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Materialized' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.materialized',
                identity: { pluginId: 'acme.materialized', localId: 'overview' },
                manifestPath: '/plugins/acme-materialized/.happier-plugin/plugin.json',
                definition: {
                    id: 'overview',
                    container: 'detailsTab',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Overview',
                },
            }],
        } as unknown as ResolvedContributionRegistry;
        const entryId = 'surfacePlacement:acme.materialized:overview';
        const project = (materializationId: string | undefined) => (
            buildPluginProjectionV2({
                registry,
                generation: 7,
                ...(materializationId
                    ? {
                        pluginExecutionOriginsByPluginId: {
                            'acme.materialized': {
                                serverIdentityId: 'srv_projection_fixture',
                                materializationRef: {
                                    machineId: 'machine_projection_fixture',
                                    materializationId,
                                    pluginId: 'acme.materialized',
                                },
                            },
                        },
                    }
                    : {}),
            } as Parameters<typeof buildPluginProjectionV2>[0])
                .familiesById.pluginUi?.entriesById[entryId]
        );

        expect(project(undefined)).not.toHaveProperty('materializationRef');
        expect(project('materialization-a')).toMatchObject({
            serverIdentityId: 'srv_projection_fixture',
            materializationRef: {
                machineId: 'machine_projection_fixture',
                materializationId: 'materialization-a',
                pluginId: 'acme.materialized',
            },
        });
        expect(project('materialization-b')).toMatchObject({
            materializationRef: {
                machineId: 'machine_projection_fixture',
                materializationId: 'materialization-b',
                pluginId: 'acme.materialized',
            },
        });
        expect(project('materialization-b')).not.toMatchObject({
            materializationRef: { materializationId: 'materialization-a' },
        });
    });

    it('derives an openable-content viewer from its existing direct details destination', () => {
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.viewer',
            identity: { pluginId: 'acme.viewer', localId: 'renderer' },
            manifestPath: '/plugins/acme-viewer/.happier-plugin/plugin.json',
            definition: {
                id: 'renderer',
                kind: 'declarative',
                root: { kind: 'text', text: 'Viewer' },
            },
        } as const;
        const detailsView = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.viewer',
            identity: { pluginId: 'acme.viewer', localId: 'file-details' },
            manifestPath: '/plugins/acme-viewer/.happier-plugin/plugin.json',
            definition: PluginUiViewV2Schema.parse({
                id: 'file-details',
                container: 'detailsTab',
                target: { kind: 'session' },
                renderer: 'renderer',
                title: 'File',
            }),
        } satisfies ResolvedUiViewV2Contribution;
        const viewer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.viewer',
            identity: { pluginId: 'acme.viewer', localId: 'markdown' },
            manifestPath: '/plugins/acme-viewer/.happier-plugin/plugin.json',
            definition: PluginOpenableContentViewerContributionV1Schema.parse({
                id: 'markdown',
                destination: 'file-details',
                contentClasses: ['text'],
                mimeTypes: ['text/markdown'],
                extensions: ['.md'],
            }),
        } satisfies ResolvedOpenableContentViewerContribution;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [renderer],
            uiViewsV2: [detailsView],
            openableContentViewers: [viewer],
        } as unknown as ResolvedContributionRegistry;
        const viewerEntryId = 'openableContentViewer:acme.viewer:markdown';
        const origin = {
            serverIdentityId: 'srv_projection_fixture',
            materializationRef: {
                machineId: 'machine_projection_fixture',
                materializationId: 'materialization-current',
                pluginId: 'acme.viewer',
            },
        } as const;
        const projected = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginExecutionOriginsByPluginId: { 'acme.viewer': origin },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        expect(projected[viewerEntryId]).toMatchObject({
            pluginId: 'acme.viewer',
            contributionKind: 'openableContentViewer',
            descriptorId: 'markdown',
            identity: { pluginId: 'acme.viewer', localId: 'markdown' },
            viewer: {
                contentClasses: ['text'],
                mimeTypes: ['text/markdown'],
                extensions: ['.md'],
            },
            destination: { pluginId: 'acme.viewer', localId: 'file-details' },
            ...origin,
        });
        expect(projected[viewerEntryId]).not.toHaveProperty('path');
        expect(projected[viewerEntryId]).not.toHaveProperty('launchInput');

        const withoutDestination = buildPluginProjectionV2({
            registry: { ...registry, uiViewsV2: [] },
            generation: 7,
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};
        expect(withoutDestination).not.toHaveProperty(viewerEntryId);

        const wrongContainerView = {
            ...detailsView,
            definition: PluginUiViewV2Schema.parse({
                ...detailsView.definition,
                container: 'rightPane',
            }),
        } satisfies ResolvedUiViewV2Contribution;
        const withWrongContainer = buildPluginProjectionV2({
            registry: {
                ...registry,
                uiViewsV2: [wrongContainerView],
            },
            generation: 7,
        }).familiesById.pluginUi?.entriesById ?? {};
        expect(withWrongContainer).not.toHaveProperty(viewerEntryId);

        const mismatchedViewer = {
            ...viewer,
            identity: { ...viewer.identity, localId: 'other' },
        } satisfies ResolvedOpenableContentViewerContribution;
        const withMismatchedIdentity = buildPluginProjectionV2({
            registry: {
                ...registry,
                openableContentViewers: [mismatchedViewer],
            },
            generation: 7,
        }).familiesById.pluginUi?.entriesById ?? {};
        expect(withMismatchedIdentity).not.toHaveProperty(viewerEntryId);
    });

    it('carries only the canonical Resource capability onto every V2 projected surface', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-resource',
                identity: { pluginId: 'acme.generated-resource', localId: 'renderer' },
                manifestPath: '/plugins/acme-generated/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Resource' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-resource',
                identity: { pluginId: 'acme.generated-resource', localId: 'generated-resource-surface' },
                manifestPath: '/plugins/acme-generated/.happier-plugin/plugin.json',
                definition: {
                    id: 'generated-resource-surface',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Resource',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {
                resourceCapabilityForPlugin: () => ({ readable: true, dynamic: false }),
            },
        }).familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.generated-resource:generated-resource-surface'])
            .toMatchObject({ runtime: { resourceCapability: { readable: true, dynamic: false } } });
        expect(entries['surfacePlacement:acme.generated-resource:generated-resource-surface'])
            .not.toHaveProperty('runtime.resourceCapability.resourceIds');
    });

    it('projects normalized destination bindings and the declared settings-page destination', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'session-panel' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'session-panel',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Session panel',
                },
            }],
            uiSettingsGroupsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation',
                    title: 'Navigation',
                    icon: 'browser',
                    defaultRank: 12,
                },
            }],
            uiSettingsPagesV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation-settings' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation-settings',
                    group: { kind: 'plugin', localId: 'navigation' },
                    title: 'Navigation settings',
                    keywords: ['navigation'],
                    renderer: 'renderer',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.navigation:session-panel']).toMatchObject({
            contributionKind: 'surfacePlacement',
            binding: {
                destination: { pluginId: 'acme.navigation', localId: 'session-panel' },
                renderer: { pluginId: 'acme.navigation', localId: 'renderer' },
                container: 'rightPane',
                target: { kind: 'session' },
                targetKind: 'session',
                instancePolicy: 'singleton',
                platforms: ['desktop', 'web'],
            },
        });
        expect(entries['surfacePlacement:acme.navigation:session-panel'])
            .not.toHaveProperty('binding.collisionDomain');
        expect(entries['surfacePlacement:acme.navigation:session-panel'])
            .not.toHaveProperty('binding.collisionKey');
        expect(entries['settingsGroup:acme.navigation:navigation']).toMatchObject({
            contributionKind: 'settingsGroup',
            group: {
                id: { pluginId: 'acme.navigation', localId: 'navigation' },
                title: 'Navigation',
                icon: 'browser',
                defaultRank: 12,
            },
        });
        expect(entries['settingsPage:acme.navigation:navigation-settings']).toMatchObject({
            contributionKind: 'settingsPage',
            page: {
                id: { pluginId: 'acme.navigation', localId: 'navigation-settings' },
                group: { kind: 'plugin', id: { pluginId: 'acme.navigation', localId: 'navigation' } },
                title: 'Navigation settings',
                keywords: ['navigation'],
            },
            binding: {
                destination: { pluginId: 'acme.navigation', localId: 'navigation-settings' },
                renderer: { pluginId: 'acme.navigation', localId: 'renderer' },
                container: 'settingsPage',
                target: { kind: 'app' },
                targetKind: 'app',
            },
        });
    });

    it('keeps tablet-capable destinations available for final native form-factor admission', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.tablet',
                identity: { pluginId: 'acme.tablet', localId: 'renderer' },
                manifestPath: '/plugins/acme-tablet/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Tablet' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.tablet',
                identity: { pluginId: 'acme.tablet', localId: 'panel' },
                manifestPath: '/plugins/acme-tablet/.happier-plugin/plugin.json',
                definition: {
                    id: 'panel',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'renderer',
                    title: 'Tablet panel',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({
            registry,
            generation: 1,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    hostRuntime: {
                        platform: 'ios',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0])
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.tablet:panel'];

        expect(entry).toMatchObject({
            binding: { platforms: ['desktop', 'web'] },
            availability: {
                state: 'fallback',
                reason: 'declarative_model_unavailable',
            },
        });
        expect(entry).not.toMatchObject({
            availability: { reason: 'destination_platform_unavailable' },
        });
    });

    it('qualifies app-page header actions at the compiled projection boundary', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation-page' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation-page',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'renderer',
                    headerActions: [{
                        id: 'refresh',
                        title: 'Refresh',
                        command: { kind: 'executeAction', action: 'refresh-navigation' },
                    }],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.navigation:navigation-page'];

        expect(entry).toMatchObject({
            binding: {
                container: 'appPage',
                targetKind: 'app',
                surfaceContextPlacement: 'appSurface',
            },
            headerActions: [{
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.navigation', localId: 'refresh-navigation' },
                },
            }],
        });
        // The compiled entry carries the qualified semantic command only; the
        // retired `action` spelling must not survive anywhere on the wire.
        expect(entry).not.toHaveProperty('headerActions.0.action');
    });

    it('projects bounded destination presentation defaults without assigning placement authority', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'navigation-page' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'navigation-page',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'renderer',
                    title: { key: 'navigation.title', fallback: 'Navigation' },
                    icon: 'settings',
                    badge: {
                        label: { key: 'navigation.badge', fallback: 'Preview' },
                        tone: 'accent',
                    },
                    groupHint: 'sessions',
                    rankHint: -25,
                    headerActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.navigation:navigation-page'];

        expect(entry).toMatchObject({
            display: {
                titleKey: 'navigation.title',
                developerFallback: 'Navigation',
                iconToken: 'settings',
                badge: {
                    labelKey: 'navigation.badge',
                    developerFallback: 'Preview',
                    tone: 'accent',
                },
                groupHint: 'sessions',
                rankHint: -25,
            },
        });
    });

    it('keeps authored literal destination presentation distinct from keyed localized presentation', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Navigation' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.navigation',
                identity: { pluginId: 'acme.navigation', localId: 'literal-navigation-page' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'literal-navigation-page',
                    container: 'appPage',
                    target: { kind: 'app' },
                    renderer: 'renderer',
                    title: 'Navigation',
                    badge: { label: 'Preview', tone: 'accent' },
                    headerActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const entry = buildPluginProjectionV2({ registry, generation: 1 })
            .familiesById.pluginUi?.entriesById['surfacePlacement:acme.navigation:literal-navigation-page'];

        expect(entry).toMatchObject({
            display: {
                title: 'Navigation',
                badge: { label: 'Preview', tone: 'accent' },
            },
        });
        expect(entry).not.toHaveProperty('display.titleKey');
        expect(entry).not.toHaveProperty('display.developerFallback');
        expect(entry).not.toHaveProperty('display.badge.labelKey');
        expect(entry).not.toHaveProperty('display.badge.developerFallback');
    });

    it('gives the deterministic V2 locale owner precedence over the legacy translation adapter', () => {
        const v2Translations = [
            {
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale: 'en' },
                manifestPath: '/plugins/acme/z.plugin.json',
                definition: { locale: 'en', messages: { title: 'Zulu V2' } },
            },
            {
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale: 'en' },
                manifestPath: '/plugins/acme/a.plugin.json',
                definition: { locale: 'en', messages: { title: 'Alpha V2' } },
            },
        ] as const;
        const project = (translations: readonly (typeof v2Translations)[number][]) => {
            const registry = {
                ...createEmptyResolvedContributionRegistry(),
                uiTranslationsV2: translations,
                uiTranslations: [{
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/legacy.plugin.json',
                    definition: {
                        locales: { en: { title: 'Legacy V1' } },
                    },
                }],
            } as unknown as ResolvedContributionRegistry;
            return buildPluginProjectionV2({ registry, generation: 1 })
                .familiesById.pluginUi?.entriesById['translations:acme.preview'];
        };

        const forward = project(v2Translations);
        const reversed = project([...v2Translations].reverse());

        expect(forward).toEqual(reversed);
        expect(forward).toMatchObject({
            bundles: { en: { title: 'Zulu V2' } },
            diagnostics: ['duplicate_translation_locale'],
        });
        expect(JSON.stringify(forward)).not.toContain('Legacy V1');
    });

    it('ships only the locales a client can read when the describe request names one', () => {
        const contributedLocales = ['en', 'fr', 'ja', 'ru'] as const;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiTranslationsV2: contributedLocales.map((locale) => ({
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale },
                manifestPath: `/plugins/acme/${locale}.plugin.json`,
                definition: { locale, messages: { title: `title-${locale}` } },
            })),
        } as unknown as ResolvedContributionRegistry;

        const project = (requestedLocale?: string) => buildPluginProjectionV2({
            registry,
            generation: 1,
            ...(requestedLocale === undefined ? {} : { requestedLocale }),
        } as Parameters<typeof buildPluginProjectionV2>[0])
            .familiesById.pluginUi?.entriesById['translations:acme.preview'] as unknown as Readonly<{
                locales: readonly string[];
                bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
            }>;

        // The only reader (`resolvePluginUiTranslationBundle`) merges the preferred
        // locale over English and never touches another one, so nothing else belongs
        // on the wire.
        const narrowed = project('fr');
        expect(Object.keys(narrowed.bundles)).toEqual(['en', 'fr']);
        expect(narrowed.bundles).toEqual({
            en: { title: 'title-en' },
            fr: { title: 'title-fr' },
        });
        // `locales` stays the full availability fact; only the payload narrows.
        expect(narrowed.locales).toEqual(['en', 'fr', 'ja', 'ru']);

        // An English client needs exactly one bundle.
        expect(Object.keys(project('en').bundles)).toEqual(['en']);

        // A client that names no locale — an older one — still receives everything.
        expect(Object.keys(project().bundles)).toEqual(['en', 'fr', 'ja', 'ru']);
    });

    it('projects connected-account descriptors only through the canonical connectedAccounts family', async () => {
        const { resolveBuiltInContributions } = await import('../resolveBuiltInContributions');
        const builtIn = resolveBuiltInContributions();
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            connectedAccountDescriptors: builtIn.connectedAccountDescriptors,
            scmHostingProviders: builtIn.scmHostingProviders,
        } as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {},
        } as Parameters<typeof buildPluginProjectionV2>[0]);

        expect(projection.familiesById.connectedAccounts?.entriesById['happier.scm.forge.bitbucket/bitbucket-account'])
            .toEqual(expect.objectContaining({
                id: 'bitbucket-account',
                serviceId: 'bitbucket',
                pluginId: 'happier.scm.forge.bitbucket',
                provenance: 'first_party',
                sourceKind: 'bundled',
                availability: { state: 'available', reason: 'resolved' },
                authentication: expect.objectContaining({
                    defaultModeId: 'manual',
                    modes: expect.arrayContaining([
                        expect.objectContaining({
                            id: 'manual',
                            kind: 'manual',
                            fields: expect.arrayContaining([
                                expect.objectContaining({ id: 'token', secret: true }),
                            ]),
                        }),
                    ]),
                }),
            }));
        expect(projection.familiesById.pluginUi?.entriesById)
            .not.toHaveProperty('connectedAccountDescriptor:happier.scm.forge.bitbucket:bitbucket-account');
    });

    it('does not project host-private structured-message descriptors even when a registry contains one', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            structuredMessages: [
                {
                    pluginId: 'acme.preview',
                    definition: {
                        id: 'preview-card',
                        title: 'Preview',
                        kind: 'acme.preview/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: 'summary-card',
                        fallback: { kind: 'summary', template: 'Preview unavailable' },
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 3,
            pluginUiHostRuntime: {
                structuredMessages: { featureEnabled: true },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};
        expect(entries['structuredMessage:acme.preview:preview-card']).toBeUndefined();
    });

    it('projects transcript Activity descriptors as same-plugin qualified Resource and Action identities', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            transcriptActivities: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                identity: { pluginId: 'acme.preview', localId: 'outward-delivery' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'outward-delivery',
                    resourceId: 'outward-delivery-activities-v1',
                    actions: ['retry-delivery'],
                },
            }],
        } satisfies ResolvedContributionRegistry;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 9,
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        expect(entries['transcriptActivity:acme.preview:outward-delivery']).toEqual({
            id: 'transcriptActivity:acme.preview:outward-delivery',
            pluginId: 'acme.preview',
            contributionKind: 'transcriptActivity',
            descriptorId: 'outward-delivery',
            resource: { pluginId: 'acme.preview', localId: 'outward-delivery-activities-v1' },
            actions: [{ pluginId: 'acme.preview', localId: 'retry-delivery' }],
        });
    });

    it('projects a Session-info section through the canonical declarative model', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            sessionInfoSections: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                pluginVersion: '1.0.0',
                identity: { pluginId: 'acme.preview', localId: 'overview' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'overview',
                    resourceId: 'session-overview',
                    order: 25,
                    actions: ['open-details'],
                },
            }],
        } satisfies ResolvedContributionRegistry;
        const model = {
            identity: {
                pluginId: 'acme.preview',
                localId: 'session-info-overview',
                qualifiedId: 'acme.preview/session-info-overview',
                generation: '9',
            },
            visible: true,
            requiredHostMethods: ['context', 'executeAction', 'readResource', 'watchResource'],
            declarativeInventory: emptyDeclarativeInventory,
            root: {
                kind: 'state',
                path: 'root',
                order: 0,
                state: 'loading',
                title: 'Loading overview',
            },
        } satisfies StablePluginDeclarativeModel;

        const entries = buildPluginProjectionV2({
            registry,
            generation: 9,
            pluginUiHostRuntime: {
                declarative: { modelsByRendererKey: { ['acme.preview\0session-info-overview']: model } },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};

        expect(entries['sessionInfoSection:acme.preview:overview']).toMatchObject({
            pluginId: 'acme.preview',
            pluginVersion: '1.0.0',
            contributionKind: 'sessionInfoSection',
            descriptorId: 'overview',
            order: 25,
            resource: { pluginId: 'acme.preview', localId: 'session-overview' },
            actions: [{ pluginId: 'acme.preview', localId: 'open-details' }],
            renderer: {
                kind: 'declarative',
                contributionId: 'session-info-overview',
                model,
                documentSource: { kind: 'resource', resourceId: 'session-overview' },
            },
            placement: {
                contributionKind: 'surfacePlacement',
                descriptorId: 'overview',
                binding: expect.objectContaining({
                    kind: 'inline',
                    role: 'sessionInfoSection',
                    surface: { pluginId: 'acme.preview', localId: 'overview' },
                    target: { kind: 'session' },
                    targetKind: 'session',
                }),
            },
        });
    });

    it('rejects a duplicate V2 view id instead of selecting a projection-order survivor (DR-2)', () => {
        const renderer = {
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'renderer' },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: 'renderer',
                kind: 'declarative',
                root: { kind: 'text', text: 'Review' },
            },
        };
        const makeView = (title: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            identity: { pluginId: 'acme.review', localId: 'dupe-panel' },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: 'dupe-panel',
                container: 'servicesPanel',
                target: { kind: 'services' },
                renderer: 'renderer',
                title,
                headerActions: [],
                fallbackRenderers: [],
            },
        });
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [renderer],
            uiViewsV2: [makeView('First'), makeView('Second')],
        } as unknown as ResolvedContributionRegistry;

        expect(() => buildPluginProjectionV2({ registry, generation: 9 }))
            .toThrow("Duplicate projected plugin UI contribution 'surfacePlacement:acme.review:dupe-panel'");
    });

    it('projects every V2 view through the canonical surface-placement family and adopts the first admitted renderer fallback', () => {
        const generatedArtifact = {
            contributionId: 'panel-artifact',
            tier: 'reactNative' as const,
            platform: 'web' as const,
            entry: 'react-native/panel/index.js',
            files: [
                {
                    relativePath: 'react-native/panel/chunk.js',
                    digest: `sha256:${'2'.repeat(64)}`,
                    byteSize: 11,
                },
                {
                    relativePath: 'react-native/panel/index.js',
                    digest: `sha256:${'3'.repeat(64)}`,
                    byteSize: 12,
                },
            ],
            digest: `sha256:${'1'.repeat(64)}`,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {
                react: '19.2.0',
                reactNative: '0.83.4',
            },
        };
        const generatedHostedArtifact = {
            contributionId: 'hosted-artifact',
            tier: 'hostedWeb' as const,
            platform: 'web' as const,
            entry: 'hosted-web/hosted-artifact/index.html',
            files: [
                {
                    relativePath: 'hosted-web/hosted-artifact/index.html',
                    digest: `sha256:${'5'.repeat(64)}`,
                    byteSize: 13,
                },
                {
                    relativePath: 'hosted-web/hosted-artifact/assets/index.js',
                    digest: `sha256:${'6'.repeat(64)}`,
                    byteSize: 14,
                },
            ],
            digest: `sha256:${'4'.repeat(64)}`,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        };
        const stableDeclarativeModel = {
            identity: {
                pluginId: 'acme.generated-rnw',
                localId: 'declarative-renderer',
                qualifiedId: 'acme.generated-rnw/declarative-renderer',
                generation: '31',
            },
            visible: true,
            requiredHostMethods: ['context', 'executeAction'],
            declarativeInventory: emptyDeclarativeInventory,
            root: { kind: 'text', path: 'root', order: 0, text: 'Generated status' },
        } satisfies StablePluginDeclarativeModel;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'panel-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 1 as const,
                    entries: [generatedArtifact],
                },
                definition: {
                    id: 'panel-renderer',
                    kind: 'reactNative',
                    artifact: 'panel-artifact',
                    requiredHostMethods: ['context', 'watchContext'],
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'declarative-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'declarative-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Generated status' },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 1 as const,
                    entries: [generatedHostedArtifact],
                },
                definition: {
                    id: 'hosted-renderer',
                    kind: 'hostedWeb',
                    source: { kind: 'artifact', artifact: 'hosted-artifact' },
                    requiredHostMethods: ['context'],
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'panel' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'panel',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'panel-renderer',
                    title: 'Generated panel',
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'declarative-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'declarative-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'declarative-renderer',
                    title: { key: 'settings.title', fallback: 'Generated settings' },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'hosted-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'hosted-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'hosted-renderer',
                    fallbackRenderers: ['panel-renderer'],
                    title: 'Generated hosted panel',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 31,
            pluginUiHostRuntime: {
                hostedWeb: {
                    featureEnabled: true,
                    frameCapability: {
                        platform: 'web',
                        adapter: 'domIframe',
                    },
                },
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: [],
                    },
                },
                declarative: {
                    modelsByRendererKey: {
                        ['acme.generated-rnw\0declarative-renderer']: stableDeclarativeModel,
                    },
                },
            },
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['reactNativeBundle:acme.generated-rnw:panel-renderer']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'reactNativeBundle',
            contributionId: 'panel-renderer',
            artifactGraph: generatedArtifact,
            requiredHostMethods: ['context', 'watchContext'],
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                cacheIdentity: {
                    pluginId: 'acme.generated-rnw',
                    contributionId: 'panel-renderer',
                    artifactDigest: generatedArtifact.digest,
                    platform: 'web',
                    projectionGeneration: 31,
                },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
        expect(entries['reactNativeBundle:acme.generated-rnw:panel-renderer']?.artifactGraph)
            .toEqual(generatedArtifact);
        expect(entries['surfacePlacement:acme.generated-rnw:panel']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'panel',
            container: 'rightPane',
            binding: expect.objectContaining({
                container: 'rightPane',
                target: { kind: 'session' },
            }),
            renderer: { kind: 'reactNative', contributionId: 'panel-renderer' },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:declarative-view']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'declarative-view',
            generatedV2: true,
            container: 'rightPane',
            binding: expect.objectContaining({
                container: 'rightPane',
                target: { kind: 'session' },
            }),
            display: { titleKey: 'settings.title', developerFallback: 'Generated settings' },
            renderer: {
                kind: 'declarative',
                contributionId: 'declarative-renderer',
                model: stableDeclarativeModel,
            },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:declarative-view']).not.toHaveProperty('order');
        expect(entries['surfacePlacement:acme.generated-rnw:hosted-view']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'hosted-view',
            generatedV2: true,
            container: 'rightPane',
            binding: expect.objectContaining({
                container: 'rightPane',
                target: { kind: 'session' },
                rendererChain: [
                    { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
                    { pluginId: 'acme.generated-rnw', localId: 'panel-renderer' },
                ],
                renderer: { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
            }),
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'hosted-renderer',
            },
            availability: {
                state: 'available',
                reason: 'available',
            },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:hosted-view'])
            .not.toHaveProperty('fallbackRenderers');
        expect(entries['hostedWeb:acme.generated-rnw:hosted-renderer']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'hostedWeb',
            contributionId: 'hosted-renderer',
            generatedV2: true,
            bridge: { allowedMessages: ['ready', 'hostApi'] },
            entry: { routeMode: 'pathFallback', path: '/' },
            runtime: {
                state: 'available',
                diagnostics: [],
                artifactReadIdentity: {
                    pluginId: 'acme.generated-rnw',
                    contributionId: 'hosted-renderer',
                    artifactDigest: generatedHostedArtifact.digest,
                    platform: 'web',
                    projectionGeneration: 31,
                },
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        });
        expect(entries['hostedWeb:acme.generated-rnw:hosted-renderer'])
            .not.toHaveProperty('runtimeMode');
        expect(entries['hostedWeb:acme.generated-rnw:hosted-renderer']?.artifactGraph)
            .toEqual(generatedHostedArtifact);

        // A missing physical frame fact does not leave a renderer-local
        // unavailable terminal. The canonical surface-placement selector
        // consumes the hosted renderer's fallback decision and adopts the
        // next declared renderer in its existing chain.
        const adapterUnavailableProjection = buildPluginProjectionV2({
            registry,
            generation: 31,
            pluginUiHostRuntime: {
                hostedWeb: { featureEnabled: true },
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: [],
                    },
                },
                declarative: {
                    modelsByRendererKey: {
                        ['acme.generated-rnw\0declarative-renderer']: stableDeclarativeModel,
                    },
                },
            },
        });
        const adapterUnavailableEntries = adapterUnavailableProjection.familiesById.pluginUi?.entriesById ?? {};

        expect(adapterUnavailableEntries['hostedWeb:acme.generated-rnw:hosted-renderer']).toMatchObject({
            runtime: {
                state: 'fallback',
                diagnostics: ['hosted_web_frame_adapter_unavailable'],
                decision: {
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                },
            },
        });
        expect(adapterUnavailableEntries['surfacePlacement:acme.generated-rnw:hosted-view']).toMatchObject({
            renderer: { kind: 'reactNative', contributionId: 'panel-renderer' },
            availability: { state: 'available', reason: 'available' },
        });
    });

    it('owns declarative availability only in the evaluated-model path', () => {
        const declarativeRenderer = (localId: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.declarative',
            identity: { pluginId: 'acme.declarative', localId },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: localId,
                kind: 'declarative',
                root: { kind: 'text', text: 'Status' },
                requiredHostMethods: ['context'],
            },
        });
        const declarativeView = (localId: string, renderer: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.declarative',
            identity: { pluginId: 'acme.declarative', localId },
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            definition: {
                id: localId,
                container: 'rightPane',
                target: { kind: 'session' },
                renderer,
                title: 'Declarative',
            },
        });
        const model = (visible: boolean, localId: string) => ({
            identity: {
                pluginId: 'acme.declarative',
                localId,
                qualifiedId: `acme.declarative/${localId}`,
                generation: '7',
            },
            visible,
            requiredHostMethods: ['context'],
            declarativeInventory: emptyDeclarativeInventory,
            root: { kind: 'text', path: 'root', order: 0, text: 'Status' },
        } satisfies StablePluginDeclarativeModel);
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [
                declarativeRenderer('visible-renderer'),
                declarativeRenderer('hidden-renderer'),
                declarativeRenderer('modelless-renderer'),
            ],
            uiViewsV2: [
                declarativeView('visible-view', 'visible-renderer'),
                declarativeView('hidden-view', 'hidden-renderer'),
                declarativeView('modelless-view', 'modelless-renderer'),
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {
                declarative: {
                    modelsByRendererKey: {
                        ['acme.declarative\0visible-renderer']: model(true, 'visible-renderer'),
                        ['acme.declarative\0hidden-renderer']: model(false, 'hidden-renderer'),
                    },
                },
            },
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.declarative:visible-view']?.availability)
            .toMatchObject({ state: 'available', reason: 'available' });
        expect(entries['surfacePlacement:acme.declarative:hidden-view']?.availability)
            .toMatchObject({ state: 'fallback', reason: 'declarative_model_hidden' });
        expect(entries['surfacePlacement:acme.declarative:modelless-view']?.availability)
            .toMatchObject({ state: 'fallback', reason: 'declarative_model_unavailable' });

        // The generic renderer-availability projector must not carry a second declarative
        // decision: it schema-parses through the strict v1 renderer union, which has no
        // declarative member, so any declarative branch there is unreachable and wrong.
        const source = readFileSync(new URL('./projection.ts', import.meta.url), 'utf8');
        const start = source.indexOf('function projectSurfaceAvailability');
        expect(start).toBeGreaterThan(-1);
        const end = source.indexOf('\n}\n', start);
        expect(end).toBeGreaterThan(start);
        expect(source.slice(start, end)).not.toContain('declarative');
    });

    it('projects a declarative document source beside its evaluated static model', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.declarative',
                identity: { pluginId: 'acme.declarative', localId: 'dashboard' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Static dashboard' },
                    documentSource: { kind: 'resource', resourceId: 'live-dashboard' },
                },
            }],
            uiViewsV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.declarative',
                identity: { pluginId: 'acme.declarative', localId: 'dashboard-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                definition: {
                    id: 'dashboard-view',
                    container: 'rightPane',
                    target: { kind: 'session' },
                    renderer: 'dashboard',
                    title: 'Dashboard',
                    instancePolicy: 'singleton',
                    headerActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;
        const model = {
            identity: {
                pluginId: 'acme.declarative',
                localId: 'dashboard',
                qualifiedId: 'acme.declarative/dashboard',
                generation: '7',
            },
            visible: true,
            requiredHostMethods: [],
            declarativeInventory: emptyDeclarativeInventory,
            root: { kind: 'text', path: 'root', order: 0, text: 'Static dashboard' },
        } satisfies StablePluginDeclarativeModel;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 7,
            pluginUiHostRuntime: {
                declarative: {
                    modelsByRendererKey: {
                        ['acme.declarative\0dashboard']: model,
                    },
                },
            },
        });
        const entry = projection.familiesById.pluginUi?.entriesById[
            'surfacePlacement:acme.declarative:dashboard-view'
        ];

        expect(entry).toMatchObject({
            renderer: {
                kind: 'declarative',
                contributionId: 'dashboard',
                documentSource: { kind: 'resource', resourceId: 'live-dashboard' },
                model,
            },
        });
    });

    it('projects a Voice provider client from its canonical generated artifact graph without a UI renderer', () => {
        const generatedArtifact = {
            contributionId: 'voice-runtime-web',
            tier: 'reactNative' as const,
            platform: 'web' as const,
            entry: 'react-native/voice-runtime-web/index.js',
            files: [{
                relativePath: 'react-native/voice-runtime-web/index.js',
                digest: `sha256:${'4'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'3'.repeat(64)}`,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            voiceProviders: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId: 'acme.generated-voice',
                pluginVersion: '1.0.0',
                identity: { pluginId: 'acme.generated-voice', localId: 'conversation' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 1 as const, entries: [generatedArtifact] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['web'],
                    capabilities: {
                        turn: { cancelResponse: true, bargeIn: false },
                    },
                    client: {
                        artifactId: generatedArtifact.contributionId,
                        modulePath: './voiceRuntime',
                        exportName: 'activate',
                    },
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 33,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: [],
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['reactNativeBundle:acme.generated-voice:conversation']).toMatchObject({
            pluginId: 'acme.generated-voice',
            contributionKind: 'reactNativeBundle',
            contributionId: 'conversation',
            artifactGraph: generatedArtifact,
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                cacheIdentity: {
                    pluginId: 'acme.generated-voice',
                    contributionId: 'conversation',
                    artifactDigest: generatedArtifact.digest,
                    platform: 'web',
                    projectionGeneration: 33,
                },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
        expect(Object.keys(entries).some((id) => id.startsWith('uiArtifact:acme.generated-voice:'))).toBe(false);
    });

    it('projects a client Action under its own identity without borrowing a co-resident Voice Artifact', () => {
        const pluginId = 'acme.generated-client-action';
        const actionId = 'open-preview';
        const actionArtifact = {
            contributionId: 'open-preview-artifact',
            tier: 'reactNative' as const,
            platform: 'ios' as const,
            entry: 'react-native/open-preview/index.js',
            files: [{
                relativePath: 'react-native/open-preview/index.js',
                digest: `sha256:${'5'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'6'.repeat(64)}`,
            builtWith: { bundler: 'repack' as const, version: '5.2.5' },
            repack: {
                containerName: 'acme_generated_client_action',
                modulePath: './openPreview',
                exportName: 'activate',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
        const voiceArtifact = {
            contributionId: 'voice-artifact',
            tier: 'reactNative' as const,
            platform: 'ios' as const,
            entry: 'react-native/voice/index.js',
            files: [{
                relativePath: 'react-native/voice/index.js',
                digest: `sha256:${'7'.repeat(64)}`,
                byteSize: 1,
            }],
            digest: `sha256:${'8'.repeat(64)}`,
            builtWith: { bundler: 'repack' as const, version: '5.2.5' },
            repack: {
                containerName: 'acme_generated_client_action',
                modulePath: './voiceRuntime',
                exportName: 'activate',
            },
            hostUiApiVersion: '1.0.0',
            compat: { react: '19.2.0', reactNative: '0.83.4' },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            actions: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId,
                pluginVersion: '1.0.0',
                identity: { pluginId, localId: actionId },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 1 as const, entries: [actionArtifact] },
                definition: {
                    kindVersion: 1,
                    id: actionId,
                    title: 'Open preview',
                    description: null,
                    safety: 'safe',
                    placements: [],
                    slash: null,
                    bindings: null,
                    examples: null,
                    surfaces: {
                        ui: true,
                        voice: false,
                        agent: false,
                        mcp: false,
                        cli: false,
                        rpc: false,
                        api: false,
                        plugin: false,
                    },
                    inputHints: null,
                    inputSchema: {},
                    execution: {
                        target: 'client',
                        client: {
                            artifactId: actionArtifact.contributionId,
                            modulePath: './openPreview',
                            exportName: 'activate',
                        },
                        platforms: ['ios'],
                    },
                    scopes: ['session'],
                    contributionSurfaces: ['ui'],
                    placementBindings: ['detailsPanel'],
                    dangerLevel: 'safe',
                },
            }],
            voiceProviders: [{
                provenance: 'external',
                source: { kind: 'package' },
                pluginId,
                pluginVersion: '1.0.0',
                identity: { pluginId, localId: 'conversation' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 1 as const, entries: [voiceArtifact] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['ios'],
                    capabilities: {
                        turn: { cancelResponse: true, bargeIn: false },
                    },
                    client: {
                        artifactId: voiceArtifact.contributionId,
                        modulePath: './voiceRuntime',
                        exportName: 'activate',
                    },
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 34,
            pluginExecutionOriginsByPluginId: {
                [pluginId]: {
                    serverIdentityId: 'srv_client_action',
                    materializationRef: {
                        machineId: 'machine_client_action',
                        materializationId: 'client-action-materialization',
                        pluginId,
                    },
                },
            },
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    hostRuntime: {
                        platform: 'ios',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.2.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: [],
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};
        const actionEntry = entries[`reactNativeBundle:${pluginId}:${actionId}`];

        expect(actionEntry).toMatchObject({
            pluginId,
            contributionKind: 'reactNativeBundle',
            contributionId: actionId,
            generatedOwnerKind: 'clientContribution',
            artifactGraph: actionArtifact,
            entry: {
                containerName: 'acme_generated_client_action',
                modulePath: './openPreview',
                exportName: 'activate',
            },
            runtime: {
                state: 'loadable',
                cacheIdentity: {
                    pluginId,
                    contributionId: actionId,
                    artifactDigest: actionArtifact.digest,
                    projectionGeneration: 34,
                },
            },
            serverIdentityId: 'srv_client_action',
            materializationRef: {
                machineId: 'machine_client_action',
                materializationId: 'client-action-materialization',
                pluginId,
            },
        });
        expect(actionEntry).not.toMatchObject({
            artifactGraph: { contributionId: voiceArtifact.contributionId },
            runtime: { cacheIdentity: { contributionId: 'conversation' } },
        });
    });

    it('projects a V2-owned generated native renderer directly without reviving legacy artifact rows', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                identity: { pluginId: 'acme.preview', localId: 'native-preview' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 1 as const,
                    entries: [{
                        contributionId: 'native-artifact',
                        tier: 'reactNative' as const,
                        platform: 'ios' as const,
                        entry: 'react-native/native-preview/ios.bundle',
                        files: [{
                            relativePath: 'react-native/native-preview/ios.bundle',
                            digest: `sha256:${'4'.repeat(64)}`,
                            byteSize: 1,
                        }],
                        digest: `sha256:${'2'.repeat(64)}`,
                        builtWith: { bundler: 'repack' as const, version: '5.2.5' },
                        repack: {
                            containerName: 'acme_preview_native',
                            modulePath: './renderSurface',
                            exportName: 'renderSurface',
                        },
                        hostUiApiVersion: '1.0.0',
                        compat: {
                            react: '19.0.0',
                            reactNative: '0.83.4',
                        },
                    }],
                },
                definition: {
                    id: 'native-preview',
                    kind: 'reactNative',
                    artifact: 'native-artifact',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 32,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    hostRuntime: {
                        platform: 'ios',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: ['clipboard'],
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById[
            'reactNativeBundle:acme.preview:native-preview'
        ];

        expect(entry).toMatchObject({
            contributionKind: 'reactNativeBundle',
            contributionId: 'native-preview',
            artifactGraph: expect.objectContaining({
                contributionId: 'native-artifact',
                platform: 'ios',
                builtWith: { bundler: 'repack', version: '5.2.5' },
                repack: {
                    containerName: 'acme_preview_native',
                    modulePath: './renderSurface',
                    exportName: 'renderSurface',
                },
            }),
            runtime: {
                state: 'loadable',
                decision: {
                    state: 'load',
                    reason: 'compatible',
                    diagnostics: [],
                },
                cacheIdentity: expect.objectContaining({
                    platform: 'ios',
                    artifactDigest: `sha256:${'2'.repeat(64)}`,
                    projectionGeneration: 32,
                }),
            },
        });
        expect(entry).not.toHaveProperty('bundle');
    });
});
