import type { ProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { useProjectContext } from '@/components/projects/useProjectContext';
import { MountedPluginActionControls } from './MountedPluginActionControls';
import * as React from 'react';
import { readCurrentPluginUiRendererProjection, resolveBundledPluginUiRendererArtifact } from '@/sync/domains/plugins/availability/bundledPluginUiRendererArtifact';
import { cloneStrictPluginJsonValue } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { usePluginSurfaceActionApproval } from './usePluginSurfaceActionApproval';
import { areServerProfileIdentifiersEquivalent, captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { useFindSurfaceRegistrationHost } from '@/keyboard/KeyboardShortcutProvider';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import type { PluginUiResourceStore, PluginUiWidgetAreaPresentation } from '@happier-dev/plugin-ui/advanced';
import { PluginUiHostPresentationScope } from '@happier-dev/plugin-ui/advanced';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { getInstalledPluginUiClientExecutableComposition, resolvePluginUiClientDragSourceRegistration, resolvePluginUiClientDropTargetRegistration } from '@/components/plugins/reactNative/clientExecutableContributions';
import { readPluginUiAccountExecutableOrigin } from '@/components/plugins/reactNative/executableModuleHost';
import { resolvePluginUiClientExecutablePlatform } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { createHostedEntityDragDropHandlers } from '@/components/plugins/hostApi/hostedEntityDragDrop';
import { createPluginEntityDragDropBinding, executeMountedPluginEntityDropAction, type PluginEntityDragDropBinding } from './entityDragDrop/pluginEntityDragDropBinding';
import { PluginEntityDragSourceView, PluginEntityDropTargetView } from './entityDragDrop/PluginEntityDragDropView';
import { PluginLiveStreamViewer } from './PluginLiveStreamViewer';
import { InputTypePickerHostProvider } from '@/components/sessions/actions/InputTypePickerHostProvider';
import { useSurfaceStateCardSize, useSurfaceStateQuietActions } from '@/components/ui/surfaces/surfaceStateSize';
import { useWidgetFrameHeaderBinding } from '@/components/widgets/frame/widgetFrameHeaderBinding';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';
import { useGlassMaterialColorResolver } from '@/components/ui/glass/useGlassSurfaceColor';
import { useContainingGlassSurfaceGroup } from '@/components/ui/glass/GlassSurface';

import { BrowserViewTargetV1Schema, type BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { PluginHostedHtmlSourceV1Schema, type PluginHostedHtmlSourceV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlSourceV1';
import { UiSurfaceNetworkRequestV1Schema, normalizeUiSurfaceCapabilityRequestV1, intersectUiSurfaceNetworkPoliciesV1, type UiSurfaceNetworkRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';
import type { ComposerRefV1 } from '@happier-dev/protocol/plugins/ui/composerRef';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import type { PluginUiTargetedSurfaceMountCoreV1, DaemonContributionRegistryProjectionMountedTargetV1, PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginDeclarativePreparedTargetedSurfaceInventoryEntryV1 } from '@happier-dev/protocol/plugins/contributions/ui/declarativeDocument';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginMachineExecutionOriginSelectorView } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { isPluginSurfaceMachineBound, usePluginSurfaceExecutionOrigin } from './pluginSurfaceExecutionOrigin';
import {
    PluginSurfaceSourceCauseContext,
    resolvePluginSurfaceSourceCause,
} from '@/components/plugins/shared/pluginSurfaceInteractionAvailability';
import { getPluginExecutionOriginCandidateOrigin, type PluginExecutionOriginContextualTarget } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import {
    buildPluginHostedWebStaticAssetPreviewId,
    isPluginUiSurfaceBindingAdmittedAtRuntimeV1,
    PluginUiFallbackRefV1Schema,
    resolvePluginUiInlineSurfaceSlotV1,
    resolvePluginUiHostedHtmlCapabilityRequestV1,
    type PluginUiChannelV1,
    type PluginUiDestinationRuntimeFormFactorV1,
    type PluginUiFallbackRefV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiArtifactDigestV1,
    type PluginUiInstanceKeyV1,
    type PluginUiInlineSurfaceMountV1,
    type PluginUiInlineSurfaceRoleV1,
    type PluginUiSurfaceBindingV1,
    type PluginUiJsonValueV1,
    type PluginUiLaunchInputV1,
    type PluginUiOpenConnectedAccountsRequestV1,
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
import { projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import { usePluginUiMediaStage } from './usePluginUiMediaStage';
import { PluginHostApiProvider } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiDataClient } from '@happier-dev/plugin-ui/data';

import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { resolveNegotiatedPluginSurfaceHostApiMethods } from '@/components/plugins/hostApi/negotiatedMethods';
import { useUiSurfaceRendererMount } from '@/components/plugins/hostApi/useUiSurfaceRendererMount';
import { useUiSurfaceOwnerLifetime } from '@/components/plugins/hostApi/useUiSurfaceOwnerLifetime';
import { PluginHostedWebPane } from '@/components/plugins/hostedWeb/PluginHostedWebPane';
import {
    PluginHostedWebUnavailable,
    readPluginHostedWebUnavailableDiagnosticCode,
    type PluginHostedWebUnavailableDiagnosticCode,
} from '@/components/plugins/hostedWeb/PluginHostedWebUnavailable';
import {
    createComposerPresentationHostHandlers,
    createComposerPresentationTransactionApplier,
    type ComposerPresentationHostOwner,
} from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import {
    useLayoutPresentationActive,
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
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import type { SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import {
    isUiSurfaceRendererKind,
    UiSurfaceRendererHost,
} from '@/components/ui/surfaces/UiSurfaceRendererHost';
import type { PluginReactNativeBundleCacheIdentity } from '@/components/plugins/reactNative/bundleCache';
import {
    PluginReactNativeSurface,
    type PluginReactNativeSurfaceModule,
} from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { PluginUiBoundary } from '@/components/plugins/reactNative/PluginUiBoundary';
import type { PluginReactNativeCompatibilityDecision } from '@/sync/domains/plugins/ui/reactNativeRuntime';
import type { PluginReactNativeLoaderBackend } from '@/components/plugins/reactNative/loader';
import { resolveDefaultReactNativeLoaderBackend } from '@/components/plugins/reactNative/resolveDefaultReactNativeLoaderBackend';
import type { PluginReactNativeLoaderPolicyInput } from '@/components/plugins/reactNative/loaderPolicy';
import {
    createCanonicalPluginReactNativeHostApiAdapter,
} from '@/components/plugins/reactNative/hostApi';
import { PluginSurfaceFallback, resolvePluginSurfaceStateAction } from '@/components/sessions/panes/PluginSurfaceFallback';
import {
    resolvePluginSurfaceStatePresentation,
    type PluginSurfacePresentationState,
} from '@/sync/domains/surfaces/copy';
import { getPreferredLanguage, t } from '@/text';
import { useHomeHasMachines, useMachineDisplayNamesById } from '@/sync/store/hooks';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
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
} from '@/sync/domains/plugins/ui/projection';
import type {
    PluginUiHostedWebProjection,
    PluginUiProjectionModel,
    PluginUiSettingsPageProjection,
    PluginUiPhysicalSurfacePlacementProjection,
    PluginUiInlineSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import {
    createInstalledPluginUiProjectionPublication,
    readPluginUiContributionOrigin,
    readPluginUiContributionSupplies,
    readPluginUiProjectionEntryExecutionOrigin,
} from '@/sync/domains/plugins/ui/projectionUnion';
import {
    createPluginUiHostedWebArtifactRequestFactsKey,
    createPluginUiReactNativeInstalledArtifactLoad,
    isPluginUiReactNativeArtifactTechnicallyAdmitted,
    PluginUiArtifactAdoptionOwner,
    readPluginUiGeneratedArtifactGraph,
    readPluginUiDaemonProjectionSelection,
    readPluginUiArtifactDaemonSources,
    readPluginUiGeneratedReactNativeModuleReference,
    readPluginUiReactNativeBundleCacheIdentity,
    resolvePluginUiRendererTechnicalAdmission,
    resolvePluginUiHostedWebArtifactTechnicalAdmission,
    type PluginUiArtifactAdoption,
    type PluginUiArtifactDaemonSource,
    type PluginUiHostedWebArtifactTechnicalAdmission,
} from '@/sync/domains/plugins/ui/artifactAdoption';
import type { PluginNativeArtifactResourceHandle } from '@/sync/domains/plugins/availability/nativeArtifactResource';
import type { PluginAccountHostedArtifactPublicationResult } from '@/sync/domains/plugins/availability/accountHostedArtifactPublication';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { readPluginActionInputSelectionPresenceSnapshot, type PluginActionInputSelectionSnapshot } from './pluginActionInputSelectionFacts';
import {
    useMountedTargetedContributions,
    type MountedTargetedContributionsState,
} from './mountedTargetedContributions';
import {
    resolvePluginLocalizedText,
    resolvePluginUiTranslationBundle,
    resolvePluginUiTranslationText,
} from '@/sync/domains/plugins/ui/i18n';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
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
import { usePluginUiHostPalette } from './pluginUiThemeProjection';
import { useNavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { useNavigationChromeShowsBack } from '@/components/ui/layout/navigationTitleChrome';
import { usePluginPageBackStepArmed } from '@/components/plugins/shared/PluginPageBackStep';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/PageHeader';
import { useNavigationTitleChromePublisher } from '@/components/ui/layout/navigationTitleChrome';
import { PluginArtifactHostingStatusProvider, renderPluginNavigationActions } from './pluginPageHeaderActions';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import {
    createPluginSurfaceComposerMountContext,
    createPluginSurfaceEphemeralMountContext,
    createPluginSurfaceDestinationMountContext,
    createPluginSurfaceInlineMountContext,
    createPluginSurfaceTargetedMountContext,
    readPluginSurfaceMountBinding,
    type PluginSurfaceComposerMountBinding,
    type PluginSurfaceEphemeralMountBinding,
    type PluginSurfaceTargetedMountBinding,
} from './pluginSurfaceMountBinding';
import {
    buildTargetedPluginSurfaceReadyTestId,
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
import { admitDeclarativeStaticModel } from './declarativeStaticModel';
import {
    projectDeclarativeTargetedSurfaceInventory,
    useDeclarativeDocumentSource,
    type DeclarativeDocumentSourcePresentation,
    type DeclarativeDocumentSourceMountScope,
} from './DeclarativeDocumentSource';
import {
    createPluginUiPrivatePresentationHost,
    type PluginDestinationRowInput,
    type PluginUiPrivateBrandTarget,
    type PluginUiPresentationBrand,
    type PluginUiPrivateTargetedSurfacePresentation,
} from './pluginUiPrivatePresentationHost';
import { renderPluginSessionPart } from './PluginSessionPartHost';
import { createDeclarativeWidgetAreaRender, type DeclarativeWidgetAreaRender } from './declarativeWidgetArea';
import { usePluginDestinationRowRenderer } from '@/components/appShell/workspace/usePluginDestinationRowRenderer';
import { useIsBeneathPluginSurfaceNestingBoundary } from './pluginSurfaceNesting';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePluginUiEphemeralSharedScopeBinding } from './pluginUiEphemeralSharedScope';
import {
    pluginUiProjectionAdmissionTargetKey,
    readPluginUiProjectionTargetedAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';
import { sync } from '@/sync/sync';
import {
    issueActivePluginAccountHostedArtifactBrowserFrame,
    type ActivePluginAccountHostedArtifactBrowserFrameIssueInput,
    type ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactBrowserFrame';
import { createPluginUiDataClient } from '@/sync/api/plugins/data/pluginUiDataClient';
import { createHostedWebAccountDataBridge } from '@/sync/api/plugins/data/hostedWebAccountDataBridge';
import type { ScopedPluginSettingsDaemonTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { useDetailsPaneSlotBinding } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { usePaneHeaderSlotBinding } from '@/components/appShell/panes/paneHeaderSlot';
import { resolvePluginUiFrameworkTranslations } from './pluginUiFrameworkTranslations';
import { useDeviceType } from '@/utils/platform/responsive';
import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';
import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';

type PluginSurfaceHostDescriptor = PluginUiPhysicalSurfacePlacementProjection | PluginUiSettingsPageProjection;

const surfaceHostStyles = StyleSheet.create({
    targetedReadyDiagnosticRoot: {
        minWidth: 0,
        minHeight: 0,
    },
    targetedReadyDiagnosticFill: {
        flex: 1,
    },
    // Host chrome above a pane's plugin content: it sits under the pane title,
    // on the same inset, never flush against the pane (or phone screen) edge.
    executionOriginBand: {
        paddingVertical: 8,
        paddingHorizontal: HEADER_BAND_HORIZONTAL_PADDING_PX,
        alignItems: 'flex-start',
    },
    executionOriginBandInWidget: { paddingHorizontal: 0 },
});

/**
 * A non-accessible device-QA observation of the incumbent mount lifetime. It
 * owns no identity or state: the exact admitted mount supplies the text and
 * the bound controller remains the sole currentness publisher.
 */
function TargetedPluginSurfaceReadyDiagnostic(props: Readonly<{
    mount: PluginUiTargetedSurfaceMountCoreV1;
    mountLifetime: BoundPluginSurfaceMountLifetime;
    children: React.ReactElement;
}>): React.ReactElement | null {
    const subscribe = React.useCallback((onRetire: () => void) => {
        const retirement = props.mountLifetime.onRetire(onRetire);
        return () => retirement.dispose();
    }, [props.mountLifetime]);
    const current = React.useSyncExternalStore(
        subscribe,
        props.mountLifetime.isCurrent,
        props.mountLifetime.isCurrent,
    );
    return (
        <View
            testID={current ? buildTargetedPluginSurfaceReadyTestId(props.mount) : undefined}
            accessible={false}
            collapsable={false}
            style={[
                surfaceHostStyles.targetedReadyDiagnosticRoot,
                props.mount.presentation === 'fill'
                    ? surfaceHostStyles.targetedReadyDiagnosticFill
                    : null,
            ]}
        >
            {props.children}
        </View>
    );
}

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
    surfaceActivity?: Readonly<{ active: boolean }>;
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
    mountLifetime: Pick<BoundPluginSurfaceMountLifetime, 'isCurrent'>;
    occurrenceId?: string;
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
        occurrenceId: input.occurrenceId,
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

/** The selected physical placement carries the registry-stamped occurrence. */
function readMountedTarget(input: Readonly<{
    pluginId: string | null | undefined;
    occurrenceId: string | null | undefined;
}>): DaemonContributionRegistryProjectionMountedTargetV1 | null {
    const pluginId = readOptionalString(input.pluginId);
    const occurrenceId = readOptionalString(input.occurrenceId);
    return pluginId && occurrenceId
        ? Object.freeze({ pluginId, occurrenceId })
        : null;
}

type MountedTargetProjectionFallback = Readonly<{
    state: Extract<PluginSurfacePresentationState, 'loading' | 'unavailable'>;
    reasonCode: string;
}>;

/**
 * Projects the target read's state into presentation only. Admission remains
 * owned by the target snapshot; this never fabricates a snapshot. A failed
 * read keeps its classified reason so the fallback says what happened.
 */
function resolveMountedTargetProjectionFallback(
    state: MountedTargetedContributionsState,
): MountedTargetProjectionFallback {
    switch (state.phase) {
        case 'loading':
            return Object.freeze({ state: 'loading', reasonCode: 'targeted_contributions_loading' });
        case 'idle':
            return Object.freeze({ state: 'unavailable', reasonCode: 'targeted_contributions_scope_unavailable' });
        case 'ready':
            // A current snapshot for a newer occurrence: the shell projection
            // has not caught up yet, and the mount will follow it.
            return Object.freeze({ state: 'loading', reasonCode: 'targeted_contributions_loading' });
        case 'failed':
            switch (state.failure?.reason) {
                case 'not-supported':
                    return Object.freeze({ state: 'unavailable', reasonCode: 'targeted_contributions_unsupported' });
                case 'timeout':
                    return Object.freeze({ state: 'unavailable', reasonCode: 'targeted_contributions_timeout' });
                case 'aborted':
                    return Object.freeze({ state: 'loading', reasonCode: 'targeted_contributions_loading' });
                case 'invalid-response':
                    return Object.freeze({ state: 'unavailable', reasonCode: 'targeted_contributions_invalid_response' });
                case 'unavailable':
                    if (state.failure.code === 'plugin_targeted_contributions_unavailable'
                        || state.failure.code === 'plugin_targeted_contributions_target_stale') {
                        return Object.freeze({ state: 'loading', reasonCode: state.failure.code });
                    }
                    return Object.freeze({ state: 'unavailable', reasonCode: 'targeted_contributions_target_unavailable' });
                default:
                    return Object.freeze({ state: 'unavailable', reasonCode: 'targeted_contributions_error' });
            }
    }
}

const EMPTY_PREPARED_TARGETED_SURFACE_MOUNTS: NonNullable<
    MountedTargetedContributionsState['preparedTargetedSurfaceMounts']
> = Object.freeze([]);

/** Only a transient failure can change when asked again. */
function isRetryableMountedTargetFailure(state: MountedTargetedContributionsState): boolean {
    return state.phase === 'failed'
        && (state.failure?.reason === 'timeout' || state.failure?.reason === 'error');
}

function hasExactMountedTargetedContributions(
    snapshot: PluginUiTargetedContributionsV1 | null | undefined,
    mountedTarget: DaemonContributionRegistryProjectionMountedTargetV1 | null,
): snapshot is PluginUiTargetedContributionsV1 {
    return mountedTarget !== null
        && snapshot?.target.pluginId === mountedTarget.pluginId
        && snapshot.target.occurrenceId === mountedTarget.occurrenceId;
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
            && mount.target.occurrenceId === mountedTarget.occurrenceId
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
            brand?.state === 'available' ? brand.monochrome === true : null,
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
    unavailableAction?: SurfaceStateAction;
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
    /** The page's declared widget areas, through this mount's one area facade. */
    renderWidgetArea?: DeclarativeWidgetAreaRender;
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
    /** Portable selected-server identity for Account perActiveServer bindings. */
    perActiveServerIdentityId?: string | null;
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
        presentationEnvironment: ReturnType<typeof projectHappierUiEnvironment>;
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
        diagnostics: document.resourceError?.diagnostics,
        // The packaged static model paints immediately and remains the valid
        // LKG until a complete dynamic document is atomically adopted.
        hasRetainedContent: true,
    });
    return (
        <DeclarativePluginSurface
            environment={props.presentationEnvironment}
            useSharedSpinner
            pluginId={props.pluginId}
            model={document.model}
            machineId={props.machineId}
            serverId={props.serverId}
            daemonSettingsTarget={props.daemonSettingsTarget}
            perActiveServerIdentityId={props.perActiveServerIdentityId}
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
            accountLifetime={props.accountLifetime}
            dataClient={props.dataClient}
            documentSourcePresentation={{
                presentation: documentSurfacePresentation,
                action: resolvePluginSurfaceStateAction({
                    recoveryAction: documentSurfacePresentation.recoveryAction,
                    onRetry: document.retry,
                    manageAction: props.unavailableAction,
                }),
            }}
            documentSourceSnapshot={{ current: document.presentation === 'fresh', readIdentity: document.readIdentity,
                readAuthorized: document.readAuthorized, digest: document.digest, refresh: document.retry }}
            captureIsCurrent={props.controller.isCurrent}
            renderTargetedSurface={props.renderTargetedSurface}
            reportUnsupportedNestedTargetedSurface={props.reportUnsupportedNestedTargetedSurface}
            {...(props.renderWidgetArea ? { renderWidgetArea: props.renderWidgetArea } : {})}
            embeddedPresentation={props.embeddedPresentation}
            contrast={props.contrast}
        />
    );
}

function DeclarativePluginSurfaceWithDocumentSource(
    props: DeclarativePluginSurfaceWithDocumentSourceProps,
) {
    const environment = props.environment;
    const presented = useLayoutPresentationActive();
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
    const occurrenceId = readOptionalString(modelIdentity?.occurrenceId);
    const adapterKey = occurrenceId
        ? `${props.controller.surfaceContext.surfaceId}:${occurrenceId}`
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
    const committedSurfaceSource = React.useRef({ adapter: hostApiAdapter, source: surface });
    React.useLayoutEffect(() => {
        if (committedSurfaceSource.current.adapter === hostApiAdapter
            && committedSurfaceSource.current.source !== surface) {
            hostApiAdapter?.pushSurfaceContext(surface);
        }
        committedSurfaceSource.current = { adapter: hostApiAdapter, source: surface };
    }, [hostApiAdapter, surface]);
    const readPublishedSurface = React.useCallback(
        () => hostApiAdapter?.getSurfaceContext() ?? surface,
        [hostApiAdapter, surface],
    );
    const subscribePublishedSurface = React.useCallback((listener: () => void) => (
        hostApiAdapter?.subscribeSurfaceContext(listener) ?? (() => {})
    ), [hostApiAdapter]);
    const publishedSurface = React.useSyncExternalStore(
        subscribePublishedSurface, readPublishedSurface, readPublishedSurface,
    );
    const presentationEnvironment = React.useMemo(
        () => projectHappierUiEnvironment(publishedSurface),
        [publishedSurface],
    );
    React.useEffect(() => {
        if (!hostApiAdapter) return;
        return props.controller.subscribeResourceInvalidations((event) => {
            hostApiAdapter.publishResourceSubscriptionEvent(event);
        });
    }, [hostApiAdapter, props.controller]);
    useUiSurfaceOwnerLifetime(hostApiAdapter);
    // The document adapter keeps its adopted document for the same Account and
    // occurrence. A replaced controller (new facts, reconnect) is therefore not
    // a new scope: currentness follows the latest controller through this
    // forwarder, while a retired controller with no successor still reads as
    // not current.
    const controllerRef = React.useRef(props.controller);
    controllerRef.current = props.controller;
    const latestControllerLifetime = React.useMemo(() => Object.freeze({
        isCurrent: (): boolean => controllerRef.current.isCurrent(),
    }), []);
    const documentMountScope = React.useMemo(() => occurrenceId
        ? createPluginUiPrivateResourceMountScope({
            pluginId: props.pluginId,
            accountLifetime: props.accountLifetime,
            mountLifetime: latestControllerLifetime,
            occurrenceId,
        })
        : null,
    [latestControllerLifetime, occurrenceId, props.accountLifetime, props.pluginId]);
    if (!hostApiAdapter || !documentMountScope) {
        return (
            <DeclarativePluginSurface
                environment={presentationEnvironment}
                pluginId={props.pluginId}
                model={props.staticModel}
                captureIsCurrent={props.controller.isCurrent}
                machineId={props.machineId}
                serverId={props.serverId}
                daemonSettingsTarget={props.daemonSettingsTarget}
                perActiveServerIdentityId={props.perActiveServerIdentityId}
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
                accountLifetime={props.accountLifetime}
                dataClient={props.dataClient}
                renderTargetedSurface={props.renderTargetedSurface}
                reportUnsupportedNestedTargetedSurface={props.reportUnsupportedNestedTargetedSurface}
                {...(props.renderWidgetArea ? { renderWidgetArea: props.renderWidgetArea } : {})}
                embeddedPresentation={props.embeddedPresentation}
                contrast={environment.contrast}
            />
        );
    }
    return (
        <PluginHostApiProviderWithPrivateResourceBinding
            hostApi={hostApiAdapter.api}
            accountLifetime={documentMountScope.accountLifetime}
            resourceStoreGeneration={documentMountScope.occurrenceId}
            mountedPluginId={documentMountScope.pluginId}
            surfaceActivity={{
                active: props.controller.isCurrent()
                    && props.interactionEnabled
                    && props.daemonInteractionEnabled
                    && presented,
            }}
            {...(props.composerRef === undefined ? {} : { composerRef: props.composerRef })}
        >
            <DeclarativePluginSurfaceDocumentContent
                presentationEnvironment={presentationEnvironment}
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

type MountedNativeHostedArtifact = Readonly<{
    adoption: PluginUiArtifactAdoption<'hostedWebNative', PluginNativeArtifactResourceHandle>;
    loadedRuntimeIdentity: Readonly<{
        pluginId: string;
        contributionId: string;
        artifactDigest: PluginUiHostedWebArtifactTechnicalAdmission['artifactGraph']['digest'];
    }>;
}>;

const artifactAdoptionStyles = StyleSheet.create({
    pendingFrame: {
        ...StyleSheet.absoluteFillObject,
        opacity: 0,
    },
});

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
    exactArtifactSource: PluginUiArtifactDaemonSource | null;
    artifactSources: readonly PluginUiArtifactDaemonSource[];
    onAccountHosting: (completion: Promise<PluginAccountHostedArtifactPublicationResult>) => void;
    admission: PluginUiHostedWebArtifactTechnicalAdmission | null;
    /** The bound surface controller remains the lifetime authority. */
    isCurrent: () => boolean;
}>): React.ReactElement {
    const [mountedNativeArtifact, setMountedNativeArtifact] = React.useState<MountedNativeHostedArtifact | null>(null);
    const [pendingNativeArtifact, setPendingNativeArtifact] = React.useState<MountedNativeHostedArtifact | null>(null);
    const [unavailableDiagnosticCode, setUnavailableDiagnosticCode] = React.useState<
        PluginHostedWebUnavailableDiagnosticCode | null
    >(null);
    const [acquisitionRevision, setAcquisitionRevision] = React.useState(0);
    const currentnessRef = React.useRef(props.isCurrent);
    currentnessRef.current = props.isCurrent;
    const isCurrent = React.useCallback(() => currentnessRef.current(), []);
    const ownerRef = React.useRef<PluginUiArtifactAdoptionOwner | null>(null);
    const mountInstanceKey = props.paneProps.mountInstanceKey;
    const artifactRequestFactsKey = createPluginUiHostedWebArtifactRequestFactsKey({
        platform: props.platform,
        source: props.exactArtifactSource,
        sources: props.artifactSources,
        admission: props.admission,
    });

    React.useEffect(() => {
        let active = true;
        setUnavailableDiagnosticCode(null);
        setPendingNativeArtifact(null);

        if (
            !isNativeHostedArtifactPlatform(props.platform)
            || !props.reader
            || !props.accountLifetime
            || !props.admission
            || !isCurrent()
        ) {
            ownerRef.current?.retire('withdrawn');
            ownerRef.current = null;
            setMountedNativeArtifact(null);
            setPendingNativeArtifact(null);
            return () => {
                active = false;
            };
        }

        const owner = ownerRef.current ?? new PluginUiArtifactAdoptionOwner({ isCurrent });
        ownerRef.current = owner;

        void (async () => {
            const acquired = await owner.adoptHostedWebNative({
                reader: props.reader!,
                artifactGraph: props.admission!.artifactGraph,
                cacheIdentity: props.admission!.cacheIdentity,
                accountLifetime: props.accountLifetime!,
                hostedWebPolicy: props.admission!.hostedWebPolicy,
                daemons: props.artifactSources,
                ...(props.admission!.daemonProjectionSelection
                    ? {
                        daemonProjectionSelection: {
                            ...props.admission!.daemonProjectionSelection,
                            isCurrent,
                        },
                    }
                    : {}),
                // The Artifact producer may use its incumbent verified cache
                // without a daemon. A daemon candidate needs the selected
                // transport; Account materialization provenance is optional.
                // Host never supplies app or Account byte-source adapters.
                ...(props.exactArtifactSource
                    ? {
                        daemon: props.exactArtifactSource,
                    }
                    : {}),
            });
            if (acquired.kind !== 'available') {
                if (active && isCurrent()) {
                    setUnavailableDiagnosticCode(
                        readPluginHostedWebUnavailableDiagnosticCode(acquired.code) ?? 'response_invalid',
                    );
                }
                return;
            }
            if (acquired.adoption.handle.accountHosting) props.onAccountHosting(acquired.adoption.handle.accountHosting);
            if (!active || !isCurrent()) {
                acquired.adoption.dispose();
                return;
            }
            const admission = props.admission!;
            const mounted = Object.freeze({
                adoption: acquired.adoption,
                loadedRuntimeIdentity: Object.freeze({
                    pluginId: admission.cacheIdentity.pluginId,
                    contributionId: admission.cacheIdentity.contributionId,
                    artifactDigest: admission.artifactGraph.digest,
                }),
            });
            setPendingNativeArtifact(mounted);
        })().catch(() => {
            if (active && isCurrent()) setUnavailableDiagnosticCode('transport_unavailable');
        });

        return () => {
            active = false;
        };
    // Equivalent parsed projection objects must not retire an otherwise-current
    // native token. This dependency key contains every Artifact request fact;
    // it is deliberately not a cache or persistence identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        props.accountLifetime,
        props.reader,
        acquisitionRevision,
        isCurrent,
        mountInstanceKey,
        artifactRequestFactsKey,
    ]);

    React.useEffect(() => () => {
        ownerRef.current?.dispose();
        ownerRef.current = null;
    }, []);

    const retry = () => setAcquisitionRevision((revision) => revision + 1);
    const renderPane = (
        mounted: MountedNativeHostedArtifact | null,
        candidate: boolean,
    ) => (
        <PluginHostedWebPane
            {...props.paneProps}
            nativeArtifactAdoption={mounted?.adoption ?? null}
            nativeArtifactLoadedRuntimeIdentity={mounted?.loadedRuntimeIdentity ?? null}
            unavailableDiagnosticCode={candidate ? null : unavailableDiagnosticCode}
            onUnavailableRetry={retry}
            {...(candidate && mounted ? {
                focusEligible: false,
                artifactCandidatePreparing: true,
                retainCandidateAdoptionOnUnmount: true,
                onArtifactCandidateReady: () => {
                    if (!mounted.adoption.commit()) return;
                    setMountedNativeArtifact(mounted);
                    setPendingNativeArtifact(null);
                    setUnavailableDiagnosticCode(null);
                },
                onArtifactCandidateFailure: (code: string) => {
                    mounted.adoption.fail(code);
                    setPendingNativeArtifact(null);
                    setUnavailableDiagnosticCode(readPluginHostedWebUnavailableDiagnosticCode(code) ?? 'response_invalid');
                },
            } : {})}
        />
    );
    if (!mountedNativeArtifact) return renderPane(pendingNativeArtifact, pendingNativeArtifact !== null);
    return (
        <>
            {unavailableDiagnosticCode ? (
                <PluginHostedWebUnavailable
                    diagnosticCode={unavailableDiagnosticCode}
                    onRetry={retry}
                    recoveryAction={props.paneProps.unavailableAction}
                />
            ) : null}
            {renderPane(mountedNativeArtifact, false)}
            {pendingNativeArtifact ? (
                <View pointerEvents="none" style={artifactAdoptionStyles.pendingFrame}>
                    {renderPane(pendingNativeArtifact, true)}
                </View>
            ) : null}
        </>
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
        || cacheIdentity.platform !== 'web'
        || cacheIdentity.artifactId !== artifactGraph.artifactId
        || cacheIdentity.artifactDigest !== artifactGraph.digest
    ) {
        return null;
    }

    let currentArtifact: ReturnType<PluginAccountAvailabilityReader['readCurrentArtifact']>;
    try {
        currentArtifact = reader.readCurrentArtifact({
            pluginId: cacheIdentity.pluginId,
            contributionId: cacheIdentity.contributionId,
            tier: artifactGraph.tier,
            platform: cacheIdentity.platform,
        });
    } catch {
        return null;
    }
    if (currentArtifact.kind !== 'available') return null;

    const selected = currentArtifact.artifact;
    if (
        selected.pluginId !== cacheIdentity.pluginId
        || selected.contributionId !== cacheIdentity.contributionId
        || selected.artifactId !== artifactGraph.artifactId
        || selected.tier !== artifactGraph.tier
        || selected.platform !== cacheIdentity.platform
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
            artifactId: selected.artifactId,
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
    const [pendingFrame, setPendingFrame] = React.useState<Extract<
        ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
        { kind: 'available' }
    > | null>(null);
    const [candidateFailure, setCandidateFailure] = React.useState<PluginHostedWebUnavailableDiagnosticCode | null>(null);
    const pendingFrameRef = React.useRef(pendingFrame);
    pendingFrameRef.current = pendingFrame;
    const [expiredFrame, setExpiredFrame] = React.useState<Extract<
        ActivePluginAccountHostedArtifactBrowserFrameIssueResult,
        { kind: 'available' }
    > | null>(null);
    const [issuanceRevision, setIssuanceRevision] = React.useState(0);
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
        source: null,
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
                setPendingFrame(null);
                setExpiredFrame(null);
            }
        };

        if (!currentRequest || !accountLifetime || !accountLifetime.isCurrent() || !isCurrent()) {
            setFrame(null);
            setPendingFrame(null);
            setExpiredFrame(null);
            return () => {
                mounted = false;
                controller.abort();
            };
        }

        const retirement = accountLifetime.onRetire(retire);
        void issueActivePluginAccountHostedArtifactBrowserFrame({
            ...currentRequest,
            accountLifetime,
            signal: controller.signal,
        }).then((result) => {
            if (!mounted || controller.signal.aborted || !accountLifetime.isCurrent() || !isCurrent()) {
                return;
            }
            if (result.kind === 'available') {
                setPendingFrame(result);
                setCandidateFailure(null);
            } else {
                setCandidateFailure(readPluginHostedWebUnavailableDiagnosticCode(result.code) ?? 'response_invalid');
                setFrame((current) => current ?? result);
            }
        }).catch(() => {
            if (!mounted || controller.signal.aborted || !accountLifetime.isCurrent() || !isCurrent()) {
                return;
            }
            setCandidateFailure('transport_unavailable');
            setFrame((current) => current ?? Object.freeze({ kind: 'unavailable' as const, code: 'transport_unavailable' as const }));
        });

        return () => {
            mounted = false;
            controller.abort();
            retirement.dispose();
        };
    // These keys contain the issued coordinate and the existing technical
    // admission facts. `issuanceRevision` changes only when the user invokes
    // the unavailable state's Retry; expiry itself never starts renewal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        props.accountLifetime,
        props.reader,
        issuanceRevision,
        isCurrent,
        mountInstanceKey,
        requestKey,
        technicalAdmissionKey,
    ]);

    const availableFrame = frame?.kind === 'available' ? frame : null;
    React.useEffect(() => {
        if (!availableFrame) return;
        const remainingMs = availableFrame.value.expiresAt - Date.now();
        if (remainingMs <= 0) {
            setExpiredFrame(availableFrame);
            return;
        }
        const timeout = setTimeout(
            () => {
                setExpiredFrame(availableFrame);
            },
            Math.min(remainingMs, 2_147_483_647),
        );
        return () => {
            clearTimeout(timeout);
        };
    }, [availableFrame]);
    const unavailableDiagnosticCode = candidateFailure ?? (availableFrame !== null && expiredFrame === availableFrame
        ? 'hosted_web_preview_expired'
        : frame?.kind === 'unavailable' ? frame.code : null);
    const appliedFrame = availableFrame !== null && expiredFrame !== availableFrame ? availableFrame : null;
    const retry = () => setIssuanceRevision((revision) => revision + 1);
    const renderFramePane = (
        candidate: Extract<ActivePluginAccountHostedArtifactBrowserFrameIssueResult, { kind: 'available' }> | null,
        pending: boolean,
    ) => (
        <PluginHostedWebPane
            {...props.paneProps}
            endpointUrl={candidate?.value.url ?? null}
            expiresAt={candidate?.value.expiresAt ?? null}
            opaqueArtifactFrame
            unavailableDiagnosticCode={pending ? null : unavailableDiagnosticCode}
            onUnavailableRetry={unavailableDiagnosticCode === null ? undefined : retry}
            {...(pending && candidate ? {
                focusEligible: false,
                artifactCandidatePreparing: true,
                onArtifactCandidateReady: () => {
                    if (pendingFrameRef.current !== candidate) return;
                    setFrame(candidate);
                    setPendingFrame(null);
                    setExpiredFrame(null);
                    setCandidateFailure(null);
                },
                onArtifactCandidateFailure: (code: string) => {
                    if (pendingFrameRef.current !== candidate) return;
                    setPendingFrame(null);
                    setCandidateFailure(readPluginHostedWebUnavailableDiagnosticCode(code) ?? 'response_invalid');
                },
            } : {})}
        />
    );
    if (!appliedFrame) return renderFramePane(pendingFrame, pendingFrame !== null);
    return (
        <>
            {unavailableDiagnosticCode ? (
                <PluginHostedWebUnavailable
                    diagnosticCode={unavailableDiagnosticCode}
                    onRetry={retry}
                    recoveryAction={props.paneProps.unavailableAction}
                />
            ) : null}
            {renderFramePane(appliedFrame, false)}
            {pendingFrame ? (
                <View pointerEvents="none" style={artifactAdoptionStyles.pendingFrame}>
                    {renderFramePane(pendingFrame, true)}
                </View>
            ) : null}
        </>
    );
}

function PluginReactNativeSurfaceHost(props: Readonly<{
    renderWidgetArea?: DeclarativeWidgetAreaRender;
    entityDragBinding?: PluginEntityDragDropBinding | null;
    readLiveStreamViewing: BoundPluginSurfaceController['readLiveStreamViewing'];
    liveStreamMachineId: string | null;
    liveStreamServerId: string | null;
    surfaceId: string;
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** Existing host-owned mount/catalog identity for local error recovery. */
    boundaryResetKey?: string;
    snapshotTitle: string;
    /** Host-private request envelope; never published to the RN module. */
    requestSurface: PluginUiSurfaceContextV1;
    decision: PluginReactNativeCompatibilityDecision;
    loadPolicy?: PluginReactNativeLoaderPolicyInput;
    cacheKey?: string;
    load?: (signal: AbortSignal) => Promise<PluginReactNativeSurfaceModule>;
    unavailableAction?: SurfaceStateAction;
    hostApi: PluginSurfaceHostApiV1;
    resourceStore?: PluginUiResourceStore;
    /** Targeted caller fallback for a contributor render crash. */
    targetedFallback?: React.ReactNode;
    /** A Composer chip's own content, drawn in place of every state card. */
    stateFallback?: React.ReactNode;
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
    loadedRuntimeIdentity?: Readonly<{
        pluginId: string;
        occurrenceId: string;
        artifactDigest: PluginUiArtifactDigestV1;
        machineId?: string | null;
        serverId?: string | null;
    }>;
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
        occurrenceId?: string;
        /** Immutable admitted presentation bytes, independent of executable occurrence. */
        artifactDigest: PluginUiArtifactDigestV1;
        platform: string;
        sessionId?: string | null;
        target: PluginSurfaceTarget;
        accountEncryptionMode: SurfaceContext['accountEncryptionMode'];
        translations: Readonly<Record<string, string>>;
        /** Exact daemon-admitted target snapshot for the sole Host API mount. */
        targetedContributions: SurfaceContext['targetedContributions'];
        pendingApproval: SurfaceContext['pendingApproval'];
        machineConnectionPending: boolean;
        machineExecutionReady: boolean;
        requesterExecutionReady: boolean;
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
        /** Exact producer/materialization origin for ephemeral shared-scope slots. */
        executionOrigin?: PluginMachineExecutionOriginV1 | null;
    }>;
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
    const hostActivelyViewed = useHostActivelyViewed();
    // One context owner (§3.2): the environment facts, the exact target and the
    // plugin's translation bundle all come from `pluginSurfaceContext.ts`, the
    // same module the hosted-web mount consumes.
    const environment = usePluginSurfaceEnvironment(canonicalIdentity.platform);
    const surfaceSource = React.useMemo(() => createPluginSurfaceContext({
        mount: canonicalIdentity.mount,
        target: canonicalIdentity.target,
        accountEncryptionMode: canonicalIdentity.accountEncryptionMode,
        environment,
        translations: canonicalIdentity.translations,
        targetedContributions: canonicalIdentity.targetedContributions,
        pendingApproval: canonicalIdentity.pendingApproval,
        machineConnectionPending: canonicalIdentity.machineConnectionPending,
        machineExecutionReady: canonicalIdentity.machineExecutionReady,
        requesterExecutionReady: canonicalIdentity.requesterExecutionReady,
    }), [
        canonicalIdentity.mount,
        canonicalIdentity.target,
        canonicalIdentity.accountEncryptionMode,
        canonicalIdentity.translations,
        canonicalIdentity.targetedContributions,
        canonicalIdentity.pendingApproval,
        canonicalIdentity.machineConnectionPending,
        canonicalIdentity.machineExecutionReady,
        canonicalIdentity.requesterExecutionReady,
        environment,
    ]);
    const canonicalRenderIdentity = React.useMemo(() => {
        return Object.freeze({
            pluginId: canonicalIdentity.pluginId,
            pluginVersion: canonicalIdentity.pluginVersion,
            viewId: canonicalIdentity.viewId,
            mount: canonicalIdentity.mount,
            occurrenceId: canonicalIdentity.occurrenceId,
            platform: canonicalIdentity.platform,
            sessionId: canonicalIdentity.sessionId,
            target: canonicalIdentity.target,
            accountEncryptionMode: canonicalIdentity.accountEncryptionMode,
            brand: canonicalIdentity.brand,
            targetedContributions: canonicalIdentity.targetedContributions,
            executionOrigin: canonicalIdentity.executionOrigin,
            surface: surfaceSource,
        });
    }, [
        canonicalIdentity.occurrenceId,
        canonicalIdentity.mount,
        canonicalIdentity.platform,
        canonicalIdentity.pluginId,
        canonicalIdentity.pluginVersion,
        canonicalIdentity.sessionId,
        canonicalIdentity.target,
        canonicalIdentity.targetedContributions,
        canonicalIdentity.pendingApproval,
        canonicalIdentity.machineConnectionPending,
        canonicalIdentity.machineExecutionReady,
        canonicalIdentity.requesterExecutionReady,
        canonicalIdentity.translations,
        canonicalIdentity.viewId,
        canonicalIdentity.brand,
        canonicalIdentity.accountEncryptionMode,
        canonicalIdentity.executionOrigin,
        surfaceSource,
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
            canonicalIdentity.artifactDigest,
            JSON.stringify(canonicalRenderIdentity.mount),
            canonicalRenderIdentity.occurrenceId,
            canonicalRenderIdentity.platform,
            canonicalRenderIdentity.sessionId ?? '',
            getPluginSurfaceTargetAuthorityKey(canonicalRenderIdentity.target),
            // Target snapshot admission updates context in place. The actual
            // controller/mountLifetime below owns caller authority retirement.
            props.mountInstanceKey ?? '',
    ].join('\u001f');
    const canonicalAccountLifetime = canonicalIdentity.accountLifetime;
    const rendererMount = useUiSurfaceRendererMount({
        lifetime: props.mountLifetime,
        interactionEnabled: props.interactionEnabled,
        focusEligible: props.focusEligible,
    });
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
    const committedSurfaceSource = React.useRef({
        adapter: canonicalHostApiAdapter,
        source: surfaceSource,
    });
    React.useLayoutEffect(() => {
        // Initial acquisition belongs to the constructor, not a second push.
        if (committedSurfaceSource.current.adapter !== canonicalHostApiAdapter
            || committedSurfaceSource.current.source === surfaceSource) {
            committedSurfaceSource.current = { adapter: canonicalHostApiAdapter, source: surfaceSource };
            return;
        }
        canonicalHostApiAdapter.pushSurfaceContext(canonicalRenderIdentity.surface);
        committedSurfaceSource.current = { adapter: canonicalHostApiAdapter, source: surfaceSource };
    }, [canonicalHostApiAdapter, canonicalRenderIdentity.surface, surfaceSource]);
    const publishedSurface = React.useSyncExternalStore(
        canonicalHostApiAdapter.subscribeSurfaceContext,
        canonicalHostApiAdapter.getSurfaceContext,
        canonicalHostApiAdapter.getSurfaceContext,
    );
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
    const { signal, isFocusEligible } = rendererMount;
    const canonicalPrivateResourceMountScope = React.useMemo(
        () => createPluginUiPrivateResourceMountScope({
            pluginId: canonicalIdentity.pluginId,
            accountLifetime: canonicalAccountLifetime,
            mountLifetime: props.mountLifetime,
            occurrenceId: canonicalIdentity.occurrenceId,
        }),
        [
            canonicalAccountLifetime,
            canonicalIdentity.occurrenceId,
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
    const { theme: hostTheme } = useUnistyles();
    const resolveMaterialColor = useGlassMaterialColorResolver(useContainingGlassSurfaceGroup());
    const projectedHostPalette = usePluginUiHostPalette(hostTheme);
    const hostPaletteRef = React.useRef(projectedHostPalette);
    if (stableJsonStringify(projectedHostPalette) !== stableJsonStringify(hostPaletteRef.current)) {
        hostPaletteRef.current = projectedHostPalette;
    }
    const hostPalette = hostPaletteRef.current;
    // The page chrome a plugin page header and its sections place themselves by, exactly as a core
    // `PageHeader` reads it: whether the navigation already shows the title, its back control and
    // the content column.
    const chromeShowsTitle = useNavigationTitleChromeShowsTitle();
    const setChromeTitle = useNavigationTitleChromePublisher()?.setTitle;
    const BackControl = useNavigationBackControl();
    const columnMaxWidthPx = useLayoutMaxWidth();
    // The header's own Back answers a page-internal step before it leaves the page, so a pushed detail draws none of its own.
    const navigationShowsBack = useNavigationChromeShowsBack();
    const pageBackStepArmed = usePluginPageBackStepArmed();
    const navigationBackSpendsStep = navigationShowsBack && pageBackStepArmed;
    const hostPageChrome = React.useMemo(() => ({
        showsTitle: chromeShowsTitle,
        renderBack: BackControl ? (style: StyleProp<ViewStyle>) => <BackControl style={style} /> : null,
        columnMaxWidthPx,
        renderNavigationActions: renderPluginNavigationActions,
        navigationBackSpendsStep,
        ...(setChromeTitle === undefined ? {} : { publishTitle: setChromeTitle }),
    }), [BackControl, chromeShowsTitle, columnMaxWidthPx, navigationBackSpendsStep, setChromeTitle]);
    // The page's app details pane, when this mount sits in a page that has one: a plugin `DetailsPane` (and a
    // `Collection` opening its items) renders there.
    const detailsPaneBinding = useDetailsPaneSlotBinding();
    const presented = useLayoutPresentationActive();
    // The pane header of the tab this mount fills: a plugin's `PaneHeaderContent` lands there, beside the
    // tab's title, exactly where built-in tabs put their "+" and live line.
    const widgetHeaderBinding = useWidgetFrameHeaderBinding();
    const tabHeaderBinding = usePaneHeaderSlotBinding();
    const paneHeaderBinding = widgetHeaderBinding ?? tabHeaderBinding;
    // The container the mount sits in (a session sidebar tab is a `pane`, a phone surface `phone`), so
    // a plugin's unsized states size themselves like the host's own states around them.
    const hostStateSize = useSurfaceStateCardSize();
    // A widget card never owns its page's primary: its plugin states offer their way forward quiet, like the host's.
    const hostQuietStateActions = useSurfaceStateQuietActions();
    const destinationRowRenderer = usePluginDestinationRowRenderer();
    const findRegistrationHost = useFindSurfaceRegistrationHost();
    const mediaStage = usePluginUiMediaStage();
    const renderDestinationRow = React.useCallback((input: PluginDestinationRowInput) => destinationRowRenderer({
        ...input,
        destination: qualifyPluginContributionReferenceV1(input.destination, canonicalRenderIdentity.pluginId),
    }), [canonicalRenderIdentity.pluginId, destinationRowRenderer]);
    const canonicalPrivatePresentationHost = React.useMemo(
        () => createPluginUiPrivatePresentationHost(
            canonicalRenderIdentity.brand,
            {
                pluginId: canonicalRenderIdentity.pluginId,
                ...(canonicalAccountLifetime ? { markdownWorkspace: {
                    target: canonicalRenderIdentity.target,
                    serverId: canonicalAccountLifetime.scope.serverId,
                } } : {}),
                direction: environment.direction,
                mediaStage,
                renderLiveStream: (input) => <PluginLiveStreamViewer {...input} hostApi={props.hostApi}
                    surface={props.requestSurface} mountLifetime={props.mountLifetime} readViewing={props.readLiveStreamViewing}
                    machineId={props.liveStreamMachineId} serverId={props.liveStreamServerId} />,
                ...(brandTargetPresentation
                    ? {
                        resolveBrandTarget: brandTargetPresentation.resolveBrandTarget,
                        fallbackBrandDisplayName: brandTargetPresentation.fallbackBrandDisplayName,
                        brandPresentationInput: {
                            machineId: brandTargetPresentation.machineId,
                            serverId: brandTargetPresentation.serverId,
                            signal,
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
                // Same-realm RN/RNW mounts only: hosted-web and declarative adapters never receive it.
                renderSessionPart: (input) => renderPluginSessionPart(input, {
                    accountLifetime: canonicalAccountLifetime,
                    presented,
                    focusEligible: props.focusEligible,
                }),
                // The page's declared areas, named for this plugin ("Add to PRs & Issues").
                ...(props.renderWidgetArea ? { renderWidgetArea: (input: PluginUiWidgetAreaPresentation) => props.renderWidgetArea!({ ...input,
                    testID: input.testID ?? `widget-area.${input.area}` }) } : {}),
                renderDestinationRow,
                ...(props.entityDragBinding ? {
                    renderDragSource: input => <PluginEntityDragSourceView binding={props.entityDragBinding!} {...input} />,
                    renderDropTarget: input => <PluginEntityDropTargetView binding={props.entityDragBinding!} {...input} />,
                } : {}),
                isFocusEligible,
                ...(findRegistrationHost ? { find: findRegistrationHost } : {}),
                palette: hostPalette,
                resolveMaterialColor,
                pageChrome: hostPageChrome,
                ...(hostStateSize === undefined ? {} : { stateSize: hostStateSize }),
                ...(hostQuietStateActions ? { stateActions: 'quiet' as const } : {}),
                ...(detailsPaneBinding === null ? {} : { detailsPane: detailsPaneBinding }),
                ...(paneHeaderBinding === null ? {} : { paneHeader: paneHeaderBinding }),
            },
        ),
        [
            renderDestinationRow,
            props.renderWidgetArea,
            findRegistrationHost,
            mediaStage,
            props.entityDragBinding,
            hostStateSize,
            hostQuietStateActions,
            detailsPaneBinding,
            paneHeaderBinding,
            hostPalette,
            resolveMaterialColor,
            hostPageChrome,
            signal,
            canonicalAccountLifetime,
            presented,
            props.focusEligible,
            canonicalRenderIdentity.brand,
            canonicalRenderIdentity.pluginId,
            canonicalRenderIdentity.target,
            brandTargetPresentation?.fallbackBrandDisplayName,
            brandTargetPresentation?.machineId,
            brandTargetPresentation?.resolveBrandTarget,
            brandTargetPresentation?.serverId,
            canonicalTargetAuthorityKey,
            environment.direction,
            hasRenderTargetedSurface,
            isFocusEligible,
            isBrandTargetPresentationCurrent,
            renderTargetedSurface,
            props.targetedSurfaceUnavailableReason,
            props.hostApi, props.requestSurface, props.mountLifetime, props.readLiveStreamViewing,
            props.liveStreamMachineId, props.liveStreamServerId,
        ],
    );
    const canonicalPrivateDataClient = props.dataClient ?? undefined;
    const canonicalEphemeralSharedScope = usePluginUiEphemeralSharedScopeBinding({
        accountLifetime: canonicalAccountLifetime,
        pluginId: canonicalIdentity.pluginId,
        occurrenceId: canonicalIdentity.occurrenceId,
        artifactDigest: canonicalIdentity.artifactDigest,
        executionOrigin: canonicalIdentity.executionOrigin,
        mountLifetime: props.mountLifetime,
    });
    const canonicalPrivateHostBindings = React.useMemo(() => Object.freeze({
        presentationActive: hostActivelyViewed && isFocusEligible(),
        accountLifetime: canonicalPrivateResourceMountScope.accountLifetime,
        resourceStoreGeneration: canonicalPrivateResourceMountScope.occurrenceId,
        ...(props.resourceStore ? { resourceStore: props.resourceStore } : {}),
        ...(canonicalPrivatePresentationHost === undefined
            ? {}
            : { presentationHost: canonicalPrivatePresentationHost }),
        ...(canonicalPrivateDataClient === undefined
            ? {}
            : { dataClient: canonicalPrivateDataClient }),
        ...(props.composerRef === undefined
            ? {}
            : { composerRef: props.composerRef }),
        ephemeralSharedScope: canonicalEphemeralSharedScope,
    }), [
        hostActivelyViewed,
        isFocusEligible,
        props.focusEligible,
        props.interactionEnabled,
        canonicalPrivateDataClient,
        canonicalPrivatePresentationHost,
        canonicalPrivateResourceMountScope,
        props.resourceStore,
        props.composerRef,
        canonicalEphemeralSharedScope,
    ]);
    const widgetPresentation = useWidgetPresentation();
    const canonicalRenderContext = React.useMemo<RenderContext>(() => {
        const identity = canonicalRenderIdentity;
        const context = {
            plugin: Object.freeze({ id: identity.pluginId, version: identity.pluginVersion }),
            surface: publishedSurface,
            hostApi: canonicalHostApiAdapter.api,
            signal,
            activity: Object.freeze({
                active: rendererMount.isCurrent() && props.interactionEnabled && presented,
            }),
            // EU-5a: absent launch input stays absent. Spreading a `{ launchInput:
            // undefined }` key would make "opened without input" indistinguishable
            // from "opened with an explicit undefined" for an author reading the key.
            ...(props.launchInput === undefined ? {} : { launchInput: props.launchInput }),
            ...(widgetPresentation === undefined ? {} : { widgetPresentation }),
            // EU-5b: the page's own location. Absent on every placement that is
            // not a page, and `''` at a page root — the two are different facts.
            ...(props.subPath === undefined ? {} : { subPath: props.subPath }),
        } satisfies RenderContext;
        return Object.freeze(context);
    }, [
        signal,
        canonicalHostApiAdapter,
        canonicalRenderIdentity,
        publishedSurface,
        rendererMount.isCurrent,
        presented,
        props.interactionEnabled,
        props.launchInput,
        widgetPresentation,
        props.subPath,
    ]);

    useUiSurfaceOwnerLifetime(canonicalHostApiAdapter);

    return (
        <PluginReactNativeSurface
            surfaceId={props.surfaceId}
            mountInstanceKey={props.mountInstanceKey}
            {...(props.boundaryResetKey === undefined ? {} : { boundaryResetKey: props.boundaryResetKey })}
            snapshotTitle={props.snapshotTitle}
            decision={props.decision}
            {...(props.loadPolicy ? { loadPolicy: props.loadPolicy } : {})}
            {...(props.cacheKey ? { cacheKey: props.cacheKey } : {})}
            load={props.load}
            recoveryAction={props.unavailableAction}
            subjectName={canonicalIdentity.brand?.displayName}
            renderContext={canonicalRenderContext}
            {...(props.targetedFallback === undefined ? {} : { targetedFallback: props.targetedFallback })}
            {...(props.stateFallback === undefined ? {} : { stateFallback: props.stateFallback })}
            {...(props.onTargetedSurfaceRenderFailure ? { onCrash: props.onTargetedSurfaceRenderFailure } : {})}
            privateHostBindings={canonicalPrivateHostBindings}
            interactionEnabled={props.interactionEnabled}
                focusEligible={props.focusEligible}
                loadedRuntimeIdentity={props.loadedRuntimeIdentity}
        />
    );
}

function readReactNativeRuntimeState(
    entry: Readonly<Record<string, unknown>> | null,
    platform: 'web' | 'ios' | 'android',
): Readonly<{
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
    const cacheKey = runtime.cacheKey;
    const graph = readPluginUiGeneratedArtifactGraph(entry);
    const pluginId = readOptionalString(entry?.pluginId);
    const contributionId = readOptionalString(entry?.contributionId);
    const cacheIdentity = graph?.tier === 'reactNative' && pluginId && contributionId
        ? readPluginUiReactNativeBundleCacheIdentity(runtime.cacheIdentity, {
            pluginId,
            contributionId,
            artifactId: graph.artifactId,
            platform,
        })
        : null;
    return Object.freeze({
        decision: normalizedDecision,
        ...(source === 'installedArtifact'
            ? {
                loadPolicy: Object.freeze({ source }) as PluginReactNativeLoaderPolicyInput,
            }
            : {}),
        ...(typeof cacheKey === 'string' && cacheKey.trim().length > 0 ? { cacheKey } : {}),
        ...(cacheIdentity ? { cacheIdentity } : {}),
    });
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
function resolveSurfaceResourceScope(binding: PluginUiSurfaceBindingV1 | null) {
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
    | Readonly<{ canRender: false; reason: string; state?: 'loading' }>;

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

export function resolvePluginSurfaceDescriptorRenderGate(
    descriptor: PluginSurfaceHostDescriptor,
    policyContext: PluginUiPolicyEvaluationContext,
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
    if (availability?.state === 'resolving') {
        return { canRender: false, reason: 'plugin_execution_origin_pending', state: 'loading' };
    }
    if (availability?.state !== 'available') {
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

const INLINE_LOADING_MARKER_STYLE = { width: 0, height: 0 } as const;

function renderPluginSurfaceUnavailable(
    reasonCode: string,
    action?: SurfaceStateAction,
    state: Extract<PluginSurfacePresentationState, 'loading' | 'unavailable'> = 'unavailable',
    onRetry?: () => void,
    subjectName?: string,
): React.ReactElement {
    return (
        <PluginSurfaceFallback
            testID="plugin-surface-unavailable"
            state={state}
            reasonCode={reasonCode}
            subjectName={subjectName}
            action={action}
            onRetry={onRetry}
            accessibilitySemantics="status"
        />
    );
}

/** Retain presentation only; the bound controller still admits every operation. */
function PluginSurfacePresentation(props: Readonly<{
    lifetime: BoundPluginSurfaceMountLifetime;
    children?: React.ReactElement;
    notice?: React.ReactNode;
}>): React.ReactElement {
    const committed = React.useRef<Readonly<{
        lifetime: BoundPluginSurfaceMountLifetime;
        content: React.ReactElement;
    }> | null>(null);
    React.useLayoutEffect(() => {
        if (props.children && props.lifetime.isCurrent()) {
            committed.current = { lifetime: props.lifetime, content: props.children };
        } else if (committed.current?.lifetime !== props.lifetime || !props.lifetime.isCurrent()) {
            committed.current = null;
        }
    });
    // Account, target and occurrence retirement must still remove private state.
    const retained = committed.current?.lifetime === props.lifetime && props.lifetime.isCurrent()
        ? committed.current.content : null;
    return <>{props.notice}<React.Fragment key="surface">{props.children ?? retained}</React.Fragment></>;
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
    /** Exact response-local projection map; never a broad app projection lookup. */
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    /** Exact response-local V2 package/translation facts for B presentation. */
    pluginProjectionV2?: PluginProjectionV2 | null;
    /** Already composed and normalized by this target's acquisition publication. */
    pluginUiProjection: PluginUiProjectionModel | null;
    actionInputSelectionFactsKey: PluginActionInputSelectionSnapshot;
    /** Only the admitted runtime catalog lends Composer attachment authority. */
    runtimeComposerAttachmentsById?: PluginUiProjectionModel['composerAttachmentsById'];
    /**
     * The response-local daemon authority is ready. Retained exact target facts
     * may keep B presented during revalidation, but daemon mutations remain
     * unavailable until the next authoritative response settles.
     */
    daemonProjectionReady: boolean;
    /** Borrowed currentness for the parent's optional scoped Machine transport. */
    isExecutionOriginCurrent?: BoundPluginSurfaceBinding['isExecutionOriginCurrent'];
}>;

/**
 * The one live Composer arm of the generalized physical surface host. The
 * caller has already paired a host-stamped mount with the daemon's exact
 * current catalog row; this host consumes those facts without selecting a
 * renderer, inventing a destination, or retaining a Composer registry.
 */
export type PluginSurfaceComposerMountProps = Readonly<{
    mount: PluginSurfaceComposerMountBinding;
    /** Existing exact mount/catalog identity; changing it retires this renderer. */
    boundaryResetKey?: string;
    /** The real physical target for generic Resource/context semantics. */
    physicalTarget: PluginSurfaceTarget;
    /** The incumbent Composer scope lifetime; this host only observes it. */
    parentLifetime: BoundPluginSurfaceMountLifetime;
    /** Exact response-local action projection for the admitted generation. */
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    /** Exact current V2 projection for translations/package presentation. */
    pluginProjectionV2?: PluginProjectionV2 | null;
    pluginUiProjection: PluginUiProjectionModel;
    actionInputSelectionFactsKey: PluginActionInputSelectionSnapshot;
    /** Mutation admission remains closed until this current response is ready. */
    daemonProjectionReady: boolean;
    /** Canonical Composer badge shown if the selected renderer cannot mount. */
    fallback?: React.ReactNode;
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

/** One non-destination embedded mount whose placement owns an ephemeral result. */
export type PluginSurfaceEphemeralMountProps = Readonly<{
    mount: PluginSurfaceEphemeralMountBinding;
    boundaryResetKey?: string;
    physicalTarget: PluginSurfaceTarget;
    parentLifetime: BoundPluginSurfaceMountLifetime;
    pluginProjectionById?: Readonly<Record<string, PluginProjectionEntry>> | null;
    pluginProjectionV2?: PluginProjectionV2 | null;
    pluginUiProjection: PluginUiProjectionModel;
    actionInputSelectionFactsKey: PluginActionInputSelectionSnapshot;
    daemonProjectionReady: boolean;
    fallback?: React.ReactNode;
    binding?: BoundPluginSurfaceBinding;
}>;

type PluginSurfaceHostDestinationInput = Readonly<{
    descriptor: PluginSurfaceHostDescriptor;
    renderer: Readonly<Record<string, unknown>>;
    targetedMount?: never;
    composerMount?: never;
    ephemeralMount?: never;
}>;

type PluginSurfaceHostTargetedInput = Readonly<{
    descriptor?: never;
    renderer?: never;
    targetedMount: PluginSurfaceTargetedMountProps;
    composerMount?: never;
    ephemeralMount?: never;
}>;

type PluginSurfaceHostComposerInput = Readonly<{
    descriptor?: never;
    renderer?: never;
    targetedMount?: never;
    composerMount: PluginSurfaceComposerMountProps;
    ephemeralMount?: never;
}>;

type PluginSurfaceHostEphemeralInput = Readonly<{
    descriptor?: never;
    renderer?: never;
    targetedMount?: never;
    composerMount?: never;
    ephemeralMount: PluginSurfaceEphemeralMountProps;
}>;

/**
 * The one physical plugin-surface mount owner. Beneath an embedded Session presentation it mounts
 * nothing (`PluginSurfaceNestingBoundary`), whichever region asked for the surface.
 */
export function PluginSurfaceHost(props: PluginSurfaceHostProps): React.ReactElement | null {
    if (useIsBeneathPluginSurfaceNestingBoundary()) return null;
    return <PluginSurfaceHostMount {...props} />;
}

type PluginSurfaceHostProps = React.ComponentProps<typeof PluginSurfaceHostMount>;

function PluginSurfaceHostMount(props: Readonly<(
    PluginSurfaceHostDestinationInput | PluginSurfaceHostTargetedInput | PluginSurfaceHostComposerInput | PluginSurfaceHostEphemeralInput
) & {
    resourceBrowserTarget?: unknown;
    contextualExecutionTarget?: PluginExecutionOriginContextualTarget | null;
    machineId?: string | null;
    serverId?: string | null;
    /** Explicit Settings-route daemon target; `null` intentionally disables origin fallback. */
    daemonSettingsTarget?: ScopedPluginSettingsDaemonTarget | null;
    /** Portable selected-server identity for Account perActiveServer bindings. */
    perActiveServerIdentityId?: string | null;
    isDaemonSettingsTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Settings-only availability is independent of this mount's action bridge. */
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
    sessionId?: string | null;
    agentId?: string | null;
    /** §3.2: the exact identities this placement owns for its declared target. */
    projectId?: string | null;
    projectContext?: ProjectWidgetAreaContextV1 | null;
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
    /** Persisted widget egress choice, intersected with the installed renderer ceiling. */
    guestNetworkOverride?: UiSurfaceNetworkRequestV1;
    /** Resolver-stamped ephemeral instance identity; absent for legacy singleton mounts. */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** Validated current framed-renderer height; the outer placement owns sizing. */
    onIntrinsicHeightChange?: (height: number) => void;
    /** Route-owned recovery for generic destination unavailability; targeted mounts keep their caller fallback. */
    unavailableAction?: SurfaceStateAction;
    /**
     * EU-5b: the plugin-local location for a full-page (`app.page`) mount — the
     * remainder of the host-generated route after the page root. Absent at every
     * placement that has no location under it.
     */
    subPath?: PluginUiSubPathV1;
    projectionInteractionEnabled?: boolean;
    /** The containing host's actual current document admission. */
    isHostCurrent?: () => boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
    /** Exact host-owned inline placement; admission remains in the Surface Registry. */
    inlineMount?: Readonly<{
        role: PluginUiInlineSurfaceRoleV1;
        presentation: 'content' | 'fill';
    }>;
}>): React.ReactElement | null {
    const router = useRouter();
    const targetedMount = 'targetedMount' in props ? props.targetedMount : undefined;
    const composerMount = 'composerMount' in props ? props.composerMount : undefined;
    const ephemeralMount = 'ephemeralMount' in props ? props.ephemeralMount : undefined;
    const targetedRequest = targetedMount?.request;
    const targetedBinding = targetedRequest?.mount ?? null;
    const composerBinding = composerMount?.mount ?? null;
    const ephemeralBinding = ephemeralMount?.mount ?? null;
    // Resolve an ordinary inline placement before deciding composition depth.
    // Unlike daemon-selected targeted/Composer/ephemeral mounts, an inline
    // placement still owns its descriptor and renderer; it is nevertheless an
    // embedded parent and must not receive a B→C targeted bridge.
    const projectedMountBinding = React.useMemo(
        () => props.descriptor
            ? readPluginSurfaceMountBinding({ descriptor: props.descriptor, renderer: props.renderer! })
            : null,
        [props.descriptor, props.renderer],
    );
    const inlineMountBindingCandidate = props.inlineMount && projectedMountBinding?.kind === 'inline'
        ? projectedMountBinding
        : null;
    const hasEmbeddedRendererMount = targetedBinding !== null || composerBinding !== null || ephemeralBinding !== null;
    // This is the single composition-depth fact: all physical embedded mounts,
    // including valid Agent/session-info inline mounts, are one level deep.
    const hasEmbeddedMount = hasEmbeddedRendererMount || inlineMountBindingCandidate !== null;
    const descriptor = hasEmbeddedRendererMount ? null : props.descriptor;
    const renderer = targetedBinding
        ? targetedBinding.renderer as Readonly<Record<string, unknown>>
        : composerBinding
            ? composerBinding.renderer as Readonly<Record<string, unknown>>
            : ephemeralBinding
                ? ephemeralBinding.renderer as Readonly<Record<string, unknown>>
            : inlineMountBindingCandidate?.renderer ?? props.renderer!;
    // Embedded children consume the daemon's exact selected artifact entry
    // verbatim; neither arm looks the contributor up in a broad UI projection.
    const selectedEmbeddedRenderer = targetedBinding?.mount.selectedRenderer
        ?? composerBinding?.catalogEntry.selectedRenderer
        ?? ephemeralBinding?.surface.selectedRenderer
        ?? null;
    const mountedRendererArtifact = selectedEmbeddedRenderer?.artifactProjection
        ? selectedEmbeddedRenderer.artifactProjection as Readonly<Record<string, unknown>>
        : null;
    const mountedPluginId = targetedBinding?.mount.contributor.pluginId
        ?? composerBinding?.mount.contribution.pluginId
        ?? ephemeralBinding?.surface.contribution.pluginId
        ?? descriptor!.pluginId;
    const mountedContributionId = targetedBinding?.mount.contributor.contributionId
        ?? composerBinding?.mount.contribution.localId
        ?? ephemeralBinding?.surface.contribution.localId
        ?? descriptor!.id;
    const mountedSurfaceId = targetedBinding
        ? `targeted:${targetedRequest!.instanceKey}`
        : composerBinding
            ? `composer:${composerBinding.mount.instanceKey}`
            : ephemeralBinding
                ? `ephemeral:${ephemeralBinding.surface.contribution.pluginId}:${ephemeralBinding.surface.contribution.localId}`
            : descriptor!.id;
    const mountedInstanceKey = targetedBinding
        ? targetedRequest!.instanceKey
        : composerBinding
            ? composerBinding.mount.instanceKey
            : ephemeralBinding
                ? `ephemeral:${ephemeralBinding.surface.contribution.pluginId}:${ephemeralBinding.surface.contribution.localId}`
            : props.mountInstanceKey;
    // Ordinary configured copies have the same host-owned instance/input pair
    // as targeted children. Rendering and surface Resources read one frozen
    // snapshot; neither a plugin nor a sibling copy can rewrite that context.
    const ordinaryLaunchInput = React.useMemo(() => props.launchInput === undefined ? undefined
        : cloneStrictPluginJsonValue(props.launchInput, 'surface.launchInput') as PluginUiLaunchInputV1,
    [props.launchInput]);
    const ordinaryResourceContext = React.useMemo(() => mountedInstanceKey ? Object.freeze({
        kind: 'surface' as const, mountInstanceKey: mountedInstanceKey, launchInput: ordinaryLaunchInput ?? null,
    }) : undefined, [mountedInstanceKey, ordinaryLaunchInput]);
    const availabilityReader = useActivePluginAccountAvailabilityReader(mountedPluginId);
    // Registry projections are immutable for the lifetime of one render input.
    // Parse that exact input once rather than cloning its normalized binding on
    // every unrelated host render. Object identity is only the React cache key:
    // a replacement descriptor or renderer is always revalidated, while
    // generation/currentness remains owned by the bound controller below.
    const mountBinding = targetedBinding
        ?? composerBinding
        ?? ephemeralBinding
        ?? projectedMountBinding;
    const selectedSurfaceBinding = mountBinding?.kind === 'destination'
        ? mountBinding.destinationBinding
        : mountBinding?.kind === 'inline'
            ? mountBinding.inlineBinding
            : null;
    const selectedInlineBinding = selectedSurfaceBinding?.kind === 'inline'
        ? selectedSurfaceBinding
        : null;
    const surfaceScope = React.useMemo(
        () => targetedBinding
            ? Object.freeze({ declared: false as const, reason: 'surface_target_undeclared' as const })
            : composerBinding
                ? resolveResourceScope({ kind: 'session' })
                : ephemeralBinding
                    ? resolveResourceScope({ kind: 'app' })
            : resolveSurfaceResourceScope(selectedSurfaceBinding),
        [composerBinding, ephemeralBinding, selectedSurfaceBinding, targetedBinding],
    );
    const addressedProjectRef = useProjectAccountWorkspaceRef(surfaceScope.declared && surfaceScope.targetKind === 'project'
        && props.projectContext === undefined ? props.projectId ?? null : null, props.serverId ?? undefined);
    const readProjectContext = useProjectContext({ serverId: props.serverId ?? addressedProjectRef?.serverId ?? '',
        projectRef: addressedProjectRef, activeCheckout: addressedProjectRef });
    const suppliedProjectContext = props.projectContext === undefined ? readProjectContext : props.projectContext;
    const projectContext = suppliedProjectContext && (suppliedProjectContext.scope.authority?.isCurrent() ?? true)
        && (!props.serverId || areServerProfileIdentifiersEquivalent(suppliedProjectContext.scope.serverId, props.serverId)) ? suppliedProjectContext : null;
    // F7 — an app-scope projection is a UNION across every eligible online
    // machine, so the CONTRIBUTION carries the machine that produced it. Every
    // effect this mount performs — action dispatch, resource reads, artifact
    // fetches, crash reports, declarative settings — binds to that origin, its
    // generation and its executable authority, so a placement can never be
    // executed against a machine that merely had a newer heartbeat.
    //
    // A single-machine (session/project/browser/services) projection stamps no
    // origin, and there the mount's own facts remain authoritative.
    // Composition depth does not select execution: ordinary app inline widgets
    // consume the same Account union and Administration owner as app pages.
    // Daemon-selected embedded mounts already carry their exact contextual origin.
    const accountUnionMount = !hasEmbeddedRendererMount && selectedSurfaceBinding?.targetKind === 'app'
        && Array.isArray(descriptor?.hostSupplies);
    const accountExecutionOrigin = React.useMemo(() => targetedBinding?.mount.accountExecutionOrigin
        ?? (accountUnionMount ? readPluginUiAccountExecutableOrigin(descriptor) : null),
    [accountUnionMount, descriptor, targetedBinding]);
    // An app union may first present a Machine declaration, then publish this
    // same destination under Account custody. Loading ending elsewhere cannot
    // admit reads from that interim requester. Availability publishes bundled
    // declarations atomically with its first scoped observation.
    const requesterAccountAdmission = accountUnionMount
        ? availabilityReader?.readCurrentAccountExecution(mountedPluginId) : undefined;
    const requesterAccountProjection = accountUnionMount ? availabilityReader?.readAccountUiProjection() : null;
    const requesterAccountEntry = descriptor?.contributionKind === 'settingsPage'
        ? requesterAccountProjection?.settingsPagesById[descriptor.id]
        : descriptor ? requesterAccountProjection?.surfacePlacementsById[descriptor.id] : undefined;
    // Renderer byte selection cannot admit a retained Machine requester while
    // Availability already owns this exact destination under Account custody.
    const expectedRequesterOrigin = React.useMemo(() => readPluginUiAccountExecutableOrigin(requesterAccountEntry),
        [requesterAccountEntry]);
    const requesterAccountObservationLoaded = requesterAccountAdmission !== undefined
        && (requesterAccountAdmission.kind === 'available'
            || (requesterAccountAdmission.code !== 'account_availability_not_loaded'
                && requesterAccountAdmission.code !== 'account_availability_scope_mismatch'));
    const requesterProjectionOriginAdmitted = !accountUnionMount || (requesterAccountObservationLoaded
        && (expectedRequesterOrigin
            ? accountExecutionOrigin !== null
                && accountExecutionOrigin.accountId === expectedRequesterOrigin.accountId
                && areServerProfileIdentifiersEquivalent(accountExecutionOrigin.serverId, expectedRequesterOrigin.serverId)
                && accountExecutionOrigin.custodyId === expectedRequesterOrigin.custodyId
                && pluginSourceCustodyV1Equal(accountExecutionOrigin.sourceCustody, expectedRequesterOrigin.sourceCustody)
            // A loaded absence settles a genuine Machine requester, not a
            // retained Account declaration whose custody was withdrawn.
            : accountExecutionOrigin === null));
    const needsMachineExecution = accountUnionMount && descriptor != null && isPluginSurfaceMachineBound({
        pluginId: mountedPluginId, surface: descriptor, projection: props.pluginUiProjection,
    });
    const showsExecutionOriginSelector = needsMachineExecution && props.descriptor?.contributionKind === 'surfacePlacement'
        && (props.descriptor.binding.kind !== 'destination' || props.descriptor.binding.container !== 'appPage');
    // Inside a widget frame the body's own inset is the edge: the pane band's inset would push the chip past it.
    const insideWidgetFrame = useWidgetPresentation() !== undefined;
    const pluginExecution = usePluginSurfaceExecutionOrigin({
        pluginId: mountedPluginId, projection: props.pluginUiProjection, entry: descriptor,
        enabled: needsMachineExecution,
        includeMachineCandidates: showsExecutionOriginSelector,
        contextualTarget: props.contextualExecutionTarget,
        surfaceTarget: surfaceScope.declared && surfaceScope.targetKind === 'project' ? projectContext?.target : undefined,
    });
    // A host-only renderer still has a real mounted caller. Retain only the
    // producer already stamped on this declaration, never elect a Machine for
    // presentation or turn generic executeAction into a daemon requirement.
    const presentationSupply = React.useMemo(() => {
        if (!accountUnionMount || needsMachineExecution || !descriptor) return null;
        const producer = readPluginUiContributionOrigin(descriptor);
        const producerOrigin = producer?.executionOrigin;
        if (!producerOrigin || !descriptor.occurrenceId) return null;
        return readPluginUiContributionSupplies(descriptor).find(supply => supply.executionOrigin
            && supply.occurrenceId === descriptor.occurrenceId
            && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, producerOrigin)) ?? null;
    }, [accountUnionMount, descriptor, needsMachineExecution]);
    // Producer snapshots are immutable; preserve their derived origin between
    // unrelated parent and Availability-only updates.
    const origin = React.useMemo(() => accountUnionMount
        ? needsMachineExecution ? pluginExecution.selectedSupply : presentationSupply
        : descriptor ? readPluginUiContributionOrigin(descriptor) : null,
    [accountUnionMount, descriptor, needsMachineExecution, pluginExecution.selectedSupply, presentationSupply]);
    // The same producer-stamped origin backs both unioned and direct machine
    // projections. A mounted action never reconstructs this ref from UI facts.
    const executionOrigin = React.useMemo(() => targetedBinding?.mount.executionOrigin
        ?? composerBinding?.catalogEntry.executionOrigin
        ?? ephemeralBinding?.surface.executionOrigin
        ?? origin?.executionOrigin
        ?? (!accountUnionMount && descriptor ? readPluginUiProjectionEntryExecutionOrigin(descriptor) : undefined),
    [accountUnionMount, composerBinding, descriptor, ephemeralBinding, origin, targetedBinding]);
    const machineId = (executionOrigin ? getPluginMachineExecutionOriginRef(executionOrigin).machineId : null)
        ?? origin?.machineId
        ?? (needsMachineExecution ? pluginExecution.selection.storedTarget?.machineId : null)
        ?? (accountUnionMount ? null : props.machineId);
    // Administration's refusal, with the one Machine that refused when it is only one.
    const executionSelectionState = needsMachineExecution ? pluginExecution.selection.state : null;
    const refusingMachineIds = React.useMemo(() => executionSelectionState?.kind === 'unavailable'
        ? [...new Set(executionSelectionState.candidates.map(candidate => (
            getPluginMachineExecutionOriginRef(getPluginExecutionOriginCandidateOrigin(candidate)).machineId)))]
        : [], [executionSelectionState]);
    const machineDisplayIds = React.useMemo(() => [
        ...(typeof machineId === 'string' && machineId.trim() ? [machineId] : []),
        ...refusingMachineIds,
    ], [machineId, refusingMachineIds]);
    const machineDisplayNamesById = useMachineDisplayNamesById(machineDisplayIds);
    const homeHasMachines = useHomeHasMachines();
    const machineDisplayName = typeof machineId === 'string'
        ? machineDisplayNamesById[machineId] ?? null
        : null;
    const serverId = hasEmbeddedRendererMount ? props.serverId : origin ? origin.serverId
        : accountUnionMount ? accountExecutionOrigin?.serverId ?? pluginExecution.selection.storedTarget?.serverIdentityId ?? null : props.serverId;
    // The daemon byte route: the machine this mount reads from. It is
    // transport only; the lease verifies whatever bytes it returns.
    const exactArtifactSource = typeof machineId === 'string' && typeof serverId === 'string'
        ? Object.freeze({ machineId, serverId })
        : null;
    const mountedComposerMediaExecutionTarget = React.useMemo<SessionExecutionTargetV1 | undefined>(() => (
        typeof serverId === 'string' && typeof machineId === 'string'
            ? Object.freeze({ serverId, machineId })
            : undefined
    ), [machineId, serverId]);
    const mountedPluginUiProjection = (
        targetedBinding
            ? targetedMount?.pluginUiProjection ?? null
            : composerBinding
                ? composerMount?.pluginUiProjection ?? null
                : ephemeralBinding
                    ? ephemeralMount?.pluginUiProjection ?? null
                : props.pluginUiProjection ?? null
    );
    const installedPackagesById = mountedPluginUiProjection?.installedPackagesById;
    const projectionInteractionEnabled = selectedEmbeddedRenderer
        ? props.projectionInteractionEnabled !== false
            && selectedEmbeddedRenderer.availability.state === 'available'
        : origin
            ? origin.phase === 'current' && origin.interactionEnabled === true
            // Machine-free Account reads need no execution-origin selection.
            // A machine-backed mount with no admitted origin still fails closed.
            : accountUnionMount && needsMachineExecution ? false : props.projectionInteractionEnabled;
    const daemonInteraction = usePluginSurfaceDaemonInteraction({
        machineId,
        projectionInteractionEnabled,
    });
    const daemonSettingsInteraction = usePluginSurfaceDaemonInteraction({
        machineId: props.daemonSettingsTarget?.machineId ?? machineId,
    });
    // Acquire the exact routed Account lifetime once for this mount. It remains an
    // opaque cancellation/currentness input: neither the surface host nor the
    // artifact learns an Account id or creates another epoch.
    //
    // Refresh on retirement so presentation fails closed synchronously even if
    // no unrelated parent state happens to rerender this host first. The existing
    // credential-scope owner remains the only lifecycle owner; this mount merely
    // observes its existing retirement callback.
    const [, refreshAfterAccountRetirement] = React.useReducer((revision: number) => revision + 1, 0);
    const routedAccountBindings = useServerCredentialAccountScopeBindings(serverId ? [serverId] : []);
    const accountLifetime: ActiveServerAccountScopeLifetime | null = serverId
        ? routedAccountBindings.values().next().value ?? null
        : captureActiveServerAccountScopeLifetime();
    const reactNativeFeatureEnabled = useFeatureEnabled('plugins.ui.reactNativeBundles', {
        scopeKind: 'spawn', serverId: serverId ?? accountLifetime?.scope.serverId ?? '',
    });
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(refreshAfterAccountRetirement);
        return () => retirement?.dispose();
    }, [accountLifetime]);
    const mountedTargetPluginId = hasEmbeddedRendererMount
        ? null
        : selectedSurfaceBinding?.kind === 'destination'
            ? selectedSurfaceBinding.destination.pluginId
            : selectedSurfaceBinding?.surface.pluginId;
    const mountedTarget = React.useMemo(() => readMountedTarget({
        pluginId: mountedTargetPluginId,
        occurrenceId: accountExecutionOrigin?.custodyId ?? (accountUnionMount
            ? needsMachineExecution ? pluginExecution.selectedSupply?.occurrenceId : presentationSupply?.occurrenceId
            : readOptionalString(descriptor?.occurrenceId)),
    }), [accountExecutionOrigin?.custodyId, accountUnionMount, descriptor?.occurrenceId, mountedTargetPluginId, needsMachineExecution, pluginExecution.selectedSupply?.occurrenceId, presentationSupply?.occurrenceId]);
    // Every current public SurfaceContext carries this target-scoped snapshot;
    // an admitted empty point list is valid, but an absent snapshot is not
    // silently rewritten into a legacy context.
    const mountedTargetSnapshotRequired = mountedTarget !== null;
    // App declarations/Artifacts admit rendering. The optional daemon point
    // inventory admits its capabilities, never the Account page around them.
    const renderRequiresTargetSnapshot = mountedTargetSnapshotRequired && !accountUnionMount;
    // The catalog row says whether the target declares contribution points. A
    // plugin without points has an empty snapshot by definition, so its mount
    // makes no second request.
    const mountedTargetRow = mountedTarget
        ? mountedPluginUiProjection?.installedPackagesById?.[mountedTarget.pluginId]
        : undefined;
    // The Account catalog may retain another installation's package row. Its
    // presentation cannot stamp the selected Machine's mounted caller custody.
    const mountedTargetSourceCustody = accountExecutionOrigin?.sourceCustody ?? (accountUnionMount
        ? (needsMachineExecution ? pluginExecution.selectedSupply : presentationSupply)?.sourceCustody
        : executionOrigin && 'sourceRef' in executionOrigin
            ? executionOrigin.sourceRef.sourceCustody
            : mountedTargetRow?.sourceCustody);
    const mountedTargetDeclaresPoints = mountedTargetRow?.declaresContributionPoints !== false
        || !mountedTargetSourceCustody;
    // Bumping the refresh key re-asks the daemon for this target. It backs the
    // Retry on a transiently failed read and is never advanced on its own.
    const [mountedTargetRefreshKey, setMountedTargetRefreshKey] = React.useState(0);
    const retryMountedTargetProjection = React.useCallback(() => {
        setMountedTargetRefreshKey((current) => current + 1);
    }, []);
    const mountedTargetRead = useMountedTargetedContributions({
        accountLifetime,
        accountExecutionOrigin: accountExecutionOrigin ?? undefined,
        machineId,
        serverId,
        pluginId: mountedTarget?.pluginId,
        mountedOccurrenceId: mountedTarget?.occurrenceId,
        enabled: mountedTargetSnapshotRequired && mountedTargetDeclaresPoints,
        refreshKey: mountedTargetRefreshKey,
    });
    // The per-machine projection the shell already holds: actions, composer
    // attachments and child mounts come from it, never from the target read.
    const mountedMachineProjection = useDaemonMergedProjectionInputs({
        accountLifetime,
        machineId,
        serverId,
        enabled: mountedTargetSnapshotRequired,
    });
    const pointlessTargetedContributions = React.useMemo((): PluginUiTargetedContributionsV1 | null => {
        if (!mountedTarget || mountedTargetDeclaresPoints || !mountedTargetSourceCustody) return null;
        const snapshot: PluginUiTargetedContributionsV1 = {
            target: Object.freeze({
                pluginId: mountedTarget.pluginId,
                occurrenceId: mountedTarget.occurrenceId,
                sourceCustody: mountedTargetSourceCustody,
            }),
            points: [],
        };
        Object.freeze(snapshot.points);
        return Object.freeze(snapshot);
    }, [mountedTarget, mountedTargetDeclaresPoints, mountedTargetSourceCustody]);
    // The read answers with the daemon's current occurrence. A different tag
    // means the plugin reloaded: the shell projection follows and the mount
    // is rebuilt for the new occurrence instead of failing.
    const currentMountedTargetRead = hasExactMountedTargetedContributions(
        mountedTargetRead.targetedContributions,
        mountedTarget,
    )
        ? mountedTargetRead
        : null;
    const mountedTargetedContributions = pointlessTargetedContributions
        ?? currentMountedTargetRead?.targetedContributions
        ?? null;
    // Action and SurfaceContext text belong to this exact mounted source,
    // independently of another replica's aggregate presentation declarations.
    const pointlessProjectionPublication = React.useMemo(
        () => createInstalledPluginUiProjectionPublication(), [accountLifetime, machineId, serverId],
    );
    const pointlessMachineProjection = pointlessTargetedContributions && mountedMachineProjection.phase === 'ready'
        ? mountedMachineProjection.inputs?.pluginUiProjection ?? null : null;
    const mountedPresentationUiProjection = React.useMemo(() => currentMountedTargetRead
        ? currentMountedTargetRead.pluginUiProjection
        : pointlessMachineProjection
            ? pointlessProjectionPublication.publish(mountedPluginUiProjection ? [mountedPluginUiProjection] : [], pointlessMachineProjection)
            : mountedPluginUiProjection,
    [currentMountedTargetRead, mountedPluginUiProjection, pointlessMachineProjection, pointlessProjectionPublication]);
    // Daemon-owned interaction needs only the current target slice: a page is
    // never gated on the whole-machine describe. Machine projection inputs
    // (actions, composer attachments, child mounts) are used when present and
    // retained through a refresh.
    const mountedMachineInputs = mountedTargetedContributions !== null
        ? pointlessTargetedContributions !== null ? mountedMachineProjection.inputs : currentMountedTargetRead?.projectionInputs ?? null
        : null;
    const mountedTargetReady = mountedTargetedContributions !== null
        && (pointlessTargetedContributions !== null || mountedTargetRead.phase === 'ready');
    // Publish each positive loading prerequisite used by the controller's
    // existing Machine gate. A failed read is an outage, not pending; Account
    // reads and surface activity remain independent of these Machine facts.
    const machinePrerequisitesPending = (needsMachineExecution && pluginExecution.loading)
        || (mountedTargetSnapshotRequired && !mountedTargetReady && mountedTargetRead.phase === 'loading')
        || (pointlessTargetedContributions !== null && mountedMachineProjection.phase === 'loading');
    const mountedTargetFallback = mountedTargetRead.phase === 'failed'
        ? resolveMountedTargetProjectionFallback(mountedTargetRead) : null;
    const daemonConnectionFailure = mountedTargetFallback?.state === 'unavailable'
        ? { code: mountedTargetRead.failure?.reason === 'timeout' ? 'timeout' as const : 'unavailable' as const,
            reasonCode: mountedTargetFallback.reasonCode }
        : undefined;
    // A fresh process whose machine has no reachable daemon can still mount the
    // destination it last confirmed, because the retained presentation slice it
    // booted from carries the target admission that accompanied it. This is the
    // same last-confirmed custody the projection itself was restored from —
    // read-only by construction, since `daemonReachable` being false is exactly
    // what withholds every daemon-owned method from this mount. The moment a
    // daemon answers, the live snapshot above supersedes it.
    const retainedOfflineTargetedContributions = React.useMemo(() => (
        !hasEmbeddedRendererMount
        && mountedTarget
        && !daemonInteraction.daemonReachable
        && machineId
        && accountLifetime?.isCurrent() === true
            ? readPluginUiProjectionTargetedAdmissionSnapshot({
                scope: accountLifetime.scope,
                targetKey: pluginUiProjectionAdmissionTargetKey({ serverId, machineId }),
                machineId,
                target: mountedTarget,
            })
            : null
    ), [
        accountLifetime,
        daemonInteraction.daemonReachable,
        hasEmbeddedRendererMount,
        machineId,
        mountedTarget,
        serverId,
    ]);
    const targetedContributions = targetedBinding
        ? targetedBinding.mount.contributorTargetedContributions
        : composerBinding
            ? composerBinding.catalogEntry.contributorTargetedContributions
            : ephemeralBinding
                ? ephemeralBinding.surface.contributorTargetedContributions
            : mountedTargetedContributions
                ?? retainedOfflineTargetedContributions
                ?? null;
    const preparedTargetedSurfaceMounts = !hasEmbeddedMount
        ? pointlessTargetedContributions
            ? EMPTY_PREPARED_TARGETED_SURFACE_MOUNTS
            : hasExactMountedTargetedSurfaceMounts(
                currentMountedTargetRead?.preparedTargetedSurfaceMounts ?? undefined,
                mountedTarget,
            )
                ? currentMountedTargetRead?.preparedTargetedSurfaceMounts ?? undefined
                : undefined
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
    const surfaceTargetResolution = React.useMemo(() => resolvePluginSurfaceTarget({
        targetKind: surfaceScope.declared ? surfaceScope.targetKind : null,
        sessionId: props.sessionId,
        agentId: props.agentId,
        project: projectContext?.target,
        browserTarget: declaredBrowserTarget,
    }), [
        declaredBrowserTarget?.kind,
        declaredBrowserTarget?.targetId,
        declaredBrowserTargetUrl,
        props.agentId,
        projectContext?.target,
        props.sessionId,
        surfaceScope,
    ]);
    const resolvedSurfaceTarget: PluginSurfaceTargetResolution = targetedMount
        ? Object.freeze({ resolved: true as const, target: targetedMount.physicalTarget })
        : composerMount
            ? Object.freeze({ resolved: true as const, target: composerMount.physicalTarget })
            : ephemeralMount
                ? Object.freeze({ resolved: true as const, target: ephemeralMount.physicalTarget })
        : surfaceTargetResolution;
    const surfaceTargetAuthorityKey = resolvedSurfaceTarget.resolved
        ? getPluginSurfaceTargetAuthorityKey(resolvedSurfaceTarget.target)
        : null;
    const surfaceLocale = getPreferredLanguage();
    const surfaceTranslationSources = mountedPresentationUiProjection?.translationsByPluginId ?? EMPTY_PLUGIN_UI_PROJECTION.translationsByPluginId;
    const surfaceTranslations = React.useMemo(() => Object.freeze({
        ...resolvePluginUiTranslationBundle({
            projection: { translationsByPluginId: surfaceTranslationSources },
            pluginId: mountedPluginId,
            locale: surfaceLocale,
            contributorPluginIds: targetedContributions?.points.flatMap((point) => (
                point.protocols.flatMap((protocol) => (
                    protocol.contributions.map((contribution) => contribution.contributor.pluginId)
                ))
            )),
        }),
        // Framework-owned chrome is projected after author strings so a plugin
        // cannot replace a fixed host action by declaring the same key.
        ...resolvePluginUiFrameworkTranslations(),
    }), [mountedPluginId, surfaceTranslationSources, surfaceLocale, targetedContributions]);
    const surfacePlatform = props.platform ?? 'web';
    const surfaceEnvironment = usePluginSurfaceEnvironment(surfacePlatform);
    const declarativePresentationEnvironment = React.useMemo(
        () => projectHappierUiEnvironment({
            ...surfaceEnvironment,
            translations: surfaceTranslations,
        }),
        [surfaceEnvironment, surfaceTranslations],
    );
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
    const surfaceChannel = props.channel ?? 'internal';
    const observedDeviceType = useDeviceType();
    // Runtime form-factor admission is reactive at this one physical mount: an
    // explicit host prop wins, otherwise the existing device-type hook re-admits
    // the binding when the physical form factor changes (rotation, split view,
    // window move). Adapters never subscribe; they consume the resolved fact.
    const runtimeFormFactor = props.formFactor ?? resolvePluginUiRuntimeFormFactor({
        deviceType: observedDeviceType,
    });
    // The Registry-normalized binding is the sole platform admission fact. A
    // conservative producer subset must not be widened back to the slot's
    // current default by this mount.
    const surfacePlatformSupported = selectedEmbeddedRenderer
        ? selectedEmbeddedRenderer.availability.state === 'available'
        : selectedSurfaceBinding
        ? isPluginUiSurfaceBindingAdmittedAtRuntimeV1({
            binding: selectedSurfaceBinding,
            platform: surfacePlatform,
            formFactor: runtimeFormFactor,
            hostPurpose: props.binding?.openableContent ? 'openableContentViewer' : undefined,
        })
        : false;
    // Resource admission is a fact of the exact selected surface member. Do not
    // let a renderer contribution or a sibling replica grant it. All ordinary
    // destinations and inline mounts consume their own selected producer fact.
    const resourceCapability = targetedBinding
        ? targetedBinding.mount.resourceCapability
        : composerBinding
            ? composerBinding.catalogEntry.resourceCapability
            : ephemeralBinding
                ? ephemeralBinding.surface.resourceCapability
        : selectedSurfaceBinding
        ? accountExecutionOrigin
            ? pluginExecution.selectedSupply?.resourceCapability
            : readSelectedPluginUiResourceCapability(descriptor)
        : undefined;
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
    // whether this exact current release admits Account Data; it leaks neither
    // Collection/declaration details nor mutation authority.
    const currentAccountDataCapability = availabilityReader?.readCurrentAccountDataCapability({
        pluginId: mountedPluginId,
    });
    const accountDataRendererEligible = currentAccountDataCapability?.kind === 'available';
    // One client belongs to this mounted plugin, its captured Account
    // lifetime and its current Account Data admission. It is only a thin
    // adapter over the Data owner: no UI cache, query planner, cursor, watcher,
    // or competing Account epoch lives here. An admission transition (a cold
    // start that mounted before Availability loaded, or a first claim) hands
    // the surface a new client, because that identity change is the one signal
    // a consumer that read on mount has to read again; an operation refused
    // before admission would otherwise stay refused until a manual retry.
    const mountedPluginUiDataClient = React.useMemo(
        () => {
            const reader = availabilityReaderRef.current;
            return accountLifetime && reader
                ? createPluginUiDataClient({
                    pluginId: mountedPluginId,
                    accountLifetime,
                    readAvailability: () => availabilityReaderRef.current ?? reader,
                })
                : null;
        },
        [accountLifetime, mountedPluginId, hasAvailabilityReader, accountDataRendererEligible],
    );
    // The hosted frame gets the same mounted, Account-lifetime-bound Data
    // client as the declarative and React Native consumers. Its framed
    // lifecycle owns request/cancel/currentness; Data remains the only owner
    // of queries, cursors, snapshots, and Account retirement.
    const createMountedHostedWebAccountDataBridge = React.useMemo(
        () => mountedPluginUiDataClient
            ? ({ publish }: Readonly<{ publish: Parameters<typeof createHostedWebAccountDataBridge>[0]['publish'] }>) => (
                createHostedWebAccountDataBridge({
                    dataClient: mountedPluginUiDataClient,
                    publish,
                })
            )
            : undefined,
        [mountedPluginUiDataClient],
    );
    // A renderer whose current release admits Account Data remains usable
    // through a daemon outage: Collection reads/CAS and Account KV keep their
    // own scoped currentness and transport authority. Client construction is
    // not itself admission; the current release must carry an exact Collection
    // contract or required storage.account declaration. The controller
    // separately owns the factual daemon-backed Action/Resource method set.
    const localControllerInteractionEnabled = accountLocalInteractionEnabled
        && (accountUnionMount || (projectionInteractionEnabled !== false && originInteractionCurrent));
    const rendererInteractionEnabled = localControllerInteractionEnabled
        && (
            accountUnionMount || accountDataRendererEligible
            || (daemonInteraction.hasAddressedMachine
                ? daemonInteraction.daemonReachable
                : daemonInteraction.endpointOnline)
        );
    const daemonOwnedInteractionEnabled = localControllerInteractionEnabled
        && projectionInteractionEnabled !== false && originInteractionCurrent
        && daemonInteraction.daemonReachable;
    // Projection admission controls controller-owned Actions/Resources, but a
    // declared daemon settings target remains readable while its transport is
    // reachable. Keep that factual transport gate separate so Settings does
    // not accidentally inherit an unrelated presentation/action decision.
    const daemonSettingsInteractionEnabled = accountLocalInteractionEnabled
        && originInteractionCurrent
        && daemonSettingsInteraction.daemonReachable;
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
            machineId,
            serverId,
            sessionId: props.sessionId,
            targetAuthorityKey: surfaceTargetAuthorityKey,
            platform: surfacePlatform,
            channel: surfaceChannel,
            pluginProjectionById: targetedMount?.pluginProjectionById ?? null,
            pluginUiProjection: mountedPluginUiProjection,
            accountLifetime,
            parentLifetime: targetedMount?.parentLifetime ?? null,
            interactionEnabled: localControllerInteractionEnabled && surfacePlatformSupported,
            daemonInteractionEnabled: daemonOwnedInteractionEnabled
                && surfacePlatformSupported
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
                occurrenceId: composerBinding.mount.occurrenceId,
                executionOrigin,
                resourceCapability,
                ...(composerResourceContext === undefined ? {} : { resourceContext: composerResourceContext }),
                pluginProjectionById: composerMount?.pluginProjectionById ?? null,
                pluginUiProjection: mountedPluginUiProjection,
                targetedContributions: composerBinding.catalogEntry.contributorTargetedContributions,
                accountLifetime,
                parentLifetime: composerMount?.parentLifetime ?? null,
                mountInstanceKey: composerBinding.mount.instanceKey,
                interactionEnabled: localControllerInteractionEnabled && surfacePlatformSupported,
                daemonInteractionEnabled: daemonOwnedInteractionEnabled
                    && surfacePlatformSupported
                    && composerMount?.daemonProjectionReady === true,
            })
        : ephemeralBinding
            ? Object.freeze({
                pluginId: ephemeralBinding.surface.contribution.pluginId,
                contributionId: ephemeralBinding.surface.contribution.localId,
                surfaceId: mountedSurfaceId,
                sessionId: props.sessionId,
                targetAuthorityKey: surfaceTargetAuthorityKey,
                placement: 'ephemeralSurface' as const,
                platform: surfacePlatform,
                channel: surfaceChannel,
                resourceScope: surfaceScope.declared ? surfaceScope.resourceScope : [],
                machineId,
                serverId,
                occurrenceId: ephemeralBinding.surface.occurrenceId,
                executionOrigin,
                resourceCapability,
                pluginProjectionById: ephemeralMount?.pluginProjectionById ?? null,
                pluginUiProjection: mountedPluginUiProjection,
                targetedContributions: ephemeralBinding.surface.contributorTargetedContributions,
                accountLifetime,
                parentLifetime: ephemeralMount?.parentLifetime ?? null,
                mountInstanceKey: mountedInstanceKey,
                interactionEnabled: localControllerInteractionEnabled && surfacePlatformSupported,
                daemonInteractionEnabled: daemonOwnedInteractionEnabled
                    && surfacePlatformSupported
                    && ephemeralMount?.daemonProjectionReady === true,
            })
        : Object.freeze({
            pluginId: mountedPluginId,
            contributionId: selectedSurfaceBinding?.kind === 'destination'
                ? selectedSurfaceBinding.destination.localId
                : selectedSurfaceBinding?.surface.localId ?? mountedContributionId,
            surfaceId: mountedSurfaceId,
            sessionId: props.sessionId,
            targetAuthorityKey: surfaceTargetAuthorityKey,
            placement: selectedSurfaceBinding?.surfaceContextPlacement ?? 'unknown',
            platform: surfacePlatform,
            channel: surfaceChannel,
            resourceScope: surfaceScope.declared ? surfaceScope.resourceScope : [],
            machineId,
            machineDisplayName,
            homeHasMachines,
            pluginDisplayName: installedPackagesById?.[mountedPluginId]?.displayName ?? null,
            serverId,
            occurrenceId: accountExecutionOrigin?.custodyId ?? mountedTarget?.occurrenceId ?? null,
            daemonOccurrenceId: accountUnionMount
                ? (needsMachineExecution ? pluginExecution.selectedSupply : presentationSupply)?.occurrenceId
                : undefined,
            ...(accountExecutionOrigin ? { accountExecutionOrigin } : {}),
            executionOrigin,
            resourceCapability,
            ...(ordinaryResourceContext ? { resourceContext: ordinaryResourceContext } : {}),
            pluginProjectionById: mountedMachineInputs?.pluginProjectionById ?? null,
            pluginUiProjection: mountedPresentationUiProjection,
            targetedContributions,
            accountLifetime,
            mountInstanceKey: mountedInstanceKey,
            isHostCurrent: props.isHostCurrent,
            interactionEnabled: localControllerInteractionEnabled && surfacePlatformSupported,
            daemonInteractionEnabled: daemonOwnedInteractionEnabled
                && surfacePlatformSupported
                && mountedTargetReady
                && (pointlessTargetedContributions === null || mountedMachineProjection.phase === 'ready'),
        });
    // Resolve Actions from the same scoped publication as the controller: exact
    // Machine sources plus independently admitted Account callees. A different
    // plugin's app-wide Run-on selection cannot replace this mount's source.
    const mountedProjectedActions = baseControllerFacts.pluginUiProjection?.actionsById;
    const resolveContributedAction = React.useMemo(
        () => createPluginUiProjectedActionResolver(mountedProjectedActions),
        [mountedProjectedActions],
    );
    const publishedActionSelection = targetedMount?.actionInputSelectionFactsKey
        ?? composerMount?.actionInputSelectionFactsKey
        ?? ephemeralMount?.actionInputSelectionFactsKey
        ?? currentMountedTargetRead?.actionInputSelectionFactsKey;
    const matchingSelectionTarget = baseControllerFacts.targetedContributions?.target.pluginId === baseControllerFacts.pluginId;
    const hasSelectionProjection = baseControllerFacts.pluginProjectionById !== undefined && baseControllerFacts.pluginProjectionById !== null;
    if (!publishedActionSelection && hasSelectionProjection && matchingSelectionTarget
        && baseControllerFacts.targetedContributions!.points.length > 0) {
        throw new Error('Mounted Action selection facts were not published by their source');
    }
    const actionInputSelectionFactsKey = publishedActionSelection ?? readPluginActionInputSelectionPresenceSnapshot({
        hasPluginProjection: hasSelectionProjection, hasTargetedContributions: matchingSelectionTarget,
    });
    const controllerFacts = Object.freeze({
        ...baseControllerFacts,
        resourceDeclarations: targetedMount?.request.mount.mount.resourceDeclarations
            ?? currentMountedTargetRead?.resourceDeclarationsByPluginId?.[baseControllerFacts.pluginId],
        actionInputSelectionFactsKey,
        targetSourceCustody: baseControllerFacts.targetedContributions?.target.sourceCustody ?? mountedTargetSourceCustody,
        executionOriginSelectionKind: needsMachineExecution ? pluginExecution.selection.state.kind : undefined,
        ...(executionSelectionState?.kind === 'unavailable' && executionSelectionState.candidates.length > 0
            ? { executionOriginRefusal: Object.freeze({
                reasons: executionSelectionState.reasons,
                ...(refusingMachineIds.length === 1 ? { machineDisplayName: machineDisplayNamesById[refusingMachineIds[0]!] ?? null } : {}),
            }) }
            : {}),
        isDaemonConnectionPending: () => machinePrerequisitesPending,
        daemonConnectionFailure: !needsMachineExecution || pluginExecution.selection.state.kind === 'selected'
            ? daemonConnectionFailure : undefined,
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
    const projectedMountedComposerAttachmentsById = targetedBinding
        ? targetedMount?.runtimeComposerAttachmentsById ?? EMPTY_PLUGIN_UI_PROJECTION.composerAttachmentsById
        : ephemeralBinding
            ? ephemeralMount?.pluginUiProjection.composerAttachmentsById ?? EMPTY_PLUGIN_UI_PROJECTION.composerAttachmentsById
        : mountedMachineInputs?.pluginUiProjection.composerAttachmentsById ?? EMPTY_PLUGIN_UI_PROJECTION.composerAttachmentsById;
    const mountedComposerAttachmentsById = Object.keys(projectedMountedComposerAttachmentsById).length > 0
        ? projectedMountedComposerAttachmentsById
        : EMPTY_PLUGIN_UI_PROJECTION.composerAttachmentsById;
    // The admitted mounted target already owns generic Composer identity.
    // Delivering an empty Machine projection adds no attachment authority and
    // must not replace its handlers or cancel unrelated Account reads.
    const mountedComposerOwnerPluginId = targetedBinding
        ? targetedBinding.mount.contributor.pluginId
        : !composerBinding && mountedTarget
            ? mountedPluginId
            : null;
    const mountedComposerOwnerContributionId = targetedBinding
        ? targetedBinding.mount.contributor.contributionId
        : !composerBinding && mountedTarget
            ? selectedSurfaceBinding?.kind === 'destination'
                ? selectedSurfaceBinding.destination.localId
                : selectedSurfaceBinding?.surface.localId ?? mountedContributionId
            : null;
    const mountedComposerOwnerOccurrenceId = targetedBinding
        ? targetedBinding.mount.contributor.occurrenceId
        : !composerBinding && mountedTarget
            ? mountedTarget.occurrenceId
            : null;
    const mountedComposerOwnerInstanceKey = targetedBinding
        ? targetedRequest?.instanceKey ?? null
        : !composerBinding && mountedTarget
            ? mountedInstanceKey ?? mountedSurfaceId
            : null;
    const mountedComposerOwner = React.useMemo<ComposerPresentationHostOwner | null>(() => {
        if (
            !mountedComposerOwnerPluginId
            || !mountedComposerOwnerContributionId
            || !mountedComposerOwnerOccurrenceId
            || !mountedComposerOwnerInstanceKey
        ) return null;
        return Object.freeze({
            identity: Object.freeze({
                pluginId: mountedComposerOwnerPluginId,
                localId: mountedComposerOwnerContributionId,
            }),
            occurrenceId: mountedComposerOwnerOccurrenceId,
            surfaceInstanceKey: mountedComposerOwnerInstanceKey,
        });
    }, [
        mountedComposerOwnerContributionId,
        mountedComposerOwnerOccurrenceId,
        mountedComposerOwnerInstanceKey,
        mountedComposerOwnerPluginId,
    ]);
    // Referentially stable on purpose: this resolver is part of the mounted
    // Composer applier, which is part of the mount's identity. A semantically
    // equivalent projection must not retire the mount, and the label is
    // resolved at admission time anyway, so read the current projection then.
    const mountedPluginUiProjectionRef = React.useRef(mountedPluginUiProjection);
    mountedPluginUiProjectionRef.current = mountedPluginUiProjection;
    const entityDragRuntime = useEntityDragDropRuntime();
    const entityDragMountKey = React.useId();
    const entityDragBindingRef = React.useRef<PluginEntityDragDropBinding | null>(null);
    const entityDragHostControllerRef = React.useRef<BoundPluginSurfaceController | null>(null);
    const entityDragEligibleRef = React.useRef(false);
    entityDragEligibleRef.current = accountLocalInteractionEnabled && presentationFocusEligible;
    const mountedComposerAttachmentLocalize = React.useCallback<PluginLocalizedTextResolver>(
        (pluginId, value) => resolvePluginLocalizedText({
            projection: mountedPluginUiProjectionRef.current,
            pluginId,
            value,
            locale: getPreferredLanguage(),
        }),
        [],
    );
    const mountedComposerAttachmentsRef = React.useRef(mountedComposerAttachmentsById);
    mountedComposerAttachmentsRef.current = mountedComposerAttachmentsById;
    const mountedComposerTransactionApplier = React.useMemo(() => (
        mountedComposerOwner
            ? createComposerPresentationTransactionApplier({
                get composerAttachmentsById() { return mountedComposerAttachmentsRef.current; },
                localize: mountedComposerAttachmentLocalize,
            })
            : null
    ), [
        mountedComposerAttachmentLocalize,
        mountedComposerOwner,
    ]);
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
        && (renderer.kind === 'reactNative' || renderer.kind === 'hostedWeb' || renderer.kind === 'hostedHtml');
    const createMountedComposerHostApiHandlers = React.useCallback((input: Readonly<{
        isCurrent: () => boolean;
    }>) => {
        if (!mountedComposerOwner || !mountedComposerTransactionApplier) {
            throw new Error('mounted_composer_handler_owner_unavailable');
        }
        const handlers = createComposerPresentationHostHandlers({
            scope: accountLifetime?.scope,
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
        accountLifetime,
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
        : ephemeralBinding
            ? ephemeralMount?.binding
        : mountedComposerBinding
            ?? (targetedBinding ? undefined : props.binding);
    const openConnectedAccounts = React.useCallback(async (request: PluginUiOpenConnectedAccountsRequestV1) => {
        return presentConnectSheet({
            scope: accountLifetime?.scope ?? null,
            ...(machineId && serverId ? { initialMachineTarget: {
                serverIdentityId: captureServerProfileScopeResolver()(serverId), machineId,
            } } : {}),
            ...('purpose' in request && request.purpose && accountLifetime ? {
                purpose: request.purpose,
                purposeSettlement: 'resourceDefault',
                purposeRequest: { scope: accountLifetime.scope, purpose: request.purpose, ...(machineId ? { machineId } : {}) },
            } : {}),
            ...(request.service ? { service: request.service,
                ...(request.accountId ? { account: { service: request.service, accountId: request.accountId } } : {}) } : {}),
        });
    }, [accountLifetime, machineId, serverId]);
    const controllerBindingWithConnectedAccounts = React.useMemo<BoundPluginSurfaceBinding>(() => Object.freeze({
        ...(controllerBinding ?? {}),
        openConnectedAccounts,
        ...(targetedMount?.isExecutionOriginCurrent
            ? { isExecutionOriginCurrent: targetedMount.isExecutionOriginCurrent }
            : needsMachineExecution ? { isExecutionOriginCurrent: pluginExecution.isExecutionOriginCurrent } : {}),
    }), [controllerBinding, needsMachineExecution, openConnectedAccounts, pluginExecution.isExecutionOriginCurrent, targetedMount?.isExecutionOriginCurrent]);
    const baseCreateMountedHostApiHandlers = controllerBindingWithConnectedAccounts.createMountedHostApiHandlers;
    const createMountedHostApiHandlers = React.useCallback<BoundPluginSurfaceMountedHostApiHandlersFactory>((input) => {
        const mountedBundle = baseCreateMountedHostApiHandlers?.(input);
        const entityBinding = accountLifetime ? createPluginEntityDragDropBinding({
            runtime: entityDragRuntime, pluginId: mountedPluginId, mountKey: entityDragMountKey,
            scope: accountLifetime.scope, isCurrent: () => input.isCurrent() && accountLifetime.isCurrent(),
            isInteractionEnabled: () => entityDragEligibleRef.current,
            subscribeRegistrations: listener => getInstalledPluginUiClientExecutableComposition().subscribe(listener),
            isSourceDeclared: localId => Boolean(mountedPluginUiProjectionRef.current?.dragSourcesById[`${mountedPluginId}/${localId}`]),
            isTargetDeclared: localId => Boolean(mountedPluginUiProjectionRef.current?.dropTargetsById[`${mountedPluginId}/${localId}`]),
            readSource: localId => {
                const source = mountedPluginUiProjectionRef.current?.dragSourcesById[`${mountedPluginId}/${localId}`];
                if (!source) return null;
                const resolved = resolvePluginUiClientDragSourceRegistration({ source, platform: resolvePluginUiClientExecutablePlatform() });
                return resolved ? { descriptor: source.definition, describe: resolved.runtime.describe,
                    fallbackDescription: { title: mountedComposerAttachmentLocalize(mountedPluginId, source.definition.title),
                        ...(source.definition.preview?.subtitle === undefined ? {} : { subtitle: mountedComposerAttachmentLocalize(mountedPluginId, source.definition.preview.subtitle) }) },
                    isCurrent: resolved.registration.lifecycle.isCurrent } : null;
            },
            readTarget: localId => {
                const target = mountedPluginUiProjectionRef.current?.dropTargetsById[`${mountedPluginId}/${localId}`];
                if (!target) return null;
                const resolved = resolvePluginUiClientDropTargetRegistration({ target, platform: resolvePluginUiClientExecutablePlatform() });
                return resolved ? { descriptor: target.definition, resolve: resolved.runtime.resolve,
                    isCurrent: resolved.registration.lifecycle.isCurrent } : null;
            },
            executeAction: async (action, actionInput) => {
                const mounted = entityDragHostControllerRef.current;
                if (!mounted || !input.isCurrent()) return { status: 'refused', reason: { code: 'plugin-drag-mount-retired', message: 'plugin-drag-mount-retired' } };
                return executeMountedPluginEntityDropAction(mounted, action, actionInput);
            },
        }) : null;
        entityDragBindingRef.current = entityBinding;
        const hostedEntity = entityBinding ? createHostedEntityDragDropHandlers({ binding: entityBinding,
            isCurrent: input.isCurrent, readSessionItem: () => controllerFacts.sessionId && accountLifetime?.isCurrent()
                ? { kind: 'session', scope: accountLifetime.scope, address: { serverId: accountLifetime.scope.serverId, sessionId: controllerFacts.sessionId } } : null }) : null;
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
        const suspendCurrentUiContext = (): void => mountPublication?.clear();
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
                clear: (): void => {
                    hasRetainedEnrichment = false;
                    retainedEnrichment = null;
                    suspendCurrentUiContext();
                },
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
        const setCurrentUiContextEligibility = mountedBundle?.setCurrentUiContextEligibility || currentUiContext || entityBinding
            ? (nextEligible: boolean): void => {
                mountedBundle?.setCurrentUiContextEligibility?.(nextEligible);
                eligible = nextEligible;
                entityBinding?.refresh();
                if (!activated) return;
                if (eligible) {
                    currentUiContext?.restore();
                } else {
                    suspendCurrentUiContext();
                }
            }
            : undefined;
        return Object.freeze({
            handlers: { ...mountedBundle?.handlers, ...hostedEntity?.handlers },
            ...(currentUiContext ? { currentUiContext } : {}),
            ...(activate ? { activate } : {}),
            ...(setCurrentUiContextEligibility ? { setCurrentUiContextEligibility } : {}),
            dispose: () => {
                hostedEntity?.dispose();
                entityBinding?.dispose();
                mountedBundle?.dispose?.();
                if (entityDragBindingRef.current === entityBinding) entityDragBindingRef.current = null;
            },
        });
    }, [accountLifetime, baseCreateMountedHostApiHandlers, controllerFacts.sessionId, currentUiContextMountPublisher, entityDragMountKey, entityDragRuntime, mountedPluginId]);
    const { approval: pluginActionApproval, pendingApproval, execute: defaultPluginActionExecute } = usePluginSurfaceActionApproval({
        accountLifetime,
        scopeKey: JSON.stringify([accountLifetime?.scope ?? null, mountedSurfaceId, surfaceTargetAuthorityKey, props.mountInstanceKey ?? null]),
        serverId,
        hasCustomExecutor: Boolean(controllerBindingWithConnectedAccounts.executeHostAction),
    });
    const effectiveControllerBinding = React.useMemo<BoundPluginSurfaceBinding | undefined>(() => {
        if (!baseCreateMountedHostApiHandlers && !currentUiContextMountPublisher && !accountLifetime) {
            return controllerBindingWithConnectedAccounts;
        }
        return Object.freeze({
            ...controllerBindingWithConnectedAccounts,
            ...(!controllerBindingWithConnectedAccounts?.executeHostAction && defaultPluginActionExecute ? {
                executeHostAction: defaultPluginActionExecute,
            } : {}),
            createMountedHostApiHandlers,
        });
    }, [
        baseCreateMountedHostApiHandlers,
        controllerBindingWithConnectedAccounts,
        createMountedHostApiHandlers,
        currentUiContextMountPublisher,
        accountLifetime,
        defaultPluginActionExecute,
    ]);
    const controller = useBoundPluginSurfaceController({
        facts: controllerFacts,
        ...(effectiveControllerBinding ? { binding: effectiveControllerBinding } : {}),
    });
    // Dispatch and public readmission consume one controller-owned admission
    // fact, including fresh execution-origin validation, not only its retained
    // presentation inputs. Unrelated loading cannot hold an admitted target.
    const machineExecutionReady = controller.canInteractWithDaemon();
    const machineConnectionPending = !machineExecutionReady && machinePrerequisitesPending;
    const requesterExecutionReady = controller.isRequesterAdmitted() && requesterProjectionOriginAdmitted;
    const [accountHosting, setAccountHosting] = React.useState<Readonly<{
        owner: BoundPluginSurfaceController;
        completion: Promise<PluginAccountHostedArtifactPublicationResult>;
    }> | null>(null);
    const reportAccountHosting = React.useCallback((completion: Promise<PluginAccountHostedArtifactPublicationResult>) => {
        if (controller.isCurrent()) setAccountHosting({ owner: controller, completion });
    }, [controller]);
    entityDragHostControllerRef.current = controller;
    const entityDragBinding = entityDragBindingRef.current;
    const entityDragPresentationHost = React.useMemo(() => createPluginUiPrivatePresentationHost(undefined, entityDragBinding ? {
        renderDragSource: dragInput => <PluginEntityDragSourceView binding={entityDragBinding} {...dragInput} />,
        renderDropTarget: dropInput => <PluginEntityDropTargetView binding={entityDragBinding} {...dropInput} />,
    } : undefined), [entityDragBinding]);
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
                        occurrenceId: contributor.occurrenceId,
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
            targetedBinding.mount.target.occurrenceId,
            targetedBinding.mount.contributor.pluginId,
            targetedBinding.mount.contributor.contributionId,
            targetedBinding.mount.contributor.occurrenceId,
            targetedBinding.mount.role,
            targetedBinding.mount.presentation,
            targetedBinding.mount.selectedRenderer.identity.pluginId,
            targetedBinding.mount.selectedRenderer.identity.localId,
            targetedBinding.mount.selectedRenderer.renderer.kind,
            targetedSurfaceLaunchInputResetKey,
        ])
        : undefined;
    const composerBoundaryResetKey = composerMount?.boundaryResetKey;
    const ephemeralBoundaryResetKey = ephemeralMount?.boundaryResetKey;
    // The three mount inputs are a discriminated union, so the fallback owner
    // is the ACTIVE arm rather than the first non-nullish value. An author's
    // explicit `null` means "render no fallback"; a value-level `??` merge
    // turned that into `undefined` and every downstream presence check then
    // rendered the generic unavailable presentation the author suppressed.
    const embeddedFallback = targetedRequest
        ? targetedRequest.fallback
        : composerMount
            ? composerMount.fallback
            : ephemeralMount?.fallback;
    const renderWithTargetedSurfaceBoundary = (child: React.ReactElement): React.ReactElement => {
        if (renderer.kind === 'declarative' && entityDragPresentationHost) {
            child = <PluginUiHostPresentationScope environment={declarativePresentationEnvironment} presentationHost={entityDragPresentationHost}>{child}</PluginUiHostPresentationScope>;
        }
        if (!targetedBinding && !composerBinding && !ephemeralBinding) return child;
        // The physical B mount owns this boundary so its bound controller can
        // publish through the incumbent currentness-aware diagnostic handler.
        // A's artifact boundary and durable RN crash state remain outside it.
        return (
            <PluginUiBoundary
                surfaceId={mountedSurfaceId}
                resetKey={targetedSurfaceBoundaryResetKey ?? composerBoundaryResetKey ?? ephemeralBoundaryResetKey}
                mountInstanceKey={mountedInstanceKey}
                {...(embeddedFallback !== undefined
                    ? { fallback: embeddedFallback }
                    : {})}
                {...(targetedBinding ? { onCrash: reportTargetedSurfaceRenderFailure } : {})}
            >
                {targetedBinding ? (
                    <TargetedPluginSurfaceReadyDiagnostic
                        mount={targetedBinding.mount}
                        mountLifetime={controller}
                    >
                        {child}
                    </TargetedPluginSurfaceReadyDiagnostic>
                ) : child}
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
    const accountEncryptionModeReadiness = usePluginSurfaceAccountEncryptionMode({
        accountLifetime,
        credentials: accountEncryptionModeCredentials,
        isCurrent: isAccountEncryptionModeCurrent,
    });
    const accountEncryptionMode = accountEncryptionModeReadiness.status === 'ready'
        ? accountEncryptionModeReadiness.mode
        : null;
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
        : selectedSurfaceBinding?.kind === 'destination'
            ? selectedSurfaceBinding.destination.pluginId
            : selectedSurfaceBinding?.surface.pluginId;
    const mountedBrandTarget = mountedBrandPluginId && resolveBrandTarget
        ? resolveBrandTarget(mountedBrandPluginId)
        : undefined;
    const projectedBrand = React.useMemo(
        () => mountedBrandTarget
            ? Object.freeze({
                displayName: mountedBrandTarget.displayName,
                ...(mountedBrandTarget.installedPackage.brand?.state === 'available'
                    ? {
                        resource: mountedBrandTarget.installedPackage.brand.resource,
                        monochrome: mountedBrandTarget.installedPackage.brand.monochrome,
                    }
                    : {}),
            })
            : undefined,
        [mountedBrandTarget],
    );
    // Native and declarative area controls share this host-only area facade.
    const renderDeclarativeWidgetArea = React.useMemo<DeclarativeWidgetAreaRender | undefined>(() => (controller.widgetArea
        ? createDeclarativeWidgetAreaRender({ dispatch: controller.widgetArea, surfaceName: projectedBrand?.displayName ?? mountedPluginId,
            machineConnectionPending, machineExecutionReady })
        : undefined), [controller.widgetArea, mountedPluginId, projectedBrand?.displayName, machineConnectionPending, machineExecutionReady]);
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
        surfaceScope.declared && surfaceScope.targetKind === 'project' ? projectContext?.policyContext : undefined,
        props.policyContext,
        {
            platform: surfacePlatform,
            channel: surfaceChannel,
        },
    ), [props.policyContext, projectContext?.policyContext, surfaceScope, surfaceChannel, surfacePlatform]);
    const renderMountedTargetedSurface = React.useCallback((request: TargetedPluginSurfaceMountRequest): React.ReactNode => {
        if (!resolvedSurfaceTarget.resolved) return null;
        return (
            <PluginSurfaceHost
                key={request.instanceKey}
                targetedMount={{
                    request,
                    physicalTarget: resolvedSurfaceTarget.target,
                    parentLifetime: controller,
                    pluginProjectionById: currentMountedTargetRead?.projectionInputs?.pluginProjectionById,
                    pluginProjectionV2: currentMountedTargetRead?.projectionInputs?.pluginProjectionV2,
                    pluginUiProjection: currentMountedTargetRead?.pluginUiProjection ?? null,
                    actionInputSelectionFactsKey: request.mount.mount.actionInputSelectionFactsKey!,
                    runtimeComposerAttachmentsById: currentMountedTargetRead?.projectionInputs?.pluginUiProjection.composerAttachmentsById,
                    daemonProjectionReady: machineExecutionReady,
                    ...(needsMachineExecution && request.mount.mount.accountExecutionOrigin
                        ? { isExecutionOriginCurrent: pluginExecution.isExecutionOriginCurrent } : {}),
                }}
                machineId={machineId}
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
        currentMountedTargetRead,
        localControllerInteractionEnabled,
        machineExecutionReady,
        machineId,
        mountedMachineInputs,
        mountedTargetReady,
        needsMachineExecution,
        pluginExecution.isExecutionOriginCurrent,
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
        if (hasEmbeddedMount || !preparedTargetedSurfaceMounts || !mountedTarget || !targetedContributions) return null;
        return (
            <TargetedPluginSurfaceHost
                node={node}
                fallback={fallback}
                mounts={preparedTargetedSurfaceMounts}
                target={targetedContributions.target}
                renderMountedSurface={renderMountedTargetedSurface}
            />
        );
    }, [hasEmbeddedMount, mountedTarget, preparedTargetedSurfaceMounts, renderMountedTargetedSurface, targetedContributions]);
    const renderReactTargetedSurface = React.useCallback((
        presentation: PluginUiPrivateTargetedSurfacePresentation,
    ): React.ReactNode => {
        if (hasEmbeddedMount || !preparedTargetedSurfaceMounts || !mountedTarget || !targetedContributions) {
            return presentation.fallback ?? null;
        }
        return (
            <TargetedPluginSurfaceHost
                presentation={presentation}
                mounts={preparedTargetedSurfaceMounts}
                target={targetedContributions.target}
                renderMountedSurface={renderMountedTargetedSurface}
            />
        );
    }, [hasEmbeddedMount, mountedTarget, preparedTargetedSurfaceMounts, renderMountedTargetedSurface, targetedContributions]);
    const inlineSlot = props.inlineMount
        ? resolvePluginUiInlineSurfaceSlotV1(
            props.inlineMount.role,
            props.inlineMount.presentation,
            selectedInlineBinding?.targetKind,
        )
        : null;
    const inlineMountBinding = mountBinding?.kind === 'inline' ? mountBinding : null;
    const inlinePresentation = inlineSlot?.presentation;
    // Public mount context projects the admitted binding, not each host render.
    const surfaceMount = React.useMemo(() => mountBinding?.kind === 'inline'
        ? inlinePresentation ? createPluginSurfaceInlineMountContext(mountBinding, inlinePresentation) : null
        : mountBinding?.kind === 'targetedSurface'
            ? createPluginSurfaceTargetedMountContext(mountBinding)
            : mountBinding?.kind === 'composer'
                ? createPluginSurfaceComposerMountContext(mountBinding)
                : mountBinding?.kind === 'ephemeral'
                    ? createPluginSurfaceEphemeralMountContext()
                    : mountBinding?.kind === 'destination'
                        ? createPluginSurfaceDestinationMountContext(mountBinding)
                        : null, [inlinePresentation, mountBinding]);
    const renderGate: PluginSurfaceRenderGateDecision = selectedEmbeddedRenderer
        ? selectedEmbeddedRenderer.availability.state === 'available'
            ? { canRender: true as const }
            : { canRender: false as const, reason: selectedEmbeddedRenderer.availability.reason }
        : resolvePluginSurfaceDescriptorRenderGate(
            descriptor!,
            policyContext,
        );
    const renderUnavailable = (
        reason: string,
        state: Extract<PluginSurfacePresentationState, 'loading' | 'unavailable'> = 'unavailable',
        onRetry?: () => void,
    ): React.ReactElement => (
        state !== 'loading' && embeddedFallback !== undefined
            ? <>{embeddedFallback}</>
            // A Composer region or control is inline, not a page: while it loads it reserves nothing
            // (a page-shaped skeleton would sit in the thread), keeping only the hidden QA marker.
            : state === 'loading' && composerMount
                ? <View testID={`plugin-surface-unavailable-diagnostic-${reason}`} accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants" style={INLINE_LOADING_MARKER_STYLE} />
                : renderPluginSurfaceUnavailable(reason, props.unavailableAction, state, onRetry, projectedBrand?.displayName)
    );
    const renderAccountEncryptionModeReadiness = (): React.ReactElement => (
        accountEncryptionModeReadiness.status === 'loading'
            ? renderUnavailable('account_encryption_mode_pending', 'loading')
            : renderUnavailable('account_encryption_mode_unavailable')
    );
    // Only a failed daemon answer can change on a re-ask; unsupported/idle/
    // invalid target answers keep no Retry because asking again cannot help.
    const renderMountedTargetProjectionFallback = (): React.ReactElement => {
        const fallback = resolveMountedTargetProjectionFallback(mountedTargetRead);
        return renderUnavailable(
            fallback.reasonCode,
            fallback.state,
            isRetryableMountedTargetFailure(mountedTargetRead) ? retryMountedTargetProjection : undefined,
        );
    };
    if (!renderGate.canRender) {
        if (renderGate.state === 'loading') {
            return <PluginSurfacePresentation lifetime={controller} notice={renderUnavailable(renderGate.reason, renderGate.state)} />;
        }
        return renderUnavailable(renderGate.reason, renderGate.state);
    }
    if (!mountBinding) {
        return renderUnavailable(props.inlineMount
            ? 'inline_surface_binding_unavailable'
            : 'destination_binding_unavailable');
    }
    if (!surfacePlatformSupported) {
        return renderUnavailable('destination_platform_unavailable');
    }
    const boundSurface = selectedSurfaceBinding;
    // §3.2 r0.9 — target exactness fails CLOSED. A declared session/project/
    // project/browser placement whose principal identity this mount cannot
    // supply is the host failing to BIND the target; it is not an app surface.
    // Nothing is admitted: no host API, no mount, no context. The plugin sees the
    // canonical unavailable diagnostic instead of a target it would have to trust.
    if (!resolvedSurfaceTarget.resolved) {
        return renderUnavailable(resolvedSurfaceTarget.reason);
    }
    // A resolved Account mode is required before building a new renderer
    // context. Revalidation keeps only the incumbent presentation within its
    // controller lifetime; it does not replace current Account/Action admission.
    if (accountLocalInteractionEnabled && !accountEncryptionMode) {
        return accountEncryptionModeReadiness.status === 'loading'
            ? <PluginSurfacePresentation lifetime={controller} notice={renderAccountEncryptionModeReadiness()} />
            : renderAccountEncryptionModeReadiness();
    }
    const surfaceTarget = resolvedSurfaceTarget.target;
    const resolvedHostApi = controller.hostApi;
    const structuralTransportHostMethods = resolveNegotiatedPluginSurfaceHostApiMethods({
        installedMethods: controller.admissionMethods,
        canPushToSurface: true,
    });
    if (inlineMountBinding && (
        !props.inlineMount
        || !inlineSlot
        || !selectedInlineBinding
        || selectedInlineBinding.role !== inlineSlot.role
        || selectedInlineBinding.targetKind !== inlineSlot.targetKind
        || selectedInlineBinding.surfaceContextPlacement !== inlineSlot.surfaceContextPlacement
    )) {
        return renderUnavailable('inline_surface_binding_unavailable');
    }
    if (props.inlineMount && !inlineMountBinding) {
        return renderUnavailable('inline_surface_binding_unavailable');
    }
    if (!surfaceMount) {
        return renderUnavailable('inline_surface_binding_unavailable');
    }
    // The generalized physical mount consumes B's exact facts. The embedded
    // arm deliberately has neither a destination nor A's launch identity.
    const mountLaunchInput = targetedBinding
        ? targetedRequest!.input
        : composerBinding
            ? composerBinding.mount.input
            : ephemeralBinding
                ? props.launchInput ?? null
            : ordinaryLaunchInput;
    const mountSubPath = hasEmbeddedRendererMount ? undefined : props.subPath;
    const mountInstanceKey = targetedBinding
        ? targetedRequest!.instanceKey
        : composerBinding
            ? composerBinding.mount.instanceKey
            : ephemeralBinding
                ? mountedInstanceKey
            : props.mountInstanceKey;
    const renderDeclarative = (): React.ReactNode => {
        if (renderer.kind !== 'declarative') return null;
        const admittedModel = admitDeclarativeStaticModel({
            model: renderer.model,
            expectedPluginId: mountedPluginId,
        });
        if (!admittedModel) {
            return renderUnavailable('declarative_model_unavailable');
        }
        const model = admittedModel.model;
        const renderStaticModel = () => (
            <DeclarativePluginSurface
                environment={declarativePresentationEnvironment}
                pluginId={mountedPluginId}
                model={model}
                machineId={machineId}
                serverId={serverId}
                daemonSettingsTarget={hasEmbeddedRendererMount ? undefined : props.daemonSettingsTarget}
                perActiveServerIdentityId={hasEmbeddedRendererMount ? undefined : props.perActiveServerIdentityId}
                isDaemonSettingsTargetCurrent={hasEmbeddedRendererMount ? undefined : props.isDaemonSettingsTargetCurrent}
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
                policyContext={hasEmbeddedRendererMount ? undefined : policyContext}
                openSurface={controller.openSurface}
                // UI-D02: availability is the FACTUAL installed set, exactly as
                // the document-source arms above already read it. An embedded
                // mount whose container supplied no destination binding installs
                // no handler and is therefore already unavailable here; adding
                // `hasEmbeddedMount` on top refused a Composer surface whose
                // scope DID bind the canonical navigation owner, so an enabled
                // control resolved after doing nothing.
                openSurfaceAvailable={controller.installedMethods.includes('openSurface')}
                accountLifetime={accountLifetime}
                dataClient={mountedPluginUiDataClient}
                renderTargetedSurface={hasEmbeddedMount ? undefined : renderTargetedSurface}
                {...(renderDeclarativeWidgetArea ? { renderWidgetArea: renderDeclarativeWidgetArea } : {})}
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
                    unavailableAction={props.unavailableAction}
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
                    daemonSettingsTarget={hasEmbeddedRendererMount ? undefined : props.daemonSettingsTarget}
                    perActiveServerIdentityId={hasEmbeddedRendererMount ? undefined : props.perActiveServerIdentityId}
                    isDaemonSettingsTargetCurrent={hasEmbeddedRendererMount ? undefined : props.isDaemonSettingsTargetCurrent}
                    settingsScopesEnabled={declarativeSettingsScopesEnabled}
                    interactionEnabled={accountLocalInteractionEnabled}
                    focusEligible={presentationFocusEligible}
                    daemonInteractionEnabled={daemonOwnedInteractionEnabled}
                    controller={controller}
                    pluginUiProjection={mountedPluginUiProjection}
                    policyContext={hasEmbeddedRendererMount ? undefined : policyContext}
                    renderTargetedSurface={hasEmbeddedMount ? undefined : renderTargetedSurface}
                    reportUnsupportedNestedTargetedSurface={hasEmbeddedMount
                        ? reportUnsupportedNestedTargetedSurface
                        : undefined}
                    {...(renderDeclarativeWidgetArea ? { renderWidgetArea: renderDeclarativeWidgetArea } : {})}
                    embeddedPresentation={surfaceMount.kind === 'embedded' ? surfaceMount.presentation : undefined}
                    {...(composerBinding ? { composerRef: composerBinding.mount.composer } : {})}
                />
            );
        }
        return renderWithTargetedSurfaceBoundary(renderStaticModel());
    };

    const renderHostedWebPane = (
        contributionId: string,
        projectedContribution: Readonly<Record<string, unknown>> | null,
        inlineDocument?: PluginHostedHtmlSourceV1,
        inlineDocumentNetworkOrigins?: readonly string[],
        inlineDocumentNetwork?: 'none' | 'open',
    ) => {
        const contribution = resolveBundledPluginUiRendererArtifact(projectedContribution,
            accountLifetime ? readCurrentPluginUiRendererProjection(accountLifetime.scope) : null);
        if (!accountEncryptionMode) {
            return renderAccountEncryptionModeReadiness();
        }
        const explicitBrowserTarget = hasEmbeddedRendererMount
            ? null
            : readSurfaceBrowserTarget({
                resourceBrowserTarget: props.resourceBrowserTarget,
                descriptor: descriptor!,
            });
        // Generated V2 hosted web has an Artifact-owned byte source, not an
        // author/mount supplied URL or Session preview. Legacy projections keep
        // their established explicit-target/preview behavior below.
        const browserTarget = inlineDocument || contribution?.generatedV2 === true
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
        const requiredHostMethods = readRequiredPluginSurfaceHostMethods(
            inlineDocument ? renderer.requiredHostMethods : contribution?.requiredHostMethods,
        );
        const hostedWebInteractionEnabled = controller.interactive && rendererInteractionEnabled;
        const canonicalHostedSource = inlineDocument !== undefined || contribution?.generatedV2 === true;
        const hostedWebTechnicalAdmission = canonicalHostedSource
            ? resolvePluginUiRendererTechnicalAdmission<PluginHostedHtmlSourceV1 | PluginUiHostedWebArtifactTechnicalAdmission>({
                requiredHostMethods,
                structuralHostMethods: structuralTransportHostMethods,
                resolveSourceAdmission: () => inlineDocument ?? resolvePluginUiHostedWebArtifactTechnicalAdmission({
                    contribution,
                    pluginId: mountedPluginId,
                    channel: surfaceChannel,
                }),
            })
            : null;
        // Hosted SDK clients negotiate the sole Host API version. A generated mount
        // therefore cannot lend the bridge a context until the exact daemon
        // target snapshot has arrived; an old cached target never qualifies.
        if (canonicalHostedSource && renderRequiresTargetSnapshot && !targetedContributions) {
            return renderMountedTargetProjectionFallback();
        }
        const canonicalHostApi = canonicalHostedSource
            && hostedWebTechnicalAdmission?.kind === 'available'
            && (!renderRequiresTargetSnapshot || targetedContributions !== null)
            ? {
                authorPlugin: {
                    id: mountedPluginId,
                    version: readOptionalString(contribution?.pluginVersion ?? descriptor?.pluginVersion)
                        ?? readOptionalString(installedPackagesById?.[mountedPluginId]?.version)
                        ?? '0.0.0',
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
                pendingApproval,
                machineConnectionPending,
                machineExecutionReady,
                requesterExecutionReady,
                // §3.2/§3.3: the hosted-web binding carries the SAME exact
                // target, semantic theme and translation bundle the React Native
                // mount receives, resolved by the one context owner.
                target: surfaceTarget,
                accountEncryptionMode,
                translations: surfaceTranslations,
                ...(targetedContributions ? { targetedContributions } : {}),
            }
            : undefined;
        if (canonicalHostedSource && hostedWebTechnicalAdmission?.kind !== 'available') {
            return renderUnavailable(hostedWebTechnicalAdmission?.kind === 'unavailable'
                ? hostedWebTechnicalAdmission.code
                : 'artifact_technical_admission_unavailable');
        }

        const hostedArtifactAdmission = hostedWebTechnicalAdmission?.kind === 'available'
            && 'artifactGraph' in hostedWebTechnicalAdmission.sourceAdmission
            ? hostedWebTechnicalAdmission.sourceAdmission
            : null;

        const paneProps: React.ComponentProps<typeof PluginHostedWebPane> = {
            contributionId,
            unavailableAction: props.unavailableAction,
            surfaceContext: controller.surfaceContext,
            ...(inlineDocument
                ? {
                    inlineDocument,
                    inlineDocumentNetworkOrigins,
                    inlineDocumentNetwork,
                    projectedContribution: null,
                    pluginUiProjection: mountedPluginUiProjection,
                }
                : hasEmbeddedRendererMount
                ? {
                    // An explicit selected artifact means unavailable when it
                    // is absent; embedded mounts never fall back to a broad
                    // projection lookup for their renderer contribution.
                    projectedContribution: contribution as PluginUiHostedWebProjection | null,
                    pluginUiProjection: mountedPluginUiProjection,
                }
                : { pluginUiProjection: props.pluginUiProjection }),
            endpointUrl: preview?.accessUrl ?? null,
            expiresAt: preview?.expiresAt ?? null,
            platform: props.platform,
            nowMs: props.nowMs,
            hostApi: resolvedHostApi,
            canonicalHostApi,
            ...(embeddedFallback === undefined ? {} : { targetedFallback: embeddedFallback }),
            ...(physicalComposerSubscriptionPublisherSetter
                ? { setComposerSubscriptionPublisher: physicalComposerSubscriptionPublisherSetter }
                : {}),
            interactionEnabled: hostedWebInteractionEnabled,
            focusEligible: presentationFocusEligible,
            mountInstanceKey,
            ...(props.onIntrinsicHeightChange
                ? { onIntrinsicHeightChange: props.onIntrinsicHeightChange }
                : {}),
            isCurrent: controller.isCurrent,
            mountLifetime: controller,
            accountLifetime,
            subscribeResourceInvalidations: controller.subscribeResourceInvalidations,
            policyContext,
            ...(createMountedHostedWebAccountDataBridge === undefined
                ? {}
                : { createAccountDataBridge: createMountedHostedWebAccountDataBridge }),
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
                    exactArtifactSource={exactArtifactSource}
                    artifactSources={readPluginUiArtifactDaemonSources(contribution)}
                    onAccountHosting={reportAccountHosting}
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

    const renderHostedHtml = (): React.ReactNode => {
        if (renderer.kind !== 'hostedHtml') return null;
        const source = PluginHostedHtmlSourceV1Schema.safeParse(renderer.source);
        if (!source.success) return renderUnavailable('hosted_html_source_invalid');
        // Installed plugins retain their full public ABI. This canonical
        // normalization supplies CSP egress only; the caller-authored Session
        // capability ceiling is deliberately not applied on this path.
        const capabilities = resolvePluginUiHostedHtmlCapabilityRequestV1(renderer);
        if (!capabilities) return renderUnavailable('hosted_html_source_invalid');
        const override = props.guestNetworkOverride === undefined ? null : UiSurfaceNetworkRequestV1Schema.safeParse(props.guestNetworkOverride);
        if (override && !override.success) return renderUnavailable('hosted_html_source_invalid');
        const requestedNetwork = override?.success ? normalizeUiSurfaceCapabilityRequestV1(override.data) : capabilities;
        if (!requestedNetwork) return renderUnavailable('hosted_html_source_invalid');
        const network = intersectUiSurfaceNetworkPoliciesV1(requestedNetwork, capabilities);
        return renderWithTargetedSurfaceBoundary(renderHostedWebPane(
            mountedContributionId,
            null,
            source.data,
            network.networkOrigins,
            network.network === 'origins' ? undefined : network.network,
        ));
    };

    const renderHostedWeb = (): React.ReactNode => {
        if (renderer.kind !== 'hostedWeb') return null;
        if (hasEmbeddedRendererMount) {
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
    };

    const renderReactNative = (): React.ReactNode => {
        if (renderer.kind !== 'reactNative') return null;
        if (!reactNativeFeatureEnabled) return renderUnavailable('feature_gate_disabled');
        if (!accountEncryptionMode) {
            return renderAccountEncryptionModeReadiness();
        }
        if (hasEmbeddedRendererMount && !mountedRendererArtifact) {
            return renderUnavailable(composerBinding
                ? 'composer_renderer_artifact_unavailable'
                : ephemeralBinding
                    ? 'ephemeral_renderer_artifact_unavailable'
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
        const projectedContribution = selectedEmbeddedRenderer
            ? mountedRendererArtifact
            : contributionId
                ? props.pluginUiProjection?.reactNativeBundlesById[contributionId] ?? null
                : null;
        const contribution = resolveBundledPluginUiRendererArtifact(projectedContribution,
            accountLifetime ? readCurrentPluginUiRendererProjection(accountLifetime.scope) : null);
        const runtime = readReactNativeRuntimeState(
            contribution ?? null,
            props.platform === 'ios' || props.platform === 'android' ? props.platform : 'web',
        );
        const cacheIdentity = runtime?.cacheIdentity ?? null;
        const resolvedRnContributionId = contribution?.contributionId
            ? String(contribution.contributionId)
            : contributionId ?? '';
        const artifactGraph = readPluginUiGeneratedArtifactGraph(contribution);
        const daemonProjectionSelection = readPluginUiDaemonProjectionSelection(contribution);
        const generatedV2 = contribution?.generatedV2 === true;
        // Daemon-offline continuity may retain a same-Account visual snapshot,
        // but Account retirement is a disclosure boundary. Do not hand the RN
        // renderer an inert state that would preserve Account-A component/data
        // state while no current Account lifetime exists.
        if (generatedV2 && !accountLocalInteractionEnabled) {
            return renderUnavailable('account_scope_unavailable');
        }
        const moduleReference = generatedV2
            ? readPluginUiGeneratedReactNativeModuleReference(artifactGraph)
            : undefined;
        const reactNativeRequiredHostMethods = readRequiredPluginSurfaceHostMethods(
            renderer.requiredHostMethods ?? contribution?.requiredHostMethods,
        );
        const reactNativeTechnicalAdmission = generatedV2
            ? resolvePluginUiRendererTechnicalAdmission({
                requiredHostMethods: reactNativeRequiredHostMethods,
                structuralHostMethods: structuralTransportHostMethods,
                resolveSourceAdmission: () => isPluginUiReactNativeArtifactTechnicallyAdmitted({
                    artifactGraph,
                    cacheIdentity,
                    moduleReference,
                })
                    ? true
                    : null,
            })
            : null;
        const generatedArtifactAdmissionSatisfied = !generatedV2
            || reactNativeTechnicalAdmission?.kind === 'available';
        // The same CommonJS evaluator is the only executable Artifact backend
        // on web, iOS, and Android. Tests may inject the same backend contract.
        const effectiveReactNativeLoaderBackend =
            props.reactNativeLoaderBackend ?? resolveDefaultReactNativeLoaderBackend();
        const installedArtifactLoad = runtime?.decision.state === 'load'
            && runtime.loadPolicy?.source === 'installedArtifact'
            && cacheIdentity
            && generatedArtifactAdmissionSatisfied
            && artifactGraph
            && availabilityReader
            && accountLifetime
            ? createPluginUiReactNativeInstalledArtifactLoad({
                identity: cacheIdentity,
                executionOrigin,
                daemons: readPluginUiArtifactDaemonSources(contribution),
                onAccountHosting: reportAccountHosting,
                artifactGraph,
                reader: availabilityReader,
                accountLifetime,
                ...(exactArtifactSource
                    ? {
                        daemon: exactArtifactSource,
                    }
                    : {}),
                ...(daemonProjectionSelection
                    ? {
                        daemonProjectionSelection: {
                            ...daemonProjectionSelection,
                            isCurrent: controller.isCurrent,
                        },
                    }
                    : {}),
                moduleReference,
                hostPlatform: props.platform ?? 'web',
                backend: effectiveReactNativeLoaderBackend,
                isCurrent: controller.isCurrent,
            })
            : undefined;
        const load = installedArtifactLoad;
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
        if (renderRequiresTargetSnapshot && !targetedContributions) {
            return renderMountedTargetProjectionFallback();
        }
        if (reactNativeTechnicalAdmission?.kind !== 'available') {
            return renderUnavailable(reactNativeTechnicalAdmission?.kind === 'unavailable'
                ? reactNativeTechnicalAdmission.code
                : 'artifact_technical_admission_unavailable');
        }
        const renderOccurrenceId = readOptionalString(baseControllerFacts.occurrenceId);
        const canonicalRenderIdentity = {
            pluginId: mountedPluginId,
            pluginVersion: readOptionalString(contribution?.pluginVersion) ?? '0.0.0',
            viewId: mountedContributionId,
            mount: surfaceMount,
            occurrenceId: renderOccurrenceId,
            artifactDigest: artifactGraph.digest,
            platform: props.platform ?? resolvedHostApi.platform,
            sessionId: props.sessionId,
            target: surfaceTarget,
            accountEncryptionMode,
            translations: surfaceTranslations,
            targetedContributions: targetedContributions ?? undefined,
            pendingApproval,
            machineConnectionPending,
            machineExecutionReady,
            requesterExecutionReady,
            executionOrigin,
            ...(projectedBrand ? { brand: projectedBrand } : {}),
            ...(brandTargetPresentation
                ? {
                    brandTargetPresentation,
                }
                : {}),
            accountLifetime,
        };
        const descriptorDisplayRecord = readRecord(
            hasEmbeddedRendererMount ? contribution?.display : descriptor!.display,
        );
        const descriptorDisplay = hasEmbeddedRendererMount ? null : readPluginSurfaceDisplay(descriptor!);
        const snapshotTitle = hasEmbeddedRendererMount
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
        return renderWithTargetedSurfaceBoundary(
            <PluginReactNativeSurfaceHost
                {...(renderDeclarativeWidgetArea ? { renderWidgetArea: renderDeclarativeWidgetArea } : {})}
                entityDragBinding={entityDragBinding}
                readLiveStreamViewing={controller.readLiveStreamViewing}
                liveStreamMachineId={machineId ?? null}
                liveStreamServerId={serverId ?? null}
                surfaceId={mountedSurfaceId}
                mountInstanceKey={mountInstanceKey}
                {...((composerBoundaryResetKey ?? ephemeralBoundaryResetKey) === undefined
                    ? {}
                    : { boundaryResetKey: composerBoundaryResetKey ?? ephemeralBoundaryResetKey })}
                snapshotTitle={snapshotTitle}
                requestSurface={requestSurface}
                decision={runtime?.decision ?? {
                    state: 'fallback',
                    reason: contributionId ? 'feature_disabled' : 'unknown',
                    diagnostics: contributionId ? ['react_native_loader_unavailable'] : ['react_native_contribution_unavailable'],
                    fallback: readFallbackRef(hasEmbeddedRendererMount ? contribution?.fallback : descriptor!.fallback),
                }}
                {...(runtime?.loadPolicy ? { loadPolicy: runtime.loadPolicy } : {})}
                {...(runtime?.cacheKey ? { cacheKey: runtime.cacheKey } : {})}
                load={load}
                unavailableAction={props.unavailableAction}
                hostApi={resolvedHostApi}
                {...(targetedBinding || composerBinding || ephemeralBinding ? {
                    ...(embeddedFallback !== undefined
                        ? { targetedFallback: embeddedFallback }
                        : {}),
                    // A Composer chip is one pressable: its own content, never a state card.
                    ...(composerBinding && embeddedFallback !== undefined
                        ? { stateFallback: embeddedFallback }
                        : {}),
                    ...(targetedBinding ? {
                    onTargetedSurfaceRenderFailure: reportTargetedSurfaceRenderFailure,
                    } : {}),
                } : {})}
                mountLifetime={controller}
                resourceStore={controller.resourceStore}
                interactionEnabled={reactNativeInteractionEnabled}
                focusEligible={presentationFocusEligible}
                {...(cacheIdentity && renderOccurrenceId ? {
                    loadedRuntimeIdentity: {
                        pluginId: cacheIdentity.pluginId,
                        occurrenceId: renderOccurrenceId,
                        artifactDigest: cacheIdentity.artifactDigest,
                        machineId: exactArtifactSource?.machineId ?? machineId ?? null,
                        serverId: exactArtifactSource?.serverId ?? serverId ?? null,
                    },
                } : {})}
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
                // The reason tracks the SAME fact that withheld the bridge above:
                // every embedded mount — targeted B and Composer alike — is already
                // one level deep. Keying it to `targetedBinding` left a Composer-
                // embedded RN mount with no bridge AND no reason, so its author's
                // `<TargetedSurface>` vanished with no diagnostic at all.
                targetedSurfaceUnavailableReason={hasEmbeddedMount ? 'unsupported_nested_targeted_surface' : undefined}
            />
        );
    };

    // The daemon registry remains the renderer-admission owner. This adapter
    // only narrows its deliberately opaque projection carrier before handing
    // the already-admitted arm to the shared physical renderer dispatcher.
    if (!isUiSurfaceRendererKind(renderer.kind)) return null;
    const rendererHost = (
        <UiSurfaceRendererHost
            kind={renderer.kind}
            renderers={{
                declarative: renderDeclarative,
                hostedHtml: renderHostedHtml,
                hostedWeb: renderHostedWeb,
                reactNative: renderReactNative,
            }}
        />
    );
    return (
        <PluginSurfacePresentation lifetime={controller}>
        <InputTypePickerHostProvider enabled={renderer.kind === 'reactNative'}
            machineId={machineId ?? undefined} serverId={serverId} sessionId={props.sessionId}
            pluginUiProjection={mountedPresentationUiProjection} pluginUiMachineId={machineId ?? null}
            accountLifetime={accountLifetime ?? undefined} isCurrent={controller.isCurrent}
            contextKey={surfaceTargetAuthorityKey ?? undefined}>
            {showsExecutionOriginSelector ? <View style={[surfaceHostStyles.executionOriginBand, insideWidgetFrame ? surfaceHostStyles.executionOriginBandInWidget : null]}>
            <PluginMachineExecutionOriginSelectorView selection={pluginExecution.selection}
                presentation="chip" groupTitle={t('settingsPlugins.executionOriginTitle')}
                testIDPrefix="plugin-surface-execution" />
        </View> : null}
        <PluginSurfaceSourceCauseContext.Provider value={needsMachineExecution
            ? resolvePluginSurfaceSourceCause(pluginExecution.selection.state) : null}>
            {/* Always mounted: an upload starting after first paint must not remount the surface. */}
            <PluginArtifactHostingStatusProvider isCurrent={controller.isCurrent}
                completion={accountHosting?.owner === controller ? accountHosting.completion : null}>
                {rendererHost}
            </PluginArtifactHostingStatusProvider>
        </PluginSurfaceSourceCauseContext.Provider>
        {controller.actionControls ? <MountedPluginActionControls controls={controller.actionControls} /> : null}
        {pluginActionApproval.approvalPending && pluginActionApproval.approvalId ? (
            <ActionApprovalPendingNotice testID="plugin-surface-approval-pending"
                message={t('approvals.status.open')} summary={pluginActionApproval.approvalSummary}
                onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(pluginActionApproval.approvalId!)}?serverId=${encodeURIComponent(accountLifetime?.scope.serverId ?? serverId ?? '')}`)} />
        ) : null}
        </InputTypePickerHostProvider>
        </PluginSurfacePresentation>
    );
}

export function PluginSurfacePlacementHost(props: Readonly<{
    placement: PluginUiPhysicalSurfacePlacementProjection;
    resourceBrowserTarget?: unknown;
    contextualExecutionTarget?: PluginExecutionOriginContextualTarget | null;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    agentId?: string | null;
    projectId?: string | null;
    projectContext?: ProjectWidgetAreaContextV1 | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    platform?: LocalServicePreviewPlatform;
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
    channel?: PluginUiChannelV1;
    nowMs?: () => number;
    binding?: BoundPluginSurfaceBinding;
    /** EU-5a: the launch input the opener passed for THIS selected placement. */
    launchInput?: PluginUiLaunchInputV1;
    guestNetworkOverride?: UiSurfaceNetworkRequestV1;
    /** Resolver-stamped ephemeral instance identity; absent for legacy singleton mounts. */
    mountInstanceKey?: PluginUiInstanceKeyV1;
    /** Validated current framed-renderer height; the outer placement owns sizing. */
    onIntrinsicHeightChange?: (height: number) => void;
    /** Recovery owned by the enclosing destination route. */
    unavailableAction?: SurfaceStateAction;
    /** EU-5b: the plugin-local location, for a full-page (`app.page`) mount. */
    subPath?: PluginUiSubPathV1;
    projectionInteractionEnabled?: boolean;
    isHostCurrent?: () => boolean;
    policyContext?: PluginUiPolicyEvaluationContext;
    reactNativeLoaderBackend?: PluginReactNativeLoaderBackend;
    inlineMount?: Readonly<{
        role: PluginUiInlineSurfaceRoleV1;
        presentation: 'content' | 'fill';
    }>;
}>): React.ReactElement | null {
    return (
        <PluginSurfaceHost
            descriptor={props.placement}
            renderer={props.placement.renderer}
            resourceBrowserTarget={props.resourceBrowserTarget}
            contextualExecutionTarget={props.contextualExecutionTarget}
            machineId={props.machineId}
            serverId={props.serverId}
            sessionId={props.sessionId}
            agentId={props.agentId}
            projectId={props.projectId}
            projectContext={props.projectContext}
            pluginUiProjection={props.pluginUiProjection}
            localServicePreviewState={props.localServicePreviewState}
            platform={props.platform}
            formFactor={props.formFactor}
            channel={props.channel}
            nowMs={props.nowMs}
            binding={props.binding}
            launchInput={props.launchInput}
            guestNetworkOverride={props.guestNetworkOverride}
            mountInstanceKey={props.mountInstanceKey}
            {...(props.onIntrinsicHeightChange
                ? { onIntrinsicHeightChange: props.onIntrinsicHeightChange }
                : {})}
            unavailableAction={props.unavailableAction}
            subPath={props.subPath}
            projectionInteractionEnabled={props.projectionInteractionEnabled}
            isHostCurrent={props.isHostCurrent}
            policyContext={props.policyContext}
            reactNativeLoaderBackend={props.reactNativeLoaderBackend}
            inlineMount={props.inlineMount}
        />
    );
}

export type PluginInlineSurfaceHostProps = Omit<
    React.ComponentProps<typeof PluginSurfacePlacementHost>,
    'inlineMount' | 'placement'
> & Readonly<{
    placement: PluginUiInlineSurfacePlacementProjection;
    // The admitted role/presentation pairs are Registry-derived in Protocol.
    // This host does not keep a second hand-maintained union of them.
    inlineMount: PluginUiInlineSurfaceMountV1;
}>;

/** Thin physical adapter over the one Surface Registry and PluginSurfaceHost. */
export function PluginInlineSurfaceHost(
    props: PluginInlineSurfaceHostProps,
): React.ReactElement | null {
    return <PluginSurfacePlacementHost {...props} />;
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
    /** Portable selected-server identity for Account perActiveServer bindings. */
    perActiveServerIdentityId?: string | null;
    isDaemonSettingsTargetCurrent?: (target: ScopedPluginSettingsDaemonTarget) => boolean;
    /** Settings-only availability is independent of this mount's action bridge. */
    settingsScopesEnabled?: Readonly<{ account: boolean; daemon: boolean }>;
    pluginUiProjection?: PluginUiProjectionModel | null;
    /** The page's plugin-local location; `''` at the page root. */
    subPath?: PluginUiSubPathV1;
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
            perActiveServerIdentityId={props.perActiveServerIdentityId}
            isDaemonSettingsTargetCurrent={props.isDaemonSettingsTargetCurrent}
            settingsScopesEnabled={props.settingsScopesEnabled}
            pluginUiProjection={props.pluginUiProjection}
            subPath={props.subPath}
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
