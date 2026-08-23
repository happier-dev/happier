import * as React from 'react';

import {
    BrowserViewTargetV1Schema,
    DaemonPluginReactNativeCrashStateV1Schema,
    isSameDaemonPluginReactNativeCrashBindingTokenV1,
    type ComposerRefV1,
    type ComposerSnapshotV1,
    type DaemonPluginUiComposerSurfaceCatalogEntryV1,
    type DaemonPluginUiTargetedSurfaceMountIdentityV1,
    type DaemonPluginUiTargetedSurfaceMountV1,
    type DaemonContributionRegistryProjectionMountedTargetV1,
    type BrowserViewTargetV1,
    type DaemonPluginReactNativeCrashStateV1,
    type PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1,
    type PluginProjectionV2,
    type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import {
    buildPluginHostedWebStaticAssetPreviewId,
    isPluginUiDestinationBindingAdmittedAtRuntimeV1,
    PluginUiFallbackRefV1Schema,
    type PluginUiChannelV1,
    type PluginUiDestinationBindingV1,
    type PluginUiDestinationRuntimeFormFactorV1,
    type PluginUiFallbackRefV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiInstanceKeyV1,
    type PluginUiJsonValueV1,
    type PluginUiLaunchInputV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiSubPathV1,
    type PluginUiPlatformV1,
    type PluginUiSurfaceContextV1,
    type PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginSurfaceTarget,
    RenderContext,
    SurfaceContext,
} from '@happier-dev/plugin-sdk/ui';
import { PluginHostApiProvider } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';

import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { resolveNegotiatedPluginSurfaceHostApiMethods } from '@/components/plugins/hostApi/negotiatedMethods';
import { PluginHostedWebPane } from '@/components/plugins/hostedWeb/PluginHostedWebPane';
import {
    createComposerPresentationHostHandlers,
    createComposerPresentationTransactionApplier,
    type ComposerPresentationHostOwner,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    usePluginSurfaceCurrentUiContextEligibility,
    usePluginSurfaceFocusEligibility,
} from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import {
    useCurrentUiContextMountLifecycleActive,
    useCurrentUiContextMountPublisher,
    useOptionalCurrentUiContextReader,
} from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextMountPublication } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { CurrentUiContextMountedEnrichment } from '@/components/appShell/currentUiContext/currentUiContextModel';
import type { SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import type { PluginReactNativeBundleCacheIdentity } from '@/components/plugins/reactNative/bundleCache';
import {
    PluginReactNativeSurface,
    type PluginReactNativeSurfaceModule,
} from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { PluginUiBoundary } from '@/components/plugins/reactNative/PluginUiBoundary';
import type { PluginReactNativePendingFailure } from '@/components/plugins/reactNative/watchdog';
import type { PluginReactNativeCompatibilityDecision } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import {
    createDefaultRepackScriptManagerBackend,
    type PluginReactNativeLoaderBackend,
    type RepackInstalledArtifactModuleReference,
} from '@/components/plugins/reactNative/loader';
import { loadPluginReactNativeDevServerModule } from '@/components/plugins/reactNative/devLoader';
import { resolveDefaultReactNativeLoaderBackend } from '@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend';
import type { PluginReactNativeLoaderPolicyInput } from '@/components/plugins/reactNative/loaderPolicy';
import {
    createCanonicalPluginReactNativeHostApiAdapter,
} from '@/components/plugins/reactNative/hostApi';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import {
    resolvePluginSurfaceStatePresentation,
    type PluginSurfacePresentationState,
} from '@/sync/domains/surfaces/copy';
import { getPreferredLanguage, t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { resolvePluginDisplayString } from '@/components/plugins/surfaces/resolvePluginDisplayString';
import {
    selectLocalServicePreviewByBrowserTarget,
    type LocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    createPluginUiProjectedActionResolver,
    normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';
import type {
    PluginUiHostedWebProjection,
    PluginUiProjectionModel,
    PluginUiSettingsPageProjection,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    readPluginUiContributionOrigin,
    readPluginUiProjectionEntryExecutionOrigin,
} from '@/sync/domains/plugins/ui/projectionUnion';
import {
    createPluginUiHostedWebArtifactRequestFactsKey,
    createPluginUiReactNativeInstalledArtifactLoad,
    isPluginUiReactNativeArtifactTechnicallyAdmitted,
    PluginUiArtifactAdoptionOwner,
    readPluginUiGeneratedArtifactGraph,
    readPluginUiGeneratedReactNativeModuleReference,
    readPluginUiReactNativeBundleCacheIdentity,
    resolvePluginUiRendererTechnicalAdmission,
    resolvePluginUiHostedWebArtifactTechnicalAdmission,
    type PluginUiArtifactAdoption,
    type PluginUiArtifactDaemonOrigin,
    type PluginUiHostedWebArtifactTechnicalAdmission,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import type { PluginNativeArtifactResourceHandle } from '@/sync/domains/plugins/availability/nativeArtifactResource';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    resolvePluginUiTranslationBundle,
    resolvePluginUiTranslationText,
} from '@/sync/domains/plugins/ui/i18n';
import type { PluginSurfaceHostApiV1 } from './createPluginSurfaceHostApi';
import {
    readRequiredPluginSurfaceHostMethods,
    useBoundPluginSurfaceController,
    usePluginSurfaceDaemonInteraction,
    type BoundPluginSurfaceBinding,
    type BoundPluginSurfaceController,
    type BoundPluginSurfaceMountedHostApiHandlersFactory,
    type BoundPluginSurfaceMountLifetime,
} from './boundPluginSurfaceController';
import {
    createPluginSurfaceContext,
    getPluginSurfaceTargetAuthorityKey,
    resolvePluginSurfaceTarget,
    usePluginSurfaceAccountEncryptionMode,
    usePluginSurfaceEnvironment,
    type PluginSurfaceEnvironment,
    type PluginSurfaceTargetResolution,
} from './pluginSurfaceContext';
import {
    createPluginSurfaceComposerMountContext,
    createPluginSurfaceDestinationMountContext,
    createPluginSurfaceTargetedMountContext,
    readPluginSurfaceMountBinding,
    type PluginSurfaceComposerMountBinding,
    type PluginSurfaceTargetedMountBinding,
} from './pluginSurfaceMountBinding';
import {
    createTargetedPluginSurfaceBoundFacts,
    TargetedPluginSurfaceHost,
    type TargetedPluginSurfaceMountRequest,
} from './TargetedPluginSurfaceHost';
import {
    createPluginUiPolicyEvaluationContext,
    evaluatePluginUiPolicy,
    type PluginUiPolicyEvaluationContext,
} from '@/sync/domains/plugins/ui/policy';
import { resolveResourceScope } from '@/sync/domains/plugins/ui/scope/resolveResourceScope';
import { readSelectedPluginUiResourceCapability } from '@/sync/domains/plugins/ui/resourceCapability';
import { resolvePluginUiProjectionContributionId } from '@/sync/domains/plugins/ui/projectionRefs';
import { DeclarativePluginSurface } from './DeclarativePluginSurface';
import {
    projectDeclarativeTargetedSurfaceInventory,
    useDeclarativeDocumentSource,
    type DeclarativeDocumentSourcePresentation,
    type DeclarativeDocumentSourceMountScope,
} from './DeclarativeDocumentSource';
import {
    createPluginUiPrivatePresentationHost,
    type PluginUiPrivateBrandTarget,
    type PluginUiPresentationBrand,
    type PluginUiPrivateTargetedSurfacePresentation,
} from './pluginUiPrivatePresentationHost';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { sync } from '@/sync/sync';
import {
    issueActivePluginAccountHostedArtifactBrowserFrame,
    type ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    type ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactBrowserFrame';
import { createPluginUiDataClient } from '@/sync/api/plugins/data/pluginUiDataClient';
import { createHostedWebCollectionUiQueryBridge } from '@/sync/api/plugins/data/hostedWebCollectionUiQueryBridge';
import type { ScopedPluginSettingsDaemonTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import {
    submitReactNativeCrashReportViaMachineRpc,
    type ReactNativeCrashReportResult,
} from '@/sync/domains/plugins/ui/reactNativeCrashReports';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { getDeviceType } from '@/utils/platform/responsive';

type PluginSurfaceHostDescriptor = PluginUiSurfacePlacementProjection | PluginUiSettingsPageProjection;

/**
 * Host-only props for the bundled provider. The public provider declaration
 * stays author-safe; this cast is used solely after the host has established
 * an exact declarative mount and never widens RenderContext.
 */
type PluginHostApiProviderPrivateResourceProps = React.ComponentProps<typeof PluginHostApiProvider> & Readonly<{
    accountLifetime?: DeclarativeDocumentSourceMountScope['accountLifetime'];
    resourceStoreGeneration?: string;
    mountedPluginId?: string;
    composerRef?: ComposerRefV1;
}>;

/** The one existing physical renderer-to-document publication seam. */
export type PluginSurfaceComposerSubscriptionPublisher = (input: Readonly<{
    subscriptionId: string;
    snapshot: ComposerSnapshotV1;
}>) => boolean;

const PluginHostApiProviderWithPrivateResourceBinding = PluginHostApiProvider as unknown as React.ComponentType<
    PluginHostApiProviderPrivateResourceProps
>;

function createPluginUiPrivateResourceMountScope(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    mountLifetime: BoundPluginSurfaceMountLifetime;
    generation: string;
}>): DeclarativeDocumentSourceMountScope {
    const capturedLifetime = input.accountLifetime;
    const capturedMountLifetime = input.mountLifetime;
    // Do not pass `ActiveServerAccountScopeLifetime` itself: it includes its
    // Account scope. The artifact needs only currentness and cancellation.
    const accountLifetime = capturedLifetime
        ? Object.freeze({
            isCurrent: (): boolean => capturedLifetime.isCurrent(),
            onRetire: (cancel: () => void) => capturedLifetime.onRetire(cancel),
        })
        : null;
    return Object.freeze({
        pluginId: input.pluginId,
        accountLifetime,
        // The document adapter needs this exact existing mount observation to
        // reject a Resource snapshot delivered before passive adoption when
        // the physical surface has since retired. It creates no lifecycle.
        mountLifetime: Object.freeze({
            isCurrent: (): boolean => capturedMountLifetime.isCurrent(),
        }),
        generation: input.generation,
    });
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * The selected package row is the only UI projection fact that carries the
 * daemon-committed target generation. Do not derive it from the coarse
 * projection generation or an Artifact/materialization identity.
 */
function readMountedTarget(input: Readonly<{
    pluginId: string | null | undefined;
    installedPackagesById: PluginUiProjectionModel['installedPackagesById'] | null | undefined;
}>): DaemonContributionRegistryProjectionMountedTargetV1 | null {
    const pluginId = readOptionalString(input.pluginId);
    const immutableGenerationId = pluginId
        ? readOptionalString(input.installedPackagesById?.[pluginId]?.immutableGenerationId)
        : undefined;
    return pluginId && immutableGenerationId
        ? Object.freeze({ pluginId, immutableGenerationId })
        : null;
}

function hasExactMountedTargetedContributions(
    snapshot: PluginUiTargetedContributionsV1 | null | undefined,
    mountedTarget: DaemonContributionRegistryProjectionMountedTargetV1 | null,
): snapshot is PluginUiTargetedContributionsV1 {
    return mountedTarget !== null
        && snapshot?.target.pluginId === mountedTarget.pluginId
        && snapshot.target.immutableGenerationId === mountedTarget.immutableGenerationId;
}

/**
 * Mounted child rendering consumes only the exact cold semantic mount list.
 * The public target snapshot remains a Host API context projection, never a
 * second admission input for a targeted renderer.
 */
function hasExactMountedTargetedSurfaceMounts<
    TMount extends Readonly<{ target: DaemonContributionRegistryProjectionMountedTargetV1 }>,
>(
    mounts: readonly TMount[] | undefined,
    mountedTarget: DaemonContributionRegistryProjectionMountedTargetV1 | null,
): mounts is readonly TMount[] {
    return mountedTarget !== null
        && mounts !== undefined
        && mounts.every((mount) => (
            mount.target.pluginId === mountedTarget.pluginId
            && mount.target.immutableGenerationId === mountedTarget.immutableGenerationId
        ));
}

function readFallbackRef(value: unknown): PluginUiFallbackRefV1 | undefined {
    const parsed = PluginUiFallbackRefV1Schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

function readStringArray(value: unknown): readonly string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        : [];
}

/**
 * The private brand presenter consumes only package identity and declared brand
 * facts. This key deliberately excludes the projection object's identity so an
 * equivalent Availability refresh cannot retire a mounted presentation host.
 */
function readInstalledPackageBrandTargetIdentity(
    installedPackagesById: PluginUiProjectionModel['installedPackagesById'] | null | undefined,
): string {
    return JSON.stringify(Object.keys(installedPackagesById ?? {}).sort().map((key) => {
        const installedPackage = installedPackagesById?.[key];
        const brand = installedPackage?.brand;
        return [
            key,
            installedPackage?.id ?? null,
            installedPackage?.displayName ?? null,
            installedPackage?.version ?? null,
            installedPackage?.enabled ?? null,
            installedPackage?.source.kind ?? null,
            installedPackage?.source.locator ?? null,
            brand?.state ?? null,
            brand?.state === 'available' ? brand.resource.pluginId : null,
            brand?.state === 'available' ? brand.resource.localId : null,
            brand?.state === 'available' ? brand.width : null,
            brand?.state === 'available' ? brand.height : null,
            brand?.state === 'available' ? brand.digest : null,
        ];
    }));
}

function createInstalledPackageBrandTargetResolver(
    installedPackagesById: PluginUiProjectionModel['installedPackagesById'] | null | undefined,
): ((pluginId: string) => PluginUiPrivateBrandTarget | undefined) | undefined {
    if (!installedPackagesById) return undefined;
    const targetsById = Object.freeze(Object.fromEntries(
        Object.entries(installedPackagesById).flatMap(([pluginId, targetPackage]) => (
            targetPackage
                ? [[pluginId, Object.freeze({
                    displayName: targetPackage.displayName,
                    installedPackage: targetPackage,
                })] as const]
                : []
        )),
    ));
    return (pluginId: string): PluginUiPrivateBrandTarget | undefined => {
        return Object.prototype.hasOwnProperty.call(targetsById, pluginId)
            ? targetsById[pluginId]
            : undefined;
    };
}

/**
 * The live-document adapter deliberately wraps the existing declarative
 * renderer rather than becoming a renderer itself. It supplies only an adopted
 * model; action, settings, accessibility and visual node rendering stay owned
 * by `DeclarativePluginSurface`.
 */
type DeclarativePluginSurfaceWithDocumentSourceProps = Readonly<{
    pluginId: string;
    staticModel: Readonly<Record<string, unknown>>;
    documentSource: unknown;
    /** The exact Registry container published through the public SDK context. */
    surfaceMount: SurfaceContext['mount'];
    surfaceTarget: PluginSurfaceTarget;
    accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
    /** The one parent-mounted environment snapshot for both static and document declarative paths. */
    environment: PluginSurfaceEnvironment;
    surfaceTranslations: Readonly<Record<string, string>>;
    targetedContributions: SurfaceContext['targetedContributions'];
    /** Current host-private mount inventory from the same parent target response. */
    preparedTargetedSurfaces?: readonly PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1[];
    /** The one normalized-node bridge into the exact correlated child mount. */
    renderTargetedSurface?: (
        node: Readonly<Record<string, unknown>>,
        fallback: React.ReactNode,
    ) => React.ReactNode;
    /** The B mount owns diagnostics for its intentionally unavailable C bridge. */
    reportUnsupportedNestedTargetedSurface?: () => void;
    /** `content` stays in the parent's scroll owner; root `fill` owns its own. */
    embeddedPresentation?: 'content' | 'fill';
    /** A host-stamped Composer ref is private and exists only for Composer mounts. */
    composerRef?: ComposerRefV1;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    dataClient: PluginUiDataClient | null;
    machineId?: string | null;
    serverId?: string | null;
    /** Explicit Settings-route daemon target; `null` intentionally disables origin fallback. */
    daemonSettingsTarget?: ScopedPluginSettingsDaemonTarget | null;
    isDaemonSettingsTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Settings-only availability is independent of this mount's action bridge. */
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
    /** Current Account/local admission for the declarative presentation boundary. */
    interactionEnabled: boolean;
    /** One outer physical mount eligibility fact for retained declarative content. */
    focusEligible?: boolean;
    /** Daemon-only admission for declarative actions and daemon settings. */
    daemonInteractionEnabled: boolean;
    controller: BoundPluginSurfaceController;
    authorityGeneration: number;
    pluginUiProjection?: PluginUiProjectionModel | null;
    policyContext?: PluginUiPolicyEvaluationContext;
}>;

function resolveDeclarativeDocumentPluginSurfaceState(
    presentation: DeclarativeDocumentSourcePresentation,
): PluginSurfacePresentationState {
    switch (presentation) {
        case 'initialLoading':
            return 'loading';
        case 'fresh':
            return 'available';
        case 'refreshingLkg':
            return 'refreshing';
        case 'staleReconnectingLkg':
            return 'stale';
        case 'terminalUnavailable':
            return 'unavailable';
        case 'invalidDocument':
            return 'failedRetry';
    }
}

function DeclarativePluginSurfaceDocumentContent(
    props: DeclarativePluginSurfaceWithDocumentSourceProps & Readonly<{
        documentMountScope: DeclarativeDocumentSourceMountScope;
        contrast: SurfaceContext['contrast'];
    }>,
) {
    const document = useDeclarativeDocumentSource({
        pluginId: props.pluginId,
        staticModel: props.staticModel,
        documentSource: props.documentSource,
        mountScope: props.documentMountScope,
        ...(props.preparedTargetedSurfaces === undefined
            ? {}
            : { preparedTargetedSurfaces: props.preparedTargetedSurfaces }),
    });
    const documentSurfacePresentation = resolvePluginSurfaceStatePresentation({
        state: resolveDeclarativeDocumentPluginSurfaceState(document.presentation),
        reasonCode: document.invalidDocument
            ? 'plugin_declarative_document_invalid'
            : document.resourceError?.code,
        // The packaged static model paints immediately and remains the valid
        // LKG until a complete dynamic document is atomically adopted.
        hasRetainedContent: true,
    });
    return (
        <DeclarativePluginSurface
            pluginId={props.pluginId}
            model={document.model}
            machineId={props.machineId}
            serverId={props.serverId}
            daemonSettingsTarget={props.daemonSettingsTarget}
            isDaemonSettingsTargetCurrent={props.isDaemonSettingsTargetCurrent}
            settingsScopesEnabled={props.settingsScopesEnabled}
            interactionEnabled={props.interactionEnabled}
            focusEligible={props.focusEligible}
            daemonInteractionEnabled={props.daemonInteractionEnabled}
            dispatchAction={props.controller.dispatchAction}
            actionAvailable={props.controller.installedMethods.includes('executeAction')}
            {...(props.composerRef === undefined ? {} : { composerRef: props.composerRef })}
            applyComposer={props.controller.applyComposer}
            composerApplyAvailable={props.controller.installedMethods.includes('applyComposer')}
            pluginUiProjection={props.pluginUiProjection}
            policyContext={props.policyContext}
            openSurface={props.controller.openSurface}
            openSurfaceAvailable={props.controller.installedMethods.includes('openSurface')}
            authorityGeneration={props.authorityGeneration}
            accountLifetime={props.accountLifetime}
            dataClient={props.dataClient}
            documentSourcePresentation={{
                presentation: documentSurfacePresentation,
                retry: document.retry,
            }}
            renderTargetedSurface={props.renderTargetedSurface}
            reportUnsupportedNestedTargetedSurface={props.reportUnsupportedNestedTargetedSurface}
            embeddedPresentation={props.embeddedPresentation}
            contrast={props.contrast}
        />
    );
}

function DeclarativePluginSurfaceWithDocumentSource(
    props: DeclarativePluginSurfaceWithDocumentSourceProps,
) {
    const environment = props.environment;
    const surface = React.useMemo(() => createPluginSurfaceContext({
        mount: props.surfaceMount,
        target: props.surfaceTarget,
        accountEncryptionMode: props.accountEncryptionMode,
        environment,
        translations: props.surfaceTranslations,
        targetedContributions: props.targetedContributions,
    }), [
        environment,
        props.accountEncryptionMode,
        props.surfaceMount,
        props.surfaceTarget,
        props.surfaceTranslations,
        props.targetedContributions,
    ]);
    // Environment snapshots update independently of the Resource store. Keep
    // the adapter/store lifetime bound to the controller identity and push the
    // latest public context into the existing adapter rather than reopening a
    // watch on every locale/theme change.
    const surfaceRef = React.useRef(surface);
    surfaceRef.current = surface;
    const modelIdentity = readRecord(props.staticModel.identity);
    const generation = readOptionalString(modelIdentity?.generation);
    const adapterKey = generation
        ? `${props.controller.surfaceContext.surfaceId}:${generation}`
        : null;
    const hostApiAdapter = React.useMemo(() => {
        if (!adapterKey) return null;
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface: surfaceRef.current,
            requestSurface: props.controller.surfaceContext,
            requestIdPrefix: `declarative-document:${adapterKey}`,
            handleRequest: props.controller.hostApi.handleRequest,
            installedMethods: props.controller.installedMethods,
            getInstalledMethods: () => props.controller.hostApi.installedMethods,
            getAdmissionMethods: () => props.controller.hostApi.admissionMethods,
            isCurrent: props.controller.isCurrent,
        });
        // The current context is pushed below; only controller identity is a
        // Resource-store lifetime boundary.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [adapterKey, props.controller]);
    React.useEffect(() => {
        hostApiAdapter?.pushSurfaceContext(surface);
    }, [hostApiAdapter, surface]);
    React.useEffect(() => {
        if (!hostApiAdapter) return;
        return props.controller.subscribeResourceInvalidations((event) => {
            hostApiAdapter.publishResourceSubscriptionEvent(event);
        });
    }, [hostApiAdapter, props.controller]);
    React.useLayoutEffect(() => () => {
        hostApiAdapter?.dispose();
    }, [hostApiAdapter]);
    const documentMountScope = React.useMemo(() => generation
        ? createPluginUiPrivateResourceMountScope({
            pluginId: props.pluginId,
            accountLifetime: props.accountLifetime,
            mountLifetime: props.controller,
            generation,
        })
        : null,
    [generation, props.accountLifetime, props.controller, props.pluginId]);
    if (!hostApiAdapter || !documentMountScope) {
        return (
            <DeclarativePluginSurface
                pluginId={props.pluginId}
                model={props.staticModel}
                machineId={props.machineId}
                serverId={props.serverId}
                daemonSettingsTarget={props.daemonSettingsTarget}
                isDaemonSettingsTargetCurrent={props.isDaemonSettingsTargetCurrent}
                settingsScopesEnabled={props.settingsScopesEnabled}
                interactionEnabled={props.interactionEnabled}
                focusEligible={props.focusEligible}
                daemonInteractionEnabled={props.daemonInteractionEnabled}
                dispatchAction={props.controller.dispatchAction}
                actionAvailable={props.controller.installedMethods.includes('executeAction')}
                {...(props.composerRef === undefined ? {} : { composerRef: props.composerRef })}
                applyComposer={props.controller.applyComposer}
                composerApplyAvailable={props.controller.installedMethods.includes('applyComposer')}
                pluginUiProjection={props.pluginUiProjection}
                policyContext={props.policyContext}
                openSurface={props.controller.openSurface}
                openSurfaceAvailable={props.controller.installedMethods.includes('openSurface')}
                authorityGeneration={props.authorityGeneration}
                accountLifetime={props.accountLifetime}
                dataClient={props.dataClient}
                renderTargetedSurface={props.renderTargetedSurface}
                reportUnsupportedNestedTargetedSurface={props.reportUnsupportedNestedTargetedSurface}
                embeddedPresentation={props.embeddedPresentation}
                contrast={environment.contrast}
            />
        );
    }
    return (
        <PluginHostApiProviderWithPrivateResourceBinding
            hostApi={hostApiAdapter.api}
            accountLifetime={documentMountScope.accountLifetime}
            resourceStoreGeneration={documentMountScope.generation}
            mountedPluginId={documentMountScope.pluginId}
            {...(props.composerRef === undefined ? {} : { composerRef: props.composerRef })}
        >
            <DeclarativePluginSurfaceDocumentContent
                {...props}
                documentMountScope={documentMountScope}
                contrast={environment.contrast}
            />
        </PluginHostApiProviderWithPrivateResourceBinding>
    );
}

function readPluginSurfaceDisplay(
    descriptor: PluginSurfaceHostDescriptor,
): Readonly<{
    titleKey?: string;
    descriptionKey?: string;
    labelKey?: string;
    developerFallback?: string;
}> | null {
    const display = readRecord(descriptor.display);
    if (!display) {
        return null;
    }
    return {
        ...(readOptionalString(display.titleKey) ? { titleKey: readOptionalString(display.titleKey) } : {}),
        ...(readOptionalString(display.descriptionKey) ? { descriptionKey: readOptionalString(display.descriptionKey) } : {}),
        ...(readOptionalString(display.labelKey) ? { labelKey: readOptionalString(display.labelKey) } : {}),
        ...(readOptionalString(display.developerFallback)
            ? { developerFallback: readOptionalString(display.developerFallback) }
            : {}),
    };
}

function createPluginSurfaceDisplayKeyResolver(params: Readonly<{
    projection: PluginUiProjectionModel | null | undefined;
    pluginId: string;
}>): ((key: string) => string | null) | undefined {
    if (!params.projection) {
        return undefined;
    }
    return (key: string) => resolvePluginUiTranslationText({
        projection: params.projection,
        pluginId: params.pluginId,
        key,
        locale: getPreferredLanguage(),
    });
}

function isNativeHostedArtifactPlatform(platform: LocalServicePreviewPlatform | undefined): boolean {
    return platform === 'ios' || platform === 'android' || platform === 'desktop';
}

/**
 * Thin renderer consumer of the UI-sync Artifact adoption owner. It holds only
 * React presentation state; source selection, cache, technical admission, and
 * consumer retirement remain in their existing canonical owners.
 */
function PluginHostedWebArtifactAdoptionPane(props: Readonly<{
    paneProps: React.ComponentProps<typeof PluginHostedWebPane>;
    platform: LocalServicePreviewPlatform | undefined;
    reader: PluginAccountAvailabilityReader | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    exactArtifactOrigin: PluginUiArtifactDaemonOrigin | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
    /** The bound surface controller remains the lifetime authority. */
    isCurrent: () => boolean;
}>): React.ReactElement {
    const [nativeArtifactAdoption, setNativeArtifactAdoption] = React.useState<
        PluginUiArtifactAdoption<'hostedWebNative', PluginNativeArtifactResourceHandle> | null
    >(null);
    const currentnessRef = React.useRef(props.isCurrent);
    currentnessRef.current = props.isCurrent;
    const isCurrent = React.useCallback(() => currentnessRef.current(), []);
    const mountInstanceKey = props.paneProps.mountInstanceKey;
    const artifactRequestFactsKey = createPluginUiHostedWebArtifactRequestFactsKey({
        platform: props.platform,
        origin: props.exactArtifactOrigin,
        admission: props.admission,
    });

    React.useEffect(() => {
        const owner = new PluginUiArtifactAdoptionOwner({ isCurrent });
        let mounted: PluginUiArtifactAdoption<'hostedWebNative', PluginNativeArtifactResourceHandle> | null = null;

        if (
            !isNativeHostedArtifactPlatform(props.platform)
            || !props.reader
            || !props.accountLifetime
            || !props.admission
            || !isCurrent()
        ) {
            setNativeArtifactAdoption(null);
            return () => owner.dispose();
        }

        void (async () => {
            const acquired = await owner.adoptHostedWebNative({
                reader: props.reader!,
                artifactGraph: props.admission!.artifactGraph,
                cacheIdentity: props.admission!.cacheIdentity,
                accountLifetime: props.accountLifetime!,
                hostedWebPolicy: props.admission!.hostedWebPolicy,
                // The Artifact producer may use its incumbent verified cache
                // without a daemon. Only a daemon candidate itself needs an
                // exact Administration-stamped origin; Host never supplies
                // app or Account byte-source adapters.
                ...(props.exactArtifactOrigin
                    ? {
                        daemon: props.exactArtifactOrigin,
                    }
                    : {}),
            });
            if (acquired.kind !== 'available') return;
            mounted = acquired.adoption;
            setNativeArtifactAdoption(acquired.adoption);
        })();

        return () => {
            owner.dispose();
            const adoption = mounted;
            setNativeArtifactAdoption((current) => current === adoption ? null : current);
        };
    // Equivalent parsed projection objects must not retire an otherwise-current
    // native token. This dependency key contains every Artifact request fact;
    // it is deliberately not a cache or persistence identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        props.accountLifetime,
        props.reader,
        isCurrent,
        mountInstanceKey,
        artifactRequestFactsKey,
    ]);

    return (
        <PluginHostedWebPane
            {...props.paneProps}
            nativeArtifactAdoption={nativeArtifactAdoption}
        />
    );
}

type BrowserHostedArtifactFrameRequest = Omit<
    ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    'accountLifetime' | 'signal'
>;

/**
 * Availability selects the release coordinate; the generated projection
 * supplies the independently admitted Artifact graph. Browser capability
 * issuance proceeds only when those two owners agree exactly. This validates
 * their handoff without selecting bytes, a cache, or a transport fallback.
 */
function readBrowserHostedArtifactFrameRequest(input: Readonly<{
    reader: PluginAccountAvailabilityReader | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
}>): BrowserHostedArtifactFrameRequest | null {
    const { reader, admission } = input;
    if (!reader || !admission) return null;
    const { artifactGraph, cacheIdentity } = admission;
    if (
        artifactGraph.tier !== 'hostedWeb'
        || artifactGraph.platform !== 'web'
        || cacheIdentity.contributionId !== artifactGraph.contributionId
        || cacheIdentity.platform !== artifactGraph.platform
        || cacheIdentity.artifactDigest !== artifactGraph.digest
    ) {
        return null;
    }

    let currentArtifact: ReturnType<PluginAccountAvailabilityReader['readCurrentArtifact']>;
    try {
        currentArtifact = reader.readCurrentArtifact({
            pluginId: cacheIdentity.pluginId,
            contributionId: artifactGraph.contributionId,
            tier: artifactGraph.tier,
            platform: artifactGraph.platform,
        });
    } catch {
        return null;
    }
    if (currentArtifact.kind !== 'available') return null;

    const selected = currentArtifact.artifact;
    if (
        selected.pluginId !== cacheIdentity.pluginId
        || selected.contributionId !== artifactGraph.contributionId
        || selected.tier !== artifactGraph.tier
        || selected.platform !== artifactGraph.platform
        || selected.digest !== artifactGraph.digest
        || selected.digest !== cacheIdentity.artifactDigest
    ) {
        return null;
    }

    return Object.freeze({
        release: Object.freeze({
            pluginId: selected.pluginId,
            version: selected.releaseVersion,
        }),
        slot: Object.freeze({
            contributionId: selected.contributionId,
            tier: selected.tier,
            platform: selected.platform,
        }),
        expectedArtifactDigest: selected.digest,
    });
}

function browserHostedArtifactFrameRequestKey(
    request: BrowserHostedArtifactFrameRequest | null,
): string | null {
    if (!request) return null;
    return [
        request.release.pluginId,
        request.release.version,
        request.slot.contributionId,
        request.slot.tier,
        request.slot.platform,
        request.expectedArtifactDigest,
    ].join('\u001f');
}

/**
 * Browser-only presentation consumer for the issued Artifact capability URL.
 * Its state is mount-local and cleared on the incumbent Account retirement;
 * the issuer and server remain the sole capability/byte-source owners.
 */
function PluginHostedWebBrowserArtifactFramePane(props: Readonly<{
    paneProps: React.ComponentProps<typeof PluginHostedWebPane>;
    reader: PluginAccountAvailabilityReader | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
    /** The bound surface controller remains the lifetime authority. */
    isCurrent: () => boolean;
}>): React.ReactElement {
    const [frame, setFrame] = React.useState<ActivePluginAccountHostedArtifactBrowserFrameIssueResult | null>(null);
    const [expiredFrame, setExpiredFrame] = React.useState<Extract<
        ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
        { kind: 'available' }
    > | null>(null);
    const currentnessRef = React.useRef(props.isCurrent);
    currentnessRef.current = props.isCurrent;
    const isCurrent = React.useCallback(() => currentnessRef.current(), []);
    const request = readBrowserHostedArtifactFrameRequest({
        reader: props.reader,
        admission: props.admission,
    });
    const requestRef = React.useRef(request);
    requestRef.current = request;
    const requestKey = browserHostedArtifactFrameRequestKey(request);
    const technicalAdmissionKey = createPluginUiHostedWebArtifactRequestFactsKey({
        platform: 'web',
        origin: null,
        admission: props.admission,
    });
    const mountInstanceKey = props.paneProps.mountInstanceKey;

    React.useLayoutEffect(() => {
        const currentRequest = requestRef.current;
        const accountLifetime = props.accountLifetime;
        const controller = new AbortController();
        let mounted = true;
        const retire = () => {
            controller.abort();
            if (mounted) {
                setFrame(null);
                setExpiredFrame(null);
            }
        };

        if (!currentRequest || !accountLifetime || !accountLifetime.isCurrent() || !isCurrent()) {
            setFrame(null);
            setExpiredFrame(null);
            return () => {
                mounted = false;
                controller.abort();
            };
        }

        // Clear an earlier capability before the replacement request becomes
        // observable. Layout timing prevents an old Account/release URL from
        // surviving a changed current selection through a browser paint.
        setFrame(null);
        setExpiredFrame(null);
        const retirement = accountLifetime.onRetire(retire);
        void issueActivePluginAccountHostedArtifactBrowserFrame({
            ...currentRequest,
            accountLifetime,
            signal: controller.signal,
        }).then((result) => {
            if (!mounted || controller.signal.aborted || !accountLifetime.isCurrent() || !isCurrent()) {
                return;
            }
            setFrame(result);
        }).catch(() => {
            if (!mounted || controller.signal.aborted || !accountLifetime.isCurrent() || !isCurrent()) {
                return;
            }
            setFrame(Object.freeze({ kind: 'unavailable' as const, code: 'transport_unavailable' as const }));
        });

        return () => {
            mounted = false;
            controller.abort();
            retirement.dispose();
        };
    // These keys contain the issued coordinate and the existing technical
    // admission facts. They are effect dependencies, never a capability cache
    // or a renewal schedule.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        props.accountLifetime,
        props.reader,
        isCurrent,
        mountInstanceKey,
        requestKey,
        technicalAdmissionKey,
    ]);

    const availableFrame = frame?.kind === 'available' ? frame : null;
    const endpoint = availableFrame !== null && expiredFrame !== availableFrame
        ? availableFrame.value
        : null;
    React.useEffect(() => {
        if (!availableFrame) return;
        const remainingMs = availableFrame.value.expiresAt - Date.now();
        if (remainingMs <= 0) {
            setExpiredFrame(availableFrame);
            return;
        }
        const timeout = setTimeout(
            () => setExpiredFrame(availableFrame),
            Math.min(remainingMs, 2_147_483_647),
        );
        return () => {
            clearTimeout(timeout);
        };
    }, [availableFrame]);
    const unavailableDiagnosticCode = expiredFrame === availableFrame
        ? 'hosted_web_preview_expired'
        : frame?.kind === 'unavailable' ? frame.code : null;
    return (
        <PluginHostedWebPane
            {...props.paneProps}
            endpointUrl={endpoint?.url ?? null}
            expiresAt={endpoint?.expiresAt ?? null}
            opaqueArtifactFrame
            unavailableDiagnosticCode={unavailableDiagnosticCode}
        />
    );
}

function sanitizeReactNativeFederatedIdentifier(value: string): string {
    const normalized = value
        .trim()
        .replace(/[^A-Za-z0-9_$]/gu, '_')
        .replace(/^[^A-Za-z_$]+/u, '');
    return normalized || 'pluginReactNativeBundle';
}

function readReactNativeModuleReference(params: Readonly<{
    pluginId: string;
    contributionId: string;
    entry: unknown;
}>): RepackInstalledArtifactModuleReference {
    const entry = readRecord(params.entry);
    const containerName = readOptionalString(entry?.containerName)
        ?? sanitizeReactNativeFederatedIdentifier(`${params.pluginId}_${params.contributionId}`);
    const modulePath = readOptionalString(entry?.modulePath) ?? './renderSurface';
    const exportName = readOptionalString(entry?.exportName) ?? 'renderSurface';
    return Object.freeze({
        containerName,
        modulePath,
        exportName,
    });
}

/**
 * RN-2: the dev-hot-reload LOAD path. A development-channel, locally-sourced surface
 * served by a local Re.Pack/Metro dev server loads straight from the projected dev
 * URL with no materialized artifact (every mount re-fetches). The cli projection has
 * already enforced the `plugins.ui.reactNativeBundles.devHotReload` + local +
 * development gate before emitting the `devHotReload` source.
 */
function createReactNativeDevServerLoad(
    input: Readonly<{
        devUrl: string;
        pluginId: string;
        contributionId: string;
        moduleReference: RepackInstalledArtifactModuleReference;
    }>,
    backend?: PluginReactNativeLoaderBackend,
): () => Promise<PluginReactNativeSurfaceModule> {
    return async () => {
        const result = await loadPluginReactNativeDevServerModule({
            devUrl: input.devUrl,
            pluginId: input.pluginId,
            contributionId: input.contributionId,
            moduleReference: input.moduleReference,
            backend: backend ?? createDefaultRepackScriptManagerBackend(),
        });
        if (result.ok) {
            return result.module;
        }

        throw Object.assign(new Error(result.code), {
            code: result.code,
            diagnostics: result.diagnostics,
        });
    };
}

function PluginReactNativeSurfaceHost(props: Readonly<{
    surfaceId: string;
    mountInstanceKey?: PluginUiInstanceKeyV1;
    snapshotTitle: string;
    /** Host-private request envelope; never published to the RN module. */
    requestSurface: PluginUiSurfaceContextV1;
    decision: PluginReactNativeCompatibilityDecision;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    load?: () => Promise<PluginReactNativeSurfaceModule>;
    hostApi: PluginSurfaceHostApiV1;
    /** Targeted caller fallback for a contributor render crash. */
    targetedFallback?: React.ReactNode;
    /** The targeted physical mount's incumbent bounded crash diagnostic. */
    onTargetedSurfaceRenderFailure?: (surfaceId: string, error: Error) => void;
    /**
     * The canonical controller-owned mount lifetime. The renderer owns its
     * RenderContext signal, but must retire it when the physical host retires
     * even if a private A→B presentation callback keeps this React tree alive.
     */
    mountLifetime: BoundPluginSurfaceMountLifetime;
    interactionEnabled: boolean;
    /** Outer physical mount's one layout/route presentation eligibility fact. */
    focusEligible: boolean;
    /** One host-created client for the canonical mounted Account lifetime. */
    dataClient?: PluginUiDataClient | null;
    /**
     * EU-4b: the mount's live resource invalidation sink. Each event is
     * republished into the canonical adapter's ONE subscription registry, so
     * the author's `watchResource` listener observes it.
     */
    subscribeResourceInvalidations?: (
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
    ) => () => void;
    launchInput?: PluginUiLaunchInputV1;
    subPath?: PluginUiSubPathV1;
    canonicalRenderIdentity: Readonly<{
        pluginId: string;
        pluginVersion: string;
        viewId: string;
        mount: SurfaceContext['mount'];
        generation: string;
        platform: string;
        sessionId?: string | null;
        target: PluginSurfaceTarget;
        accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
        translations: Readonly<Record<string, string>>;
        /** Exact daemon-admitted target snapshot for the sole Host API mount. */
        targetedContributions: SurfaceContext['targetedContributions'];
        /** Manifest/projection-owned brand; never supplied by the artifact. */
        brand?: PluginUiPresentationBrand;
        /**
         * A closed exact-target resolver for host-owned installed-package brand
         * presentation. This stays in private entry bindings, never RenderContext.
         */
        brandTargetPresentation?: Readonly<{
            fallbackBrandDisplayName: string;
            resolveBrandTarget(pluginId: string): PluginUiPrivateBrandTarget | undefined;
            machineId: string | null | undefined;
            serverId: string | null | undefined;
            isCurrent: () => boolean;
        }>;
        /** Host-only currentness source; the public RenderContext never carries it. */
        accountLifetime: ActiveServerAccountScopeLifetime | null;
    }>;
    crashStateToken?: DaemonPluginReactNativeCrashStateV1['token'];
    /** Host-private binding for watchdog persistence; never part of RenderContext. */
    crashReportScopeKey?: string;
    crashStateDisabled?: boolean;
    reportFailure?: (failure: PluginReactNativePendingFailure) => Promise<ReactNativeCrashReportResult>;
    resetCrashState?: () => Promise<ReactNativeCrashReportResult>;
    /** Composer-only private carrier; never part of the public RenderContext. */
    composerRef?: ComposerRefV1;
    /** Exact Composer bridge into this adapter's existing subscription registry. */
    setComposerSubscriptionPublisher?: (
        publisher: PluginSurfaceComposerSubscriptionPublisher | undefined,
    ) => void;
    /** Parent-only bridge into the same generalized physical mount owner. */
    renderTargetedSurface?: (input: PluginUiPrivateTargetedSurfacePresentation) => React.ReactNode;
    /** Targeted children cannot become another active targeted-surface parent. */
    targetedSurfaceUnavailableReason?: 'unsupported_nested_targeted_surface';
}>): React.ReactElement {
    const canonicalIdentity = props.canonicalRenderIdentity;
    // One context owner (§3.2): the environment facts, the exact target and the
    // plugin's translation bundle all come from `pluginSurfaceContext.ts`, the
    // same module the hosted-web mount consumes.
    const environment = usePluginSurfaceEnvironment(canonicalIdentity.platform);
    const canonicalRenderIdentity = React.useMemo(() => {
        return Object.freeze({
            pluginId: canonicalIdentity.pluginId,
            pluginVersion: canonicalIdentity.pluginVersion,
            viewId: canonicalIdentity.viewId,
            mount: canonicalIdentity.mount,
            generation: canonicalIdentity.generation,
            platform: canonicalIdentity.platform,
            sessionId: canonicalIdentity.sessionId,
            target: canonicalIdentity.target,
            accountEncryptionMode: canonicalIdentity.accountEncryptionMode,
            brand: canonicalIdentity.brand,
            targetedContributions: canonicalIdentity.targetedContributions,
            surface: createPluginSurfaceContext({
                mount: canonicalIdentity.mount,
                target: canonicalIdentity.target,
                accountEncryptionMode: canonicalIdentity.accountEncryptionMode,
                environment,
                translations: canonicalIdentity.translations,
                targetedContributions: canonicalIdentity.targetedContributions,
            }),
        });
    }, [
        canonicalIdentity.generation,
        canonicalIdentity.mount,
        canonicalIdentity.platform,
        canonicalIdentity.pluginId,
        canonicalIdentity.pluginVersion,
        canonicalIdentity.sessionId,
        canonicalIdentity.target,
        canonicalIdentity.targetedContributions,
        canonicalIdentity.translations,
        canonicalIdentity.viewId,
        canonicalIdentity.brand,
        canonicalIdentity.accountEncryptionMode,
        environment,
    ]);

    // UI-D03: the adapter's lifetime is the MOUNT's, not the surface snapshot's.
    // Environment facts (locale, theme, contrast, text scale, motion, screen
    // reader, safe areas) change often; rebuilding the adapter for each of them
    // would retire every `watchContext` subscription the plugin holds, which is
    // exactly why the previous adapter could only ever emit one snapshot. The
    // adapter is therefore keyed on the surface IDENTITY and receives context
    // changes through its push producer below.
    const canonicalSurfaceRef = React.useRef(canonicalRenderIdentity.surface);
    canonicalSurfaceRef.current = canonicalRenderIdentity.surface;
    const canonicalAdapterKey = [
            canonicalRenderIdentity.pluginId,
            canonicalRenderIdentity.pluginVersion,
            canonicalRenderIdentity.viewId,
            JSON.stringify(canonicalRenderIdentity.mount),
            canonicalRenderIdentity.generation,
            canonicalRenderIdentity.platform,
            canonicalRenderIdentity.sessionId ?? '',
            getPluginSurfaceTargetAuthorityKey(canonicalRenderIdentity.target),
            canonicalRenderIdentity.targetedContributions.target.pluginId,
            canonicalRenderIdentity.targetedContributions.target.immutableGenerationId,
            props.mountInstanceKey ?? '',
    ].join('\u001f');
    const canonicalAccountLifetime = canonicalIdentity.accountLifetime;
    const canonicalHostApiAdapter = React.useMemo(() => {
        const surface = canonicalSurfaceRef.current;
        return createCanonicalPluginReactNativeHostApiAdapter({
            surface,
            requestSurface: props.requestSurface,
            requestIdPrefix: `rn-v2:${canonicalAdapterKey}`,
            handleRequest: props.hostApi.handleRequest,
            installedMethods: props.hostApi.installedMethods,
            getInstalledMethods: () => props.hostApi.installedMethods,
            getAdmissionMethods: () => props.hostApi.admissionMethods,
            isCurrent: props.mountLifetime.isCurrent,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- the surface is read
        // through a ref on purpose; see the push producer below.
    }, [canonicalAdapterKey, canonicalAccountLifetime, props.hostApi, props.mountLifetime, props.requestSurface]);
    // The context producer (UI-D03). Every established `watchContext` subscriber
    // observes the new facts; an identical snapshot is not republished, so the
    // mount push at establishment time is not a spurious event.
    React.useEffect(() => {
        canonicalHostApiAdapter.pushSurfaceContext(canonicalRenderIdentity.surface);
    }, [canonicalHostApiAdapter, canonicalRenderIdentity.surface]);
    // EU-4b: the mount's one invalidation sink reaches the adapter's existing
    // subscription registry. No second registry, and nothing else publishes.
    const subscribeResourceInvalidations = props.subscribeResourceInvalidations;
    React.useEffect(() => {
        if (!subscribeResourceInvalidations) return;
        return subscribeResourceInvalidations((event) => {
            canonicalHostApiAdapter.publishResourceSubscriptionEvent(event);
        });
    }, [canonicalHostApiAdapter, subscribeResourceInvalidations]);
    const setComposerSubscriptionPublisher = props.setComposerSubscriptionPublisher;
    const composerSubscriptionPublisher = setComposerSubscriptionPublisher !== undefined
        && props.hostApi.installedMethods.includes('watchComposer')
        ? canonicalHostApiAdapter.publishComposerSubscriptionEvent
        : undefined;
    // Composer document observation stays owned by the scope adapter. Any
    // exact mount that factually installed `watchComposer` may lend this
    // adapter's one publisher, while `composerRef` remains private to actual
    // Composer-bound mounts.
    React.useLayoutEffect(() => {
        if (!setComposerSubscriptionPublisher) return;
        setComposerSubscriptionPublisher(composerSubscriptionPublisher);
        return () => setComposerSubscriptionPublisher(undefined);
    }, [composerSubscriptionPublisher, setComposerSubscriptionPublisher]);
    // The bound controller already owns every semantic mount replacement and
    // retirement fact. Response-local context objects may refresh while it
    // remains current, so they must never create a second author lifetime.
    const abortController = React.useMemo(() => new AbortController(), [props.mountLifetime]);
    const presentationFocusEligibleRef = React.useRef(props.focusEligible);
    presentationFocusEligibleRef.current = props.focusEligible;
    const interactionEnabledRef = React.useRef(props.interactionEnabled);
    interactionEnabledRef.current = props.interactionEnabled;
    // The outer layout owns presentation eligibility. Keep it in a ref so an
    // opaque target obtained before A→B/tab/route changes is checked against
    // the latest fact without recreating this physical surface host.
    const isFocusEligible = React.useCallback(() => (
        props.mountLifetime.isCurrent()
        && !abortController.signal.aborted
        && interactionEnabledRef.current
        && presentationFocusEligibleRef.current
    ), [abortController.signal, props.mountLifetime]);
    const canonicalPrivateResourceMountScope = React.useMemo(
        () => createPluginUiPrivateResourceMountScope({
            pluginId: canonicalIdentity.pluginId,
            accountLifetime: canonicalAccountLifetime,
            mountLifetime: props.mountLifetime,
            generation: canonicalIdentity.generation,
        }),
        [
            canonicalAccountLifetime,
            canonicalIdentity.generation,
            canonicalIdentity.pluginId,
            props.mountInstanceKey,
            props.mountLifetime,
        ],
    );
    // Availability responses recreate this private wrapper even when its target
    // facts are unchanged. The mounted host keeps the latest controller
    // currentness predicate through this ref, while its identity remains owned
    // by the meaningful brand target facts below.
    const brandTargetPresentation = canonicalIdentity.brandTargetPresentation;
    const brandTargetPresentationCurrentRef = React.useRef(brandTargetPresentation?.isCurrent);
    brandTargetPresentationCurrentRef.current = brandTargetPresentation?.isCurrent;
    const isBrandTargetPresentationCurrent = React.useCallback(() => (
        brandTargetPresentationCurrentRef.current?.() === true
    ), []);
    // Targeted mount resolution is refreshed from the daemon projection. Keep
    // the private host's bridge stable and delegate through the latest exact
    // resolver, just as the Host API adapter pushes current context through its
    // existing physical mount rather than treating a response object as a new
    // author lifetime.
    const renderTargetedSurfaceRef = React.useRef(props.renderTargetedSurface);
    renderTargetedSurfaceRef.current = props.renderTargetedSurface;
    const renderTargetedSurface = React.useCallback((
        input: PluginUiPrivateTargetedSurfacePresentation,
    ): React.ReactNode => renderTargetedSurfaceRef.current?.(input), []);
    const hasRenderTargetedSurface = props.renderTargetedSurface !== undefined;
    const canonicalTargetAuthorityKey = getPluginSurfaceTargetAuthorityKey(canonicalRenderIdentity.target);
    const canonicalPrivatePresentationHost = React.useMemo(
        () => createPluginUiPrivatePresentationHost(
            canonicalRenderIdentity.brand,
            {
                ...(brandTargetPresentation
                    ? {
                        resolveBrandTarget: brandTargetPresentation.resolveBrandTarget,
                        fallbackBrandDisplayName: brandTargetPresentation.fallbackBrandDisplayName,
                        brandPresentationInput: {
                            machineId: brandTargetPresentation.machineId,
                            serverId: brandTargetPresentation.serverId,
                            expectedGeneration: canonicalRenderIdentity.generation,
                            signal: abortController.signal,
                            accountLifetime: canonicalAccountLifetime,
                            isCurrent: isBrandTargetPresentationCurrent,
                        },
                    }
                    : {}),
                ...(hasRenderTargetedSurface === false
                    ? {}
                    : { renderTargetedSurface }),
                ...(props.targetedSurfaceUnavailableReason === undefined
                    ? {}
                    : { targetedSurfaceUnavailableReason: props.targetedSurfaceUnavailableReason }),
                isFocusEligible,
            },
        ),
        [
            abortController.signal,
            canonicalAccountLifetime,
            canonicalRenderIdentity.brand,
            canonicalRenderIdentity.generation,
            brandTargetPresentation?.fallbackBrandDisplayName,
            brandTargetPresentation?.machineId,
            brandTargetPresentation?.resolveBrandTarget,
            brandTargetPresentation?.serverId,
            canonicalTargetAuthorityKey,
            hasRenderTargetedSurface,
            isFocusEligible,
            isBrandTargetPresentationCurrent,
            renderTargetedSurface,
            props.targetedSurfaceUnavailableReason,
        ],
    );
    const canonicalPrivateDataClient = props.dataClient ?? undefined;
    const canonicalPrivateHostBindings = React.useMemo(() => Object.freeze({
        accountLifetime: canonicalPrivateResourceMountScope.accountLifetime,
        resourceStoreGeneration: canonicalPrivateResourceMountScope.generation,
        ...(canonicalPrivatePresentationHost === undefined
            ? {}
            : { presentationHost: canonicalPrivatePresentationHost }),
        ...(canonicalPrivateDataClient === undefined
            ? {}
            : { dataClient: canonicalPrivateDataClient }),
        ...(props.composerRef === undefined
            ? {}
            : { composerRef: props.composerRef }),
    }), [
        canonicalPrivateDataClient,
        canonicalPrivatePresentationHost,
        canonicalPrivateResourceMountScope,
        props.composerRef,
    ]);
    const canonicalRenderContext = React.useMemo<RenderContext>(() => {
        const identity = canonicalRenderIdentity;
        const context = {
            plugin: Object.freeze({ id: identity.pluginId, version: identity.pluginVersion }),
            surface: identity.surface,
            hostApi: canonicalHostApiAdapter.api,
            signal: abortController.signal,
            // EU-5a: absent launch input stays absent. Spreading a `{ launchInput:
            // undefined }` key would make "opened without input" indistinguishable
            // from "opened with an explicit undefined" for an author reading the key.
            ...(props.launchInput === undefined ? {} : { launchInput: props.launchInput }),
            // EU-5b: the page's own location. Absent on every placement that is
            // not a page, and `''` at a page root — the two are different facts.
            ...(props.subPath === undefined ? {} : { subPath: props.subPath }),
        } satisfies RenderContext;
        return Object.freeze(context);
    }, [
        abortController.signal,
        canonicalHostApiAdapter,
        canonicalRenderIdentity,
        props.launchInput,
        props.subPath,
    ]);

    React.useLayoutEffect(() => () => {
        canonicalHostApiAdapter.dispose();
    }, [canonicalHostApiAdapter]);
    React.useLayoutEffect(() => {
        const retirement = props.mountLifetime.onRetire(() => {
            abortController.abort();
        });
        return () => retirement.dispose();
    }, [abortController, props.mountLifetime]);
    React.useLayoutEffect(() => () => {
        abortController.abort();
    }, [abortController]);

    return (
        <PluginReactNativeSurface
            surfaceId={props.surfaceId}
            mountInstanceKey={props.mountInstanceKey}
            snapshotTitle={props.snapshotTitle}
            decision={props.decision}
            {...(props.loadPolicy ? { loadPolicy: props.loadPolicy } : {})}
            {...(props.cacheKey ? { cacheKey: props.cacheKey } : {})}
            load={props.load}
            renderContext={canonicalRenderContext}
            {...(props.targetedFallback === undefined ? {} : { targetedFallback: props.targetedFallback })}
            {...(props.onTargetedSurfaceRenderFailure ? { onCrash: props.onTargetedSurfaceRenderFailure } : {})}
            privateHostBindings={canonicalPrivateHostBindings}
            interactionEnabled={props.interactionEnabled}
            focusEligible={props.focusEligible}
            {...(props.crashStateToken ? { crashStateToken: props.crashStateToken } : {})}
            {...(props.crashReportScopeKey ? { crashReportScopeKey: props.crashReportScopeKey } : {})}
            {...(props.crashStateDisabled === undefined ? {} : { crashStateDisabled: props.crashStateDisabled })}
            {...(props.reportFailure ? { reportFailure: props.reportFailure } : {})}
            {...(props.resetCrashState ? { resetCrashState: props.resetCrashState } : {})}
        />
    );
}

function readReactNativeRuntimeState(entry: Readonly<Record<string, unknown>> | null): Readonly<{
    decision: PluginReactNativeCompatibilityDecision;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    cacheIdentity?: PluginReactNativeBundleCacheIdentity;
}> | null {
    const runtime = readRecord(entry?.runtime);
    const decision = readRecord(runtime?.decision);
    if (!runtime || !decision) {
        return null;
    }

    const state = decision.state;
    const reason = decision.reason;
    if (
        (state !== 'load' && state !== 'fallback' && state !== 'disabled' && state !== 'blocked')
        || typeof reason !== 'string'
    ) {
        return null;
    }

    const normalizedDecision = Object.freeze({
        state,
        reason: reason as PluginReactNativeCompatibilityDecision['reason'],
        diagnostics: Object.freeze(readStringArray(decision.diagnostics)),
        ...(readFallbackRef(decision.fallback) ? { fallback: readFallbackRef(decision.fallback) } : {}),
    });
    // A durable crash tombstone never carries executable identity into the
    // renderer, including when an older producer still includes those fields.
    if (state === 'disabled') {
        return Object.freeze({ decision: normalizedDecision });
    }

    const loadPolicy = readRecord(runtime.loadPolicy);
    const source = loadPolicy?.source;
    // RN-2: propagate the dev-hot-reload `devUrl` (the local dev-server `AccessEndpoint`)
    // from the cli projection through to the host loader policy so the dev LOAD path
    // is reachable. Without it, a `devHotReload` source can never resolve loadable.
    const devUrl = readOptionalString(loadPolicy?.devUrl);
    const cacheKey = runtime.cacheKey;
    const cacheIdentity = readPluginUiReactNativeBundleCacheIdentity(runtime.cacheIdentity);
    return Object.freeze({
        decision: normalizedDecision,
        ...(source === 'installedArtifact' || source === 'devHotReload'
            ? {
                loadPolicy: Object.freeze({
                    source,
                    ...(source === 'devHotReload' && devUrl ? { devUrl } : {}),
                }) as PluginReactNativeLoaderPolicyInput,
            }
            : {}),
        ...(typeof cacheKey === 'string' && cacheKey.trim().length > 0 ? { cacheKey } : {}),
        ...(cacheIdentity ? { cacheIdentity } : {}),
    });
}

/** The surface descriptor, not the renderer bundle, publishes this exact state. */
function readDescriptorReactNativeCrashState(
    descriptor: PluginSurfaceHostDescriptor,
): DaemonPluginReactNativeCrashStateV1 | null {
    const parsed = DaemonPluginReactNativeCrashStateV1Schema.safeParse(
        readRecord(descriptor.runtime)?.reactNativeCrashState,
    );
    return parsed.success ? parsed.data : null;
}

function isExactDescriptorReactNativeCrashState(input: Readonly<{
    state: DaemonPluginReactNativeCrashStateV1;
    binding: PluginUiDestinationBindingV1;
    renderer: Readonly<Record<string, unknown>>;
    artifactDigest: string | null;
}>): boolean {
    const rendererId = readRendererBindingId(input.renderer);
    return rendererId !== null
        && input.state.token.mount.kind === 'destination'
        && input.state.token.mount.destination.pluginId === input.binding.destination.pluginId
        && input.state.token.mount.destination.localId === input.binding.destination.localId
        && input.state.token.renderer.pluginId === input.binding.destination.pluginId
        && input.state.token.renderer.localId === rendererId
        && input.artifactDigest !== null
        && input.state.token.artifactDigest === input.artifactDigest;
}

function sameTargetedReactNativeCrashMount(
    left: Extract<DaemonPluginReactNativeCrashStateV1['token']['mount'], Readonly<{ kind: 'targetedSurface' }>>,
    right: DaemonPluginUiTargetedSurfaceMountIdentityV1,
): boolean {
    return left.target.pluginId === right.target.pluginId
        && left.target.immutableGenerationId === right.target.immutableGenerationId
        && left.point.pointId === right.point.pointId
        && left.point.protocol.id === right.point.protocol.id
        && left.point.protocol.version === right.point.protocol.version
        && left.contributor.pluginId === right.contributor.pluginId
        && left.contributor.contributionId === right.contributor.contributionId
        && left.contributor.immutableGenerationId === right.contributor.immutableGenerationId
        && left.role === right.role
        && left.presentation === right.presentation;
}

function isExactTargetedReactNativeCrashState(input: Readonly<{
    state: DaemonPluginReactNativeCrashStateV1;
    mount: DaemonPluginUiTargetedSurfaceMountV1;
    artifactDigest: string | null;
}>): boolean {
    const tokenMount = input.state.token.mount;
    return tokenMount.kind === 'targetedSurface'
        && sameTargetedReactNativeCrashMount(tokenMount, input.mount)
        && input.state.token.renderer.pluginId === input.mount.selectedRenderer.identity.pluginId
        && input.state.token.renderer.localId === input.mount.selectedRenderer.identity.localId
        && input.artifactDigest !== null
        && input.state.token.artifactDigest === input.artifactDigest;
}

function sameComposerReactNativeCrashMount(
    left: Extract<DaemonPluginReactNativeCrashStateV1['token']['mount'], Readonly<{ kind: 'composer' }>>,
    right: DaemonPluginUiComposerSurfaceCatalogEntryV1,
): boolean {
    return left.contribution.pluginId === right.contribution.pluginId
        && left.contribution.localId === right.contribution.localId
        && left.immutableGenerationId === right.immutableGenerationId
        && left.role === right.role;
}

function isExactComposerReactNativeCrashState(input: Readonly<{
    state: DaemonPluginReactNativeCrashStateV1;
    catalogEntry: DaemonPluginUiComposerSurfaceCatalogEntryV1;
    artifactDigest: string | null;
}>): boolean {
    const tokenMount = input.state.token.mount;
    return tokenMount.kind === 'composer'
        && sameComposerReactNativeCrashMount(tokenMount, input.catalogEntry)
        && input.state.token.renderer.pluginId === input.catalogEntry.selectedRenderer.identity.pluginId
        && input.state.token.renderer.localId === input.catalogEntry.selectedRenderer.identity.localId
        && input.artifactDigest !== null
        && input.state.token.artifactDigest === input.artifactDigest;
}

function readBrowserViewTarget(value: unknown): BrowserViewTargetV1 | null {
    const result = BrowserViewTargetV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function readSurfaceBrowserTarget(params: Readonly<{
    resourceBrowserTarget?: unknown;
    descriptor: PluginSurfaceHostDescriptor;
}>): BrowserViewTargetV1 | null {
    return readBrowserViewTarget(params.resourceBrowserTarget)
        ?? readBrowserViewTarget(params.descriptor.browserTarget);
}

/**
 * Legacy daemon static-asset previews register a local-service preview under
 * the canonical `plugin-static:<pluginId>:<contributionId>:<sessionId>:<machineId>`
 * id. Only that historical Session-scoped producer may synthesize this target.
 * Generated V2 packaged artifacts use their Artifact lease/cache identity and
 * must never turn a stale `runtimeMode` field into a competing loopback source.
 */
function resolveHostedWebStaticAssetBrowserTarget(params: Readonly<{
    contribution: Readonly<Record<string, unknown>> | null;
    sessionId: string | null | undefined;
    machineId: string | null | undefined;
}>): BrowserViewTargetV1 | null {
    if (params.contribution?.generatedV2 === true) {
        return null;
    }
    const runtimeMode = readRecord(params.contribution?.runtimeMode);
    if (runtimeMode?.kind !== 'installedStaticAssets') {
        return null;
    }
    const pluginId = readOptionalString(params.contribution?.pluginId);
    const contributionId = readOptionalString(params.contribution?.contributionId);
    const sessionId = readOptionalString(params.sessionId);
    const machineId = readOptionalString(params.machineId);
    if (!pluginId || !contributionId || !sessionId || !machineId) {
        return null;
    }
    return {
        kind: 'localServicePreview',
        targetId: buildPluginHostedWebStaticAssetPreviewId({
            pluginId,
            contributionId,
            sessionId,
            machineId,
        }),
        sessionId,
        machineId,
    };
}

/**
 * Resolve the `{ targetKind, resourceScope }` from the already-admitted binding.
 * The UI host never reconstructs this from a legacy placement id or its duplicate
 * descriptor fields: Registry/CLI admission owns the binding and the bound host
 * consumes its exact target for every renderer.
 */
function resolveSurfaceResourceScope(binding: PluginUiDestinationBindingV1 | null) {
    return resolveResourceScope(binding?.target ?? null);
}

function readRendererBindingId(renderer: Readonly<Record<string, unknown>>): string | null {
    return readOptionalString(renderer.contributionId) ?? null;
}

function resolveHostedWebProjectionMount(params: Readonly<{
    pluginId: string;
    contributionId: unknown;
    entriesById: Readonly<Record<string, unknown>>;
}>): Readonly<{
    contributionId: string;
    contribution: Readonly<Record<string, unknown>> | null;
}> | null {
    const contributionId = resolvePluginUiProjectionContributionId({
        family: 'hostedWeb',
        pluginId: params.pluginId,
        contributionId: params.contributionId,
        entriesById: params.entriesById,
    });
    if (!contributionId) {
        return null;
    }
    return Object.freeze({
        contributionId,
        contribution: readRecord(params.entriesById[contributionId]),
    });
}

type PluginSurfaceRenderGateDecision =
    | Readonly<{ canRender: true }>
    | Readonly<{ canRender: false; reason: string }>;

function firstDiagnosticOrReason(
    diagnostics: readonly string[],
    fallback: string,
): string {
    const diagnostic = diagnostics.find((entry) => entry.trim().length > 0);
    return diagnostic ?? fallback;
}

function normalizeUnavailableReason(reason: string): string {
    return reason === 'feature_gate_disabled' ? 'feature_disabled' : reason;
}

function resolvePluginSurfaceDescriptorRenderGate(
    descriptor: PluginSurfaceHostDescriptor,
    policyContext: PluginUiPolicyEvaluationContext,
    allowReactNativeCrashReset = false,
): PluginSurfaceRenderGateDecision {
    const policyDecision = evaluatePluginUiPolicy(descriptor, policyContext);
    if (!policyDecision.visible) {
        return {
            canRender: false,
            reason: normalizeUnavailableReason(firstDiagnosticOrReason(
                policyDecision.diagnostics,
                'policy_unavailable',
            )),
        };
    }
    if (descriptor.contributionKind !== 'surfacePlacement' && descriptor.contributionKind !== 'settingsPage') {
        return { canRender: true };
    }
    const availability = readRecord(descriptor.availability);
    if (availability?.state !== 'available') {
        if (
            allowReactNativeCrashReset
            && availability?.state === 'disabled'
            && readOptionalString(availability.reason) === 'crash_disabled'
        ) {
            return { canRender: true };
        }
        return {
            canRender: false,
            reason: normalizeUnavailableReason(
                readOptionalString(availability?.reason)
                    ?? firstDiagnosticOrReason(readStringArray(availability?.diagnostics), 'surface_unavailable'),
            ),
        };
    }
    return { canRender: true };
}

function renderPluginSurfaceUnavailable(
    reasonCode: string,
    action?: SurfaceStateAction,
): React.ReactElement {
    return (
        <PluginSurfaceFallback
            testID="plugin-surface-unavailable"
            reasonCode={reasonCode}
            action={action}
            accessibilitySemantics="status"
        />
    );
}

/**
 * B is supplied only by the response-local A→B adapter. Its target is the
 * already-resolved physical parent target; it is presentation context only,
 * never a destination binding or a source of B Actions/Resources.
 */
export type PluginSurfaceTargetedMountProps = Readonly<{
    request: TargetedPluginSurfaceMountRequest;
    physicalTarget: PluginSurfaceTarget;
    /** The existing A controller lifetime that B must compose, never replace. */
    parentLifetime: BoundPluginSurfaceMountLifetime;
    /** Exact V2 response generation that contained the correlated A→B mount. */
    projectionGeneration?: number | string | null;
    /** Exact response-local projection map; never a broad app projection lookup. */
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    /** Exact response-local V2 package/translation facts for B presentation. */
    pluginProjectionV2?: PluginProjectionV2 | null;
    /**
     * The response-local daemon authority is ready. Retained exact target facts
     * may keep B presented during revalidation, but daemon mutations remain
     * unavailable until the next authoritative response settles.
     */
    daemonProjectionReady: boolean;
}>;

/**
 * The one live Composer arm of the generalized physical surface host. The
 * caller has already paired a host-stamped mount with the daemon's exact
 * current catalog row; this host consumes those facts without selecting a
 * renderer, inventing a destination, or retaining a Composer registry.
 */
export type PluginSurfaceComposerMountProps = Readonly<{
    mount: PluginSurfaceComposerMountBinding;
    /** The real physical target for generic Resource/context semantics. */
    physicalTarget: PluginSurfaceTarget;
    /** The incumbent Composer scope lifetime; this host only observes it. */
    parentLifetime: BoundPluginSurfaceMountLifetime;
    /** Exact response-local action projection for the admitted generation. */
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    /** Exact current V2 projection for translations/package presentation. */
    pluginProjectionV2?: PluginProjectionV2 | null;
    /** Mutation admission remains closed until this current response is ready. */
    daemonProjectionReady: boolean;
    /** Optional semantic Composer handlers supplied by the scope owner. */
    binding?: BoundPluginSurfaceBinding;
    /**
     * The current physical renderer lends its established publication sink to
     * the exact Composer document owner when this mount factually installs
     * `watchComposer`.
     */
    setComposerSubscriptionPublisher?: (
        publisher: PluginSurfaceComposerSubscriptionPublisher | undefined,
    ) => void;
}>;

type PluginSurfaceHostDestinationInput = Readonly<{
    descriptor: PluginSurfaceHostDescriptor;
    renderer: Readonly<Record<string, unknown>>;
    targetedMount?: never;
    composerMount?: never;
}>;

type PluginSurfaceHostTargetedInput = Readonly<{
    descriptor?: never;
    renderer?: never;
    targetedMount: PluginSurfaceTargetedMountProps;
    composerMount?: never;
}>;

type PluginSurfaceHostComposerInput = Readonly<{
    descriptor?: never;
    renderer?: never;
    targetedMount?: never;
    composerMount: PluginSurfaceComposerMountProps;
}>;

export function PluginSurfaceHost(props: Readonly<(
    PluginSurfaceHostDestinationInput | PluginSurfaceHostTargetedInput | PluginSurfaceHostComposerInput
) & {
    resourceBrowserTarget?: unknown;
    machineId?: string | null;
    serverId?: string | null;
    /** Explicit Settings-route daemon target; `null` intentionally disables origin fallback. */
    daemonSettingsTarget?: ScopedPluginSettingsDaemonTarget | null;
    isDaemonSettingsTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Settings-only availability is independent of this mount's action bridge. */
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
    sessionId?: string | null;
    agentId?: string | null;
    /** §3.2: the exact identities this placement owns for its declared target. */
    projectId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    platform?: LocalServicePreviewPlatform;
    /** Runtime-only host observation; never an authored destination field. */
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
    channel?: PluginUiChannelV1;
    nowMs?: () => number;
    /**
     * §3.1: the extras THIS placement owns — its destination selector and any
     * host-ActionSpec front door it must scope itself. Everything else the mount
     * needs is derived by the bound controller from the facts above; a placement
     * never hands the host a pre-composed API.
     */
    binding?: BoundPluginSurfaceBinding;
    /** EU-5a: the launch input the opener passed for THIS selected placement. */
    launchInput?: PluginUiLaunchInputV1;
    /** Resolver-stamped ephemeral instance identity; absent for legacy singleton mounts. */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** Route-owned recovery for generic destination unavailability; targeted mounts keep their caller fallback. */
    unavailableAction?: SurfaceStateAction;
    /**
     * EU-5b: the plugin-local location for a full-page (`app.page`) mount — the
     * remainder of the host-generated route after the page root. Absent at every
     * placement that has no location under it.
     */
    subPath?: PluginUiSubPathV1;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
}>): React.ReactElement | null {
    const targetedMount = 'targetedMount' in props ? props.targetedMount : undefined;
    const composerMount = 'composerMount' in props ? props.composerMount : undefined;
    const targetedRequest = targetedMount?.request;
    const targetedBinding = targetedRequest?.mount ?? null;
    const composerBinding = composerMount?.mount ?? null;
    const hasEmbeddedMount = targetedBinding !== null || composerBinding !== null;
    const descriptor = hasEmbeddedMount ? null : props.descriptor;
    const renderer = targetedBinding
        ? targetedBinding.renderer as Readonly<Record<string, unknown>>
        : composerBinding
            ? composerBinding.renderer as Readonly<Record<string, unknown>>
            : props.renderer!;
    // Embedded children consume the daemon's exact selected artifact entry
    // verbatim; neither arm looks the contributor up in a broad UI projection.
    const selectedEmbeddedRenderer = targetedBinding?.mount.selectedRenderer
        ?? composerBinding?.catalogEntry.selectedRenderer
        ?? null;
    const mountedRendererArtifact = selectedEmbeddedRenderer?.artifactProjection
        ? selectedEmbeddedRenderer.artifactProjection as Readonly<Record<string, unknown>>
        : null;
    const mountedPluginId = targetedBinding?.mount.contributor.pluginId
        ?? composerBinding?.mount.contribution.pluginId
        ?? descriptor!.pluginId;
    const mountedContributionId = targetedBinding?.mount.contributor.contributionId
        ?? composerBinding?.mount.contribution.localId
        ?? descriptor!.id;
    const mountedSurfaceId = targetedBinding
        ? `targeted:${targetedRequest!.instanceKey}`
        : composerBinding
            ? `composer:${composerBinding.mount.instanceKey}`
            : descriptor!.id;
    const mountedInstanceKey = targetedBinding
        ? targetedRequest!.instanceKey
        : composerBinding
            ? composerBinding.mount.instanceKey
            : props.mountInstanceKey;
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const mountBinding = targetedBinding
        ?? composerBinding
        ?? readPluginSurfaceMountBinding({ descriptor: descriptor!, renderer });
    const selectedDestinationBinding = mountBinding?.kind === 'destination'
        ? mountBinding.destinationBinding
        : null;
    // F7 — an app-scope projection is a UNION across every eligible online
    // machine, so the CONTRIBUTION carries the machine that produced it. Every
    // effect this mount performs — action dispatch, resource reads, artifact
    // fetches, crash reports, declarative settings — binds to that origin, its
    // generation and its executable authority, so a placement can never be
    // executed against a machine that merely had a newer heartbeat.
    //
    // A single-machine (session/project/browser/services) projection stamps no
    // origin, and there the mount's own facts remain authoritative.
    const origin = descriptor ? readPluginUiContributionOrigin(descriptor) : null;
    // The same producer-stamped origin backs both unioned and direct machine
    // projections. A mounted action never reconstructs this ref from UI facts.
    const executionOrigin = targetedBinding?.mount.executionOrigin
        ?? composerBinding?.catalogEntry.executionOrigin
        ?? origin?.executionOrigin
        ?? (descriptor ? readPluginUiProjectionEntryExecutionOrigin(descriptor) : undefined);
    // New daemon Artifact reads require Administration's exact producer stamp.
    // An already verified Account-scoped Artifact cache may still mount without
    // one; mount machine/server facts must never become an invented origin.
    const exactArtifactOrigin = executionOrigin && hasEmbeddedMount && props.serverId
        ? Object.freeze({
            executionOrigin,
            serverId: props.serverId,
        })
        : origin?.executionOrigin && origin.serverId
        ? Object.freeze({
            executionOrigin: origin.executionOrigin,
            serverId: origin.serverId,
        })
        : null;
    const machineId = executionOrigin?.materializationRef.machineId
        ?? origin?.machineId
        ?? props.machineId;
    const serverId = hasEmbeddedMount ? props.serverId : origin ? origin.serverId : props.serverId;
    const mountedComposerMediaExecutionTarget = React.useMemo<SessionExecutionTargetV1 | undefined>(() => (
        typeof serverId === 'string' && typeof machineId === 'string'
            ? Object.freeze({ serverId, machineId })
            : undefined
    ), [machineId, serverId]);
    const projectionGeneration = targetedBinding
        ? targetedMount?.projectionGeneration
        : composerBinding
            ? composerBinding.mount.projectionGeneration
        : origin ? origin.generation : props.pluginUiProjection?.generation;
    const artifactProjectionGeneration = typeof projectionGeneration === 'number'
        ? projectionGeneration
        : null;
    const mountedPluginUiProjection = React.useMemo(() => (
        targetedBinding
            ? normalizePluginUiProjection(targetedMount?.pluginProjectionV2 ?? null)
            : composerBinding
                ? normalizePluginUiProjection(composerMount?.pluginProjectionV2 ?? null)
                : props.pluginUiProjection ?? null
    ), [composerBinding, composerMount?.pluginProjectionV2, props.pluginUiProjection, targetedBinding, targetedMount?.pluginProjectionV2]);
    // The raw V2 Action map is the sole target source for the bound surface.
    // This closure is an exact lookup over that producer-owned snapshot, not a
    // second action registry or a synthesized legacy descriptor.
    // A daemon refresh rebuilds the raw V2 object graph even when its Action
    // authority is unchanged. The resolver is controller-facing, so retain it
    // across that equivalent producer snapshot; a changed raw map remains the
    // one fact that replaces the bound controller and its facade.
    const mountedProjectedActionsKey = stableJsonStringify(
        mountedPluginUiProjection?.actionsById ?? {},
    );
    const resolveContributedAction = React.useMemo(
        () => createPluginUiProjectedActionResolver(mountedPluginUiProjection?.actionsById),
        // `mountedProjectedActionsKey` includes every producer-owned Action
        // descriptor exposed by this exact projection.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [mountedProjectedActionsKey],
    );
    const projectionInteractionEnabled = selectedEmbeddedRenderer
        ? props.projectionInteractionEnabled !== false
            && selectedEmbeddedRenderer.availability.state === 'available'
        : origin
            ? origin.phase === 'current' && origin.interactionEnabled === true
            : props.projectionInteractionEnabled;
    const installedPackagesById = mountedPluginUiProjection?.installedPackagesById;
    const mountedTargetPluginId = hasEmbeddedMount ? null : selectedDestinationBinding?.destination.pluginId;
    const mountedTarget = React.useMemo(() => readMountedTarget({
        pluginId: mountedTargetPluginId,
        installedPackagesById,
    }), [installedPackagesById, mountedTargetPluginId]);
    // Every current public SurfaceContext carries this target-scoped snapshot;
    // an admitted empty point list is valid, but an absent/stale snapshot is not
    // silently rewritten into a legacy context.
    const mountedTargetSnapshotRequired = mountedTarget !== null;
    const mountedTargetProjection = useDaemonMergedProjectionInputs({
        machineId,
        serverId,
        enabled: mountedTargetSnapshotRequired,
        ...(mountedTargetSnapshotRequired ? { mountedTarget } : {}),
    });
    const mountedTargetInputs = !hasEmbeddedMount && hasExactMountedTargetedContributions(
        mountedTargetProjection.inputs?.targetedContributions,
        mountedTarget,
    )
        ? mountedTargetProjection.inputs
        : null;
    const targetedContributions = targetedBinding
        ? targetedBinding.mount.contributorTargetedContributions
        : composerBinding
            ? composerBinding.catalogEntry.contributorTargetedContributions
            : mountedTargetInputs?.targetedContributions ?? null;
    const preparedTargetedSurfaceMounts = !hasEmbeddedMount && hasExactMountedTargetedSurfaceMounts(
        mountedTargetProjection.inputs?.preparedTargetedSurfaceMounts,
        mountedTarget,
    )
        ? mountedTargetProjection.inputs?.preparedTargetedSurfaceMounts
        : undefined;
    // Dynamic declarative Resources are normalized in UI, but their target
    // inventory is still the exact same target-scoped daemon response that
    // supplied the parent context. Do not issue a second lookup or invent a
    // renderer/input-schema inventory from broad projections.
    const declarativeTargetedSurfaceInventory = React.useMemo(
        () => preparedTargetedSurfaceMounts !== undefined
            ? projectDeclarativeTargetedSurfaceInventory(preparedTargetedSurfaceMounts)
            : undefined,
        [preparedTargetedSurfaceMounts],
    );
    // A unioned contribution's origin is the exact producer authority. Unlike
    // a host-level projection action decision, a false origin fact says that
    // this contribution is no longer current at its owning daemon, so even a
    // Settings read must not target it.
    const originInteractionCurrent = selectedEmbeddedRenderer
        ? selectedEmbeddedRenderer.availability.state === 'available'
        : origin ? origin.phase === 'current' && origin.interactionEnabled === true : true;
    const daemonInteraction = usePluginSurfaceDaemonInteraction({
        machineId,
        projectionInteractionEnabled,
    });
    // §3.2 exact target: Registry/CLI owns the declared target through the
    // selected binding; this host supplies only the current destination facts.
    // Both React Native and hosted-web mounts consume this one resolution.
    const declaredBrowserTarget = descriptor
        ? readSurfaceBrowserTarget({
            resourceBrowserTarget: props.resourceBrowserTarget,
            descriptor,
        })
        : null;
    const declaredBrowserTargetUrl = declaredBrowserTarget?.kind === 'externalUrl'
        ? declaredBrowserTarget.url
        : null;
    // One scope resolution for this mount. An undeclared/unrecognized target kind
    // reaches the target resolver as `null`, which fails resolution there rather
    // than being coerced into a target the descriptor never declared.
    const surfaceScope = React.useMemo(
        () => targetedBinding
            ? Object.freeze({ declared: false as const, reason: 'surface_target_undeclared' as const })
            : composerBinding
                ? resolveResourceScope({ kind: 'session' })
            : resolveSurfaceResourceScope(selectedDestinationBinding),
        [composerBinding, selectedDestinationBinding, targetedBinding],
    );
    const surfaceTargetResolution = React.useMemo(() => resolvePluginSurfaceTarget({
        targetKind: surfaceScope.declared ? surfaceScope.targetKind : null,
        sessionId: props.sessionId,
        agentId: props.agentId,
        projectId: props.projectId,
        browserTarget: declaredBrowserTarget,
    }), [
        declaredBrowserTarget?.kind,
        declaredBrowserTarget?.targetId,
        declaredBrowserTargetUrl,
        props.agentId,
        props.projectId,
        props.sessionId,
        surfaceScope,
    ]);
    const resolvedSurfaceTarget: PluginSurfaceTargetResolution = targetedMount
        ? Object.freeze({ resolved: true as const, target: targetedMount.physicalTarget })
        : composerMount
            ? Object.freeze({ resolved: true as const, target: composerMount.physicalTarget })
        : surfaceTargetResolution;
    const surfaceTargetAuthorityKey = resolvedSurfaceTarget.resolved
        ? getPluginSurfaceTargetAuthorityKey(resolvedSurfaceTarget.target)
        : null;
    const surfaceLocale = getPreferredLanguage();
    const surfaceTranslations = React.useMemo(() => Object.freeze({
        ...resolvePluginUiTranslationBundle({
            projection: mountedPluginUiProjection,
            pluginId: mountedPluginId,
            locale: surfaceLocale,
        }),
        // Framework-owned chrome is projected after author strings so a plugin
        // cannot replace a fixed host action by declaring the same key.
        'happier.plugin-ui.form.submit': t('common.submit'),
        'happier.plugin-ui.form.cancel': t('common.cancel'),
        'happier.plugin-ui.action.execute': t('common.run'),
        'happier.plugin-ui.action.copy': t('common.copy'),
        'happier.plugin-ui.action.open': t('common.open'),
        'happier.plugin-ui.action.refresh': t('common.refresh'),
        'happier.plugin-ui.state.loading': t('ui.pluginUi.loading'),
        'happier.plugin-ui.state.empty': t('ui.pluginUi.empty'),
        'happier.plugin-ui.state.error': t('ui.pluginUi.error'),
        'happier.plugin-ui.list.moreActions': t('ui.pluginUi.moreActions'),
    }), [mountedPluginId, mountedPluginUiProjection, surfaceLocale]);
    const surfacePlatform = props.platform ?? 'web';
    const surfaceEnvironment = usePluginSurfaceEnvironment(surfacePlatform);
    // Read the surrounding route/tab eligibility exactly once at the generalized
    // physical mount, then lend the fact to every renderer interaction boundary.
    const presentationFocusEligible = usePluginSurfaceFocusEligibility();
    const inheritedCurrentUiContextFocusEligible = usePluginSurfaceCurrentUiContextEligibility();
    // A targeted B is a physical presentation child of its parent A. It may
    // inherit ordinary focus, but that inherited root fact must not make it a
    // second semantic-current publisher alongside the selected page mount.
    const currentUiContextFocusEligible = inheritedCurrentUiContextFocusEligible && targetedBinding === null;
    const currentUiContextMountLifecycleActive = useCurrentUiContextMountLifecycleActive();
    const currentUiContextMountPublisher = useCurrentUiContextMountPublisher();
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const runtimeFormFactor = props.formFactor ?? resolvePluginUiRuntimeFormFactor({
        // The surrounding pane/cockpit owns reactive layout updates. The
        // terminal mount needs a synchronous current snapshot only; subscribing
        // here would recreate controller-facing render state for every window
        // measurement before any destination fact changed.
        deviceType: getDeviceType(),
    });
    const surfaceChannel = props.channel ?? 'internal';
    // The Registry-normalized binding is the sole platform admission fact. A
    // conservative producer subset must not be widened back to the slot's
    // current default by this mount.
    const destinationPlatformSupported = selectedEmbeddedRenderer
        ? selectedEmbeddedRenderer.availability.state === 'available'
        : selectedDestinationBinding
        ? isPluginUiDestinationBindingAdmittedAtRuntimeV1({
            binding: selectedDestinationBinding,
            platform: surfacePlatform,
            formFactor: runtimeFormFactor,
        })
        : false;
    // Resource admission is a fact of the exact selected surface member. Do not
    // let a renderer contribution, a sibling replica, or a settings descriptor
    // grant it: those are not the selected Resource producer for this mount.
    const resourceCapability = targetedBinding
        ? targetedBinding.mount.resourceCapability
        : composerBinding
            ? composerBinding.catalogEntry.resourceCapability
        : selectedDestinationBinding
        && descriptor?.contributionKind === 'surfacePlacement'
        ? readSelectedPluginUiResourceCapability(descriptor)
        : undefined;
    // Capture the incumbent Account lifetime once for this mount. It remains an
    // opaque cancellation/currentness input: neither the surface host nor the
    // artifact learns an Account id or creates another epoch.
    //
    // Refresh on retirement so presentation fails closed synchronously even if
    // no unrelated parent state happens to rerender this host first. The active
    // Account-scope owner remains the only lifecycle owner; this mount merely
    // observes its existing retirement callback.
    const [, refreshAfterAccountRetirement] = React.useReducer((revision: number) => revision + 1, 0);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(refreshAfterAccountRetirement);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    const accountLocalInteractionEnabled = accountLifetime?.isCurrent() === true;
    // The Availability projection rematerializes an equivalent bound reader on
    // every AccountChange. A reader remains live for its bound Account scope,
    // so that update must not replace this mount's client (and reset its
    // Data-owned pager); a retirement/new Account lifetime does recreate it.
    const availabilityReaderRef = React.useRef(availabilityReader);
    availabilityReaderRef.current = availabilityReader;
    const hasAvailabilityReader = availabilityReader !== null;
    // Client construction alone is not a renderer admission fact: every active
    // Account exposes the bound reader. Availability remains the one owner of
    // whether this exact current release has an Account Collection contract to
    // read/watch; it neither leaks the contract inventory nor grants CAS.
    const currentAccountCollectionCapability = availabilityReader?.readCurrentCollectionCapability({
        pluginId: mountedPluginId,
    });
    const accountCollectionRendererEligible = currentAccountCollectionCapability?.kind === 'available';
    // One client belongs to this mounted plugin and its captured Account
    // lifetime. It is only a thin adapter over the Data owner: no UI cache,
    // query planner, cursor, watcher, or competing Account epoch lives here.
    const mountedPluginUiDataClient = React.useMemo(
        () => {
            const reader = availabilityReaderRef.current;
            return accountLifetime && reader
                ? createPluginUiDataClient({
                    pluginId: mountedPluginId,
                    accountLifetime,
                    availabilityReader: reader,
                })
                : null;
        },
        [accountLifetime, mountedPluginId, hasAvailabilityReader],
    );
    // The hosted frame gets the same mounted, Account-lifetime-bound Data
    // client as the declarative and React Native consumers. Its framed
    // lifecycle owns request/cancel/currentness; Data remains the only owner
    // of queries, cursors, snapshots, and Account retirement.
    const createMountedHostedWebCollectionUiQueryBridge = React.useMemo(
        () => mountedPluginUiDataClient
            ? ({ publish }: Readonly<{ publish: Parameters<typeof createHostedWebCollectionUiQueryBridge>[0]['publish'] }>) => (
                createHostedWebCollectionUiQueryBridge({
                    dataClient: mountedPluginUiDataClient,
                    publish,
                })
            )
            : undefined,
        [mountedPluginUiDataClient],
    );
    // A renderer whose current release admits Account Collection Data remains
    // usable through a daemon outage: its reads/CAS keep their own scoped
    // currentness and transport authority. Do not make client construction a
    // general offline admission — a zero-Collection release keeps the existing
    // exact daemon/endpoint gate. The controller separately owns the factual
    // daemon-backed Action/Resource method set; no renderer infers it.
    const localControllerInteractionEnabled = accountLocalInteractionEnabled
        && projectionInteractionEnabled !== false
        && originInteractionCurrent;
    const rendererInteractionEnabled = localControllerInteractionEnabled
        && (
            accountCollectionRendererEligible
            || (daemonInteraction.hasAddressedMachine
                ? daemonInteraction.daemonReachable
                : daemonInteraction.endpointOnline)
        );
    const daemonOwnedInteractionEnabled = localControllerInteractionEnabled
        && daemonInteraction.daemonReachable;
    // Projection admission controls controller-owned Actions/Resources, but a
    // declared daemon settings target remains readable while its transport is
    // reachable. Keep that factual transport gate separate so Settings does
    // not accidentally inherit an unrelated presentation/action decision.
    const daemonSettingsInteractionEnabled = accountLocalInteractionEnabled
        && originInteractionCurrent
        && daemonInteraction.daemonReachable;
    // Account data/settings own their own currentness through this same
    // lifetime, while daemon settings/actions must also observe daemon
    // reachability. Do the intersection here at the one mounted host rather
    // than letting individual declarative consumers invent local offline rules.
    const declarativeSettingsScopesEnabled = React.useMemo(() => Object.freeze({
        account: accountLocalInteractionEnabled && (props.settingsScopesEnabled?.account ?? true),
        daemon: daemonSettingsInteractionEnabled && (props.settingsScopesEnabled?.daemon ?? true),
    }), [
        accountLocalInteractionEnabled,
        daemonSettingsInteractionEnabled,
        props.settingsScopesEnabled?.account,
        props.settingsScopesEnabled?.daemon,
    ]);
    // §3.1: ONE bound controller owns this mount's host-API semantics. Every
    // placement reaches it through the facts above — no placement composes
    // handlers, and none is left with a handler-less API it cannot serve.
    const composerResourceContext = composerMount?.physicalTarget.kind === 'session'
        ? Object.freeze({ kind: 'session' as const, sessionId: composerMount.physicalTarget.sessionId })
        : undefined;
    const composerSessionId = composerMount?.physicalTarget.kind === 'session'
        ? composerMount.physicalTarget.sessionId
        : props.sessionId;
    const baseControllerFacts = targetedBinding
        ? createTargetedPluginSurfaceBoundFacts({
            request: targetedRequest!,
            serverId,
            sessionId: props.sessionId,
            targetAuthorityKey: surfaceTargetAuthorityKey,
            platform: surfacePlatform,
            channel: surfaceChannel,
            projectionGeneration,
            pluginProjectionById: targetedMount?.pluginProjectionById ?? null,
            pluginUiProjection: mountedPluginUiProjection,
            accountLifetime,
            parentLifetime: targetedMount?.parentLifetime ?? null,
            interactionEnabled: localControllerInteractionEnabled && destinationPlatformSupported,
            daemonInteractionEnabled: daemonOwnedInteractionEnabled
                && destinationPlatformSupported
                && targetedMount?.daemonProjectionReady === true,
        })
        : composerBinding
            ? Object.freeze({
                pluginId: composerBinding.mount.contribution.pluginId,
                contributionId: composerBinding.mount.contribution.localId,
                surfaceId: mountedSurfaceId,
                sessionId: composerSessionId,
                targetAuthorityKey: surfaceTargetAuthorityKey,
                placement: 'composerSurface' as const,
                platform: surfacePlatform,
                channel: surfaceChannel,
                resourceScope: surfaceScope.declared ? surfaceScope.resourceScope : [],
                machineId,
                serverId,
                projectionGeneration,
                executionOrigin,
                resourceCapability,
                ...(composerResourceContext === undefined ? {} : { resourceContext: composerResourceContext }),
                pluginProjectionById: composerMount?.pluginProjectionById ?? null,
                pluginUiProjection: mountedPluginUiProjection,
                targetedContributions: composerBinding.catalogEntry.contributorTargetedContributions,
                accountLifetime,
                parentLifetime: composerMount?.parentLifetime ?? null,
                mountInstanceKey: composerBinding.mount.instanceKey,
                interactionEnabled: localControllerInteractionEnabled && destinationPlatformSupported,
                daemonInteractionEnabled: daemonOwnedInteractionEnabled
                    && destinationPlatformSupported
                    && composerMount?.daemonProjectionReady === true,
            })
        : Object.freeze({
            pluginId: mountedPluginId,
            contributionId: selectedDestinationBinding?.destination.localId ?? mountedContributionId,
            surfaceId: mountedSurfaceId,
            sessionId: props.sessionId,
            targetAuthorityKey: surfaceTargetAuthorityKey,
            placement: selectedDestinationBinding?.surfaceContextPlacement ?? 'unknown',
            platform: surfacePlatform,
            channel: surfaceChannel,
            resourceScope: surfaceScope.declared ? surfaceScope.resourceScope : [],
            machineId,
            serverId,
            projectionGeneration,
            executionOrigin,
            resourceCapability,
            pluginProjectionById: mountedTargetInputs?.pluginProjectionById ?? null,
            pluginUiProjection: mountedPluginUiProjection,
            targetedContributions,
            accountLifetime,
            mountInstanceKey: mountedInstanceKey,
            interactionEnabled: localControllerInteractionEnabled && destinationPlatformSupported,
            daemonInteractionEnabled: daemonOwnedInteractionEnabled
                && destinationPlatformSupported
                && mountedTargetProjection.phase === 'ready',
        });
    const controllerFacts = Object.freeze({
        ...baseControllerFacts,
        resolveContributedAction,
        ...(currentUiContextReader
            ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
            : {}),
    });
    // Generic and targeted mounts carry no private current Composer ref, but an
    // exact current mount can still address any live Composer ref through the
    // canonical document registry. The target-scoped projection is the only
    // attachment authority source here: the broad app union deliberately does
    // not become a second Composer catalog.
    const mountedComposerProjectionSource = targetedBinding
        ? targetedMount?.pluginProjectionV2 ?? null
        : mountedTargetInputs?.pluginProjectionV2 ?? null;
    // A daemon refresh rebuilds the exact V2 object graph even when Composer
    // attachment authority is unchanged. This semantic key belongs at the
    // mounted handler boundary: it preserves the controller/observer lifetime
    // for an equivalent map while still replacing it for an authority change.
    const mountedComposerAttachmentsKey = stableJsonStringify(
        mountedComposerProjectionSource?.familiesById.composerAttachments?.entriesById ?? {},
    );
    const mountedComposerAttachmentsById = React.useMemo(() => (
        mountedComposerProjectionSource
            ? normalizePluginUiProjection(mountedComposerProjectionSource).composerAttachmentsById
            : EMPTY_PLUGIN_UI_PROJECTION.composerAttachmentsById
        // `mountedComposerAttachmentsKey` is the complete semantic input to
        // this handler-owned authority map; raw response identity is not a
        // mount-currentness fact.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [mountedComposerAttachmentsKey]);
    const mountedComposerOwnerPluginId = targetedBinding
        ? targetedBinding.mount.contributor.pluginId
        : !composerBinding && mountedTarget && mountedTargetInputs
            ? mountedPluginId
            : null;
    const mountedComposerOwnerContributionId = targetedBinding
        ? targetedBinding.mount.contributor.contributionId
        : !composerBinding && mountedTarget && mountedTargetInputs
            ? selectedDestinationBinding?.destination.localId ?? mountedContributionId
            : null;
    const mountedComposerOwnerGeneration = targetedBinding
        ? targetedBinding.mount.contributor.immutableGenerationId
        : !composerBinding && mountedTarget && mountedTargetInputs
            ? mountedTarget.immutableGenerationId
            : null;
    const mountedComposerOwnerInstanceKey = targetedBinding
        ? targetedRequest?.instanceKey ?? null
        : !composerBinding && mountedTarget && mountedTargetInputs
            ? mountedInstanceKey ?? mountedSurfaceId
            : null;
    const mountedComposerOwner = React.useMemo<ComposerPresentationHostOwner | null>(() => {
        if (
            !mountedComposerOwnerPluginId
            || !mountedComposerOwnerContributionId
            || !mountedComposerOwnerGeneration
            || !mountedComposerOwnerInstanceKey
        ) return null;
        return Object.freeze({
            identity: Object.freeze({
                pluginId: mountedComposerOwnerPluginId,
                localId: mountedComposerOwnerContributionId,
            }),
            immutableGenerationId: mountedComposerOwnerGeneration,
            surfaceInstanceKey: mountedComposerOwnerInstanceKey,
        });
    }, [
        mountedComposerOwnerContributionId,
        mountedComposerOwnerGeneration,
        mountedComposerOwnerInstanceKey,
        mountedComposerOwnerPluginId,
    ]);
    const mountedComposerTransactionApplier = React.useMemo(() => (
        mountedComposerOwner
            ? createComposerPresentationTransactionApplier({
                composerAttachmentsById: mountedComposerAttachmentsById,
            })
            : null
    ), [mountedComposerAttachmentsById, mountedComposerOwner]);
    const mountedComposerSubscriptionPublisherRef = React.useRef<PluginSurfaceComposerSubscriptionPublisher | null>(null);
    const publishMountedComposerSnapshot = React.useCallback((event: Readonly<{
        subscriptionId: string;
        snapshot: ComposerSnapshotV1;
    }>): void => {
        const publisher = mountedComposerSubscriptionPublisherRef.current;
        if (!publisher || publisher(event) !== true) {
            throw new Error('composer_subscription_publisher_unavailable');
        }
    }, []);
    const mountedComposerPublisherCapable = props.binding?.openableContent === undefined
        && mountedComposerOwner !== null
        && (renderer.kind === 'reactNative' || renderer.kind === 'hostedWeb');
    const createMountedComposerHostApiHandlers = React.useCallback((input: Readonly<{
        isCurrent: () => boolean;
    }>) => {
        if (!mountedComposerOwner || !mountedComposerTransactionApplier) {
            throw new Error('mounted_composer_handler_owner_unavailable');
        }
        const handlers = createComposerPresentationHostHandlers({
            owner: mountedComposerOwner,
            transactionApplier: mountedComposerTransactionApplier,
            ...(mountedComposerMediaExecutionTarget
                ? { executionTarget: mountedComposerMediaExecutionTarget }
                : {}),
            isCurrent: input.isCurrent,
            ...(mountedComposerPublisherCapable ? { publishComposerSnapshot: publishMountedComposerSnapshot } : {}),
        });
        return Object.freeze({
            handlers,
            dispose: handlers.dispose,
        });
    }, [
        mountedComposerMediaExecutionTarget,
        mountedComposerOwner,
        mountedComposerPublisherCapable,
        mountedComposerTransactionApplier,
        publishMountedComposerSnapshot,
    ]);
    const setMountedComposerSubscriptionPublisher = React.useCallback((publisher: PluginSurfaceComposerSubscriptionPublisher | undefined): void => {
        mountedComposerSubscriptionPublisherRef.current = publisher ?? null;
    }, []);
    React.useEffect(() => () => {
        mountedComposerSubscriptionPublisherRef.current = null;
    }, []);
    const mountedComposerBinding = React.useMemo<BoundPluginSurfaceBinding | undefined>(() => {
        if (!mountedComposerOwner || !mountedComposerTransactionApplier) return undefined;
        return Object.freeze({
            ...(targetedBinding ? {} : props.binding ?? {}),
            createMountedHostApiHandlers: createMountedComposerHostApiHandlers,
        });
    }, [createMountedComposerHostApiHandlers, mountedComposerOwner, mountedComposerTransactionApplier, props.binding, targetedBinding]);
    const controllerBinding = composerBinding
        ? composerMount?.binding
        : mountedComposerBinding
            ?? (targetedBinding ? undefined : props.binding);
    const baseCreateMountedHostApiHandlers = controllerBinding?.createMountedHostApiHandlers;
    const createMountedHostApiHandlers = React.useCallback<BoundPluginSurfaceMountedHostApiHandlersFactory>((input) => {
        const mountedBundle = baseCreateMountedHostApiHandlers?.(input);
        // Factory construction happens during render. Creating this small
        // closure is inert; the bound controller activates it only after the
        // exact physical surface commits.
        // A controller can exist briefly while its exact generated renderer is
        // still unavailable. Allocate a provider publication only when the
        // physically mounted renderer first publishes, so that transient
        // controller replacement neither creates nor retires a second mount
        // authority before any public context exists.
        let mountPublication: CurrentUiContextMountPublication | null = null;
        const getMountPublication = (): CurrentUiContextMountPublication | null => {
            if (mountPublication === null && currentUiContextMountPublisher) {
                mountPublication = currentUiContextMountPublisher.createMount();
            }
            return mountPublication;
        };
        let activated = false;
        let eligible = false;
        let hasRetainedEnrichment = false;
        let retainedEnrichment: CurrentUiContextMountedEnrichment | null = null;
        const canPublish = (): boolean => input.isCurrent() && activated && eligible;
        const currentUiContext = currentUiContextMountPublisher
            ? Object.freeze({
                publish: (enrichment: CurrentUiContextMountedEnrichment | null): boolean => {
                    if (!input.isCurrent()) return false;
                    retainedEnrichment = enrichment;
                    hasRetainedEnrichment = enrichment !== null;
                    // A child may publish from its own committed layout effect
                    // before this host's layout effect has delivered focus.
                    // Retain only the exact mount's latest bounded data and
                    // expose it once that incumbent presentation fact arrives.
                    return !canPublish() || getMountPublication()?.publish(enrichment) === true;
                },
                clear: (): void => mountPublication?.clear(),
                restore: (): boolean => {
                    if (!canPublish() || !hasRetainedEnrichment) return false;
                    return getMountPublication()?.publish(retainedEnrichment) === true;
                },
                dispose: (): void => {
                    hasRetainedEnrichment = false;
                    retainedEnrichment = null;
                    mountPublication?.dispose();
                    mountPublication = null;
                },
            })
            : undefined;
        const activate = mountedBundle?.activate || currentUiContext
            ? (): void => {
                if (activated) return;
                mountedBundle?.activate?.();
                activated = true;
                currentUiContext?.restore();
            }
            : undefined;
        const setCurrentUiContextEligibility = mountedBundle?.setCurrentUiContextEligibility || currentUiContext
            ? (nextEligible: boolean): void => {
                mountedBundle?.setCurrentUiContextEligibility?.(nextEligible);
                eligible = nextEligible;
                if (!activated) return;
                if (eligible) {
                    currentUiContext?.restore();
                } else {
                    currentUiContext?.clear();
                }
            }
            : undefined;
        return Object.freeze({
            handlers: mountedBundle?.handlers ?? {},
            ...(currentUiContext ? { currentUiContext } : {}),
            ...(activate ? { activate } : {}),
            ...(setCurrentUiContextEligibility ? { setCurrentUiContextEligibility } : {}),
            ...(mountedBundle?.dispose ? { dispose: mountedBundle.dispose } : {}),
        });
    }, [baseCreateMountedHostApiHandlers, currentUiContextMountPublisher]);
    const effectiveControllerBinding = React.useMemo<BoundPluginSurfaceBinding | undefined>(() => {
        if (!baseCreateMountedHostApiHandlers && !currentUiContextMountPublisher) return controllerBinding;
        return Object.freeze({
            ...(controllerBinding ?? {}),
            createMountedHostApiHandlers,
        });
    }, [
        baseCreateMountedHostApiHandlers,
        controllerBinding,
        createMountedHostApiHandlers,
        currentUiContextMountPublisher,
    ]);
    const controller = useBoundPluginSurfaceController({
        facts: controllerFacts,
        ...(effectiveControllerBinding ? { binding: effectiveControllerBinding } : {}),
    });
    React.useLayoutEffect(() => {
        // Presentation focus remains available to every renderer, while the
        // existing layout owner separately names the one semantic-current
        // surface. Ambiguous pane roots deliberately publish no enrichment.
        // Native inactive transitions are provider-owned retirement, including
        // an accompanying focus loss. Foreground applies the latest focus fact
        // once through this controller's existing retained publication path.
        if (!currentUiContextMountLifecycleActive) return;
        controller.setCurrentUiContextEligibility?.(currentUiContextFocusEligible);
    }, [controller, currentUiContextFocusEligible, currentUiContextMountLifecycleActive]);
    React.useLayoutEffect(() => () => {
        // Controller replacement and physical unmount remain their existing
        // publication-owner retirement paths, independent of app visibility.
        controller.setCurrentUiContextEligibility?.(false);
    }, [controller]);
    React.useLayoutEffect(() => () => {
        // A full-page subpath changes beneath the same physical adapter. Retire
        // its prior semantic record during layout cleanup, before the retained
        // child can publish its next location from a layout effect.
        controller.clearCurrentUiContext();
    }, [controller, props.subPath]);
    const physicalComposerSubscriptionPublisherSetter = composerBinding
        ? composerMount?.setComposerSubscriptionPublisher
        : mountedComposerPublisherCapable
            ? setMountedComposerSubscriptionPublisher
            : undefined;
    const reportUnsupportedNestedTargetedSurface = React.useCallback((): void => {
        if (!controller.installedMethods.includes('diagnostic')) return;
        void Promise.resolve(controller.hostApi.handleRequest({
            version: 1,
            requestId: `nested-targeted-surface:${mountedSurfaceId}`,
            surface: controller.surfaceContext,
            method: 'diagnostic',
            payload: {
                code: 'unsupported_nested_targeted_surface',
                severity: 'warning',
            },
        })).catch(() => undefined);
    }, [controller, mountedSurfaceId]);
    const reportTargetedSurfaceRenderFailure = React.useCallback((): void => {
        if (!targetedBinding || !controller.installedMethods.includes('diagnostic')) return;
        const contributor = targetedBinding.mount.contributor;
        void Promise.resolve(controller.hostApi.handleRequest({
            version: 1,
            requestId: `targeted-surface-render-failure:${mountedSurfaceId}`,
            surface: controller.surfaceContext,
            method: 'diagnostic',
            payload: {
                code: 'targeted_surface_render_failure',
                severity: 'error',
                // Keep the host-owned diagnostic bounded and attribution-only:
                // renderer errors can contain author-controlled or sensitive text.
                details: {
                    contributor: {
                        pluginId: contributor.pluginId,
                        contributionId: contributor.contributionId,
                        immutableGenerationId: contributor.immutableGenerationId,
                    },
                    targetedSurfaceId: mountedSurfaceId,
                },
            },
        })).catch(() => undefined);
    }, [controller, mountedSurfaceId, targetedBinding]);
    const targetedSurfaceLaunchInputResetKey = targetedRequest?.input === undefined
        ? 'absent'
        : `present:${stableJsonStringify(targetedRequest.input)}`;
    const targetedSurfaceBoundaryResetKey = targetedBinding
        ? JSON.stringify([
            targetedBinding.mount.target.pluginId,
            targetedBinding.mount.target.immutableGenerationId,
            targetedBinding.mount.contributor.pluginId,
            targetedBinding.mount.contributor.contributionId,
            targetedBinding.mount.contributor.immutableGenerationId,
            targetedBinding.mount.role,
            targetedBinding.mount.presentation,
            targetedBinding.mount.selectedRenderer.identity.pluginId,
            targetedBinding.mount.selectedRenderer.identity.localId,
            targetedBinding.mount.selectedRenderer.renderer.kind,
            targetedSurfaceLaunchInputResetKey,
        ])
        : undefined;
    const renderWithTargetedSurfaceBoundary = (child: React.ReactElement): React.ReactElement => {
        if (!targetedBinding) return child;
        // The physical B mount owns this boundary so its bound controller can
        // publish through the incumbent currentness-aware diagnostic handler.
        // A's artifact boundary and durable RN crash state remain outside it.
        return (
            <PluginUiBoundary
                surfaceId={mountedSurfaceId}
                resetKey={targetedSurfaceBoundaryResetKey}
                mountInstanceKey={mountedInstanceKey}
                {...(targetedRequest && targetedRequest.fallback !== undefined
                    ? { fallback: targetedRequest.fallback }
                    : {})}
                onCrash={reportTargetedSurfaceRenderFailure}
            >
                {child}
            </PluginUiBoundary>
        );
    };
    // The Account-mode cache is the sole reader/value owner. This mount keeps
    // only its own currentness fence: credentials, the captured Account
    // lifetime, and the controller must all still name this physical mount
    // before its resolved disclosure can become public context.
    const accountEncryptionModeCredentials = sync.getCredentials();
    const accountEncryptionModeCredentialScope = accountEncryptionModeCredentials
        ? resolveAuthCredentialsScopeKey(accountEncryptionModeCredentials)
        : null;
    const isAccountEncryptionModeCurrent = React.useCallback((): boolean => {
        const currentCredentials = sync.getCredentials();
        return Boolean(
            accountEncryptionModeCredentialScope
            && currentCredentials
            && accountLifetime?.isCurrent() === true
            && controller.isCurrent()
            && resolveAuthCredentialsScopeKey(currentCredentials) === accountEncryptionModeCredentialScope,
        );
    }, [accountEncryptionModeCredentialScope, accountLifetime, controller.isCurrent]);
    const accountEncryptionMode = usePluginSurfaceAccountEncryptionMode({
        accountLifetime,
        credentials: accountEncryptionModeCredentials,
        isCurrent: isAccountEncryptionModeCurrent,
    });
    // The generated surface receives a closed exact-target resolver through
    // private bindings. Keep that composition stable across equivalent parent
    // renders: the map is its only package-data authority, while the bound
    // controller remains its only currentness authority.
    const installedPackageBrandTargetIdentity = readInstalledPackageBrandTargetIdentity(installedPackagesById);
    const resolveBrandTarget = React.useMemo(
        () => createInstalledPackageBrandTargetResolver(installedPackagesById),
        // The semantic key contains every package fact the private resolver
        // passes to presentation. Retaining an equivalent snapshot prevents a
        // no-op Availability refresh from rebuilding the artifact bindings.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [installedPackageBrandTargetIdentity],
    );
    const mountedBrandPluginId = hasEmbeddedMount
        ? mountedPluginId
        : selectedDestinationBinding?.destination.pluginId;
    const mountedBrandTarget = mountedBrandPluginId && resolveBrandTarget
        ? resolveBrandTarget(mountedBrandPluginId)
        : undefined;
    const projectedBrand = React.useMemo(
        () => mountedBrandTarget
            ? Object.freeze({
                displayName: mountedBrandTarget.displayName,
                ...(mountedBrandTarget.installedPackage.brand?.state === 'available'
                    ? { resource: mountedBrandTarget.installedPackage.brand.resource }
                    : {}),
            })
            : undefined,
        [mountedBrandTarget],
    );
    const brandTargetPresentation = React.useMemo(
        () => resolveBrandTarget
            ? Object.freeze({
                fallbackBrandDisplayName: t('common.unavailable'),
                resolveBrandTarget,
                machineId,
                serverId,
                isCurrent: controller.isCurrent,
            })
            : undefined,
        [controller.isCurrent, machineId, resolveBrandTarget, serverId, surfaceLocale],
    );
    const policyContext = React.useMemo(() => createPluginUiPolicyEvaluationContext(
        props.policyContext,
        {
            platform: surfacePlatform,
            channel: surfaceChannel,
        },
    ), [props.policyContext, surfaceChannel, surfacePlatform]);
    const renderMountedTargetedSurface = React.useCallback((request: TargetedPluginSurfaceMountRequest): React.ReactNode => {
        if (!resolvedSurfaceTarget.resolved) return null;
        return (
            <PluginSurfaceHost
                key={request.instanceKey}
                targetedMount={{
                    request,
                    physicalTarget: resolvedSurfaceTarget.target,
                    parentLifetime: controller,
                    projectionGeneration: mountedTargetInputs?.pluginProjectionV2?.generation,
                    pluginProjectionById: mountedTargetInputs?.pluginProjectionById,
                    pluginProjectionV2: mountedTargetInputs?.pluginProjectionV2,
                    daemonProjectionReady: mountedTargetProjection.phase === 'ready',
                }}
                serverId={serverId}
                sessionId={props.sessionId}
                localServicePreviewState={props.localServicePreviewState}
                platform={surfacePlatform}
                formFactor={runtimeFormFactor}
                channel={surfaceChannel}
                nowMs={props.nowMs}
                projectionInteractionEnabled={localControllerInteractionEnabled}
                policyContext={policyContext}
                reactNativeLoaderBackend={props.reactNativeLoaderBackend}
            />
        );
    }, [
        controller,
        localControllerInteractionEnabled,
        mountedTargetProjection,
        policyContext,
        props.localServicePreviewState,
        props.nowMs,
        props.reactNativeLoaderBackend,
        props.sessionId,
        resolvedSurfaceTarget,
        runtimeFormFactor,
        serverId,
        surfaceChannel,
        surfacePlatform,
    ]);
    const renderTargetedSurface = React.useCallback((
        node: Readonly<Record<string, unknown>>,
        fallback: React.ReactNode,
    ): React.ReactNode => {
        // V1 has one embedded level. The child gets its own contributor snapshot
        // but no target inventory/bridge, so it cannot recursively mount a B→C
        // surface through this adapter.
        if (hasEmbeddedMount || !preparedTargetedSurfaceMounts || !mountedTarget) return null;
        return (
            <TargetedPluginSurfaceHost
                node={node}
                fallback={fallback}
                mounts={preparedTargetedSurfaceMounts}
                target={mountedTarget}
                renderMountedSurface={renderMountedTargetedSurface}
            />
        );
    }, [hasEmbeddedMount, mountedTarget, preparedTargetedSurfaceMounts, renderMountedTargetedSurface]);
    const renderReactTargetedSurface = React.useCallback((
        presentation: PluginUiPrivateTargetedSurfacePresentation,
    ): React.ReactNode => {
        if (hasEmbeddedMount || !preparedTargetedSurfaceMounts || !mountedTarget) {
            return presentation.fallback ?? null;
        }
        return (
            <TargetedPluginSurfaceHost
                presentation={presentation}
                mounts={preparedTargetedSurfaceMounts}
                target={mountedTarget}
                renderMountedSurface={renderMountedTargetedSurface}
            />
        );
    }, [hasEmbeddedMount, mountedTarget, preparedTargetedSurfaceMounts, renderMountedTargetedSurface]);
    const descriptorCrashState = !hasEmbeddedMount && renderer.kind === 'reactNative' && descriptor
        ? readDescriptorReactNativeCrashState(descriptor)
        : null;
    const renderGate = selectedEmbeddedRenderer
        ? selectedEmbeddedRenderer.availability.state === 'available'
            ? { canRender: true as const }
            : { canRender: false as const, reason: selectedEmbeddedRenderer.availability.reason }
        : resolvePluginSurfaceDescriptorRenderGate(
            descriptor!,
            policyContext,
            descriptorCrashState?.disabled === true,
        );
    const renderUnavailable = (reason: string): React.ReactElement => (
        targetedBinding && targetedRequest?.fallback !== undefined
            ? <>{targetedRequest.fallback}</>
            : renderPluginSurfaceUnavailable(reason, props.unavailableAction)
    );
    if (!renderGate.canRender) {
        return renderUnavailable(renderGate.reason);
    }
    if (!mountBinding) {
        return renderUnavailable('destination_binding_unavailable');
    }
    if (!destinationPlatformSupported) {
        return renderUnavailable('destination_platform_unavailable');
    }
    const boundDestination = selectedDestinationBinding;
    // §3.2 r0.9 — target exactness fails CLOSED. A declared session/project/
    // project/browser placement whose principal identity this mount cannot
    // supply is the host failing to BIND the target; it is not an app surface.
    // Nothing is admitted: no host API, no mount, no context. The plugin sees the
    // canonical unavailable diagnostic instead of a target it would have to trust.
    if (!resolvedSurfaceTarget.resolved) {
        return renderUnavailable(resolvedSurfaceTarget.reason);
    }
    // Account-mode disclosure is required for every executable renderer. Do
    // not lend either public Host API transport a stale, inferred, or absent
    // context while the canonical cache is resolving or has just invalidated.
    if (accountLocalInteractionEnabled && !accountEncryptionMode) {
        return renderUnavailable('account_encryption_mode_unavailable');
    }
    const surfaceTarget = resolvedSurfaceTarget.target;
    const resolvedHostApi = controller.hostApi;
    const structuralTransportHostMethods = resolveNegotiatedPluginSurfaceHostApiMethods({
        installedMethods: controller.admissionMethods,
        canPushToSurface: true,
    });
    const surfaceMount = mountBinding.kind === 'targetedSurface'
        ? createPluginSurfaceTargetedMountContext(mountBinding)
        : mountBinding.kind === 'composer'
            ? createPluginSurfaceComposerMountContext(mountBinding)
            : createPluginSurfaceDestinationMountContext(mountBinding);
    // The generalized physical mount consumes B's exact facts. The embedded
    // arm deliberately has neither a destination nor A's launch identity.
    const mountLaunchInput = targetedBinding
        ? targetedRequest!.input
        : composerBinding
            ? composerBinding.mount.input
            : props.launchInput;
    const mountSubPath = hasEmbeddedMount ? undefined : props.subPath;
    const mountInstanceKey = targetedBinding
        ? targetedRequest!.instanceKey
        : composerBinding
            ? composerBinding.mount.instanceKey
            : props.mountInstanceKey;
    if (renderer.kind === 'declarative') {
        const model = readRecord(renderer.model);
        const modelIdentity = readRecord(model?.identity);
        if (
            !model
            || model.visible !== true
            || modelIdentity?.pluginId !== mountedPluginId
            || !readOptionalString(modelIdentity.generation)
            || !readRecord(model.root)
        ) {
            return renderUnavailable('declarative_model_unavailable');
        }
        const renderStaticModel = () => (
            <DeclarativePluginSurface
                pluginId={mountedPluginId}
                model={model}
                machineId={machineId}
                serverId={serverId}
                daemonSettingsTarget={hasEmbeddedMount ? undefined : props.daemonSettingsTarget}
                isDaemonSettingsTargetCurrent={hasEmbeddedMount ? undefined : props.isDaemonSettingsTargetCurrent}
                settingsScopesEnabled={declarativeSettingsScopesEnabled}
                interactionEnabled={accountLocalInteractionEnabled}
                focusEligible={presentationFocusEligible}
                daemonInteractionEnabled={daemonOwnedInteractionEnabled}
                dispatchAction={controller.dispatchAction}
                actionAvailable={controller.installedMethods.includes('executeAction')}
                {...(composerBinding ? { composerRef: composerBinding.mount.composer } : {})}
                applyComposer={controller.applyComposer}
                composerApplyAvailable={controller.installedMethods.includes('applyComposer')}
                pluginUiProjection={mountedPluginUiProjection}
                policyContext={hasEmbeddedMount ? undefined : policyContext}
                openSurface={controller.openSurface}
                // UI-D02: availability is the FACTUAL installed set, exactly as
                // the document-source arms above already read it. An embedded
                // mount whose container supplied no destination binding installs
                // no handler and is therefore already unavailable here; adding
                // `hasEmbeddedMount` on top refused a Composer surface whose
                // scope DID bind the canonical navigation owner, so an enabled
                // control resolved after doing nothing.
                openSurfaceAvailable={controller.installedMethods.includes('openSurface')}
                authorityGeneration={daemonInteraction.daemonStateVersion}
                accountLifetime={accountLifetime}
                dataClient={mountedPluginUiDataClient}
                renderTargetedSurface={hasEmbeddedMount ? undefined : renderTargetedSurface}
                // Nesting is structurally unsupported for EVERY embedded mount,
                // not only the targeted arm: an embedded Composer surface has no
                // B->C bridge either, and it was committing the same fallback
                // silently. A destination mount is excluded because it CAN mount
                // a targeted child, so its fallback means "this child is
                // unavailable", not "nesting is unsupported here".
                reportUnsupportedNestedTargetedSurface={hasEmbeddedMount
                    ? reportUnsupportedNestedTargetedSurface
                    : undefined}
                embeddedPresentation={surfaceMount.kind === 'embedded' ? surfaceMount.presentation : undefined}
                contrast={surfaceEnvironment.contrast}
            />
        );
        const documentSource = readRecord(renderer.documentSource);
        if (
            documentSource?.kind === 'resource'
            && readOptionalString(documentSource.resourceId)
            && targetedContributions !== null
        ) {
            // A missing Account lifetime preserves the incumbent inert static
            // snapshot. It never builds the document Host API/context; active
            // Accounts are withheld by the mode gate above instead.
            if (!accountEncryptionMode) return renderWithTargetedSurfaceBoundary(renderStaticModel());
            return renderWithTargetedSurfaceBoundary(
                <DeclarativePluginSurfaceWithDocumentSource
                    pluginId={mountedPluginId}
                    staticModel={model}
                    documentSource={documentSource}
                    surfaceMount={surfaceMount}
                    surfaceTarget={surfaceTarget}
                    accountEncryptionMode={accountEncryptionMode}
                    environment={surfaceEnvironment}
                    surfaceTranslations={surfaceTranslations}
                    targetedContributions={targetedContributions}
                    preparedTargetedSurfaces={hasEmbeddedMount ? undefined : declarativeTargetedSurfaceInventory}
                    accountLifetime={accountLifetime}
                    dataClient={mountedPluginUiDataClient}
                    machineId={machineId}
                    serverId={serverId}
                    daemonSettingsTarget={hasEmbeddedMount ? undefined : props.daemonSettingsTarget}
                    isDaemonSettingsTargetCurrent={hasEmbeddedMount ? undefined : props.isDaemonSettingsTargetCurrent}
                    settingsScopesEnabled={declarativeSettingsScopesEnabled}
                    interactionEnabled={accountLocalInteractionEnabled}
                    focusEligible={presentationFocusEligible}
                    daemonInteractionEnabled={daemonOwnedInteractionEnabled}
                    controller={controller}
                    authorityGeneration={daemonInteraction.daemonStateVersion}
                    pluginUiProjection={mountedPluginUiProjection}
                    policyContext={hasEmbeddedMount ? undefined : policyContext}
                    renderTargetedSurface={hasEmbeddedMount ? undefined : renderTargetedSurface}
                    reportUnsupportedNestedTargetedSurface={hasEmbeddedMount
                        ? reportUnsupportedNestedTargetedSurface
                        : undefined}
                    embeddedPresentation={surfaceMount.kind === 'embedded' ? surfaceMount.presentation : undefined}
                    {...(composerBinding ? { composerRef: composerBinding.mount.composer } : {})}
                />
            );
        }
        return renderWithTargetedSurfaceBoundary(renderStaticModel());
    }

    if (!accountEncryptionMode) {
        return renderUnavailable('account_encryption_mode_unavailable');
    }

    const renderHostedWebPane = (
        contributionId: string,
        contribution: Readonly<Record<string, unknown>> | null,
    ) => {
        const explicitBrowserTarget = hasEmbeddedMount
            ? null
            : readSurfaceBrowserTarget({
                resourceBrowserTarget: props.resourceBrowserTarget,
                descriptor: descriptor!,
            });
        // Generated V2 hosted web has an Artifact-owned byte source, not an
        // author/mount supplied URL or Session preview. Legacy projections keep
        // their established explicit-target/preview behavior below.
        const browserTarget = contribution?.generatedV2 === true
            ? null
            : explicitBrowserTarget ?? resolveHostedWebStaticAssetBrowserTarget({
                contribution,
                sessionId: props.sessionId,
                machineId,
            });
        const preview = props.localServicePreviewState && browserTarget?.kind === 'localServicePreview'
            ? selectLocalServicePreviewByBrowserTarget(props.localServicePreviewState, browserTarget)
            : null;

        // UI-D02: the bridge still publishes the mount's factual served set,
        // while renderer eligibility comes from the shared structural admission
        // owner below. A transient daemon outage therefore stays a typed runtime
        // unavailability instead of de-admitting only hosted web.
        const requiredHostMethods = readRequiredPluginSurfaceHostMethods(contribution?.requiredHostMethods);
        const hostedWebInteractionEnabled = controller.interactive && rendererInteractionEnabled;
        const hostedWebTechnicalAdmission = contribution?.generatedV2 === true
            ? resolvePluginUiRendererTechnicalAdmission({
                requiredHostMethods,
                structuralHostMethods: structuralTransportHostMethods,
                resolveArtifactAdmission: () => resolvePluginUiHostedWebArtifactTechnicalAdmission({
                    contribution,
                    pluginId: mountedPluginId,
                    projectionGeneration: artifactProjectionGeneration,
                    channel: surfaceChannel,
                }),
            })
            : null;
        // Hosted SDK clients negotiate the sole Host API version. A generated mount
        // therefore cannot lend the bridge a context until the exact daemon
        // target snapshot has arrived; an old cached target never qualifies.
        if (contribution?.generatedV2 === true && !targetedContributions) {
            return renderUnavailable('targeted_contributions_unavailable');
        }
        const canonicalHostApi = contribution?.generatedV2 === true
            && projectionGeneration !== null
            && projectionGeneration !== undefined
            && hostedWebTechnicalAdmission?.kind === 'available'
            && targetedContributions !== null
            ? {
                identity: {
                    pluginId: mountedPluginId,
                    pluginVersion: readOptionalString(contribution.pluginVersion) ?? '0.0.0',
                    viewId: mountedContributionId,
                    generation: String(projectionGeneration),
                    ...(props.sessionId ? { sessionId: props.sessionId } : {}),
                },
                mount: surfaceMount,
                // The hosted guest NEGOTIATES ONCE and freezes the advertised
                // set for the life of the mount, so this must be the STRUCTURAL
                // set (`admissionMethods`), not the live-narrowed one. A mount
                // that first handshakes while the daemon is unreachable would
                // otherwise never regain `readResource`/`watchResource`. Live
                // narrowing still applies per request: the one host-API owner
                // answers a structurally installed but currently unreachable
                // method with the retryable `unavailable` envelope. Same
                // separation the React Native adapter already makes.
                methods: resolvedHostApi.admissionMethods,
                // §3.2/§3.3: the hosted-web binding carries the SAME exact
                // target, semantic theme and translation bundle the React Native
                // mount receives, resolved by the one context owner.
                target: surfaceTarget,
                accountEncryptionMode,
                translations: surfaceTranslations,
                targetedContributions,
            }
            : undefined;
        if (contribution?.generatedV2 === true && hostedWebTechnicalAdmission?.kind !== 'available') {
            return renderUnavailable(hostedWebTechnicalAdmission?.kind === 'unavailable'
                ? hostedWebTechnicalAdmission.code
                : 'artifact_technical_admission_unavailable');
        }

        const hostedArtifactAdmission = hostedWebTechnicalAdmission?.kind === 'available'
            ? hostedWebTechnicalAdmission.artifactAdmission
            : null;

        const paneProps: React.ComponentProps<typeof PluginHostedWebPane> = {
            contributionId,
            surfaceContext: controller.surfaceContext,
            ...(hasEmbeddedMount
                ? {
                    // An explicit selected artifact means unavailable when it
                    // is absent; embedded mounts never fall back to a broad
                    // projection lookup for their renderer contribution.
                    projectedContribution: contribution as PluginUiHostedWebProjection | null,
                    projectionGeneration: artifactProjectionGeneration,
                    pluginUiProjection: mountedPluginUiProjection,
                }
                : { pluginUiProjection: props.pluginUiProjection }),
            endpointUrl: preview?.accessUrl ?? null,
            expiresAt: preview?.expiresAt ?? null,
            platform: props.platform,
            nowMs: props.nowMs,
            hostApi: resolvedHostApi,
            canonicalHostApi,
            ...(targetedBinding ? { targetedFallback: targetedRequest?.fallback } : {}),
            ...(physicalComposerSubscriptionPublisherSetter
                ? { setComposerSubscriptionPublisher: physicalComposerSubscriptionPublisherSetter }
                : {}),
            interactionEnabled: hostedWebInteractionEnabled,
            focusEligible: presentationFocusEligible,
            mountInstanceKey,
            isCurrent: controller.isCurrent,
            accountLifetime,
            subscribeResourceInvalidations: controller.subscribeResourceInvalidations,
            policyContext,
            ...(createMountedHostedWebCollectionUiQueryBridge === undefined
                ? {}
                : { createCollectionUiQueryBridge: createMountedHostedWebCollectionUiQueryBridge }),
            ...(mountLaunchInput === undefined ? {} : { launchInput: mountLaunchInput }),
            ...(mountSubPath === undefined ? {} : { subPath: mountSubPath }),
            ...(composerBinding ? { composerRef: composerBinding.mount.composer } : {}),
        };
        if (contribution?.generatedV2 === true) {
            if (surfacePlatform === 'web') {
                return (
                    <PluginHostedWebBrowserArtifactFramePane
                        paneProps={paneProps}
                        reader={availabilityReader}
                        accountLifetime={accountLifetime}
                        admission={hostedArtifactAdmission}
                        isCurrent={controller.isCurrent}
                    />
                );
            }
            return (
                <PluginHostedWebArtifactAdoptionPane
                    paneProps={paneProps}
                    platform={surfacePlatform}
                    reader={availabilityReader}
                    accountLifetime={accountLifetime}
                    exactArtifactOrigin={exactArtifactOrigin}
                    admission={hostedArtifactAdmission}
                    isCurrent={controller.isCurrent}
                />
            );
        }

        return (
            <PluginHostedWebPane
                {...paneProps}
            />
        );
    };

    if (renderer.kind === 'hostedWeb') {
        if (hasEmbeddedMount) {
            if (!mountedRendererArtifact) {
                return renderUnavailable(composerBinding
                    ? 'composer_renderer_artifact_unavailable'
                    : 'targeted_renderer_artifact_unavailable');
            }
            const embeddedPane = renderHostedWebPane(
                selectedEmbeddedRenderer!.identity.localId,
                mountedRendererArtifact,
            );
            return targetedBinding
                ? renderWithTargetedSurfaceBoundary(embeddedPane)
                : embeddedPane;
        }
        const hostedWebMount = resolveHostedWebProjectionMount({
            pluginId: descriptor!.pluginId,
            contributionId: renderer.contributionId,
            entriesById: props.pluginUiProjection?.hostedWebById ?? {},
        });
        return renderHostedWebPane(
            hostedWebMount?.contributionId ?? '',
            hostedWebMount?.contribution ?? null,
        );
    }

    if (renderer.kind === 'reactNative') {
        if (hasEmbeddedMount && !mountedRendererArtifact) {
            return renderUnavailable(composerBinding
                ? 'composer_renderer_artifact_unavailable'
                : 'targeted_renderer_artifact_unavailable');
        }
        const contributionId = selectedEmbeddedRenderer
            ? selectedEmbeddedRenderer.identity.localId
            : resolvePluginUiProjectionContributionId({
                family: 'reactNativeBundle',
                pluginId: descriptor!.pluginId,
                contributionId: renderer.contributionId,
                entriesById: props.pluginUiProjection?.reactNativeBundlesById ?? {},
            });
        const contribution = selectedEmbeddedRenderer
            ? mountedRendererArtifact
            : contributionId
                ? props.pluginUiProjection?.reactNativeBundlesById[contributionId] ?? null
                : null;
        const runtime = readReactNativeRuntimeState(contribution ?? null);
        const cacheIdentity = runtime?.cacheIdentity ?? null;
        const resolvedRnContributionId = contribution?.contributionId
            ? String(contribution.contributionId)
            : contributionId ?? '';
        const artifactGraph = readPluginUiGeneratedArtifactGraph(contribution);
        const generatedV2 = contribution?.generatedV2 === true;
        const projectedCrashState = selectedEmbeddedRenderer
            ? selectedEmbeddedRenderer.crashState ?? null
            : descriptorCrashState;
        const exactGeneratedCrashState = generatedV2
            && projectedCrashState
            && (
                targetedBinding
                    ? isExactTargetedReactNativeCrashState({
                        state: projectedCrashState,
                        mount: targetedBinding.mount,
                        artifactDigest: artifactGraph?.digest ?? null,
                    })
                    : composerBinding
                        ? isExactComposerReactNativeCrashState({
                            state: projectedCrashState,
                            catalogEntry: composerBinding.catalogEntry,
                            artifactDigest: artifactGraph?.digest ?? null,
                        })
                    : isExactDescriptorReactNativeCrashState({
                        state: projectedCrashState,
                        binding: boundDestination!,
                        renderer,
                        artifactDigest: artifactGraph?.digest ?? null,
                    })
            )
            ? projectedCrashState
            : null;
        const requiresGeneratedCrashState = generatedV2 && (
            (
                runtime?.decision.state === 'load'
                && runtime.loadPolicy?.source === 'installedArtifact'
            )
            || (
                runtime?.decision.state === 'disabled'
                && projectedCrashState?.disabled === true
            )
        );
        if (requiresGeneratedCrashState && !exactGeneratedCrashState) {
            return renderUnavailable('react_native_crash_state_unavailable');
        }
        // Daemon-offline continuity may retain a same-Account visual snapshot,
        // but Account retirement is a disclosure boundary. Do not hand the RN
        // renderer an inert state that would preserve Account-A component/data
        // state while no current Account lifetime exists.
        if (generatedV2 && !accountLocalInteractionEnabled) {
            return renderUnavailable('account_scope_unavailable');
        }
        const moduleReference = generatedV2
            ? readPluginUiGeneratedReactNativeModuleReference(artifactGraph)
            : readReactNativeModuleReference({
                pluginId: mountedPluginId,
                contributionId: resolvedRnContributionId,
                entry: contribution?.entry,
            });
        const reactNativeRequiredHostMethods = readRequiredPluginSurfaceHostMethods(
            renderer.requiredHostMethods ?? contribution?.requiredHostMethods,
        );
        const reactNativeTechnicalAdmission = generatedV2
            ? resolvePluginUiRendererTechnicalAdmission({
                requiredHostMethods: reactNativeRequiredHostMethods,
                structuralHostMethods: structuralTransportHostMethods,
                resolveArtifactAdmission: () => isPluginUiReactNativeArtifactTechnicallyAdmitted({
                    artifactGraph,
                    cacheIdentity,
                    projectionGeneration: artifactProjectionGeneration,
                    moduleReference,
                })
                    ? true
                    : null,
            })
            : null;
        const generatedArtifactAdmissionSatisfied = !generatedV2
            || reactNativeTechnicalAdmission?.kind === 'available';
        // RN-WEB-LOADER: resolve the backend explicitly here — the ONE place
        // that picks Re.Pack (native) vs the web-module backend (web) — so a
        // web-rendered reactNative surface never silently falls through to
        // loader.ts's internal repack-only default (which fails closed on
        // web by design, per `nativeRepackClientResolver.ts`). Tests/callers
        // may still override via `props.reactNativeLoaderBackend`.
        const effectiveReactNativeLoaderBackend =
            props.reactNativeLoaderBackend ?? resolveDefaultReactNativeLoaderBackend();
        const installedArtifactLoad = runtime?.decision.state === 'load'
            && runtime.loadPolicy?.source === 'installedArtifact'
            && cacheIdentity
            && generatedArtifactAdmissionSatisfied
            && artifactGraph
            && availabilityReader
            && accountLifetime
            && exactGeneratedCrashState
            ? createPluginUiReactNativeInstalledArtifactLoad({
                identity: cacheIdentity,
                artifactGraph,
                reader: availabilityReader,
                accountLifetime,
                crashStateToken: exactGeneratedCrashState.token,
                ...(exactArtifactOrigin
                    ? {
                        daemon: exactArtifactOrigin,
                    }
                    : {}),
                moduleReference,
                hostPlatform: props.platform ?? 'web',
                backend: effectiveReactNativeLoaderBackend,
                isCurrent: controller.isCurrent,
            })
            : undefined;
        // RN-2: a `devHotReload` source loads from the projected local dev-server URL
        // (no installed artifact, no machine RPC). The exact selected renderer stays
        // RN; this branch only implements that renderer's load path.
        const devServerLoad = runtime?.decision.state === 'load'
            && runtime.loadPolicy?.source === 'devHotReload'
            && runtime.loadPolicy.devUrl
            && moduleReference
            ? createReactNativeDevServerLoad({
                devUrl: runtime.loadPolicy.devUrl,
                pluginId: mountedPluginId,
                contributionId: resolvedRnContributionId,
                moduleReference,
            }, effectiveReactNativeLoaderBackend)
            : undefined;
        const load = installedArtifactLoad ?? devServerLoad;
        // §3.1: the RN transport's surface context is the CONTROLLER's — the same
        // one the API answering its requests was built from. The mount previously
        // stamped the renderer's bundle contribution here while the host API
        // stamped the declaring contribution, so an envelope and its answer named
        // two different contributions.
        const requestSurface = contributionId ? controller.surfaceContext : undefined;
        const reactNativeInteractionEnabled = controller.interactive
            && rendererInteractionEnabled
            && generatedArtifactAdmissionSatisfied;
        if (!generatedV2 || !artifactGraph || !requestSurface) {
            return renderUnavailable('canonical_render_context_unavailable');
        }
        if (!targetedContributions) {
            return renderUnavailable('targeted_contributions_unavailable');
        }
        if (reactNativeTechnicalAdmission?.kind !== 'available') {
            return renderUnavailable(reactNativeTechnicalAdmission?.kind === 'unavailable'
                ? reactNativeTechnicalAdmission.code
                : 'artifact_technical_admission_unavailable');
        }
        const canonicalRenderIdentity = {
            pluginId: mountedPluginId,
            pluginVersion: readOptionalString(contribution?.pluginVersion) ?? '0.0.0',
            viewId: mountedContributionId,
            mount: surfaceMount,
            generation: String(projectionGeneration ?? cacheIdentity?.projectionGeneration ?? 0),
            platform: props.platform ?? resolvedHostApi.platform,
            sessionId: props.sessionId,
            target: surfaceTarget,
            accountEncryptionMode,
            translations: surfaceTranslations,
            targetedContributions,
            ...(projectedBrand ? { brand: projectedBrand } : {}),
            ...(brandTargetPresentation
                ? {
                    brandTargetPresentation,
                }
                : {}),
            accountLifetime,
        };
        const descriptorDisplayRecord = readRecord(
            hasEmbeddedMount ? contribution?.display : descriptor!.display,
        );
        const descriptorDisplay = hasEmbeddedMount ? null : readPluginSurfaceDisplay(descriptor!);
        const snapshotTitle = hasEmbeddedMount
            ? readOptionalString(descriptorDisplayRecord?.label)
                ?? readOptionalString(descriptorDisplayRecord?.title)
                ?? mountedSurfaceId
            : resolvePluginDisplayString({
                developerFallback: descriptorDisplay?.developerFallback,
                keys: [descriptorDisplay?.labelKey, descriptorDisplay?.titleKey],
                resolveKey: createPluginSurfaceDisplayKeyResolver({
                    projection: mountedPluginUiProjection,
                    pluginId: descriptor!.pluginId,
                }),
            })
                ?? readOptionalString(descriptorDisplayRecord?.label)
                ?? readOptionalString(descriptorDisplayRecord?.title)
                ?? descriptor!.id;
        // The selected mount route is only transport selection; the exact token
        // remains the daemon's mutation fence. Unioned projections retain their
        // producer-stamped route, while a direct single-machine mount consumes
        // the exact machine/server facts already selected by its host.
        const crashReportTarget = exactGeneratedCrashState
            ? exactArtifactOrigin
                ? Object.freeze({
                    machineId: exactArtifactOrigin.executionOrigin.materializationRef.machineId,
                    serverId: exactArtifactOrigin.serverId,
                })
                : machineId
                    ? Object.freeze({ machineId, serverId })
                    : null
            : null;
        // The local watchdog is only a durable quarantine. Its pending rows
        // must remain bound to the host's exact daemon target plus the existing
        // Account lifetime, otherwise an equal daemon token could be replayed
        // after this mount changes server, machine, or Account.
        const crashReportScopeKey = crashReportTarget && accountLifetime?.isCurrent() === true
            ? JSON.stringify([
                crashReportTarget.machineId,
                serverAccountScopeKeySuffix(accountLifetime.scope),
            ])
            : undefined;
        const reportReactNativeFailure = exactGeneratedCrashState && crashReportTarget && crashReportScopeKey
            ? async (failure: PluginReactNativePendingFailure): Promise<ReactNativeCrashReportResult> => {
                if (
                    !controller.isCurrent()
                    || accountLifetime?.isCurrent() !== true
                    || !isSameDaemonPluginReactNativeCrashBindingTokenV1(
                        failure.token,
                        exactGeneratedCrashState.token,
                    )
                ) {
                    return Object.freeze({ ok: false, reason: 'binding_token_mismatch' });
                }
                return await submitReactNativeCrashReportViaMachineRpc({
                    machineId: crashReportTarget.machineId,
                    serverId: crashReportTarget.serverId,
                    report: {
                        kind: 'reportFailure',
                        token: exactGeneratedCrashState.token,
                        failureOccurrenceId: failure.failureOccurrenceId,
                        failure: failure.failure,
                    },
                });
            }
            : undefined;
        const resetReactNativeCrashState = exactGeneratedCrashState && crashReportTarget && crashReportScopeKey
            ? async (): Promise<ReactNativeCrashReportResult> => {
                if (!controller.isCurrent() || accountLifetime?.isCurrent() !== true) {
                    return Object.freeze({ ok: false, reason: 'unavailable' });
                }
                return await submitReactNativeCrashReportViaMachineRpc({
                    machineId: crashReportTarget.machineId,
                    serverId: crashReportTarget.serverId,
                    report: { kind: 'reset', token: exactGeneratedCrashState.token },
                });
            }
            : undefined;
        return renderWithTargetedSurfaceBoundary(
            <PluginReactNativeSurfaceHost
                surfaceId={mountedSurfaceId}
                mountInstanceKey={mountInstanceKey}
                snapshotTitle={snapshotTitle}
                requestSurface={requestSurface}
                decision={runtime?.decision ?? {
                    state: 'fallback',
                    reason: contributionId ? 'feature_disabled' : 'unknown',
                    diagnostics: contributionId ? ['react_native_loader_unavailable'] : ['react_native_contribution_unavailable'],
                    fallback: readFallbackRef(hasEmbeddedMount ? contribution?.fallback : descriptor!.fallback),
                }}
                {...(runtime?.loadPolicy ? { loadPolicy: runtime.loadPolicy } : {})}
                {...(runtime?.cacheKey ? { cacheKey: runtime.cacheKey } : {})}
                load={load}
                hostApi={resolvedHostApi}
                {...(targetedBinding ? {
                    ...(targetedRequest && targetedRequest.fallback !== undefined
                        ? { targetedFallback: targetedRequest.fallback }
                        : {}),
                    onTargetedSurfaceRenderFailure: reportTargetedSurfaceRenderFailure,
                } : {})}
                mountLifetime={controller}
                interactionEnabled={reactNativeInteractionEnabled}
                focusEligible={presentationFocusEligible}
                dataClient={mountedPluginUiDataClient}
                subscribeResourceInvalidations={controller.subscribeResourceInvalidations}
                canonicalRenderIdentity={canonicalRenderIdentity}
                launchInput={mountLaunchInput}
                subPath={mountSubPath}
                {...(composerBinding ? { composerRef: composerBinding.mount.composer } : {})}
                {...(physicalComposerSubscriptionPublisherSetter
                    ? { setComposerSubscriptionPublisher: physicalComposerSubscriptionPublisherSetter }
                    : {})}
                // Only an outer physical mount receives the private bridge.
                // Embedded B renders deliberately get no B→C path.
                renderTargetedSurface={hasEmbeddedMount ? undefined : renderReactTargetedSurface}
                targetedSurfaceUnavailableReason={targetedBinding ? 'unsupported_nested_targeted_surface' : undefined}
                {...(exactGeneratedCrashState ? {
                    crashStateToken: exactGeneratedCrashState.token,
                    crashStateDisabled: exactGeneratedCrashState.disabled,
                } : {})}
                {...(crashReportScopeKey ? { crashReportScopeKey } : {})}
                {...(reportReactNativeFailure ? { reportFailure: reportReactNativeFailure } : {})}
                {...(resetReactNativeCrashState ? { resetCrashState: resetReactNativeCrashState } : {})}
            />
        );
    }

    return null;
}

export function PluginSurfacePlacementHost(props: Readonly<{
    placement: PluginUiSurfacePlacementProjection;
    resourceBrowserTarget?: unknown;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    projectId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    platform?: LocalServicePreviewPlatform;
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
    channel?: PluginUiChannelV1;
    nowMs?: () => number;
    binding?: BoundPluginSurfaceBinding;
    /** EU-5a: the launch input the opener passed for THIS selected placement. */
    launchInput?: PluginUiLaunchInputV1;
    /** Resolver-stamped ephemeral instance identity; absent for legacy singleton mounts. */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** Recovery owned by the enclosing destination route. */
    unavailableAction?: SurfaceStateAction;
    /** EU-5b: the plugin-local location, for a full-page (`app.page`) mount. */
    subPath?: PluginUiSubPathV1;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
}>): React.ReactElement | null {
    return (
        <PluginSurfaceHost
            descriptor={props.placement}
            renderer={props.placement.renderer}
            resourceBrowserTarget={props.resourceBrowserTarget}
            machineId={props.machineId}
            serverId={props.serverId}
            sessionId={props.sessionId}
            agentId={props.agentId}
            projectId={props.projectId}
            pluginUiProjection={props.pluginUiProjection}
            localServicePreviewState={props.localServicePreviewState}
            platform={props.platform}
            formFactor={props.formFactor}
            channel={props.channel}
            nowMs={props.nowMs}
            binding={props.binding}
            launchInput={props.launchInput}
            mountInstanceKey={props.mountInstanceKey}
            unavailableAction={props.unavailableAction}
            subPath={props.subPath}
            projectionInteractionEnabled={props.projectionInteractionEnabled}
            policyContext={props.policyContext}
            reactNativeLoaderBackend={props.reactNativeLoaderBackend}
        />
    );
}

/**
 * Thin Settings-route adapter over the one bound surface host. Settings pages
 * have the same Registry-normalized destination binding as every other plugin
 * destination; this component deliberately adds no renderer or host-API path.
 */
export function PluginSettingsPageHost(props: Readonly<{
    page: PluginUiSettingsPageProjection;
    machineId?: string | null;
    serverId?: string | null;
    /** Explicit Settings-route daemon target; `null` intentionally disables origin fallback. */
    daemonSettingsTarget?: ScopedPluginSettingsDaemonTarget | null;
    isDaemonSettingsTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Settings-only availability is independent of this mount's action bridge. */
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
    pluginUiProjection?: PluginUiProjectionModel | null;
    platform?: LocalServicePreviewPlatform;
    channel?: PluginUiChannelV1;
    nowMs?: () => number;
    /** Settings-route navigation is supplied by the one qualified host resolver. */
    binding?: BoundPluginSurfaceBinding;
    /** Recovery owned by the enclosing Settings route. */
    unavailableAction?: SurfaceStateAction;
    projectionInteractionEnabled?: boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
}>): React.ReactElement | null {
    return (
        <PluginSurfaceHost
            descriptor={props.page}
            renderer={props.page.renderer}
            machineId={props.machineId}
            serverId={props.serverId}
            daemonSettingsTarget={props.daemonSettingsTarget}
            isDaemonSettingsTargetCurrent={props.isDaemonSettingsTargetCurrent}
            settingsScopesEnabled={props.settingsScopesEnabled}
            pluginUiProjection={props.pluginUiProjection}
            platform={props.platform}
            channel={props.channel}
            nowMs={props.nowMs}
            binding={props.binding}
            unavailableAction={props.unavailableAction}
            projectionInteractionEnabled={props.projectionInteractionEnabled}
            policyContext={props.policyContext}
            reactNativeLoaderBackend={props.reactNativeLoaderBackend}
        />
    );
}
