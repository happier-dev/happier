import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    encodeBase64,
    DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1Schema,
    DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
    DaemonPluginUiTargetedSurfaceMountV1Schema,
    normalizePluginAccountCollectionContractV1,
    PluginProjectedActionV2Schema,
    PluginProjectionV2Schema,
    type DaemonPluginUiTargetedSurfaceMountV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1,
    type DaemonPluginReactNativeCrashStateV1,
    type BrowserLocalServicePreviewTargetV1,
    type ComposerSnapshotV1,
    type PluginProjectionV2,
} from '@happier-dev/protocol';
import {
    preparePluginJsonSchema,
    rehydrateCanonicalProtocolComposableSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import {
    PLUGIN_UI_HOST_METHODS_V1,
    buildPluginHostedWebStaticAssetPreviewId,
    ComposerSurfaceMountBindingV1Schema,
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    normalizePluginUiDestinationBindingV1,
    normalizePluginUiInlineSurfaceBindingV1,
    normalizePluginUiSettingsPageBindingV1,
    PluginUiArtifactDigestV1Schema,
    PluginUiSurfaceBindingV1Schema,
    PluginUiTargetedContributionsV1Schema,
    type PluginUiDestinationBindingInputV1,
    type PluginUiDestinationBindingV1,
    type PluginUiInlineSurfaceBindingInputV1,
    type PluginUiHostMethodV1,
    type PluginUiTargetedContributionSurfaceV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginAvailabilityActionHttpPathsV1,
    PluginPortableReleaseManifestV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { derivePluginUiTargetedSurfaceMountInstanceKeyV1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';

import { defineUiSurface } from '@happier-dev/plugin-ui';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';
import { completePresentationPluginUiDataClient } from '@/dev/testkit/pluginUiDataClient';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import {
    type HappierUiEnvironment,
} from '@happier-dev/plugin-ui/environment';
import { defineAccountCollection } from '@happier-dev/plugin-sdk/collections';
import type { PluginUiHostApi, RenderContext, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiHostApiClient } from '@happier-dev/plugin-sdk/ui/client';
import type {
    CurrentUiContextMountPublication,
    CurrentUiContextMountPublisher,
} from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import type { PluginUiPrivatePresentationHost } from './pluginUiPrivatePresentationHost';
import type { TargetedPluginSurfaceMountRequest } from './TargetedPluginSurfaceHost';
import type { PluginSurfaceTargetedMountProps } from './PluginSurfaceHost';
import {
    readPluginSurfaceComposerMountBinding,
    readPluginSurfaceEphemeralMountBinding,
} from './pluginSurfaceMountBinding';
import { projectPluginUiTheme } from './pluginUiThemeProjection';
import {
    notifyComposerPresentationTargetChanged,
    registerComposerPresentationTarget,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    createPluginReactNativeWatchdog,
    type PluginReactNativeWatchdog,
    type PluginReactNativeWatchdogPersistence,
    type PluginReactNativeWatchdogSnapshot,
} from '../reactNative/watchdog';

/** A durable store that answers, exactly as the real storage adapter does. */
function createMemoryWatchdogPersistence(): PluginReactNativeWatchdogPersistence {
    let persisted: PluginReactNativeWatchdogSnapshot | null = null;
    return {
        readSnapshot: () => persisted === null ? null : { snapshot: persisted },
        writeSnapshot: (snapshot) => {
            persisted = snapshot;
        },
    };
}

import { createDeferred, flushHookEffects, renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { darkTheme, lightTheme } from '@/theme';
import {
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiPhysicalSurfacePlacementProjection,
    type PluginUiProjectionModel,
    type PluginUiSettingsPageProjection,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { MachinePluginUiResourceWatchNextResult } from '@/sync/ops/machineContributionRegistryProjection';
import {
    setServerProfileIdentityForUrl,
    upsertServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilitySnapshot,
} from '@/sync/domains/plugins/availability/reader';
import { recordAccountStoredContentServerRequirements } from '@/sync/http/accountStoredContentCompatibility';

const directDeclarativeTestEnvironment = Object.freeze({
    theme: projectPluginUiTheme(lightTheme),
    localization: Object.freeze({
        locale: 'en',
        direction: 'ltr' as const,
        translate: (_key: string, fallback?: string): string => fallback ?? '',
    }),
    accessibility: Object.freeze({
        textScale: 1,
        reducedMotion: false,
        screenReaderEnabled: false,
        contrast: 'normal' as const,
    }),
    platform: Object.freeze({ platform: 'web' as const, colorScheme: 'light' as const }),
    insets: Object.freeze({
        safeArea: Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 }),
    }),
}) satisfies HappierUiEnvironment;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GENERATED_DESTINATION_UNAVAILABLE_HOST_METHODS = new Set<PluginUiHostMethodV1>([
    'readResource',
    'statOpenableContent',
    'readOpenableContent',
    'watchResource',
    'openSurface',
    // A generated destination is not a full page, so it has no location of its
    // own to replace. The navigation family stays factually uninstalled here.
    'replacePageLocation',
]);

const EXPECTED_GENERIC_DESTINATION_HOST_METHODS = [
    'context',
    'watchContext',
    'executeAction',
    'readResource',
    'watchResource',
    'notify',
    'confirm',
    'diagnostic',
    'readClipboard',
    'writeClipboard',
    'openExternalLink',
    'selectActionInput',
    'activeComposer',
    'readComposer',
    'watchComposer',
    'applyComposer',
    'focusComposer',
    'setComposerDecorations',
    'acquireComposerInputLock',
] as const satisfies readonly PluginUiHostMethodV1[];

const {
    reactNativeSurfaceProps,
    reactNativeSurfaceRuntime,
    activeLanguage,
    surfaceEnvironment,
    pluginSurfaceDiagnosticLog,
    currentUiContextMountPublisher,
    currentUiContextMountLifecycle,
} = vi.hoisted(() => ({
    reactNativeSurfaceProps: [] as unknown[],
    reactNativeSurfaceRuntime: {
        enabled: false,
        module: null as unknown,
        watchdog: null as PluginReactNativeWatchdog | null,
    },
    activeLanguage: { value: 'en' },
    surfaceEnvironment: {
        platform: 'web' as 'web' | 'ios' | 'android',
        dark: false,
        rtl: false,
        fontScale: 1,
        insets: { top: 0, right: 0, bottom: 0, left: 0 },
        reducedMotion: false,
        screenReaderEnabled: false,
        highContrast: false,
        // Swappable so a test can mount under a DIFFERENT active theme, not just
        // light/dark. `null` keeps the testkit's canonical light theme.
        theme: null as unknown,
    },
    pluginSurfaceDiagnosticLog: vi.fn(),
    currentUiContextMountPublisher: {
        value: null as CurrentUiContextMountPublisher | null,
    },
    currentUiContextMountLifecycle: {
        active: true,
    },
}));
const pluginSurfaceConnectivity = vi.hoisted(() => ({
    endpointStatus: 'online' as 'online' | 'offline',
    machineOnline: true,
    daemonStateVersion: 1,
}));
const pluginSurfaceAccountLifetime = vi.hoisted(() => {
    type TestAccountLifetime = Readonly<{
        scope: Readonly<{ serverId: string; accountId: string }>;
        isCurrent: () => boolean;
        onRetire: (callback: () => void) => Readonly<{ dispose: () => void }>;
    }>;
    let current = true;
    let lifetimeRevision = 0;
    const retirementCallbacks = new Set<() => void>();
    const createLifetime = (scope: Readonly<{ serverId: string; accountId: string }>): TestAccountLifetime => {
        const revision = lifetimeRevision;
        return Object.freeze({
            scope: Object.freeze({ ...scope }),
            isCurrent: () => current && revision === lifetimeRevision,
            onRetire: (callback: () => void) => {
                retirementCallbacks.add(callback);
                return Object.freeze({ dispose: () => retirementCallbacks.delete(callback) });
            },
        });
    };
    const defaultScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
    let defaultLifetime = createLifetime(defaultScope);
    return {
        defaultLifetime,
        value: defaultLifetime as TestAccountLifetime | null,
        reset() {
            current = true;
            lifetimeRevision += 1;
            retirementCallbacks.clear();
            defaultLifetime = createLifetime(defaultScope);
            this.defaultLifetime = defaultLifetime;
            this.value = defaultLifetime;
        },
        setScope(scope: Readonly<{ serverId: string; accountId: string }>) {
            current = true;
            lifetimeRevision += 1;
            retirementCallbacks.clear();
            this.value = createLifetime(scope);
        },
        retire() {
            current = false;
            this.value = null;
            for (const callback of [...retirementCallbacks]) callback();
            retirementCallbacks.clear();
        },
    };
});

/**
 * The SDK fixture is authored in an independently compiled package and imports
 * only public SDK/UI APIs. These cases deliberately mount those real target
 * products through the incumbent host instead of reaching into its private
 * presentation bridge, so the public React/RNW and declarative entry points
 * prove the same cold, target-scoped A→B composition contract.
 */
describe('external targeted source products through the bound surface host', () => {
    const targetPluginId = 'fixture.physical-copy-target';
    const contributorPluginId = 'fixture.physical-copy-contributor';
    const contributorGeneration = 'physical-copy-contributor-generation-a';
    const point = Object.freeze({
        pointId: 'sources',
        protocol: Object.freeze({ id: 'physical-copy-sources', version: 1 }),
    });
    const contributor = Object.freeze({
        pluginId: contributorPluginId,
        contributionId: 'physical-copy-source',
        immutableGenerationId: contributorGeneration,
    });
    const surface = Object.freeze({
        point,
        contributor,
        role: 'detail',
        presentation: 'content' as const,
    } satisfies PluginUiTargetedContributionSurfaceV1);
    const targetReactRendererId = 'physical-copy-target-react-renderer';
    const targetDeclarativeRendererId = 'physical-copy-target-declarative-renderer';
    const targetArtifactDigest = PluginUiArtifactDigestV1Schema.parse(
        `sha256:${'1'.repeat(64)}`,
    );
    const exactTargetedReadyTestId = [
        'plugin-targeted-surface-ready',
        targetPluginId,
        'physical-copy-target-generation-react-exact',
        contributorPluginId,
        contributor.contributionId,
        contributorGeneration,
        contributorPluginId,
        contributor.contributionId,
        'declarative',
    ].join(':');

    type SnapshotVariant = 'exact' | 'missing' | 'duplicate' | 'mismatched';

    function createTargetedFixture(input: Readonly<{
        generation: number;
        targetGeneration: string;
        variant: SnapshotVariant;
    }>) {
        const mountedTarget = Object.freeze({
            pluginId: targetPluginId,
            immutableGenerationId: input.targetGeneration,
        });
        const exposedSurface = input.variant === 'mismatched'
            ? Object.freeze({
                ...surface,
                contributor: Object.freeze({
                    ...contributor,
                    immutableGenerationId: 'physical-copy-contributor-generation-stale',
                }),
            })
            : surface;
        const exposedSurfaces = input.variant === 'missing'
            ? Object.freeze([])
            : input.variant === 'duplicate'
                ? Object.freeze([surface, surface])
                : Object.freeze([exposedSurface]);
        const targetedContributions = Object.freeze({
            target: mountedTarget,
            points: input.variant === 'missing'
                ? Object.freeze([])
                : Object.freeze([Object.freeze({
                    pointId: point.pointId,
                    protocols: Object.freeze([Object.freeze({
                        protocol: point.protocol,
                        contributions: Object.freeze([Object.freeze({
                            contributor,
                            protocol: point.protocol,
                            descriptor: Object.freeze({ kind: 'issue', label: 'Physical package source' }),
                            operations: Object.freeze([]),
                            surfaces: exposedSurfaces,
                        })]),
                    })]),
                })]),
        });
        const targetedMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            kind: 'targetedSurface',
            target: mountedTarget,
            point,
            contributor,
            role: surface.role,
            presentation: surface.presentation,
            inputSchema: defineProtocolObject({
                entryId: defineProtocolString(),
            }, { policy: 'closed' }).jsonSchema,
            rendererChain: [{
                pluginId: contributor.pluginId,
                localId: contributor.contributionId,
            }],
            selectedRenderer: {
                identity: {
                    pluginId: contributor.pluginId,
                    localId: contributor.contributionId,
                },
                renderer: {
                    kind: 'declarative',
                    contributionId: contributor.contributionId,
                    model: {
                        visible: true,
                        identity: {
                            pluginId: contributor.pluginId,
                            localId: contributor.contributionId,
                            qualifiedId: `${contributor.pluginId}/${contributor.contributionId}`,
                            generation: String(input.generation),
                        },
                        nodes: [],
                        root: {
                            kind: 'text',
                            path: 'root',
                            order: 0,
                            text: 'External source contributor detail',
                        },
                    },
                },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: mountedExecutionOrigin(
                contributor.pluginId,
                'machine_1',
                'physical-copy-contributor-materialization-a',
            ),
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: {
                target: {
                    pluginId: contributor.pluginId,
                    immutableGenerationId: contributor.immutableGenerationId,
                },
                points: [],
            },
        });
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: input.generation,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        });
        const targetFixture = Object.freeze({
            mountedTarget,
            targetedContributions,
        }) satisfies ReturnType<typeof primeExactTargetedContributions>;
        return Object.freeze({
            targetFixture,
            response: Object.freeze({
                supported: true,
                projection,
                targetedContributions,
                targetedSurfaceMounts: Object.freeze([targetedMount]),
            }),
            targetedMount,
        });
    }

    function externalTargetReactPlacement(): PluginUiSurfacePlacementProjection {
        const destinationId = 'physical-copy-target-surface';
        const placement = surfacePlacementFixture({
            binding: {
                pluginId: targetPluginId,
                destinationId,
                rendererId: targetReactRendererId,
                container: 'rightPane',
                target: { kind: 'session', sessionIdPath: '/session/id' },
            },
            renderer: {
                kind: 'reactNative',
                contributionId: targetReactRendererId,
                requiredHostMethods: ['context'],
            },
            display: { label: 'Physical copy React target' },
            runtime: {
                reactNativeCrashState: {
                    token: {
                        mount: {
                            kind: 'destination',
                            destination: { pluginId: targetPluginId, localId: destinationId },
                        },
                        renderer: { pluginId: targetPluginId, localId: targetReactRendererId },
                        artifactDigest: targetArtifactDigest,
                        crashStateEpoch: 1,
                    },
                    disabled: false,
                },
            },
        });
        return Object.freeze({ ...placement, generatedV2: true }) as PluginUiSurfacePlacementProjection;
    }

    function externalTargetReactProjection(generation: number): PluginUiProjectionModel {
        const bundleId = `reactNativeBundle:${targetPluginId}:${targetReactRendererId}`;
        const entry = 'react-native/physical-copy-target/index.js';
        const fileDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'2'.repeat(64)}`);
        return {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation,
            reactNativeBundlesById: {
                [bundleId]: {
                    id: bundleId,
                    pluginId: targetPluginId,
                    contributionKind: 'reactNativeBundle',
                    contributionId: targetReactRendererId,
                    pluginVersion: '0.1.0',
                    generatedV2: true,
                    hostApi: { minVersion: '1.0.0', methods: ['context'] },
                    artifactGraph: {
                        contributionId: targetReactRendererId,
                        tier: 'reactNative',
                        platform: 'web',
                        entry,
                        files: [{
                            relativePath: entry,
                            digest: fileDigest,
                            byteSize: 16,
                        }],
                        digest: targetArtifactDigest,
                        builtWith: { bundler: 'vite', version: '7.0.0' },
                        hostUiApiVersion: '1.0.0',
                        compat: { react: '19.2.0', reactNative: '0.83.4' },
                    },
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: { source: 'installedArtifact' },
                        cacheKey: `physical-copy-target-${generation}`,
                        cacheIdentity: {
                            pluginId: targetPluginId,
                            contributionId: targetReactRendererId,
                            artifactDigest: targetArtifactDigest,
                            hostAppVersion: '2.0.0',
                            hostUiApiVersion: '1.0.0',
                            reactVersion: '19.2.0',
                            reactNativeVersion: '0.83.4',
                            platform: 'web',
                            channel: 'internal',
                            nativeCapabilitiesDigest: PluginUiArtifactDigestV1Schema.parse(
                                `sha256:${'3'.repeat(64)}`,
                            ),
                            projectionGeneration: generation,
                        },
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;
    }

    function externalTargetDeclarativePlacement(root: unknown): PluginUiSurfacePlacementProjection {
        return surfacePlacementFixture({
            binding: {
                pluginId: targetPluginId,
                destinationId: 'physical-copy-target-surface',
                rendererId: targetDeclarativeRendererId,
                container: 'rightPane',
                target: { kind: 'session', sessionIdPath: '/session/id' },
            },
            renderer: {
                kind: 'declarative',
                contributionId: targetDeclarativeRendererId,
                model: {
                    visible: true,
                    identity: {
                        pluginId: targetPluginId,
                        localId: targetDeclarativeRendererId,
                        qualifiedId: `${targetPluginId}/${targetDeclarativeRendererId}`,
                        generation: '1',
                    },
                    nodes: [],
                    root,
                },
            },
            display: { label: 'Physical copy declarative target' },
        });
    }

    function projectionFor(
        baseProjection: PluginUiProjectionModel,
        targetFixture: ReturnType<typeof createTargetedFixture>['targetFixture'],
    ): PluginUiProjectionModel {
        return withMountedTargetPackage(baseProjection, targetFixture, {
            displayName: 'Physical copy target',
            version: '0.1.0',
        });
    }

    it('mounts the public React/RNW target only after its exact cold snapshot', async () => {
        const { renderPhysicalCopyTargetSurface } = await import(
            '../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/target/src/surface',
        );
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const exact = createTargetedFixture({
            generation: 501,
            targetGeneration: 'physical-copy-target-generation-react-exact',
            variant: 'exact',
        });
        const pending = createDeferred<typeof exact.response>();
        contributionProjectionDescribeMock.mockImplementation(() => pending.promise);
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: renderPhysicalCopyTargetSurface,
        });
        const projection = projectionFor(externalTargetReactProjection(501), exact.targetFixture);
        const render = (currentProjection: PluginUiProjectionModel) => (
            <PluginSurfacePlacementHost
                placement={externalTargetReactPlacement()}
                pluginUiProjection={currentProjection}
                machineId="machine_1"
                serverId="server_1"
                sessionId="session_1"
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />
        );
        const screen = await renderScreen(render(projection), { flushOptions: { cycles: 0 } });

        await vi.waitFor(() => expect(contributionProjectionDescribeMock).toHaveBeenCalledWith(
            'machine_1',
            expect.objectContaining({
                serverId: 'server_1',
                mountedTarget: exact.targetFixture.mountedTarget,
            }),
        ));
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.findByTestId(exactTargetedReadyTestId)).toBeNull();
        expect(reactNativeSurfaceProps).toHaveLength(0);

        await act(async () => {
            pending.resolve(exact.response);
            await pending.promise;
        });
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('External source contributor detail');
            expect(reactNativeSurfaceProps).not.toHaveLength(0);
        });
        const exactProps = reactNativeSurfaceProps.at(-1) as { renderContext?: { surface?: SurfaceContext } };
        expect(exactProps.renderContext?.surface?.targetedContributions)
            .toEqual(exact.targetFixture.targetedContributions);

        const exactMarker = screen.findByTestId(exactTargetedReadyTestId);
        expect(exactMarker?.props).toMatchObject({
            accessible: false,
            collapsable: false,
        });
        expect(exactMarker?.props.accessibilityElementsHidden).toBeUndefined();
        expect(exactMarker?.props.importantForAccessibility).toBeUndefined();

        const wrong = createTargetedFixture({
            generation: 502,
            targetGeneration: 'physical-copy-target-generation-react-wrong',
            variant: 'mismatched',
        });
        contributionProjectionDescribeMock.mockResolvedValue(wrong.response);
        await screen.update(render(projectionFor(
            externalTargetReactProjection(502),
            wrong.targetFixture,
        )));
        await vi.waitFor(() => {
            expect(screen.root.findAll((node) => (
                typeof node.props.testID === 'string'
                && node.props.testID.startsWith('plugin-targeted-surface-ready:')
            ))).toHaveLength(0);
            expect(screen.getTextContent()).not.toContain('External source contributor detail');
        });

        contributionProjectionDescribeMock.mockResolvedValue(exact.response);
        await screen.update(render(projection));
        await vi.waitFor(() => {
            expect(screen.findByTestId(exactTargetedReadyTestId)).toBeTruthy();
            expect(screen.getTextContent()).toContain('External source contributor detail');
        });
        await screen.unmount();
    });

    async function assertPublicReactTargetFallback(
        variant: Exclude<SnapshotVariant, 'exact'>,
        generation: number,
    ): Promise<void> {
        const { renderPhysicalCopyTargetSurface } = await import(
            '../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/target/src/surface',
        );
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const fixture = createTargetedFixture({
            generation,
            targetGeneration: `physical-copy-target-generation-react-${variant}`,
            variant,
        });
        contributionProjectionDescribeMock.mockResolvedValue(fixture.response);
        const renderSurface = vi.fn(renderPhysicalCopyTargetSurface);
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface,
        });
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={externalTargetReactPlacement()}
                pluginUiProjection={projectionFor(externalTargetReactProjection(generation), fixture.targetFixture)}
                machineId="machine_1"
                serverId="server_1"
                sessionId="session_1"
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
            { flushOptions: { cycles: 0 } },
        );

        if (variant === 'missing') {
            await vi.waitFor(() => {
                expect(screen.getTextContent()).toContain('External source detail unavailable');
                expect(reactNativeSurfaceProps).not.toHaveLength(0);
            });
            expect(screen.getTextContent()).not.toContain('External source contributor detail');
            expect(renderSurface).toHaveBeenCalled();
            const props = reactNativeSurfaceProps.at(-1) as { renderContext?: { surface?: SurfaceContext } };
            expect(props.renderContext?.surface?.targetedContributions)
                .toEqual(fixture.targetFixture.targetedContributions);
        } else {
            await vi.waitFor(() => {
                expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
                expect(reactNativeSurfaceProps).not.toHaveLength(0);
            });
            expect(screen.getTextContent()).not.toContain('External source contributor detail');
            expect(renderSurface).not.toHaveBeenCalled();
        }
        await screen.unmount();
    }

    it('keeps the public React/RNW target at its fallback for a missing current handle', async () => {
        await assertPublicReactTargetFallback('missing', 502);
    });

    it('withholds the public React/RNW target for duplicate current handles', async () => {
        await assertPublicReactTargetFallback('duplicate', 503);
    });

    it('withholds the public React/RNW target for a mismatched contributor generation', async () => {
        await assertPublicReactTargetFallback('mismatched', 504);
    });

    it('mounts the public declarative target node through the same exact contributor mount', async () => {
        const { physicalCopyTargetDetailNode } = await import(
            '../../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/target/src/index',
        );
        const { normalizePluginDeclarativeDocumentV1 } = await import('@happier-dev/protocol');
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const fixture = createTargetedFixture({
            generation: 505,
            targetGeneration: 'physical-copy-target-generation-declarative-exact',
            variant: 'exact',
        });
        contributionProjectionDescribeMock.mockResolvedValue(fixture.response);
        const inputValidation = preparePluginJsonSchema(fixture.targetedMount.inputSchema);
        const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(inputValidation.jsonSchema);
        if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
        const admittedModel = normalizePluginDeclarativeDocumentV1({
            pluginId: targetPluginId,
            generation: String(fixture.response.projection.generation),
            actions: [],
            document: { version: 1, root: physicalCopyTargetDetailNode },
            preparedTargetedSurfaces: [{
                targetPluginId,
                handle: surface,
                inputSchema: inputValidation.jsonSchema,
                inputValidation,
                inputNormalizer,
            }],
        });
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={externalTargetDeclarativePlacement(admittedModel.root)}
                pluginUiProjection={projectionFor({
                    ...EMPTY_PLUGIN_UI_PROJECTION,
                    generation: 505,
                }, fixture.targetFixture)}
                machineId="machine_1"
                serverId="server_1"
                sessionId="session_1"
                platform="web"
            />,
            { flushOptions: { cycles: 0 } },
        );

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('External source contributor detail');
            expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
        });
    });
});

function createMemoryCacheStorage(): Readonly<{
    cacheStorage: CacheStorage;
    clear: () => void;
}> {
    const stores = new Map<string, Map<string, Response>>();
    const requestUrl = (request: RequestInfo | URL): string => {
        if (typeof request === 'string') return request;
        return request instanceof URL ? request.href : request.url;
    };
    return Object.freeze({
        // This is the browser CacheStorage system boundary consumed by the
        // installed Artifact cache; the host and Artifact owners stay real.
        cacheStorage: {
            open: async (name: string) => {
                const records = stores.get(name) ?? new Map<string, Response>();
                stores.set(name, records);
                return {
                    match: async (request: RequestInfo | URL) => records.get(requestUrl(request))?.clone(),
                    put: async (request: RequestInfo | URL, response: Response) => {
                        records.set(requestUrl(request), response.clone());
                    },
                    delete: async (request: RequestInfo | URL) => records.delete(requestUrl(request)),
                    keys: async () => [...records.keys()].map((url) => new Request(url)),
                } as unknown as Cache;
            },
            delete: async (name: string) => stores.delete(name),
            has: async (name: string) => stores.has(name),
            keys: async () => [...stores.keys()],
            match: async () => undefined,
        } as unknown as CacheStorage,
        clear: () => stores.clear(),
    });
}

const pluginArtifactCacheStorage = createMemoryCacheStorage();
const observedDeclarativeHostApis = vi.hoisted(() => [] as PluginUiHostApi[]);
const declarativeSettingsGetMock = vi.hoisted(() => vi.fn());
const declarativeSettingsSetMock = vi.hoisted(() => vi.fn());
const declarativeActionExecuteMock = vi.hoisted(() => vi.fn());
const createActivePluginCollectionUiQueryPagerMock = vi.hoisted(() => vi.fn());
const pluginDataTransport = vi.hoisted(() => ({
    enabled: false,
    request: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async (path: string) => {
        throw new Error(`Unexpected plugin Data path: ${path}`);
    }),
}));
/** The daemon resource-read RPC — a genuine transport boundary, asserted on. */
const resourceReadMock = vi.hoisted(() => vi.fn(async () => ({
    supported: true,
    result: {
        ok: true,
        contentType: 'application/json',
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        bytesBase64: 'e30=',
    },
})));
const resourceWatchOpenMock = vi.hoisted(() => vi.fn(async () => ({
    supported: true,
    result: {
        ok: true,
        digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
})));
const resourceWatchNextMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<MachinePluginUiResourceWatchNextResult>>(
    async (_machineId, rawRequest) => {
        const request = rawRequest as Readonly<{ subscriptionId?: unknown }>;
        if (typeof request.subscriptionId !== 'string') throw new Error('expected_resource_watch_subscription');
        // A never-settling long poll keeps react-test-renderer's async `act`
        // open forever. Tests that exercise invalidation install their own
        // response; the neutral default closes the genuine transport boundary.
        return {
            supported: true,
            result: {
                ok: true,
                status: 'event',
                event: {
                    version: 1,
                    subscriptionId: request.subscriptionId,
                    kind: 'error',
                    code: 'unavailable',
                    diagnostics: ['test_resource_watch_complete'],
                },
            },
        };
    },
));
const resourceWatchCloseMock = vi.hoisted(() => vi.fn(async () => undefined));
const activePluginAvailability = vi.hoisted(() => ({
    reader: null as unknown,
}));
const reactNativeCrashReports = vi.hoisted(() => ({
    submit: vi.fn(),
}));
const contributionProjectionDescribeMock = vi.hoisted(() => vi.fn());
const accountEncryptionModeCredentials = vi.hoisted(() => ({
    value: { token: 'plugin-surface-account-mode-test-token' } as Readonly<{ token: string }> | null,
}));
const accountEncryptionModeFetch = vi.hoisted(() => vi.fn<
    typeof import('@/sync/api/account/apiAccountEncryptionMode').fetchAccountEncryptionMode
>());

type AccountEncryptionModeResult = Awaited<ReturnType<
    typeof import('@/sync/api/account/apiAccountEncryptionMode').fetchAccountEncryptionMode
>>;

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginSettingsGet: (...args: unknown[]) => declarativeSettingsGetMock(...args),
    machinePluginSettingsSet: (...args: unknown[]) => declarativeSettingsSetMock(...args),
    machinePluginStructuredMessageActionExecute: (...args: unknown[]) => declarativeActionExecuteMock(...args),
    machinePluginUiResourceRead: (...args: never[]) => (resourceReadMock as (...a: unknown[]) => unknown)(...args),
    machinePluginUiResourceWatchOpen: (...args: never[]) => (resourceWatchOpenMock as (...a: unknown[]) => unknown)(...args),
    machinePluginUiResourceWatchNext: (...args: never[]) => (resourceWatchNextMock as (...a: unknown[]) => unknown)(...args),
    machinePluginUiResourceWatchClose: (...args: never[]) => (resourceWatchCloseMock as (...a: unknown[]) => unknown)(...args),
    machineContributionRegistryProjectionDescribe: (...args: unknown[]) => contributionProjectionDescribeMock(...args),
}));

vi.mock('@/sync/api/plugins/data/queryPluginCollectionUiQuery', () => ({
    createActivePluginCollectionUiQueryPager: (...args: unknown[]) => (
        createActivePluginCollectionUiQueryPagerMock(...args)
    ),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/state/storage')>()),
    useEndpointStatus: () => pluginSurfaceConnectivity.endpointStatus,
    useMachineCliDetectionTarget: () => ({
        isOnline: pluginSurfaceConnectivity.machineOnline,
        daemonStateVersion: pluginSurfaceConnectivity.daemonStateVersion,
    }),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => pluginSurfaceAccountLifetime.value,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>();
    return {
        ...original,
        fetchAccountEncryptionMode: (...args: Parameters<typeof original.fetchAccountEncryptionMode>) => (
            accountEncryptionModeFetch(...args)
        ),
    };
});

vi.mock('@/sync/sync', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/sync')>();
    return {
        ...original,
        // Credentials are a genuine process boundary for the mount; preserve
        // the real Sync owner for every other method while making this test
        // fixture's current credential scope deterministic.
        sync: new Proxy(original.sync, {
            get(target, property) {
                if (property === 'getCredentials') {
                    return () => accountEncryptionModeCredentials.value;
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    };
});

vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...original,
        getActiveServerSnapshot: () => pluginDataTransport.enabled
            ? {
                serverId: 'server-a',
                serverUrl: 'https://plugin-data.example',
                generation: 1,
            }
            : original.getActiveServerSnapshot(),
    };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope')>();
    return {
        ...original,
        captureSessionRequestAuthorityForServerAccountScope: (...args: Parameters<
            typeof original.captureSessionRequestAuthorityForServerAccountScope
        >) => {
            if (!pluginDataTransport.enabled) {
                return original.captureSessionRequestAuthorityForServerAccountScope(...args);
            }
            return Promise.resolve({
                scope: args[0].scope,
                context: { token: 'account-token' },
                request: pluginDataTransport.request,
            });
        },
    };
});

vi.mock('@/sync/domains/plugins/availability/projection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/domains/plugins/availability/projection')>()),
    useActivePluginAccountAvailabilityReader: () => activePluginAvailability.reader,
}));

vi.mock('@/sync/domains/plugins/ui/reactNativeCrashReports', () => ({
    submitReactNativeCrashReportViaMachineRpc: (...args: unknown[]) => reactNativeCrashReports.submit(...args),
}));

vi.mock('@/log', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/log')>();
    return {
        ...original,
        log: {
            ...original.log,
            log: (...args: unknown[]) => pluginSurfaceDiagnosticLog(...args),
        },
    };
});

vi.mock('@happier-dev/plugin-ui/advanced', async (importOriginal) => {
    const pluginUiHostApi = await importOriginal<typeof import('@happier-dev/plugin-ui/advanced')>();
    const ReactModule = await import('react');
    return {
        ...pluginUiHostApi,
        // This wraps the public SDK provider rather than replacing its resource
        // store, so the assertion observes the real host-to-plugin context.
        PluginHostApiProvider: (props: React.ComponentProps<typeof pluginUiHostApi.PluginHostApiProvider>) => {
            observedDeclarativeHostApis.push(props.hostApi);
            return ReactModule.createElement(pluginUiHostApi.PluginHostApiProvider, props);
        },
    };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return surfaceEnvironment.platform;
            },
        },
        View: (props: any) => React.createElement('View', props, props.children),
        ...createCapturingFlatListMock({ renderItems: true }).module,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const unistyles = await createUnistylesMock();
    return {
        ...unistyles,
        useUnistyles: () => {
            const { theme, rt } = unistyles.useUnistyles();
            return {
                theme: {
                    ...(surfaceEnvironment.theme as Record<string, unknown> | null ?? theme),
                    dark: surfaceEnvironment.dark,
                },
                rt: {
                    ...rt,
                    rtl: surfaceEnvironment.rtl,
                    fontScale: surfaceEnvironment.fontScale,
                    insets: surfaceEnvironment.insets,
                },
            };
        },
    };
});

vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => surfaceEnvironment.reducedMotion,
}));

vi.mock('@/hooks/ui/useScreenReaderEnabled', () => ({
    useScreenReaderEnabled: () => surfaceEnvironment.screenReaderEnabled,
}));

vi.mock('@/hooks/ui/useHighContrastPreference', () => ({
    useHighContrastPreference: () => surfaceEnvironment.highContrast,
}));

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const frameworkChrome = {
        en: {
            submit: 'Submit',
            cancel: 'Cancel',
            run: 'Run',
            copy: 'Copy',
            open: 'Open',
            refresh: 'Refresh',
            loading: 'Loading',
            empty: 'Nothing to show',
            error: 'Something went wrong',
            moreActions: 'More actions',
        },
        es: {
            submit: 'Enviar',
            cancel: 'Cancelar',
            run: 'Ejecutar',
            copy: 'Copiar',
            open: 'Abrir',
            refresh: 'Actualizar',
            loading: 'Cargando',
            empty: 'Nada que mostrar',
            error: 'Algo salió mal',
            moreActions: 'Más acciones',
        },
    } as const;
    return {
        ...createTextModuleMock({
            translate: (key) => {
                const chrome = frameworkChrome[activeLanguage.value as keyof typeof frameworkChrome];
                if (key === 'common.submit') return chrome?.submit ?? key;
                if (key === 'common.cancel') return chrome?.cancel ?? key;
                if (key === 'common.run') return chrome?.run ?? key;
                if (key === 'common.copy') return chrome?.copy ?? key;
                if (key === 'common.open') return chrome?.open ?? key;
                if (key === 'common.refresh') return chrome?.refresh ?? key;
                if (key === 'ui.pluginUi.loading') return chrome?.loading ?? key;
                if (key === 'ui.pluginUi.empty') return chrome?.empty ?? key;
                if (key === 'ui.pluginUi.error') return chrome?.error ?? key;
                if (key === 'ui.pluginUi.moreActions') return chrome?.moreActions ?? key;
                return key;
            },
            translateLoose: (key) => key,
            getPreferredLanguage: () => activeLanguage.value,
        }),
        hasTranslation: () => false,
    };
});

vi.mock('@/components/plugins/reactNative/PluginReactNativeSurface', async (importOriginal) => {
    const ReactModule = await import('react');
    const original = await importOriginal<typeof import('@/components/plugins/reactNative/PluginReactNativeSurface')>();
    return {
        ...original,
        PluginReactNativeSurface: (props: any) => {
            reactNativeSurfaceProps.push(props);
            if (reactNativeSurfaceRuntime.enabled) {
                return ReactModule.createElement(original.PluginReactNativeSurface, {
                    ...props,
                    module: reactNativeSurfaceRuntime.module,
                    ...(reactNativeSurfaceRuntime.watchdog
                        ? { watchdog: reactNativeSurfaceRuntime.watchdog }
                        : {}),
                });
            }
            return ReactModule.createElement('PluginReactNativeSurfaceMock', {
                testID: 'plugin-react-native-surface-proxy',
            });
        },
    };
});

vi.mock('@/components/appShell/currentUiContext/CurrentUiContextProvider', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/components/appShell/currentUiContext/CurrentUiContextProvider')>();
    return {
        ...original,
        // The real AppShell provider owns its one record separately. This host
        // test supplies only its private mount-publication capability so the
        // mounted controller and SDK transport remain real.
        useCurrentUiContextMountPublisher: () => currentUiContextMountPublisher.value,
        useCurrentUiContextMountLifecycleActive: () => currentUiContextMountLifecycle.active,
    };
});

afterEach(() => {
    vi.useRealTimers();
    activeLanguage.value = 'en';
    surfaceEnvironment.platform = 'web';
    surfaceEnvironment.dark = false;
    surfaceEnvironment.rtl = false;
    surfaceEnvironment.fontScale = 1;
    surfaceEnvironment.insets = { top: 0, right: 0, bottom: 0, left: 0 };
    surfaceEnvironment.reducedMotion = false;
    surfaceEnvironment.screenReaderEnabled = false;
    surfaceEnvironment.highContrast = false;
    surfaceEnvironment.theme = null;
    pluginSurfaceConnectivity.endpointStatus = 'online';
    pluginSurfaceConnectivity.machineOnline = true;
    pluginSurfaceConnectivity.daemonStateVersion = 1;
    declarativeSettingsGetMock.mockReset();
    declarativeSettingsSetMock.mockReset();
    declarativeActionExecuteMock.mockReset();
    createActivePluginCollectionUiQueryPagerMock.mockReset();
    pluginDataTransport.enabled = false;
    pluginDataTransport.request.mockReset();
    recordAccountStoredContentServerRequirements({
        serverUrl: 'https://plugin-data.example',
        requirements: undefined,
    });
    resourceReadMock.mockClear();
    resourceWatchOpenMock.mockClear();
    resourceWatchNextMock.mockClear();
    resourceWatchCloseMock.mockClear();
    pluginSurfaceDiagnosticLog.mockClear();
    reactNativeSurfaceRuntime.enabled = false;
    reactNativeSurfaceRuntime.module = null;
    reactNativeSurfaceRuntime.watchdog = null;
    currentUiContextMountPublisher.value = null;
    currentUiContextMountLifecycle.active = true;
    observedDeclarativeHostApis.length = 0;
    pluginSurfaceAccountLifetime.reset();
    activePluginAvailability.reader = null;
    reactNativeCrashReports.submit.mockReset();
    accountEncryptionModeFetch.mockReset();
    accountEncryptionModeCredentials.value = null;
});

beforeEach(async () => {
    pluginArtifactCacheStorage.clear();
    vi.stubGlobal('caches', pluginArtifactCacheStorage.cacheStorage);
    contributionProjectionDescribeMock.mockReset();
    contributionProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
    accountEncryptionModeCredentials.value = { token: 'plugin-surface-account-mode-test-token' };
    accountEncryptionModeFetch.mockResolvedValue({ mode: 'e2ee', updatedAt: 1 });
    const { clearDaemonMergedProjectionCacheForTests } = await import(
        '@/agents/backendCatalog/loadDaemonMergedProjectionInputs'
    );
    clearDaemonMergedProjectionCacheForTests();
});

const target: BrowserLocalServicePreviewTargetV1 = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
};

function mountedExecutionOrigin(
    pluginId: string,
    machineId: string,
    materializationId: string,
    serverIdentityId = 'srv_server_a',
) {
    return Object.freeze({
        serverIdentityId,
        materializationRef: Object.freeze({
            machineId,
            materializationId,
            pluginId,
        }),
    });
}

/**
 * Host fixtures name their admitted destination explicitly. This deliberately
 * does not translate the historical `placement` field: the Registry normalizer
 * is the only binding owner and returns every normalized field used in production.
 */
function destinationBinding(input: PluginUiDestinationBindingInputV1): PluginUiDestinationBindingV1 {
    const normalized = normalizePluginUiDestinationBindingV1(input);
    if (!normalized) {
        throw new Error(`fixture destination binding is not admitted: ${input.container}/${input.target.kind}`);
    }
    return normalized;
}

/**
 * A V2 projected surface fixture. The caller must state its binding inputs
 * explicitly; this helper deliberately has no legacy placement-string input.
 */
function surfacePlacementFixture(input: Readonly<{
    binding: PluginUiDestinationBindingInputV1;
    renderer: Readonly<Record<string, unknown>>;
    display?: Readonly<Record<string, unknown>>;
    runtime?: Readonly<Record<string, unknown>>;
    id?: string;
}>): PluginUiSurfacePlacementProjection {
    const binding = destinationBinding(input.binding);
    return Object.freeze({
        id: input.id ?? `surfacePlacement:${binding.destination.pluginId}:${binding.destination.localId}`,
        pluginId: binding.destination.pluginId,
        contributionKind: 'surfacePlacement',
        descriptorId: binding.destination.localId,
        binding,
        // The projection retains this author declaration for neighboring
        // consumers, but the host obtains target kind and context placement
        // only from `binding`.
        target: binding.target,
        renderer: input.renderer,
        display: input.display ?? {},
        ...(input.runtime ? { runtime: input.runtime } : {}),
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection);
}

const DECLARATIVE_DOCUMENT_CONTENT_TYPE = 'application/vnd.happier.declarative-document+json;version=1';

function documentResourceRead(
    document: unknown,
    contentType = DECLARATIVE_DOCUMENT_CONTENT_TYPE,
    digest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
) {
    return {
        supported: true,
        result: {
            ok: true,
            contentType,
            digest,
            bytesBase64: encodeBase64(new TextEncoder().encode(JSON.stringify(document)), 'base64'),
        },
    };
}

function declarativeDocumentPlacement(): PluginUiSurfacePlacementProjection {
    return surfacePlacementFixture({
        binding: {
            pluginId: 'acme.live-dashboard',
            destinationId: 'dashboard-view',
            rendererId: 'dashboard',
            container: 'rightPane',
            target: { kind: 'session', sessionIdPath: '/session/id' },
        },
        renderer: {
            kind: 'declarative',
            contributionId: 'dashboard',
            documentSource: { kind: 'resource', resourceId: 'live-dashboard' },
            model: {
                identity: {
                    pluginId: 'acme.live-dashboard',
                    localId: 'dashboard',
                    qualifiedId: 'acme.live-dashboard/dashboard',
                    generation: '7',
                },
                visible: true,
                requiredHostMethods: [],
                declarativeInventory: {
                    actions: [],
                    destinations: [],
                    settings: [],
                    uiQueries: [],
                },
                nodes: [{ kind: 'text', path: 'root', order: 0, text: 'Static dashboard' }],
                root: { kind: 'text', path: 'root', order: 0, text: 'Static dashboard' },
            },
        },
        runtime: { resourceCapability: { readable: true, dynamic: true } },
    });
}

function createPreviewState() {
    return applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
        generatedAt: 100,
        refreshState: 'idle',
        diagnostics: [],
        previews: [{
            previewId: 'preview_1',
            accessUrl: 'https://preview.happier.test/plugin/acme/',
            expiresAt: null,
            diagnostics: [],
            resource: {
                previewId: 'preview_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                owner: { kind: 'session', id: 'session_1' },
                target: {
                    scheme: 'https',
                    host: 'localhost',
                    port: 5173,
                },
                initialPath: { pathname: '/', search: '' },
                display: {
                    title: 'Preview',
                    addressLabel: 'localhost:5173',
                },
                originMode: 'host',
                browserTarget: target,
            },
        }],
    });
}

const hostedWebProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['hostApi'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        },
    },
};

const generatedHostedWebArtifactFixture = Object.freeze({
    pluginId: 'acme.browser',
    releaseVersion: '1.2.3',
    projectionGeneration: 11,
    graph: Object.freeze({
        contributionId: 'panel',
        tier: 'hostedWeb' as const,
        platform: 'web' as const,
        entry: 'hosted-web/browser/index.html',
        files: Object.freeze([Object.freeze({
            relativePath: 'hosted-web/browser/index.html',
            digest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'b'.repeat(64)}`),
            byteSize: 16,
        })]),
        digest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`),
        builtWith: Object.freeze({ bundler: 'vite' as const, version: '7.0.0' }),
        hostUiApiVersion: '1.0.0',
        compat: Object.freeze({}),
    }),
});

/**
 * Generated browser frames consume the same Availability-issued scoped
 * capability as production. The fixture supplies only that genuine external
 * transport boundary; Artifact selection, admission and frame ownership stay
 * in the real host path below.
 */
function createGeneratedHostedWebArtifactProjection(input: Readonly<{
    requiredHostMethods: readonly string[];
    allowedMessageKinds: readonly string[];
}>): PluginUiProjectionModel {
    const targetFixture = primeExactTargetedContributions({
        pluginId: generatedHostedWebArtifactFixture.pluginId,
        immutableGenerationId: 'browser-hosted-artifact-generation-11',
        projectionGeneration: generatedHostedWebArtifactFixture.projectionGeneration,
    });
    return withMountedTargetPackage({
        ...hostedWebProjection,
        generation: generatedHostedWebArtifactFixture.projectionGeneration,
        hostedWebById: {
            'hostedWeb:acme.browser:panel': {
                ...hostedWebProjection.hostedWebById['hostedWeb:acme.browser:panel']!,
                generatedV2: true,
                pluginVersion: generatedHostedWebArtifactFixture.releaseVersion,
                service: { kind: 'staticAssets', assetRootId: 'hosted-web/browser' },
                runtimeMode: {
                    kind: 'installedStaticAssets',
                    artifactId: 'browser-static',
                    assetRootId: 'hosted-web/browser',
                },
                entry: { routeMode: 'pathFallback', path: '/' },
                bridge: { allowedMessages: input.allowedMessageKinds },
                sandbox: { scripts: true },
                security: {
                    allowedNavigationOrigins: [],
                    allowedCallbackOrigins: [],
                    allowedConnectOrigins: [],
                    csp: {
                        connectSrc: 'selfOnly',
                        allowDataUrls: false,
                        allowBlobUrls: false,
                        allowInlineStyles: false,
                        allowEval: false,
                    },
                    sourceMaps: 'disabled',
                    mixedContent: 'devLoopbackOnly',
                },
                requiredHostMethods: input.requiredHostMethods,
                artifactGraph: generatedHostedWebArtifactFixture.graph,
                runtime: {
                    state: 'available',
                    diagnostics: [],
                    decision: { state: 'render', reason: 'available', diagnostics: [] },
                    artifactReadIdentity: {
                        pluginId: generatedHostedWebArtifactFixture.pluginId,
                        contributionId: generatedHostedWebArtifactFixture.graph.contributionId,
                        artifactDigest: generatedHostedWebArtifactFixture.graph.digest,
                        platform: 'web',
                        projectionGeneration: generatedHostedWebArtifactFixture.projectionGeneration,
                    },
                },
            },
        },
    } as unknown as PluginUiProjectionModel, targetFixture, {
        displayName: 'Browser Inspector',
        version: generatedHostedWebArtifactFixture.releaseVersion,
    });
}

function prepareGeneratedHostedWebArtifactFrame(): void {
    const { graph, pluginId, releaseVersion } = generatedHostedWebArtifactFixture;
    activePluginAvailability.reader = createPluginAccountAvailabilityReader({
        scope: { serverId: 'server-a', accountId: 'account-a' },
        snapshot: {
            availabilityCursor: 11,
            materializations: [],
            snapshots: [],
            intentReads: [{
                pluginId,
                response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                    availabilityCursor: 11,
                    hostingCapability: {
                        enabled: true,
                        maxArtifactBytes: 1024,
                        maxAccountBytes: 2048,
                    },
                    intent: {
                        pluginId,
                        desiredVersion: releaseVersion,
                        enabled: true,
                        offlineUiHosting: 'enabled',
                        writableCollections: [],
                        revision: 'browser-hosted-artifact-intent-11',
                    },
                    release: {
                        ref: { pluginId, version: releaseVersion },
                        archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                        normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                            schemaVersion: 2,
                            id: pluginId,
                            version: releaseVersion,
                            displayName: 'Browser Inspector',
                            engines: { happier: '^1.0.0' },
                            runtime: { apiVersion: 1 },
                            contributes: {},
                        }),
                        collectionContracts: [],
                        uiSlots: [{
                            contributionId: graph.contributionId,
                            tier: graph.tier,
                            platform: graph.platform,
                            artifactDigest: graph.digest,
                            compatibility: { hostUiApiVersion: graph.hostUiApiVersion },
                        }],
                        packageAssetArchive: {
                            archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                            resources: [],
                        },
                    },
                    uiArtifacts: [{
                        release: { pluginId, version: releaseVersion },
                        contributionId: graph.contributionId,
                        tier: graph.tier,
                        platform: graph.platform,
                        artifactId: '00000000-0000-4000-8000-000000000011',
                        artifactDigest: graph.digest,
                        compatibility: {
                            hostAppVersion: '1.0.0',
                            hostUiApiVersion: graph.hostUiApiVersion,
                            platform: graph.platform,
                            channel: 'internal',
                            nativeCapabilities: [],
                        },
                    }],
                }),
            }],
        } satisfies PluginAccountAvailabilitySnapshot,
    });
    pluginDataTransport.enabled = true;
    pluginDataTransport.request.mockImplementation(async (path: string) => {
        if (path !== PluginAvailabilityActionHttpPathsV1[
            'account.plugins.availability.uiArtifact.browserFrame.issue'
        ]) {
            throw new Error(`Unexpected browser Artifact path: ${path}`);
        }
        return new Response(JSON.stringify({
            url: 'https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/hwb1.generated-hosted-frame.signature/',
            expiresAt: Date.now() + 60_000,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
}

const browserHostedWebPlacement = surfacePlacementFixture({
    binding: {
        pluginId: 'acme.browser',
        destinationId: 'hosted-panel',
        rendererId: 'panel',
        container: 'browserPanel',
        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Browser panel' },
    // This fixture is a selected dynamic Resource producer. The bridge
    // negotiation tests below assert that only this selected member grants the
    // dynamic methods; renderer declarations remain admission-only.
    runtime: { resourceCapability: { readable: true, dynamic: true } },
});

const generatedBrowserHostedWebHostIdentity = Object.freeze({
    pluginId: generatedHostedWebArtifactFixture.pluginId,
    pluginVersion: generatedHostedWebArtifactFixture.releaseVersion,
    viewId: browserHostedWebPlacement.id,
    generation: String(generatedHostedWebArtifactFixture.projectionGeneration),
});

/**
 * EU-5b: a full-page destination whose renderer is hosted web. `app.page` is an
 * app-scope panel, so the registry admits the same runtime modes it admits for
 * every other panel — a page is not a React-Native-only placement.
 */
const appPageHostedWebPlacement = surfacePlacementFixture({
    binding: {
        pluginId: 'acme.browser',
        destinationId: 'notes',
        rendererId: 'panel',
        container: 'appPage',
        target: { kind: 'app' },
    },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Notes' },
});

const appPageHostedWebProjection: PluginUiProjectionModel = {
    ...hostedWebProjection,
    generation: 11,
    surfacePlacementsById: {
        'surfacePlacement:acme.browser:notes': appPageHostedWebPlacement,
    },
} as unknown as PluginUiProjectionModel;

const STATIC_ASSET_PREVIEW_ID = buildPluginHostedWebStaticAssetPreviewId({
    pluginId: 'acme.docs',
    contributionId: 'panel',
    sessionId: 'session_docs',
    machineId: 'machine_docs',
});

const staticAssetHostedWebProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.docs:panel': {
            id: 'hostedWeb:acme.docs:panel',
            pluginId: 'acme.docs',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'staticAssets', assetRootId: 'hosted-web/docs' },
            runtimeMode: { kind: 'installedStaticAssets', artifactId: 'docs-static', assetRootId: 'hosted-web/docs' },
            entry: { routeMode: 'pathFallback', path: '/' },
            bridge: { allowedMessages: ['hostApi'] },
            sandbox: { scripts: true },
            // Installed static-asset bundles are served over loopback http, so the
            // declared policy must allow devLoopbackOnly mixed content to load.
            security: {
                allowedNavigationOrigins: [],
                allowedCallbackOrigins: [],
                allowedConnectOrigins: [],
                csp: {
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                },
                sourceMaps: 'disabled',
                mixedContent: 'devLoopbackOnly',
            },
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: { state: 'render', reason: 'available', diagnostics: [] },
            },
        },
    },
};

// Generated V2 packaged assets carry an Artifact byte-read identity. They are
// deliberately not Session static-asset previews, even while an older daemon
// projection may still contain the retired runtimeMode field during rollout.
const generatedArtifactHostedWebProjection: PluginUiProjectionModel = {
    ...staticAssetHostedWebProjection,
    hostedWebById: {
        'hostedWeb:acme.docs:panel': {
            ...staticAssetHostedWebProjection.hostedWebById['hostedWeb:acme.docs:panel']!,
            generatedV2: true,
            runtime: {
                state: 'fallback',
                diagnostics: ['hosted_web_frame_adapter_unavailable'],
                decision: {
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                    diagnostics: ['hosted_web_frame_adapter_unavailable'],
                },
                artifactReadIdentity: {
                    pluginId: 'acme.docs',
                    contributionId: 'panel',
                    artifactDigest: `sha256:${'a'.repeat(64)}`,
                    platform: 'web',
                    projectionGeneration: 11,
                },
            },
        },
    },
};

// A static-asset hosted-web placement carries NO explicit browser target: the
// served loopback endpoint is correlated from the daemon-registered preview.
const staticAssetHostedWebPlacement = surfacePlacementFixture({
    binding: {
        pluginId: 'acme.docs',
        destinationId: 'docs-panel',
        rendererId: 'panel',
        container: 'servicesPanel',
        target: { kind: 'services' },
    },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Docs' },
});

function createStaticAssetPreviewState() {
    return applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
        generatedAt: 100,
        refreshState: 'idle',
        diagnostics: [],
        previews: [{
            previewId: STATIC_ASSET_PREVIEW_ID,
            accessUrl: 'http://127.0.0.1:51789/',
            expiresAt: null,
            diagnostics: [],
            resource: {
                previewId: STATIC_ASSET_PREVIEW_ID,
                sessionId: 'session_docs',
                machineId: 'machine_docs',
                owner: { kind: 'plugin', id: 'acme.docs' },
                target: { scheme: 'http', host: '127.0.0.1', port: 51789 },
                initialPath: { pathname: '/', search: '' },
                display: { title: 'Docs', addressLabel: '127.0.0.1:51789' },
                originMode: 'path',
            },
        }],
    });
}

const reactNativeCacheIdentity = {
    pluginId: 'acme.browser',
    contributionId: 'native-panel',
    artifactDigest: PluginUiArtifactDigestV1Schema.parse('sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'),
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    reactNativeVersion: '0.83.4',
    // `browserPanel` is an admitted desktop/web destination. Keep this static
    // RN fixture on desktop so the test exercises its loader rather than the
    // binding's deliberate native-platform rejection.
    platform: 'desktop',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
} as const;

const defaultReactNativeModuleReference = {
    containerName: 'acme_browser_native_panel',
    modulePath: './renderSurface',
    exportName: 'renderSurface',
} as const;

const reactNativeProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    reactNativeBundlesById: {
        'reactNativeBundle:acme.browser:native-panel': {
            id: 'reactNativeBundle:acme.browser:native-panel',
            pluginId: 'acme.browser',
            contributionKind: 'reactNativeBundle',
            contributionId: 'native-panel',
            hostApi: {
                minVersion: '1.0.0',
                methods: ['readResource'],
            },
            runtime: {
                decision: {
                    state: 'load',
                    reason: 'compatible',
                    diagnostics: [],
                },
                loadPolicy: {
                    source: 'installedArtifact',
                    featureEnabled: true,
                    loaderBackendAvailable: true,
                },
                cacheKey: 'native-cache-key',
                cacheIdentity: reactNativeCacheIdentity,
            },
        },
    },
};

const browserReactNativePlacement = surfacePlacementFixture({
    binding: {
        pluginId: 'acme.browser',
        destinationId: 'native-panel',
        rendererId: 'native-panel',
        container: 'browserPanel',
        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    },
    renderer: { kind: 'reactNative', contributionId: 'native-panel' },
    display: { label: 'Native panel' },
    // Normal generated-RN fixtures reuse this descriptor. The projected
    // binding is deliberately exact even though legacy RN projections ignore
    // it, so a generated contribution cannot mount through an unbound test
    // descriptor.
    runtime: {
        reactNativeCrashState: {
            token: {
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'acme.browser', localId: 'native-panel' },
                },
                renderer: { pluginId: 'acme.browser', localId: 'native-panel' },
                artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'e'.repeat(64)}`),
                crashStateEpoch: 7,
            },
            disabled: false,
        },
    },
});

const generatedReactNativeCacheIdentity = {
    ...reactNativeCacheIdentity,
    artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'e'.repeat(64)}`),
    platform: 'web',
    projectionGeneration: 44,
} as const;

const generatedReactNativeArtifactGraph = {
    contributionId: generatedReactNativeCacheIdentity.contributionId,
    tier: 'reactNative' as const,
    platform: generatedReactNativeCacheIdentity.platform,
    entry: 'react-native/native-panel/index.js',
    files: [{
        relativePath: 'react-native/native-panel/index.js',
        digest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'f'.repeat(64)}`),
        byteSize: 16,
    }],
    digest: generatedReactNativeCacheIdentity.artifactDigest,
    builtWith: { bundler: 'vite' as const, version: '7.0.0' },
    hostUiApiVersion: generatedReactNativeCacheIdentity.hostUiApiVersion,
    compat: {
        react: generatedReactNativeCacheIdentity.reactVersion,
        reactNative: generatedReactNativeCacheIdentity.reactNativeVersion,
    },
} as const;

const generatedReactNativeProjection = {
    ...reactNativeProjection,
    generation: generatedReactNativeCacheIdentity.projectionGeneration,
    reactNativeBundlesById: {
        'reactNativeBundle:acme.browser:native-panel': {
            ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
            generatedV2: true,
            pluginVersion: '3.2.1',
            artifactGraph: generatedReactNativeArtifactGraph,
            runtime: {
                decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                loadPolicy: { source: 'installedArtifact' },
                cacheKey: 'generated-native-cache-key',
                cacheIdentity: generatedReactNativeCacheIdentity,
            },
        },
    },
} as unknown as PluginUiProjectionModel;

function generatedReactNativeCrashState(input: Readonly<{
    artifactDigest?: string;
    destinationId?: string;
    rendererId?: string;
    disabled?: boolean;
}> = {}): DaemonPluginReactNativeCrashStateV1 {
    return {
        token: {
            mount: {
                kind: 'destination',
                destination: {
                    pluginId: 'acme.browser',
                    localId: input.destinationId ?? 'native-panel',
                },
            },
            renderer: {
                pluginId: 'acme.browser',
                localId: input.rendererId ?? 'native-panel',
            },
            artifactDigest: PluginUiArtifactDigestV1Schema.parse(
                input.artifactDigest ?? generatedReactNativeCacheIdentity.artifactDigest,
            ),
            crashStateEpoch: 7,
        },
        disabled: input.disabled ?? false,
    };
}

function generatedReactNativePlacement(input: Readonly<{
    /** `undefined` supplies the normal daemon projection; `null` models omission. */
    crashState?: DaemonPluginReactNativeCrashStateV1 | null;
    disabled?: boolean;
}> = {}): PluginUiSurfacePlacementProjection {
    const crashState = input.crashState === undefined
        ? generatedReactNativeCrashState({ disabled: input.disabled })
        : input.crashState;
    const placement = surfacePlacementFixture({
        binding: {
            pluginId: 'acme.browser',
            destinationId: 'native-panel',
            rendererId: 'native-panel',
            container: 'browserPanel',
            target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
        },
        renderer: { kind: 'reactNative', contributionId: 'native-panel' },
        display: { label: 'Native panel' },
        ...(crashState
            ? { runtime: { reactNativeCrashState: crashState } }
            : {}),
    });
    return Object.freeze({
        ...placement,
        generatedV2: true,
        ...(input.disabled
            ? {
                availability: {
                    state: 'disabled' as const,
                    reason: 'crash_disabled',
                    diagnostics: ['crash_threshold_reached'],
                },
            }
            : {}),
    }) as unknown as PluginUiSurfacePlacementProjection;
}

/**
 * Generated surfaces consume the daemon's exact target snapshot. These fixtures
 * deliberately use the real projection boundary mock instead of manufacturing a
 * UI-side target or permitting the retired no-snapshot renderer path.
 */
function primeExactTargetedContributions(input: Readonly<{
    pluginId: string;
    immutableGenerationId: string;
    projectionGeneration?: number;
    /** Exact response-local B projection; never the broad A presentation map. */
    projection?: PluginProjectionV2;
    targetedContributions?: Readonly<Record<string, unknown>>;
    targetedSurfaceMounts?: readonly DaemonPluginUiTargetedSurfaceMountV1[];
}>) {
    const mountedTarget = Object.freeze({
        pluginId: input.pluginId,
        immutableGenerationId: input.immutableGenerationId,
    });
    const targetedContributions = input.targetedContributions ?? Object.freeze({
        target: mountedTarget,
        points: [],
    });
    contributionProjectionDescribeMock.mockResolvedValue({
        supported: true,
        projection: {
            ...(input.projection ?? PluginProjectionV2Schema.parse({
                v: 2,
                generation: input.projectionGeneration ?? 1,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            })),
        },
        targetedContributions,
        ...(input.targetedSurfaceMounts === undefined
            ? {}
            : { targetedSurfaceMounts: input.targetedSurfaceMounts }),
    });
    return Object.freeze({ mountedTarget, targetedContributions });
}

function withMountedTargetPackage(
    projection: PluginUiProjectionModel,
    targetFixture: ReturnType<typeof primeExactTargetedContributions>,
    input: Readonly<{
        displayName: string;
        version: string;
    }>,
): PluginUiProjectionModel {
    const { mountedTarget } = targetFixture;
    return {
        ...projection,
        installedPackagesById: {
            ...projection.installedPackagesById,
            [mountedTarget.pluginId]: {
                id: mountedTarget.pluginId,
                displayName: input.displayName,
                version: input.version,
                enabled: true,
                source: { kind: 'bundled', locator: mountedTarget.pluginId },
                immutableGenerationId: mountedTarget.immutableGenerationId,
                brand: { state: 'missing' },
            },
        },
    } as unknown as PluginUiProjectionModel;
}

/**
 * The mounted host resolves contributed Actions only from the raw V2 producer
 * map. Keep fixture Actions equally producer-shaped: a declarative reference
 * is not itself a daemon target or an authorization bypass.
 */
function projectedDaemonUiAction(input: Readonly<{
    pluginId: string;
    localId: string;
    machineId: string;
    materializationId: string;
    serverIdentityId?: string;
}>): ReturnType<typeof PluginProjectedActionV2Schema.parse> {
    return PluginProjectedActionV2Schema.parse({
        id: input.localId,
        pluginId: input.pluginId,
        title: input.localId,
        scopes: ['global'],
        surfaces: ['ui'],
        placementBindings: ['detailsPanel'],
        execution: { target: 'daemon' },
        ...mountedExecutionOrigin(
            input.pluginId,
            input.machineId,
            input.materializationId,
            input.serverIdentityId,
        ),
        dangerLevel: 'safe',
        available: true,
    });
}

/**
 * Generated V2 fixtures must model both halves of a current mount: the broad
 * projection that selects its renderer and the daemon's exact target snapshot
 * that makes the author-facing RenderContext admissible. Keeping that pair in
 * one fixture helper prevents tests from reviving the retired no-snapshot path.
 */
function withExactGeneratedMountedTarget(input: Readonly<{
    projection: PluginUiProjectionModel;
    pluginId: string;
    immutableGenerationId: string;
    projectionGeneration: number;
    displayName: string;
    version: string;
}>): Readonly<{
    projection: PluginUiProjectionModel;
    targetFixture: ReturnType<typeof primeExactTargetedContributions>;
}> {
    const targetFixture = primeExactTargetedContributions({
        pluginId: input.pluginId,
        immutableGenerationId: input.immutableGenerationId,
        projectionGeneration: input.projectionGeneration,
    });
    return Object.freeze({
        targetFixture,
        projection: withMountedTargetPackage(input.projection, targetFixture, {
            displayName: input.displayName,
            version: input.version,
        }),
    });
}

/**
 * A live declarative document consumes the same exact mounted-target snapshot
 * as every current Host API surface. Keep this fixture on the actual
 * projection-boundary mock rather than reviving the retired empty-projection
 * path just to reach the Resource transport.
 */
function declarativeDocumentProjection(): PluginUiProjectionModel {
    const targetFixture = primeExactTargetedContributions({
        pluginId: 'acme.live-dashboard',
        immutableGenerationId: 'live-dashboard-generation-7',
        projectionGeneration: 7,
    });
    return withMountedTargetPackage({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 7,
    }, targetFixture, {
        displayName: 'Live dashboard',
        version: '1.0.0',
    });
}

function reactNativeSurfacePlacementFixture(
    binding: PluginUiDestinationBindingInputV1,
): PluginUiSurfacePlacementProjection {
    return surfacePlacementFixture({
        binding,
        renderer: { kind: 'reactNative', contributionId: binding.rendererId },
        display: { label: 'Native panel' },
        // The generated context fixtures below share the default Artifact
        // identity. Keep the token bound to each fixture's normalized
        // destination/renderer pair so those fixtures exercise the same
        // fail-closed descriptor contract as production.
        runtime: {
            reactNativeCrashState: {
                token: {
                    mount: {
                        kind: 'destination',
                        destination: { pluginId: binding.pluginId, localId: binding.destinationId },
                    },
                    renderer: { pluginId: binding.pluginId, localId: binding.rendererId },
                    artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'e'.repeat(64)}`),
                    crashStateEpoch: 7,
                },
                disabled: false,
            },
        },
    });
}

function reactNativeInlineSurfacePlacementFixture(
    input: PluginUiInlineSurfaceBindingInputV1,
): PluginUiPhysicalSurfacePlacementProjection {
    const binding = normalizePluginUiInlineSurfaceBindingV1(input);
    if (!binding) {
        throw new Error(`fixture inline surface binding is not admitted: ${input.role}/${input.target.kind}`);
    }
    return Object.freeze({
        id: `surfacePlacement:${binding.surface.pluginId}:${binding.surface.localId}`,
        pluginId: binding.surface.pluginId,
        contributionKind: 'surfacePlacement' as const,
        descriptorId: binding.surface.localId,
        binding,
        target: binding.target,
        renderer: { kind: 'reactNative', contributionId: input.rendererId },
        display: { label: 'Native inline surface' },
        availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
        headerActions: [],
        runtime: {
            reactNativeCrashState: {
                token: {
                    mount: {
                        kind: 'inline' as const,
                        surface: binding.surface,
                        role: binding.role,
                    },
                    renderer: { pluginId: input.pluginId, localId: input.rendererId },
                    artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'e'.repeat(64)}`),
                    crashStateEpoch: 7,
                },
                disabled: false,
            },
        },
    });
}

describe('PluginSurfacePlacementHost', () => {
    it('uses an explicit Settings daemon target and rejects its write after that target retires', async () => {
        declarativeSettingsGetMock.mockResolvedValue({
            supported: true,
            snapshot: {
                protocolVersion: 1,
                pluginId: 'acme.settings-page',
                scope: { kind: 'daemon' },
                revision: '0',
                values: { endpoint: 'https://selected.example.test' },
                redactedKeys: [],
            },
        });
        const binding = normalizePluginUiSettingsPageBindingV1({
            pluginId: 'acme.settings-page',
            pageId: 'defaults',
            rendererId: 'settings-form',
        });
        if (!binding) throw new Error('Settings page fixture needs a normalized binding');
        const page: PluginUiSettingsPageProjection = {
            id: 'settingsPage:acme.settings-page:defaults',
            pluginId: 'acme.settings-page',
            contributionKind: 'settingsPage',
            descriptorId: 'defaults',
            page: {
                id: { pluginId: 'acme.settings-page', localId: 'defaults' },
                group: { kind: 'host', id: 'general' },
                title: 'Defaults',
            },
            binding,
            renderer: {
                kind: 'declarative',
                contributionId: 'settings-form',
                model: {
                    identity: {
                        pluginId: 'acme.settings-page',
                        localId: 'settings-form',
                        qualifiedId: 'acme.settings-page/settings-form',
                        generation: '1',
                    },
                    visible: true,
                    root: {
                        kind: 'group',
                        path: 'root',
                        order: 0,
                        children: [{
                            kind: 'field',
                            path: 'root.children[0]',
                            order: 0,
                            label: 'Endpoint',
                            control: { kind: 'text', settingId: 'endpoint' },
                            setting: {
                                id: 'endpoint',
                                descriptor: { scope: 'daemon', schema: { type: 'string' } },
                            },
                        }],
                    },
                },
            },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
        };
        const daemonSettingsTarget = {
            kind: 'daemon' as const,
            serverIdentityId: 'settings-server-identity',
            machineId: 'settings-machine',
            serverId: 'settings-server',
        };
        const isDaemonSettingsTargetCurrent = vi.fn(() => false);
        const { PluginSettingsPageHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSettingsPageHost
                page={page}
                machineId="ambient-machine"
                serverId="ambient-server"
                daemonSettingsTarget={daemonSettingsTarget}
                isDaemonSettingsTargetCurrent={isDaemonSettingsTargetCurrent}
                settingsScopesEnabled={{ account: true, daemon: true }}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
                projectionInteractionEnabled={false}
            />,
        );
        await vi.waitFor(() => {
            expect(declarativeSettingsGetMock).toHaveBeenCalledWith('settings-machine', {
                serverId: 'settings-server',
                serverIdentityId: 'settings-server-identity',
                pluginId: 'acme.settings-page',
            });
        });
        expect(declarativeSettingsGetMock).not.toHaveBeenCalledWith('ambient-machine', expect.anything());

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'https://stale.example.test');
        });
        await act(async () => {
            screen.pressByTestId('plugin-declarative-field-save:root.children[0]');
        });

        expect(isDaemonSettingsTargetCurrent).toHaveBeenCalledWith(daemonSettingsTarget);
        expect(declarativeSettingsSetMock).not.toHaveBeenCalled();
    });

    it('renders an evaluated declarative model and uses canonical settings/action RPCs', async () => {
        surfaceEnvironment.platform = 'android';
        const daemonProfile = upsertServerProfile({
            serverUrl: 'https://server-a',
            name: 'Declarative Settings Test',
        });
        expect(daemonProfile.id).toBe('server-a');
        expect(setServerProfileIdentityForUrl(daemonProfile.serverUrl, 'srv_server_a')).toMatchObject({
            id: 'server-a',
            serverIdentityId: 'srv_server_a',
        });
        declarativeSettingsGetMock.mockResolvedValue({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '0', values: { name: 'Before', count: 2, mode: 'safe', enabled: true, token: 'must-not-render' }, redactedKeys: ['token'] } });
        declarativeSettingsSetMock.mockResolvedValue({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '1', values: { name: 'After', count: 3, mode: 'fast', enabled: true }, redactedKeys: ['token'] } });
        declarativeActionExecuteMock.mockResolvedValue({ supported: true, result: { ok: true, result: null } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:settings', pluginId: 'acme.forms', pluginVersion: '1.0.0',
            contributionKind: 'surfacePlacement', descriptorId: 'settings', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Settings' },
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'settings', rendererId: 'form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            ...mountedExecutionOrigin(
                'acme.forms',
                'machine-1',
                'materialization-forms-current',
            ),
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-7' },
                visible: true, requiredHostMethods: ['executeAction'], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, title: 'Profile', children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name', contributionId: 'profile', qualifiedId: 'acme.forms/settings/profile/fields/name', descriptor: { id: 'name', title: 'Name', target: { kind: 'plugin' }, scope: 'daemon', schema: { type: 'string' } } } },
                    { kind: 'status', path: 'root.children[1]', order: 2, label: 'State', value: 'Ready', tone: 'success' },
                    { kind: 'action', path: 'root.children[2]', order: 3, action: { identity: { pluginId: 'acme.forms', localId: 'save' }, qualifiedId: 'acme.forms/save', generation: 'generation-7' }, label: 'Save', enabled: true },
                    { kind: 'action', path: 'root.children[3]', order: 4, action: { identity: { pluginId: 'acme.forms', localId: 'delete' }, qualifiedId: 'acme.forms/delete', generation: 'generation-7' }, label: 'Delete', enabled: false },
                    { kind: 'stack', path: 'root.children[4]', order: 5, direction: 'vertical', children: [
                        { kind: 'text', path: 'root.children[4].children[0]', order: 6, text: 'Plain text' },
                        { kind: 'markdown', path: 'root.children[4].children[1]', order: 7, text: '**Formatted**' },
                    ] },
                    { kind: 'field', path: 'root.children[5]', order: 8, label: 'Count', control: { kind: 'number', settingId: 'count' }, setting: { id: 'count', descriptor: { scope: 'daemon', schema: { type: 'number' } } } },
                    { kind: 'field', path: 'root.children[6]', order: 9, label: 'Mode', control: { kind: 'select', settingId: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, setting: { id: 'mode', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                    { kind: 'field', path: 'root.children[7]', order: 10, label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' }, setting: { id: 'enabled', descriptor: { scope: 'daemon', schema: { type: 'boolean' } } } },
                    { kind: 'field', path: 'root.children[8]', order: 11, label: 'Token', control: { kind: 'secret', settingId: 'token' }, setting: { id: 'token', descriptor: { scope: 'daemon', secret: true, schema: { type: 'string' } } } },
                    { kind: 'action', path: 'root.children[9]', order: 12, action: { identity: { pluginId: 'acme.shared', localId: 'reset' }, qualifiedId: 'acme.shared/reset', generation: 'generation-7' }, input: null, label: 'Reset', enabled: true },
                    { kind: 'field', path: 'root.children[10]', order: 13, label: 'Account token', control: { kind: 'secret', settingId: 'accountToken' }, setting: { id: 'accountToken', descriptor: { scope: 'account', secret: true, schema: { type: 'string' } } } },
                ] },
            } },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [],
        } as const;
        const targetFixture = primeExactTargetedContributions({
            pluginId: 'acme.forms',
            immutableGenerationId: 'forms-generation-7',
            projectionGeneration: 7,
        });
        const projectedUi = withMountedTargetPackage({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            actionsById: {
                'acme.forms/save': projectedDaemonUiAction({
                    pluginId: 'acme.forms',
                    localId: 'save',
                    machineId: 'machine-1',
                    materializationId: 'materialization-forms-current',
                }),
                'acme.shared/reset': projectedDaemonUiAction({
                    pluginId: 'acme.shared',
                    localId: 'reset',
                    machineId: 'machine-1',
                    materializationId: 'materialization-shared-current',
                }),
            },
        }, targetFixture, {
            displayName: 'Forms',
            version: '1.0.0',
        });
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" serverId="server-a" pluginUiProjection={projectedUi} platform="web" />);
        await act(async () => {});
        expect(declarativeSettingsGetMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            serverIdentityId: 'srv_server_a',
            pluginId: 'acme.forms',
        });
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Before');
        // Account-secret presentation remains visible and inert when this
        // fixture has no active Account target; hiding it would make recovery
        // depend on executable/daemon availability.
        expect(screen.findByTestId('plugin-declarative-field:root.children[10]')).not.toBeNull();
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[10]')?.props.disabled).toBe(true);
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'After'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[0]'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
            pluginId: 'acme.forms',
            fieldId: 'name',
            mutation: { kind: 'set', value: 'After' },
            expectedRevision: '0',
        }));
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(false);
        await act(async () => { screen.pressByTestId('plugin-declarative-action:acme.forms/save'); });
        const omittedSaveInput = declarativeActionExecuteMock.mock.calls.at(-1)?.[1] as Readonly<Record<string, unknown>> | undefined;
        expect(omittedSaveInput).toEqual({
            serverId: 'server-a',
            // Action dispatch is fenced by the bound projection generation,
            // rather than the declarative model's source-label generation.
            expectedGeneration: '7',
            qualifiedActionId: 'acme.forms/save',
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'settings',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-forms-current',
                        pluginId: 'acme.forms',
                    },
                },
            },
        });
        expect(Object.prototype.hasOwnProperty.call(omittedSaveInput, 'input')).toBe(false);
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/delete')?.props.disabled).toBe(true);
        const deleteActionStyle = screen.findByTestId('plugin-declarative-action:acme.forms/delete')?.props.style;
        // The shared pressable owns the disabled activation guard; the
        // declarative renderer still preserves focus/semantic identity.
        expect(deleteActionStyle).toMatchObject({ minHeight: 48 });
        expect(screen.findByTestId('plugin-declarative-status')?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.findByTestId('plugin-declarative-stack')).toBeTruthy();
        expect(screen.findByTestId('plugin-declarative-markdown:root.children[4].children[1]')?.props.markdown).toBe('**Formatted**');
        expect(screen.getTextContent()).toContain('Plain text');
        expect(screen.findByTestId('plugin-declarative-field:root.children[8]')?.props.secureTextEntry).toBe(true);
        expect(screen.findByTestId('plugin-declarative-field:root.children[8]')?.props.value).toBe('');
        expect(screen.findByTestId('plugin-declarative-field:root.children[8]')?.props.style.minHeight).toBe(48);
        const fieldSaveStyle = screen.findByTestId('plugin-declarative-field-save:root.children[8]')?.props.style;
        expect(typeof fieldSaveStyle).toBe('function');
        expect(fieldSaveStyle?.({ pressed: false })).toMatchObject({ minHeight: 48 });
        // Secret deletion is explicit. An empty field save is still data and
        // must cross the shared scoped Settings adapter as a normal set.
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[8]', ''); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[8]'); });
        expect(declarativeSettingsSetMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            fieldId: 'token',
            mutation: { kind: 'set', value: '' },
        }));
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[5]', '42'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[5]'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'count',
            mutation: { kind: 'set', value: 42 },
        }));
        await act(async () => { screen.pressByTestId('plugin-declarative-field:root.children[6]:option:1'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'mode',
            mutation: { kind: 'set', value: 'fast' },
        }));
        await act(async () => { screen.pressByTestId('plugin-declarative-action:acme.shared/reset'); });
        expect(declarativeActionExecuteMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.shared/reset',
            input: null,
            executionSurface: 'ui',
            // The mounted surface, not the cross-plugin target, supplies the
            // daemon-revalidated immediate caller binding.
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'settings',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-forms-current',
                        pluginId: 'acme.forms',
                    },
                },
            },
        });
    });

    it('adopts a declared live declarative document through the mounted Resource host API instead of rendering only the static model', async () => {
        // The incumbent declarative renderer initializes its Settings boundary
        // even though this text-only document has no fields.
        declarativeSettingsGetMock.mockResolvedValue({ supported: false, reason: 'error' });
        const liveDocument = documentResourceRead({
            version: 1,
            root: { kind: 'text', text: 'Live dashboard' },
        });
        // The canonical L1 store admits its watch before one baseline read.
        // That admitted snapshot is the live document until an invalidation
        // queues a replacement.
        resourceReadMock.mockResolvedValueOnce(liveDocument);
        resourceWatchOpenMock.mockResolvedValueOnce({
            supported: true,
            result: { ok: true, digest: liveDocument.result.digest },
        });
        const projection = declarativeDocumentProjection();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={declarativeDocumentPlacement()}
                machineId="machine-1"
                serverId="server-a"
                sessionId="session-live-dashboard"
                pluginUiProjection={projection}
                platform="web"
            />,
        );

        expect(resourceReadMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
            expectedGeneration: '7',
            callerPluginId: 'acme.live-dashboard',
            resource: { pluginId: 'acme.live-dashboard', localId: 'live-dashboard' },
        }));
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Live dashboard');
            expect(screen.getTextContent()).not.toContain('Static dashboard');
        });
    });

    it('routes fixed collection row commands through catalog presentation and mounted facades only', async () => {
        const pluginId = 'acme.rows';
        const generation = 'row-generation';
        const collectionQuery = {
            collection: { pluginId, collectionId: 'tasks' },
            id: 'open',
            indexId: 'by-status',
            parameters: {
                status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
            },
            prefix: [{ kind: 'parameter', parameterId: 'status' }],
            order: 'asc' as const,
            pageSize: 50,
            projectedFields: [
                { field: 'status', kind: 'string' },
                { field: 'title', kind: 'string' },
            ],
        };
        const action = {
            identity: { pluginId, localId: 'inspect' },
            qualifiedId: `${pluginId}/inspect`,
            generation,
        };
        const destination = {
            identity: { pluginId, localId: 'task-details' },
            qualifiedId: `${pluginId}/task-details`,
            generation,
        };
        const row = {
            context: {
                collection: { pluginId, collectionId: 'tasks' },
                rowId: 'task-7',
                revision: 12,
            },
            fields: { title: 'Catalog-backed task', status: 'open' },
        };
        const pagerSnapshot = Object.freeze({
            status: 'ready' as const,
            rows: Object.freeze([row]),
            hasMore: false,
        });
        const pager = {
            getSnapshot: () => pagerSnapshot,
            subscribe: () => () => {},
            refresh: vi.fn(async () => {}),
            loadMore: vi.fn(async () => {}),
            dispose: vi.fn(),
        };
        const dataClient = completePresentationPluginUiDataClient({
            collection: () => {
                throw new Error('Collection mutation is outside row-command presentation');
            },
            openCollectionQuery: vi.fn(async () => pager),
        });
        const dispatchAction = vi.fn(async () => null);
        const openSurface = vi.fn(async () => null);
        const destinationPlacement = surfacePlacementFixture({
            binding: {
                pluginId,
                destinationId: 'task-details',
                rendererId: 'details',
                container: 'rightPane',
                target: { kind: 'session', sessionIdPath: '/session/id' },
            },
            renderer: { kind: 'declarative', contributionId: 'details' },
            display: { label: 'Task details', iconToken: 'preview' },
        });
        const { DeclarativePluginSurface } = await import('./DeclarativePluginSurface');
        const renderCollectionSurface = (actionAvailable = true) => (
            <DeclarativePluginSurface
                    environment={directDeclarativeTestEnvironment}
                    pluginId={pluginId}
                    model={{
                    identity: {
                        pluginId,
                        localId: 'tasks',
                        qualifiedId: `${pluginId}/tasks`,
                        generation,
                    },
                    visible: true,
                    requiredHostMethods: [],
                    declarativeInventory: {
                        actions: [{ ...action, enabled: true, title: 'Inspect task', icon: 'action' }],
                        destinations: [destination],
                        settings: [],
                        uiQueries: [collectionQuery],
                    },
                    nodes: [],
                    root: {
                        kind: 'collectionList',
                        path: 'root',
                        order: 0,
                        source: { collectionId: 'tasks', uiQueryId: 'open', parameters: { status: 'open' } },
                        query: collectionQuery,
                        projection: {
                            titleField: { field: 'title', kind: 'string' },
                            badgeField: { field: 'status', kind: 'string' },
                        },
                        primaryCommand: { kind: 'action', action },
                        secondaryCommands: [{ kind: 'openSurface', destination }],
                    },
                }}
                    interactionEnabled={true}
                    daemonInteractionEnabled={true}
                    dispatchAction={dispatchAction}
                    actionAvailable={actionAvailable}
                    pluginUiProjection={{
                    ...EMPTY_PLUGIN_UI_PROJECTION,
                    generation: 8,
                    surfacePlacementsById: { [destinationPlacement.id]: destinationPlacement },
                }}
                    openSurface={openSurface}
                    openSurfaceAvailable
                    authorityGeneration={8}
                    accountLifetime={{
                    scope: { serverId: 'server-a', accountId: 'account-a' },
                    isCurrent: () => true,
                    onRetire: () => ({ dispose: () => {} }),
                }}
                    dataClient={dataClient}
                />
        );
        const screen = await renderScreen(renderCollectionSurface());

        await act(async () => { await Promise.resolve(); });
        expect(dataClient.openCollectionQuery).toHaveBeenCalledWith({
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
            signal: expect.any(AbortSignal),
        });
        expect(createActivePluginCollectionUiQueryPagerMock).not.toHaveBeenCalled();
        // A root collection takes the one surface scroll viewport through the
        // public virtualized List; the outer ScrollArea must not coexist with
        // it and recreate all rows for a bounded Data page.
        expect(screen.findAllByType('FlatList')).toHaveLength(1);
        expect(screen.findAllByType('ScrollView')).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('plugin-declarative-collection-list:root:row:task-7');
            await Promise.resolve();
        });
        expect(dispatchAction).toHaveBeenCalledWith(action.identity, {
            collection: { pluginId, collectionId: 'tasks' },
            rowId: 'task-7',
            revision: 12,
        });

        const menu = screen.findByType(DropdownMenu);
        const destinationItem = menu.props.items.find((item: Readonly<{ title: string }>) => (
            item.title === 'Task details'
        ));
        if (!destinationItem) throw new Error('expected_catalog_destination_command');
        await act(async () => {
            menu.props.onSelect(destinationItem.id);
            await Promise.resolve();
        });
        expect(openSurface).toHaveBeenCalledWith(destination.identity);
        expect(pager.loadMore).not.toHaveBeenCalled();

        await screen.update(renderCollectionSurface(false));
        const disabledRow = screen.findByTestId('plugin-declarative-collection-list:root:row:task-7');
        expect(disabledRow?.props).toMatchObject({ disabled: true });
        expect(disabledRow?.props.onPress).toEqual(expect.any(Function));
        const dispatchesBeforeDisabledPress = dispatchAction.mock.calls.length;
        await act(async () => { screen.pressByTestId('plugin-declarative-collection-list:root:row:task-7'); });
        expect(dispatchAction).toHaveBeenCalledTimes(dispatchesBeforeDisabledPress);

        let settlePendingAction!: () => void;
        const pendingAction = new Promise<null>((resolve) => {
            settlePendingAction = () => { resolve(null); };
        });
        dispatchAction.mockImplementationOnce(async () => await pendingAction);
        await screen.update(renderCollectionSurface());
        await act(async () => {
            screen.pressByTestId('plugin-declarative-collection-list:root:row:task-7');
            await Promise.resolve();
        });
        const busyRow = screen.findByTestId('plugin-declarative-collection-list:root:row:task-7');
        expect(busyRow?.props).toMatchObject({
            disabled: true,
            accessibilityState: expect.objectContaining({ busy: true, disabled: true }),
        });
        expect(busyRow?.props.onPress).toEqual(expect.any(Function));
        await act(async () => { settlePendingAction(); await pendingAction; });
    });

    it('uses the one flex-owning wrapper for a direct fill targeted Surface root', async () => {
        const { DeclarativePluginSurface } = await import('./DeclarativePluginSurface');
        const renderTargetedSurface = vi.fn(() => React.createElement('MountedTargetedFillSurface'));
        const screen = await renderScreen(
            <DeclarativePluginSurface
                pluginId="acme.targeted-fill"
                model={{
                    identity: {
                        pluginId: 'acme.targeted-fill',
                        localId: 'fill',
                        qualifiedId: 'acme.targeted-fill/fill',
                        generation: 'fill-generation',
                    },
                    visible: true,
                    root: {
                        kind: 'targetedSurface',
                        path: 'root',
                        order: 0,
                        surface: { presentation: 'fill' },
                    },
                }}
                interactionEnabled={true}
                daemonInteractionEnabled={false}
                dispatchAction={vi.fn(async () => null)}
                actionAvailable={false}
                openSurface={vi.fn(async () => null)}
                openSurfaceAvailable={false}
                authorityGeneration={1}
                renderTargetedSurface={renderTargetedSurface}
            />,
        );

        expect(renderTargetedSurface).toHaveBeenCalled();
        expect(screen.findByTestId('plugin-declarative-surface-fill')?.props.style)
            .toEqual({ flex: 1, minWidth: 0 });
        expect(screen.findAllByType('ScrollView')).toHaveLength(0);
    });

    it('keeps the static declarative model when the returned Resource MIME is not the exact document type', async () => {
        declarativeSettingsGetMock.mockResolvedValue({ supported: false, reason: 'error' });
        resourceReadMock.mockResolvedValueOnce(documentResourceRead({
            version: 1,
            root: { kind: 'text', text: 'Rejected dynamic dashboard' },
        }, 'application/json'));
        const projection = declarativeDocumentProjection();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={declarativeDocumentPlacement()}
                machineId="machine-1"
                serverId="server-a"
                sessionId="session-live-dashboard"
                pluginUiProjection={projection}
                platform="web"
            />,
        );

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(resourceReadMock).toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('Static dashboard');
        expect(screen.getTextContent()).not.toContain('Rejected dynamic dashboard');
    });

    it('gives a dynamic declarative document the selected Registry container in its public context', async () => {
        const projection = declarativeDocumentProjection();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={declarativeDocumentPlacement()}
                machineId="machine-1"
                serverId="server-a"
                sessionId="session-live-dashboard"
                pluginUiProjection={projection}
                platform="web"
            />,
        );

        await vi.waitFor(() => {
            expect(observedDeclarativeHostApis.length).toBeGreaterThan(0);
        });

        await expect(observedDeclarativeHostApis.at(-1)!.context()).resolves.toMatchObject({
            mount: {
                kind: 'destination',
                destination: { pluginId: 'acme.live-dashboard', localId: 'dashboard-view' },
                container: 'rightPane',
            },
            target: { kind: 'session', sessionId: 'session-live-dashboard' },
        });
    });

    it('does not reparse an unchanged admitted mount binding for an unrelated host rerender', async () => {
        const projection = declarativeDocumentProjection();
        const placement = declarativeDocumentPlacement();
        const parseSpy = vi.spyOn(PluginUiSurfaceBindingV1Schema, 'safeParse');
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderHost = (projectionInteractionEnabled: boolean) => (
            <PluginSurfacePlacementHost
                placement={placement}
                machineId="machine-1"
                serverId="server-a"
                sessionId="session-live-dashboard"
                pluginUiProjection={projection}
                platform="web"
                projectionInteractionEnabled={projectionInteractionEnabled}
            />
        );

        const screen = await renderScreen(renderHost(true));
        try {
            expect(parseSpy).toHaveBeenCalled();
            parseSpy.mockClear();

            await screen.update(renderHost(false));

            expect(parseSpy).not.toHaveBeenCalled();
        } finally {
            parseSpy.mockRestore();
            await screen.unmount();
        }
    });

    it('reparses a replacement mount projection and fails a mismatched renderer closed', async () => {
        const projection = declarativeDocumentProjection();
        const initialPlacement = declarativeDocumentPlacement();
        const parseSpy = vi.spyOn(PluginUiSurfaceBindingV1Schema, 'safeParse');
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderHost = (placement: PluginUiSurfacePlacementProjection) => (
            <PluginSurfacePlacementHost
                placement={placement}
                machineId="machine-1"
                serverId="server-a"
                sessionId="session-live-dashboard"
                pluginUiProjection={projection}
                platform="web"
            />
        );

        const screen = await renderScreen(renderHost(initialPlacement));
        try {
            expect(parseSpy).toHaveBeenCalled();
            parseSpy.mockClear();

            const validReplacement = Object.freeze({
                ...initialPlacement,
                renderer: Object.freeze({ ...initialPlacement.renderer }),
            }) as PluginUiSurfacePlacementProjection;
            await screen.update(renderHost(validReplacement));

            expect(parseSpy).toHaveBeenCalled();
            expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
            parseSpy.mockClear();

            const mismatchedReplacement = Object.freeze({
                ...validReplacement,
                renderer: Object.freeze({
                    ...validReplacement.renderer,
                    contributionId: 'another-renderer',
                }),
            }) as PluginUiSurfacePlacementProjection;
            await screen.update(renderHost(mismatchedReplacement));

            expect(parseSpy).toHaveBeenCalled();
            expect(screen.findByTestId(
                'plugin-surface-unavailable-diagnostic-destination_binding_unavailable',
            )).toBeTruthy();
        } finally {
            parseSpy.mockRestore();
            await screen.unmount();
        }
    });

    it('keeps dynamic LKG while reporting a bounded invalid-document diagnostic and retrying through the Resource store', async () => {
        declarativeSettingsGetMock.mockResolvedValue({ supported: false, reason: 'error' });
        const rejectedDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`);
        const adopted = documentResourceRead(
            { version: 1, root: { kind: 'text', text: 'Adopted dashboard' } },
            DECLARATIVE_DOCUMENT_CONTENT_TYPE,
            `sha256:${'b'.repeat(64)}`,
        );
        const rejected = documentResourceRead(
            { version: 1, root: { kind: 'text', text: 'Rejected dashboard' } },
            'application/json',
            rejectedDigest,
        );
        const recovered = documentResourceRead(
            { version: 1, root: { kind: 'text', text: 'Recovered dashboard' } },
            DECLARATIVE_DOCUMENT_CONTENT_TYPE,
            `sha256:${'d'.repeat(64)}`,
        );
        let settleInvalidation: (() => void) | undefined;
        resourceReadMock
            .mockResolvedValueOnce(adopted)
            // A real invalidation queues the replacement after the admitted
            // baseline. An invalid document must preserve that first LKG.
            .mockResolvedValueOnce(rejected)
            .mockResolvedValueOnce(recovered);
        resourceWatchOpenMock.mockResolvedValueOnce({
            supported: true,
            // The real mounted watch returns its admission digest. Matching
            // the baseline prevents an invented establishment re-read from
            // consuming the invalidation fixture before this test delivers it.
            result: { ok: true, digest: adopted.result.digest },
        });
        resourceWatchNextMock
            // Keep the current watch admitted through the baseline read. The
            // next poll is held until this test releases an actual invalidation.
            .mockResolvedValueOnce({
                supported: true,
                result: { ok: true, status: 'idle' },
            } satisfies MachinePluginUiResourceWatchNextResult)
            .mockImplementationOnce(async (_machineId, rawRequest) => {
                const request = rawRequest as Readonly<{ subscriptionId?: unknown }>;
                const subscriptionId = request.subscriptionId;
                if (typeof subscriptionId !== 'string') {
                    throw new Error('expected_resource_watch_subscription');
                }
                return await new Promise<MachinePluginUiResourceWatchNextResult>((resolve) => {
                    settleInvalidation = () => {
                        resolve({
                            supported: true,
                            result: {
                                ok: true,
                                status: 'event',
                                event: {
                                    version: 1,
                                    subscriptionId,
                                    kind: 'invalidated',
                                    digest: rejectedDigest,
                                },
                            },
                        });
                    };
            });
        });
        const projection = declarativeDocumentProjection();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={declarativeDocumentPlacement()}
                machineId="machine-1"
                serverId="server-a"
                sessionId="session-live-dashboard"
                pluginUiProjection={projection}
                platform="web"
            />,
        );

        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Adopted dashboard');
        });
        await vi.waitFor(() => {
            expect(settleInvalidation).toEqual(expect.any(Function));
        });
        const resolveInvalidation = settleInvalidation;
        if (!resolveInvalidation) {
            throw new Error('expected_resource_invalidation');
        }
        await act(async () => {
            resolveInvalidation();
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(screen.findByTestId('plugin-declarative-document-source-error')).toBeTruthy();
        });
        expect(screen.findByTestId('plugin-declarative-document-source-status:failedRetry')).toBeTruthy();
        expect(resourceWatchNextMock).toHaveBeenCalled();
        expect(screen.getTextContent()).toContain('Adopted dashboard');
        expect(screen.getTextContent()).not.toContain('Rejected dashboard');

        await act(async () => {
            screen.pressByTestId('plugin-declarative-document-source-retry');
        });
        await vi.waitFor(() => {
            expect(screen.getTextContent()).toContain('Recovered dashboard');
        });
        expect(screen.findByTestId('plugin-declarative-document-source-error')).toBeNull();
    });

    it('keeps a settings-less declarative surface interactive when the plugin has no settings service', async () => {
        // A plugin that contributes only actions and views has no settings service by
        // design (`availability('settings') === unavailable`), so `settings.get` fails.
        // That must not retire the whole surface into an offline read-only snapshot.
        declarativeSettingsGetMock.mockResolvedValue({ supported: false, reason: 'error' });
        declarativeActionExecuteMock.mockResolvedValue({ supported: true, result: { ok: true, result: null } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.actionsonly:tab', pluginId: 'acme.actionsonly', pluginVersion: '1.0.0',
            contributionKind: 'surfacePlacement', descriptorId: 'tab', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Tab' },
            binding: destinationBinding({
                pluginId: 'acme.actionsonly', destinationId: 'tab', rendererId: 'decl',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            ...mountedExecutionOrigin(
                'acme.actionsonly',
                'machine-1',
                'materialization-actionsonly-current',
            ),
            renderer: { kind: 'declarative', contributionId: 'decl', model: {
                identity: { pluginId: 'acme.actionsonly', localId: 'decl', qualifiedId: 'acme.actionsonly/decl', generation: 'generation-7' },
                visible: true, requiredHostMethods: ['executeAction'], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, title: 'Actions', children: [
                    { kind: 'action', path: 'root.children[0]', order: 1, action: { identity: { pluginId: 'acme.actionsonly', localId: 'run' }, qualifiedId: 'acme.actionsonly/run', generation: 'generation-7' }, label: 'Run', enabled: true },
                ] },
            } },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [],
        } as const;
        const targetFixture = primeExactTargetedContributions({
            pluginId: 'acme.actionsonly',
            immutableGenerationId: 'actionsonly-generation-7',
            projectionGeneration: 7,
        });
        const projectedUi = withMountedTargetPackage({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 7,
            actionsById: {
                'acme.actionsonly/run': projectedDaemonUiAction({
                    pluginId: 'acme.actionsonly',
                    localId: 'run',
                    machineId: 'machine-1',
                    materializationId: 'materialization-actionsonly-current',
                }),
            },
        }, targetFixture, {
            displayName: 'Actions only',
            version: '1.0.0',
        });
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" serverId="server-a" pluginUiProjection={projectedUi} platform="web" />);
        await act(async () => {});
        await act(async () => { screen.pressByTestId('plugin-declarative-action:acme.actionsonly/run'); });
        const actionExecute = declarativeActionExecuteMock.mock.calls[0]?.[1];
        expect(actionExecute).toMatchObject({
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.actionsonly/run',
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'tab',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-actionsonly-current',
                        pluginId: 'acme.actionsonly',
                    },
                },
            },
        });
        expect(declarativeActionExecuteMock.mock.calls[0]?.[0]).toBe('machine-1');
        expect(actionExecute).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(actionExecute!, 'input')).toBe(false);
    });

    it('renders declarative tone and action variant through canonical theme tokens', async () => {
        declarativeSettingsGetMock.mockResolvedValue({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.tone', scope: { kind: 'daemon' }, revision: '0', values: {}, redactedKeys: [] } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const {
            DECLARATIVE_ACTION_VARIANT_COLORS,
            DECLARATIVE_TONE_TO_HAPPIER_TONE,
        } = await import('./DeclarativePluginSurface');
        const node = (path: string, extra: Record<string, unknown>) => ({ path, order: 1, ...extra });
        const placement = {
            id: 'surfacePlacement:acme.tone:panel', pluginId: 'acme.tone', contributionKind: 'surfacePlacement',
            descriptorId: 'panel', generatedV2: true, target: { kind: 'app' },
            display: { developerFallback: 'Tone' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.tone', destinationId: 'panel', rendererId: 'panel',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            renderer: { kind: 'declarative', contributionId: 'panel', model: {
                identity: { pluginId: 'acme.tone', localId: 'panel', qualifiedId: 'acme.tone/panel', generation: 'g1' },
                visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    node('root.children[0]', { kind: 'text', text: 'Danger text', tone: 'danger' }),
                    node('root.children[1]', { kind: 'text', text: 'Muted text', tone: 'muted' }),
                    node('root.children[2]', { kind: 'text', text: 'Plain text' }),
                    node('root.children[3]', { kind: 'status', label: 'State', value: 'Degraded', tone: 'warning' }),
                    node('root.children[4]', { kind: 'action', action: { identity: { pluginId: 'acme.tone', localId: 'wipe' }, qualifiedId: 'acme.tone/wipe', generation: 'g1' }, label: 'Wipe', variant: 'destructive', enabled: true }),
                    node('root.children[5]', { kind: 'action', action: { identity: { pluginId: 'acme.tone', localId: 'save' }, qualifiedId: 'acme.tone/save', generation: 'g1' }, label: 'Save', variant: 'primary', enabled: true }),
                ] },
            } },
        } as const;
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        await act(async () => {});

        const { lightTheme } = await import('@/theme');
        const colors = lightTheme.colors;
        const flattenStyle = (style: unknown): Readonly<Record<string, unknown>> => {
            if (Array.isArray(style)) {
                return style.reduce<Readonly<Record<string, unknown>>>(
                    (flattened, entry) => ({ ...flattened, ...flattenStyle(entry) }),
                    {},
                );
            }
            return style !== null && typeof style === 'object'
                ? style as Readonly<Record<string, unknown>>
                : {};
        };
        const styleColor = (testId: string) => {
            const color = flattenStyle(screen.findByTestId(testId)?.props.style).color;
            return typeof color === 'string' ? color : undefined;
        };
        const textColor = (path: string) => styleColor(`plugin-declarative-text:${path}`);
        expect(textColor('root.children[0]')).toBe(colors.state.danger.foreground);
        expect(textColor('root.children[1]')).toBe(colors.text.tertiary);
        expect(textColor('root.children[2]')).toBe(colors.text.primary);
        // A destructive action must not be pixel-identical to a primary one.
        expect(textColor('root.children[0]')).not.toBe(textColor('root.children[2]'));
        expect(styleColor('plugin-declarative-status-value:root.children[3]'))
            .toBe(colors.state.warning.foreground);

        surfaceEnvironment.highContrast = true;
        await screen.update(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        const highContrastStatusValueStyle = flattenStyle(
            screen.findByTestId('plugin-declarative-status-value:root.children[3]')?.props.style,
        );
        expect(highContrastStatusValueStyle.color).toBe(colors.text.primary);

        const destructive = screen.findByTestId('plugin-declarative-action:acme.tone/wipe');
        const primary = screen.findByTestId('plugin-declarative-action:acme.tone/save');
        expect(destructive?.props.style.backgroundColor).toBe(colors.state.danger.background);
        expect(destructive?.props.style.backgroundColor).not.toBe(primary?.props.style.backgroundColor);
        expect(primary?.props.style.backgroundColor).toBe(colors.button.primary.background);
        expect(destructive?.props.accessibilityHint).toBe('common.destructiveActionHint');
        expect(primary?.props.accessibilityHint).toBeUndefined();
        expect(styleColor('plugin-declarative-action-label:acme.tone/wipe'))
            .toBe(colors.state.danger.foreground);

        // Schema → renderer closure: a new tone/variant member cannot silently no-op.
        const { PluginDeclarativeActionVariantV2Schema, PluginDeclarativeToneV2Schema } = await import('@happier-dev/protocol');
        const { HAPPIER_TONE_COLOR_TOKEN } = await import('@happier-dev/plugin-ui/presentation');
        expect(DECLARATIVE_TONE_TO_HAPPIER_TONE).toEqual({
            default: 'neutral',
            muted: 'muted',
            success: 'success',
            warning: 'warning',
            danger: 'danger',
        });
        expect(Object.keys(DECLARATIVE_TONE_TO_HAPPIER_TONE).sort())
            .toEqual([...PluginDeclarativeToneV2Schema.options].sort());
        expect(HAPPIER_TONE_COLOR_TOKEN[DECLARATIVE_TONE_TO_HAPPIER_TONE.muted]).toBe('mutedText');
        expect(Object.keys(DECLARATIVE_ACTION_VARIANT_COLORS).sort())
            .toEqual([...PluginDeclarativeActionVariantV2Schema.options].sort());
    });

    it('renders the declarative list vocabulary through canonical list components and accessible states', async () => {
        declarativeSettingsGetMock.mockResolvedValue({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.repos', scope: { kind: 'daemon' }, revision: '0', values: {}, redactedKeys: [] } });
        declarativeActionExecuteMock.mockResolvedValue({ supported: true, result: { ok: true, result: null } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { DECLARATIVE_STATE_PRESENTATION, DECLARATIVE_TONE_ACCESSIBILITY_LABELS } = await import('./DeclarativePluginSurface');
        const reference = (localId: string) => ({
            identity: { pluginId: 'acme.repos', localId },
            qualifiedId: `acme.repos/${localId}`,
            generation: 'g1',
        });
        const placement = {
            id: 'surfacePlacement:acme.repos:list', pluginId: 'acme.repos', contributionKind: 'surfacePlacement',
            descriptorId: 'list', generatedV2: true,
            target: { kind: 'session', sessionId: 'session-1' },
            display: { developerFallback: 'Repositories' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.repos', destinationId: 'list', rendererId: 'list',
                container: 'detailsTab', target: { kind: 'session' },
            }),
            ...mountedExecutionOrigin(
                'acme.repos',
                'machine-1',
                'materialization-repos-current',
            ),
            renderer: { kind: 'declarative', contributionId: 'list', model: {
                identity: { pluginId: 'acme.repos', localId: 'list', qualifiedId: 'acme.repos/list', generation: 'g1' },
                visible: true, requiredHostMethods: [], nodes: [],
                // Shaped exactly as the manifest grammar allows: `list` holds
                // sections/rows/states, and `metadata`/`actionPanel` are siblings
                // of the list inside the free-form `stack`.
                root: { kind: 'stack', path: 'root', order: 0, children: [
                    { kind: 'list', path: 'root.c0', order: 1, label: 'Repositories', children: [
                        { kind: 'section', path: 'root.c0.c0', order: 2, title: 'Active', footer: 'Refreshed on reload', children: [
                            { kind: 'item', path: 'root.c0.c0.c0', order: 3, title: 'happier', subtitle: 'Main repository', detail: '42', icon: 'file', action: reference('open'), input: { id: 'happier' }, enabled: true },
                            { kind: 'item', path: 'root.c0.c0.c1', order: 4, title: 'archived', tone: 'danger', action: reference('archive'), enabled: false },
                            { kind: 'item', path: 'root.c0.c0.c2', order: 5, title: 'unavailable', subtitle: 'Action unavailable', action: reference('missing') },
                        ] },
                        { kind: 'state', path: 'root.c0.c1', order: 6, state: 'error', title: 'Sync failed', description: 'Retry from the panel.' },
                        { kind: 'state', path: 'root.c0.c2', order: 7, state: 'loading', title: 'Loading repositories' },
                        { kind: 'state', path: 'root.c0.c3', order: 8, state: 'empty', title: 'No archived repositories', icon: 'info' },
                    ] },
                    { kind: 'metadata', path: 'root.c1', order: 9, title: 'Details', entries: [
                        { label: 'Branch', value: 'dev' },
                        { label: 'Status', value: 'Degraded', tone: 'warning' },
                    ] },
                    { kind: 'actionPanel', path: 'root.c2', order: 10, title: 'Repository actions', children: [
                        { kind: 'action', path: 'root.c2.c0', order: 11, action: reference('archive'), label: 'Archive', variant: 'destructive', enabled: true },
                    ] },
                ] },
            } },
        } as const;
        // The model's `g1` labels its declarative bindings, but the canonical
        // action transport must carry the daemon projection generation instead.
        const targetFixture = primeExactTargetedContributions({
            pluginId: 'acme.repos',
            immutableGenerationId: 'repos-generation-1',
            projectionGeneration: 1,
        });
        const projectedUi = withMountedTargetPackage({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            generation: 1,
            actionsById: {
                'acme.repos/open': projectedDaemonUiAction({
                    pluginId: 'acme.repos',
                    localId: 'open',
                    machineId: 'machine-1',
                    materializationId: 'materialization-repos-current',
                }),
                'acme.repos/archive': projectedDaemonUiAction({
                    pluginId: 'acme.repos',
                    localId: 'archive',
                    machineId: 'machine-1',
                    materializationId: 'materialization-repos-current',
                }),
            },
        }, targetFixture, {
            displayName: 'Repositories',
            version: '1.0.0',
        });
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" serverId="server-a" sessionId="session-1" pluginUiProjection={projectedUi} platform="web" />);
        await act(async () => {});

        // The collection is an accessible list, not an anonymous stack of views.
        const list = screen.findByTestId('plugin-declarative-list:root.c0');
        expect(list?.props.accessibilityRole).toBe('list');
        expect(list?.props.accessibilityLabel).toBe('Repositories');
        expect(screen.getTextContent()).toContain('Active');
        expect(screen.getTextContent()).toContain('Refreshed on reload');
        expect(screen.getTextContent()).toContain('Main repository');

        // An enabled row dispatches through the canonical §3.5 dispatcher with its
        // declared launch input.
        await act(async () => { screen.pressByTestId('plugin-declarative-item:root.c0.c0.c0'); });
        expect(declarativeActionExecuteMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            sessionId: 'session-1',
            expectedGeneration: '1',
            qualifiedActionId: 'acme.repos/open',
            input: { id: 'happier' },
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    contributionLocalId: 'list',
                    materializationRef: {
                        machineId: 'machine-1',
                        materializationId: 'materialization-repos-current',
                        pluginId: 'acme.repos',
                    },
                },
            },
        });

        // A policy-denied row is inert and says so to assistive technology.
        const denied = screen.findByTestId('plugin-declarative-item:root.c0.c0.c1');
        expect(denied?.props.onPress).toEqual(expect.any(Function));
        expect(denied?.props.accessibilityState?.disabled).toBe(true);
        const dispatchesBeforeDeniedPress = declarativeActionExecuteMock.mock.calls.length;
        await act(async () => { screen.pressByTestId('plugin-declarative-item:root.c0.c0.c1'); });
        expect(declarativeActionExecuteMock).toHaveBeenCalledTimes(dispatchesBeforeDeniedPress);
        // Tone is never colour-only.
        expect(denied?.props.accessibilityLabel).toContain('common.error');
        const unavailable = screen.findByTestId('plugin-declarative-item:root.c0.c0.c2');
        expect(unavailable?.props.onPress).toEqual(expect.any(Function));
        expect(unavailable?.props.accessibilityState?.disabled).toBe(true);

        // Metadata reads as label/value pairs, with tone spoken rather than painted.
        expect(screen.findByTestId('plugin-declarative-metadata-entry:root.c1:0')?.props.accessibilityLabel)
            .toBe('Branch: dev');
        expect(screen.findByTestId('plugin-declarative-metadata-entry:root.c1:1')?.props.accessibilityLabel)
            .toBe('common.warning: Status: Degraded');

        // States carry their meaning in roles/state, not only in colour.
        expect(screen.findByTestId('plugin-declarative-state:root.c0.c1')?.props.accessibilityRole).toBe('alert');
        expect(screen.findByTestId('plugin-declarative-state:root.c0.c2')?.props.accessibilityState)
            .toMatchObject({ busy: true });
        expect(screen.getTextContent()).toContain('No archived repositories');

        // Grouped actions stay one accessible group and keep the destructive hint.
        expect(screen.findByTestId('plugin-declarative-action-panel:root.c2')?.props.accessibilityLabel)
            .toBe('Repository actions');
        expect(screen.findByTestId('plugin-declarative-action:acme.repos/archive')?.props.accessibilityHint)
            .toBe('common.destructiveActionHint');

        // Schema → renderer closure for the new vocabulary.
        const { PluginDeclarativeStateV2Schema, PluginDeclarativeToneV2Schema } = await import('@happier-dev/protocol');
        expect(Object.keys(DECLARATIVE_STATE_PRESENTATION).sort())
            .toEqual([...PluginDeclarativeStateV2Schema.options].sort());
        expect(Object.keys(DECLARATIVE_TONE_ACCESSIBILITY_LABELS).sort())
            .toEqual([...PluginDeclarativeToneV2Schema.options].sort());
    });

    // F7 — a unioned app-scope contribution carries the machine that produced it,
    // and every effect this mount performs must reach THAT machine.
    it('executes a unioned contribution against its own origin machine, not the mount\'s ambient one', async () => {
        const ambientServer = upsertServerProfile({
            serverUrl: 'https://server-ambient',
            name: 'Ambient Settings Origin Test',
        });
        const originServer = upsertServerProfile({
            serverUrl: 'https://server-origin',
            name: 'Origin Settings Origin Test',
        });
        expect(setServerProfileIdentityForUrl(ambientServer.serverUrl, 'srv_ambient')).toMatchObject({
            id: ambientServer.id,
            serverIdentityId: 'srv_ambient',
        });
        expect(setServerProfileIdentityForUrl(originServer.serverUrl, 'srv_origin')).toMatchObject({
            id: originServer.id,
            serverIdentityId: 'srv_origin',
        });
        declarativeSettingsGetMock.mockResolvedValue({
            supported: true,
            snapshot: {
                protocolVersion: 1,
                pluginId: 'acme.forms',
                scope: { kind: 'daemon' },
                revision: '0',
                values: { name: 'Origin' },
                redactedKeys: [],
            },
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = (hostOrigin?: Readonly<Record<string, unknown>>) => ({
            id: 'surfacePlacement:acme.forms:origin', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'origin', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Origin' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'origin', rendererId: 'form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            ...(hostOrigin ? { hostOrigin } : {}),
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                ] },
            } },
        } as const);

        // Wrong-implementation control: without an origin the ambient machine is
        // still what the mount binds to.
        await renderScreen(
            <PluginSurfacePlacementHost placement={placement()} machineId="machine-ambient" serverId={ambientServer.id} pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />,
        );
        expect(declarativeSettingsGetMock).toHaveBeenCalledWith('machine-ambient', expect.objectContaining({ pluginId: 'acme.forms' }));

        declarativeSettingsGetMock.mockClear();
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement({
                    machineId: 'machine-origin',
                    serverId: originServer.id,
                    generation: 12,
                    interactionEnabled: true,
                    phase: 'current',
                    executionOrigin: mountedExecutionOrigin('acme.forms', 'machine-origin', 'origin-materialization', 'srv_origin'),
                })}
                machineId="machine-ambient"
                serverId={ambientServer.id}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />,
        );
        expect(declarativeSettingsGetMock).toHaveBeenCalledWith('machine-origin', expect.objectContaining({ pluginId: 'acme.forms' }));
        expect(declarativeSettingsGetMock).not.toHaveBeenCalledWith('machine-ambient', expect.anything());
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Origin');

        // The origin also owns executable admission: a contribution whose own
        // projection is not current is inert even while the mount's ambient
        // projection says interaction is enabled.
        declarativeSettingsGetMock.mockClear();
        const inert = await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement({
                    machineId: 'machine-stale',
                    serverId: originServer.id,
                    generation: 12,
                    interactionEnabled: false,
                    phase: 'unavailable',
                    executionOrigin: mountedExecutionOrigin('acme.forms', 'machine-stale', 'stale-materialization', 'srv_origin'),
                })}
                machineId="machine-ambient"
                serverId={ambientServer.id}
                projectionInteractionEnabled
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />,
        );
        expect(declarativeSettingsGetMock).not.toHaveBeenCalled();
        expect(inert.findByTestId('plugin-declarative-field:root.children[0]')?.props.editable).toBe(false);
    });

    it('keeps Account-local declarative interaction available while daemon-owned settings recover offline', async () => {
        const daemonProfile = upsertServerProfile({
            serverUrl: 'https://server-recovery',
            name: 'Recovery Settings Test',
        });
        expect(setServerProfileIdentityForUrl(daemonProfile.serverUrl, 'srv_recovery')).toMatchObject({
            id: daemonProfile.id,
            serverIdentityId: 'srv_recovery',
        });
        let resolveOldSettings!: (value: unknown) => void;
        const oldSettings = new Promise((resolve) => { resolveOldSettings = resolve; });
        let resolveReconnectSettings!: (value: unknown) => void;
        const reconnectSettings = new Promise((resolve) => { resolveReconnectSettings = resolve; });
        let currentMachineRequestCount = 0;
        declarativeSettingsGetMock.mockImplementation((machineId: string) => {
            if (machineId === 'machine-old') return oldSettings;
            currentMachineRequestCount += 1;
            return currentMachineRequestCount === 1
                ? Promise.resolve({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '0', values: { name: 'Current' }, redactedKeys: [] } })
                : reconnectSettings;
        });
        // Account Data has its own resource/pager owner. This ready snapshot
        // proves the daemon's temporary offline state does not make its row
        // inaccessible through the host-wide interaction boundary.
        const accountCollectionQuery = {
            collection: { pluginId: 'acme.forms', collectionId: 'account-items' },
            id: 'recent',
            indexId: 'by-status',
            parameters: {
                status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
            },
            prefix: [{ kind: 'parameter', parameterId: 'status' }],
            order: 'asc' as const,
            pageSize: 50,
            projectedFields: [{ field: 'title', kind: 'string' }],
        };
        const accountCollectionContract = normalizePluginAccountCollectionContractV1({
            pluginId: 'acme.forms',
            contribution: {
                id: 'account-items',
                schemaVersion: 1,
                schema: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', maxLength: 256 },
                        status: { type: 'string', enum: ['open'] },
                        title: { type: 'string', maxLength: 256 },
                    },
                    required: ['id', 'status', 'title'],
                    additionalProperties: false,
                },
                rowIdField: 'id',
                identityFields: [],
                serverReadable: ['title', 'status'],
                indexes: [{
                    id: 'by-status',
                    fields: [
                        { field: 'status', direction: 'asc' },
                        { field: 'id', direction: 'asc' },
                    ],
                }],
                uiQueries: [{
                    id: 'recent',
                    indexId: 'by-status',
                    parameters: {
                        status: { kind: 'string', maxUtf8Bytes: 16, enum: ['open'] },
                    },
                    prefix: [{ kind: 'parameter', parameterId: 'status' }],
                    order: 'asc',
                    pageSize: 50,
                    projectedFields: ['title'],
                }],
                relations: [],
                migrations: [],
            },
        });
        const accountCollectionRef = {
            pluginId: accountCollectionContract.pluginId,
            collectionId: accountCollectionContract.collectionId,
            schemaVersion: accountCollectionContract.schemaVersion,
            contractDigest: accountCollectionContract.contractDigest,
        };
        activePluginAvailability.reader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 1,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId: 'acme.forms',
                    response: {
                        availabilityCursor: 1,
                        hostingCapability: {
                            enabled: true,
                            maxArtifactBytes: 1024,
                            maxAccountBytes: 2048,
                        },
                        intent: {
                            pluginId: 'acme.forms',
                            desiredVersion: '1.0.0',
                            enabled: true,
                            offlineUiHosting: 'enabled',
                            writableCollections: [accountCollectionRef],
                            revision: 'intent-1',
                        },
                        release: {
                            ref: { pluginId: 'acme.forms', version: '1.0.0' },
                            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                                schemaVersion: 2,
                                id: 'acme.forms',
                                version: '1.0.0',
                                displayName: 'Forms',
                                engines: { happier: '^1.0.0' },
                                runtime: { apiVersion: 1 },
                                contributes: {},
                            }),
                            collectionContracts: [accountCollectionRef],
                            uiSlots: [],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [],
                    },
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://plugin-data.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
        pluginDataTransport.enabled = true;
        pluginDataTransport.request.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return new Response(JSON.stringify({
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (path === '/v1/plugins/data/contract') {
                return new Response(JSON.stringify({ contract: accountCollectionContract }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            throw new Error(`Unexpected plugin Data path: ${path}`);
        });
        const accountCollectionSnapshot = Object.freeze({
            status: 'ready' as const,
            rows: Object.freeze([{
                context: {
                    collection: { pluginId: 'acme.forms', collectionId: 'account-items' },
                    rowId: 'account-item-1',
                    revision: 1,
                },
                fields: { title: 'Account-local item' },
            }]),
            hasMore: false,
        });
        const accountCollectionPager = {
            getSnapshot: () => accountCollectionSnapshot,
            subscribe: () => () => {},
            refresh: vi.fn(async () => {}),
            loadMore: vi.fn(async () => {}),
            dispose: vi.fn(),
        };
        // The direct client resolves the immutable Availability-admitted
        // contract through its authenticated HTTP boundary. The Data-owned
        // pager remains opaque to this host test after that handoff.
        createActivePluginCollectionUiQueryPagerMock.mockReturnValue(accountCollectionPager);
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = (generation: string) => ({
            id: 'surfacePlacement:acme.forms:recovery', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'recovery', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Recovery' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'recovery', rendererId: 'form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation }, visible: true, requiredHostMethods: [], nodes: [],
                declarativeInventory: {
                    actions: [],
                    destinations: [],
                    settings: [],
                    uiQueries: [accountCollectionQuery],
                },
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                    { kind: 'action', path: 'root.children[1]', order: 2, action: { identity: { pluginId: 'acme.forms', localId: 'save' }, qualifiedId: 'acme.forms/save', generation }, label: 'Save', enabled: true },
                    { kind: 'field', path: 'root.children[2]', order: 3, label: 'Account endpoint', control: { kind: 'text', settingId: 'endpoint' }, setting: { id: 'endpoint', descriptor: { scope: 'account', schema: { type: 'string' } } } },
                    {
                        kind: 'collectionList',
                        path: 'root.children[3]',
                        order: 4,
                        source: { collectionId: 'account-items', uiQueryId: 'recent', parameters: { status: 'open' } },
                        query: accountCollectionQuery,
                        projection: { titleField: { field: 'title', kind: 'string' } },
                    },
                ] },
            } },
        } as const);
        const renderPlacement = (generation: string, machineId?: string) => (
            <PluginSurfaceFocusEligibilityProvider active>
                <PluginSurfacePlacementHost
                    placement={placement(generation)}
                    machineId={machineId}
                    serverId={daemonProfile.id}
                    pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                    platform="web"
                />
            </PluginSurfaceFocusEligibilityProvider>
        );
        const screen = await renderScreen(renderPlacement('generation-1'));
        await act(async () => { await Promise.resolve(); });
        expect(createActivePluginCollectionUiQueryPagerMock).toHaveBeenCalledTimes(1);
        expect(declarativeSettingsGetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.editable).toBe(false);
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(true);

        await screen.update(renderPlacement('generation-1', 'machine-old'));
        expect(declarativeSettingsGetMock).toHaveBeenCalledWith('machine-old', expect.objectContaining({ pluginId: 'acme.forms' }));
        await screen.update(renderPlacement('generation-2', 'machine-current'));
        await act(async () => { await Promise.resolve(); });
        // Candidate adoption is a subscription-lifetime boundary even when
        // the successor keeps the same collection/query local ids. The prior
        // generation's Data pager must retire before the successor reads.
        expect(accountCollectionPager.dispose).toHaveBeenCalledTimes(1);
        expect(createActivePluginCollectionUiQueryPagerMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(false);
        const staleOnlineAction = screen.findByTestId(
            'plugin-declarative-action:acme.forms/save',
        )?.props.onPress as (() => void);

        await act(async () => { resolveOldSettings({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '0', values: { name: 'Stale' }, redactedKeys: [] } }); });
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');

        pluginSurfaceConnectivity.endpointStatus = 'offline';
        await screen.update(renderPlacement('generation-2', 'machine-current'));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');
        const offlineBoundary = screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.forms:acme.forms/form',
        );
        // The surface boundary protects only interaction whose canonical owner
        // is the daemon. Account Settings (and Account Data beside it) retain
        // their own currentness owner and must not become aria-hidden merely
        // because the selected daemon is offline.
        expect(offlineBoundary?.props).toMatchObject({
            inert: false,
            'aria-hidden': false,
        });
        expect(offlineBoundary?.props.style).toMatchObject({ pointerEvents: 'auto' });
        expect(screen.findByTestId(
            'plugin-surface-offline-summary:declarative:acme.forms:acme.forms/form',
        )).toBeNull();
        expect(screen.findByTestId(
            'plugin-declarative-collection-list:root.children[3]:row:account-item-1',
        )).not.toBeNull();
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.editable).toBe(false);
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')?.props.disabled).toBe(true);
        await act(async () => {
            staleOnlineAction();
        });
        expect(declarativeActionExecuteMock).not.toHaveBeenCalled();

        const callsBeforeReconnect = declarativeSettingsGetMock.mock.calls.length;
        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.daemonStateVersion += 1;
        await screen.update(renderPlacement('generation-2', 'machine-current'));
        expect(declarativeSettingsGetMock).toHaveBeenCalledTimes(callsBeforeReconnect + 1);
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('Current');
        // Account-local controls retain their own lifetime while the daemon
        // Settings record performs its authoritative reconnect read.
        expect(screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.forms:acme.forms/form',
        )?.props.inert).toBe(false);
        await act(async () => {
            resolveReconnectSettings({
                supported: true,
                snapshot: {
                    protocolVersion: 1,
                    pluginId: 'acme.forms',
                    scope: { kind: 'daemon' },
                    revision: '1',
                    values: { name: 'Revalidated' },
                    redactedKeys: [],
                },
            });
            await reconnectSettings;
        });
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value)
            .toBe('Revalidated');
        expect(screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.forms:acme.forms/form',
        )?.props.inert).toBe(false);
        expect(screen.findByTestId(
            'plugin-surface-offline-summary:declarative:acme.forms:acme.forms/form',
        )).toBeNull();
    });

    it('fails closed before a daemon-backed declarative surface can act without a current Account lifetime', async () => {
        const daemonProfile = upsertServerProfile({
            serverUrl: 'https://server-missing-account-lifetime',
            name: 'Missing Account Lifetime Test',
        });
        expect(setServerProfileIdentityForUrl(daemonProfile.serverUrl, 'srv_missing_account_lifetime')).toMatchObject({
            id: daemonProfile.id,
            serverIdentityId: 'srv_missing_account_lifetime',
        });
        pluginSurfaceAccountLifetime.value = null;
        declarativeSettingsGetMock.mockResolvedValue({
            supported: true,
            snapshot: {
                protocolVersion: 1,
                pluginId: 'acme.missing-account-lifetime',
                scope: { kind: 'daemon' },
                revision: '0',
                values: { endpoint: 'https://should-not-load.example.test' },
                redactedKeys: [],
            },
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.missing-account-lifetime:settings',
            pluginId: 'acme.missing-account-lifetime',
            contributionKind: 'surfacePlacement',
            descriptorId: 'settings',
            generatedV2: true,
            target: { kind: 'app' },
            display: { developerFallback: 'Missing Account Lifetime' },
            availability: { state: 'available', reason: 'available', diagnostics: [] },
            headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.missing-account-lifetime',
                destinationId: 'settings',
                rendererId: 'form',
                container: 'settingsPage',
                target: { kind: 'app' },
            }),
            renderer: {
                kind: 'declarative',
                contributionId: 'form',
                model: {
                    identity: {
                        pluginId: 'acme.missing-account-lifetime',
                        localId: 'form',
                        qualifiedId: 'acme.missing-account-lifetime/form',
                        generation: 'generation-1',
                    },
                    visible: true,
                    requiredHostMethods: [],
                    nodes: [],
                    root: {
                        kind: 'group',
                        path: 'root',
                        order: 0,
                        children: [
                            {
                                kind: 'field',
                                path: 'root.children[0]',
                                order: 1,
                                label: 'Endpoint',
                                control: { kind: 'text', settingId: 'endpoint' },
                                setting: { id: 'endpoint', descriptor: { scope: 'daemon', schema: { type: 'string' } } },
                            },
                            {
                                kind: 'action',
                                path: 'root.children[1]',
                                order: 2,
                                action: {
                                    identity: { pluginId: 'acme.missing-account-lifetime', localId: 'save' },
                                    qualifiedId: 'acme.missing-account-lifetime/save',
                                    generation: 'generation-1',
                                },
                                label: 'Save',
                                enabled: true,
                            },
                        ],
                    },
                },
            },
        } as const;
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement}
                machineId="machine-missing-account-lifetime"
                serverId={daemonProfile.id}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />,
        );

        expect(declarativeSettingsGetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId(
            'plugin-surface-snapshot:declarative:acme.missing-account-lifetime:acme.missing-account-lifetime/form',
        )?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.editable).toBe(false);
        expect(screen.findByTestId('plugin-declarative-action:acme.missing-account-lifetime/save')?.props.disabled)
            .toBe(true);
    });

    it('serializes declarative setting writes and preserves the exact failed draft for retry', async () => {
        const daemonProfile = upsertServerProfile({
            serverUrl: 'https://server-write-serialization',
            name: 'Serialized Settings Writes Test',
        });
        expect(setServerProfileIdentityForUrl(daemonProfile.serverUrl, 'srv_write_serialization')).toMatchObject({
            id: daemonProfile.id,
            serverIdentityId: 'srv_write_serialization',
        });
        let resolveFirstWrite!: (value: unknown) => void;
        const firstWrite = new Promise((resolve) => { resolveFirstWrite = resolve; });
        declarativeSettingsGetMock
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '0', values: { name: 'Before', mode: 'safe' }, redactedKeys: [] } })
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '2', values: { name: 'External', mode: 'fast' }, redactedKeys: [] } });
        declarativeSettingsSetMock
            .mockImplementationOnce(() => firstWrite)
            .mockResolvedValueOnce({ supported: false, reason: 'error' })
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '3', values: { name: 'Retried', mode: 'fast' }, redactedKeys: [] } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:writes', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'writes', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Writes' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'writes', rendererId: 'form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                    { kind: 'field', path: 'root.children[1]', order: 2, label: 'Mode', control: { kind: 'select', settingId: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, setting: { id: 'mode', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                ] },
            } },
        } as const;
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" serverId={daemonProfile.id} pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        await act(async () => {});
        const staleNameSave = screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.onPress as (() => void);

        await act(async () => { screen.pressByTestId('plugin-declarative-field:root.children[1]:option:1'); });
        expect(declarativeSettingsSetMock.mock.calls).toEqual([[
            'machine-1',
            expect.objectContaining({
                pluginId: 'acme.forms',
                fieldId: 'mode',
                mutation: { kind: 'set', value: 'fast' },
                expectedRevision: '0',
            }),
        ]]);
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);
        await act(async () => { staleNameSave(); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(1);

        await act(async () => { resolveFirstWrite({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '1', values: { name: 'Before', mode: 'fast' }, redactedKeys: [] } }); });
        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'After'); });
        const readsBeforeFailedWrite = declarativeSettingsGetMock.mock.calls.length;
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[0]'); });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => expect(declarativeSettingsGetMock).toHaveBeenCalledTimes(readsBeforeFailedWrite + 1));
        expect(screen.findByTestId('plugin-declarative-field:root.children[0]')?.props.value).toBe('After');
        expect(screen.findByTestId('plugin-declarative-settings-error')?.props.accessibilityLiveRegion).toBe('polite');

        await act(async () => { screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Retried'); });
        await act(async () => { screen.pressByTestId('plugin-declarative-field-save:root.children[0]'); });
        expect(declarativeSettingsSetMock).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            fieldId: 'name',
            mutation: { kind: 'set', value: 'Retried' },
            expectedRevision: '2',
        }));
    });

    it('preserves an unsaved surviving declarative draft across a root replacement and retires it when removed', async () => {
        const daemonProfile = upsertServerProfile({
            serverUrl: 'https://server-root-replacement',
            name: 'Root replacement Settings Test',
        });
        expect(setServerProfileIdentityForUrl(daemonProfile.serverUrl, 'srv_root_replacement')).toMatchObject({
            id: daemonProfile.id,
            serverIdentityId: 'srv_root_replacement',
        });
        declarativeSettingsGetMock.mockResolvedValue({
            supported: true,
            snapshot: {
                protocolVersion: 1,
                pluginId: 'acme.forms',
                scope: { kind: 'daemon' },
                revision: '0',
                values: { retained: 'Persisted', sibling: 'Sibling' },
                redactedKeys: [],
            },
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const field = (id: string, order: number) => ({
            kind: 'field' as const,
            path: `root.${id}`,
            order,
            label: id,
            control: { kind: 'text' as const, settingId: id },
            setting: { id, descriptor: { scope: 'daemon' as const, schema: { type: 'string' as const } } },
        });
        const placement = (children: readonly ReturnType<typeof field>[]) => surfacePlacementFixture({
            id: 'surfacePlacement:acme.forms:root-replacement',
            binding: {
                pluginId: 'acme.forms',
                destinationId: 'root-replacement',
                rendererId: 'form',
                container: 'settingsPage',
                target: { kind: 'app' },
            },
            display: { developerFallback: 'Root replacement' },
            renderer: {
                kind: 'declarative',
                contributionId: 'form',
                model: {
                    identity: {
                        pluginId: 'acme.forms',
                        localId: 'form',
                        qualifiedId: 'acme.forms/form',
                        generation: 'generation-1',
                    },
                    visible: true,
                    requiredHostMethods: [],
                    nodes: [],
                    root: { kind: 'group', path: 'root', order: 0, children },
                },
            },
        });
        const renderPlacement = (children: readonly ReturnType<typeof field>[]) => (
            <PluginSurfacePlacementHost
                placement={placement(children)}
                machineId="machine-1"
                serverId={daemonProfile.id}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />
        );

        const screen = await renderScreen(renderPlacement([field('retained', 1), field('before', 2)]));
        await act(async () => {});
        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.retained', 'Unsaved draft');
        });

        await screen.update(renderPlacement([field('after', 1), field('retained', 2)]));
        await act(async () => {});
        expect(screen.findByTestId('plugin-declarative-field:root.retained')?.props.value).toBe('Unsaved draft');

        await screen.update(renderPlacement([field('removed', 1)]));
        await act(async () => {});
        await screen.update(renderPlacement([field('retained', 1), field('after-return', 2)]));
        await act(async () => {});
        expect(screen.findByTestId('plugin-declarative-field:root.retained')?.props.value).toBe('Persisted');
    }, 180_000);

    it('does not let a pre-reconnect write completion release the current authority write lock', async () => {
        const daemonProfile = upsertServerProfile({
            serverUrl: 'https://server-write-reconnect',
            name: 'Reconnect Settings Writes Test',
        });
        expect(setServerProfileIdentityForUrl(daemonProfile.serverUrl, 'srv_write_reconnect')).toMatchObject({
            id: daemonProfile.id,
            serverIdentityId: 'srv_write_reconnect',
        });
        let resolvePreReconnectWrite!: (value: unknown) => void;
        const preReconnectWrite = new Promise((resolve) => { resolvePreReconnectWrite = resolve; });
        let resolveCurrentWrite!: (value: unknown) => void;
        const currentWrite = new Promise((resolve) => { resolveCurrentWrite = resolve; });
        declarativeSettingsGetMock
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '0', values: { name: 'Before', mode: 'safe' }, redactedKeys: [] } })
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '1', values: { name: 'Revalidated', mode: 'safe' }, redactedKeys: [] } });
        declarativeSettingsSetMock
            .mockImplementationOnce(() => preReconnectWrite)
            .mockImplementationOnce(() => currentWrite)
            .mockResolvedValueOnce({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '3', values: { name: 'Unexpected', mode: 'fast' }, redactedKeys: [] } });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:write-reconnect', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'write-reconnect', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Write reconnect' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'write-reconnect', rendererId: 'form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            renderer: { kind: 'declarative', contributionId: 'form', model: {
                identity: { pluginId: 'acme.forms', localId: 'form', qualifiedId: 'acme.forms/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [],
                root: { kind: 'group', path: 'root', order: 0, children: [
                    { kind: 'field', path: 'root.children[0]', order: 1, label: 'Name', control: { kind: 'text', settingId: 'name' }, setting: { id: 'name', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                    { kind: 'field', path: 'root.children[1]', order: 2, label: 'Mode', control: { kind: 'select', settingId: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, setting: { id: 'mode', descriptor: { scope: 'daemon', schema: { type: 'string' } } } },
                ] },
            } },
        } as const;
        const renderPlacement = () => (
            <PluginSurfacePlacementHost
                placement={placement}
                machineId="machine-1"
                serverId={daemonProfile.id}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />
        );
        const screen = await renderScreen(renderPlacement());
        await act(async () => {});

        await act(async () => {
            screen.pressByTestId('plugin-declarative-field:root.children[1]:option:1');
        });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(1);

        pluginSurfaceConnectivity.endpointStatus = 'offline';
        await screen.update(renderPlacement());
        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.daemonStateVersion += 1;
        await screen.update(renderPlacement());
        await act(async () => {});

        await act(async () => {
            screen.changeTextByTestId('plugin-declarative-field:root.children[0]', 'Current write');
        });
        await act(async () => {
            screen.pressByTestId('plugin-declarative-field-save:root.children[0]');
        });
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);

        await act(async () => {
            resolvePreReconnectWrite({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '1', values: { name: 'Stale', mode: 'fast' }, redactedKeys: [] } });
            await preReconnectWrite;
        });

        expect(screen.findByTestId('plugin-declarative-field-save:root.children[0]')?.props.disabled).toBe(true);
        expect(declarativeSettingsSetMock).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveCurrentWrite({ supported: true, snapshot: { protocolVersion: 1, pluginId: 'acme.forms', scope: { kind: 'daemon' }, revision: '2', values: { name: 'Current write', mode: 'safe' }, redactedKeys: [] } });
            await currentWrite;
        });
    });

    it('renders unavailable instead of a blank surface for a mismatched evaluated model', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placement = {
            id: 'surfacePlacement:acme.forms:mismatch', pluginId: 'acme.forms', contributionKind: 'surfacePlacement', descriptorId: 'mismatch', generatedV2: true,
            target: { kind: 'app' }, display: { developerFallback: 'Mismatch' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'mismatch', rendererId: 'form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            renderer: { kind: 'declarative', contributionId: 'form', model: { identity: { pluginId: 'other.plugin', localId: 'form', qualifiedId: 'other.plugin/form', generation: 'generation-1' }, visible: true, requiredHostMethods: [], nodes: [], root: { kind: 'text', path: 'root', order: 0, text: 'Must not render' } } },
        } as const;
        const screen = await renderScreen(<PluginSurfacePlacementHost placement={placement} machineId="machine-1" pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION} platform="web" />);
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-declarative_model_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('declarative_model_unavailable');
        expect(screen.getTextContent()).not.toContain('Must not render');
    });

    it('uses the destination owner\'s recovery action for a generic unavailable surface', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const onPress = vi.fn();
        const placement = {
            ...browserHostedWebPlacement,
            availability: {
                state: 'fallback' as const,
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            },
        };
        const props = {
            placement,
            resourceBrowserTarget: target,
            machineId: 'machine_1',
            pluginUiProjection: hostedWebProjection,
            localServicePreviewState: createPreviewState(),
            platform: 'web' as const,
            unavailableAction: { label: 'Manage plugin', onPress },
        } as React.ComponentProps<typeof PluginSurfacePlacementHost> & Readonly<{
            unavailableAction: Readonly<{ label: string; onPress: () => void }>;
        }>;
        const screen = await renderScreen(<PluginSurfacePlacementHost {...props} />);

        expect(screen.findByTestId('plugin-surface-unavailable-action')).toBeTruthy();
        await act(async () => {
            screen.pressByTestId('plugin-surface-unavailable-action');
        });
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('keeps generated declarative source rows inert until the daemon projects an evaluated model', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const declarativePlacement = {
            id: 'surfacePlacement:acme.forms:settings',
            pluginId: 'acme.forms',
            contributionKind: 'surfacePlacement',
            descriptorId: 'settings',
            generatedV2: true,
            target: { kind: 'app' },
            binding: destinationBinding({
                pluginId: 'acme.forms', destinationId: 'settings', rendererId: 'settings-form',
                container: 'settingsPage', target: { kind: 'app' },
            }),
            renderer: {
                kind: 'declarative',
                contributionId: 'settings-form',
                root: {
                    kind: 'action',
                    action: 'save',
                    label: 'Save settings',
                },
                requiredHostMethods: ['executeAction'],
            },
            display: { titleKey: 'settings', developerFallback: 'Settings' },
            availability: {
                state: 'fallback',
                reason: 'declarative_model_unavailable',
                diagnostics: ['declarative_model_unavailable'],
            },
            headerActions: [],
        } as const;
        const handleRequest = vi.fn();

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={declarativePlacement}
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-declarative_model_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('declarative_model_unavailable');
        expect(screen.findByTestId('plugin-declarative-action:acme.forms/save')).toBeNull();
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('renders explicit unavailable states for unavailable or unevaluated placements', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const unavailablePlacement = {
            ...browserHostedWebPlacement,
            availability: {
                state: 'fallback',
                reason: 'feature_disabled',
                diagnostics: ['feature_disabled'],
            },
        } as const;
        const deferredPlacement = {
            ...browserHostedWebPlacement,
            featureGate: 'plugins.ui.hostedWeb',
        } as const;

        const unavailable = await renderScreen(
            <PluginSurfacePlacementHost
                placement={unavailablePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        const deferred = await renderScreen(
            <PluginSurfacePlacementHost
                placement={deferredPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );

        expect(unavailable.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(deferred.findByTestId('plugin-hosted-web-frame')).toBeNull();
        expect(unavailable.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(deferred.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(unavailable.findByTestId('plugin-surface-unavailable-diagnostic-feature_disabled')).toBeTruthy();
        expect(deferred.findByTestId('plugin-surface-unavailable-diagnostic-feature_disabled')).toBeTruthy();
        expect(unavailable.getTextContent()).not.toContain('feature_disabled');
        expect(deferred.getTextContent()).not.toContain('feature_disabled');
    });

    it('threads host policy context into placement and hosted-web render gates', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const gatedPlacement = {
            ...browserHostedWebPlacement,
            featureGate: 'plugins.ui.hostedWeb',
        } as const;
        const gatedProjection: PluginUiProjectionModel = {
            ...hostedWebProjection,
            hostedWebById: {
                ...hostedWebProjection.hostedWebById,
                'hostedWeb:acme.browser:panel': {
                    ...hostedWebProjection.hostedWebById['hostedWeb:acme.browser:panel'],
                    compatibility: {
                        platforms: ['web'],
                        channels: ['internal'],
                    },
                },
            },
        };

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={gatedPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={gatedProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
                policyContext={{
                    isFeatureEnabled: (featureId) => featureId === 'plugins.ui.hostedWeb',
                }}
            />,
        );

        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
    });

    it('gives the hosted-web bridge the bound controller surface identity, not a second one built at the frame', async () => {
        // The hosted-web mount used to build its own `PluginUiSurfaceContextV1`
        // beside the controller's, spelling `contributionId` as the RENDERER
        // contribution ('panel') while every other mount spells it as the
        // DECLARING placement ('hosted-panel'). One type, one meaning: the frame
        // query the guest echoes back and the identity the bridge matches against
        // both come from the controller's context now.
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserHostedWebPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                sessionId="ses-hosted-1"
                pluginUiProjection={{ ...hostedWebProjection, generation: 11 }}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        const frame = screen.root.findByType('iframe');
        const src = new URL(String(frame?.props.src ?? 'https://unused.test/'));
        expect(src.searchParams.get('happierContributionId')).toBe('hosted-panel');
        expect(src.searchParams.get('happierSurfaceId')).toBe('surfacePlacement:acme.browser:hosted-panel');
        expect(src.searchParams.get('happierSessionId')).toBeNull();
    });

    it('does not revive predecessor direct hosted-web requests at a browser panel', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        (globalThis as any).window = new EventTarget();

        try {
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={browserHostedWebPlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    pluginUiProjection={{ ...hostedWebProjection, generation: 11 }}
                    localServicePreviewState={createPreviewState()}
                    platform="web"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            const frame = screen.root.findByType('iframe');
            expect(String(frame?.props.src ?? '')).toContain('happierBridgeNonce=');
            const nonce = new URL(String(frame?.props.src ?? 'https://unused.test/')).searchParams.get('happierBridgeNonce') ?? 'nonce';

            await act(async () => undefined);
            await act(async () => {
                const event = new Event('message') as MessageEvent;
                Object.defineProperties(event, {
                    origin: { value: 'https://preview.happier.test' },
                    data: { value: {
                        version: 1,
                        pluginId: 'acme.browser',
                        // The guest echoes the identity the host put in its frame
                        // query — the bound controller's surface context, whose
                        // `contributionId` is the DECLARING placement.
                        contributionId: 'hosted-panel',
                        surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                        nonce,
                        sequence: 2,
                        kind: 'readResource',
                        payload: { resource: 'index' },
                    } },
                    source: { value: iframeSource },
                });
                (globalThis as any).window.dispatchEvent(event);
                await Promise.resolve();
                await Promise.resolve();
            });

            expect(resourceReadMock).not.toHaveBeenCalled();
            expect(iframeSource.postMessage).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
        }
    });

    it('converges a generated hosted-frame Resource store after an invalidation and suppresses a late retired update', async () => {
        const baselineDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`);
        const currentDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'b'.repeat(64)}`);
        const lateDigest = PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`);
        const resourceResult = (digest: string, body: string) => ({
            supported: true,
            result: {
                ok: true,
                contentType: 'application/json',
                digest,
                bytesBase64: encodeBase64(new TextEncoder().encode(body), 'base64'),
            },
        });
        resourceReadMock
            .mockResolvedValueOnce(resourceResult(baselineDigest, '{"status":"baseline"}'))
            .mockResolvedValueOnce(resourceResult(currentDigest, '{"status":"current"}'));
        resourceWatchOpenMock.mockResolvedValueOnce({
            supported: true,
            result: { ok: true, digest: baselineDigest },
        });
        let releaseInvalidation: (() => void) | undefined;
        let releaseLateEvent: (() => void) | undefined;
        resourceWatchNextMock
            .mockResolvedValueOnce({
                supported: true,
                result: { ok: true, status: 'idle' },
            } satisfies MachinePluginUiResourceWatchNextResult)
            .mockImplementationOnce(async (_machineId, rawRequest) => {
                const subscriptionId = (rawRequest as Readonly<{ subscriptionId?: unknown }>).subscriptionId;
                if (typeof subscriptionId !== 'string') throw new Error('expected_resource_watch_subscription');
                return await new Promise<MachinePluginUiResourceWatchNextResult>((resolve) => {
                    releaseInvalidation = () => {
                        resolve({
                            supported: true,
                            result: {
                                ok: true,
                                status: 'event',
                                event: {
                                    version: 1,
                                    subscriptionId,
                                    kind: 'invalidated',
                                    digest: currentDigest,
                                },
                            },
                        });
                    };
                });
            })
            .mockImplementationOnce(async (_machineId, rawRequest) => {
                const subscriptionId = (rawRequest as Readonly<{ subscriptionId?: unknown }>).subscriptionId;
                if (typeof subscriptionId !== 'string') throw new Error('expected_resource_watch_subscription');
                return await new Promise<MachinePluginUiResourceWatchNextResult>((resolve) => {
                    releaseLateEvent = () => {
                        resolve({
                            supported: true,
                            result: {
                                ok: true,
                                status: 'event',
                                event: {
                                    version: 1,
                                    subscriptionId,
                                    kind: 'invalidated',
                                    digest: lateDigest,
                                },
                            },
                        });
                    };
                });
            });

        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const hostWindow = new EventTarget();
        const hostOrigin = 'https://host.happier.test';
        const bootstrapKey = '__HAPPIER_PLUGIN_UI_HOST_API_CLIENT_V1__';
        const previousWindow = (globalThis as any).window;
        const previousLocation = (globalThis as any).location;
        const previousBootstrap = Object.getOwnPropertyDescriptor(globalThis, bootstrapKey);
        let guestListener: ((message: unknown) => void) | undefined;
        let bootstrapIdentity: Readonly<{
            pluginId: string;
            pluginVersion: string;
            viewId: string;
            generation: string;
            sessionId?: string;
        }> | null = null;
        const iframeSource = {
            postMessage: vi.fn((message: unknown) => {
                const record = message && typeof message === 'object'
                    ? message as Readonly<{ direction?: unknown; kind?: unknown; payload?: unknown }>
                    : null;
                if (record?.direction === 'hostToFrame' && record.kind === 'bootstrap') {
                    const payload = record.payload;
                    const identity = payload && typeof payload === 'object'
                        ? (payload as Readonly<{ identity?: unknown }>).identity
                        : null;
                    if (identity && typeof identity === 'object') {
                        bootstrapIdentity = identity as typeof bootstrapIdentity;
                    }
                    return;
                }
                if (record?.direction === 'hostToFrame' && record.kind === 'hostApi') {
                    guestListener?.(record.payload);
                    return;
                }
                if (record?.kind === 'result') {
                    guestListener?.(record.payload);
                }
            }),
        } as unknown as WindowProxy;
        let store: ReturnType<typeof createPluginUiResourceStore> | null = null;

        const dispatchGuestEnvelope = (input: Readonly<{
            pluginId: string;
            contributionId: string;
            surfaceId: string;
            sessionId: string | null;
            nonce: string;
            sequence: number;
            kind: string;
            payload: unknown;
        }>) => {
            const event = new Event('message') as MessageEvent;
            Object.defineProperties(event, {
                origin: { value: 'null' },
                source: { value: iframeSource },
                data: { value: {
                    version: 1,
                    pluginId: input.pluginId,
                    contributionId: input.contributionId,
                    surfaceId: input.surfaceId,
                    ...(input.sessionId === null ? {} : { sessionId: input.sessionId }),
                    nonce: input.nonce,
                    sequence: input.sequence,
                    kind: input.kind,
                    payload: input.payload,
                } },
            });
            hostWindow.dispatchEvent(event);
        };

        (globalThis as any).window = hostWindow;
        (globalThis as any).location = { origin: hostOrigin };
        try {
            prepareGeneratedHostedWebArtifactFrame();
            const generatedProjection = createGeneratedHostedWebArtifactProjection({
                requiredHostMethods: [],
                allowedMessageKinds: ['ready', 'hostApi'],
            });
            const generatedPlacement = {
                ...browserHostedWebPlacement,
                generatedV2: true,
                pluginVersion: '1.2.3',
                renderer: { kind: 'hostedWeb', contributionId: 'panel', requiredHostMethods: [] },
            } as const;
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={generatedPlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    sessionId="session_1"
                    pluginUiProjection={generatedProjection}
                    localServicePreviewState={createPreviewState()}
                    platform="web"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            await vi.waitFor(() => expect(screen.root.findAllByType('iframe')).toHaveLength(1));
            const frameUrl = new URL(String(screen.root.findByType('iframe').props.src));
            const pluginId = frameUrl.searchParams.get('happierPluginId');
            const contributionId = frameUrl.searchParams.get('happierContributionId');
            const surfaceId = frameUrl.searchParams.get('happierSurfaceId');
            const nonce = frameUrl.searchParams.get('happierBridgeNonce');
            if (!pluginId || !contributionId || !surfaceId || !nonce) {
                throw new Error('expected_generated_hosted_frame_bridge_identity');
            }

            // The guest becomes eligible only by its strict opaque-origin ready
            // message; the host returns the private bootstrap through the frame
            // it just mounted, rather than through a test-only host adapter.
            await act(async () => {
                dispatchGuestEnvelope({
                    pluginId,
                    contributionId,
                    surfaceId,
                    sessionId: 'session_1',
                    nonce,
                    sequence: 1,
                    kind: 'ready',
                    payload: { ready: true },
                });
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(bootstrapIdentity).not.toBeNull());
            const identity = bootstrapIdentity;
            if (!identity) throw new Error('expected_generated_hosted_frame_bootstrap');

            let guestSequence = 1;
            Reflect.set(globalThis, bootstrapKey, {
                identity,
                transport: {
                    send: (message: unknown) => {
                        guestSequence += 1;
                        dispatchGuestEnvelope({
                            pluginId,
                            contributionId,
                            surfaceId,
                            sessionId: 'session_1',
                            nonce,
                            sequence: guestSequence,
                            kind: 'hostApi',
                            payload: message,
                        });
                    },
                    subscribe: (listener: (message: unknown) => void) => {
                        guestListener = listener;
                        return Object.freeze({
                            dispose: () => {
                                if (guestListener === listener) guestListener = undefined;
                            },
                        });
                    },
                },
            });
            // The public client consumes the host-private post-ready bootstrap.
            // Temporarily hide the host document so it cannot try to install a
            // second guest lifecycle against the host's own window.
            (globalThis as any).window = undefined;
            const hostApi = await createPluginUiHostApiClient();
            (globalThis as any).window = hostWindow;

            store = createPluginUiResourceStore({
                client: {
                    readResource: hostApi.readResource.bind(hostApi),
                    watchResource: hostApi.watchResource.bind(hostApi),
                },
                pluginId: 'acme.browser',
            });
            const entry = store.getEntry('live-status');
            const snapshots: ReturnType<typeof entry.getSnapshot>[] = [];
            const unsubscribe = entry.subscribe(() => {
                snapshots.push(entry.getSnapshot());
            }, true);

            await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({
                digest: baselineDigest,
                freshness: 'fresh',
                subscription: 'live',
            }));
            await vi.waitFor(() => expect(releaseInvalidation).toEqual(expect.any(Function)));
            const releaseFirstInvalidation = releaseInvalidation;
            if (!releaseFirstInvalidation) throw new Error('expected_resource_invalidation');
            const readsBeforeInvalidation = resourceReadMock.mock.calls.length;

            await act(async () => {
                releaseFirstInvalidation();
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({
                digest: currentDigest,
                freshness: 'fresh',
                subscription: 'live',
            }));
            expect(resourceReadMock).toHaveBeenCalledTimes(readsBeforeInvalidation + 1);

            const invalidationPushes = (iframeSource.postMessage as ReturnType<typeof vi.fn>).mock.calls
                .map(([message]) => message)
                .filter((message): message is Readonly<{
                    direction: 'hostToFrame';
                    kind: 'hostApi';
                    payload: Readonly<{ kind?: unknown; event?: unknown }>;
                }> => Boolean(
                    message
                    && typeof message === 'object'
                    && (message as Readonly<{ direction?: unknown }>).direction === 'hostToFrame'
                    && (message as Readonly<{ kind?: unknown }>).kind === 'hostApi'
                    && (message as Readonly<{ payload?: unknown }>).payload
                    && typeof (message as Readonly<{ payload?: unknown }>).payload === 'object'
                    && ((message as Readonly<{ payload?: Readonly<{ kind?: unknown; event?: unknown }> }>).payload?.kind === 'subscription')
                    && ((message as Readonly<{ payload?: Readonly<{ kind?: unknown; event?: Readonly<{ kind?: unknown }> }> }>).payload?.event?.kind === 'invalidated'),
                ));
            expect(invalidationPushes).toHaveLength(1);
            expect(invalidationPushes[0]?.payload.event).toEqual({
                version: 1,
                subscriptionId: expect.any(String),
                kind: 'invalidated',
                digest: currentDigest,
            });

            await vi.waitFor(() => expect(releaseLateEvent).toEqual(expect.any(Function)));
            const releaseLate = releaseLateEvent;
            if (!releaseLate) throw new Error('expected_late_resource_invalidation');
            unsubscribe();
            await vi.waitFor(() => expect(resourceWatchCloseMock).toHaveBeenCalledTimes(1));
            const snapshotCountAfterRetirement = snapshots.length;
            const readsAfterRetirement = resourceReadMock.mock.calls.length;
            const pushesAfterRetirement = invalidationPushes.length;

            await act(async () => {
                releaseLate();
                await Promise.resolve();
                await Promise.resolve();
            });
            expect(resourceReadMock).toHaveBeenCalledTimes(readsAfterRetirement);
            expect(snapshots).toHaveLength(snapshotCountAfterRetirement);
            expect((iframeSource.postMessage as ReturnType<typeof vi.fn>).mock.calls
                .filter(([message]) => message && typeof message === 'object'
                    && (message as Readonly<{ direction?: unknown }>).direction === 'hostToFrame'
                    && (message as Readonly<{ kind?: unknown }>).kind === 'hostApi'
                    && (message as Readonly<{ payload?: Readonly<{ kind?: unknown; event?: Readonly<{ kind?: unknown }> }> }>).payload?.kind === 'subscription'
                    && (message as Readonly<{ payload?: Readonly<{ event?: Readonly<{ kind?: unknown }> }> }>).payload?.event?.kind === 'invalidated')
                .length).toBe(pushesAfterRetirement);
        } finally {
            store?.dispose();
            if (previousBootstrap) {
                Object.defineProperty(globalThis, bootstrapKey, previousBootstrap);
            } else {
                Reflect.deleteProperty(globalThis, bootstrapKey);
            }
            (globalThis as any).window = previousWindow;
            (globalThis as any).location = previousLocation;
        }
    });

    it('installs the generated hosted-web canonical bootstrap binding on the existing frame bridge', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        prepareGeneratedHostedWebArtifactFrame();
        surfaceEnvironment.dark = true;
        surfaceEnvironment.rtl = true;
        surfaceEnvironment.fontScale = 1.5;
        surfaceEnvironment.insets = { top: 8, right: 4, bottom: 16, left: 2 };
        surfaceEnvironment.reducedMotion = true;
        surfaceEnvironment.screenReaderEnabled = true;
        surfaceEnvironment.highContrast = true;
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const previousLocation = (globalThis as any).location;
        const handleRequest = vi.fn(async () => ({ accepted: true }));
        (globalThis as any).window = new EventTarget();
        (globalThis as any).location = { origin: 'https://host.happier.test' };
        const generatedProjection = createGeneratedHostedWebArtifactProjection({
            requiredHostMethods: ['context', 'executeAction'],
            allowedMessageKinds: ['ready', 'hostApi'],
        });
        const generatedPlacement = {
            ...browserHostedWebPlacement,
            generatedV2: true,
            pluginVersion: '1.2.3',
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'panel',
                requiredHostMethods: ['context', 'executeAction'],
            },
        } as const;

        try {
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={generatedPlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    pluginUiProjection={generatedProjection}
                    localServicePreviewState={createPreviewState()}
                    platform="web"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            await vi.waitFor(() => expect(screen.root.findAllByType('iframe')).toHaveLength(1));
            const frame = screen.root.findByType('iframe');
            const frameUrl = new URL(String(frame.props.src));
            expect(frameUrl.searchParams.has('happierPluginVersion')).toBe(false);
            expect(frameUrl.searchParams.has('happierViewId')).toBe(false);
            expect(frameUrl.searchParams.has('happierGeneration')).toBe(false);
            expect(frameUrl.searchParams.get('happierHostOrigin')).toBe('https://host.happier.test');

            await act(async () => {
                const event = new Event('message') as MessageEvent;
                Object.defineProperties(event, {
                    origin: { value: 'null' },
                    data: { value: {
                        version: 1,
                        pluginId: 'acme.browser',
                        contributionId: 'hosted-panel',
                        surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                        nonce: frameUrl.searchParams.get('happierBridgeNonce'),
                        sequence: 1,
                        kind: 'ready',
                        payload: { ready: true },
                    } },
                    source: { value: iframeSource },
                });
                (globalThis as any).window.dispatchEvent(event);
                await Promise.resolve();
                await Promise.resolve();
            });
            expect((iframeSource.postMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
                expect.objectContaining({
                    direction: 'hostToFrame',
                    kind: 'bootstrap',
                    payload: expect.objectContaining({
                        identity: generatedBrowserHostedWebHostIdentity,
                    }),
                }),
                '*',
            );

            await act(async () => {
                const event = new Event('message') as MessageEvent;
                Object.defineProperties(event, {
                    origin: { value: 'null' },
                    data: { value: {
                        version: 1,
                        pluginId: 'acme.browser',
                        contributionId: 'hosted-panel',
                        surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                        nonce: frameUrl.searchParams.get('happierBridgeNonce'),
                        sequence: 2,
                        kind: 'hostApi',
                        payload: {
                            wireVersion: 1,
                            kind: 'negotiate',
                            identity: generatedBrowserHostedWebHostIdentity,
                            apiRange: '^1.0.0',
                        },
                    } },
                    source: { value: iframeSource },
                });
                (globalThis as any).window.dispatchEvent(event);
                await Promise.resolve();
            });

            expect((iframeSource.postMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'result',
                    payload: expect.objectContaining({
                        kind: 'negotiated',
                        // §3.1/UI-D02: the controller's factual set for a mount
                        // that can address a machine and a projected generation.
                        // The declared `requiredHostMethods` (`['context',
                        // 'executeAction']`) is the admission requirement, not
                        // this list.
                        methods: EXPECTED_GENERIC_DESTINATION_HOST_METHODS,
                        surface: expect.objectContaining({
                            mount: {
                                kind: 'destination',
                                container: 'browserPanel',
                                destination: {
                                    pluginId: 'acme.browser',
                                    localId: 'hosted-panel',
                                },
                            },
                            target: { kind: 'browser', targetId: 'preview_1' },
                            platform: 'web',
                            direction: 'rtl',
                            colorScheme: 'dark',
                            contrast: 'high',
                            textScale: 1.5,
                            reducedMotion: true,
                            screenReaderEnabled: true,
                            safeAreaInsets: { top: 8, right: 4, bottom: 16, left: 2 },
                        }),
                    }),
                }),
                '*',
            );
            expect(handleRequest).not.toHaveBeenCalled();
        } finally {
            (globalThis as any).window = previousWindow;
            (globalThis as any).location = previousLocation;
        }
    });

    it('advertises the mount\'s installed methods, not the declared requirement (UI-D02)', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        prepareGeneratedHostedWebArtifactFrame();
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as any).window;
        const previousLocation = (globalThis as any).location;
        const handleRequest = vi.fn(async () => ({ accepted: true }));
        (globalThis as any).window = new EventTarget();
        (globalThis as any).location = { origin: 'https://host.happier.test' };
        const generatedProjection = createGeneratedHostedWebArtifactProjection({
            requiredHostMethods: ['context'],
            allowedMessageKinds: ['hostApi'],
        });
        const generatedPlacement = {
            ...browserHostedWebPlacement,
            generatedV2: true,
            pluginVersion: '1.2.3',
            renderer: { kind: 'hostedWeb', contributionId: 'panel', requiredHostMethods: ['context'] },
        } as const;

        try {
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={generatedPlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    pluginUiProjection={generatedProjection}
                    localServicePreviewState={createPreviewState()}
                    platform="web"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: iframeSource }
                            : null
                    ),
                },
            );
            await vi.waitFor(() => expect(screen.root.findAllByType('iframe')).toHaveLength(1));
            const frameUrl = new URL(String(screen.root.findByType('iframe').props.src));

            await act(async () => {
                const event = new Event('message') as MessageEvent;
                Object.defineProperties(event, {
                    origin: { value: 'null' },
                    data: { value: {
                        version: 1,
                        pluginId: 'acme.browser',
                        contributionId: 'hosted-panel',
                        surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                        nonce: frameUrl.searchParams.get('happierBridgeNonce'),
                        sequence: 1,
                        // `ready` is an internal bootstrap lifecycle message:
                        // it is admitted for a canonical host binding even when
                        // the author declaration names only `hostApi`.
                        kind: 'ready',
                        payload: { ready: true },
                    } },
                    source: { value: iframeSource },
                });
                (globalThis as any).window.dispatchEvent(event);
                await Promise.resolve();
                await Promise.resolve();
            });
            expect((iframeSource.postMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
                expect.objectContaining({ direction: 'hostToFrame', kind: 'bootstrap' }),
                '*',
            );

            await act(async () => {
                const event = new Event('message') as MessageEvent;
                Object.defineProperties(event, {
                    origin: { value: 'null' },
                    data: { value: {
                        version: 1,
                        pluginId: 'acme.browser',
                        contributionId: 'hosted-panel',
                        surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                        nonce: frameUrl.searchParams.get('happierBridgeNonce'),
                        sequence: 2,
                        kind: 'hostApi',
                        payload: {
                            wireVersion: 1,
                            kind: 'negotiate',
                            identity: generatedBrowserHostedWebHostIdentity,
                            apiRange: '^1.0.0',
                        },
                    } },
                    source: { value: iframeSource },
                });
                (globalThis as any).window.dispatchEvent(event);
                await Promise.resolve();
            });

            expect((iframeSource.postMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
                expect.objectContaining({
                    kind: 'result',
                    payload: expect.objectContaining({
                        kind: 'negotiated',
                        // The declared requirement is only `context`; the bound
                        // controller installs everything this mount can serve. A
                        // binding that echoed `requiredHostMethods` would
                        // advertise `['context']`. Both subscription methods are
                        // served here: `watchContext` from the mount's own
                        // surface fact (EU-8) and `watchResource` from the
                        // daemon-backed watch handler (EU-4b).
                        methods: EXPECTED_GENERIC_DESTINATION_HOST_METHODS,
                    }),
                }),
                '*',
            );

        } finally {
            (globalThis as any).window = previousWindow;
            (globalThis as any).location = previousLocation;
        }
    });

    it('admits hosted watchContext from its mount-owned push transport but refuses unavailable Resource and openable methods (§3.4)', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        // Generated V2 renderers must carry their real Artifact admission
        // facts. A hand-built generated descriptor with no Artifact is rejected
        // before host-method negotiation, which cannot prove watchContext.
        prepareGeneratedHostedWebArtifactFrame();
        const mountedProjection = createGeneratedHostedWebArtifactProjection({
            requiredHostMethods: ['context', 'readResource'],
            allowedMessageKinds: ['hostApi'],
        });
        const generatedPlacement = {
            ...browserHostedWebPlacement,
            generatedV2: true,
            pluginVersion: '1.2.3',
            renderer: { kind: 'hostedWeb', contributionId: 'panel', requiredHostMethods: ['context', 'readResource'] },
        } as const;

        // `watchContext` is not a second controller method. The selected
        // hosted-web transport owns the frame push producer for the mount's
        // one context fact, so its admission must use that same transport
        // projection. The frame still cannot negotiate before its strict ready
        // transition (covered by the bridge owner test); this is only renderer
        // admission against what that mounted transport can subsequently serve.
        const watchContextProjection: PluginUiProjectionModel = {
            ...mountedProjection,
            hostedWebById: {
                ...mountedProjection.hostedWebById,
                'hostedWeb:acme.browser:panel': {
                    ...mountedProjection.hostedWebById['hostedWeb:acme.browser:panel'],
                    requiredHostMethods: ['watchContext'],
                },
            },
        };
        const watchContextPlacement = {
            ...generatedPlacement,
            renderer: { kind: 'hostedWeb', contributionId: 'panel', requiredHostMethods: ['watchContext'] },
        } as const;
        const watchContextScreen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={watchContextPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server-a"
                pluginUiProjection={watchContextProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        await vi.waitFor(() => {
            // The exact generated Artifact reaches the frame only when the
            // mount's own push transport admits watchContext.
            expect(watchContextScreen.findByTestId('plugin-surface-unavailable')).toBeNull();
            expect(watchContextScreen.root.findAllByType('iframe')).toHaveLength(1);
        });

        // The renderer requires the daemon-served snapshot authority; this mount
        // cannot address a machine, so the controller does not install it and the
        // mount is refused rather than started with a method it cannot serve.
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedPlacement}
                resourceBrowserTarget={target}
                pluginUiProjection={mountedProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );

        expect(screen.root.findAllByType('iframe')).toHaveLength(0);
        expect(screen.root.findAllByProps({ testID: 'plugin-surface-unavailable' }).length).toBeGreaterThan(0);

        // Negative control: the SAME declaration is admitted where the mount can
        // address the machine and generation the method needs — so the refusal
        // above came from the factual installed set, not from the declaration.
        await screen.update(
            <PluginSurfacePlacementHost
                placement={generatedPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server-a"
                pluginUiProjection={mountedProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        await vi.waitFor(() => {
            expect(screen.root.findAllByProps({ testID: 'plugin-surface-unavailable' })).toHaveLength(0);
        });

        // A separate selected viewer may require the opaque-content methods,
        // but those methods are not installed by this ordinary Resource mount.
        // The normal renderer remains admitted above; widening its requirement
        // would incorrectly reject the ordinary panel instead of just refusing
        // this dedicated openable renderer.
        const openableRequiredHostMethods = ['context', 'statOpenableContent', 'readOpenableContent'];
        const openableProjection: PluginUiProjectionModel = {
            ...mountedProjection,
            hostedWebById: {
                ...mountedProjection.hostedWebById,
                'hostedWeb:acme.browser:panel': {
                    ...mountedProjection.hostedWebById['hostedWeb:acme.browser:panel'],
                    requiredHostMethods: openableRequiredHostMethods,
                },
            },
        };
        const openablePlacement = {
            ...generatedPlacement,
            renderer: {
                kind: 'hostedWeb',
                contributionId: 'panel',
                requiredHostMethods: openableRequiredHostMethods,
            },
        } as const;
        await screen.update(
            <PluginSurfacePlacementHost
                placement={openablePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={openableProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        expect(screen.root.findAllByType('iframe')).toHaveLength(0);
        expect(screen.root.findAllByProps({ testID: 'plugin-surface-unavailable' }).length).toBeGreaterThan(0);
    });

    it('keeps zero-Collection hosted-web surfaces inert and does not revive predecessor React Native mounts offline', async () => {
        reactNativeSurfaceProps.length = 0;
        pluginSurfaceConnectivity.endpointStatus = 'offline';
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        // A bound Availability reader always gives the mount a Data client. That
        // is not itself an offline rendering grant: this current release has no
        // admitted Account Collection contract to read or mutate.
        activePluginAvailability.reader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 1,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId: 'acme.browser',
                    response: {
                        availabilityCursor: 1,
                        hostingCapability: { enabled: false },
                        intent: {
                            pluginId: 'acme.browser',
                            desiredVersion: '3.2.1',
                            enabled: true,
                            offlineUiHosting: 'disabled',
                            writableCollections: [],
                            revision: 'intent-1',
                        },
                        release: {
                            ref: { pluginId: 'acme.browser', version: '3.2.1' },
                            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                                schemaVersion: 2,
                                id: 'acme.browser',
                                version: '3.2.1',
                                displayName: 'Browser Inspector',
                                engines: { happier: '^1.0.0' },
                                runtime: { apiVersion: 1 },
                                contributes: {},
                            }),
                            collectionContracts: [],
                            uiSlots: [],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [],
                    },
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        const hostApi = {
            platform: 'web' as const,
            channel: 'internal' as const,
            installedMethods: PLUGIN_UI_HOST_METHODS_V1,
            handleRequest: vi.fn(async () => ({ accepted: true })),
        };

        const hostedWeb = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserHostedWebPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        expect(hostedWeb.findByTestId(
            'plugin-surface-snapshot:surfacePlacement:acme.browser:hosted-panel',
        )?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });
        expect(hostedWeb.findByTestId(
            'plugin-surface-offline-summary:surfacePlacement:acme.browser:hosted-panel',
        )).toBeTruthy();

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={reactNativeProjection}
                platform="web"
            />,
        );
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);

        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.machineOnline = false;
        await hostedWeb.update(
            <PluginSurfacePlacementHost
                placement={browserHostedWebPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={hostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
        );
        expect(hostedWeb.findByTestId(
            'plugin-surface-snapshot:surfacePlacement:acme.browser:hosted-panel',
        )?.props).toMatchObject({
            inert: true,
            'aria-hidden': true,
        });

        const secondReactNativeScreen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                pluginUiProjection={reactNativeProjection}
                platform="web"
            />,
        );
        expect(secondReactNativeScreen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('renders an installed static-asset hosted-web surface from the daemon-served preview endpoint (Phase 6.1)', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const served = await renderScreen(
            <PluginSurfacePlacementHost
                placement={staticAssetHostedWebPlacement}
                machineId="machine_docs"
                sessionId="session_docs"
                pluginUiProjection={staticAssetHostedWebProjection}
                localServicePreviewState={createStaticAssetPreviewState()}
                platform="web"
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { postMessage: vi.fn() } }
                        : null
                ),
            },
        );
        const iframe = served.findByType('iframe');
        expect(iframe).not.toBeNull();
        expect(String(iframe?.props.src ?? '')).toContain('http://127.0.0.1:51789/');

        // Truthful availability: with no served preview row the surface stays
        // unavailable instead of advertising a phantom endpoint.
        const unserved = await renderScreen(
            <PluginSurfacePlacementHost
                placement={staticAssetHostedWebPlacement}
                machineId="machine_docs"
                sessionId="session_docs"
                pluginUiProjection={staticAssetHostedWebProjection}
                localServicePreviewState={createLocalServicePreviewState()}
                platform="web"
            />,
        );
        expect(unserved.root.findAllByType('iframe')).toHaveLength(0);
    });

    it('does not turn a generated V2 Artifact identity back into a Session preview URL', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const rendered = await renderScreen(
            <PluginSurfacePlacementHost
                placement={staticAssetHostedWebPlacement}
                machineId="machine_docs"
                sessionId="session_docs"
                pluginUiProjection={generatedArtifactHostedWebProjection}
                localServicePreviewState={createStaticAssetPreviewState()}
                platform="web"
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { postMessage: vi.fn() } }
                        : null
                ),
            },
        );

        // The presence of a stale runtimeMode and a real Session preview must
        // not make it a competing source for this V2 Artifact renderer. A
        // future packaged web-frame owner may legitimately render an iframe
        // through its own Artifact route, so this assertion rejects the
        // retired Session loopback source rather than all iframe adapters.
        expect(rendered.root.findAllByType('iframe').some((frame) => (
            String(frame.props.src ?? '').startsWith('http://127.0.0.1:51789/')
        ))).toBe(false);
    });

    it('retries and reissues an exact browser Artifact capability without remounting the surface', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const previousWindow = (globalThis as any).window;
        const previousLocation = (globalThis as any).location;
        (globalThis as any).window = new EventTarget();
        (globalThis as any).location = { origin: 'https://host.happier.test' };
        const graph = {
            contributionId: 'panel',
            tier: 'hostedWeb',
            platform: 'web',
            entry: 'hosted-web/docs/index.html',
            files: [{
                relativePath: 'hosted-web/docs/index.html',
                digest: `sha256:${'b'.repeat(64)}`,
                byteSize: 16,
            }],
            digest: `sha256:${'a'.repeat(64)}`,
            builtWith: { bundler: 'vite', version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        } as const;
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.docs',
            immutableGenerationId: 'docs-generation-11',
            projectionGeneration: 11,
        });
        const generatedProjection = withMountedTargetPackage({
            ...generatedArtifactHostedWebProjection,
            generation: 11,
            hostedWebById: {
                'hostedWeb:acme.docs:panel': {
                    ...generatedArtifactHostedWebProjection.hostedWebById['hostedWeb:acme.docs:panel']!,
                    artifactGraph: graph,
                },
            },
        } as unknown as PluginUiProjectionModel, targetedFixture, {
            displayName: 'Docs',
            version: '1.2.3',
        });
        const issuedCapabilities = [
            'hwb1.fixture.signature-1',
            'hwb1.fixture.signature-2',
        ] as const;
        const issuedUrls = issuedCapabilities.map((capability) => (
            `https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/${capability}/`
        ));
        const firstExpiresAt = Date.now() + 10_000;
        const replacementExpiresAt = Date.now() + 60_000;
        const releaseVersion = '1.2.3';
        activePluginAvailability.reader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 1,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId: 'acme.docs',
                    response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                        availabilityCursor: 1,
                        hostingCapability: {
                            enabled: true,
                            maxArtifactBytes: 1024,
                            maxAccountBytes: 2048,
                        },
                        intent: {
                            pluginId: 'acme.docs',
                            desiredVersion: releaseVersion,
                            enabled: true,
                            offlineUiHosting: 'enabled',
                            writableCollections: [],
                            revision: 'intent-1',
                        },
                        release: {
                            ref: { pluginId: 'acme.docs', version: releaseVersion },
                            archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                                schemaVersion: 2,
                                id: 'acme.docs',
                                version: releaseVersion,
                                displayName: 'Docs',
                                engines: { happier: '^1.0.0' },
                                runtime: { apiVersion: 1 },
                                contributes: {},
                            }),
                            collectionContracts: [],
                            uiSlots: [{
                                contributionId: graph.contributionId,
                                tier: graph.tier,
                                platform: graph.platform,
                                artifactDigest: graph.digest,
                                compatibility: {
                                    hostUiApiVersion: graph.hostUiApiVersion,
                                },
                            }],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [{
                            release: { pluginId: 'acme.docs', version: releaseVersion },
                            contributionId: graph.contributionId,
                            tier: graph.tier,
                            platform: graph.platform,
                            artifactId: '00000000-0000-4000-8000-000000000001',
                            artifactDigest: graph.digest,
                            compatibility: {
                                hostAppVersion: '1.0.0',
                                hostUiApiVersion: graph.hostUiApiVersion,
                                platform: graph.platform,
                                channel: 'internal',
                                nativeCapabilities: [],
                            },
                        }],
                    }),
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        pluginDataTransport.enabled = true;
        let issuedCount = 0;
        pluginDataTransport.request.mockImplementation(async (path: string) => {
            if (path !== PluginAvailabilityActionHttpPathsV1[
                'account.plugins.availability.uiArtifact.browserFrame.issue'
            ]) {
                throw new Error(`Unexpected browser Artifact path: ${path}`);
            }
            if (issuedCount === 0) {
                issuedCount += 1;
                throw new Error('transient_browser_artifact_transport');
            }
            const issueIndex = Math.min(issuedCount - 1, issuedUrls.length - 1);
            issuedCount += 1;
            return new Response(JSON.stringify({
                url: issuedUrls[issueIndex],
                expiresAt: issueIndex === 0 ? firstExpiresAt : replacementExpiresAt,
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });

        try {
            const renderBrowserArtifactFrame = async () => await renderScreen(
                <PluginSurfacePlacementHost
                    placement={staticAssetHostedWebPlacement}
                    machineId="machine_docs"
                    serverId="server-a"
                    sessionId="session_docs"
                    pluginUiProjection={generatedProjection}
                    localServicePreviewState={createStaticAssetPreviewState()}
                    platform="web"
                />,
                {
                    createNodeMock: (element) => (
                        (element as { type?: string }).type === 'iframe'
                            ? { contentWindow: { postMessage: vi.fn() } }
                            : null
                    ),
                },
            );
            const screen = await renderBrowserArtifactFrame();

            await flushHookEffects({ cycles: 6 });
            expect(screen.findByTestId('plugin-hosted-web-unavailable-action')).toBeTruthy();
            expect(pluginDataTransport.request).toHaveBeenCalledTimes(1);
            await act(async () => {
                screen.pressByTestId('plugin-hosted-web-unavailable-action');
                await Promise.resolve();
            });
            await flushHookEffects({ cycles: 6 });
            expect(screen.root.findAllByType('iframe')).toHaveLength(1);
            expect(pluginDataTransport.request).toHaveBeenCalledTimes(2);
            const [path, init] = pluginDataTransport.request.mock.calls[1]!;
            expect(path).toBe(PluginAvailabilityActionHttpPathsV1[
                'account.plugins.availability.uiArtifact.browserFrame.issue'
            ]);
            expect(JSON.parse(String(init?.body))).toEqual({
                release: { pluginId: 'acme.docs', version: releaseVersion },
                contributionId: graph.contributionId,
                tier: graph.tier,
                platform: graph.platform,
                expectedArtifactDigest: graph.digest,
            });

            const frame = screen.root.findByType('iframe');
            const frameUrl = new URL(String(frame.props.src));
            expect(frameUrl.origin).toBe('https://artifacts.happier.test');
            expect(frameUrl.pathname).toBe(`/v1/plugins/availability/ui-artifacts/browser/${issuedCapabilities[0]}/`);
            // The opaque capability is still server-owned, but the guest needs
            // this non-secret parent origin for its canonical bootstrap.
            expect(frameUrl.searchParams.get('happierHostOrigin')).toBe('https://host.happier.test');
            expect(frameUrl.searchParams.has('happierLaunchInput')).toBe(false);
            expect(frameUrl.searchParams.has('happierSubPath')).toBe(false);
            expect(frame.props.sandbox).toBe('allow-scripts');
            expect(frame.props.csp).toBeUndefined();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(10_000);
            });
            await flushHookEffects({ cycles: 12 });

            // Expiry is a real reissue boundary for the same current mount.
            // The issuer receives the same exact Artifact coordinate, while
            // the guest gets a fresh opaque capability and bridge nonce.
            expect(pluginDataTransport.request).toHaveBeenCalledTimes(3);
            expect(screen.root.findAllByType('iframe')).toHaveLength(1);
            expect(JSON.parse(String(pluginDataTransport.request.mock.calls[2]?.[1]?.body))).toEqual({
                release: { pluginId: 'acme.docs', version: releaseVersion },
                contributionId: graph.contributionId,
                tier: graph.tier,
                platform: graph.platform,
                expectedArtifactDigest: graph.digest,
            });
            const replacementFrameUrl = new URL(String(screen.root.findByType('iframe').props.src));
            expect(replacementFrameUrl.pathname).toBe(
                `/v1/plugins/availability/ui-artifacts/browser/${issuedCapabilities[1]}/`,
            );
            expect(replacementFrameUrl.searchParams.get('happierHostOrigin')).toBe('https://host.happier.test');
            expect(replacementFrameUrl.searchParams.get('happierBridgeNonce')).not.toBe(
                frameUrl.searchParams.get('happierBridgeNonce'),
            );

            await act(async () => {
                pluginSurfaceAccountLifetime.retire();
            });
            await flushHookEffects({ cycles: 6 });
            expect(screen.root.findAllByType('iframe')).toHaveLength(0);
        } finally {
            (globalThis as any).window = previousWindow;
            (globalThis as any).location = previousLocation;
        }
    });

    it('does not promote legacy RN cache bytes without a current Artifact availability lease', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const loadInstalledBundle = vi.fn(async () => module.renderSurface);

        getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
            identity: reactNativeCacheIdentity,
            bytes: new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]),
            format: 'plainJs',
        });

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                pluginUiProjection={reactNativeProjection}
                platform="desktop"
                reactNativeLoaderBackend={{
                    backendId: 'repackScriptManager',
                    available: true,
                    loadInstalledBundle,
                }}
            />,
            // This contract is the synchronous mount admission fact. Do not
            // flush unrelated long-lived resource/watch effects before reading
            // the renderer props it gates.
            { flushOptions: { cycles: 0 } },
        );

        // Legacy renderer-cache residency is not a canonical RenderContext
        // source. A host must fail closed before it can expose a retired Host
        // API shape, regardless of whether bytes happen to remain cached.
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
        expect(loadInstalledBundle).not.toHaveBeenCalled();
    });

    it('binds one exact generated crash state to the surface report and reset operations', async () => {
        reactNativeSurfaceProps.length = 0;
        const crashState = generatedReactNativeCrashState();
        reactNativeCrashReports.submit.mockResolvedValue({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-crash-state-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState })}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={mountedProjection}
                platform="web"
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

        const props = reactNativeSurfaceProps.at(-1) as {
            crashStateToken?: DaemonPluginReactNativeCrashStateV1['token'];
            crashStateDisabled?: boolean;
            reportFailure?: (failure: Readonly<{
                token: DaemonPluginReactNativeCrashStateV1['token'];
                failureOccurrenceId: string;
                failure: 'render_error';
            }>) => Promise<unknown>;
            resetCrashState?: () => Promise<unknown>;
        };
        const failure = {
            token: crashState.token,
            failureOccurrenceId: '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
            failure: 'render_error' as const,
        };

        expect(props.crashStateToken).toEqual(crashState.token);
        expect(props.crashStateDisabled).toBe(false);
        await expect(props.reportFailure?.(failure)).resolves.toEqual({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        await expect(props.resetCrashState?.()).resolves.toEqual({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        expect(reactNativeCrashReports.submit).toHaveBeenNthCalledWith(1, {
            machineId: 'machine_1',
            serverId: 'server_1',
            report: {
                kind: 'reportFailure',
                token: crashState.token,
                failureOccurrenceId: failure.failureOccurrenceId,
                failure: failure.failure,
            },
        });
        expect(reactNativeCrashReports.submit).toHaveBeenNthCalledWith(2, {
            machineId: 'machine_1',
            serverId: 'server_1',
            report: { kind: 'reset', token: crashState.token },
        });
    });

    it('reconciles one persisted crash occurrence through the real host, unavailable card, report, and rejoined surface', async () => {
        reactNativeSurfaceProps.length = 0;
        const crashState = generatedReactNativeCrashState();
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-crash-scope-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        // First let the Host produce its canonical target/Account scope. The
        // normal proxy branch deliberately keeps this setup mount inert.
        const sourceScreen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState })}
                resourceBrowserTarget={target}
                machineId="machine-a"
                serverId="server-a"
                pluginUiProjection={mountedProjection}
                platform="web"
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const sourceScopeKey = (reactNativeSurfaceProps.at(-1) as {
            crashReportScopeKey?: string;
        }).crashReportScopeKey;
        expect(sourceScopeKey).toBe(JSON.stringify([
            'machine-a',
            serverAccountScopeKeySuffix({ serverId: 'server-a', accountId: 'account-a' }),
        ]));
        await sourceScreen.unmount();

        const persistence = createMemoryWatchdogPersistence();
        const sourceWatchdog = createPluginReactNativeWatchdog({
            persistence,
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });
        const pending = sourceWatchdog.recordFailure({
            token: crashState.token,
            scopeKey: sourceScopeKey!,
            failure: 'render_error',
        });
        const restartedWatchdog = createPluginReactNativeWatchdog({
            persistence,
        });
        const completedReport = createDeferred<{
            ok: true;
            token: DaemonPluginReactNativeCrashStateV1['token'];
            disabled: boolean;
        }>();
        reactNativeCrashReports.submit.mockImplementation(() => completedReport.promise);
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.watchdog = restartedWatchdog;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: defineUiSurface(() => React.createElement(
                'View',
                { testID: 'plugin-rn-crash-rejoined-surface' },
            )),
        });

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState })}
                resourceBrowserTarget={target}
                machineId="machine-a"
                serverId="server-a"
                pluginUiProjection={mountedProjection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
            { flushOptions: { cycles: 0 } },
        );

        await vi.waitFor(() => expect(reactNativeCrashReports.submit).toHaveBeenCalledTimes(1));
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
        expect(screen.getTextContent()).toContain('pluginReactNative.unavailable');
        expect(screen.findByTestId('plugin-rn-crash-rejoined-surface')).toBeNull();
        expect(reactNativeCrashReports.submit).toHaveBeenCalledWith({
            machineId: 'machine-a',
            serverId: 'server-a',
            report: {
                kind: 'reportFailure',
                token: crashState.token,
                failureOccurrenceId: pending.failureOccurrenceId,
                failure: pending.failure,
            },
        });

        await act(async () => {
            completedReport.resolve({ ok: true, token: crashState.token, disabled: false });
            await completedReport.promise;
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        await vi.waitFor(() => {
            expect(screen.findByTestId('plugin-rn-crash-rejoined-surface')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        });
        expect(createPluginReactNativeWatchdog({
            persistence,
        }).readPending({ token: crashState.token, scopeKey: sourceScopeKey! })).toEqual([]);
        await screen.unmount();
    });

    it('does not replay a persisted crash occurrence when only its machine, server, or Account changes', async () => {
        const crashState = generatedReactNativeCrashState();
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-crash-scope-isolation-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const rejoinedModule = Object.freeze({
            renderSurface: defineUiSurface(() => React.createElement(
                'View',
                { testID: 'plugin-rn-crash-scope-successor-surface' },
            )),
        });
        const scenarios = [
            {
                source: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    account: { serverId: 'server-a', accountId: 'account-a' },
                },
                successor: {
                    machineId: 'machine-b',
                    serverId: 'server-a',
                    account: { serverId: 'server-a', accountId: 'account-a' },
                },
            },
            {
                source: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    account: { serverId: 'server-a', accountId: 'account-a' },
                },
                successor: {
                    machineId: 'machine-a',
                    serverId: 'server-b',
                    account: { serverId: 'server-b', accountId: 'account-a' },
                },
            },
            {
                source: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    account: { serverId: 'server-a', accountId: 'account-a' },
                },
                successor: {
                    machineId: 'machine-a',
                    serverId: 'server-a',
                    account: { serverId: 'server-a', accountId: 'account-b' },
                },
            },
        ] as const;

        for (const scenario of scenarios) {
            pluginSurfaceAccountLifetime.setScope(scenario.source.account);
            reactNativeSurfaceProps.length = 0;
            reactNativeSurfaceRuntime.enabled = false;
            const sourceScreen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={generatedReactNativePlacement({ crashState })}
                    resourceBrowserTarget={target}
                    machineId={scenario.source.machineId}
                    serverId={scenario.source.serverId}
                    pluginUiProjection={mountedProjection}
                    platform="web"
                />,
                { flushOptions: { cycles: 0 } },
            );
            await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
            const sourceScopeKey = (reactNativeSurfaceProps.at(-1) as {
                crashReportScopeKey?: string;
            }).crashReportScopeKey;
            expect(sourceScopeKey).toBeDefined();
            await sourceScreen.unmount();

            const persistence = createMemoryWatchdogPersistence();
            const sourceWatchdog = createPluginReactNativeWatchdog({
                persistence,
                createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
            });
            const pending = sourceWatchdog.recordFailure({
                token: crashState.token,
                scopeKey: sourceScopeKey!,
                failure: 'render_error',
            });
            const restartedWatchdog = createPluginReactNativeWatchdog({
                persistence,
            });

            pluginSurfaceAccountLifetime.setScope(scenario.successor.account);
            reactNativeSurfaceProps.length = 0;
            reactNativeCrashReports.submit.mockReset();
            reactNativeCrashReports.submit.mockResolvedValue({
                ok: true,
                token: crashState.token,
                disabled: false,
            });
            reactNativeSurfaceRuntime.enabled = true;
            reactNativeSurfaceRuntime.watchdog = restartedWatchdog;
            reactNativeSurfaceRuntime.module = rejoinedModule;
            const successorScreen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={generatedReactNativePlacement({ crashState })}
                    resourceBrowserTarget={target}
                    machineId={scenario.successor.machineId}
                    serverId={scenario.successor.serverId}
                    pluginUiProjection={mountedProjection}
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />,
                { flushOptions: { cycles: 0 } },
            );
            await vi.waitFor(() => {
                expect(successorScreen.findByTestId('plugin-rn-crash-scope-successor-surface')).toBeTruthy();
            });
            const successorScopeKey = (reactNativeSurfaceProps.at(-1) as {
                crashReportScopeKey?: string;
            }).crashReportScopeKey;
            expect(successorScopeKey).not.toBe(sourceScopeKey);
            expect(reactNativeCrashReports.submit).not.toHaveBeenCalled();
            expect(restartedWatchdog.readPending({
                token: crashState.token,
                scopeKey: sourceScopeKey!,
            })).toEqual([pending]);
            await successorScreen.unmount();
        }
    });

    it('retires the mounted author tree on Account replacement while the successor Account read is unavailable', async () => {
        // UI-NAV-REQ-12 through the real bound host: A -> B -> A with B's read
        // never settling. The author holds last-known-good rows in its own
        // React state exactly as the Channels surface does, so a retained tree
        // would keep Account A's private binding rendered under Account B. A
        // successor that resolved instantly could not tell the two apart.
        //
        // The mount is a `devHotReload` source with no projected crash state:
        // the host admits that shape (`requiresGeneratedCrashState` covers only
        // installed/disabled artifacts), and it is exactly the shape whose
        // watchdog scope key — the incidental carrier of the Account today —
        // is absent, so only a real Account boundary can retire this tree.
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const devUrl = 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true';
        const nativeCacheIdentity = {
            ...generatedReactNativeCacheIdentity,
            platform: 'ios',
        } as const;
        const nativeArtifactGraph = {
            ...generatedReactNativeArtifactGraph,
            platform: 'ios',
            builtWith: { bundler: 'repack', version: '5.0.0' },
            repack: defaultReactNativeModuleReference,
        } as const;
        const nativePlacement = Object.freeze({
            ...surfacePlacementFixture({
                binding: {
                    pluginId: 'acme.browser',
                    destinationId: 'native-dev-panel',
                    rendererId: 'native-panel',
                    container: 'rightPane',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                },
                renderer: { kind: 'reactNative', contributionId: 'native-panel' },
                display: { label: 'Native dev panel' },
                runtime: {},
            }),
            generatedV2: true,
        }) as unknown as PluginUiSurfacePlacementProjection;
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-account-author-boundary-generation-44',
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
        });
        const devProjection = withMountedTargetPackage({
            ...generatedReactNativeProjection,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...generatedReactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    artifactGraph: nativeArtifactGraph,
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: {
                            source: 'devHotReload',
                            devUrl,
                            featureEnabled: true,
                            loaderBackendAvailable: true,
                        },
                        cacheKey: 'generated-native-account-boundary-cache-key',
                        cacheIdentity: nativeCacheIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel, targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });

        let currentAccountRow: string | null = 'account-a-private-binding';
        let authorMounts = 0;
        const AuthorTree = (): React.ReactElement => {
            const [lastKnownGood] = React.useState(() => {
                authorMounts += 1;
                return currentAccountRow;
            });
            return React.createElement('View', {
                testID: 'plugin-rn-account-author-rows',
                accessibilityLabel: lastKnownGood ?? 'no-rows-yet',
            });
        };
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: defineUiSurface(() => React.createElement(AuthorTree)),
        });
        const host = () => (
            <PluginSurfacePlacementHost
                placement={nativePlacement}
                machineId="machine_1"
                serverId="server_1"
                sessionId="session_1"
                pluginUiProjection={devProjection}
                platform="ios"
                formFactor="tablet"
                reactNativeLoaderBackend={{
                    backendId: 'repackScriptManager',
                    available: true,
                    loadDevServerBundle: vi.fn(async () => () => null),
                }}
            />
        );
        const readAuthorRows = () => (
            screen.findByTestId('plugin-rn-account-author-rows')?.props.accessibilityLabel
        );

        pluginSurfaceAccountLifetime.setScope({ serverId: 'server_1', accountId: 'account-a' });
        const screen = await renderScreen(host(), { flushOptions: { cycles: 0 } });
        await vi.waitFor(() => {
            expect(readAuthorRows()).toBe('account-a-private-binding');
        });
        expect(authorMounts).toBe(1);
        expect((reactNativeSurfaceProps.at(-1) as {
            crashReportScopeKey?: string;
        }).crashReportScopeKey).toBeUndefined();

        // Control: an ordinary re-render inside ONE Account lifetime must NOT
        // retire the author tree. Without this arm the assertions below would
        // also pass for a host that remounts the plugin on every render, which
        // is not the contract and would hide the loss of the real boundary.
        currentAccountRow = null;
        await screen.update(host());
        expect(readAuthorRows()).toBe('account-a-private-binding');
        expect(authorMounts).toBe(1);

        // Account B's read never settles, so only a retired author tree can
        // clear Account A's rows.
        pluginSurfaceAccountLifetime.setScope({ serverId: 'server_1', accountId: 'account-b' });
        await screen.update(host());
        await vi.waitFor(() => {
            expect(readAuthorRows()).toBe('no-rows-yet');
        });
        expect(authorMounts).toBe(2);

        currentAccountRow = 'account-a-private-binding';
        pluginSurfaceAccountLifetime.setScope({ serverId: 'server_1', accountId: 'account-a' });
        await screen.update(host());
        await vi.waitFor(() => {
            expect(readAuthorRows()).toBe('account-a-private-binding');
        });
        expect(authorMounts).toBe(3);
        await screen.unmount();
    });

    it('does not let a late old-scope report completion alter the current surface', async () => {
        reactNativeSurfaceProps.length = 0;
        const crashState = generatedReactNativeCrashState();
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-crash-late-completion-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const sourceScopeProbe = await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState })}
                resourceBrowserTarget={target}
                machineId="machine-a"
                serverId="server-a"
                pluginUiProjection={mountedProjection}
                platform="web"
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const sourceScopeKey = (reactNativeSurfaceProps.at(-1) as {
            crashReportScopeKey?: string;
        }).crashReportScopeKey;
        expect(sourceScopeKey).toBeDefined();
        await sourceScopeProbe.unmount();

        const persistence = createMemoryWatchdogPersistence();
        const sourceWatchdog = createPluginReactNativeWatchdog({
            persistence,
            createFailureOccurrenceId: () => '6f46e1ba-4e7e-4e7e-8de8-6e8bc4ceac12',
        });
        const pending = sourceWatchdog.recordFailure({
            token: crashState.token,
            scopeKey: sourceScopeKey!,
            failure: 'render_error',
        });
        const restartedWatchdog = createPluginReactNativeWatchdog({
            persistence,
        });
        const lateReport = createDeferred<{
            ok: true;
            token: DaemonPluginReactNativeCrashStateV1['token'];
            disabled: boolean;
        }>();
        reactNativeCrashReports.submit.mockImplementation(() => lateReport.promise);
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.watchdog = restartedWatchdog;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: defineUiSurface(() => React.createElement(
                'View',
                { testID: 'plugin-rn-current-after-late-report' },
            )),
        });
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState })}
                resourceBrowserTarget={target}
                machineId="machine-a"
                serverId="server-a"
                pluginUiProjection={mountedProjection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => expect(reactNativeCrashReports.submit).toHaveBeenCalledTimes(1));
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();

        pluginSurfaceAccountLifetime.setScope({ serverId: 'server-b', accountId: 'account-b' });
        await screen.update(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState })}
                resourceBrowserTarget={target}
                machineId="machine-b"
                serverId="server-b"
                pluginUiProjection={mountedProjection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
        );
        await vi.waitFor(() => {
            expect(screen.findByTestId('plugin-rn-current-after-late-report')).toBeTruthy();
            expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        });

        await act(async () => {
            // A result that would disable the source binding must not mutate
            // the successor after the source effect has been cancelled.
            lateReport.resolve({ ok: true, token: crashState.token, disabled: true });
            await lateReport.promise;
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(reactNativeCrashReports.submit).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('plugin-rn-current-after-late-report')).toBeTruthy();
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
        expect(restartedWatchdog.readPending({
            token: crashState.token,
            scopeKey: sourceScopeKey!,
        })).toEqual([pending]);
        await screen.unmount();
    });

    it('fails closed before generated Artifact adoption when its crash state is missing or mismatched', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-crash-state-rejection-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const mismatchedArtifactState = generatedReactNativeCrashState({
            artifactDigest: `sha256:${'a'.repeat(64)}`,
        });

        for (const placement of [
            generatedReactNativePlacement({ crashState: null }),
            generatedReactNativePlacement({ crashState: mismatchedArtifactState }),
        ]) {
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={placement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={mountedProjection}
                    platform="web"
                />,
                { flushOptions: { cycles: 0 } },
            );
            await vi.waitFor(() => {
                expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
                expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-react_native_crash_state_unavailable')).toBeTruthy();
                expect(screen.getTextContent()).not.toContain('react_native_crash_state_unavailable');
            });
        }

        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('admits a disabled generated binding only to expose its exact reset operation', async () => {
        reactNativeSurfaceProps.length = 0;
        const crashState = generatedReactNativeCrashState({ disabled: true });
        reactNativeCrashReports.submit.mockResolvedValue({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-crash-reset-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({ crashState, disabled: true })}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={mountedProjection}
                platform="web"
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

        const props = reactNativeSurfaceProps.at(-1) as {
            crashStateToken?: DaemonPluginReactNativeCrashStateV1['token'];
            crashStateDisabled?: boolean;
            load?: unknown;
            resetCrashState?: () => Promise<unknown>;
        };
        expect(props.crashStateToken).toEqual(crashState.token);
        expect(props.crashStateDisabled).toBe(true);
        expect(props.load).toBeUndefined();
        await expect(props.resetCrashState?.()).resolves.toEqual({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        expect(reactNativeCrashReports.submit).toHaveBeenCalledWith({
            machineId: 'machine_1',
            serverId: 'server_1',
            report: { kind: 'reset', token: crashState.token },
        });
    });

    it('withholds a generated mount and Host API context until the current Account mode resolves', async () => {
        reactNativeSurfaceProps.length = 0;
        let resolveAccountEncryptionMode!: (value: AccountEncryptionModeResult) => void;
        const accountEncryptionModePending = new Promise<AccountEncryptionModeResult>((resolve) => {
            resolveAccountEncryptionMode = resolve;
        });
        accountEncryptionModeFetch.mockImplementation(async () => await accountEncryptionModePending);
        const mountedProjection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-account-mode-generation-44',
            projectionGeneration: 44,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement()}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={mountedProjection}
                platform="web"
            />,
            { flushOptions: { cycles: 0 } },
        );

        await flushHookEffects();
        expect(accountEncryptionModeFetch).toHaveBeenCalled();
        expect(reactNativeSurfaceProps).toHaveLength(0);

        await act(async () => {
            resolveAccountEncryptionMode({ mode: 'plain', updatedAt: 2 });
        });
        await vi.waitFor(() => {
            const props = reactNativeSurfaceProps.at(-1) as {
                renderContext?: { surface?: Pick<SurfaceContext, 'accountEncryptionMode'> };
            } | undefined;
            expect(props?.renderContext?.surface?.accountEncryptionMode).toBe('plain');
        });

        await screen.unmount();
    });

    it('mounts generated RNW with the canonical SDK render context and no invented Re.Pack identity', async () => {
        reactNativeSurfaceProps.length = 0;
        surfaceEnvironment.dark = true;
        surfaceEnvironment.rtl = true;
        surfaceEnvironment.fontScale = 1.6;
        surfaceEnvironment.insets = { top: 12, right: 8, bottom: 24, left: 4 };
        surfaceEnvironment.reducedMotion = true;
        surfaceEnvironment.screenReaderEnabled = true;
        surfaceEnvironment.highContrast = true;
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-rnw-generation-44',
            projectionGeneration: 44,
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const entryRelativePath = 'react-native/native-panel/index.js';
        const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: entryRelativePath, bytes: entryBytes },
        ]);
        const generatedIdentity = {
            ...reactNativeCacheIdentity,
            artifactDigest,
            platform: 'web',
            projectionGeneration: 44,
        };
        const artifactCompatibility = {
            hostUiApiVersion: '1.0.0',
            reactVersion: '19.2.0',
            reactNativeVersion: '0.83.4',
            expoRuntimeVersion: '0.2.0-native',
            hermesVersion: '0.15.0',
        } as const;
        const generatedProjection = {
            ...reactNativeProjection,
            generation: 44,
            installedPackagesById: {
                'acme.browser': {
                    id: 'acme.browser',
                    displayName: 'Browser Inspector',
                    version: '3.2.1',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'acme.browser' },
                    immutableGenerationId: targetedFixture.mountedTarget.immutableGenerationId,
                    brand: {
                        state: 'available',
                        resource: { pluginId: 'acme.browser', localId: 'brand-mark' },
                        width: 64,
                        height: 64,
                        digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
                    },
                },
                'acme.provider': {
                    id: 'acme.provider',
                    displayName: 'Provider Console',
                    version: '1.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'acme.provider' },
                    brand: { state: 'missing' },
                },
                'acme.disabled-provider': {
                    id: 'acme.disabled-provider',
                    displayName: 'Disabled Provider',
                    version: '1.0.0',
                    enabled: false,
                    source: { kind: 'bundled', locator: 'acme.disabled-provider' },
                    brand: { state: 'missing' },
                },
            },
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    generatedV2: true,
                    pluginVersion: '3.2.1',
                    artifactGraph: {
                        contributionId: 'native-panel-artifact',
                        tier: 'reactNative',
                        platform: 'web',
                        entry: entryRelativePath,
                        files: [{
                            relativePath: entryRelativePath,
                            digest: entryDigest,
                            byteSize: entryBytes.byteLength,
                        }],
                        digest: artifactDigest,
                        builtWith: { bundler: 'vite', version: '7.0.0' },
                        hostUiApiVersion: '1.0.0',
                        compat: { react: '19.2.0', reactNative: '0.83.4' },
                    },
                    hostApi: {
                        minVersion: '1.0.0',
                        methods: ['context', 'executeAction', 'publishCurrentUiContext'],
                    },
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: { source: 'installedArtifact' },
                        cacheKey: 'generated-native-cache-key',
                        cacheIdentity: generatedIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;
        const cache = getInstalledPluginReactNativeBundleCache();
        const persistentIdentity = {
            accountScope: { serverId: 'server-a', accountId: 'account-a' },
            releaseVersion: '3.2.1',
            pluginId: generatedIdentity.pluginId,
            contributionId: 'native-panel-artifact',
            tier: 'reactNative' as const,
            platform: 'web' as const,
            artifactDigest,
        };
        expect(await cache.writePersistentArtifact({
            persistentIdentity,
            bytes: entryBytes,
            entryRelativePath,
            files: [{
                relativePath: entryRelativePath,
                digest: entryDigest,
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            }],
        })).toBe(true);
        await expect(cache.readPersistentArtifact(persistentIdentity)).resolves.toEqual(expect.objectContaining({
            persistentIdentity,
            bytes: entryBytes,
        }));
        const generatedAccountAvailabilityReader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 44,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId: generatedIdentity.pluginId,
                    response: {
                        availabilityCursor: 44,
                        hostingCapability: { enabled: false },
                        intent: {
                            pluginId: generatedIdentity.pluginId,
                            desiredVersion: '3.2.1',
                            enabled: true,
                            offlineUiHosting: 'disabled',
                            writableCollections: [],
                            revision: 'intent-1',
                        },
                        release: {
                            ref: { pluginId: generatedIdentity.pluginId, version: '3.2.1' },
                            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                                schemaVersion: 2,
                                id: generatedIdentity.pluginId,
                                version: '3.2.1',
                                displayName: 'Browser Inspector',
                                engines: { happier: '^1.0.0' },
                                runtime: { apiVersion: 1 },
                                contributes: {},
                            }),
                            collectionContracts: [],
                            uiSlots: [{
                                contributionId: 'native-panel-artifact',
                                tier: 'reactNative',
                                platform: 'web',
                                artifactDigest,
                                compatibility: artifactCompatibility,
                            }],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [],
                    },
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        activePluginAvailability.reader = generatedAccountAvailabilityReader;
        const renderSurface = () => React.createElement('PluginNativeSurface');
        const loadInstalledBundle = vi.fn(async () => renderSurface);
        const reactNativeLoaderBackend = {
            backendId: 'reactNativeWebModule' as const,
            available: true,
            loadInstalledBundle,
        };
        const handleRequest = vi.fn(async () => ({ accepted: true }));
        const generatedPlacement = generatedReactNativePlacement({
            crashState: generatedReactNativeCrashState({ artifactDigest }),
        });

        // The mount no longer takes a host API: `connected` now drives the REAL
        // signal the controller reads — daemon reachability.
        const renderPlacement = (
            projection: PluginUiProjectionModel = generatedProjection,
            connected = true,
            focusActive = false,
        ) => {
            pluginSurfaceConnectivity.endpointStatus = connected ? 'online' : 'offline';
            return (
                <PluginSurfaceFocusEligibilityProvider active={focusActive}>
                    <PluginSurfacePlacementHost
                    placement={generatedPlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    sessionId="session-generated"
                    platform="web"
                    reactNativeLoaderBackend={reactNativeLoaderBackend}
                    />
                </PluginSurfaceFocusEligibilityProvider>
            );
        };
        const screen = await renderScreen(renderPlacement());
        await flushHookEffects();
        let props = reactNativeSurfaceProps.at(-1) as {
            hostApi?: unknown;
            renderContext?: {
                plugin: { id: string; version: string };
                surface: {
                    mount: SurfaceContext['mount'];
                    locale: string;
                    direction: string;
                    colorScheme: string;
                    contrast: string;
                    textScale: number;
                    reducedMotion: boolean;
                    screenReaderEnabled: boolean;
                    safeAreaInsets: { top: number; right: number; bottom: number; left: number };
                    target: SurfaceContext['target'];
                };
                hostApi: {
                    version(): { apiVersion: string; wireVersion: number; methods: readonly string[] };
                    context(): Promise<unknown>;
                    executeAction(action: string, input: unknown): Promise<unknown>;
                };
                signal: AbortSignal;
            };
            privateHostBindings?: {
                accountLifetime?: unknown;
                resourceStoreGeneration?: string;
                presentationHost?: PluginUiPrivatePresentationHost;
                dataClient?: unknown;
            };
            load?: () => Promise<unknown>;
            interactionEnabled?: boolean;
        };

        expect(props.hostApi).toBeUndefined();
        expect(props.interactionEnabled).toBe(true);
        expect(props.renderContext).toMatchObject({
            plugin: { id: 'acme.browser', version: '3.2.1' },
            surface: {
                mount: {
                    kind: 'destination',
                    destination: { pluginId: 'acme.browser', localId: 'native-panel' },
                    container: 'browserPanel',
                },
                locale: 'en',
                direction: 'rtl',
                colorScheme: 'dark',
                contrast: 'high',
                textScale: 1.6,
                reducedMotion: true,
                screenReaderEnabled: true,
                safeAreaInsets: { top: 12, right: 8, bottom: 24, left: 4 },
                // The mount's browser view target IS the surface's target
                // (§3.2). A browser destination without one does not
                // become an app surface — it fails closed and never mounts,
                // which the dedicated negative case below proves.
                target: { kind: 'browser', targetId: target.targetId },
            },
            hostApi: {
                version: expect.any(Function),
                context: expect.any(Function),
                executeAction: expect.any(Function),
            },
            signal: expect.any(AbortSignal),
        });
        expect(props.renderContext).not.toHaveProperty('view');
        expect(props.renderContext).not.toHaveProperty('generation');
        expect(props.renderContext).not.toHaveProperty('dataClient');
        expect('resourceScope' in (props.renderContext ?? {})).toBe(false);
        expect('dataClient' in (props.renderContext ?? {})).toBe(false);
        expect(Object.keys(props.renderContext ?? {})).not.toContain('resourceScope');
        expect(Object.keys(props.renderContext ?? {})).not.toContain('dataClient');
        expect(Object.getOwnPropertySymbols(props.renderContext ?? {})).not.toContain(
            Symbol.for('happier.pluginUi.privateResourceStoreScope.v1'),
        );
        expect(Object.getOwnPropertySymbols(props.renderContext ?? {})).not.toContain(
            Symbol.for('happier.pluginUi.privatePresentationHost.v1'),
        );
        expect(Object.isFrozen(props.privateHostBindings)).toBe(true);
        expect(props.privateHostBindings?.accountLifetime).toEqual(expect.objectContaining({
            isCurrent: expect.any(Function),
        }));
        expect(props.privateHostBindings?.resourceStoreGeneration).toBe('44');
        expect(props.privateHostBindings?.dataClient).toEqual(expect.objectContaining({
            collection: expect.any(Function),
            openCollectionQuery: expect.any(Function),
        }));
        const accountADataClient = props.privateHostBindings?.dataClient;
        expect(props.renderContext?.hostApi.version()).toMatchObject({
            apiVersion: '1.0.0',
            wireVersion: 1,
            // Factual (UI-D02): this mount cannot address a machine, so the
            // daemon-served snapshot/Resource authority is NOT advertised.
            // Composer facade methods are factually installed on a generated
            // destination; only the daemon Resource/openable/navigation
            // families are unavailable here. Current-UI publication likewise
            // stays absent without the AppShell-owned mount publisher. Derive
            // that remainder from the canonical vocabulary after excluding
            // those semantic families.
            methods: PLUGIN_UI_HOST_METHODS_V1.filter(
                (method) => (
                    !GENERATED_DESTINATION_UNAVAILABLE_HOST_METHODS.has(method)
                    && method !== 'publishCurrentUiContext'
                ),
            ),
        });
        await expect(props.renderContext?.hostApi.context()).resolves.toBe(props.renderContext?.surface);
        // §3.1: the author's own API is the bound controller's. The exact
        // target snapshot admits the mount, but this fixture deliberately
        // carries no caller contribution, so contributed Action dispatch stays
        // typed-unavailable rather than inventing a caller (UI-D08). The
        // successful daemon round trip is proven per placement by the EU-2
        // cross-path block below.
        await expect(props.renderContext?.hostApi.executeAction('open', { source: 'generated' }))
            .rejects.toMatchObject({
                code: 'unavailable',
                diagnostics: [{
                    code: 'plugin_mounted_caller_unavailable',
                    severity: 'error',
                }],
            });
        // Exact bytes can come from the verified persistent Artifact cache
        // without a daemon origin. That does not grant daemon effect authority:
        // the independently asserted contributed Action remains typed unavailable.
        expect(props.load).toEqual(expect.any(Function));
        await expect(props.load?.()).resolves.toEqual({ renderSurface });
        expect(loadInstalledBundle).toHaveBeenCalledTimes(1);

        const projectionWithMalformedRawCacheDigest = (
            field: 'artifactDigest' | 'nativeCapabilitiesDigest',
        ): PluginUiProjectionModel => {
            const projection = structuredClone(generatedProjection);
            const bundle = projection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'];
            const runtime = bundle?.runtime;
            const cacheIdentity = runtime && typeof runtime === 'object'
                ? Reflect.get(runtime, 'cacheIdentity')
                : null;
            if (!cacheIdentity || typeof cacheIdentity !== 'object') {
                throw new Error('Fixture must retain the projected raw cache identity.');
            }
            const digest = Reflect.get(cacheIdentity, field);
            if (typeof digest !== 'string') {
                throw new Error(`Fixture must retain a raw ${field}.`);
            }
            // This models corrupt projection input at the host boundary without
            // weakening the typed fixture or adding a test-only digest parser.
            Reflect.set(cacheIdentity, field, digest.toUpperCase());
            return projection;
        };
        const expectMalformedRawCacheDigestToFailClosed = async (
            field: 'artifactDigest' | 'nativeCapabilitiesDigest',
        ) => {
            const renderedSurfaceCount = reactNativeSurfaceProps.length;
            await screen.update(renderPlacement(projectionWithMalformedRawCacheDigest(field)));
            // Invalid raw identities fail before a new physical RN surface is
            // mounted. The retained array entry belongs to the preceding
            // admitted render and must not be reinterpreted as malformed props.
            expect(reactNativeSurfaceProps, field).toHaveLength(renderedSurfaceCount);
            expect(loadInstalledBundle, field).toHaveBeenCalledTimes(1);
        };

        // Negative controls: both Protocol-branded digests must survive the
        // raw Host projection boundary before an installed Artifact can load.
        await expectMalformedRawCacheDigestToFailClosed('artifactDigest');
        await expectMalformedRawCacheDigestToFailClosed('nativeCapabilitiesDigest');
        await screen.update(renderPlacement());
        // The fail-closed malformed projections physically retire the prior
        // renderer. Continue the equivalence checks from the newly admitted
        // mount rather than from the intentionally aborted predecessor.
        props = reactNativeSurfaceProps.at(-1) as typeof props;

        const presentationHost = props.privateHostBindings?.presentationHost;
        expect(presentationHost).toBeTruthy();
        expect(presentationHost?.brand).toEqual({
            displayName: 'Browser Inspector',
            resource: { pluginId: 'acme.browser', localId: 'brand-mark' },
        });
        // A bound mount lifetime alone cannot distinguish a visible
        // destination from a retained hidden pane. The private host can expose
        // the transfer function, but the inactive layout fact makes it fail
        // closed before touching a physical target.
        const focusTarget = { focus: vi.fn() };
        expect(typeof presentationHost?.focusTarget).toBe('function');
        expect(presentationHost?.focusTarget?.(focusTarget)).toBe(false);
        expect(focusTarget.focus).not.toHaveBeenCalled();
        const targetBrandPresentationHost = presentationHost as unknown as Readonly<{
            resolveBrandDisplayName(pluginId: string): string;
            renderBrandMark(input: Readonly<{
                pluginId: string;
                size?: 'small' | 'medium' | 'large';
                showName?: boolean;
                testID?: string;
            }>): React.ReactElement;
        }>;
        expect(targetBrandPresentationHost.resolveBrandDisplayName('acme.provider')).toBe('Provider Console');
        // Name identity stays projection-owned even when that provider cannot supply
        // optional bytes. The mark renderer itself must remain a neutral fallback.
        expect(targetBrandPresentationHost.resolveBrandDisplayName('acme.disabled-provider')).toBe('Disabled Provider');
        expect(targetBrandPresentationHost.renderBrandMark({
            pluginId: 'acme.provider',
            size: 'small',
            showName: false,
            testID: 'provider-brand',
        })).toEqual(expect.anything());
        expect(Object.keys(presentationHost ?? {})).not.toContain('installedPackagesById');
        expect(props.renderContext).not.toHaveProperty('installedPackagesById');
        const anchorRef = { current: { measureInWindow: () => {} } } as React.RefObject<unknown>;
        const focusReturnRef = { current: { focus: () => {} } } as React.RefObject<unknown>;
        const onRequestClose = vi.fn();
        let contentControls: Parameters<
            Parameters<PluginUiPrivatePresentationHost['renderPopover']>[0]['content']
        >[0] | undefined;
        const popover = presentationHost!.renderPopover({
            open: true,
            anchorRef,
            focusReturnRef,
            onRequestClose,
            content: (controls) => {
                contentControls = controls;
                return null;
            },
        });
        expect(popover.props.anchorRef).toBe(anchorRef);
        expect(popover.props.focusReturnRef).toBe(focusReturnRef);
        expect(popover.props.portal).toMatchObject({ web: true, native: true });
        const requestClose = vi.fn();
        popover.props.children({ requestClose });
        contentControls?.requestClose('selection');
        expect(requestClose).toHaveBeenCalledWith('selection');
        popover.props.onRequestClose();
        expect(onRequestClose).toHaveBeenCalledTimes(1);

        const initialPresentationHost = props.privateHostBindings?.presentationHost;
        const initialSignal = props.renderContext?.signal;
        await screen.update(renderPlacement(structuredClone(generatedProjection)));
        const semanticallyEquivalentProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(semanticallyEquivalentProps.renderContext?.signal).toBe(initialSignal);
        expect(semanticallyEquivalentProps.privateHostBindings?.presentationHost)
            .toBe(initialPresentationHost);

        surfaceEnvironment.dark = false;
        surfaceEnvironment.rtl = false;
        surfaceEnvironment.fontScale = 2;
        surfaceEnvironment.insets = { top: 0, right: 16, bottom: 20, left: 16 };
        surfaceEnvironment.reducedMotion = false;
        surfaceEnvironment.screenReaderEnabled = false;
        surfaceEnvironment.highContrast = false;
        await screen.update(renderPlacement());
        const refreshedProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(refreshedProps.renderContext?.surface).toMatchObject({
            direction: 'ltr',
            colorScheme: 'light',
            contrast: 'normal',
            textScale: 2,
            reducedMotion: false,
            screenReaderEnabled: false,
            safeAreaInsets: { top: 0, right: 16, bottom: 20, left: 16 },
        });
        expect(refreshedProps.renderContext?.signal).toBe(initialSignal);
        expect(refreshedProps.renderContext?.signal.aborted).toBe(false);
        expect(refreshedProps.privateHostBindings?.dataClient).toBe(accountADataClient);

        // The Availability hook rematerializes an equivalent bound reader when
        // its Account projection changes. That must not replace this mount's
        // Data client (and dispose its Data-owned pager) while the captured
        // Account lifetime remains current.
        activePluginAvailability.reader = Object.freeze({ ...generatedAccountAvailabilityReader });
        await screen.update(renderPlacement());
        const availabilityRefreshedProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(availabilityRefreshedProps.privateHostBindings?.dataClient).toBe(accountADataClient);

        await screen.update(renderPlacement(generatedProjection, false));
        const offlineProps = reactNativeSurfaceProps.at(-1) as typeof props;
        // A bound Availability reader/Data client exists for every active
        // Account, but this release admits no Collection contract. It remains
        // interaction-inert through a daemon outage without creating a second,
        // context-less RN mount path.
        expect(offlineProps.interactionEnabled).toBe(false);
        expect(offlineProps.renderContext).toBeDefined();
        expect(offlineProps.privateHostBindings?.dataClient).toBe(accountADataClient);
        expect(offlineProps.privateHostBindings?.presentationHost?.focusTarget?.(focusTarget)).toBe(false);
        expect(focusTarget.focus).not.toHaveBeenCalled();
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();
        // The renderer and its host API lifetime remain current offline; only
        // the daemon-backed effect boundary is unavailable.
        await expect(props.renderContext?.hostApi.executeAction('open', { source: 'offline' }))
            .rejects.toMatchObject({ code: 'unavailable' });

        const renderedSurfaceCountBeforeStaleProjection = reactNativeSurfaceProps.length;
        await screen.update(renderPlacement({
            ...generatedProjection,
            generation: generatedIdentity.projectionGeneration + 1,
        }));
        // Artifact admission owns the projection-generation fence. A stale
        // generation is rejected before another physical RN renderer receives
        // props; the previous array entry must not be mistaken for an inert
        // stale-generation mount.
        expect(reactNativeSurfaceProps).toHaveLength(renderedSurfaceCountBeforeStaleProjection);
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeNull();
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();

        await screen.update(renderPlacement(generatedProjection, true, true));
        const revalidatedProps = reactNativeSurfaceProps.at(-1) as typeof props;
        expect(revalidatedProps.interactionEnabled).toBe(true);
        expect(revalidatedProps.renderContext).toBeDefined();
        const activeFocusHost = revalidatedProps.privateHostBindings?.presentationHost;
        expect(activeFocusHost?.focusTarget?.(focusTarget)).toBe(true);
        expect(focusTarget.focus).toHaveBeenCalledTimes(1);

        const renderedSurfaceCountBeforeAccountRetirement = reactNativeSurfaceProps.length;
        await act(async () => {
            pluginSurfaceAccountLifetime.retire();
            await Promise.resolve();
        });
        // Daemon-offline retention is same-Account continuity. Account
        // retirement is instead a disclosure boundary: the Account-A plugin
        // tree and its private Data provider must unmount before Account B.
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeNull();
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(renderedSurfaceCountBeforeAccountRetirement);
        expect(activeFocusHost?.focusTarget?.(focusTarget)).toBe(false);
        expect(focusTarget.focus).toHaveBeenCalledTimes(1);

        await screen.unmount();
        expect(props.renderContext?.signal.aborted).toBe(true);
    });

    it('keeps an Account-data RN renderer mounted through an all-daemons-offline cold start while daemon methods stay unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const collectionDefinition = defineAccountCollection({
            id: 'account-items',
            schemaVersion: 1,
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string', maxLength: 256 },
                    title: { type: 'string', maxLength: 256 },
                },
                required: ['id', 'title'],
                additionalProperties: false,
            },
            rowIdField: 'id',
            identityFields: [],
            serverReadable: ['title'],
            indexes: [],
            uiQueries: [],
            relations: [],
        });
        const contract = normalizePluginAccountCollectionContractV1({
            pluginId: 'acme.browser',
            contribution: {
                ...collectionDefinition,
                migrations: [],
            },
        });
        const contractRef = {
            pluginId: contract.pluginId,
            collectionId: contract.collectionId,
            schemaVersion: contract.schemaVersion,
            contractDigest: contract.contractDigest,
        };
        activePluginAvailability.reader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 1,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId: 'acme.browser',
                    response: {
                        availabilityCursor: 1,
                        hostingCapability: {
                            enabled: true,
                            maxArtifactBytes: 1024,
                            maxAccountBytes: 2048,
                        },
                        intent: {
                            pluginId: 'acme.browser',
                            desiredVersion: '3.2.1',
                            enabled: true,
                            offlineUiHosting: 'enabled',
                            writableCollections: [contractRef],
                            revision: 'intent-1',
                        },
                        release: {
                            ref: { pluginId: 'acme.browser', version: '3.2.1' },
                            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                                schemaVersion: 2,
                                id: 'acme.browser',
                                version: '3.2.1',
                                displayName: 'Browser Inspector',
                                engines: { happier: '^1.0.0' },
                                runtime: { apiVersion: 1 },
                                contributes: {},
                            }),
                            collectionContracts: [contractRef],
                            uiSlots: [],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [],
                    },
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        recordAccountStoredContentServerRequirements({
            serverUrl: 'https://plugin-data.example',
            requirements: {
                v: 1,
                minimumProtocolVersion: 2,
                currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1',
            },
        });
        pluginDataTransport.enabled = true;
        pluginDataTransport.request.mockImplementation(async (path: string) => {
            if (path === '/v1/account/encryption/currentness') {
                return new Response(JSON.stringify({
                    mode: 'plain',
                    version: 1,
                    signingKeyFingerprint: null,
                    contentKeyFingerprint: null,
                    updatedAt: 1,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (path === '/v1/plugins/data/contract') {
                return new Response(JSON.stringify({ contract }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }
            if (path === '/v1/plugins/data/get') {
                return new Response(JSON.stringify({
                    row: {
                        rowId: 'account-item-1',
                        revision: 3,
                        content: { t: 'plain', v: {} },
                        projection: { title: 'Account-local item' },
                    },
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (path === '/v1/plugins/data/mutate') {
                return new Response(JSON.stringify({
                    status: 'updated',
                    results: [{ rowId: 'account-item-1', revision: 4, deleted: false }],
                    changeCursor: 4,
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            throw new Error(`Unexpected plugin Data path: ${path}`);
        });
        const baseProjection = {
            ...reactNativeProjection,
            generation: 91,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    generatedV2: true,
                    pluginVersion: '3.2.1',
                    artifactGraph: {
                        ...generatedReactNativeArtifactGraph,
                        digest: generatedReactNativeCacheIdentity.artifactDigest,
                    },
                    hostApi: {
                        minVersion: '1.0.0',
                        methods: ['context', 'executeAction', 'readResource'],
                    },
                    // `requiredHostMethods` is an admission contract, not a
                    // live-daemon availability claim: this Account-data
                    // renderer remains mounted through an offline cold start.
                    requiredHostMethods: ['readResource'],
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: { source: 'devHotReload', devUrl: 'http://127.0.0.1:8082/index.bundle', featureEnabled: true, loaderBackendAvailable: true },
                        cacheKey: 'account-data-offline-rn-cache-key',
                        cacheIdentity: {
                            ...generatedReactNativeCacheIdentity,
                            projectionGeneration: 91,
                        },
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;
        const projection = withExactGeneratedMountedTarget({
            projection: baseProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-account-data-offline-generation-91',
            projectionGeneration: 91,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const placement = {
            ...generatedReactNativePlacement({
                crashState: generatedReactNativeCrashState({
                    artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                }),
            }),
            runtime: {
                reactNativeCrashState: generatedReactNativeCrashState({
                    artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                }),
                resourceCapability: { readable: true, dynamic: false },
            },
            binding: generatedReactNativePlacement().binding,
        } as PluginUiSurfacePlacementProjection;
        const renderPlacement = (connected: boolean) => {
            pluginSurfaceConnectivity.endpointStatus = connected ? 'online' : 'offline';
            pluginSurfaceConnectivity.machineOnline = connected;
            return (
                <PluginSurfacePlacementHost
                    placement={placement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadDevServerBundle: vi.fn(async () => () => null),
                    }}
                />
            );
        };

        const screen = await renderScreen(renderPlacement(false));
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const offlineProps = reactNativeSurfaceProps.at(-1) as {
            interactionEnabled?: boolean;
            renderContext?: RenderContext;
            privateHostBindings?: { dataClient?: PluginUiDataClient };
        };
        expect(offlineProps.interactionEnabled).toBe(true);
        expect(offlineProps.renderContext).toBeDefined();
        expect(offlineProps.privateHostBindings?.dataClient).toBeDefined();
        expect(offlineProps.renderContext?.hostApi.version().methods).toEqual(
            expect.arrayContaining(['context', 'watchContext', 'executeAction']),
        );
        expect(offlineProps.renderContext?.hostApi.version().methods).toContain('readResource');
        await expect(offlineProps.renderContext?.hostApi.executeAction('open', { source: 'offline' }))
            .rejects.toMatchObject({ code: 'unavailable' });
        await expect(offlineProps.renderContext?.hostApi.readResource('snapshot'))
            .rejects.toMatchObject({ code: 'unavailable' });
        expect(declarativeActionExecuteMock).not.toHaveBeenCalled();
        expect(resourceReadMock).not.toHaveBeenCalled();

        const dataClient = offlineProps.privateHostBindings!.dataClient!;
        const collection = dataClient.collection(collectionDefinition);
        await expect(collection.get('account-item-1')).resolves.toEqual({
            rowId: 'account-item-1',
            revision: 3,
            value: { id: 'account-item-1', title: 'Account-local item' },
        });
        await expect(collection.put({ id: 'account-item-1', title: 'Updated offline' }, {
            expectedRevision: 3,
        })).resolves.toEqual({
            rowId: 'account-item-1',
            revision: 4,
            value: { id: 'account-item-1', title: 'Updated offline' },
        });
        const mutationCall = pluginDataTransport.request.mock.calls.find(([path]) => path === '/v1/plugins/data/mutate');
        expect(mutationCall).toBeDefined();
        expect(JSON.parse(String(mutationCall?.[1]?.body))).toMatchObject({
            pluginId: 'acme.browser',
            collectionId: 'account-items',
            operations: [{
                kind: 'put',
                rowId: 'account-item-1',
                expectedRevision: 3,
                projection: { title: 'Updated offline' },
            }],
        });

        await screen.update(renderPlacement(true));
        const reconnectedProps = reactNativeSurfaceProps.at(-1) as typeof offlineProps;
        expect(reconnectedProps.interactionEnabled).toBe(true);
        expect(reconnectedProps.privateHostBindings?.dataClient).toBe(dataClient);
        expect(reconnectedProps.renderContext?.signal).toBe(offlineProps.renderContext?.signal);
        expect(reconnectedProps.renderContext?.hostApi.version().methods).toEqual(
            expect.arrayContaining(['executeAction', 'readResource']),
        );
        await expect(reconnectedProps.renderContext?.hostApi.readResource('snapshot')).resolves.toMatchObject({
            contentType: 'application/json',
            bytes: new Uint8Array([123, 125]),
        });
        expect(resourceReadMock).toHaveBeenCalledWith('machine_1', expect.objectContaining({
            serverId: 'server_1',
            expectedGeneration: '91',
            callerPluginId: 'acme.browser',
            resource: { pluginId: 'acme.browser', localId: 'snapshot' },
        }));

        await screen.unmount();
        expect(offlineProps.renderContext?.signal.aborted).toBe(true);
    });

    it('keeps structurally admitted RN Host API methods stable across reconnect without remounting it', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderMethodSets: string[] = [];
        const mountedProbeEffects: string[] = [];
        const CurrentnessProbe = (props: Readonly<{ hostApi: PluginUiHostApi }>) => {
            React.useEffect(() => {
                mountedProbeEffects.push('mount');
                return () => { mountedProbeEffects.push('unmount'); };
            }, []);
            return React.createElement('View', {
                testID: 'plugin-rn-host-api-currentness',
                accessibilityLabel: props.hostApi.version().methods.join(','),
            });
        };
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: (context: RenderContext) => {
                renderMethodSets.push(context.hostApi.version().methods.join(','));
                return React.createElement(CurrentnessProbe, { hostApi: context.hostApi });
            },
        });
        const placement = {
            ...generatedReactNativePlacement({
                crashState: generatedReactNativeCrashState({
                    artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                }),
            }),
            runtime: {
                reactNativeCrashState: generatedReactNativeCrashState({
                    artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                }),
                resourceCapability: { readable: true, dynamic: false },
            },
            binding: generatedReactNativePlacement().binding,
        } as PluginUiSurfacePlacementProjection;
        const projection = withExactGeneratedMountedTarget({
            projection: generatedReactNativeProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-host-api-currentness-generation-91',
            projectionGeneration: 91,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const renderPlacement = (connected: boolean) => {
            pluginSurfaceConnectivity.endpointStatus = connected ? 'online' : 'offline';
            pluginSurfaceConnectivity.machineOnline = connected;
            return (
                <PluginSurfacePlacementHost
                    placement={placement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadDevServerBundle: vi.fn(async () => () => null),
                    }}
                />
            );
        };

        const screen = await renderScreen(renderPlacement(false));
        await vi.waitFor(() => expect(screen.findByTestId('plugin-rn-host-api-currentness')).toBeTruthy());
        const offlineHostApi = (reactNativeSurfaceProps.at(-1) as {
            renderContext?: RenderContext;
        }).renderContext?.hostApi;
        expect(offlineHostApi).toBeDefined();
        expect(screen.findByTestId('plugin-rn-host-api-currentness')?.props.accessibilityLabel)
            .toContain('readResource');
        expect(mountedProbeEffects).toEqual(['mount']);

        pluginSurfaceConnectivity.daemonStateVersion += 1;
        await screen.update(renderPlacement(true));

        await vi.waitFor(() => expect(screen.findByTestId('plugin-rn-host-api-currentness')?.props.accessibilityLabel)
            .toContain('readResource'));
        const reconnectedHostApi = (reactNativeSurfaceProps.at(-1) as {
            renderContext?: RenderContext;
        }).renderContext?.hostApi;
        expect(reconnectedHostApi).toBe(offlineHostApi);
        expect(renderMethodSets.at(-1)).toContain('readResource');
        expect(mountedProbeEffects).toEqual(['mount']);

        await screen.unmount();
        expect(mountedProbeEffects).toEqual(['mount', 'unmount']);
    });

    it('EU-5a: carries openSurface launch input into the canonical render context and replaces it on reopen', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        const entryRelativePath = 'react-native/native-panel/index.js';
        const entryBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
        const generatedIdentity = {
            ...reactNativeCacheIdentity,
            artifactDigest: PluginUiArtifactDigestV1Schema.parse('sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'),
            platform: 'web',
            projectionGeneration: 52,
        };
        const baseProjection = {
            ...reactNativeProjection,
            generation: 52,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    generatedV2: true,
                    pluginVersion: '3.2.1',
                    artifactGraph: {
                        contributionId: 'native-panel-artifact',
                        tier: 'reactNative',
                        platform: 'web',
                        entry: entryRelativePath,
                        files: [{
                            relativePath: entryRelativePath,
                            digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                            byteSize: entryBytes.byteLength,
                        }],
                        digest: generatedIdentity.artifactDigest,
                        builtWith: { bundler: 'vite', version: '7.0.0' },
                        hostUiApiVersion: '1.0.0',
                        compat: { react: '19.2.0', reactNative: '0.83.4' },
                    },
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: { source: 'installedArtifact' },
                        cacheKey: 'launch-input-cache-key',
                        cacheIdentity: generatedIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel;
        const generatedProjection = withExactGeneratedMountedTarget({
            projection: baseProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-launch-input-generation-52',
            projectionGeneration: 52,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
            identity: generatedIdentity,
            bytes: entryBytes,
            entryRelativePath,
            format: 'plainJs',
            files: [{
                relativePath: entryRelativePath,
                digest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
                byteSize: entryBytes.byteLength,
                bytes: entryBytes,
            }],
        });
        const handleRequest = vi.fn(async () => null);
        const renderPlacement = (launchInput?: unknown) => (
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement({
                    crashState: generatedReactNativeCrashState({
                        artifactDigest: generatedIdentity.artifactDigest,
                    }),
                })}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={generatedProjection}
                sessionId="session-launch"
                platform="web"
                launchInput={launchInput as never}
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />
        );
        type LaunchProps = { renderContext?: { launchInput?: unknown } };

        // Opened without input: the key is ABSENT, not `undefined`, so an author
        // can distinguish "no launch input" from an explicit value.
        const screen = await renderScreen(renderPlacement());
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        expect(reactNativeSurfaceProps.at(-1) as LaunchProps).toBeTruthy();
        expect((reactNativeSurfaceProps.at(-1) as LaunchProps).renderContext)
            .not.toHaveProperty('launchInput');

        await screen.update(renderPlacement({ itemId: 'first' }));
        expect((reactNativeSurfaceProps.at(-1) as LaunchProps).renderContext?.launchInput)
            .toEqual({ itemId: 'first' });

        // Reopening replaces the launch input; it is never merged with the previous one.
        await screen.update(renderPlacement({ filter: 'second' }));
        expect((reactNativeSurfaceProps.at(-1) as LaunchProps).renderContext?.launchInput)
            .toEqual({ filter: 'second' });
    });

    it('EU-5b: keeps app.page launch facts out of the hosted-web frame URL', async () => {
        // Launch facts leave through the strict post-ready bootstrap. The
        // location is only the bridge address and cannot retain transient input
        // in browser history, referrers, request logs, or cache identity.
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderPage = (launch?: Readonly<{ launchInput?: unknown; subPath?: string }>) => (
            <PluginSurfacePlacementHost
                placement={appPageHostedWebPlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                sessionId="session_1"
                pluginUiProjection={appPageHostedWebProjection}
                localServicePreviewState={createPreviewState()}
                platform="web"
                {...(launch?.launchInput === undefined ? {} : { launchInput: launch.launchInput as never })}
                {...(launch?.subPath === undefined ? {} : { subPath: launch.subPath })}
            />
        );
        const frameQuery = (screen: Awaited<ReturnType<typeof renderScreen>>) => (
            new URL(String(screen.root.findByType('iframe').props.src)).searchParams
        );

        const screen = await renderScreen(renderPage({ subPath: '' }));
        expect(frameQuery(screen).has('happierSubPath')).toBe(false);

        await screen.update(renderPage({ subPath: 'work/ideas.md', launchInput: { noteId: 'note-7' } }));
        const withLocation = frameQuery(screen);
        expect(withLocation.has('happierSubPath')).toBe(false);
        expect(withLocation.has('happierLaunchInput')).toBe(false);

        // Omitted input is absent too; neither arm ever has a URL spelling.
        await screen.update(renderPage());
        const plain = frameQuery(screen);
        expect(plain.has('happierSubPath')).toBe(false);
        expect(plain.has('happierLaunchInput')).toBe(false);
    });

    it('RN-2: mounts a devHotReload source loadable from the projected dev-server URL', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const module = {
            renderSurface: () => React.createElement('PluginNativeSurface', { testID: 'plugin-native-surface' }),
        };
        const loadDevServerBundle = vi.fn(async () => module.renderSurface);
        const devUrl = 'http://127.0.0.1:8082/index.bundle?platform=ios&dev=true';
        const nativeCacheIdentity = {
            ...generatedReactNativeCacheIdentity,
            platform: 'ios',
        } as const;
        const nativeArtifactGraph = {
            ...generatedReactNativeArtifactGraph,
            platform: 'ios',
            builtWith: { bundler: 'repack', version: '5.0.0' },
            repack: defaultReactNativeModuleReference,
        } as const;
        const nativePlacement = Object.freeze({
            ...surfacePlacementFixture({
                binding: {
                    pluginId: 'acme.browser',
                    destinationId: 'native-dev-panel',
                    rendererId: 'native-panel',
                    container: 'rightPane',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                },
                renderer: { kind: 'reactNative', contributionId: 'native-panel' },
                display: { label: 'Native dev panel' },
                runtime: {
                    reactNativeCrashState: {
                        token: {
                            mount: {
                                kind: 'destination',
                                destination: { pluginId: 'acme.browser', localId: 'native-dev-panel' },
                            },
                            renderer: { pluginId: 'acme.browser', localId: 'native-panel' },
                            artifactDigest: nativeArtifactGraph.digest,
                            crashStateEpoch: 7,
                        },
                        disabled: false,
                    },
                },
            }),
            generatedV2: true,
        }) as unknown as PluginUiSurfacePlacementProjection;
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-dev-generation-44',
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
        });
        const devProjection = withMountedTargetPackage({
            ...generatedReactNativeProjection,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...generatedReactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    artifactGraph: nativeArtifactGraph,
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: {
                            source: 'devHotReload',
                            devUrl,
                            featureEnabled: true,
                            loaderBackendAvailable: true,
                        },
                        cacheKey: 'generated-native-dev-cache-key',
                        cacheIdentity: nativeCacheIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel, targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={nativePlacement}
                machineId="machine_1"
                serverId="server_1"
                sessionId="session_1"
                pluginUiProjection={devProjection}
                platform="ios"
                formFactor="tablet"
                reactNativeLoaderBackend={{
                    backendId: 'repackScriptManager',
                    available: true,
                    loadDevServerBundle,
                }}
            />,
            { flushOptions: { cycles: 0 } },
        );

        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

        const props = reactNativeSurfaceProps.at(-1) as {
            loadPolicy?: { source?: string; devUrl?: string };
            load?: () => Promise<unknown>;
        };
        expect(props.loadPolicy).toEqual(expect.objectContaining({ source: 'devHotReload', devUrl }));
        await expect(props.load?.()).resolves.toEqual(module);
        expect(loadDevServerBundle).toHaveBeenCalledWith({
            devUrl,
            pluginId: 'acme.browser',
            contributionId: 'native-panel',
            moduleReference: defaultReactNativeModuleReference,
        });
    });

    it('RN-2: does not build a dev load path for a denied devHotReload projection (no dev URL / fallback)', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-dev-denied-generation-44',
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
        });
        const deniedProjection = withMountedTargetPackage({
            ...generatedReactNativeProjection,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...generatedReactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    runtime: {
                        decision: { state: 'fallback', reason: 'channel_policy_denied', diagnostics: ['dev_hot_reload_denied'] },
                        loadPolicy: { source: 'devHotReload', featureEnabled: true, loaderBackendAvailable: true },
                        cacheKey: 'generated-native-dev-denied-cache-key',
                        cacheIdentity: generatedReactNativeCacheIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel, targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={generatedReactNativePlacement()}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={deniedProjection}
                platform="web"
            />,
        );

        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

        const props = reactNativeSurfaceProps.at(-1) as {
            decision?: { state?: string };
            load?: () => Promise<unknown>;
        };
        expect(props.decision?.state).toBe('fallback');
        expect(props.load).toBeUndefined();
    });

    it('keeps the declared RN renderer when its runtime is unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-runtime-unavailable-generation-44',
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
        });
        const projection = withMountedTargetPackage({
            ...generatedReactNativeProjection,
            hostedWebById: hostedWebProjection.hostedWebById,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...generatedReactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    runtime: {
                        decision: {
                            state: 'fallback',
                            reason: 'feature_disabled',
                            diagnostics: ['react_native_unavailable'],
                            fallback: { kind: 'hostedWeb', contributionId: 'panel' },
                        },
                        loadPolicy: {
                            source: 'installedArtifact',
                            featureEnabled: false,
                            loaderBackendAvailable: true,
                        },
                        cacheKey: 'generated-native-runtime-unavailable-cache-key',
                        cacheIdentity: generatedReactNativeCacheIdentity,
                    },
                },
            },
        } as unknown as PluginUiProjectionModel, targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...generatedReactNativePlacement(),
                    renderer: {
                        kind: 'reactNative',
                        contributionId: 'native-panel',
                        fallback: { kind: 'hostedWeb', contributionId: 'panel' },
                    },
                }}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                localServicePreviewState={createPreviewState()}
                platform="web"
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { postMessage: vi.fn() } }
                        : null
                ),
            },
        );

        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();
        expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
    });

    it('fails closed when the exact RN binding cannot install projected Host API requirements', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-required-host-method-generation-44',
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
        });
        const entry = generatedReactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'];
        const { hostApi: _legacyHostApi, ...entryWithoutLegacyHostApi } = entry;
        const malformedProjection = withMountedTargetPackage({
            ...generatedReactNativeProjection,
            reactNativeBundlesById: {
                ...generatedReactNativeProjection.reactNativeBundlesById,
                'reactNativeBundle:acme.browser:native-panel': {
                    ...entryWithoutLegacyHostApi,
                    requiredHostMethods: ['readResource'],
                },
            },
        } as unknown as PluginUiProjectionModel, targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...generatedReactNativePlacement(),
                    binding: generatedReactNativePlacement().binding,
                }}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={malformedProjection}
                platform="web"
                projectionInteractionEnabled={false}
            />,
        );

        // Required methods are admitted against the exact destination binding's
        // factual installed methods. The authoritative target snapshot is
        // present, but its noninteractive controller installs no `readResource`;
        // the missing historical contribution `hostApi` object cannot create a
        // legacy adapter or expand the live binding.
        await vi.waitFor(() => {
            expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-required_host_methods_unavailable')).toBeTruthy();
            expect(screen.getTextContent()).not.toContain('required_host_methods_unavailable');
        });
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
        expect(resourceReadMock).not.toHaveBeenCalled();
    });

    it('does not route ungenerated Project and Session bindings through the removed public RN context', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const placements = [
            surfacePlacementFixture({
                binding: {
                    pluginId: 'acme.browser',
                    destinationId: 'project-details',
                    rendererId: 'native-panel',
                    container: 'detailsTab',
                    target: { kind: 'project', workspaceRefIdPath: '/workspaceRefId' },
                },
                renderer: { kind: 'reactNative', contributionId: 'native-panel' },
                display: { label: 'Project details' },
            }),
            surfacePlacementFixture({
                binding: {
                    pluginId: 'acme.browser',
                    destinationId: 'session-bottom-panel',
                    rendererId: 'native-panel',
                    container: 'bottomPane',
                    target: { kind: 'session', sessionIdPath: '/session/id' },
                },
                renderer: { kind: 'reactNative', contributionId: 'native-panel' },
                display: { label: 'Session bottom panel' },
            }),
        ];

        for (const placement of placements) {
            reactNativeSurfaceProps.length = 0;
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={placement}
                    projectId="project-1"
                    sessionId="session-1"
                    pluginUiProjection={reactNativeProjection}
                    platform="desktop"
                />,
            );
            expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
            expect(reactNativeSurfaceProps).toHaveLength(0);
        }
    });

    it('refuses a descriptor that has no exact V2 binding instead of reviving a removed workspace target', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { binding: _binding, ...descriptorWithoutBinding } = browserReactNativePlacement;

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...descriptorWithoutBinding,
                    id: 'surfacePlacement:acme.browser:workspace-details',
                    descriptorId: 'workspace-details',
                    target: { kind: 'workspace' },
                } as never}
                pluginUiProjection={reactNativeProjection}
                platform="desktop"
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-destination_binding_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('destination_binding_unavailable');
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('refuses a normalized binding for a different renderer instead of mounting the descriptor renderer', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserReactNativePlacement,
                    binding: destinationBinding({
                        pluginId: 'acme.browser',
                        destinationId: 'native-panel',
                        rendererId: 'other-native-panel',
                        container: 'browserPanel',
                        target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
                    }),
                }}
                resourceBrowserTarget={target}
                pluginUiProjection={reactNativeProjection}
                platform="desktop"
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-destination_binding_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('destination_binding_unavailable');
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('admits desktop/tablet rows at a native tablet host while keeping native phones closed', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const tabletPlacement = surfacePlacementFixture({
            binding: {
                pluginId: 'acme.tablet',
                destinationId: 'tablet-panel',
                rendererId: 'tablet-renderer',
                container: 'rightPane',
                target: { kind: 'session', sessionIdPath: '/session/id' },
            },
            renderer: {
                kind: 'declarative',
                contributionId: 'tablet-renderer',
                model: {
                    identity: {
                        pluginId: 'acme.tablet',
                        localId: 'tablet-renderer',
                        qualifiedId: 'acme.tablet/tablet-renderer',
                        generation: 'tablet-generation',
                    },
                    visible: true,
                    requiredHostMethods: [],
                    nodes: [],
                    root: { kind: 'text', path: 'root', order: 0, text: 'Tablet panel' },
                },
            },
            display: { label: 'Tablet panel' },
        });
        const FormFactorPlacementHost = PluginSurfacePlacementHost as unknown as React.ComponentType<
            React.ComponentProps<typeof PluginSurfacePlacementHost> & Readonly<{
                formFactor: 'phone' | 'tablet';
            }>
        >;

        const tablet = await renderScreen(
            <FormFactorPlacementHost
                placement={tabletPlacement}
                sessionId="session-1"
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="ios"
                formFactor="tablet"
            />,
        );
        expect(tablet.findByTestId('plugin-surface-unavailable')).toBeNull();
        expect(tablet.getTextContent()).toContain('Tablet panel');

        const phone = await renderScreen(
            <FormFactorPlacementHost
                placement={tabletPlacement}
                sessionId="session-1"
                pluginUiProjection={EMPTY_PLUGIN_UI_PROJECTION}
                platform="ios"
                formFactor="phone"
            />,
        );
        expect(phone.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(phone.findByTestId('plugin-surface-unavailable-diagnostic-destination_platform_unavailable')).toBeTruthy();
        expect(phone.getTextContent()).not.toContain('destination_platform_unavailable');
    });

    it('refuses a supported destination when its binding excludes the current platform', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserReactNativePlacement,
                    // `browserPanel` normally supports web and desktop. This
                    // conservative producer subset admits only web, so a
                    // desktop mount must not infer the slot's wider default.
                    binding: {
                        ...browserReactNativePlacement.binding,
                        platforms: ['web'] as const,
                    },
                }}
                resourceBrowserTarget={target}
                pluginUiProjection={reactNativeProjection}
                platform="desktop"
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-destination_platform_unavailable')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('destination_platform_unavailable');
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('does not expose a binding method ceiling through an ungenerated public RN API', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={{
                    ...browserReactNativePlacement,
                    binding: browserReactNativePlacement.binding,
                }}
                resourceBrowserTarget={target}
                pluginUiProjection={reactNativeProjection}
                platform="web"
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);

    });

    it('does not retain an incumbent RN host for an ungenerated projection', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const render = () => (
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                pluginUiProjection={reactNativeProjection}
                platform="web"
            />
        );

        const screen = await renderScreen(render());
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);

        await screen.update(render());
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);

    });

});

/**
 * EU-3 gate rows 1 (exact context), 2 (semantic theme) and 3 (localization),
 * proven at the real React Native mount: the plugin's `RenderContext.surface` is
 * the observable, and the environment/theme/translation owners underneath it are
 * production code.
 */
describe('mounted plugin surface context (§3.2, §3.3, UI-D11/D12/D13)', () => {
    const generatedArtifactEntry = 'react-native/native-panel/index.js';
    const generatedArtifactBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
    const generatedIdentity = {
        ...reactNativeCacheIdentity,
        artifactDigest: PluginUiArtifactDigestV1Schema.parse('sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'),
        platform: 'web',
        projectionGeneration: 77,
    };
    const generatedFileDigest = 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    function createGeneratedProjection(
        overrides: Partial<PluginUiProjectionModel> = {},
    ): PluginUiProjectionModel {
        return {
            ...reactNativeProjection,
            generation: 77,
            reactNativeBundlesById: {
                'reactNativeBundle:acme.browser:native-panel': {
                    ...reactNativeProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel'],
                    generatedV2: true,
                    pluginVersion: '3.2.1',
                    artifactGraph: {
                        contributionId: 'native-panel-artifact',
                        tier: 'reactNative',
                        platform: 'web',
                        entry: generatedArtifactEntry,
                        files: [{
                            relativePath: generatedArtifactEntry,
                            digest: generatedFileDigest,
                            byteSize: generatedArtifactBytes.byteLength,
                        }],
                        digest: generatedIdentity.artifactDigest,
                        builtWith: { bundler: 'vite', version: '7.0.0' },
                        hostUiApiVersion: '1.0.0',
                        compat: { react: '19.2.0', reactNative: '0.83.4' },
                    },
                    hostApi: { minVersion: '1.0.0', methods: ['context', 'executeAction'] },
                    runtime: {
                        decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                        loadPolicy: { source: 'installedArtifact' },
                        cacheKey: 'generated-context-cache-key',
                        cacheIdentity: generatedIdentity,
                    },
                },
            },
            ...overrides,
        } as unknown as PluginUiProjectionModel;
    }

    async function primeGeneratedArtifact() {
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
            identity: generatedIdentity,
            bytes: generatedArtifactBytes,
            entryRelativePath: generatedArtifactEntry,
            format: 'plainJs',
            files: [{
                relativePath: generatedArtifactEntry,
                digest: generatedFileDigest,
                byteSize: generatedArtifactBytes.byteLength,
                bytes: generatedArtifactBytes,
            }],
        });
    }

    function readMountedSurface(): SurfaceContext {
        const props = reactNativeSurfaceProps.at(-1) as { renderContext?: { surface: SurfaceContext } };
        expect(props.renderContext, 'the generated placement must mount a canonical render context').toBeTruthy();
        return props.renderContext!.surface;
    }

    it('retires an app-page A current-UI command before the retained native host renders B', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();

        type PublishedRecord = Readonly<{
            entityLabel: string | undefined;
            commandIds: readonly string[];
        }>;
        let currentRecord: PublishedRecord | null = null;
        let activeMountOwner: number | null = null;
        let currentPublication: CurrentUiContextMountPublication | null = null;
        let nextMountOwner = 0;
        let nextCommandId = 0;
        const readCurrentRecord = (): PublishedRecord | null => currentRecord;
        const readCurrentPublication = (): CurrentUiContextMountPublication | null => currentPublication;
        currentUiContextMountPublisher.value = Object.freeze({
            createMount: vi.fn(() => {
                const owner = nextMountOwner;
                nextMountOwner += 1;
                let disposed = false;
                let publication!: CurrentUiContextMountPublication;
                const clear = vi.fn((): void => {
                    if (activeMountOwner !== owner) return;
                    activeMountOwner = null;
                    currentPublication = null;
                    currentRecord = null;
                });
                publication = Object.freeze({
                    publish: vi.fn((enrichment: CurrentUiContextMountedEnrichment | null): boolean => {
                        if (disposed) return false;
                        if (enrichment === null) {
                            clear();
                            return true;
                        }
                        if (activeMountOwner !== null && activeMountOwner !== owner) return false;
                        activeMountOwner = owner;
                        currentPublication = publication;
                        const commandIds = Object.freeze((enrichment.commands ?? []).map(() => {
                            nextCommandId += 1;
                            return `current-ui-command:${nextCommandId}`;
                        }));
                        currentRecord = Object.freeze({
                            entityLabel: enrichment.entity?.label,
                            commandIds,
                        });
                        return true;
                    }),
                    clear,
                    dispose: vi.fn((): void => {
                        if (disposed) return;
                        disposed = true;
                        clear();
                    }),
                });
                return publication;
            }),
        } satisfies CurrentUiContextMountPublisher);

        const enrichmentA = {
            entity: {
                kind: 'issue',
                label: 'Issue A',
                reference: { number: 1 },
            },
            commands: [{
                title: 'Open issue B',
                command: {
                    kind: 'openSurface',
                    destination: 'notes',
                    input: { issueNumber: 2 },
                },
            }],
        } satisfies Parameters<RenderContext['hostApi']['publishCurrentUiContext']>[0];
        const enrichmentB = {
            entity: {
                kind: 'issue',
                label: 'Issue B',
                reference: { number: 2 },
            },
        } satisfies Parameters<RenderContext['hostApi']['publishCurrentUiContext']>[0];
        let recordObservedDuringBLayout: PublishedRecord | null | undefined;
        let publishB: (() => void) | null = null;
        const readPublishB = (): (() => void) | null => publishB;
        const renderContexts: RenderContext[] = [];
        const CurrentUiContextProbe = (props: Readonly<{ context: RenderContext }>): React.ReactElement => {
            React.useLayoutEffect(() => {
                if (props.context.subPath === 'issues/a') {
                    props.context.hostApi.publishCurrentUiContext(enrichmentA);
                    return;
                }
                if (props.context.subPath === 'issues/b') {
                    recordObservedDuringBLayout = currentRecord;
                }
            }, [props.context.hostApi, props.context.subPath]);
            React.useEffect(() => {
                if (props.context.subPath !== 'issues/b') return;
                publishB = () => props.context.hostApi.publishCurrentUiContext(enrichmentB);
                return () => {
                    publishB = null;
                };
            }, [props.context.hostApi, props.context.subPath]);
            return React.createElement('View', { testID: `current-ui-context:${props.context.subPath ?? 'root'}` });
        };
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: (context: RenderContext) => {
                renderContexts.push(context);
                return React.createElement(CurrentUiContextProbe, { context });
            },
        });

        const basePlacement = generatedReactNativePlacement({
            crashState: generatedReactNativeCrashState({ destinationId: 'notes' }),
        });
        const appPagePlacement = Object.freeze({
            ...basePlacement,
            id: 'surfacePlacement:acme.browser:notes',
            descriptorId: 'notes',
            // App pages publish through the public Host API just like the
            // built-in surface contract declares. Keep the renderer's
            // admission declaration aligned with the generated bundle so the
            // real host path grants the method instead of exercising a
            // fixture-only omission.
            renderer: Object.freeze({
                ...basePlacement.renderer,
                requiredHostMethods: ['context', 'executeAction', 'publishCurrentUiContext'],
            }),
            // Do not mutate a normalized browser binding: its `targetKind`
            // remains browser even if its nested target record says app.
            // Re-enter the Registry normalizer so the app-page test uses the
            // same complete binding contract as production.
            binding: destinationBinding({
                pluginId: 'acme.browser',
                destinationId: 'notes',
                rendererId: 'native-panel',
                container: 'appPage' as const,
                target: Object.freeze({ kind: 'app' as const }),
            }),
        }) as PluginUiSurfacePlacementProjection;
        const generatedProjection = createGeneratedProjection();
        const projection = withExactGeneratedMountedTarget({
            projection: {
                ...generatedProjection,
                reactNativeBundlesById: {
                    ...generatedProjection.reactNativeBundlesById,
                    'reactNativeBundle:acme.browser:native-panel': {
                        ...generatedProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel']!,
                        hostApi: {
                            minVersion: '1.0.0',
                            methods: ['context', 'executeAction', 'publishCurrentUiContext'],
                        },
                    },
                },
            } as PluginUiProjectionModel,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-current-ui-location-generation-77',
            projectionGeneration: 77,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderPlacement = (subPath: string) => (
            <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                <PluginSurfacePlacementHost
                    placement={appPagePlacement}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    platform="web"
                    subPath={subPath}
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />
            </PluginSurfaceFocusEligibilityProvider>
        );
        const readLatestContext = (subPath: string): RenderContext => {
            const context = renderContexts.filter((entry) => entry.subPath === subPath).at(-1);
            if (!context) throw new Error(`Expected the native surface to render ${subPath}`);
            return context;
        };

        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(renderPlacement('issues/a'), { flushOptions: { cycles: 0 } });
            await vi.waitFor(() => expect(renderContexts.some((entry) => entry.subPath === 'issues/a')).toBe(true));
            const contextA = readLatestContext('issues/a');
            expect(contextA.hostApi.version().methods).toContain('publishCurrentUiContext');
            await vi.waitFor(() => expect(readCurrentRecord()?.entityLabel).toBe('Issue A'));
            const publicationA = readCurrentPublication();
            if (!publicationA) throw new Error('Expected A to own the current mount publication.');
            const commandA = readCurrentRecord()?.commandIds[0];
            if (!commandA) throw new Error('Expected A to publish its opaque command.');

            await screen.update(renderPlacement('issues/b'));
            await vi.waitFor(() => expect(renderContexts.some((entry) => entry.subPath === 'issues/b')).toBe(true));
            const contextB = readLatestContext('issues/b');

            // The physical RN adapter intentionally remains alive for a page
            // location update. Its semantic record must nevertheless be gone
            // before B's child layout effect is permitted to publish.
            expect(contextB.hostApi).toBe(contextA.hostApi);
            expect(contextB.signal).toBe(contextA.signal);
            expect(recordObservedDuringBLayout).toBeNull();
            expect(readCurrentRecord()).toBeNull();
            expect(readCurrentRecord()?.commandIds.includes(commandA) ?? false).toBe(false);
            expect(publicationA.clear).toHaveBeenCalledTimes(1);

            await vi.waitFor(() => expect(readPublishB()).not.toBeNull());
            const publishCurrentB = readPublishB();
            if (!publishCurrentB) throw new Error('Expected B to retain its normal delayed publication.');
            await act(async () => {
                publishCurrentB();
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(readCurrentRecord()?.entityLabel).toBe('Issue B'));
            expect(readCurrentPublication()).toBe(publicationA);
            expect(readCurrentRecord()?.commandIds.includes(commandA) ?? false).toBe(false);

            await screen.unmount();
            screen = undefined;
            expect(readCurrentRecord()).toBeNull();
            expect(publicationA.dispose).toHaveBeenCalledTimes(1);
        } finally {
            await screen?.unmount();
        }
    });

    it('keeps simultaneous native background and focus withdrawal provider-owned, then replays once on foreground', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const publishLabels: string[] = [];
        const observedActivities: boolean[] = [];
        const publicationClear = vi.fn();
        const publicationDispose = vi.fn();
        const publication = Object.freeze({
            publish: vi.fn((enrichment: CurrentUiContextMountedEnrichment | null): boolean => {
                if (enrichment === null) {
                    publicationClear();
                    return true;
                }
                publishLabels.push(enrichment.entity?.label ?? '');
                return true;
            }),
            clear: publicationClear,
            dispose: publicationDispose,
        }) satisfies CurrentUiContextMountPublication;
        currentUiContextMountPublisher.value = Object.freeze({
            createMount: vi.fn(() => publication),
        }) satisfies CurrentUiContextMountPublisher;
        const CurrentUiContextProbe = (props: Readonly<{ context: RenderContext }>): React.ReactElement => {
            observedActivities.push(props.context.activity?.active ?? false);
            React.useLayoutEffect(() => {
                props.context.hostApi.publishCurrentUiContext({
                    entity: { kind: 'issue', label: 'Issue A' },
                });
            }, [props.context.hostApi]);
            return React.createElement('View', { testID: 'current-ui-lifecycle-probe' });
        };
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: (context: RenderContext) => React.createElement(CurrentUiContextProbe, { context }),
        });
        const basePlacement = generatedReactNativePlacement({
            crashState: generatedReactNativeCrashState({ destinationId: 'notes' }),
        });
        const appPagePlacement = Object.freeze({
            ...basePlacement,
            id: 'surfacePlacement:acme.browser:notes',
            descriptorId: 'notes',
            renderer: Object.freeze({
                ...basePlacement.renderer,
                requiredHostMethods: ['context', 'executeAction', 'publishCurrentUiContext'],
            }),
            binding: destinationBinding({
                pluginId: 'acme.browser',
                destinationId: 'notes',
                rendererId: 'native-panel',
                container: 'appPage' as const,
                target: Object.freeze({ kind: 'app' as const }),
            }),
        }) as PluginUiSurfacePlacementProjection;
        const generatedProjection = createGeneratedProjection();
        const projection = withExactGeneratedMountedTarget({
            projection: {
                ...generatedProjection,
                reactNativeBundlesById: {
                    ...generatedProjection.reactNativeBundlesById,
                    'reactNativeBundle:acme.browser:native-panel': {
                        ...generatedProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel']!,
                        hostApi: {
                            minVersion: '1.0.0',
                            methods: ['context', 'executeAction', 'publishCurrentUiContext'],
                        },
                    },
                },
            } as PluginUiProjectionModel,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-current-ui-lifecycle-generation-77',
            projectionGeneration: 77,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const loaderBackend = Object.freeze({
            backendId: 'reactNativeWebModule',
            available: true,
            loadInstalledBundle: vi.fn(async () => () => null),
        });
        const renderPlacement = (focusEligible = true) => (
            <PluginSurfaceFocusEligibilityProvider
                active={focusEligible}
                currentUiContextActive={focusEligible}
            >
                <PluginSurfacePlacementHost
                    placement={appPagePlacement}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    platform="web"
                    subPath="issues/a"
                    reactNativeLoaderBackend={loaderBackend}
                />
            </PluginSurfaceFocusEligibilityProvider>
        );

        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
            await vi.waitFor(() => expect(publishLabels).toEqual(['Issue A']));
            expect(typeof observedActivities.at(-1)).toBe('boolean');
            expect(publicationClear).not.toHaveBeenCalled();

            currentUiContextMountLifecycle.active = false;
            await screen.update(renderPlacement(false));
            expect(publicationClear).not.toHaveBeenCalled();
            expect(publishLabels).toEqual(['Issue A']);
            expect(typeof observedActivities.at(-1)).toBe('boolean');

            currentUiContextMountLifecycle.active = true;
            await screen.update(renderPlacement(true));
            await vi.waitFor(() => expect(publishLabels).toEqual(['Issue A', 'Issue A']));
            expect(typeof observedActivities.at(-1)).toBe('boolean');
            expect(publicationClear).not.toHaveBeenCalled();
        } finally {
            await screen?.unmount();
        }
        expect(publicationDispose).toHaveBeenCalledTimes(1);
    });

    it('mounts the sole Host API React Native context only from its exact daemon-targeted snapshot', async () => {
        reactNativeSurfaceProps.length = 0;
        const mountedTarget = {
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-generation-42',
        } as const;
        const targetedContributions = {
            target: mountedTarget,
            points: [],
        } as const;
        contributionProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 77,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {},
                diagnostics: [],
            },
            targetedContributions,
        });
        const baseProjection = createGeneratedProjection({
            installedPackagesById: {
                'acme.browser': {
                    id: 'acme.browser',
                    displayName: 'Browser Inspector',
                    version: '3.2.1',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'acme.browser' },
                    immutableGenerationId: mountedTarget.immutableGenerationId,
                    brand: { state: 'missing' },
                },
            },
        });
        const projection = {
            ...baseProjection,
            reactNativeBundlesById: {
                ...baseProjection.reactNativeBundlesById,
                'reactNativeBundle:acme.browser:native-panel': {
                    ...baseProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel']!,
                    hostApi: { minVersion: '1.0.0', methods: ['context', 'executeAction'] },
                },
            },
        } as PluginUiProjectionModel;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
            // The target fetch is the subject of this test; let its bounded
            // microtask flush below settle before unrelated mounted effects.
            { flushOptions: { cycles: 0 } },
        );
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(contributionProjectionDescribeMock).toHaveBeenCalledWith('machine_1', expect.objectContaining({
            serverId: 'server_1',
            mountedTarget,
        }));
        expect(readMountedSurface().targetedContributions).toEqual(targetedContributions);
    });

    it('mounts a fresh all-daemons-offline process from the last-confirmed targeted admission in device custody', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const { prepareWarmCacheEncryptionKey } = await import('@/sync/domains/state/warmCacheEncryptionKey');
        await prepareWarmCacheEncryptionKey();
        const {
            forgetPluginUiProjectionAdmissionSnapshots,
            pluginUiProjectionAdmissionTargetKey,
            savePluginUiProjectionAdmissionSnapshot,
        } = await import('@/sync/domains/plugins/ui/projectionWarmCache');
        const { clearDaemonMergedProjectionCacheForTests } = await import(
            '@/agents/backendCatalog/loadDaemonMergedProjectionInputs'
        );
        const custodyScope = { serverId: 'server-a', accountId: 'account-a' };
        forgetPluginUiProjectionAdmissionSnapshots(custodyScope);

        const mountedTarget = {
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-cold-custody-generation-77',
        } as const;
        // A retained admission must be a positive fact: an empty point list is
        // valid live data but is never last-known-good offline authority, so
        // the custody fixture names one admitted point.
        const targetedContributions = PluginUiTargetedContributionsV1Schema.parse({
            target: mountedTarget,
            points: [{
                pointId: 'review-detail',
                protocols: [{
                    protocol: { id: 'review/detail', version: 1 },
                    contributions: [{
                        contributor: {
                            pluginId: 'acme.review',
                            contributionId: 'detail',
                            immutableGenerationId: 'review-generation-a',
                        },
                        protocol: { id: 'review/detail', version: 1 },
                        operations: [],
                        surfaces: [],
                    }],
                }],
            }],
        });
        const installedPackage = {
            id: 'acme.browser',
            displayName: 'Browser Inspector',
            version: '3.2.1',
            enabled: true,
            source: { kind: 'bundled', locator: 'acme.browser' },
            immutableGenerationId: mountedTarget.immutableGenerationId,
            brand: { state: 'missing' },
        } as const;
        // The exact daemon projection the machine-wide currentness owner
        // confirms, so the retained presentation slice is real bytes rather
        // than a hand-written custody record.
        const daemonProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 77,
            installedPackagesById: { 'acme.browser': installedPackage },
            familiesById: {
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        'translations:acme.browser': {
                            id: 'translations:acme.browser',
                            pluginId: 'acme.browser',
                            contributionKind: 'translations',
                            locales: ['en'],
                            bundles: { en: { title: 'Browser Inspector' } },
                        },
                    },
                },
            },
        });
        savePluginUiProjectionAdmissionSnapshot({
            scope: custodyScope,
            targetKey: pluginUiProjectionAdmissionTargetKey({
                serverId: 'server_1',
                machineId: 'machine_1',
            }),
            machineId: 'machine_1',
            projection: daemonProjection,
        });

        const projection = createGeneratedProjection({
            installedPackagesById: { 'acme.browser': installedPackage },
        }) as PluginUiProjectionModel;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderPlacement = () => (
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />
        );

        // Warm process: the one describe that confirms this exact target.
        contributionProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: daemonProjection,
            targetedContributions,
        });
        const warm = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(readMountedSurface().targetedContributions).toEqual(targetedContributions);
        await warm.unmount();

        // A genuinely fresh process re-parses these bytes with the canonical
        // entry schema before anything can restore them, so prove the persisted
        // shape survives that round trip and not only the in-process handoff.
        const {
            loadPluginUiProjectionWarmCacheEntries,
            PluginUiProjectionCacheEntryV1Schema,
        } = await import('@/sync/domains/state/warmCachePersistence');
        const persistedEntry = loadPluginUiProjectionWarmCacheEntries('server-a', 'account-a')[
            pluginUiProjectionAdmissionTargetKey({ serverId: 'server_1', machineId: 'machine_1' })
        ];
        const reparsedEntry = PluginUiProjectionCacheEntryV1Schema.safeParse(
            JSON.parse(JSON.stringify(persistedEntry)),
        );
        expect(reparsedEntry.success).toBe(true);
        expect(reparsedEntry.data?.targetedContributionsByPluginId?.['acme.browser'])
            .toEqual(targetedContributions);

        // Fresh process, laptop asleep: no in-memory target cache survives and
        // every daemon is unreachable, so the transport can only fail.
        clearDaemonMergedProjectionCacheForTests();
        reactNativeSurfaceProps.length = 0;
        pluginSurfaceConnectivity.endpointStatus = 'offline';
        pluginSurfaceConnectivity.machineOnline = false;
        contributionProjectionDescribeMock.mockReset();
        contributionProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'error' });

        const cold = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const coldSurface = readMountedSurface();
        expect(coldSurface.targetedContributions).toEqual(targetedContributions);
        const coldProps = reactNativeSurfaceProps.at(-1) as { interactionEnabled?: boolean };
        expect(coldProps.interactionEnabled).toBe(false);
        await cold.unmount();

        // The moment a daemon answers, its live snapshot supersedes custody.
        clearDaemonMergedProjectionCacheForTests();
        reactNativeSurfaceProps.length = 0;
        pluginSurfaceConnectivity.endpointStatus = 'online';
        pluginSurfaceConnectivity.machineOnline = true;
        // Structurally different from the retained admission, so the assertion
        // below distinguishes live authority from device custody.
        const liveTargetedContributions = PluginUiTargetedContributionsV1Schema.parse({
            target: mountedTarget,
            points: [{
                pointId: 'review-detail',
                protocols: [{
                    protocol: { id: 'review/detail', version: 1 },
                    contributions: [{
                        contributor: {
                            pluginId: 'acme.review',
                            contributionId: 'detail',
                            immutableGenerationId: 'review-generation-b',
                        },
                        protocol: { id: 'review/detail', version: 1 },
                        operations: [],
                        surfaces: [],
                    }],
                }],
            }],
        });
        contributionProjectionDescribeMock.mockReset();
        contributionProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: daemonProjection,
            targetedContributions: liveTargetedContributions,
        });
        const live = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(readMountedSurface().targetedContributions).toEqual(liveTargetedContributions);
        await live.unmount();

        // Falsification: the daemon now admits no points for this exact target.
        // The presentation slice and its exact generation stay retained, so the
        // only thing that can fail the following cold mount is refusing to keep
        // an empty target envelope as offline authority.
        clearDaemonMergedProjectionCacheForTests();
        reactNativeSurfaceProps.length = 0;
        contributionProjectionDescribeMock.mockReset();
        contributionProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: daemonProjection,
            targetedContributions: PluginUiTargetedContributionsV1Schema.parse({
                target: mountedTarget,
                points: [],
            }),
        });
        const emptiedWarm = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        await emptiedWarm.unmount();
        expect(loadPluginUiProjectionWarmCacheEntries('server-a', 'account-a')[
            pluginUiProjectionAdmissionTargetKey({ serverId: 'server_1', machineId: 'machine_1' })
        ]?.targetedContributionsByPluginId?.['acme.browser']).toBeUndefined();

        clearDaemonMergedProjectionCacheForTests();
        reactNativeSurfaceProps.length = 0;
        pluginSurfaceConnectivity.endpointStatus = 'offline';
        pluginSurfaceConnectivity.machineOnline = false;
        contributionProjectionDescribeMock.mockReset();
        contributionProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'error' });
        const emptyTarget = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(reactNativeSurfaceProps).toHaveLength(0);
        expect(emptyTarget.findByTestId(
            'plugin-surface-unavailable-diagnostic-targeted_contributions_unavailable',
        )).toBeTruthy();
        await emptyTarget.unmount();

        // Falsification: empty this Account's custody entirely and the same cold
        // process must fail closed instead of mounting an unproven target.
        clearDaemonMergedProjectionCacheForTests();
        reactNativeSurfaceProps.length = 0;
        forgetPluginUiProjectionAdmissionSnapshots(custodyScope);
        const emptied = await renderScreen(renderPlacement(), { flushOptions: { cycles: 0 } });
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(reactNativeSurfaceProps).toHaveLength(0);
        expect(emptied.findByTestId(
            'plugin-surface-unavailable-diagnostic-targeted_contributions_unavailable',
        )).toBeTruthy();
    });

    it('wires a parent React surface through the private exact B target bridge', async () => {
        reactNativeSurfaceProps.length = 0;
        const mountedTarget = Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-targeted-react-generation-77',
        });
        const surface = Object.freeze({
            point: Object.freeze({
                pointId: 'review-detail',
                protocol: Object.freeze({ id: 'review/detail', version: 1 }),
            }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'review-generation-b',
            }),
            role: 'detail',
            presentation: 'content' as const,
        } as const satisfies PluginUiTargetedContributionSurfaceV1);
        const targetedContributions = Object.freeze({
            target: mountedTarget,
            points: Object.freeze([Object.freeze({
                pointId: surface.point.pointId,
                protocols: Object.freeze([Object.freeze({
                    protocol: surface.point.protocol,
                    contributions: Object.freeze([Object.freeze({
                        contributor: surface.contributor,
                        protocol: surface.point.protocol,
                        operations: Object.freeze([]),
                        surfaces: Object.freeze([surface]),
                    })]),
                })]),
            })]),
        });
        const targetedMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: surface.point,
            contributor: surface.contributor,
            role: surface.role,
            presentation: surface.presentation,
            inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
            rendererChain: Object.freeze([Object.freeze({
                pluginId: surface.contributor.pluginId,
                localId: surface.contributor.contributionId,
            })]),
            selectedRenderer: Object.freeze({
                identity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    localId: surface.contributor.contributionId,
                }),
                    renderer: Object.freeze({
                        kind: 'declarative' as const,
                        contributionId: surface.contributor.contributionId,
                        model: Object.freeze({
                            visible: true,
                        identity: Object.freeze({
                            pluginId: surface.contributor.pluginId,
                                localId: surface.contributor.contributionId,
                                generation: '77',
                            }),
                            root: Object.freeze({
                                kind: 'targetedSurface',
                                path: 'root',
                                order: 0,
                                surface: Object.freeze({
                                    point: Object.freeze({
                                        pointId: 'nested-review-detail',
                                        protocol: Object.freeze({ id: 'review/nested-detail', version: 1 }),
                                    }),
                                    contributor: Object.freeze({
                                        pluginId: 'acme.nested-review',
                                        contributionId: 'nested-detail',
                                        immutableGenerationId: 'nested-generation-c',
                                    }),
                                    role: 'detail',
                                    presentation: 'content',
                                }),
                                input: Object.freeze({ reviewId: 'review-42' }),
                                instanceKey: `targeted-surface:v1:${'f'.repeat(64)}`,
                                fallback: Object.freeze({
                                    kind: 'state',
                                    path: 'root.fallback',
                                    order: 1,
                                    state: 'empty',
                                    title: 'Nested review unavailable',
                                }),
                            }),
                        }),
                    }),
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin('acme.review', 'machine_1', 'review-materialization-b'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    immutableGenerationId: surface.contributor.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const targetFixture = primeExactTargetedContributions({
            pluginId: mountedTarget.pluginId,
            immutableGenerationId: mountedTarget.immutableGenerationId,
            projectionGeneration: 77,
            targetedContributions,
            targetedSurfaceMounts: [targetedMount],
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');

        const parent = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => {
            expect(contributionProjectionDescribeMock).toHaveBeenCalledWith('machine_1', expect.objectContaining({
                serverId: 'server_1',
                mountedTarget: targetFixture.mountedTarget,
            }));
            expect(reactNativeSurfaceProps.at(-1)).toBeTruthy();
        });
        const props = reactNativeSurfaceProps.at(-1) as {
            privateHostBindings?: { presentationHost?: PluginUiPrivatePresentationHost };
        };
        const renderTargetedSurface = props.privateHostBindings?.presentationHost?.renderTargetedSurface;
        expect(renderTargetedSurface).toEqual(expect.any(Function));

        const rendered = renderTargetedSurface?.(Object.freeze({
            surface,
            input: Object.freeze({ reviewId: 'review-42' }),
            instanceKey: 'review-42',
        }));
        if (!React.isValidElement(rendered)) throw new Error('Expected the parent bridge to return its physical child.');
        expect(rendered.props).toMatchObject({
            presentation: {
                surface,
                input: { reviewId: 'review-42' },
                instanceKey: 'review-42',
            },
            mounts: [targetedMount],
            target: mountedTarget,
        });
        const child = await renderScreen(rendered);
        expect(child.findByTestId('plugin-surface-unavailable')).toBeNull();
        expect(child.findByTestId('plugin-declarative-surface-embedded-content')).toBeTruthy();
        expect(child.findByTestId('plugin-declarative-surface')).toBeNull();
        expect(child.findByTestId('plugin-declarative-state:root.fallback')).toBeTruthy();
        expect(child.getTextContent()).toContain('Nested review unavailable');
        await vi.waitFor(() => expect(pluginSurfaceDiagnosticLog).toHaveBeenCalledWith(
            expect.stringContaining('"code":"unsupported_nested_targeted_surface"'),
        ));
        await child.unmount();
        await parent.unmount();
    });

    it('contains a throwing declarative B at its caller fallback without charging A\'s RN crash state', async () => {
        reactNativeSurfaceProps.length = 0;
        const mountedTarget = Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-targeted-crash-generation-77',
        });
        // The app receives the structural Protocol identity after the public
        // nominal author edge (covered by the SDK authoring-inference fixture).
        const surface = Object.freeze({
            point: Object.freeze({
                pointId: 'review-detail',
                protocol: Object.freeze({ id: 'review/detail', version: 1 }),
            }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'review-generation-b',
            }),
            role: 'detail',
            presentation: 'content' as const,
        } as const satisfies PluginUiTargetedContributionSurfaceV1);
        const targetedContributions = Object.freeze({
            target: mountedTarget,
            points: Object.freeze([Object.freeze({
                pointId: surface.point.pointId,
                protocols: Object.freeze([Object.freeze({
                    protocol: surface.point.protocol,
                    contributions: Object.freeze([Object.freeze({
                        contributor: surface.contributor,
                        protocol: surface.point.protocol,
                        operations: Object.freeze([]),
                        surfaces: Object.freeze([surface]),
                    })]),
                })]),
            })]),
        });
        const validTargetedMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: surface.point,
            contributor: surface.contributor,
            role: surface.role,
            presentation: surface.presentation,
            inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
            rendererChain: Object.freeze([Object.freeze({
                pluginId: surface.contributor.pluginId,
                localId: surface.contributor.contributionId,
            })]),
            selectedRenderer: Object.freeze({
                identity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    localId: surface.contributor.contributionId,
                }),
                renderer: Object.freeze({
                    kind: 'declarative' as const,
                    contributionId: surface.contributor.contributionId,
                    model: Object.freeze({
                        visible: true,
                        identity: Object.freeze({
                            pluginId: surface.contributor.pluginId,
                            localId: surface.contributor.contributionId,
                            generation: '77',
                        }),
                        root: Object.freeze({
                            kind: 'state',
                            path: 'root',
                            order: 0,
                            state: 'empty',
                            title: 'Review detail',
                        }),
                    }),
                }),
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin('acme.review', 'machine_1', 'review-materialization-b'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    immutableGenerationId: surface.contributor.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const validRenderer = validTargetedMount.selectedRenderer.renderer;
        if (validRenderer.kind !== 'declarative') {
            throw new Error('The target-child fixture must use the declarative renderer.');
        }
        const validModel = validRenderer.model as Readonly<Record<string, unknown>>;
        const validRoot = validModel.root as Readonly<Record<string, unknown>>;
        const throwingTitle = Object.create(null) as Readonly<Record<string, unknown>>;
        let targetedRenderShouldFail = true;
        // Fault injection stays inside the real declarative renderer: it models
        // a renderer defect without replacing the target bridge or B mount.
        Object.defineProperty(throwingTitle, 'fallback', {
            enumerable: true,
            get(): string {
                if (targetedRenderShouldFail) {
                    throw new Error('targeted_declarative_render_failure');
                }
                return 'Recovered review detail';
            },
        });
        const throwingTargetedMount = Object.freeze({
            ...validTargetedMount,
            selectedRenderer: Object.freeze({
                ...validTargetedMount.selectedRenderer,
                renderer: Object.freeze({
                    ...validRenderer,
                    model: Object.freeze({
                        ...validModel,
                        root: Object.freeze({ ...validRoot, title: throwingTitle }),
                    }),
                }),
            }),
        }) satisfies DaemonPluginUiTargetedSurfaceMountV1;
        const targetFixture = primeExactTargetedContributions({
            pluginId: mountedTarget.pluginId,
            immutableGenerationId: mountedTarget.immutableGenerationId,
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
            targetedContributions,
            targetedSurfaceMounts: [throwingTargetedMount],
        });
        const projection = withMountedTargetPackage(generatedReactNativeProjection, targetFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        reactNativeCrashReports.submit.mockResolvedValue({
            ok: true,
            token: generatedReactNativeCrashState().token,
            disabled: false,
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let child: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let omittedFallbackChild: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let nullFallbackChild: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={generatedReactNativePlacement()}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />,
                { flushOptions: { cycles: 0 } },
            );

            await vi.waitFor(() => {
                expect(reactNativeSurfaceProps.at(-1)).toBeTruthy();
            });
            const props = reactNativeSurfaceProps.at(-1) as {
                privateHostBindings?: { presentationHost?: PluginUiPrivatePresentationHost };
            };
            const renderTargetedSurface = props.privateHostBindings?.presentationHost?.renderTargetedSurface;
            expect(renderTargetedSurface).toEqual(expect.any(Function));
            const rendered = renderTargetedSurface?.(Object.freeze({
                surface,
                input: Object.freeze({ reviewId: 'review-42' }),
                instanceKey: 'review-42',
                fallback: React.createElement('View', { testID: 'targeted-crash-fallback' }),
            }));
            if (!React.isValidElement(rendered)) {
                throw new Error('Expected the app-private target bridge to return its physical child.');
            }
            child = await renderScreen(React.createElement(
                'View',
                { testID: 'targeted-crash-target-shell' },
                rendered,
            ));

            await vi.waitFor(() => {
                expect(
                    child?.findByTestId('targeted-crash-target-shell'),
                    JSON.stringify(child?.tree.toJSON()),
                ).toBeTruthy();
                expect(child?.findByTestId('targeted-crash-fallback')).toBeTruthy();
            });
            expect(screen?.findByTestId('plugin-rn-ui-unavailable')).toBeNull();
            expect(reactNativeCrashReports.submit).not.toHaveBeenCalled();
            const targetedSurfaceId = `targeted:${derivePluginUiTargetedSurfaceMountInstanceKeyV1({
                targetPluginId: mountedTarget.pluginId,
                surface,
                rawInstanceKey: 'review-42',
            })}`;
            await vi.waitFor(() => expect(pluginSurfaceDiagnosticLog).toHaveBeenCalledTimes(1));
            const diagnosticLog = pluginSurfaceDiagnosticLog.mock.calls[0]?.[0];
            expect(typeof diagnosticLog).toBe('string');
            const diagnosticRecord = JSON.parse(
                (diagnosticLog as string).replace('[plugin-ui-host-api] ', ''),
            ) as {
                pluginId?: unknown;
                contributionId?: unknown;
                surfaceId?: unknown;
                diagnostic?: unknown;
            };
            expect(diagnosticRecord).toMatchObject({
                pluginId: 'acme.review',
                contributionId: 'detail',
                surfaceId: targetedSurfaceId,
                diagnostic: {
                    code: 'targeted_surface_render_failure',
                    severity: 'error',
                    details: {
                        contributor: surface.contributor,
                        targetedSurfaceId,
                    },
                },
            });
            expect(diagnosticRecord.diagnostic).not.toHaveProperty('message');
            expect(JSON.stringify(diagnosticRecord)).not.toContain('targeted_declarative_render_failure');

            // A refresh of the same caller entry replaces launch input without
            // remounting it. The B boundary must retry its contained renderer
            // rather than retaining the prior caller fallback.
            targetedRenderShouldFail = false;
            const recovered = renderTargetedSurface?.(Object.freeze({
                surface,
                input: Object.freeze({ reviewId: 'review-43' }),
                instanceKey: 'review-42',
                fallback: React.createElement('View', { testID: 'targeted-crash-fallback' }),
            }));
            if (!React.isValidElement(recovered)) {
                throw new Error('Expected the app-private target bridge to return its physical child.');
            }
            await child.update(React.createElement(
                'View',
                { testID: 'targeted-crash-target-shell' },
                recovered,
            ));
            await vi.waitFor(() => {
                expect(child?.findByTestId('targeted-crash-fallback')).toBeNull();
                expect(child?.findByTestId('plugin-declarative-state:root')).toBeTruthy();
            });

            targetedRenderShouldFail = true;
            const renderedWithoutFallback = renderTargetedSurface?.(Object.freeze({
                surface,
                input: Object.freeze({ reviewId: 'review-43' }),
                instanceKey: 'review-43',
            }));
            if (!React.isValidElement(renderedWithoutFallback)) {
                throw new Error('Expected the app-private target bridge to return its physical child.');
            }
            omittedFallbackChild = await renderScreen(React.createElement(
                'View',
                { testID: 'targeted-crash-omitted-fallback-shell' },
                renderedWithoutFallback,
            ));
            await vi.waitFor(() => {
                expect(
                    omittedFallbackChild?.findByTestId('plugin-rn-ui-unavailable'),
                    JSON.stringify(omittedFallbackChild?.tree.toJSON()),
                ).toBeTruthy();
            });
            expect(omittedFallbackChild.findByTestId('targeted-crash-fallback')).toBeNull();

            // An explicit `null` fallback is the author saying "render nothing
            // here", which is a different statement from omitting the prop.
            // The physical host must not collapse it into the generic
            // unavailable presentation.
            const renderedWithNullFallback = renderTargetedSurface?.(Object.freeze({
                surface,
                input: Object.freeze({ reviewId: 'review-44' }),
                instanceKey: 'review-44',
                fallback: null,
            }));
            if (!React.isValidElement(renderedWithNullFallback)) {
                throw new Error('Expected the app-private target bridge to return its physical child.');
            }
            nullFallbackChild = await renderScreen(React.createElement(
                'View',
                { testID: 'targeted-crash-null-fallback-shell' },
                renderedWithNullFallback,
            ));
            await vi.waitFor(() => {
                expect(
                    nullFallbackChild?.findByTestId('targeted-crash-null-fallback-shell'),
                    JSON.stringify(nullFallbackChild?.tree.toJSON()),
                ).toBeTruthy();
            });
            expect(
                nullFallbackChild.findByTestId('plugin-rn-ui-unavailable'),
                JSON.stringify(nullFallbackChild.tree.toJSON()),
            ).toBeNull();
            expect(nullFallbackChild.findByTestId('targeted-crash-fallback')).toBeNull();
        } finally {
            await nullFallbackChild?.unmount();
            await omittedFallbackChild?.unmount();
            await child?.unmount();
            await screen?.unmount();
            consoleError.mockRestore();
        }
    });

    it('uses the renderer-owned declared fallback when the exact B renderer is unavailable', async () => {
        reactNativeSurfaceProps.length = 0;
        const mountedTarget = Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-targeted-fallback-generation-77',
        });
        const surface = Object.freeze({
            point: Object.freeze({
                pointId: 'review-detail',
                protocol: Object.freeze({ id: 'review/detail', version: 1 }),
            }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'review-generation-b',
            }),
            role: 'detail',
            presentation: 'content' as const,
        } as const satisfies PluginUiTargetedContributionSurfaceV1);
        const blockedMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: surface.point,
            contributor: surface.contributor,
            role: surface.role,
            presentation: surface.presentation,
            inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
            rendererChain: Object.freeze([Object.freeze({
                pluginId: surface.contributor.pluginId,
                localId: surface.contributor.contributionId,
            })]),
            selectedRenderer: Object.freeze({
                identity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    localId: surface.contributor.contributionId,
                }),
                renderer: Object.freeze({
                    kind: 'declarative' as const,
                    contributionId: surface.contributor.contributionId,
                }),
                availability: Object.freeze({
                    state: 'fallback' as const,
                    reason: 'contributor_unavailable',
                    diagnostics: Object.freeze(['contributor_unavailable']),
                }),
            }),
            executionOrigin: mountedExecutionOrigin('acme.review', 'machine_1', 'review-materialization-b'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    immutableGenerationId: surface.contributor.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const inputValidation = preparePluginJsonSchema(blockedMount.inputSchema);
        const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(inputValidation.jsonSchema);
        if (!inputNormalizer) throw new Error('Expected canonical Surface schema to rehydrate');
        const preparedBlockedMount = Object.freeze({
            ...blockedMount,
            inputSchema: inputValidation.jsonSchema,
            inputValidation,
            inputNormalizer,
        });
        const request = Object.freeze({
            mount: Object.freeze({
                kind: 'targetedSurface' as const,
                mount: preparedBlockedMount,
                renderer: preparedBlockedMount.selectedRenderer.renderer,
            }),
            input: Object.freeze({ reviewId: 'review-42' }),
            instanceKey: derivePluginUiTargetedSurfaceMountInstanceKeyV1({
                targetPluginId: mountedTarget.pluginId,
                surface,
                rawInstanceKey: 'review-fallback',
            }),
            fallback: React.createElement('TargetedDeclaredFallback', {
                testID: 'targeted-declared-fallback',
            }),
        }) satisfies TargetedPluginSurfaceMountRequest;
        const targetedMount = {
            request,
            physicalTarget: Object.freeze({ kind: 'browser' as const, targetId: 'browser-target-fallback' }),
            parentLifetime: Object.freeze({
                isCurrent: () => true,
                onRetire: () => Object.freeze({ dispose() {} }),
            }),
            projectionGeneration: 77,
            pluginProjectionById: Object.freeze({}),
            pluginProjectionV2: null,
            daemonProjectionReady: true,
        } satisfies PluginSurfaceTargetedMountProps;
        const { PluginSurfaceHost } = await import('./PluginSurfaceHost');
        const onPress = vi.fn();
        const props = {
            targetedMount,
            serverId: 'server_1',
            platform: 'web' as const,
            channel: 'internal' as const,
            unavailableAction: { label: 'Manage plugin', onPress },
        } as React.ComponentProps<typeof PluginSurfaceHost> & Readonly<{
            unavailableAction: Readonly<{ label: string; onPress: () => void }>;
        }>;
        const screen = await renderScreen(
            <PluginSurfaceHost {...props} />,
        );

        expect(screen.findByTestId('targeted-declared-fallback')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
        expect(onPress).not.toHaveBeenCalled();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('keeps B caller fallback through its issued generated V2 Artifact frame without borrowing the parent projection', async () => {
        reactNativeSurfaceProps.length = 0;
        const mountedTarget = Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-targeted-hosted-generation-77',
        });
        const surface = Object.freeze({
            point: Object.freeze({
                pointId: 'review-detail',
                protocol: Object.freeze({ id: 'review/detail', version: 1 }),
            }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'review-generation-b',
            }),
            role: 'detail',
            presentation: 'content' as const,
        });
        const targetedContributions = Object.freeze({
            target: mountedTarget,
            points: Object.freeze([Object.freeze({
                pointId: surface.point.pointId,
                protocols: Object.freeze([Object.freeze({
                    protocol: surface.point.protocol,
                    contributions: Object.freeze([Object.freeze({
                        contributor: surface.contributor,
                        protocol: surface.point.protocol,
                        operations: Object.freeze([]),
                        surfaces: Object.freeze([surface]),
                    })]),
                })]),
            })]),
        });
        const artifactDigest = `sha256:${'d'.repeat(64)}`;
        const artifactGraph = Object.freeze({
            contributionId: surface.contributor.contributionId,
            tier: 'hostedWeb' as const,
            platform: 'web' as const,
            entry: 'hosted-web/review/index.html',
            files: Object.freeze([Object.freeze({
                relativePath: 'hosted-web/review/index.html',
                digest: `sha256:${'e'.repeat(64)}`,
                byteSize: 16,
            })]),
            digest: artifactDigest,
            builtWith: Object.freeze({ bundler: 'vite' as const, version: '7.0.0' }),
            hostUiApiVersion: '1.0.0',
            compat: Object.freeze({}),
        });
        const artifactProjection = Object.freeze({
            id: 'hostedWeb:acme.review:detail',
            pluginId: surface.contributor.pluginId,
            contributionKind: 'hostedWeb',
            contributionId: surface.contributor.contributionId,
            generatedV2: true,
            pluginVersion: '3.2.1',
            artifactGraph,
            service: Object.freeze({ kind: 'staticAssets', assetRootId: 'hosted-web/review' }),
            runtimeMode: Object.freeze({
                kind: 'installedStaticAssets',
                artifactId: 'review-static',
                assetRootId: 'hosted-web/review',
            }),
            entry: Object.freeze({ routeMode: 'pathFallback', path: '/' }),
            bridge: Object.freeze({ allowedMessages: Object.freeze(['hostApi']) }),
            sandbox: Object.freeze({ scripts: true }),
            security: Object.freeze({
                allowedNavigationOrigins: Object.freeze([]),
                allowedCallbackOrigins: Object.freeze([]),
                allowedConnectOrigins: Object.freeze([]),
                csp: Object.freeze({
                    connectSrc: 'selfOnly',
                    allowDataUrls: false,
                    allowBlobUrls: false,
                    allowInlineStyles: false,
                    allowEval: false,
                }),
                sourceMaps: 'disabled',
                mixedContent: 'devLoopbackOnly',
            }),
            runtime: Object.freeze({
                state: 'fallback',
                diagnostics: Object.freeze(['hosted_web_frame_adapter_unavailable']),
                decision: Object.freeze({
                    state: 'fallback',
                    reason: 'hosted_web_frame_adapter_unavailable',
                    diagnostics: Object.freeze(['hosted_web_frame_adapter_unavailable']),
                }),
                artifactReadIdentity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    contributionId: surface.contributor.contributionId,
                    artifactDigest,
                    platform: 'web' as const,
                    projectionGeneration: 77,
                }),
            }),
        });
        const targetedMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: surface.point,
            contributor: surface.contributor,
            role: surface.role,
            presentation: surface.presentation,
            inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
            rendererChain: Object.freeze([Object.freeze({
                pluginId: surface.contributor.pluginId,
                localId: surface.contributor.contributionId,
            })]),
            selectedRenderer: Object.freeze({
                identity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    localId: surface.contributor.contributionId,
                }),
                renderer: Object.freeze({
                    kind: 'hostedWeb' as const,
                    contributionId: surface.contributor.contributionId,
                    source: Object.freeze({
                        kind: 'artifact' as const,
                        artifact: surface.contributor.contributionId,
                    }),
                    requiredHostMethods: Object.freeze([]),
                }),
                artifactProjection,
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin('acme.review', 'machine_1', 'review-materialization-b'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    immutableGenerationId: surface.contributor.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const targetFixture = primeExactTargetedContributions({
            pluginId: mountedTarget.pluginId,
            immutableGenerationId: mountedTarget.immutableGenerationId,
            projectionGeneration: 77,
            targetedContributions,
            targetedSurfaceMounts: [targetedMount],
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const issuedCapability = 'hwb1.review-targeted.signature';
        const issuedUrl = `https://artifacts.happier.test/v1/plugins/availability/ui-artifacts/browser/${issuedCapability}/`;
        const expiresAt = Date.now() + 60_000;
        const releaseVersion = artifactProjection.pluginVersion;
        activePluginAvailability.reader = createPluginAccountAvailabilityReader({
            scope: { serverId: 'server-a', accountId: 'account-a' },
            snapshot: {
                availabilityCursor: 1,
                materializations: [],
                snapshots: [],
                intentReads: [{
                    pluginId: surface.contributor.pluginId,
                    response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                        availabilityCursor: 1,
                        hostingCapability: {
                            enabled: true,
                            maxArtifactBytes: 1024,
                            maxAccountBytes: 2048,
                        },
                        intent: {
                            pluginId: surface.contributor.pluginId,
                            desiredVersion: releaseVersion,
                            enabled: true,
                            offlineUiHosting: 'enabled',
                            writableCollections: [],
                            revision: 'intent-review-hosted-1',
                        },
                        release: {
                            ref: { pluginId: surface.contributor.pluginId, version: releaseVersion },
                            archiveDigestSha256: `sha256:${'f'.repeat(64)}`,
                            normalizedManifest: PluginPortableReleaseManifestV1Schema.parse({
                                schemaVersion: 2,
                                id: surface.contributor.pluginId,
                                version: releaseVersion,
                                displayName: 'Review',
                                engines: { happier: '^1.0.0' },
                                runtime: { apiVersion: 1 },
                                contributes: {},
                            }),
                            collectionContracts: [],
                            uiSlots: [{
                                contributionId: artifactGraph.contributionId,
                                tier: artifactGraph.tier,
                                platform: artifactGraph.platform,
                                artifactDigest: artifactGraph.digest,
                                compatibility: {
                                    hostUiApiVersion: artifactGraph.hostUiApiVersion,
                                },
                            }],
                            packageAssetArchive: {
                                archiveDigestSha256: `sha256:${'f'.repeat(64)}`,
                                resources: [],
                            },
                        },
                        uiArtifacts: [{
                            release: { pluginId: surface.contributor.pluginId, version: releaseVersion },
                            contributionId: artifactGraph.contributionId,
                            tier: artifactGraph.tier,
                            platform: artifactGraph.platform,
                            artifactId: '00000000-0000-4000-8000-000000000077',
                            artifactDigest: artifactGraph.digest,
                            compatibility: {
                                hostAppVersion: '1.0.0',
                                hostUiApiVersion: artifactGraph.hostUiApiVersion,
                                platform: artifactGraph.platform,
                                channel: 'internal',
                                nativeCapabilities: [],
                            },
                        }],
                    }),
                }],
            } satisfies PluginAccountAvailabilitySnapshot,
        });
        pluginDataTransport.enabled = true;
        pluginDataTransport.request.mockImplementation(async (path: string) => {
            if (path !== PluginAvailabilityActionHttpPathsV1[
                'account.plugins.availability.uiArtifact.browserFrame.issue'
            ]) {
                throw new Error(`Unexpected browser Artifact path: ${path}`);
            }
            return new Response(JSON.stringify({ url: issuedUrl, expiresAt }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const parent = await renderScreen(
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server-a"
                sessionId="session_1"
                pluginUiProjection={projection}
                localServicePreviewState={createLocalServicePreviewState()}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
            { flushOptions: { cycles: 0 } },
        );
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const parentProps = reactNativeSurfaceProps.at(-1) as {
            privateHostBindings?: { presentationHost?: PluginUiPrivatePresentationHost };
        };
        const renderTargetedSurface = parentProps.privateHostBindings?.presentationHost?.renderTargetedSurface;
        const rendered = renderTargetedSurface?.(Object.freeze({
            surface,
            input: Object.freeze({ reviewId: 'review-hosted-42' }),
            instanceKey: 'review-hosted-42',
            fallback: React.createElement('TargetedHostedFallback', {
                testID: 'targeted-hosted-ready-timeout-fallback',
            }),
        }));
        if (!React.isValidElement(rendered)) throw new Error('Expected the parent bridge to return its physical child.');

        const locationScope = globalThis as unknown as { location?: unknown };
        const previousLocation = locationScope.location;
        locationScope.location = {
            origin: 'https://host.happier.test',
        };
        vi.useFakeTimers();
        let child: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            child = await renderScreen(rendered, {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: { postMessage: vi.fn() } }
                        : null
                ),
            });
            await flushHookEffects({ cycles: 6 });
            expect(child.root.findAllByType('iframe')).toHaveLength(1);
            expect(pluginDataTransport.request).toHaveBeenCalledTimes(1);
            const [path, init] = pluginDataTransport.request.mock.calls[0]!;
            expect(path).toBe(PluginAvailabilityActionHttpPathsV1[
                'account.plugins.availability.uiArtifact.browserFrame.issue'
            ]);
            expect(JSON.parse(String(init?.body))).toEqual({
                release: { pluginId: surface.contributor.pluginId, version: releaseVersion },
                contributionId: artifactGraph.contributionId,
                tier: artifactGraph.tier,
                platform: artifactGraph.platform,
                expectedArtifactDigest: artifactGraph.digest,
            });
            const frame = child.findByType('iframe');
            const src = new URL(String(frame?.props.src ?? 'https://unused.test/'));
            const instanceKey = derivePluginUiTargetedSurfaceMountInstanceKeyV1({
                targetPluginId: mountedTarget.pluginId,
                surface,
                rawInstanceKey: 'review-hosted-42',
            });
            expect(src.origin).toBe('https://artifacts.happier.test');
            expect(src.pathname).toBe(`/v1/plugins/availability/ui-artifacts/browser/${issuedCapability}/`);
            expect(src.searchParams.get('happierPluginId')).toBe(surface.contributor.pluginId);
            expect(src.searchParams.get('happierContributionId')).toBe(surface.contributor.contributionId);
            expect(src.searchParams.get('happierSurfaceId')).toBe(`targeted:${instanceKey}`);
            await act(async () => {
                await vi.advanceTimersByTimeAsync(30_000);
            });
            expect(
                child.findByTestId('targeted-hosted-ready-timeout-fallback'),
                JSON.stringify(child.tree.toJSON()),
            ).toBeTruthy();
            expect(child.findByTestId('plugin-hosted-web-unavailable')).toBeNull();
            expect(child.findByTestId('plugin-hosted-web-frame')).toBeNull();
            expect(parent.findByTestId('plugin-react-native-surface-proxy')).toBeTruthy();
        } finally {
            await child?.unmount();
            vi.useRealTimers();
            locationScope.location = previousLocation;
            await parent.unmount();
        }
    });

    it('physically mounts B React Native with its exact artifact, crash fence, input key, and Resource context', async () => {
        reactNativeSurfaceProps.length = 0;
        resourceReadMock.mockClear();
        const currentUiPublishAttempts: string[] = [];
        let currentUiOwner: number | null = null;
        let currentUiEntityLabel: string | undefined;
        let nextCurrentUiOwner = 0;
        currentUiContextMountPublisher.value = Object.freeze({
            createMount: () => {
                const owner = nextCurrentUiOwner;
                nextCurrentUiOwner += 1;
                let disposed = false;
                const clear = (): void => {
                    if (currentUiOwner !== owner) return;
                    currentUiOwner = null;
                    currentUiEntityLabel = undefined;
                };
                return Object.freeze({
                    publish(enrichment: CurrentUiContextMountedEnrichment | null): boolean {
                        if (disposed) return false;
                        if (enrichment === null) {
                            clear();
                            return true;
                        }
                        const label = enrichment.entity?.label ?? '';
                        currentUiPublishAttempts.push(label);
                        if (currentUiOwner !== null && currentUiOwner !== owner) return false;
                        currentUiOwner = owner;
                        currentUiEntityLabel = label;
                        return true;
                    },
                    clear,
                    dispose(): void {
                        if (disposed) return;
                        disposed = true;
                        clear();
                    },
                } satisfies CurrentUiContextMountPublication);
            },
        } satisfies CurrentUiContextMountPublisher);
        const CurrentUiContextProbe = (props: Readonly<{ context: RenderContext }>): React.ReactElement => {
            React.useLayoutEffect(() => {
                props.context.hostApi.publishCurrentUiContext({
                    entity: {
                        kind: 'issue',
                        label: props.context.plugin.id === 'acme.browser'
                            ? 'Parent issue'
                            : 'Nested review',
                    },
                });
            }, [props.context.hostApi, props.context.plugin.id]);
            return React.createElement('View', { testID: `current-ui-probe:${props.context.plugin.id}` });
        };
        reactNativeSurfaceRuntime.enabled = true;
        reactNativeSurfaceRuntime.module = Object.freeze({
            renderSurface: (context: RenderContext) => React.createElement(CurrentUiContextProbe, { context }),
        });
        const mountedTarget = Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-targeted-native-generation-77',
        });
        const surface = Object.freeze({
            point: Object.freeze({
                pointId: 'review-detail',
                protocol: Object.freeze({ id: 'review/detail', version: 1 }),
            }),
            contributor: Object.freeze({
                pluginId: 'acme.review',
                contributionId: 'detail',
                immutableGenerationId: 'review-generation-b',
            }),
            role: 'detail',
            presentation: 'fill' as const,
        });
        const targetedContributions = Object.freeze({
            target: mountedTarget,
            points: Object.freeze([Object.freeze({
                pointId: surface.point.pointId,
                protocols: Object.freeze([Object.freeze({
                    protocol: surface.point.protocol,
                    contributions: Object.freeze([Object.freeze({
                        contributor: surface.contributor,
                        protocol: surface.point.protocol,
                        operations: Object.freeze([]),
                        surfaces: Object.freeze([surface]),
                    })]),
                })]),
            })]),
        });
        const artifactDigest = PluginUiArtifactDigestV1Schema.parse(
            `sha256:${'b'.repeat(64)}`,
        );
        const artifactProjection = Object.freeze({
            id: 'reactNativeBundle:acme.review:detail',
            pluginId: surface.contributor.pluginId,
            contributionKind: 'reactNativeBundle',
            contributionId: surface.contributor.contributionId,
            generatedV2: true,
            pluginVersion: '4.0.0',
            artifactGraph: Object.freeze({
                contributionId: surface.contributor.contributionId,
                tier: 'reactNative' as const,
                platform: 'web' as const,
                entry: 'react-native/review/index.js',
                files: Object.freeze([Object.freeze({
                    relativePath: 'react-native/review/index.js',
                    digest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'c'.repeat(64)}`),
                    byteSize: 16,
                })]),
                digest: artifactDigest,
                builtWith: Object.freeze({ bundler: 'vite' as const, version: '7.0.0' }),
                hostUiApiVersion: '1.0.0',
                compat: Object.freeze({ react: '19.2.0', reactNative: '0.83.4' }),
            }),
            hostApi: Object.freeze({
                minVersion: '1.0.0',
                methods: Object.freeze(['context', 'readResource', 'publishCurrentUiContext']),
            }),
            runtime: Object.freeze({
                decision: Object.freeze({ state: 'load', reason: 'compatible', diagnostics: Object.freeze([]) }),
                loadPolicy: Object.freeze({ source: 'installedArtifact' }),
                cacheKey: 'review-native-cache-key',
                cacheIdentity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    contributionId: surface.contributor.contributionId,
                    artifactDigest,
                    hostAppVersion: '2.0.0',
                    hostUiApiVersion: '1.0.0',
                    reactVersion: '19.2.0',
                    reactNativeVersion: '0.83.4',
                    platform: 'web',
                    channel: 'internal',
                    nativeCapabilitiesDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'d'.repeat(64)}`),
                    projectionGeneration: 77,
                }),
            }),
        });
        const crashState = Object.freeze({
            token: Object.freeze({
                mount: Object.freeze({
                    kind: 'targetedSurface' as const,
                    target: mountedTarget,
                    point: surface.point,
                    contributor: surface.contributor,
                    role: surface.role,
                    presentation: surface.presentation,
                }),
                renderer: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    localId: surface.contributor.contributionId,
                }),
                artifactDigest,
                crashStateEpoch: 9,
            }),
            disabled: false,
        });
        const targetedMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
            kind: 'targetedSurface' as const,
            target: mountedTarget,
            point: surface.point,
            contributor: surface.contributor,
            role: surface.role,
            presentation: surface.presentation,
            inputSchema: defineProtocolObject({}, { policy: 'additive-open/preserve' }).jsonSchema,
            rendererChain: Object.freeze([Object.freeze({
                pluginId: surface.contributor.pluginId,
                localId: surface.contributor.contributionId,
            })]),
            selectedRenderer: Object.freeze({
                identity: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    localId: surface.contributor.contributionId,
                }),
                renderer: Object.freeze({
                    kind: 'reactNative' as const,
                    contributionId: surface.contributor.contributionId,
                }),
                artifactProjection,
                crashState,
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin('acme.review', 'machine_1', 'review-materialization-b'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: surface.contributor.pluginId,
                    immutableGenerationId: surface.contributor.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const exactBPresentationProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 77,
            installedPackagesById: {
                'acme.review': {
                    id: 'acme.review',
                    displayName: 'Review Detail',
                    version: '4.0.0',
                    enabled: true,
                    source: { kind: 'bundled', locator: 'acme.review' },
                    immutableGenerationId: surface.contributor.immutableGenerationId,
                    brand: {
                        state: 'available',
                        resource: { pluginId: 'acme.review', localId: 'review-brand-mark' },
                        width: 64,
                        height: 64,
                        digest: `sha256:${'e'.repeat(64)}`,
                    },
                },
            },
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
                    entriesById: {
                        'translations:acme.review': {
                            id: 'translations:acme.review',
                            pluginId: 'acme.review',
                            contributionKind: 'translations',
                            locales: ['en'],
                            bundles: { en: { 'review.title': 'Exact B review title' } },
                        },
                    },
                },
            },
            diagnostics: [],
        });
        const targetFixture = primeExactTargetedContributions({
            pluginId: mountedTarget.pluginId,
            immutableGenerationId: mountedTarget.immutableGenerationId,
            projectionGeneration: 77,
            projection: exactBPresentationProjection,
            targetedContributions,
            targetedSurfaceMounts: [targetedMount],
        });
        const parentGeneratedProjection = createGeneratedProjection({
            translationsByPluginId: {
                'acme.browser': {
                    id: 'translations:acme.browser',
                    pluginId: 'acme.browser',
                    contributionKind: 'translations',
                    locales: ['en'],
                    bundles: { en: { 'review.title': 'Wrong ambient A title' } },
                },
            },
        } as unknown as Partial<PluginUiProjectionModel>);
        const projection = withMountedTargetPackage({
            ...parentGeneratedProjection,
            reactNativeBundlesById: {
                ...parentGeneratedProjection.reactNativeBundlesById,
                'reactNativeBundle:acme.browser:native-panel': {
                    ...parentGeneratedProjection.reactNativeBundlesById['reactNativeBundle:acme.browser:native-panel']!,
                    hostApi: {
                        minVersion: '1.0.0',
                        methods: ['context', 'executeAction', 'publishCurrentUiContext'],
                    },
                },
            },
        } as PluginUiProjectionModel, targetFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const renderParent = (nestedTargetedSurface?: React.ReactNode) => (
            <PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                <PluginSurfacePlacementHost
                    placement={browserReactNativePlacement}
                    resourceBrowserTarget={target}
                    machineId="machine_1"
                    serverId="server_1"
                    sessionId="session_1"
                    pluginUiProjection={projection}
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />
                {nestedTargetedSurface}
            </PluginSurfaceFocusEligibilityProvider>
        );
        const parent = await renderScreen(renderParent(), { flushOptions: { cycles: 0 } });
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        await vi.waitFor(() => expect(currentUiEntityLabel).toBe('Parent issue'));
        const parentProps = reactNativeSurfaceProps.at(-1) as {
            privateHostBindings?: { presentationHost?: PluginUiPrivatePresentationHost };
        };
        const renderTargetedSurface = parentProps.privateHostBindings?.presentationHost?.renderTargetedSurface;
        const targetedFallback = React.createElement('TargetedFallback', {
            testID: 'targeted-native-crash-fallback',
        });
        const rendered = renderTargetedSurface?.(Object.freeze({
            surface,
            input: Object.freeze({ reviewId: 'review-native-42' }),
            instanceKey: 'review-native-42',
            fallback: targetedFallback,
        }));
        if (!React.isValidElement(rendered)) throw new Error('Expected the parent bridge to return its physical child.');

        await parent.update(renderParent(rendered));
        await vi.waitFor(() => expect(reactNativeSurfaceProps.some((candidate) => (
            (candidate as { renderContext?: RenderContext }).renderContext?.plugin.id === surface.contributor.pluginId
        ))).toBe(true));
        // The targeted physical child inherits ordinary presentation focus from
        // its parent, but it is not a second semantic-current mount. A rejected
        // second publisher would leave the parent visible by accident while
        // keeping a competing ownership path alive.
        expect(currentUiPublishAttempts).not.toContain('Nested review');
        expect(currentUiEntityLabel).toBe('Parent issue');
        await parent.update(renderParent());

        const renderTargetedChild = (focusActive: boolean) => (
            <PluginSurfaceFocusEligibilityProvider active={focusActive}>
                {rendered}
            </PluginSurfaceFocusEligibilityProvider>
        );
        const child = await renderScreen(renderTargetedChild(false));
        await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(1));
        const childProps = reactNativeSurfaceProps.at(-1) as {
            surfaceId?: string;
            mountInstanceKey?: string;
            focusEligible?: boolean;
            crashStateToken?: unknown;
            targetedFallback?: React.ReactNode;
            onCrash?: (surfaceId: string, error: Error) => void;
            renderContext?: RenderContext;
            privateHostBindings?: Readonly<{
                composerRef?: unknown;
                presentationHost?: PluginUiPrivatePresentationHost;
            }>;
        };
        const instanceKey = derivePluginUiTargetedSurfaceMountInstanceKeyV1({
            targetPluginId: mountedTarget.pluginId,
            surface,
            rawInstanceKey: 'review-native-42',
        });
        const targetedReadyTestId = [
            'plugin-targeted-surface-ready',
            mountedTarget.pluginId,
            mountedTarget.immutableGenerationId,
            surface.contributor.pluginId,
            surface.contributor.contributionId,
            surface.contributor.immutableGenerationId,
            targetedMount.selectedRenderer.identity.pluginId,
            targetedMount.selectedRenderer.identity.localId,
            targetedMount.selectedRenderer.renderer.kind,
        ].join(':');
        expect(child.findByTestId('plugin-surface-unavailable')).toBeNull();
        expect(child.findByTestId(targetedReadyTestId)).toBeTruthy();
        expect(childProps.surfaceId).toBe(`targeted:${instanceKey}`);
        expect(childProps.mountInstanceKey).toBe(instanceKey);
        expect(childProps.focusEligible).toBe(false);
        expect(childProps.renderContext?.launchInput).toEqual({ reviewId: 'review-native-42' });
        expect(childProps.crashStateToken).toEqual(crashState.token);
        expect(childProps.targetedFallback).toBe(targetedFallback);
        expect(childProps.onCrash).toEqual(expect.any(Function));
        expect(childProps.privateHostBindings?.presentationHost?.renderTargetedSurface).toBeUndefined();
        expect(childProps.privateHostBindings?.presentationHost?.targetedSurfaceUnavailableReason)
            .toBe('unsupported_nested_targeted_surface');
        expect(childProps.renderContext?.plugin).toMatchObject({
            id: surface.contributor.pluginId,
        });
        expect(childProps.renderContext?.surface).toMatchObject({
            mount: { kind: 'embedded', role: surface.role, presentation: surface.presentation },
            target: { kind: 'browser', targetId: target.targetId },
            targetedContributions: targetedMount.contributorTargetedContributions,
        });
        // B presentation facts come only from the exact daemon response that
        // selected B. A broad parent projection carries a conflicting string
        // and must never bleed into B's public context or private brand host.
        expect(childProps.renderContext?.surface.translations).toMatchObject({
            'review.title': 'Exact B review title',
        });
        expect(childProps.renderContext?.surface.translations).not.toHaveProperty('Wrong ambient A title');
        expect(childProps.renderContext?.surface.translations['review.title']).not.toBe('Wrong ambient A title');
        const childPresentationHost = childProps.privateHostBindings?.presentationHost;
        expect(childPresentationHost?.brand).toEqual({
            displayName: 'Review Detail',
            resource: { pluginId: 'acme.review', localId: 'review-brand-mark' },
        });
        // Targeted children have no local activation switch: the enclosing
        // surface's compositional presentation fact flows into B's existing
        // private host and leaves it fail-closed while that parent is hidden.
        const childFocusTarget = { focus: vi.fn() };
        expect(typeof childPresentationHost?.focusTarget).toBe('function');
        expect(childPresentationHost?.focusTarget?.(childFocusTarget)).toBe(false);
        expect(childFocusTarget.focus).not.toHaveBeenCalled();

        await child.update(renderTargetedChild(true));
        expect((reactNativeSurfaceProps.at(-1) as { focusEligible?: boolean }).focusEligible).toBe(true);
        expect(childPresentationHost?.focusTarget?.(childFocusTarget)).toBe(true);
        expect(childFocusTarget.focus).toHaveBeenCalledTimes(1);
        const childBrandTarget = childPresentationHost as unknown as Readonly<{
            resolveBrandDisplayName(pluginId: string): string;
        }>;
        expect(childBrandTarget.resolveBrandDisplayName('acme.review')).toBe('Review Detail');
        expect(childBrandTarget.resolveBrandDisplayName('acme.browser')).toBe('common.unavailable');
        expect(childProps.renderContext?.hostApi.version().methods).toEqual(
            expect.arrayContaining(['readResource', 'watchResource']),
        );
        expect(childProps.renderContext?.hostApi.version().methods).not.toContain('unsubscribeResource');
        await expect(childProps.renderContext?.hostApi.readResource('review-summary'))
            .resolves.toMatchObject({ contentType: 'application/json' });
        expect(resourceReadMock).toHaveBeenCalledWith('machine_1', expect.objectContaining({
            serverId: 'server_1',
            callerPluginId: surface.contributor.pluginId,
            expectedGeneration: '77',
            resource: { pluginId: surface.contributor.pluginId, localId: 'review-summary' },
            context: {
                kind: 'surface',
                mountInstanceKey: instanceKey,
                launchInput: { reviewId: 'review-native-42' },
            },
        }));

        // B owns its own contributor/generation facts, but—like every generic
        // mount—never receives a private current Composer ref. Exact document
        // access therefore proves the canonical target registry is composed
        // through B's controller rather than borrowed from parent A.
        const targetedComposerRef = Object.freeze({
            kind: 'session' as const,
            sessionId: 'session-targeted-composer',
        });
        let targetedComposerSnapshot: ComposerSnapshotV1 = Object.freeze({
            revision: 1,
            ref: targetedComposerRef,
            text: 'Targeted review draft',
            references: Object.freeze([]),
            attachments: Object.freeze([]),
            layout: 'wrap' as const,
            capabilities: Object.freeze({ text: true, references: true, attachments: true, submit: true }),
            state: Object.freeze({
                focused: false,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            }),
        });
        const unregisterTargetedComposer = registerComposerPresentationTarget(targetedComposerRef, {
            readRevision: () => targetedComposerSnapshot.revision,
            replace: () => targetedComposerSnapshot.revision,
            readSnapshot: () => targetedComposerSnapshot,
        });
        try {
            const targetedHostApi = childProps.renderContext!.hostApi;
            expect(childProps.privateHostBindings?.composerRef).toBeUndefined();
            expect(targetedHostApi.version().methods).toEqual(
                expect.arrayContaining(['activeComposer', 'readComposer', 'watchComposer']),
            );
            await expect(targetedHostApi.activeComposer()).resolves.toBeNull();
            await expect(targetedHostApi.readComposer(targetedComposerRef)).resolves.toEqual({
                status: 'ready',
                snapshot: targetedComposerSnapshot,
            });

            const observed = vi.fn();
            const observation = await targetedHostApi.watchComposer(targetedComposerRef, observed);
            targetedComposerSnapshot = Object.freeze({
                ...targetedComposerSnapshot,
                revision: 2,
                text: 'Targeted review draft updated',
            });
            act(() => notifyComposerPresentationTargetChanged(targetedComposerRef));
            await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(targetedComposerSnapshot));
            observation.dispose();
        } finally {
            unregisterTargetedComposer();
        }

        const childSignal = childProps.renderContext?.signal;
        expect(childSignal?.aborted).toBe(false);
        // The child remains rendered in its own host tree, modelling the
        // retained/offline presentation callback. Retiring A must still abort
        // B and turn its old Host API inert rather than letting B survive on
        // its independent Availability bit.
        await parent.unmount();
        await vi.waitFor(() => expect(child.findByTestId(targetedReadyTestId)).toBeNull());
        expect(childSignal?.aborted).toBe(true);
        await expect(childProps.renderContext?.hostApi.readResource('review-summary'))
            .rejects.toMatchObject({ code: 'stale_surface' });
        await child.unmount();
    });

    it('retires the previous bound host when the exact Browser target authority changes', async () => {
        reactNativeSurfaceProps.length = 0;
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-target-lifecycle-generation-77',
            projectionGeneration: 77,
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const firstTarget = {
            kind: 'externalUrl',
            targetId: 'browser-target-lifecycle',
            url: 'https://first.example.test/guide',
        } as const;
        // Keep the browser identity stable while its exposed origin changes. A
        // target-id-only dependency would leave the prior controller/transport
        // current and merely push a different public context into it.
        const replacementTarget = {
            ...firstTarget,
            url: 'https://replacement.example.test/guide',
        } as const;
        const renderPlacement = (resourceBrowserTarget: Readonly<{
            kind: 'externalUrl';
            targetId: string;
            url: string;
        }>) => (
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={resourceBrowserTarget}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                sessionId="session-theme"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />
        );

        const screen = await renderScreen(renderPlacement(firstTarget));
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const firstProps = reactNativeSurfaceProps.at(-1) as {
            renderContext?: {
                signal: AbortSignal;
                surface: SurfaceContext;
                hostApi: {
                    executeAction(action: string, input: unknown): Promise<unknown>;
                };
            };
        };
        expect(firstProps.renderContext, 'the first Browser target must mount').toBeTruthy();
        expect(firstProps.renderContext!.surface.target).toEqual({
            kind: 'browser',
            targetId: 'browser-target-lifecycle',
            origin: 'https://first.example.test',
        });
        const firstSignal = firstProps.renderContext!.signal;

        await screen.update(renderPlacement(replacementTarget));
        await vi.waitFor(() => {
            const current = reactNativeSurfaceProps.at(-1) as {
                renderContext?: { surface?: SurfaceContext };
            };
            expect(current.renderContext?.surface?.target).toEqual({
                kind: 'browser',
                targetId: 'browser-target-lifecycle',
                origin: 'https://replacement.example.test',
            });
        });
        const replacementProps = reactNativeSurfaceProps.at(-1) as typeof firstProps;
        expect(replacementProps.renderContext, 'the replacement Browser target must mount').toBeTruthy();
        expect(replacementProps.renderContext!.surface.target).toEqual({
            kind: 'browser',
            targetId: 'browser-target-lifecycle',
            origin: 'https://replacement.example.test',
        });
        expect(replacementProps.renderContext!.signal).not.toBe(firstSignal);
        expect(firstSignal.aborted).toBe(true);
        expect(replacementProps.renderContext!.signal.aborted).toBe(false);
        await expect(firstProps.renderContext!.hostApi.executeAction('open', {}))
            .rejects.toMatchObject({ code: 'stale_surface' });
    });

    it('keeps a React Native signal through an equivalent target refresh and replaces it only when the mounted target generation changes', async () => {
        reactNativeSurfaceProps.length = 0;
        const { publishMachineContributionRegistryProjectionInvalidation } = await import(
            '@/sync/ops/machineContributionRegistryProjection'
        );
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetFor = (immutableGenerationId: string) => Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId,
        });
        const responseFor = (immutableGenerationId: string) => {
            const mountedTarget = targetFor(immutableGenerationId);
            return Object.freeze({
                supported: true as const,
                projection: PluginProjectionV2Schema.parse({
                    v: 2,
                    generation: 77,
                    installedPackagesById: {},
                    agentsById: {},
                    backendsById: {},
                    actionsById: {},
                    toolsById: {},
                    commandsById: {},
                    resourcesById: {},
                    settingsById: {},
                    familiesById: {},
                    diagnostics: [],
                }),
                targetedContributions: Object.freeze({
                    target: mountedTarget,
                    points: Object.freeze([]),
                }),
            });
        };
        const projectionFor = (immutableGenerationId: string) => {
            const mountedTarget = targetFor(immutableGenerationId);
            return withMountedTargetPackage(createGeneratedProjection(), {
                mountedTarget,
                targetedContributions: Object.freeze({
                    target: mountedTarget,
                    points: Object.freeze([]),
                }),
            }, {
                displayName: 'Browser Inspector',
                version: '3.2.1',
            });
        };
        let currentResponse = responseFor('browser-signal-generation-a');
        contributionProjectionDescribeMock.mockImplementation(async () => currentResponse);
        const render = (pluginUiProjection: PluginUiProjectionModel) => (
            <PluginSurfacePlacementHost
                placement={browserReactNativePlacement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={pluginUiProjection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />
        );

        const screen = await renderScreen(render(projectionFor('browser-signal-generation-a')), {
            flushOptions: { cycles: 0 },
        });
        await vi.waitFor(() => expect(reactNativeSurfaceProps.at(-1)).toBeTruthy());
        const initialProps = reactNativeSurfaceProps.at(-1) as {
            renderContext?: { signal: AbortSignal; surface: SurfaceContext; hostApi: PluginUiHostApi };
        };
        expect(initialProps.renderContext).toBeTruthy();
        const initialSignal = initialProps.renderContext!.signal;
        const initialHostApi = initialProps.renderContext!.hostApi;
        const renderedBeforeRefresh = reactNativeSurfaceProps.length;

        // A daemon invalidation reconstructs its response-local object graph.
        // This replacement is structurally equal and leaves the canonical bound
        // controller current, so a raw snapshot identity must not abort B.
        currentResponse = responseFor('browser-signal-generation-a');
        await act(async () => {
            publishMachineContributionRegistryProjectionInvalidation({
                machineId: 'machine_1',
                serverId: 'server_1',
            });
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(contributionProjectionDescribeMock).toHaveBeenCalledTimes(2);
            expect(reactNativeSurfaceProps.length).toBeGreaterThan(renderedBeforeRefresh);
        });
        const equivalentRefreshProps = reactNativeSurfaceProps.at(-1) as typeof initialProps;
        expect(equivalentRefreshProps.renderContext?.surface.targetedContributions)
            .not.toBe(initialProps.renderContext!.surface.targetedContributions);
        expect(equivalentRefreshProps.renderContext?.signal).toBe(initialSignal);
        expect(equivalentRefreshProps.renderContext?.hostApi).toBe(initialHostApi);
        expect(initialSignal.aborted).toBe(false);

        // Replacing the immutable target generation is a real mounted-target
        // replacement. The controller owns this currentness boundary, so the
        // old author signal must retire exactly with it.
        currentResponse = responseFor('browser-signal-generation-b');
        await screen.update(render(projectionFor('browser-signal-generation-b')));
        await vi.waitFor(() => {
            const current = reactNativeSurfaceProps.at(-1) as typeof initialProps;
            expect(current.renderContext?.surface.targetedContributions?.target).toEqual({
                pluginId: 'acme.browser',
                immutableGenerationId: 'browser-signal-generation-b',
            });
        });
        const replacementProps = reactNativeSurfaceProps.at(-1) as typeof initialProps;
        expect(replacementProps.renderContext?.signal).not.toBe(initialSignal);
        expect(replacementProps.renderContext?.hostApi).not.toBe(initialHostApi);
        expect(initialSignal.aborted).toBe(true);
        expect(replacementProps.renderContext?.signal.aborted).toBe(false);
        await screen.unmount();
    });

    it('derives live Resource method versions from the exact selected placement capability', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-resource-methods-generation-77',
            projectionGeneration: 77,
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const render = (placement: PluginUiSurfacePlacementProjection) => (
            <PluginSurfacePlacementHost
                placement={placement}
                resourceBrowserTarget={target}
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />
        );
        const readMethods = () => {
            const props = reactNativeSurfaceProps.at(-1) as {
                renderContext?: {
                    hostApi: { version(): { methods: readonly string[] } };
                };
            };
            expect(props.renderContext, 'the generated placement must mount a canonical render context').toBeTruthy();
            return props.renderContext!.hostApi.version().methods;
        };
        const readableStaticPlacement = {
            ...browserReactNativePlacement,
            runtime: {
                ...browserReactNativePlacement.runtime,
                resourceCapability: { readable: true, dynamic: false },
            },
        } as PluginUiSurfacePlacementProjection;
        const dynamicPlacement = {
            ...browserReactNativePlacement,
            runtime: {
                ...browserReactNativePlacement.runtime,
                resourceCapability: { readable: true, dynamic: true },
            },
        } as PluginUiSurfacePlacementProjection;
        const noResourceProducerPlacement = {
            ...browserReactNativePlacement,
            runtime: { ...browserReactNativePlacement.runtime },
        } as PluginUiSurfacePlacementProjection;

        const screen = await renderScreen(render(readableStaticPlacement));
        expect(readMethods()).toContain('readResource');
        expect(readMethods()).not.toContain('watchResource');

        await screen.update(render(dynamicPlacement));
        expect(readMethods()).toContain('readResource');
        expect(readMethods()).toContain('watchResource');

        // A renderer contribution can still carry its own host-API declaration,
        // but absent selected-surface capability must fail closed rather than
        // borrowing resource authority from a sibling or renderer.
        await screen.update(render(noResourceProducerPlacement));
        expect(readMethods()).not.toContain('readResource');
        expect(readMethods()).not.toContain('watchResource');
    });

    it('gives every placement its exact discriminated target', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-target-context-generation-77',
            projectionGeneration: 77,
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const cases = [
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'session-details',
                    rendererId: 'native-panel',
                    container: 'detailsTab',
                    target: { kind: 'session', sessionIdPath: '/sessionId' },
                }),
                props: { sessionId: 'session-77', agentId: 'codex' },
                expected: { kind: 'session', sessionId: 'session-77', agentId: 'codex' },
            },
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'project-details',
                    rendererId: 'native-panel',
                    container: 'detailsTab',
                    target: { kind: 'project', workspaceRefIdPath: '/workspaceRefId' },
                }),
                props: { projectId: 'project-4' },
                expected: { kind: 'project', projectId: 'project-4' },
            },
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'services-panel',
                    rendererId: 'native-panel',
                    container: 'servicesPanel',
                    target: { kind: 'services' },
                }),
                props: {},
                expected: { kind: 'services' },
            },
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'session-bottom-panel',
                    rendererId: 'native-panel',
                    container: 'bottomPane',
                    target: { kind: 'session', sessionIdPath: '/sessionId' },
                }),
                props: { sessionId: 'session-79' },
                expected: { kind: 'session', sessionId: 'session-79' },
            },
            {
                placement: browserReactNativePlacement,
                props: {
                    resourceBrowserTarget: {
                        kind: 'externalUrl',
                        targetId: 'browser-target-1',
                        url: 'https://docs.example.test/guide?q=1',
                    },
                },
                expected: { kind: 'browser', targetId: 'browser-target-1', origin: 'https://docs.example.test' },
            },
            // The two genuinely optional facts stay optional: a session without a
            // known agent and a browser target that has no origin are exact, not
            // failures. Requiring them would be a plausible wrong implementation
            // of the fail-closed rule.
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'session-details-without-agent',
                    rendererId: 'native-panel',
                    container: 'detailsTab',
                    target: { kind: 'session', sessionIdPath: '/sessionId' },
                }),
                props: { sessionId: 'session-78' },
                expected: { kind: 'session', sessionId: 'session-78' },
            },
            {
                placement: browserReactNativePlacement,
                props: { resourceBrowserTarget: target },
                expected: { kind: 'browser', targetId: target.targetId },
            },
        ] as const;

        const observed: unknown[] = [];
        for (const testCase of cases) {
            await renderScreen(
                <PluginSurfacePlacementHost
                    placement={testCase.placement as never}
                    machineId="machine_1"
                    serverId="server_1"
                    pluginUiProjection={projection}
                    platform="web"
                        reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => React.createElement('PluginNativeSurface')),
                    }}
                    {...testCase.props}
                />,
            );
            observed.push(readMountedSurface().target);
        }
        expect(observed).toEqual(cases.map((testCase) => testCase.expected));
    });

    it('projects an admitted inline binding as the public embedded mount context', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-inline-context-generation-77',
            projectionGeneration: 77,
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const placement = reactNativeInlineSurfacePlacementFixture({
            pluginId: 'acme.browser',
            surfaceId: 'session-info-inline',
            rendererId: 'native-panel',
            role: 'sessionInfoSection',
            target: { kind: 'session', sessionIdPath: '/sessionId' },
        });

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement}
                inlineMount={{ role: 'sessionInfoSection', presentation: 'content' }}
                sessionId="session-inline-77"
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => React.createElement('PluginNativeSurface')),
                }}
            />,
        );

        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const props = reactNativeSurfaceProps.at(-1) as { renderContext?: RenderContext };
        expect(props.renderContext?.surface.mount).toEqual({
            kind: 'embedded',
            role: 'sessionInfoSection',
            presentation: 'content',
        });
        expect(props.renderContext?.surface.mount).not.toHaveProperty('destination');
        expect(props.renderContext).not.toHaveProperty('subPath');
        await screen.unmount();
    });

    it.each([
        {
            name: 'the requested inline role maps to a different role',
            placement: reactNativeInlineSurfacePlacementFixture({
                pluginId: 'acme.browser',
                surfaceId: 'session-info-inline-role-mismatch',
                rendererId: 'native-panel',
                role: 'sessionInfoSection',
                target: { kind: 'session', sessionIdPath: '/sessionId' },
            }),
            inlineMount: { role: 'sessionSubagentLaunch' as const, presentation: 'content' as const },
        },
        {
            name: 'the requested inline role does not admit its presentation',
            placement: reactNativeInlineSurfacePlacementFixture({
                pluginId: 'acme.browser',
                surfaceId: 'session-info-inline-presentation-mismatch',
                rendererId: 'native-panel',
                role: 'sessionInfoSection',
                target: { kind: 'session', sessionIdPath: '/sessionId' },
            }),
            inlineMount: { role: 'sessionInfoSection' as const, presentation: 'fill' as const },
        },
    ])('refuses an inline binding when $name', async ({ placement, inlineMount }) => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const targetedFixture = primeExactTargetedContributions({
            pluginId: 'acme.browser',
            immutableGenerationId: `browser-inline-rejection-${placement.descriptorId}`,
            projectionGeneration: 77,
        });
        const projection = withMountedTargetPackage(createGeneratedProjection(), targetedFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement}
                inlineMount={inlineMount}
                sessionId="session-inline-77"
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={projection}
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => React.createElement('PluginNativeSurface')),
                }}
            />,
        );

        expect(screen.findByTestId('plugin-surface-unavailable-diagnostic-inline_surface_binding_unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
        await screen.unmount();
    });

    it('reports an inline-binding diagnostic when the projected inline binding is malformed', async () => {
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const admitted = reactNativeInlineSurfacePlacementFixture({
            pluginId: 'acme.browser',
            surfaceId: 'session-info-inline-malformed',
            rendererId: 'native-panel',
            role: 'sessionInfoSection',
            target: { kind: 'session', sessionIdPath: '/sessionId' },
        });
        const placement = {
            ...admitted,
            binding: { ...admitted.binding, role: 'sessionSubagentLaunch' },
        } as never;

        const screen = await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement}
                inlineMount={{ role: 'sessionInfoSection', presentation: 'content' }}
                sessionId="session-inline-77"
                machineId="machine_1"
                serverId="server_1"
                pluginUiProjection={createGeneratedProjection()}
                platform="web"
            />,
        );

        expect(screen.findByTestId(
            'plugin-surface-unavailable-diagnostic-inline_surface_binding_unavailable',
        )).toBeTruthy();
        expect(screen.findByTestId(
            'plugin-surface-unavailable-diagnostic-destination_binding_unavailable',
        )).toBeNull();
        await screen.unmount();
    });

    it('fails target resolution closed when a placement cannot supply its required identity (§3.2 r0.9)', async () => {
        // A missing principal identity is the host failing to BIND the declared
        // target. Emitting `{ kind: 'app' }` there would tell the plugin it is
        // genuinely an app surface, so a broken session/project/browser
        // mount would be indistinguishable from a real app mount. It fails closed:
        // the canonical unavailable diagnostic renders and nothing is admitted.
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const cases = [
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'session-details',
                    rendererId: 'native-panel',
                    container: 'detailsTab',
                    target: { kind: 'session', sessionIdPath: '/sessionId' },
                }),
                // `agentId` is a genuinely optional fact — supplying it must not
                // rescue a mount whose principal `sessionId` is missing.
                props: { agentId: 'codex' },
                reason: 'session_target_identity_unavailable',
            },
            {
                placement: reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'project-details',
                    rendererId: 'native-panel',
                    container: 'detailsTab',
                    target: { kind: 'project', workspaceRefIdPath: '/workspaceRefId' },
                }),
                props: {},
                reason: 'project_target_identity_unavailable',
            },
            {
                // A browser panel whose mount supplied no browser view target.
                placement: browserReactNativePlacement,
                props: {},
                reason: 'browser_target_identity_unavailable',
            },
        ] as const;

        for (const testCase of cases) {
            reactNativeSurfaceProps.length = 0;
            await primeGeneratedArtifact();
            const screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={testCase.placement as never}
                    pluginUiProjection={createGeneratedProjection()}
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => React.createElement('PluginNativeSurface')),
                    }}
                    {...testCase.props}
                />,
            );
            const unavailable = screen.findByTestId('plugin-surface-unavailable');
            expect(unavailable, testCase.reason).toBeTruthy();
            expect(screen.getTextContent()).not.toContain(testCase.reason);
            expect(unavailable?.props).toMatchObject({
                accessibilityRole: 'text',
                accessibilityLiveRegion: 'polite',
                role: 'status',
                'aria-live': 'polite',
            });
            expect(screen.findByTestId(
                `plugin-surface-unavailable-diagnostic-${testCase.reason}`,
            )).toBeTruthy();
            const accessibilityText = screen.tree.root.findAll(() => true)
                .flatMap((node) => [node.props.accessibilityLabel, node.props['aria-label']])
                .filter((value): value is string => typeof value === 'string');
            expect(accessibilityText.join(' ')).not.toContain(testCase.reason);
            // Nothing is mounted at all: no surface, and therefore no context
            // claiming to be an app surface.
            expect(reactNativeSurfaceProps, testCase.reason).toHaveLength(0);
        }
    });

    it('projects the active theme and the plugin translation bundle, and updates both live', async () => {
        reactNativeSurfaceProps.length = 0;
        await primeGeneratedArtifact();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { projectPluginUiTheme } = await import('./pluginUiThemeProjection');
        const baseProjection = createGeneratedProjection({
            translationsByPluginId: {
                'acme.browser': {
                    id: 'translations:acme.browser',
                    pluginId: 'acme.browser',
                    contributionKind: 'translations',
                    locales: ['en', 'es'],
                    bundles: {
                        en: {
                            'panel.title': 'Native panel',
                            'panel.onlyEnglish': 'English only',
                            'happier.plugin-ui.form.submit': 'Plugin submit override',
                            'happier.plugin-ui.form.cancel': 'Plugin cancel override',
                            'happier.plugin-ui.action.execute': 'Plugin execute override',
                            'happier.plugin-ui.action.copy': 'Plugin copy override',
                            'happier.plugin-ui.action.open': 'Plugin open override',
                            'happier.plugin-ui.action.refresh': 'Plugin refresh override',
                            'happier.plugin-ui.state.loading': 'Plugin loading override',
                            'happier.plugin-ui.state.empty': 'Plugin empty override',
                            'happier.plugin-ui.state.error': 'Plugin error override',
                            'happier.plugin-ui.list.moreActions': 'Plugin overflow override',
                        },
                        es: { 'panel.title': 'Panel nativo' },
                    },
                },
            },
        } as unknown as Partial<PluginUiProjectionModel>);
        const projection = withExactGeneratedMountedTarget({
            projection: baseProjection,
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-theme-context-generation-77',
            projectionGeneration: 77,
            displayName: 'Browser Inspector',
            version: '3.2.1',
        }).projection;
        const render = () => (
            <PluginSurfacePlacementHost
                placement={reactNativeSurfacePlacementFixture({
                    pluginId: 'acme.browser',
                    destinationId: 'session-bottom-panel',
                    rendererId: 'native-panel',
                    container: 'bottomPane',
                    target: { kind: 'session', sessionIdPath: '/sessionId' },
                })}
                pluginUiProjection={projection}
                machineId="machine_1"
                serverId="server_1"
                sessionId="session-theme"
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => React.createElement('PluginNativeSurface')),
                }}
            />
        );

        const screen = await renderScreen(render());
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const initial = readMountedSurface();
        expect(initial.theme).toEqual(projectPluginUiTheme(lightTheme));
        expect(initial.locale).toBe('en');
        expect(initial.translations).toEqual({
            'panel.title': 'Native panel',
            'panel.onlyEnglish': 'English only',
            'happier.plugin-ui.form.submit': 'Submit',
            'happier.plugin-ui.form.cancel': 'Cancel',
            'happier.plugin-ui.action.execute': 'Run',
            'happier.plugin-ui.action.copy': 'Copy',
            'happier.plugin-ui.action.open': 'Open',
            'happier.plugin-ui.action.refresh': 'Refresh',
            'happier.plugin-ui.state.loading': 'Loading',
            'happier.plugin-ui.state.empty': 'Nothing to show',
            'happier.plugin-ui.state.error': 'Something went wrong',
            'happier.plugin-ui.list.moreActions': 'More actions',
        });

        // A locale change moves BOTH the locale fact and the resolved bundle;
        // the English fallback still supplies the untranslated key.
        activeLanguage.value = 'es';
        await screen.update(render());
        const localized = readMountedSurface();
        expect(localized.locale).toBe('es');
        expect(localized.translations).toEqual({
            'panel.title': 'Panel nativo',
            'panel.onlyEnglish': 'English only',
            'happier.plugin-ui.form.submit': 'Enviar',
            'happier.plugin-ui.form.cancel': 'Cancelar',
            'happier.plugin-ui.action.execute': 'Ejecutar',
            'happier.plugin-ui.action.copy': 'Copiar',
            'happier.plugin-ui.action.open': 'Abrir',
            'happier.plugin-ui.action.refresh': 'Actualizar',
            'happier.plugin-ui.state.loading': 'Cargando',
            'happier.plugin-ui.state.empty': 'Nada que mostrar',
            'happier.plugin-ui.state.error': 'Algo salió mal',
            'happier.plugin-ui.list.moreActions': 'Más acciones',
        });

        // A theme change moves the projected values, not just `colorScheme`.
        surfaceEnvironment.theme = darkTheme;
        surfaceEnvironment.dark = true;
        await screen.update(render());
        const themed = readMountedSurface();
        expect(themed.colorScheme).toBe('dark');
        expect(themed.theme.colors.canvas).toBe(darkTheme.colors.background.canvas);
        expect(themed.theme.colors.canvas).not.toBe(initial.theme.colors.canvas);
    });
});

describe('Composer physical surface mount', () => {
    it('consumes one exact admitted composer catalog row through the embedded renderer pipeline', async () => {
        const contribution = Object.freeze({ pluginId: 'acme.compose', localId: 'summary' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.compose', localId: 'summary-view' });
        const applyComposer = vi.fn(async () => ({ status: 'applied' as const, revision: 5 }));
        const mount = Object.freeze({
            kind: 'composer' as const,
            contribution,
            immutableGenerationId: 'compose-generation-a',
            projectionGeneration: 7,
            role: 'region' as const,
            selectedRenderer: rendererIdentity,
            rendererChain: Object.freeze([rendererIdentity]),
            composer: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
            instanceKey: 'composer-region:session-a:summary',
            input: Object.freeze({
                v: 1 as const,
                role: 'region' as const,
                composer: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
                regionLocalId: 'summary',
            }),
        });
        const renderer = Object.freeze({
            kind: 'declarative' as const,
            contributionId: rendererIdentity.localId,
            model: Object.freeze({
                visible: true,
                identity: Object.freeze({
                    pluginId: contribution.pluginId,
                    localId: rendererIdentity.localId,
                    qualifiedId: `${contribution.pluginId}/${rendererIdentity.localId}`,
                    generation: '7',
                }),
                nodes: Object.freeze([]),
                root: Object.freeze({
                    kind: 'group',
                    path: 'root',
                    order: 0,
                    children: Object.freeze([
                        Object.freeze({
                            kind: 'text',
                            path: 'root.summary',
                            order: 1,
                            text: 'Composer summary',
                        }),
                        Object.freeze({
                            kind: 'action',
                            path: 'root.apply',
                            order: 2,
                            label: 'Replace draft',
                            enabled: true,
                            effect: Object.freeze({
                                kind: 'composerApply',
                                expectedRevision: 4,
                                operations: Object.freeze([{ kind: 'text.set', text: 'Triage this incident' }]),
                            }),
                        }),
                    ]),
                }),
            }),
        });
        const catalogEntry = Object.freeze({
            contribution,
            immutableGenerationId: mount.immutableGenerationId,
            projectionGeneration: mount.projectionGeneration,
            role: mount.role,
            rendererChain: mount.rendererChain,
            selectedRenderer: Object.freeze({
                identity: rendererIdentity,
                renderer,
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin(contribution.pluginId, 'machine-compose', 'compose-materialization-a'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: contribution.pluginId,
                    immutableGenerationId: mount.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const rawProjection = Object.freeze({
            v: 2 as const,
            generation: 7,
            installedPackagesById: Object.freeze({}),
            agentsById: Object.freeze({}),
            backendsById: Object.freeze({}),
            actionsById: Object.freeze({}),
            toolsById: Object.freeze({}),
            commandsById: Object.freeze({}),
            resourcesById: Object.freeze({}),
            settingsById: Object.freeze({}),
            familiesById: Object.freeze({}),
            diagnostics: Object.freeze([]),
        });
        const composerMount = Object.freeze({
            mount: Object.freeze({ kind: 'composer' as const, mount, catalogEntry, renderer }),
            physicalTarget: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
            parentLifetime: Object.freeze({
                isCurrent: () => true,
                onRetire: () => Object.freeze({ dispose() {} }),
            }),
            pluginProjectionById: Object.freeze({}),
            pluginProjectionV2: rawProjection,
            daemonProjectionReady: true,
            binding: Object.freeze({
                mountedHostApiHandlers: Object.freeze({ applyComposer }),
            }),
        });
        const { PluginSurfaceHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(React.createElement(PluginSurfaceHost as unknown as React.ComponentType<
            Readonly<Record<string, unknown>>
        >, {
            composerMount,
            serverId: 'server-a',
            sessionId: 'session-a',
            platform: 'web',
            channel: 'internal',
        }));

        expect(screen.findByTestId('plugin-declarative-surface-embedded-content')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Composer summary');
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
        expect(screen.findByTestId('plugin-declarative-action:composerApply:root.apply')?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId('plugin-declarative-action:composerApply:root.apply');
        });
        expect(applyComposer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            method: 'applyComposer',
            payload: {
                ref: mount.composer,
                transaction: {
                    expectedRevision: 4,
                    operations: [{ kind: 'text.set', text: 'Triage this incident' }],
                },
            },
        }), undefined);
    });

    it('mounts a Composer RN catalog selection only with its exact crash binding', async () => {
        reactNativeSurfaceProps.length = 0;
        const contribution = Object.freeze({ pluginId: 'acme.browser', localId: 'summary' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.browser', localId: 'native-panel' });
        const mount = ComposerSurfaceMountBindingV1Schema.parse({
            kind: 'composer',
            contribution,
            immutableGenerationId: 'browser-compose-generation-44',
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
            role: 'region',
            selectedRenderer: rendererIdentity,
            rendererChain: [rendererIdentity],
            composer: { kind: 'session', sessionId: 'session-a' },
            instanceKey: 'composer-region:session-a:summary',
            input: {
                v: 1,
                role: 'region',
                composer: { kind: 'session', sessionId: 'session-a' },
                regionLocalId: contribution.localId,
            },
        });
        const artifactProjection = generatedReactNativeProjection.reactNativeBundlesById[
            'reactNativeBundle:acme.browser:native-panel'
        ];
        if (!artifactProjection) throw new Error('expected generated Composer RN artifact projection');
        const crashState: DaemonPluginReactNativeCrashStateV1 = {
            token: {
                mount: {
                    kind: 'composer',
                    contribution,
                    immutableGenerationId: mount.immutableGenerationId,
                    role: mount.role,
                },
                renderer: rendererIdentity,
                artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                crashStateEpoch: 7,
            },
            disabled: false,
        };
        const catalogEntry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
            contribution,
            immutableGenerationId: mount.immutableGenerationId,
            projectionGeneration: mount.projectionGeneration,
            role: mount.role,
            rendererChain: mount.rendererChain,
            selectedRenderer: {
                identity: rendererIdentity,
                renderer: { kind: 'reactNative', contributionId: rendererIdentity.localId },
                artifactProjection,
                crashState,
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: mountedExecutionOrigin(contribution.pluginId, 'machine-compose', 'compose-materialization-a'),
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: {
                target: {
                    pluginId: contribution.pluginId,
                    immutableGenerationId: mount.immutableGenerationId,
                },
                points: [],
            },
        });
        const rawProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: mount.projectionGeneration,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        });
        const readBinding = (entry: typeof catalogEntry) => readPluginSurfaceComposerMountBinding({
            mount,
            catalogEntries: [entry],
        });
        const createComposerMount = (entry: typeof catalogEntry) => {
            const binding = readBinding(entry);
            if (!binding) return null;
            return Object.freeze({
                mount: binding,
                physicalTarget: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
                parentLifetime: Object.freeze({
                    isCurrent: () => true,
                    onRetire: () => Object.freeze({ dispose() {} }),
                }),
                pluginProjectionById: Object.freeze({}),
                pluginProjectionV2: rawProjection,
                daemonProjectionReady: true,
            });
        };
        const { PluginSurfaceHost } = await import('./PluginSurfaceHost');
        const renderComposer = (entry: typeof catalogEntry) => {
            const composerMount = createComposerMount(entry);
            if (!composerMount) throw new Error('expected valid Composer mount');
            return React.createElement(PluginSurfaceHost as unknown as React.ComponentType<
                Readonly<Record<string, unknown>>
            >, {
                composerMount,
                serverId: 'server-a',
                sessionId: 'session-a',
                platform: 'web',
                channel: 'internal',
            });
        };
        const failure = {
            token: crashState.token,
            failureOccurrenceId: '825a302d-791a-4c26-9f9d-3d7c9ad971cd',
            failure: 'render_error' as const,
        };
        reactNativeCrashReports.submit.mockResolvedValue({
            ok: true,
            token: crashState.token,
            disabled: false,
        });

        const screen = await renderScreen(renderComposer(catalogEntry), { flushOptions: { cycles: 0 } });
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        const props = reactNativeSurfaceProps.at(-1) as {
            crashStateToken?: DaemonPluginReactNativeCrashStateV1['token'];
            crashStateDisabled?: boolean;
            reportFailure?: (input: typeof failure) => Promise<unknown>;
            resetCrashState?: () => Promise<unknown>;
        };

        expect(props.crashStateToken).toEqual(crashState.token);
        expect(props.crashStateDisabled).toBe(false);
        await expect(props.reportFailure?.(failure)).resolves.toEqual({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        await expect(props.resetCrashState?.()).resolves.toEqual({
            ok: true,
            token: crashState.token,
            disabled: false,
        });
        expect(reactNativeCrashReports.submit).toHaveBeenNthCalledWith(1, {
            machineId: 'machine-compose',
            serverId: 'server-a',
            report: {
                kind: 'reportFailure',
                token: crashState.token,
                failureOccurrenceId: failure.failureOccurrenceId,
                failure: failure.failure,
            },
        });
        expect(reactNativeCrashReports.submit).toHaveBeenNthCalledWith(2, {
            machineId: 'machine-compose',
            serverId: 'server-a',
            report: { kind: 'reset', token: crashState.token },
        });

        // The physical host keeps the Protocol comparator as the sole report
        // fence: a stale RN callback cannot be rewritten to the current token.
        for (const crashMount of [
            {
                kind: 'composer' as const,
                contribution,
                immutableGenerationId: 'browser-compose-generation-45',
                role: mount.role,
            },
            {
                kind: 'composer' as const,
                contribution,
                immutableGenerationId: mount.immutableGenerationId,
                role: 'attachmentPreview' as const,
            },
        ]) {
            await expect(props.reportFailure?.({
                ...failure,
                token: { ...crashState.token, mount: crashMount },
            })).resolves.toEqual({ ok: false, reason: 'binding_token_mismatch' });
        }
        expect(reactNativeCrashReports.submit).toHaveBeenCalledTimes(2);

        // The public Composer mount must not join a new static catalog row
        // after either of its immutable scope fences changes.
        expect(readBinding({
            ...catalogEntry,
            immutableGenerationId: 'browser-compose-generation-45',
        })).toBeNull();
        expect(readBinding({
            ...catalogEntry,
            role: 'attachmentPreview',
        })).toBeNull();

        for (const crashMount of [
            {
                kind: 'composer' as const,
                contribution,
                immutableGenerationId: 'browser-compose-generation-45',
                role: mount.role,
            },
            {
                kind: 'composer' as const,
                contribution,
                immutableGenerationId: mount.immutableGenerationId,
                role: 'attachmentPreview' as const,
            },
        ]) {
            reactNativeSurfaceProps.length = 0;
            const mismatchedEntry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
                ...catalogEntry,
                selectedRenderer: {
                    ...catalogEntry.selectedRenderer,
                    crashState: {
                        ...crashState,
                        token: {
                            ...crashState.token,
                            mount: crashMount,
                        },
                    },
                },
            });

            await screen.update(renderComposer(mismatchedEntry));
            expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
            expect(reactNativeSurfaceProps).toHaveLength(0);
        }
    });

    it('mounts an Automation setup RN surface only with its exact embedded crash binding', async () => {
        reactNativeSurfaceProps.length = 0;
        const contribution = Object.freeze({ pluginId: 'acme.browser', localId: 'repository-updated' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.browser', localId: 'native-panel' });
        const immutableGenerationId = 'automation-generation-44';
        const artifactProjection = generatedReactNativeProjection.reactNativeBundlesById[
            'reactNativeBundle:acme.browser:native-panel'
        ];
        if (!artifactProjection) throw new Error('expected generated Automation RN artifact projection');
        const crashState: DaemonPluginReactNativeCrashStateV1 = {
            token: {
                mount: {
                    kind: 'automationEventSetupSurface',
                    contribution,
                    immutableGenerationId,
                },
                renderer: rendererIdentity,
                artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                crashStateEpoch: 9,
            },
            disabled: false,
        };
        const setupSurface = DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1Schema.parse({
            contribution,
            immutableGenerationId,
            projectionGeneration: generatedReactNativeCacheIdentity.projectionGeneration,
            rendererChain: [rendererIdentity],
            selectedRenderer: {
                identity: rendererIdentity,
                renderer: Object.freeze({ kind: 'reactNative' as const, contributionId: rendererIdentity.localId }),
                artifactProjection,
                crashState,
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: mountedExecutionOrigin(contribution.pluginId, 'machine-automation', 'automation-materialization-a'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: {
                target: {
                    pluginId: contribution.pluginId,
                    immutableGenerationId,
                },
                points: [],
            },
        });
        const rawProjection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: setupSurface.projectionGeneration,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        });
        const renderAutomation = (
            surface: DaemonContributionRegistryProjectionAutomationEligibleEventSetupSurfaceV1,
        ) => {
            const binding = readPluginSurfaceEphemeralMountBinding(surface);
            if (!binding) throw new Error('expected valid Automation setup surface mount');
            return React.createElement(PluginSurfaceHost as unknown as React.ComponentType<Readonly<Record<string, unknown>>>, {
                ephemeralMount: Object.freeze({
                    mount: binding,
                    physicalTarget: Object.freeze({ kind: 'app' as const }),
                    parentLifetime: Object.freeze({
                        isCurrent: () => true,
                        onRetire: () => Object.freeze({ dispose() {} }),
                    }),
                    pluginProjectionById: Object.freeze({}),
                    pluginProjectionV2: rawProjection,
                    daemonProjectionReady: true,
                }),
                machineId: 'machine-automation',
                serverId: 'server-a',
                platform: 'web',
                channel: 'internal',
            });
        };
        const { PluginSurfaceHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(renderAutomation(setupSurface), { flushOptions: { cycles: 0 } });
        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
        expect((reactNativeSurfaceProps.at(-1) as { crashStateToken?: unknown }).crashStateToken)
            .toEqual(crashState.token);

        reactNativeSurfaceProps.length = 0;
        await screen.update(renderAutomation(Object.freeze({
            ...setupSurface,
            selectedRenderer: Object.freeze({
                ...setupSurface.selectedRenderer,
                crashState: Object.freeze({
                    ...crashState,
                    token: Object.freeze({
                        ...crashState.token,
                        mount: Object.freeze({
                            kind: 'automationEventSetupSurface' as const,
                            contribution,
                            immutableGenerationId: 'automation-generation-retired',
                        }),
                    }),
                }),
            }),
        })));
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);

        await screen.update(renderAutomation(Object.freeze({
            ...setupSurface,
            selectedRenderer: Object.freeze({
                identity: rendererIdentity,
                renderer: Object.freeze({ kind: 'reactNative' as const, contributionId: rendererIdentity.localId }),
                artifactProjection,
                availability: Object.freeze({
                    state: 'fallback' as const,
                    reason: 'crash_state_unavailable',
                    diagnostics: ['crash_state_unavailable'],
                }),
            }),
        })));
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeTruthy();
        expect(reactNativeSurfaceProps).toHaveLength(0);
    });

    it('keeps equivalent Composer requests on one physical RN controller and retires it for generation or projection changes', async () => {
        reactNativeSurfaceProps.length = 0;
        const contribution = Object.freeze({ pluginId: 'acme.browser', localId: 'summary' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.browser', localId: 'native-panel' });
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-stability' });
        const physicalTarget = Object.freeze({ kind: 'session' as const, sessionId: composerRef.sessionId });
        const parentLifetime = Object.freeze({
            isCurrent: () => true,
            onRetire: () => Object.freeze({ dispose() {} }),
        });
        const transactionApplier = Object.freeze({ apply: () => ({ status: 'rejected' as const }) });
        let snapshot: ComposerSnapshotV1 = Object.freeze({
            revision: 1,
            ref: composerRef,
            text: 'initial Composer draft',
            references: Object.freeze([]),
            attachments: Object.freeze([]),
            layout: 'wrap' as const,
            capabilities: Object.freeze({ text: true, references: true, attachments: true, submit: true }),
            state: Object.freeze({
                focused: false,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            }),
        });
        const unregister = registerComposerPresentationTarget(composerRef, {
            readRevision: () => snapshot.revision,
            replace: () => snapshot.revision,
            readSnapshot: () => snapshot,
        });
        const rawProjectionFor = (projectionGeneration: number) => PluginProjectionV2Schema.parse({
            v: 2,
            generation: projectionGeneration,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {},
            diagnostics: [],
        });
        const artifactProjection = generatedReactNativeProjection.reactNativeBundlesById[
            'reactNativeBundle:acme.browser:native-panel'
        ];
        if (!artifactProjection) throw new Error('expected generated Composer RN artifact projection');
        const artifactRuntime = artifactProjection.runtime;
        if (!artifactRuntime || typeof artifactRuntime !== 'object') {
            throw new Error('expected generated Composer RN artifact runtime');
        }
        const { ComposerPluginSurface } = await import('@/components/sessions/presentation/ComposerPluginSurface');
        const requestFor = (immutableGenerationId: string) => Object.freeze({
            contribution: Object.freeze({ ...contribution }),
            immutableGenerationId,
            role: 'region' as const,
            input: Object.freeze({
                v: 1 as const,
                role: 'region' as const,
                composer: Object.freeze({ ...composerRef }),
                regionLocalId: contribution.localId,
            }),
            instanceKey: 'composer-region:session-composer-stability:summary',
        });
        const catalogEntryFor = (immutableGenerationId: string, projectionGeneration: number) => (
            DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
                contribution: Object.freeze({ ...contribution }),
                immutableGenerationId,
                projectionGeneration,
                role: 'region',
                rendererChain: [Object.freeze({ ...rendererIdentity })],
                selectedRenderer: {
                    identity: Object.freeze({ ...rendererIdentity }),
                    renderer: { kind: 'reactNative', contributionId: rendererIdentity.localId },
                    artifactProjection: {
                        ...artifactProjection,
                        runtime: {
                            ...artifactRuntime,
                            cacheIdentity: {
                                ...generatedReactNativeCacheIdentity,
                                projectionGeneration,
                            },
                        },
                    },
                    crashState: {
                        token: {
                            mount: {
                                kind: 'composer',
                                contribution,
                                immutableGenerationId,
                                role: 'region',
                            },
                            renderer: rendererIdentity,
                            artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                            crashStateEpoch: 7,
                        },
                        disabled: false,
                    },
                    availability: { state: 'available', reason: 'available', diagnostics: [] },
                },
                executionOrigin: mountedExecutionOrigin(
                    contribution.pluginId,
                    'machine-compose',
                    'compose-stability-materialization',
                ),
                resourceCapability: { readable: true, dynamic: true },
                contributorTargetedContributions: {
                    target: { pluginId: contribution.pluginId, immutableGenerationId },
                    points: [],
                },
            })
        );
        const renderComposer = (immutableGenerationId: string, projectionGeneration: number) => (
            <ComposerPluginSurface
                request={requestFor(immutableGenerationId)}
                physicalTarget={physicalTarget}
                projectionGeneration={projectionGeneration}
                catalogEntries={[catalogEntryFor(immutableGenerationId, projectionGeneration)]}
                pluginProjectionById={{}}
                pluginProjectionV2={rawProjectionFor(projectionGeneration)}
                machineId="machine-compose"
                serverId="server-a"
                parentLifetime={parentLifetime}
                transactionApplier={transactionApplier as never}
            />
        );
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        let observation: Readonly<{ dispose(): void }> | undefined;
        try {
            screen = await renderScreen(renderComposer('composer-generation-a', 44), { flushOptions: { cycles: 0 } });
            await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
            const initialProps = reactNativeSurfaceProps.at(-1) as {
                renderContext?: { signal: AbortSignal; hostApi: PluginUiHostApi };
            };
            expect(initialProps.renderContext).toBeTruthy();
            const initialSignal = initialProps.renderContext!.signal;
            const initialHostApi = initialProps.renderContext!.hostApi;
            expect(initialHostApi.version().methods).toContain('watchComposer');

            const observed = vi.fn();
            observation = await initialHostApi.watchComposer(composerRef, observed);
            const observationsBeforeEquivalentRefresh = observed.mock.calls.length;
            const rendersBeforeEquivalentRefresh = reactNativeSurfaceProps.length;

            // Scope renderers rebuild request and catalog object graphs on an
            // ordinary parent render. Their equal semantic facts must retain
            // the controller that owns the subscription.
            await screen.update(renderComposer('composer-generation-a', 44));
            await vi.waitFor(() => expect(reactNativeSurfaceProps.length)
                .toBeGreaterThan(rendersBeforeEquivalentRefresh));
            const equivalentProps = reactNativeSurfaceProps.at(-1) as typeof initialProps;
            expect(equivalentProps.renderContext?.hostApi).toBe(initialHostApi);
            expect(equivalentProps.renderContext?.signal).toBe(initialSignal);
            expect(initialSignal.aborted).toBe(false);

            snapshot = Object.freeze({ ...snapshot, revision: 2, text: 'equivalent request stayed subscribed' });
            await act(async () => {
                notifyComposerPresentationTargetChanged(composerRef);
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(observationsBeforeEquivalentRefresh + 1));
            expect(observed).toHaveBeenLastCalledWith(snapshot);

            const rendersBeforeGenerationReplacement = reactNativeSurfaceProps.length;
            await screen.update(renderComposer('composer-generation-b', 44));
            await vi.waitFor(() => expect(reactNativeSurfaceProps.length)
                .toBeGreaterThan(rendersBeforeGenerationReplacement));
            const generationReplacementProps = reactNativeSurfaceProps.at(-1) as typeof initialProps;
            const generationReplacementSignal = generationReplacementProps.renderContext?.signal;
            expect(generationReplacementProps.renderContext?.hostApi).not.toBe(initialHostApi);
            expect(generationReplacementSignal).not.toBe(initialSignal);
            expect(initialSignal.aborted).toBe(true);
            expect(generationReplacementSignal?.aborted).toBe(false);

            const generationReplacementHostApi = generationReplacementProps.renderContext?.hostApi;
            const rendersBeforeProjectionReplacement = reactNativeSurfaceProps.length;
            await screen.update(renderComposer('composer-generation-b', 45));
            await vi.waitFor(() => expect(reactNativeSurfaceProps.length)
                .toBeGreaterThan(rendersBeforeProjectionReplacement));
            const projectionReplacementProps = reactNativeSurfaceProps.at(-1) as typeof initialProps;
            expect(projectionReplacementProps.renderContext?.hostApi).not.toBe(generationReplacementHostApi);
            expect(projectionReplacementProps.renderContext?.signal).not.toBe(generationReplacementSignal);
            expect(generationReplacementSignal?.aborted).toBe(true);
        } finally {
            observation?.dispose();
            await screen?.unmount();
            unregister();
        }
    });

    it('keeps a nested declarative targeted Surface at its Composer fallback instead of creating a second embedded owner', async () => {
        const contribution = Object.freeze({ pluginId: 'acme.compose', localId: 'summary' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.compose', localId: 'summary-view' });
        const mount = Object.freeze({
            kind: 'composer' as const,
            contribution,
            immutableGenerationId: 'compose-generation-a',
            projectionGeneration: 7,
            role: 'region' as const,
            selectedRenderer: rendererIdentity,
            rendererChain: Object.freeze([rendererIdentity]),
            composer: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
            instanceKey: 'composer-region:session-a:summary',
            input: Object.freeze({
                v: 1 as const,
                role: 'region' as const,
                composer: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
                regionLocalId: 'summary',
            }),
        });
        const renderer = Object.freeze({
            kind: 'declarative' as const,
            contributionId: rendererIdentity.localId,
            model: Object.freeze({
                visible: true,
                identity: Object.freeze({
                    pluginId: contribution.pluginId,
                    localId: rendererIdentity.localId,
                    qualifiedId: `${contribution.pluginId}/${rendererIdentity.localId}`,
                    generation: '7',
                }),
                nodes: Object.freeze([]),
                root: Object.freeze({
                    kind: 'targetedSurface',
                    path: 'root',
                    order: 0,
                    surface: Object.freeze({
                        point: Object.freeze({ pointId: 'review-detail', protocol: Object.freeze({ id: 'review/detail', version: 1 }) }),
                        contributor: Object.freeze({
                            pluginId: 'acme.child',
                            contributionId: 'detail',
                            immutableGenerationId: 'child-generation-a',
                        }),
                        role: 'detail',
                        presentation: 'content',
                    }),
                    input: Object.freeze({ reviewId: 'review-42' }),
                    instanceKey: `targeted-surface:v1:${'d'.repeat(64)}`,
                    fallback: Object.freeze({
                        kind: 'state',
                        path: 'root.fallback',
                        order: 1,
                        state: 'empty',
                        title: 'Nested detail unavailable',
                    }),
                }),
            }),
        });
        const catalogEntry = Object.freeze({
            contribution,
            immutableGenerationId: mount.immutableGenerationId,
            projectionGeneration: mount.projectionGeneration,
            role: mount.role,
            rendererChain: mount.rendererChain,
            selectedRenderer: Object.freeze({
                identity: rendererIdentity,
                renderer,
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin(contribution.pluginId, 'machine-compose', 'compose-materialization-a'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: contribution.pluginId,
                    immutableGenerationId: mount.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const rawProjection = Object.freeze({
            v: 2 as const,
            generation: 7,
            installedPackagesById: Object.freeze({}),
            agentsById: Object.freeze({}),
            backendsById: Object.freeze({}),
            actionsById: Object.freeze({}),
            toolsById: Object.freeze({}),
            commandsById: Object.freeze({}),
            resourcesById: Object.freeze({}),
            settingsById: Object.freeze({}),
            familiesById: Object.freeze({}),
            diagnostics: Object.freeze([]),
        });
        const composerMount = Object.freeze({
            mount: Object.freeze({ kind: 'composer' as const, mount, catalogEntry, renderer }),
            physicalTarget: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
            parentLifetime: Object.freeze({
                isCurrent: () => true,
                onRetire: () => Object.freeze({ dispose() {} }),
            }),
            pluginProjectionById: Object.freeze({}),
            pluginProjectionV2: rawProjection,
            daemonProjectionReady: true,
        });
        const { PluginSurfaceHost } = await import('./PluginSurfaceHost');
        const screen = await renderScreen(React.createElement(PluginSurfaceHost as unknown as React.ComponentType<
            Readonly<Record<string, unknown>>
        >, {
            composerMount,
            serverId: 'server-a',
            sessionId: 'session-a',
            platform: 'web',
            channel: 'internal',
        }));

        expect(screen.findByTestId('plugin-declarative-state:root.fallback')).toBeTruthy();
        expect(screen.findByTestId('plugin-surface-unavailable')).toBeNull();
        // The committed fallback is reported, not silent. Nesting is
        // structurally unsupported for an embedded Composer mount exactly as it
        // is for an embedded targeted mount, and an author whose declared child
        // never appears has no other way to learn why.
        await vi.waitFor(() => expect(pluginSurfaceDiagnosticLog).toHaveBeenCalledWith(
            expect.stringContaining('"code":"unsupported_nested_targeted_surface"'),
        ));
    });

    it('tells a Composer-embedded React Native mount that a nested targeted Surface is unsupported', async () => {
        reactNativeSurfaceProps.length = 0;
        const contribution = Object.freeze({ pluginId: 'acme.browser', localId: 'summary' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.browser', localId: 'native-panel' });
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-nested-target' });
        const physicalTarget = Object.freeze({ kind: 'session' as const, sessionId: composerRef.sessionId });
        const immutableGenerationId = 'composer-generation-nested-target';
        const projectionGeneration = 44;
        const parentLifetime = Object.freeze({
            isCurrent: () => true,
            onRetire: () => Object.freeze({ dispose() {} }),
        });
        const transactionApplier = Object.freeze({ apply: () => ({ status: 'rejected' as const }) });
        const snapshot: ComposerSnapshotV1 = Object.freeze({
            revision: 1,
            ref: composerRef,
            text: 'nested target draft',
            references: Object.freeze([]),
            attachments: Object.freeze([]),
            layout: 'wrap' as const,
            capabilities: Object.freeze({ text: true, references: true, attachments: true, submit: true }),
            state: Object.freeze({
                focused: false,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            }),
        });
        const unregister = registerComposerPresentationTarget(composerRef, {
            readRevision: () => snapshot.revision,
            replace: () => snapshot.revision,
            readSnapshot: () => snapshot,
        });
        const artifactProjection = generatedReactNativeProjection.reactNativeBundlesById[
            'reactNativeBundle:acme.browser:native-panel'
        ];
        if (!artifactProjection) throw new Error('expected generated Composer RN artifact projection');
        const artifactRuntime = artifactProjection.runtime;
        if (!artifactRuntime || typeof artifactRuntime !== 'object') {
            throw new Error('expected generated Composer RN artifact runtime');
        }
        const { ComposerPluginSurface } = await import('@/components/sessions/presentation/ComposerPluginSurface');
        const catalogEntry = DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse({
            contribution: Object.freeze({ ...contribution }),
            immutableGenerationId,
            projectionGeneration,
            role: 'region',
            rendererChain: [Object.freeze({ ...rendererIdentity })],
            selectedRenderer: {
                identity: Object.freeze({ ...rendererIdentity }),
                renderer: { kind: 'reactNative', contributionId: rendererIdentity.localId },
                artifactProjection: {
                    ...artifactProjection,
                    runtime: {
                        ...artifactRuntime,
                        cacheIdentity: {
                            ...generatedReactNativeCacheIdentity,
                            projectionGeneration,
                        },
                    },
                },
                crashState: {
                    token: {
                        mount: {
                            kind: 'composer',
                            contribution,
                            immutableGenerationId,
                            role: 'region',
                        },
                        renderer: rendererIdentity,
                        artifactDigest: generatedReactNativeCacheIdentity.artifactDigest,
                        crashStateEpoch: 7,
                    },
                    disabled: false,
                },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: mountedExecutionOrigin(
                contribution.pluginId,
                'machine-compose',
                'compose-nested-target-materialization',
            ),
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: {
                target: { pluginId: contribution.pluginId, immutableGenerationId },
                points: [],
            },
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        try {
            screen = await renderScreen(
                <ComposerPluginSurface
                    request={Object.freeze({
                        contribution: Object.freeze({ ...contribution }),
                        immutableGenerationId,
                        role: 'region' as const,
                        input: Object.freeze({
                            v: 1 as const,
                            role: 'region' as const,
                            composer: Object.freeze({ ...composerRef }),
                            regionLocalId: contribution.localId,
                        }),
                        instanceKey: `composer-region:${composerRef.sessionId}:summary`,
                    })}
                    physicalTarget={physicalTarget}
                    projectionGeneration={projectionGeneration}
                    catalogEntries={[catalogEntry]}
                    pluginProjectionById={{}}
                    pluginProjectionV2={PluginProjectionV2Schema.parse({
                        v: 2,
                        generation: projectionGeneration,
                        installedPackagesById: {},
                        agentsById: {},
                        backendsById: {},
                        actionsById: {},
                        toolsById: {},
                        commandsById: {},
                        resourcesById: {},
                        settingsById: {},
                        familiesById: {},
                        diagnostics: [],
                    })}
                    machineId="machine-compose"
                    serverId="server-a"
                    parentLifetime={parentLifetime}
                    transactionApplier={transactionApplier as never}
                />,
                { flushOptions: { cycles: 0 } },
            );
            await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));
            const mounted = reactNativeSurfaceProps.at(-1) as {
                privateHostBindings?: Readonly<{ presentationHost?: PluginUiPrivatePresentationHost }>;
            };
            // An embedded Composer mount deliberately receives no B->C bridge.
            expect(mounted.privateHostBindings?.presentationHost?.renderTargetedSurface).toBeUndefined();
            // Structurally unsupported must not be silent: the private presentation
            // host carries the reason `<TargetedSurface>` turns into the author's
            // diagnostic, exactly as the declarative Composer twin above reports it.
            expect(mounted.privateHostBindings?.presentationHost?.targetedSurfaceUnavailableReason)
                .toBe('unsupported_nested_targeted_surface');
        } finally {
            await screen?.unmount();
            unregister();
        }
    });

    it('lends the exact hosted Composer bridge publisher only while its embedded mount is alive', async () => {
        const contribution = Object.freeze({ pluginId: 'acme.browser', localId: 'summary' });
        const rendererIdentity = Object.freeze({ pluginId: 'acme.browser', localId: 'panel' });
        const mount = Object.freeze({
            kind: 'composer' as const,
            contribution,
            immutableGenerationId: 'browser-hosted-artifact-generation-11',
            projectionGeneration: generatedHostedWebArtifactFixture.projectionGeneration,
            role: 'region' as const,
            selectedRenderer: rendererIdentity,
            rendererChain: Object.freeze([rendererIdentity]),
            composer: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
            instanceKey: 'composer-region:session-a:summary',
            input: Object.freeze({
                v: 1 as const,
                role: 'region' as const,
                composer: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
                regionLocalId: 'summary',
            }),
        });
        const generatedProjection = createGeneratedHostedWebArtifactProjection({
            requiredHostMethods: [],
            allowedMessageKinds: ['ready', 'hostApi'],
        });
        const artifactProjection = generatedProjection.hostedWebById['hostedWeb:acme.browser:panel'];
        if (!artifactProjection) throw new Error('expected generated hosted-web artifact projection');
        const renderer = Object.freeze({
            kind: 'hostedWeb' as const,
            contributionId: rendererIdentity.localId,
        });
        const catalogEntry = Object.freeze({
            contribution,
            immutableGenerationId: mount.immutableGenerationId,
            projectionGeneration: mount.projectionGeneration,
            role: mount.role,
            rendererChain: mount.rendererChain,
            selectedRenderer: Object.freeze({
                identity: rendererIdentity,
                renderer,
                artifactProjection,
                availability: Object.freeze({ state: 'available' as const, reason: 'available', diagnostics: Object.freeze([]) }),
            }),
            executionOrigin: mountedExecutionOrigin(contribution.pluginId, 'machine_1', 'compose-materialization-a'),
            resourceCapability: Object.freeze({ readable: true, dynamic: true }),
            contributorTargetedContributions: Object.freeze({
                target: Object.freeze({
                    pluginId: contribution.pluginId,
                    immutableGenerationId: mount.immutableGenerationId,
                }),
                points: Object.freeze([]),
            }),
        });
        const rawProjection = Object.freeze({
            v: 2 as const,
            generation: mount.projectionGeneration,
            installedPackagesById: Object.freeze({}),
            agentsById: Object.freeze({}),
            backendsById: Object.freeze({}),
            actionsById: Object.freeze({}),
            toolsById: Object.freeze({}),
            commandsById: Object.freeze({}),
            resourcesById: Object.freeze({}),
            settingsById: Object.freeze({}),
            familiesById: Object.freeze({}),
            diagnostics: Object.freeze([]),
        });
        const setComposerSubscriptionPublisher = vi.fn();
        const composerMount = Object.freeze({
            mount: Object.freeze({ kind: 'composer' as const, mount, catalogEntry, renderer }),
            physicalTarget: Object.freeze({ kind: 'session' as const, sessionId: 'session-a' }),
            parentLifetime: Object.freeze({
                isCurrent: () => true,
                onRetire: () => Object.freeze({ dispose() {} }),
            }),
            pluginProjectionById: Object.freeze({}),
            pluginProjectionV2: rawProjection,
            daemonProjectionReady: true,
            binding: Object.freeze({
                mountedHostApiHandlers: Object.freeze({
                    watchComposer: () => null,
                }),
            }),
            setComposerSubscriptionPublisher,
        });
        const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
        const previousWindow = (globalThis as { window?: unknown }).window;
        const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
        (globalThis as { window?: unknown }).window = new EventTarget();
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'https://host.happier.test' },
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;

        try {
            prepareGeneratedHostedWebArtifactFrame();
            const { PluginSurfaceHost } = await import('./PluginSurfaceHost');
            screen = await renderScreen(React.createElement(PluginSurfaceHost as unknown as React.ComponentType<
                Readonly<Record<string, unknown>>
            >, {
                composerMount,
                serverId: 'server-a',
                sessionId: 'session-a',
                platform: 'web',
                channel: 'internal',
            }), {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            });

            await vi.waitFor(() => expect(setComposerSubscriptionPublisher).toHaveBeenLastCalledWith(expect.any(Function)));

            await screen.unmount();
            screen = undefined;
            expect(setComposerSubscriptionPublisher).toHaveBeenLastCalledWith(undefined);
        } finally {
            await screen?.unmount();
            (globalThis as { window?: unknown }).window = previousWindow;
            if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
            else Reflect.deleteProperty(globalThis, 'location');
        }
    });
});

/**
 * EU-2 cross-path claim: "the same external plugin UI can execute ... from app,
 * session, project, browser, services, RN and hosted-web paths".
 *
 * The oracle is the plugin author's OWN `RenderContext.hostApi` — the public
 * `PluginUiHostApi` the mount hands to `renderSurface` — driven from one exact
 * Registry-normalized V2 binding and the real UI projection reader. The Host
 * does not re-select a renderer or infer a target from a legacy placement name.
 * No surface context literal, request envelope, or pre-composed host API prop is
 * hand-constructed. Only the daemon RPC (a genuine transport boundary) is
 * mocked, and it is asserted on.
 */
describe('canonical action dispatch reaches every mounted placement (EU-2)', () => {
    const crossPathEntry = 'react-native/cross-path/index.js';
    const crossPathBytes = new TextEncoder().encode('export function renderSurface() { return null; }');
    const crossPathFileDigest = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const crossPathIdentity = {
        ...reactNativeCacheIdentity,
        artifactDigest: PluginUiArtifactDigestV1Schema.parse('sha256:2222222222222222222222222222222222222222222222222222222222222222'),
        platform: 'web',
        projectionGeneration: 91,
    };

    async function primeCrossPathArtifact(): Promise<void> {
        const { getInstalledPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
        getInstalledPluginReactNativeBundleCache().putInstalledArtifact({
            identity: crossPathIdentity,
            bytes: crossPathBytes,
            entryRelativePath: crossPathEntry,
            format: 'plainJs',
            files: [{
                relativePath: crossPathEntry,
                digest: crossPathFileDigest,
                byteSize: crossPathBytes.byteLength,
                bytes: crossPathBytes,
            }],
        });
    }

    /**
     * Registry-normalized binding -> real daemon projection payload -> real UI
     * projection reader. The Host sees exactly the V2 object its producer owns;
     * it gets no legacy placement string from this fixture.
     */
    async function projectPlacementFromBinding(
        bindingInput: PluginUiDestinationBindingInputV1,
        options: Readonly<{
            exactProjection?: PluginProjectionV2;
        }> = {},
    ) {
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const binding = destinationBinding(bindingInput);
        const placementId = `surfacePlacement:${binding.destination.pluginId}:${binding.destination.localId}`;
        const targetFixture = primeExactTargetedContributions({
            pluginId: binding.destination.pluginId,
            immutableGenerationId: 'browser-cross-path-generation-91',
            projectionGeneration: 91,
            ...(options.exactProjection === undefined ? {} : { projection: options.exactProjection }),
        });
        const baseModel = normalizePluginUiProjection({
            v: 2,
            generation: 91,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            actionsById: {
                'acme.browser/refresh-index': projectedDaemonUiAction({
                    pluginId: 'acme.browser',
                    localId: 'refresh-index',
                    machineId: 'machine_1',
                    materializationId: 'materialization-cross-path-current',
                    serverIdentityId: 'srv_server_1',
                }),
            },
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            diagnostics: [],
            familiesById: {
                pluginUi: {
                    family: 'pluginUi',
                    entriesById: {
                        [placementId]: {
                            id: placementId,
                            pluginId: binding.destination.pluginId,
                            contributionKind: 'surfacePlacement',
                            descriptorId: binding.destination.localId,
                            binding,
                            target: binding.target,
                            ...mountedExecutionOrigin(
                                binding.destination.pluginId,
                                'machine_1',
                                'materialization-cross-path-current',
                                'srv_server_1',
                            ),
                            renderer: { kind: 'reactNative', contributionId: binding.renderer.localId },
                            display: { titleKey: 'crossPath.title', developerFallback: 'Cross-path panel' },
                            runtime: {
                                reactNativeCrashState: {
                                    token: {
                                        mount: {
                                            kind: 'destination',
                                            destination: {
                                                pluginId: binding.destination.pluginId,
                                                localId: binding.destination.localId,
                                            },
                                        },
                                        renderer: {
                                            pluginId: binding.destination.pluginId,
                                            localId: binding.renderer.localId,
                                        },
                                        artifactDigest: crossPathIdentity.artifactDigest,
                                        crashStateEpoch: 7,
                                    },
                                    disabled: false,
                                },
                            },
                            availability: { state: 'available', reason: 'available', diagnostics: [] },
                        },
                        'reactNativeBundle:acme.browser:native-panel': {
                            id: 'reactNativeBundle:acme.browser:native-panel',
                            pluginId: 'acme.browser',
                            contributionKind: 'reactNativeBundle',
                            contributionId: 'native-panel',
                            generatedV2: true,
                            pluginVersion: '3.2.1',
                            hostApi: { minVersion: '1.0.0', methods: ['context', 'executeAction'] },
                            artifactGraph: {
                                contributionId: 'native-panel-artifact',
                                tier: 'reactNative',
                                platform: 'web',
                                entry: crossPathEntry,
                                files: [{
                                    relativePath: crossPathEntry,
                                    digest: crossPathFileDigest,
                                    byteSize: crossPathBytes.byteLength,
                                }],
                                digest: crossPathIdentity.artifactDigest,
                                builtWith: { bundler: 'vite', version: '7.0.0' },
                                hostUiApiVersion: '1.0.0',
                                compat: { react: '19.2.0', reactNative: '0.83.4' },
                            },
                            runtime: {
                                decision: { state: 'load', reason: 'compatible', diagnostics: [] },
                                loadPolicy: { source: 'installedArtifact' },
                                cacheKey: `cross-path-${binding.destination.localId}`,
                                cacheIdentity: crossPathIdentity,
                            },
                        },
                    },
                },
            },
        } as never);
        const model = withMountedTargetPackage(baseModel, targetFixture, {
            displayName: 'Browser Inspector',
            version: '3.2.1',
        });
        const placement = model.surfacePlacementsById[placementId];
        expect(placement, `the projection must carry ${placementId}`).toBeTruthy();
        return { model, placement: placement! };
    }

    function bindingDeclaration(input: Readonly<{
        id: string;
        container: PluginUiDestinationBindingInputV1['container'];
        target: PluginUiDestinationBindingInputV1['target'];
    }>): PluginUiDestinationBindingInputV1 {
        return {
            pluginId: 'acme.browser',
            destinationId: input.id,
            rendererId: 'native-panel',
            container: input.container,
            target: input.target,
        };
    }

    function readMountedHostApi() {
        const props = reactNativeSurfaceProps.at(-1) as {
            interactionEnabled?: boolean;
            renderContext?: { hostApi: import('@happier-dev/plugin-sdk/ui').PluginUiHostApi };
        };
        // Liveness guard: "no host API" and "nothing mounted at all" are different
        // failures and must not be reported as the same one.
        expect(reactNativeSurfaceProps.length, 'the placement must mount').toBeGreaterThan(0);
        expect(props?.renderContext, 'the mount must install a canonical render context').toBeTruthy();
        return props.renderContext!.hostApi;
    }

    const placements = [
        {
            name: 'session right-sidebar',
            binding: bindingDeclaration({
                id: 'session-tab',
                container: 'rightSidebarTab',
                target: { kind: 'session', sessionIdPath: '/sessionId' },
            }),
            props: { sessionId: 'session-91' },
        },
        {
            name: 'project right-sidebar',
            binding: bindingDeclaration({
                id: 'project-tab',
                container: 'rightSidebarTab',
                target: { kind: 'project', workspaceRefIdPath: '/workspaceRefId' },
            }),
            props: { projectId: 'project-91' },
        },
        {
            name: 'services panel',
            binding: bindingDeclaration({
                id: 'services-panel',
                container: 'servicesPanel',
                target: { kind: 'services' },
            }),
            props: {},
        },
        {
            name: 'session right pane',
            binding: bindingDeclaration({
                id: 'session-side',
                container: 'rightPane',
                target: { kind: 'session', sessionIdPath: '/sessionId' },
            }),
            props: { sessionId: 'session-92' },
        },
    ] as const;

    it.each(placements)(
        'installs the canonical dispatcher at a $name mount that supplies no host API',
        async (testCase) => {
            reactNativeSurfaceProps.length = 0;
            declarativeActionExecuteMock.mockResolvedValue({
                supported: true,
                result: { ok: true, result: { refreshed: true } },
            });
            await primeCrossPathArtifact();
            const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
            const { placement, model } = await projectPlacementFromBinding(testCase.binding);

            await renderScreen(
                <PluginSurfacePlacementHost
                    placement={placement}
                    pluginUiProjection={model}
                    machineId="machine_1"
                    serverId="server-1"
                    platform="web"
                    {...testCase.props}
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />,
            );

            await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

            const hostApi = readMountedHostApi();
            expect(hostApi.version().methods).toContain('executeAction');

            await expect(hostApi.executeAction('refresh-index', { reason: testCase.name }))
                .resolves.toEqual({ refreshed: true });

            expect(declarativeActionExecuteMock).toHaveBeenCalledWith('machine_1', expect.objectContaining({
                serverId: 'server-1',
                expectedGeneration: '91',
                qualifiedActionId: 'acme.browser/refresh-index',
                input: { reason: testCase.name },
                // UI-D26: the stamp is the dispatcher's invariant, so it is present
                // at a mount that never had a hand-built host API.
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding: {
                        contributionLocalId: testCase.binding.destinationId,
                        materializationRef: {
                            machineId: 'machine_1',
                            materializationId: 'materialization-cross-path-current',
                            pluginId: testCase.binding.pluginId,
                        },
                    },
                },
            }));
        },
    );

    it('installs exact Composer reads on a generic RN destination without lending it a private current ref', async () => {
        reactNativeSurfaceProps.length = 0;
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-generic' });
        let snapshot: ComposerSnapshotV1 = Object.freeze({
            revision: 3,
            ref: composerRef,
            text: 'generic destination draft',
            references: Object.freeze([]),
            attachments: Object.freeze([]),
            layout: 'wrap' as const,
            capabilities: Object.freeze({ text: true, references: true, attachments: true, submit: true }),
            state: Object.freeze({
                focused: false,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            }),
        });
        const unregister = registerComposerPresentationTarget(composerRef, {
            readRevision: () => snapshot.revision,
            replace: () => snapshot.revision,
            readSnapshot: () => snapshot,
        });
        try {
            await primeCrossPathArtifact();
            const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
            const { placement, model } = await projectPlacementFromBinding(bindingDeclaration({
                id: 'generic-composer-reader',
                container: 'rightSidebarTab',
                target: { kind: 'session', sessionIdPath: '/sessionId' },
            }));

            await renderScreen(
                <PluginSurfacePlacementHost
                    placement={placement}
                    pluginUiProjection={model}
                    machineId="machine_1"
                    serverId="server-1"
                    sessionId="session-generic-destination"
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />,
            );
            await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

            const mounted = reactNativeSurfaceProps.at(-1) as {
                privateHostBindings?: Readonly<{ composerRef?: unknown }>;
            };
            const hostApi = readMountedHostApi();
            expect(mounted.privateHostBindings?.composerRef).toBeUndefined();
            expect(hostApi.version().methods).toContain('readComposer');
            expect(hostApi.version().methods).toContain('watchComposer');
            await expect(hostApi.activeComposer()).resolves.toBeNull();
            await expect(hostApi.readComposer(composerRef)).resolves.toEqual({ status: 'ready', snapshot });

            const observed = vi.fn();
            const observation = await hostApi.watchComposer(composerRef, observed);
            snapshot = Object.freeze({
                ...snapshot,
                revision: 4,
                text: 'generic destination draft updated',
            });
            act(() => notifyComposerPresentationTargetChanged(composerRef));
            await vi.waitFor(() => expect(observed).toHaveBeenCalledWith(snapshot));
            observation.dispose();

            unregister();
            await expect(hostApi.readComposer(composerRef)).resolves.toEqual({
                status: 'unavailable',
                reason: 'scopeClosed',
            });
        } finally {
            unregister();
        }
    });

    it('refreshes a generic Composer attachment authority after a wrong generation without remounting its RN bridge', async () => {
        reactNativeSurfaceProps.length = 0;
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-generic-attachment' });
        let snapshot: ComposerSnapshotV1 = Object.freeze({
            revision: 3,
            ref: composerRef,
            text: 'generic attachment draft',
            references: Object.freeze([]),
            attachments: Object.freeze([]),
            layout: 'wrap' as const,
            capabilities: Object.freeze({ text: true, references: true, attachments: true, submit: true }),
            state: Object.freeze({
                focused: false,
                editable: true,
                submittable: true,
                submitting: false,
                running: false,
            }),
        });
        const unregister = registerComposerPresentationTarget(composerRef, {
            readRevision: () => snapshot.revision,
            replace: () => snapshot.revision,
            readSnapshot: () => snapshot,
            createAttachmentInstanceId: () => 'host-created-generic-issue-42',
            commitDocument: (input) => {
                if (input.expectedRevision !== snapshot.revision) {
                    return { status: 'conflict' as const, currentRevision: snapshot.revision };
                }
                snapshot = Object.freeze({
                    ...snapshot,
                    text: input.mutation.text,
                    ...(input.mutation.selection === undefined ? {} : { selection: input.mutation.selection }),
                    references: Object.freeze([...input.mutation.references]),
                    attachments: Object.freeze([...input.mutation.attachments]),
                    revision: snapshot.revision + 1,
                });
                return { status: 'applied' as const, revision: snapshot.revision };
            },
        });
        const exactProjectionFor = (attachmentGeneration: string) => PluginProjectionV2Schema.parse({
            v: 2,
            generation: 91,
            installedPackagesById: {},
            agentsById: {},
            backendsById: {},
            toolsById: {},
            commandsById: {},
            resourcesById: {},
            settingsById: {},
            familiesById: {
                composerAttachments: {
                    family: 'composerAttachments',
                    entriesById: {
                        'acme.browser/generic-composer-attachment': {
                            id: 'acme.browser/generic-composer-attachment',
                            pluginId: 'acme.browser',
                            identity: {
                                pluginId: 'acme.browser',
                                localId: 'generic-composer-attachment',
                            },
                            immutableGenerationId: attachmentGeneration,
                            definition: {
                                id: 'generic-composer-attachment',
                                title: 'Generic issue',
                                icon: 'file',
                                cardinality: 'many',
                                valueSchema: { type: 'object' },
                            },
                        },
                    },
                },
            },
            diagnostics: [],
        });
        const mountedTarget = Object.freeze({
            pluginId: 'acme.browser',
            immutableGenerationId: 'browser-cross-path-generation-91',
        });
        let currentExactProjection = exactProjectionFor('browser-cross-path-generation-wrong');
        let currentResponse = Object.freeze({
            supported: true as const,
            projection: currentExactProjection,
            targetedContributions: Object.freeze({ target: mountedTarget, points: Object.freeze([]) }),
        });
        let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
        try {
            const { publishMachineContributionRegistryProjectionInvalidation } = await import(
                '@/sync/ops/machineContributionRegistryProjection'
            );
            await primeCrossPathArtifact();
            const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
            const { placement, model } = await projectPlacementFromBinding(
                bindingDeclaration({
                    id: 'generic-composer-attachment',
                    container: 'rightSidebarTab',
                    target: { kind: 'session', sessionIdPath: '/sessionId' },
                }),
                { exactProjection: currentExactProjection },
            );
            contributionProjectionDescribeMock.mockImplementation(async () => currentResponse);

            screen = await renderScreen(
                <PluginSurfacePlacementHost
                    placement={placement}
                    pluginUiProjection={model}
                    machineId="machine_1"
                    serverId="server-1"
                    sessionId="session-generic-attachment"
                    platform="web"
                    reactNativeLoaderBackend={{
                        backendId: 'reactNativeWebModule',
                        available: true,
                        loadInstalledBundle: vi.fn(async () => () => null),
                    }}
                />,
            );
            await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

            const wrongGenerationHostApi = readMountedHostApi();
            const initialSignal = (reactNativeSurfaceProps.at(-1) as {
                renderContext?: { signal?: AbortSignal };
            }).renderContext?.signal;
            const bridge = screen.findByTestId('plugin-react-native-surface-proxy');
            expect(initialSignal?.aborted).toBe(false);
            expect(bridge).toBeTruthy();
            await expect(wrongGenerationHostApi.applyComposer(composerRef, {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'generic-composer-attachment',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            })).resolves.toMatchObject({
                status: 'invalidOperation',
                reason: 'attachment_authority_mismatch',
            });

            // The immutable mounted target is unchanged, but the exact
            // attachment authority map becomes valid. The existing physical
            // RN bridge remains mounted while the canonical controller retires
            // only its stale semantic handler lifetime.
            currentExactProjection = exactProjectionFor(mountedTarget.immutableGenerationId);
            currentResponse = Object.freeze({
                supported: true as const,
                projection: currentExactProjection,
                targetedContributions: Object.freeze({ target: mountedTarget, points: Object.freeze([]) }),
            });
            const describeCallsBeforeRefresh = contributionProjectionDescribeMock.mock.calls.length;
            await act(async () => {
                publishMachineContributionRegistryProjectionInvalidation({
                    machineId: 'machine_1',
                    serverId: 'server-1',
                });
                await Promise.resolve();
                await Promise.resolve();
            });
            await vi.waitFor(() => expect(contributionProjectionDescribeMock.mock.calls.length)
                .toBeGreaterThan(describeCallsBeforeRefresh));
            await vi.waitFor(() => expect(reactNativeSurfaceProps.length).toBeGreaterThan(1));

            const hostApi = readMountedHostApi();
            const restoredSignal = (reactNativeSurfaceProps.at(-1) as {
                renderContext?: { signal?: AbortSignal };
            }).renderContext?.signal;
            expect(hostApi).not.toBe(wrongGenerationHostApi);
            expect(hostApi.version().methods).toEqual(expect.arrayContaining([
                'pickComposerMedia',
                'inspectComposerContent',
                'releaseComposerContent',
            ]));
            expect(restoredSignal).not.toBe(initialSignal);
            expect(initialSignal?.aborted).toBe(true);
            expect(restoredSignal?.aborted).toBe(false);
            expect(screen.findByTestId('plugin-react-native-surface-proxy')).toBe(bridge);

            await expect(hostApi.applyComposer(composerRef, {
                expectedRevision: 3,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'generic-composer-attachment',
                    value: {
                        key: '42',
                        value: { issueId: 42 },
                        presentation: { label: 'Issue #42' },
                    },
                }],
            })).resolves.toEqual({
                status: 'applied',
                revision: 4,
                attachmentInstanceIds: ['host-created-generic-issue-42'],
            });
            await expect(hostApi.readComposer(composerRef)).resolves.toMatchObject({
                status: 'ready',
                snapshot: {
                    attachments: [{
                        instanceId: 'host-created-generic-issue-42',
                        attachment: {
                            pluginId: 'acme.browser',
                            localId: 'generic-composer-attachment',
                        },
                        key: '42',
                    }],
                },
            });
            await expect(hostApi.applyComposer(composerRef, {
                expectedRevision: 4,
                operations: [{
                    kind: 'attachment.add',
                    attachmentLocalId: 'foreign-attachment',
                    value: {
                        key: 'never',
                        value: {},
                        presentation: { label: 'Nope' },
                    },
                }],
            })).resolves.toMatchObject({
                status: 'invalidOperation',
                reason: 'attachment_authority_mismatch',
            });
        } finally {
            await screen?.unmount();
            unregister();
        }
    });

    // Negative control (UI-D08 through the mount): a failed settlement must REJECT
    // on the author's own API. A plausible wrong implementation returns the
    // daemon's `{ ok: false, code }` envelope as a successful action result.
    it('rejects a failed contributed action at a generic mount instead of resolving the envelope', async () => {
        reactNativeSurfaceProps.length = 0;
        declarativeActionExecuteMock.mockResolvedValue({
            supported: true,
            result: { ok: false, code: 'plugin_action_surface_unavailable' },
        });
        await primeCrossPathArtifact();
        const { PluginSurfacePlacementHost } = await import('./PluginSurfaceHost');
        const { placement, model } = await projectPlacementFromBinding(bindingDeclaration({
            id: 'session-tab-failure',
            container: 'rightSidebarTab',
            target: { kind: 'session', sessionIdPath: '/sessionId' },
        }));

        await renderScreen(
            <PluginSurfacePlacementHost
                placement={placement}
                pluginUiProjection={model}
                machineId="machine_1"
                serverId="server-1"
                sessionId="session-91"
                platform="web"
                reactNativeLoaderBackend={{
                    backendId: 'reactNativeWebModule',
                    available: true,
                    loadInstalledBundle: vi.fn(async () => () => null),
                }}
            />,
        );

        await vi.waitFor(() => expect(reactNativeSurfaceProps).not.toHaveLength(0));

        await expect(readMountedHostApi().executeAction('refresh-index', {}))
            .rejects.toMatchObject({
                diagnostics: [expect.objectContaining({
                    code: 'plugin_action_surface_unavailable',
                    severity: 'error',
                })],
            });
    });

    it('keeps a nested declarative targeted Surface at its declared fallback and reports the one-level refusal', async () => {
        const reportUnsupportedNestedTargetedSurface = vi.fn();
        const { DeclarativePluginSurface } = await import('./DeclarativePluginSurface');
        const surface = React.createElement(
            DeclarativePluginSurface,
            {
                pluginId: 'acme.review',
                model: {
                    visible: true,
                    identity: {
                        pluginId: 'acme.review',
                        localId: 'nested-detail',
                        qualifiedId: 'acme.review/nested-detail',
                        generation: 'nested-generation-b',
                    },
                    nodes: [],
                    root: {
                        kind: 'targetedSurface',
                        path: 'root',
                        order: 0,
                        surface: {
                            point: { pointId: 'review-detail', protocol: { id: 'review/detail', version: 1 } },
                            contributor: {
                                pluginId: 'acme.child',
                                contributionId: 'child-detail',
                                immutableGenerationId: 'child-generation-c',
                            },
                            role: 'detail',
                            presentation: 'content',
                        },
                        input: { reviewId: 'review-42' },
                        instanceKey: `targeted-surface:v1:${'d'.repeat(64)}`,
                        fallback: {
                            kind: 'state',
                            path: 'root.fallback',
                            order: 1,
                            state: 'empty',
                            title: 'Nested detail unavailable',
                        },
                    },
                },
                interactionEnabled: true,
                daemonInteractionEnabled: true,
                dispatchAction: async () => null,
                actionAvailable: false,
                openSurface: async () => null,
                openSurfaceAvailable: false,
                authorityGeneration: 1,
                reportUnsupportedNestedTargetedSurface,
            } as unknown as React.ComponentProps<typeof DeclarativePluginSurface>,
        );
        const screen = await renderScreen(surface);

        expect(screen.findByTestId('plugin-declarative-state:root.fallback')).toBeTruthy();
        expect(reportUnsupportedNestedTargetedSurface).toHaveBeenCalledExactlyOnceWith();
    });
});
