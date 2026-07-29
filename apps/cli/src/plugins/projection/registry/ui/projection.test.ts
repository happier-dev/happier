import { describe, expect, it } from 'vitest';

import { buildPluginProjectionV2 } from '../projection/v2';
import type { ResolvedContributionRegistry } from '../types';
import { resolveBuiltInContributions } from '../resolveBuiltInContributions';

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

// Legacy source trust metadata may remain descriptive, but UI projection
// admission is owned by final package policy plus artifact integrity.
const localPathSourceSpec = {
    kind: 'path',
    locator: '/plugins/acme',
    trustPolicy: 'prompt',
    installPolicy: 'link',
} as const;

const reactNativeBundleContribution = {
    provenance: 'external',
    source: { kind: 'path' },
    sourceSpec: localPathSourceSpec,
    pluginId: 'acme.preview',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    definition: {
        id: 'native-preview',
        bundle: {
            platform: 'ios',
            channel: 'internal',
            integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
        entry: { exportName: 'renderSurface' },
        compatibility: {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            supportedPlatforms: ['ios'],
            supportedChannels: ['internal'],
            requiredNativeCapabilities: ['clipboard'],
        },
        hostApi: { minVersion: '1.0.0' },
        fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
        display,
    },
} as const;

const reactNativeBundleArtifact = {
    provenance: 'external',
    source: { kind: 'path' },
    sourceSpec: localPathSourceSpec,
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
        integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        compatibility: {
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            reactNativeVersion: '0.83.4',
            expoRuntimeVersion: '0.2.0-native',
            hermesVersion: '0.15.0',
            // RN-HARDEN item 2: the channel-gate authority (channel above is provenance).
            supportedChannels: ['internal'],
            nativeCapabilities: ['clipboard'],
        },
        byteSize: 1024,
        contentType: 'application/javascript',
        assetPath: 'react-native/native-preview/ios.bundle.js',
    },
} as const;

function projectReactNativeFixture(params: Readonly<{
    uiArtifacts?: readonly unknown[];
}> = {}) {
    const registry = {
        ...createEmptyResolvedContributionRegistry(),
        reactNativeBundles: [reactNativeBundleContribution],
        uiArtifacts: params.uiArtifacts ?? [],
    } as unknown as ResolvedContributionRegistry;

    const projection = buildPluginProjectionV2({
        registry,
        generation: 8,
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
    return projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];
}

describe('plugin UI projection family', () => {
    it('gives the deterministic V2 locale owner precedence over the legacy translation adapter', () => {
        const v2Translations = [
            {
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale: 'en' },
                manifestPath: '/plugins/acme/z.plugin.json',
                manifestDigest: 'sha256:z',
                definition: { locale: 'en', messages: { title: 'Zulu V2' } },
            },
            {
                pluginId: 'acme.preview',
                localeIdentity: { pluginId: 'acme.preview', locale: 'en' },
                manifestPath: '/plugins/acme/a.plugin.json',
                manifestDigest: 'sha256:a',
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

    it('projects connected-account descriptors only through the canonical connectedAccounts family', () => {
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

        expect(projection.familiesById.connectedAccounts?.entriesById['happier.scm.hosting.bitbucket/bitbucket-account'])
            .toEqual(expect.objectContaining({
                id: 'bitbucket-account',
                serviceId: 'bitbucket',
                pluginId: 'happier.scm.hosting.bitbucket',
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
            .not.toHaveProperty('connectedAccountDescriptor:happier.scm.hosting.bitbucket:bitbucket-account');
    });

    it('projects descriptor, hosted web, executable bundle, translation, and artifact metadata through one host-owned family', () => {
        const previewAction = {
            provenance: 'external' as const,
            source: { kind: 'path' as const },
            pluginId: 'acme.preview',
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:manifest',
            daemonEntryPath: '/plugins/acme/daemon.mjs',
            definition: {
                kindVersion: 1 as const,
                id: 'open-preview',
                title: 'Open preview',
                description: 'Open the plugin preview',
                dangerLevel: 'safe' as const,
                surfaces: {
                    ui: true,
                    voice: false,
                    agent: false,
                    mcp: false,
                    cli: false,
                    rpc: false,
                    sdk: false,
                },
                inputSchema: { type: 'object' as const, additionalProperties: false },
                execution: {
                    routing: 'plugin' as const,
                    handler: { target: 'plugin' as const, exportName: 'openPreview' },
                },
            },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            actions: [previewAction],
            actionsById: new Map([['acme.preview/open-preview', previewAction]]),
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
                        title: 'Preview',
                        kind: 'acme.preview/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: 'summary-card',
                        fallback: { kind: 'summary', template: 'Preview unavailable' },
                    },
                },
            ],
            surfacePlacements: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-pane',
                        placement: 'session.preview',
                        target: { kind: 'session', sessionIdPath: '/session/id' },
                        renderer: { kind: 'host', rendererId: 'previewPlaceholder' },
                        display,
                        actions: [],
                        hostActions: [],
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
                        title: { key: 'title', fallback: 'Open preview' },
                        action: 'open-preview',
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
                        service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
                        entry: { routeMode: 'hostOrigin', path: '/' },
                        bridge: { allowedMessages: ['ready'] },
                        sandbox: { scripts: true },
                        security: {
                            allowedConnectOrigins: ['https://api.example.test'],
                            csp: { connectSrc: 'declaredOrigins', allowEval: false },
                        },
                        fallback: { kind: 'unavailable' },
                        display,
                    },
                },
            ],
            reactNativeBundles: [
                reactNativeBundleContribution,
            ],
            uiArtifacts: [
                reactNativeBundleArtifact,
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'preview-web-static',
                        contributionId: 'preview-web',
                        contributionFamily: 'hostedWeb',
                        artifactKind: 'hostedWebAsset',
                        platform: 'web',
                        channel: 'internal',
                        integrity: { digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
                        compatibility: {
                            hostAppVersion: '1.0.0',
                            hostUiApiVersion: '1.0.0',
                            reactVersion: '19.0.0',
                            nativeCapabilities: [],
                        },
                        byteSize: 2048,
                        contentType: 'text/html',
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                hostedWeb: {
                    featureEnabled: true,
                },
                structuredMessages: {
                    featureEnabled: true,
                },
            },
        });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['structuredMessage:acme.preview:preview-card']).toMatchObject({
            id: 'structuredMessage:acme.preview:preview-card',
            pluginId: 'acme.preview',
            contributionKind: 'structuredMessage',
            kind: 'acme.preview/preview-card.v1',
            fallback: { kind: 'summary', template: 'Preview unavailable' },
        });
        expect(entries['surfacePlacement:acme.preview:preview-pane']).toMatchObject({
            contributionKind: 'surfacePlacement',
            placement: 'session.preview',
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['sessionHeaderAction:acme.preview:open-preview']).toMatchObject({
            contributionKind: 'sessionHeaderAction',
            title: { key: 'title', fallback: 'Open preview' },
            action: 'open-preview',
        });
        expect(entries['hostedWeb:acme.preview:preview-web']).toMatchObject({
            contributionKind: 'hostedWeb',
            service: { kind: 'staticAssets', assetRootId: 'hosted-web/preview-web' },
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'preview-web-static',
                assetRootId: 'hosted-web/preview-web',
            },
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
            security: {
                allowedConnectOrigins: ['https://api.example.test'],
                csp: expect.objectContaining({ connectSrc: 'declaredOrigins' }),
            },
            fallback: { kind: 'unavailable' },
        });
        expect(entries['reactNativeBundle:acme.preview:native-preview']).toMatchObject({
            contributionKind: 'reactNativeBundle',
            compatibility: expect.objectContaining({
                reactVersion: '19.0.0',
                reactNativeVersion: '0.83.4',
            }),
            fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
            runtime: {
                state: 'fallback',
                diagnostics: ['feature_disabled'],
                decision: {
                    state: 'fallback',
                    reason: 'feature_disabled',
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                    diagnostics: ['feature_disabled'],
                },
            },
        });
        expect(entries['uiArtifact:acme.preview:native-preview-ios']).toMatchObject({
            contributionKind: 'uiArtifact',
            artifactKind: 'reactNativeBundle',
            integrity: { digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        });
        expect(entries['uiArtifact:acme.preview:preview-web-static']).toMatchObject({
            contributionKind: 'uiArtifact',
            artifactKind: 'hostedWebAsset',
            integrity: { digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
        });
        expect(entries['translations:acme.preview']).toMatchObject({
            contributionKind: 'translations',
            locales: ['en'],
        });
        expect(entries['digest:acme.preview']).toMatchObject({
            contributionKind: 'digest',
            digest: expect.stringMatching(/^sha256:/u),
            families: expect.any(Object),
        });
    });

    it('omits structured-message entries unless the structured-message feature decision is enabled', () => {
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

        const disabled = buildPluginProjectionV2({
            registry,
            generation: 3,
        }).familiesById.pluginUi?.entriesById ?? {};
        expect(disabled['structuredMessage:acme.preview:preview-card']).toBeUndefined();

        const explicitlyDisabled = buildPluginProjectionV2({
            registry,
            generation: 3,
            pluginUiHostRuntime: {
                structuredMessages: { featureEnabled: false },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};
        expect(explicitlyDisabled['structuredMessage:acme.preview:preview-card']).toBeUndefined();

        const enabled = buildPluginProjectionV2({
            registry,
            generation: 3,
            pluginUiHostRuntime: {
                structuredMessages: { featureEnabled: true },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]).familiesById.pluginUi?.entriesById ?? {};
        expect(enabled['structuredMessage:acme.preview:preview-card']).toMatchObject({
            contributionKind: 'structuredMessage',
            kind: 'acme.preview/preview-card.v1',
            fallback: { kind: 'summary', template: 'Preview unavailable' },
        });
    });

    it('projects fail-closed RN runtime diagnostics when the installed artifact is unavailable', () => {
        expect(projectReactNativeFixture()).toMatchObject({
            contributionKind: 'reactNativeBundle',
            runtime: {
                state: 'fallback',
                diagnostics: ['invalid_manifest'],
                decision: {
                    state: 'fallback',
                    reason: 'unknown',
                    diagnostics: ['invalid_manifest'],
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                },
            },
        });
    });

    it('projects RN bundles as loadable when host runtime gates expose a loader backend', () => {
        const trustedReactNativeBundleArtifact = {
            ...reactNativeBundleArtifact,
            sourceSpec: {
                kind: 'path',
                locator: '/plugins/acme',
                trustPolicy: 'local_trusted',
                installPolicy: 'link',
            },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [trustedReactNativeBundleArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
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
        const entry = projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'loadable',
                diagnostics: [],
                decision: {
                    state: 'load',
                    reason: 'compatible',
                    diagnostics: [],
                },
    loadPolicy: { source: 'installedArtifact' },
                cacheKey: expect.stringContaining('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
                cacheIdentity: expect.objectContaining({
                    projectionGeneration: 8,
                }),
            },
        });
    });

    // NATIVE-PIPELINE (LEDGER DEC-6 follow-up, item 1): platform-aware
    // placement→bundle resolution. `reactNativeBundleContribution` above (a
    // single ios sibling) already proves the SINGLE-platform-per-id case is
    // unchanged (the "ios-only" / "web-only" shape — one sibling always
    // resolves regardless of whether the connecting client reported its
    // platform). These tests cover the NEW multi-sibling ("both") case: a
    // second `bundle.platform: 'web'` contribution sharing the SAME
    // `id: 'native-preview'`.
    describe('platform-family resolution for sibling reactNativeBundles contributions sharing one id', () => {
        const webSiblingContribution = {
            ...reactNativeBundleContribution,
            definition: {
                ...reactNativeBundleContribution.definition,
                bundle: {
                    platform: 'web',
                    channel: 'internal',
                    integrity: { digest: `sha256:${'d'.repeat(64)}` },
                },
                compatibility: {
                    ...reactNativeBundleContribution.definition.compatibility,
                    supportedPlatforms: ['web'],
                },
            },
        };
        const webSiblingArtifact = {
            ...reactNativeBundleArtifact,
            sourceSpec: localPathSourceSpec,
            definition: {
                ...reactNativeBundleArtifact.definition,
                id: 'native-preview-web',
                platform: 'web',
                integrity: { digest: `sha256:${'d'.repeat(64)}` },
                assetPath: 'react-native/native-preview/web.bundle.js',
            },
        };
        const trustedIosArtifact = {
            ...reactNativeBundleArtifact,
            sourceSpec: localPathSourceSpec,
        };

        function buildBothPlatformsProjection(connectingPlatform: string | undefined) {
            const registry = {
                ...createEmptyResolvedContributionRegistry(),
                reactNativeBundles: [reactNativeBundleContribution, webSiblingContribution],
                uiArtifacts: [trustedIosArtifact, webSiblingArtifact],
            } as unknown as ResolvedContributionRegistry;

            const projection = buildPluginProjectionV2({
                registry,
                generation: 8,
                pluginUiHostRuntime: {
                    reactNativeBundles: {
                        featureEnabled: true,
                        loaderBackendAvailable: true,
                        ...(connectingPlatform
                            ? {
                                hostRuntime: {
                                    platform: connectingPlatform,
                                    channel: 'internal',
                                    hostAppVersion: '2.0.0',
                                    hostUiApiVersion: '1.0.0',
                                    reactVersion: '19.0.0',
                                    reactNativeVersion: '0.83.4',
                                    availableNativeCapabilities: ['clipboard'],
                                },
                            }
                            : {}),
                    },
                },
            } as Parameters<typeof buildPluginProjectionV2>[0]);
            return projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];
        }

        it('resolves the ios sibling when the connecting client reports platform: ios', () => {
            const entry = buildBothPlatformsProjection('ios');
            expect(entry).toMatchObject({
                bundle: { platform: 'ios' },
                runtime: {
                    state: 'loadable',
                    decision: { state: 'load', reason: 'compatible' },
                },
            });
        });

        it('resolves the web sibling when the connecting client reports platform: web', () => {
            const entry = buildBothPlatformsProjection('web');
            expect(entry).toMatchObject({
                bundle: { platform: 'web' },
                runtime: {
                    state: 'loadable',
                    decision: { state: 'load', reason: 'compatible' },
                },
            });
        });

        it('fails closed (graceful unavailable) when the connecting platform is not reported', () => {
            const entry = buildBothPlatformsProjection(undefined);
            expect(entry).toMatchObject({
                runtime: {
                    state: 'fallback',
                    diagnostics: ['react_native_bundle_platform_unresolved'],
                    decision: {
                        state: 'fallback',
                        reason: 'platform_unavailable',
                    },
                },
            });
        });

        it('fails closed (graceful unavailable) when the connecting platform matches neither sibling', () => {
            const entry = buildBothPlatformsProjection('android');
            expect(entry).toMatchObject({
                runtime: {
                    state: 'fallback',
                    diagnostics: ['react_native_bundle_platform_unresolved'],
                    decision: {
                        state: 'fallback',
                        reason: 'platform_unavailable',
                    },
                },
            });
        });
    });

    // FIX-RNWEB-SERVING: a first-party BUNDLED contribution
    // (`provenance:'first_party'`) with NO matching `uiArtifacts` entry must
    // fail closed with a diagnosable reason — never silently resolve
    // `loadable`, and never be mistaken for the (correctly denied)
    // dev-hot-reload path, since there is no `devUrl` to even consider one.
    // `resolveReactNativePluginSource` classifies this as `pluginSource:
    // 'internal'`, which `resolveDevHotReloadProjection` denies for a
    // `devUrl`-carrying artifact — but here there is no artifact at all, so
    // the runtime never reaches that gate; it fails via the SAME
    // `validateInstalledReactNativeBundleArtifact({artifact: null, ...})`
    // path a genuinely missing production artifact hits on any platform.
    it('fails closed with a clear diagnostic for a first-party bundled contribution with no registered uiArtifact', () => {
        const firstPartyContribution = {
            ...reactNativeBundleContribution,
            provenance: 'first_party',
            source: { kind: 'bundled' },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [firstPartyContribution],
            uiArtifacts: [],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
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
        const entry = projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'fallback',
                diagnostics: ['invalid_manifest'],
                decision: {
                    state: 'fallback',
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
        expect(entry?.runtime).not.toHaveProperty('cacheKey');
    });

    it('projects a local development RN bundle through dev hot reload without requiring an immutable digest', () => {
        const devContribution = {
            ...reactNativeBundleContribution,
            definition: {
                ...reactNativeBundleContribution.definition,
                bundle: {
                    platform: 'ios',
                    channel: 'development',
                },
                compatibility: {
                    ...reactNativeBundleContribution.definition.compatibility,
                    supportedChannels: ['development'],
                },
                policy: {
                    allowDevHotReload: true,
                },
            },
        };
        const devArtifact = {
            ...reactNativeBundleArtifact,
            definition: {
                ...reactNativeBundleArtifact.definition,
                channel: 'development',
                integrity: undefined,
                assetPath: undefined,
                devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
                compatibility: {
                    ...reactNativeBundleArtifact.definition.compatibility,
                    hostAppVersion: '2.0.0',
                },
            },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [devContribution],
            uiArtifacts: [devArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    devHotReloadEnabled: true,
                    hostRuntime: {
                        platform: 'ios',
                        channel: 'development',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                        reactNativeVersion: '0.83.4',
                        availableNativeCapabilities: ['clipboard'],
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'loadable',
                diagnostics: [],
                decision: {
                    state: 'load',
                    reason: 'compatible',
                    diagnostics: [],
                },
                loadPolicy: {
                    source: 'devHotReload',
                    devUrl: 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true',
                },
            },
        });
    });

    it('renders a final-policy-admitted local RN bundle through artifact integrity', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [reactNativeBundleArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
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
        const entry = projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'loadable',
                decision: {
                    state: 'load',
                    reason: 'compatible',
                },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
    });

    it('keeps a local RN bundle fallback when the family kill-switch (featureEnabled) is off', () => {
        // §5.1: the server/build kill-switch remains the OUTER gate even for a
        // trusted local source.
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [reactNativeBundleArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: false,
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
        const entry = projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'fallback',
                decision: { reason: 'feature_disabled' },
            },
        });
    });

    it('does not default RN bundles enabled when the host omits the canonical feature decision', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [reactNativeBundleArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
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
        const entry = projection.familiesById.pluginUi?.entriesById['reactNativeBundle:acme.preview:native-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'fallback',
                diagnostics: ['feature_disabled'],
                decision: {
                    state: 'fallback',
                    reason: 'feature_disabled',
                    diagnostics: ['feature_disabled'],
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
        expect(entry?.runtime).not.toHaveProperty('cacheIdentity');
    });

    it('does not expose hosted-web runtime mode when the host omits the canonical feature decision', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            hostedWeb: [{
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
                    sandbox: { scripts: true },
                    security: {
                        csp: { connectSrc: 'selfOnly', allowEval: false },
                    },
                    fallback: { kind: 'unavailable' },
                    display,
                },
            }],
            uiArtifacts: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                daemonEntryPath: '/plugins/acme/daemon.mjs',
                definition: {
                    id: 'preview-web-static',
                    contributionId: 'preview-web',
                    contributionFamily: 'hostedWeb',
                    artifactKind: 'hostedWebAsset',
                    platform: 'web',
                    channel: 'internal',
                    integrity: { digest: 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' },
                    compatibility: {
                        hostAppVersion: '1.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                        nativeCapabilities: [],
                    },
                    byteSize: 2048,
                    contentType: 'text/html',
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 8 });
        const entry = projection.familiesById.pluginUi?.entriesById['hostedWeb:acme.preview:preview-web'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'fallback',
                diagnostics: ['feature_disabled'],
                decision: {
                    state: 'fallback',
                    reason: 'feature_disabled',
                    diagnostics: ['feature_disabled'],
                },
            },
        });
        expect(entry).not.toHaveProperty('runtimeMode');
    });

    it('flags a duplicate contribution id with a diagnostic instead of silently dropping it (DR-2)', () => {
        // Two contributions from the same plugin + kind sharing a descriptorId project to
        // the same id-keyed entry. Last-write-wins is preserved (no behavior change to which
        // record survives), but the survivor must carry a `duplicate_contribution_id`
        // diagnostic so the collision is diagnosable instead of dropped (§13.5.6 / §10).
        const makePlacement = (order: number) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.review',
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:manifest',
            daemonEntryPath: '/plugins/acme/daemon.mjs',
            definition: {
                id: 'dupe-panel',
                placement: 'workspace.details',
                target: { kind: 'workspace' },
                renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                display,
                order,
                actions: [],
                hostActions: [],
            },
        });

        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: [makePlacement(1), makePlacement(2)],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 9 });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.review:dupe-panel']).toMatchObject({
            contributionKind: 'surfacePlacement',
            // last-write-wins survivor (order 2) is preserved
            order: 2,
            diagnostics: ['duplicate_contribution_id'],
        });
    });

    it('gates host renderer surface-placement availability on the pure protocol predicate (PR-12)', () => {
        const makeHostPlacement = (id: string, rendererId: string) => ({
            provenance: 'external',
            source: { kind: 'path' },
            pluginId: 'acme.preview',
            manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
            manifestDigest: 'sha256:manifest',
            daemonEntryPath: '/plugins/acme/daemon.mjs',
            definition: {
                id,
                placement: 'workspace.details',
                target: { kind: 'workspace' },
                renderer: { kind: 'host', rendererId },
                display,
                actions: [],
                hostActions: [],
            },
        });

        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: [
                makeHostPlacement('renderable-host', 'descriptorPanel'),
                makeHostPlacement('unknown-host', 'settingsDescriptorPanel'),
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 9 });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        expect(entries['surfacePlacement:acme.preview:renderable-host']).toMatchObject({
            contributionKind: 'surfacePlacement',
            renderer: { kind: 'host', rendererId: 'descriptorPanel' },
            availability: { state: 'available', reason: 'available' },
        });
        const unknownHostEntry = entries['surfacePlacement:acme.preview:unknown-host'] as
            | { availability?: { state?: unknown } }
            | undefined;
        expect(unknownHostEntry?.availability).toMatchObject({
            state: 'fallback',
        });
        expect(unknownHostEntry?.availability?.state)
            .not.toBe('available');
    });

    it('REG-1: rejects a placement whose renderer mode is unsupported by its surface descriptor (reject-at-projection)', () => {
        // `app.settingsPage` is a `container` surface — it supports only the
        // `host`/`declarative` modes, NOT `hostedWeb`. Routing the contribution
        // through PLUGIN_SURFACE_REGISTRY.projectContribution must reject the
        // mode-incompatible placement instead of mounting it blindly.
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            surfacePlacements: [
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'settings-web',
                        placement: 'app.settingsPage',
                        target: { kind: 'app' },
                        renderer: { kind: 'hostedWeb', contributionId: 'settings-web-bundle' },
                        display,
                        actions: [],
                        hostActions: [],
                    },
                },
                {
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId: 'acme.preview',
                    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                    manifestDigest: 'sha256:manifest',
                    daemonEntryPath: '/plugins/acme/daemon.mjs',
                    definition: {
                        id: 'settings-host',
                        placement: 'app.settingsPage',
                        target: { kind: 'app' },
                        renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                        display,
                        actions: [],
                        hostActions: [],
                    },
                },
            ],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({ registry, generation: 12 });
        const entries = projection.familiesById.pluginUi?.entriesById ?? {};

        const rejected = entries['surfacePlacement:acme.preview:settings-web'] as
            | { availability?: { state?: unknown; reason?: unknown; diagnostics?: readonly string[] } }
            | undefined;
        expect(rejected?.availability).toMatchObject({
            state: 'disabled',
            reason: 'surface_contribution_rejected',
        });
        expect(rejected?.availability?.diagnostics).toContain('mode_unsupported');

        // The compatible `host`-mode placement on the same surface still mounts.
        expect(entries['surfacePlacement:acme.preview:settings-host']).toMatchObject({
            availability: { state: 'available', reason: 'available' },
        });
    });

    it('projects every V2 view through the canonical surface-placement family while retaining RN artifact ownership', () => {
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
            compat: { react: '19.2.0' },
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
            root: { kind: 'text', path: 'root', order: 0, text: 'Generated status' },
            nodes: [{ kind: 'text', path: 'root', order: 0, text: 'Generated status' }],
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'panel-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
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
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'declarative-renderer',
                    kind: 'declarative',
                    root: { kind: 'text', text: 'Generated status' },
                    requiredHostMethods: ['context', 'executeAction'],
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'hosted-renderer' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
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
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'panel',
                    placement: 'app.sidePanel',
                    renderer: 'panel-renderer',
                    title: 'Generated panel',
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'declarative-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'declarative-view',
                    placement: 'app.settingsPage',
                    renderer: 'declarative-renderer',
                    title: { key: 'settings.title', fallback: 'Generated settings' },
                },
            }, {
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                identity: { pluginId: 'acme.generated-rnw', localId: 'hosted-view' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'hosted-view',
                    placement: 'app.sidePanel',
                    renderer: 'hosted-renderer',
                    fallbackRenderers: ['panel-renderer'],
                    title: 'Generated hosted panel',
                },
            }],
            surfacePlacements: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.generated-rnw',
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                definition: {
                    id: 'declarative-view',
                    placement: 'app.settingsPage',
                    target: { kind: 'app' },
                    renderer: { kind: 'host', rendererId: 'descriptorPanel' },
                    display: { titleKey: 'legacy-duplicate', developerFallback: 'Legacy duplicate' },
                    order: 99,
                    actions: [],
                    hostActions: [],
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
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
        } as Parameters<typeof buildPluginProjectionV2>[0]);
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
            placement: 'app.sidePanel',
            renderer: { kind: 'reactNative', contributionId: 'panel-renderer' },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['surfacePlacement:acme.generated-rnw:declarative-view']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'surfacePlacement',
            descriptorId: 'declarative-view',
            generatedV2: true,
            placement: 'app.settingsPage',
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
            placement: 'app.sidePanel',
            fallbackRenderers: ['panel-renderer'],
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'hosted-renderer',
                source: { kind: 'artifact', artifact: 'hosted-artifact' },
                requiredHostMethods: ['context'],
            },
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['hostedWeb:acme.generated-rnw:hosted-renderer']).toMatchObject({
            pluginId: 'acme.generated-rnw',
            contributionKind: 'hostedWeb',
            contributionId: 'hosted-renderer',
            generatedV2: true,
            runtimeMode: {
                kind: 'installedStaticAssets',
                artifactId: 'hosted-artifact',
                assetRootId: 'hosted-web/hosted-artifact',
            },
            entry: { routeMode: 'pathFallback', path: '/' },
            runtime: { state: 'available', decision: { state: 'render', reason: 'available' } },
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
                manifestDigest: 'sha256:manifest',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: { version: 1 as const, entries: [generatedArtifact] },
                definition: {
                    id: 'conversation',
                    title: 'Conversation',
                    kind: 'conversation',
                    roles: ['realtime_conversation', 'turn_control'],
                    platforms: ['web'],
                    capabilities: {
                        readiness: { requirements: [] },
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

    it('projects a V2-owned generated native renderer directly without reviving legacy artifact rows', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [reactNativeBundleArtifact],
            uiRenderersV2: [{
                provenance: 'external',
                source: { kind: 'path' },
                pluginId: 'acme.preview',
                identity: { pluginId: 'acme.preview', localId: 'native-preview' },
                manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
                manifestDigest: 'sha256:manifest',
                pluginRootPath: '/plugins/acme',
                generatedUiArtifactsManifest: {
                    version: 1 as const,
                    entries: [{
                        contributionId: 'native-artifact',
                        tier: 'reactNative' as const,
                        platform: 'ios' as const,
                        entry: 'react-native/native-preview/ios.bundle.js',
                        files: [{
                            relativePath: 'react-native/native-preview/ios.bundle.js',
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
        expect(entry?.bundle).not.toEqual(reactNativeBundleContribution.definition.bundle);
    });
});
