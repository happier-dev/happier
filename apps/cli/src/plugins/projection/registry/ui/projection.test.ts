import tweetnacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
    createPluginUiArtifactSignaturePayloadV1,
    createPluginUiArtifactSignatureSigningInputV1,
    encodeBase64,
    type PluginUiArtifactRevocationV1,
} from '@happier-dev/protocol';

import { createPluginUiArtifactRevocationState } from '@/plugins/install/ui/revocation';
import { buildPluginProjectionV2 } from '../projection/v2';
import type { ResolvedContributionRegistry } from '../types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
    return {
        agents: [],
        agentRuntimes: [],
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
        agentDefinitionsById: new Map(),
        agentRuntimeDefinitionsById: new Map(),
        pluginDiagnosticsByPluginId: {},
    };
}

const display = {
    titleKey: 'title',
    descriptionKey: 'description',
    iconToken: 'browser',
    tone: 'info',
};

// A local path install ALWAYS records the user trust grant as
// `sourceSpec.trustPolicy:'local_trusted'` (see localPath.ts / store/install/source.ts).
// The trust gate keys on that granted policy, NOT on `source.kind`.
const localTrustedPathSourceSpec = {
    kind: 'path',
    locator: '/plugins/acme',
    trustPolicy: 'local_trusted',
    installPolicy: 'link',
} as const;

// A REMOTE marketplace archive keeps `trustPolicy:'prompt'` — install is NOT a
// local trust grant; it must satisfy signature/integrity verification (§5.2).
const remoteMarketplaceSourceSpec = {
    kind: 'archive',
    locator: 'https://registry.example/acme/preview.tgz',
    trustPolicy: 'prompt',
    installPolicy: 'managed_install',
} as const;

const reactNativeBundleContribution = {
    provenance: 'external',
    source: { kind: 'path' },
    sourceSpec: localTrustedPathSourceSpec,
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
    sourceSpec: localTrustedPathSourceSpec,
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

function createSignedReactNativeBundleFixture() {
    const digest = `sha256:${'a'.repeat(64)}`;
    // Signature-path fixtures use a REMOTE (marketplace) source so the
    // signature/integrity gate is the only path to trust (§5.2). A local
    // (`path`/`archive`) source would be trusted-for-local-render WITHOUT a
    // signature (§5.1), which would not exercise signature verification.
    const contribution = {
        ...reactNativeBundleContribution,
        source: { kind: 'marketplace' },
        sourceSpec: remoteMarketplaceSourceSpec,
        definition: {
            ...reactNativeBundleContribution.definition,
            bundle: {
                ...reactNativeBundleContribution.definition.bundle,
                integrity: { digest },
            },
        },
    };
    const unsignedArtifact = {
        ...reactNativeBundleArtifact,
        source: { kind: 'marketplace' },
        sourceSpec: remoteMarketplaceSourceSpec,
        definition: {
            ...reactNativeBundleArtifact.definition,
            integrity: { digest, signingKeyId: 'rn-key-1' },
        },
    };
    const artifactManifest = {
        ...unsignedArtifact.definition,
        pluginId: unsignedArtifact.pluginId,
    };
    const keyPair = tweetnacl.sign.keyPair();
    const payload = createPluginUiArtifactSignaturePayloadV1(artifactManifest);
    const signature = encodeBase64(
        tweetnacl.sign.detached(
            new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
            keyPair.secretKey,
        ),
        'base64url',
    );
    return {
        contribution,
        artifact: {
            ...unsignedArtifact,
            definition: {
                ...unsignedArtifact.definition,
                integrity: {
                    ...unsignedArtifact.definition.integrity,
                    signature,
                },
            },
        },
        trustRoot: {
            id: 'happier-rn-root-v1',
            keys: [{
                keyId: 'rn-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
            }],
        },
    };
}

const embeddedWebBundleContribution = {
    provenance: 'external',
    source: { kind: 'path' },
    sourceSpec: localTrustedPathSourceSpec,
    pluginId: 'acme.preview',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    definition: {
        id: 'embedded-preview',
        bundle: {
            platform: 'web',
            channel: 'internal',
            assetPath: 'embedded-web/embedded-preview/entry.mjs',
            integrity: { digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        },
        entry: { mechanism: 'hostRuntimeFactoryV1' },
        compatibility: {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            hostAppVersion: '2.0.0',
            supportedPlatforms: ['web'],
            supportedChannels: ['internal'],
        },
        hostApi: { minVersion: '1.0.0', methods: ['surface.read'] },
        fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
        display,
        policy: { loadTimeoutMs: 10000, crashThreshold: 3 },
    },
} as const;

const embeddedWebBundleArtifact = {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.preview',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:manifest',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    sourceSpec: {
        kind: 'path',
        locator: '/plugins/acme',
        trustPolicy: 'local_trusted',
        installPolicy: 'link',
    },
    definition: {
        id: 'embedded-preview-web',
        contributionId: 'embedded-preview',
        contributionFamily: 'embeddedWebBundles',
        artifactKind: 'embeddedWebBundle',
        platform: 'web',
        channel: 'internal',
        integrity: { digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        compatibility: {
            hostAppVersion: '2.0.0',
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.0.0',
            nativeCapabilities: [],
        },
        byteSize: 1024,
        contentType: 'text/javascript',
        assetPath: 'embedded-web/embedded-preview/entry.mjs',
    },
} as const;

function createSignedEmbeddedWebBundleFixture() {
    const digest = `sha256:${'c'.repeat(64)}`;
    const contribution = {
        ...embeddedWebBundleContribution,
        source: { kind: 'marketplace' },
        sourceSpec: remoteMarketplaceSourceSpec,
        definition: {
            ...embeddedWebBundleContribution.definition,
            bundle: {
                ...embeddedWebBundleContribution.definition.bundle,
                integrity: { digest },
            },
        },
    };
    const unsignedArtifact = {
        ...embeddedWebBundleArtifact,
        source: { kind: 'marketplace' },
        sourceSpec: remoteMarketplaceSourceSpec,
        definition: {
            ...embeddedWebBundleArtifact.definition,
            integrity: { digest, signingKeyId: 'embedded-key-1' },
        },
    };
    const artifactManifest = {
        ...unsignedArtifact.definition,
        pluginId: unsignedArtifact.pluginId,
    };
    const keyPair = tweetnacl.sign.keyPair();
    const payload = createPluginUiArtifactSignaturePayloadV1(artifactManifest);
    const signature = encodeBase64(
        tweetnacl.sign.detached(
            new TextEncoder().encode(createPluginUiArtifactSignatureSigningInputV1(payload)),
            keyPair.secretKey,
        ),
        'base64url',
    );
    return {
        contribution,
        artifact: {
            ...unsignedArtifact,
            definition: {
                ...unsignedArtifact.definition,
                integrity: {
                    ...unsignedArtifact.definition.integrity,
                    signature,
                },
            },
        },
        trustRoot: {
            id: 'happier-embedded-root-v1',
            keys: [{
                keyId: 'embedded-key-1',
                alg: 'ed25519' as const,
                publicKeyBase64Url: encodeBase64(keyPair.publicKey, 'base64url'),
            }],
        },
    };
}

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
            embeddedWebBundles: [
                embeddedWebBundleContribution,
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
            renderer: { kind: 'host', rendererId: 'summaryCard' },
        });
        expect(entries['surfacePlacement:acme.preview:preview-pane']).toMatchObject({
            contributionKind: 'surfacePlacement',
            placement: 'session.preview',
            availability: { state: 'available', reason: 'available' },
        });
        expect(entries['sessionHeaderAction:acme.preview:open-preview']).toMatchObject({
            contributionKind: 'sessionHeaderAction',
            action: expect.objectContaining({ kind: 'openSurface' }),
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
        expect(entries['embeddedWebBundle:acme.preview:embedded-preview']).toMatchObject({
            contributionKind: 'embeddedWebBundle',
            contributionId: 'embedded-preview',
            bundle: expect.objectContaining({
                platform: 'web',
                assetPath: 'embedded-web/embedded-preview/entry.mjs',
                integrity: { digest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
            }),
            entry: { mechanism: 'hostRuntimeFactoryV1' },
            compatibility: expect.objectContaining({
                hostAppVersion: '2.0.0',
                reactVersion: '19.0.0',
            }),
            fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
            runtime: {
                state: 'fallback',
                diagnostics: ['feature_disabled'],
                decision: {
                    state: 'fallback',
                    reason: 'feature_disabled',
                    diagnostics: ['feature_disabled'],
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
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
            families: expect.objectContaining({
                embeddedWebBundles: expect.stringMatching(/^sha256:/u),
            }),
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
                        kind: 'acme.preview/preview-card.v1',
                        payloadSchema: { type: 'object' },
                        renderer: { kind: 'host', rendererId: 'summaryCard' },
                        display: { titleKey: 'title' },
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
            renderer: { kind: 'host', rendererId: 'summaryCard' },
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

    it('projects fail-closed RN runtime diagnostics when the installed artifact is revoked', () => {
        expect(projectReactNativeFixture({
            uiArtifacts: [{
                ...reactNativeBundleArtifact,
                definition: {
                    ...reactNativeBundleArtifact.definition,
                    revokedAt: '2026-06-14T00:00:00.000Z',
                },
            }],
        })).toMatchObject({
            contributionKind: 'reactNativeBundle',
            runtime: {
                state: 'fallback',
                diagnostics: ['artifact_revoked'],
                decision: {
                    state: 'fallback',
                    reason: 'artifact_revoked',
                    diagnostics: ['artifact_revoked'],
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                },
            },
        });
    });

    it('projects feed-scoped RN artifact revocations before exposing a load policy', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [{
                ...reactNativeBundleArtifact,
                definition: {
                    ...reactNativeBundleArtifact.definition,
                    integrity: {
                        ...reactNativeBundleArtifact.definition.integrity,
                        signingKeyId: 'rn-key-1',
                    },
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    revocationState: createPluginUiArtifactRevocationState({
                        revocations: [{
                            id: 'revoke-rn-key',
                            scope: { kind: 'signingKey', signingKeyId: 'rn-key-1' },
                            reason: 'compromised',
                            revokedAt: '2026-06-15T00:00:00.000Z',
                        } satisfies PluginUiArtifactRevocationV1],
                    }),
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
                diagnostics: ['artifact_revoked'],
                decision: {
                    state: 'fallback',
                    reason: 'artifact_revoked',
                    diagnostics: ['artifact_revoked'],
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
        expect(entry?.runtime).not.toHaveProperty('cacheIdentity');
    });

    it('does not project an RN load policy for untrusted remote artifacts before byte-serving would accept them', () => {
        // A remote (marketplace) source is NOT trusted-for-local-render: it must
        // pass signature/integrity verification (§2.2 / §5.2). Without a trust
        // root or signature it falls back as `execution_trust_unverified`.
        const remoteContribution = {
            ...reactNativeBundleContribution,
            source: { kind: 'marketplace' },
            sourceSpec: remoteMarketplaceSourceSpec,
        };
        const remoteArtifact = {
            ...reactNativeBundleArtifact,
            source: { kind: 'marketplace' },
            sourceSpec: remoteMarketplaceSourceSpec,
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [remoteContribution],
            uiArtifacts: [remoteArtifact],
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
                diagnostics: ['execution_trust_unverified'],
                decision: {
                    state: 'fallback',
                    reason: 'trust_denied',
                    diagnostics: ['execution_trust_unverified'],
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
        expect(entry?.runtime).not.toHaveProperty('cacheIdentity');
    });

    it('projects externally sourced RN artifacts only after signature verification against host trust roots', () => {
        const signed = createSignedReactNativeBundleFixture();
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [signed.contribution],
            uiArtifacts: [signed.artifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    trustRoots: [signed.trustRoot],
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
            },
        });
    });

    it('does not accept caller-asserted verifiedSignature execution trust as proof', () => {
        const signed = createSignedReactNativeBundleFixture();
        const artifactManifest = {
            ...signed.artifact.definition,
            pluginId: signed.artifact.pluginId,
        };
        const forgedTrust = {
            kind: 'verifiedSignature',
            signature: signed.artifact.definition.integrity.signature,
            signingKeyId: 'rn-key-1',
            trustRootId: 'happier-rn-root-v1',
            canonicalPayload: createPluginUiArtifactSignatureSigningInputV1(
                createPluginUiArtifactSignaturePayloadV1(artifactManifest),
            ),
        } as const;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [signed.contribution],
            uiArtifacts: [signed.artifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    executionTrustByArtifactDigest: {
                        [signed.artifact.definition.integrity.digest]: forgedTrust,
                    },
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
                diagnostics: ['execution_trust_unverified'],
                decision: {
                    state: 'fallback',
                    reason: 'trust_denied',
                    diagnostics: ['execution_trust_unverified'],
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
    });

    it('does not let explicit RN signature trust bypass trust-root revocation', () => {
        const signed = createSignedReactNativeBundleFixture();
        const artifactManifest = {
            ...signed.artifact.definition,
            pluginId: signed.artifact.pluginId,
        };
        const explicitTrust = {
            kind: 'verifiedSignature',
            signature: signed.artifact.definition.integrity.signature,
            signingKeyId: 'rn-key-1',
            trustRootId: 'happier-rn-root-v1',
            canonicalPayload: createPluginUiArtifactSignatureSigningInputV1(
                createPluginUiArtifactSignaturePayloadV1(artifactManifest),
            ),
        } as const;
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [signed.contribution],
            uiArtifacts: [signed.artifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                reactNativeBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    trustRoots: [signed.trustRoot],
                    executionTrustByArtifactDigest: {
                        [signed.artifact.definition.integrity.digest]: explicitTrust,
                    },
                    revocationState: createPluginUiArtifactRevocationState({
                        revocations: [{
                            id: 'revoke-root',
                            scope: { kind: 'trustRoot', trustRootId: 'happier-rn-root-v1' },
                            reason: 'compromised',
                            revokedAt: '2026-06-20T00:00:00.000Z',
                        } satisfies PluginUiArtifactRevocationV1],
                    }),
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
                diagnostics: ['execution_trust_unverified'],
                decision: {
                    state: 'fallback',
                    reason: 'trust_denied',
                    diagnostics: ['execution_trust_unverified'],
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
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
            sourceSpec: localTrustedPathSourceSpec,
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
            sourceSpec: localTrustedPathSourceSpec,
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
                    executionTrustByArtifactDigest: {},
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

    it('renders a local (path-source) RN bundle without a signature (install + enable = trust for local render)', () => {
        // §5.1: an installed+enabled plugin from a local source the user pointed
        // the CLI at (`path`) must DERIVE trust for local render — no signature,
        // no explicit `local_trusted` policy required. The family kill-switch
        // (`featureEnabled`) stays the outer gate; revocation stays a kill-switch.
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

    it('blocks a local RN bundle when its installed artifact digest is revoked', () => {
        // §5.1/§5.2: install+enable=trust does NOT bypass the revocation
        // kill-switch even for a local source.
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            reactNativeBundles: [reactNativeBundleContribution],
            uiArtifacts: [{
                ...reactNativeBundleArtifact,
                definition: {
                    ...reactNativeBundleArtifact.definition,
                    revokedAt: '2026-06-15T00:00:00.000Z',
                },
            }],
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
                decision: { reason: 'artifact_revoked' },
                diagnostics: ['artifact_revoked'],
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

    it('projects embedded-web bundles as loadable with a generation-bound installed artifact identity', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            embeddedWebBundles: [embeddedWebBundleContribution],
            uiArtifacts: [embeddedWebBundleArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                embeddedWebBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    trustState: 'full',
                    csp: {
                        supportsSameOriginModuleUrl: false,
                        allowsBlobModuleImport: true,
                    },
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['embeddedWebBundle:acme.preview:embedded-preview'];

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
                cacheIdentity: {
                    pluginId: 'acme.preview',
                    contributionId: 'embedded-preview',
                    artifactDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.0.0',
                    platform: 'web',
                    channel: 'internal',
                    projectionGeneration: 8,
                },
            },
        });
    });

    it('derives full trust for a local (path-source) embedded-web bundle without an injected trust state', () => {
        // §5.1: an installed+enabled embedded-web plugin from a local `path`
        // source DERIVES trust for local render even when the host runtime does
        // not assert `trustState`. Previously this fell back as `trust_denied` /
        // `full_trust_plugin_required`.
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            embeddedWebBundles: [embeddedWebBundleContribution],
            uiArtifacts: [embeddedWebBundleArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                embeddedWebBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    // No trustState injected — projection must derive it.
                    csp: {
                        supportsSameOriginModuleUrl: false,
                        allowsBlobModuleImport: true,
                    },
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['embeddedWebBundle:acme.preview:embedded-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
    });

    it('denies an embedded-web bundle from a remote (marketplace) source without an explicit trust grant', () => {
        // §5.2: remote embedded-web sources are NOT trusted-for-local-render.
        // Remote sources require signature/trust-root verification; provenance or
        // digest alone must not expose a load policy.
        const remoteContribution = {
            ...embeddedWebBundleContribution,
            source: { kind: 'marketplace' },
            sourceSpec: {
                kind: 'marketplace',
                locator: 'acme/preview',
                trustPolicy: 'prompt',
                installPolicy: 'managed_install',
            },
        };
        const remoteArtifact = {
            ...embeddedWebBundleArtifact,
            source: { kind: 'marketplace' },
            sourceSpec: {
                kind: 'marketplace',
                locator: 'acme/preview',
                trustPolicy: 'prompt',
                installPolicy: 'managed_install',
            },
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            embeddedWebBundles: [remoteContribution],
            uiArtifacts: [remoteArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                embeddedWebBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    csp: {
                        supportsSameOriginModuleUrl: false,
                        allowsBlobModuleImport: true,
                    },
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['embeddedWebBundle:acme.preview:embedded-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'fallback',
                decision: {
                    reason: 'trust_denied',
                    diagnostics: ['full_trust_plugin_required'],
                },
            },
        });
    });

    it('does not treat host-asserted embedded-web full trust as executable proof for remote artifacts', () => {
        const remoteContribution = {
            ...embeddedWebBundleContribution,
            source: { kind: 'marketplace' },
            sourceSpec: remoteMarketplaceSourceSpec,
        };
        const remoteArtifact = {
            ...embeddedWebBundleArtifact,
            source: { kind: 'marketplace' },
            sourceSpec: remoteMarketplaceSourceSpec,
        };
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            embeddedWebBundles: [remoteContribution],
            uiArtifacts: [remoteArtifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                embeddedWebBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    trustState: 'full',
                    csp: {
                        supportsSameOriginModuleUrl: false,
                        allowsBlobModuleImport: true,
                    },
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['embeddedWebBundle:acme.preview:embedded-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'fallback',
                decision: {
                    reason: 'trust_denied',
                    diagnostics: ['embeddedWebBundle:source=marketplace:trust=unverified'],
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
        expect(entry?.runtime).not.toHaveProperty('cacheIdentity');
    });

    it('loads a signed embedded-web bundle from a remote source after trust-root verification', () => {
        const signed = createSignedEmbeddedWebBundleFixture();
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            embeddedWebBundles: [signed.contribution],
            uiArtifacts: [signed.artifact],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                embeddedWebBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    trustRoots: [signed.trustRoot],
                    csp: {
                        supportsSameOriginModuleUrl: false,
                        allowsBlobModuleImport: true,
                    },
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['embeddedWebBundle:acme.preview:embedded-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'loadable',
                decision: { state: 'load', reason: 'compatible' },
                loadPolicy: { source: 'installedArtifact' },
            },
        });
    });

    it('projects feed-scoped embedded-web artifact revocations before exposing a load policy', () => {
        const registry = {
            ...createEmptyResolvedContributionRegistry(),
            embeddedWebBundles: [embeddedWebBundleContribution],
            uiArtifacts: [{
                ...embeddedWebBundleArtifact,
                definition: {
                    ...embeddedWebBundleArtifact.definition,
                    integrity: {
                        ...embeddedWebBundleArtifact.definition.integrity,
                        signingKeyId: 'embedded-key-1',
                    },
                },
            }],
        } as unknown as ResolvedContributionRegistry;

        const projection = buildPluginProjectionV2({
            registry,
            generation: 8,
            pluginUiHostRuntime: {
                embeddedWebBundles: {
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                    trustState: 'full',
                    revocationState: createPluginUiArtifactRevocationState({
                        revocations: [{
                            id: 'revoke-embedded-key',
                            scope: { kind: 'signingKey', signingKeyId: 'embedded-key-1' },
                            reason: 'compromised',
                            revokedAt: '2026-06-15T00:00:00.000Z',
                        } satisfies PluginUiArtifactRevocationV1],
                    }),
                    csp: {
                        supportsSameOriginModuleUrl: false,
                        allowsBlobModuleImport: true,
                    },
                    hostRuntime: {
                        platform: 'web',
                        channel: 'internal',
                        hostAppVersion: '2.0.0',
                        hostUiApiVersion: '1.0.0',
                        reactVersion: '19.0.0',
                    },
                },
            },
        } as Parameters<typeof buildPluginProjectionV2>[0]);
        const entry = projection.familiesById.pluginUi?.entriesById['embeddedWebBundle:acme.preview:embedded-preview'];

        expect(entry).toMatchObject({
            runtime: {
                state: 'blocked',
                diagnostics: ['artifact_revoked'],
                decision: {
                    state: 'blocked',
                    reason: 'artifact_revoked',
                    diagnostics: ['artifact_revoked'],
                    fallback: { kind: 'hostedWeb', contributionId: 'preview-web' },
                },
            },
        });
        expect(entry?.runtime).not.toHaveProperty('loadPolicy');
        expect(entry?.runtime).not.toHaveProperty('cacheIdentity');
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
});
