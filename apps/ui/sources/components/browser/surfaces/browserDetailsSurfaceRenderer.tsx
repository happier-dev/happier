import {
    type BrowserProfileV1,
    BrowserViewTargetV1Schema,
    type BrowserPlatformV1,
    type BrowserViewTargetV1,
    type FeatureDecision,
} from '@happier-dev/protocol';
import * as React from 'react';

import { resolveBrowserSurfacePlatform } from './useBrowserSurfaceHostProps';

import type {
    DetailsSurfaceRendererV1,
    DetailsSurfaceRenderInputV1,
} from '@/components/appShell/panes/details/surfaces';
import {
    createBrowserViewState,
    openBrowserTarget,
} from '@/sync/domains/browser/store';
import {
    resolveBrowserTargetOpenOptions,
    resolveBrowserViewTargetReplacementTab,
} from './openBrowserTargetInWorkspace';
import type { BrowserLaunchpadOpenTargetOptions } from '@/components/browser/launchpad/BrowserLaunchpad';
import type { BrowserLaunchpadRow } from '@/sync/domains/browser/targets';
import type { BrowserPreviewProxyDiagnosticsProjection } from '@/sync/domains/browser/diagnostics';
import type { BrowserControlState } from '@/sync/domains/browser/control';
import { useBrowserDaemonControlTransport } from '@/sync/domains/browser/control';
import type { DesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/desktopWebView';
import { useDesktopWebViewNativeAvailability } from '@/sync/domains/browser/adapters/useDesktopWebViewNativeAvailability';
import { resolveLocalBrowserProfile } from '@/sync/domains/browser/profiles/localBrowserProfile';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';

import {
    BrowserSurfaceHost,
    mergeBrowserSurfaceProductModels,
} from './BrowserSurfaceHost';
import type { BrowserSurfaceProductModels } from './BrowserSurfaceHost';
import {
    createBrowserSurfaceSessionId,
    readBrowserViewDetailsResource,
    readBrowserViewLaunchpadResource,
} from './browserSurfaceDetailsTabModel';

/**
 * The internal resource contract of the {@link BrowserDetailsSurface} HOST component. This is NOT a
 * workspace tab resource kind (the only workspace browser tab kind is `browser-view`); it is the
 * shape the renderer maps a `browser-view` tab resource onto, and which `SessionBrowserSurfaceTab`
 * passes directly when it embeds the host outside the details workspace.
 */
export type BrowserDetailsSurfaceResource = Readonly<{
    kind: 'browserSurface';
    mode?: unknown;
    target?: unknown;
    browserTarget?: unknown;
    browserSessionId?: unknown;
    viewId?: unknown;
    platform?: unknown;
    currentUrl?: unknown;
    currentUrlExpiresAt?: unknown;
}>;

type BrowserDetailsSurfaceViewTargetChange = Readonly<{
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
}>;

export type BrowserDetailsSurfaceRendererOptions = Readonly<{
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    // W2-A-1 / A3: the machine/server scope used to build the UI→daemon control transport so a
    // daemon-authoritative (chromiumSidecar/streamedBrowserSurface) view in this workspace tab
    // dispatches reload/stop/navigate through the daemon control broker.
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserActionSessionId?: string | null;
    platform?: BrowserPlatformV1;
    launchpadRows?: readonly BrowserLaunchpadRow[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    onOpenTarget?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    productModels?: BrowserSurfaceProductModels;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    supplementalDiagnostics?: BrowserPreviewProxyDiagnosticsProjection | null;
    browserRecording?: React.ComponentProps<typeof BrowserSurfaceHost>['browserRecording'];
    nowMs?: () => number;
}>;

function readBrowserTarget(value: unknown): BrowserViewTargetV1 | null {
    const parsed = BrowserViewTargetV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
        ? value.trim()
        : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function readBrowserPlatform(value: unknown): BrowserPlatformV1 | undefined {
    return value === 'web' || value === 'desktop' || value === 'ios' || value === 'android'
        ? value
        : undefined;
}

function createInitialBrowserState(params: Readonly<{
    browserSessionId: string;
    viewId?: string;
    target: BrowserViewTargetV1 | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    browserFeatureDecision?: FeatureDecision | null;
    browserProfile?: BrowserProfileV1 | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    platform: BrowserPlatformV1;
    currentUrl?: string;
    currentUrlExpiresAt?: number;
}>): BrowserControlState {
    const target = params.target;
    if (!target) {
        return createBrowserViewState();
    }
    // Share the open-options/seed resolver with the open-routing owner so the record this host
    // mounts is byte-for-byte the record the opener seeded for the same target identity.
    return openBrowserTarget(createBrowserViewState(), target, resolveBrowserTargetOpenOptions({
        browserSessionId: params.browserSessionId,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        target,
        localServicePreviewState: params.localServicePreviewState,
        browserFeatureDecision: params.browserFeatureDecision,
        browserProfile: params.browserProfile,
        desktopWebViewAvailability: params.desktopWebViewAvailability,
        allowExternalUrlBrowsing: params.allowExternalUrlBrowsing,
        platform: params.platform,
        currentUrl: params.currentUrl,
        currentUrlExpiresAt: params.currentUrlExpiresAt,
    }));
}

export function BrowserDetailsSurface(props: Readonly<{
    resource: BrowserDetailsSurfaceResource;
    presentationSlotId: string;
    active?: boolean;
    visible?: boolean;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServicePreviewServerId?: string | null;
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    pluginBrowserActionSessionId?: string | null;
    platform?: BrowserPlatformV1;
    launchpadRows?: readonly BrowserLaunchpadRow[];
    launchpadRefreshStatus?: 'idle' | 'refreshing' | 'error';
    launchpadRefreshError?: string | null;
    onOpenTarget?: (target: BrowserViewTargetV1, options?: BrowserLaunchpadOpenTargetOptions) => void;
    productModels?: BrowserSurfaceProductModels;
    browserFeatureDecision?: FeatureDecision | null;
    desktopWebViewAvailability?: DesktopWebViewNativeAvailability | null;
    allowExternalUrlBrowsing?: boolean;
    supplementalDiagnostics?: BrowserPreviewProxyDiagnosticsProjection | null;
    browserRecording?: React.ComponentProps<typeof BrowserSurfaceHost>['browserRecording'];
    onViewTargetChange?: (input: BrowserDetailsSurfaceViewTargetChange) => void;
    nowMs?: () => number;
    testID?: string;
}>): React.ReactElement | null {
    const target = readBrowserTarget(props.resource.target) ?? readBrowserTarget(props.resource.browserTarget);
    if (!target && props.resource.mode !== 'launchpad') {
        return null;
    }

    const platform = resolveBrowserSurfacePlatform(
        readBrowserPlatform(props.resource.platform) ?? props.platform,
    );
    const browserSessionId = readOptionalString(props.resource.browserSessionId)
        ?? createBrowserSurfaceSessionId(['slot', props.presentationSlotId]);
    const viewId = readOptionalString(props.resource.viewId);
    const currentUrl = readOptionalString(props.resource.currentUrl);
    const currentUrlExpiresAt = readOptionalNumber(props.resource.currentUrlExpiresAt);
    const targetIdentity = React.useMemo(
        () => (target ? JSON.stringify(target) : 'launchpad'),
        [target],
    );
    const runtimeBrowserFeatureDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const browserFeatureDecision = props.browserFeatureDecision ?? runtimeBrowserFeatureDecision;
    const desktopWebViewAvailability = useDesktopWebViewNativeAvailability({
        platform,
        availability: props.desktopWebViewAvailability,
    });
    const sendDaemonCommand = useBrowserDaemonControlTransport({
        machineId: props.machineId,
        serverId: props.serverId,
    });
    const mergedProductModels = React.useMemo(() => mergeBrowserSurfaceProductModels(props.productModels, {
        browserRecording: props.browserRecording,
        supplementalDiagnostics: props.supplementalDiagnostics,
    }), [props.browserRecording, props.productModels, props.supplementalDiagnostics]);
    // The in-app browser engines (desktop WebKit child view, web iframe, native WebView) are not
    // daemon-backed and so carry no daemon-issued profile; fall back to the host-local default so
    // the target policy never fails closed with `profile_missing` (which would leave an opened
    // external URL stuck on the launchpad empty-state). An explicitly supplied profile still wins.
    const browserProfile = resolveLocalBrowserProfile(mergedProductModels?.browserProfile?.profile ?? null);
    // Project the resolved profile back into the product model the host mounts so the seeded record
    // and the surface (profile status chip, ExternalUrlTarget profileId) agree on one identity.
    const productModels = React.useMemo<typeof mergedProductModels>(() => {
        if (mergedProductModels?.browserProfile?.profile === browserProfile) {
            return mergedProductModels;
        }
        return {
            ...(mergedProductModels ?? {}),
            browserProfile: {
                ...(mergedProductModels?.browserProfile ?? {}),
                profile: browserProfile,
            },
        };
    }, [browserProfile, mergedProductModels]);
    const selectionContextKey = [
        browserFeatureDecision?.state ?? 'unknown',
        browserFeatureDecision?.blockerCode ?? 'none',
        browserProfile?.profileId ?? 'no-profile',
        desktopWebViewAvailability?.available === true ? 'desktop-webview-available' : 'desktop-webview-unavailable',
        desktopWebViewAvailability?.disabledReasons.join(',') ?? 'no-native-reason',
        props.allowExternalUrlBrowsing === false ? 'external-disabled' : 'external-enabled',
    ].join(':');
    const initialBrowserState = React.useMemo(
        () => createInitialBrowserState({
            browserSessionId,
            ...(viewId ? { viewId } : {}),
            target,
            localServicePreviewState: props.localServicePreviewState,
            browserFeatureDecision,
            browserProfile,
            desktopWebViewAvailability,
            allowExternalUrlBrowsing: props.allowExternalUrlBrowsing,
            platform,
            currentUrl,
            currentUrlExpiresAt,
        }),
        [
            browserSessionId,
            currentUrl,
            currentUrlExpiresAt,
            browserFeatureDecision,
            browserProfile,
            desktopWebViewAvailability,
            platform,
            props.allowExternalUrlBrowsing,
            props.localServicePreviewState,
            target,
            viewId,
        ],
    );

    return (
        <BrowserSurfaceHost
            browserSessionId={browserSessionId}
            platform={platform}
            initialBrowserState={initialBrowserState}
            surfaceKey={`${browserSessionId}:${viewId ?? ''}:${targetIdentity}:${platform}:${currentUrl ?? ''}:${currentUrlExpiresAt ?? ''}:${selectionContextKey}`}
            presentationSlotId={props.presentationSlotId}
            keepAliveAboveRouter
            visible={props.visible ?? props.active ?? true}
            active={props.active ?? true}
            localServicePreviewState={props.localServicePreviewState}
            localServicePreviewServerId={props.localServicePreviewServerId}
            pluginUiProjection={props.pluginUiProjection}
            pluginUiInteractionEnabled={props.pluginUiInteractionEnabled}
            pluginBrowserProjection={props.pluginBrowserProjection}
            pluginBrowserActionContext={{
                machineId: props.machineId,
                serverId: props.serverId,
                sessionId: props.pluginBrowserActionSessionId,
            }}
            productModels={productModels}
            launchpadRows={props.launchpadRows}
            launchpadRefreshStatus={props.launchpadRefreshStatus}
            launchpadRefreshError={props.launchpadRefreshError}
            onOpenTarget={props.onOpenTarget}
            browserFeatureDecision={browserFeatureDecision}
            desktopWebViewAvailability={desktopWebViewAvailability}
            allowExternalUrlBrowsing={props.allowExternalUrlBrowsing}
            sendDaemonCommand={sendDaemonCommand}
            onViewTargetChange={props.onViewTargetChange}
            nowMs={props.nowMs}
            testID={props.testID ?? 'browser-details-surface'}
        />
    );
}

/**
 * Renderer for the canonical `browser-view` workspace tab kind (D2-revised). The browser is a
 * CONSUMER of the kind-agnostic details-workspace engine: each `browser-view` tab hosts exactly
 * one view's CONTENT for the tab `resource.viewId`. The workspace owns tab order/active/open/
 * close/split/keep-mounted (one tab system); this renderer mounts the single-view content via the
 * shared {@link BrowserDetailsSurface}, mapping the typed `browser-view` resource onto the
 * surface's `browserSurface` resource (target + browserSessionId) so the seeded record matches
 * the opener's identity.
 */
export function createBrowserViewDetailsSurfaceRenderer(
    options: BrowserDetailsSurfaceRendererOptions = {},
): DetailsSurfaceRendererV1 {
    return {
        id: 'browser-view-details-surface',
        owner: 'browser',
        order: 5,
        canRender: (input: DetailsSurfaceRenderInputV1) => (
            readBrowserViewDetailsResource(input.tab.resource) !== null
            || readBrowserViewLaunchpadResource(input.tab.resource) !== null
        ),
        render: (input: DetailsSurfaceRenderInputV1) => {
            const viewResource = readBrowserViewDetailsResource(input.tab.resource);
            const launchpadResource = viewResource
                ? null
                : readBrowserViewLaunchpadResource(input.tab.resource);
            if (!viewResource && !launchpadResource) return null;
            const productModels = mergeBrowserSurfaceProductModels(options.productModels, {
                browserRecording: options.browserRecording,
                supplementalDiagnostics: options.supplementalDiagnostics,
            });
            // Map the canonical `browser-view` tab resource onto the host component's internal
            // `browserSurface` resource shape. The launchpad carries no target (the new-tab page);
            // a single-view tab carries the target + identity the opener seeded.
            const surfaceResource: BrowserDetailsSurfaceResource = launchpadResource
                ? {
                    kind: 'browserSurface',
                    mode: 'launchpad',
                    browserSessionId: launchpadResource.browserSessionId,
                }
                : {
                    kind: 'browserSurface',
                    target: viewResource!.target,
                    browserSessionId: viewResource!.browserSessionId,
                    viewId: viewResource!.viewId,
                };
            const handleViewTargetChange = (viewResource || launchpadResource) && input.callbacks.replaceTab
                ? (change: BrowserDetailsSurfaceViewTargetChange) => {
                    input.callbacks.replaceTab?.(
                        input.tab.key,
                        resolveBrowserViewTargetReplacementTab({
                            target: change.target,
                            browserSessionId: change.browserSessionId,
                            viewId: change.viewId,
                        }),
                        {
                            intent: input.tab.isPinned
                                ? 'pinned'
                                : input.tab.isPreview
                                    ? 'preview'
                                    : 'default',
                        },
                    );
                }
                : undefined;
            return (
                <BrowserDetailsSurface
                    resource={surfaceResource}
                    presentationSlotId={input.descriptor.surfaceId}
                    active={input.active}
                    visible={input.active}
                    localServicePreviewState={options.localServicePreviewState}
                    localServicePreviewServerId={options.localServicePreviewServerId}
                    machineId={options.machineId}
                    serverId={options.serverId}
                    pluginUiProjection={options.pluginUiProjection}
                    pluginUiInteractionEnabled={options.pluginUiInteractionEnabled}
                    pluginBrowserProjection={options.pluginBrowserProjection}
                    pluginBrowserActionSessionId={options.pluginBrowserActionSessionId}
                    platform={options.platform}
                    productModels={productModels}
                    browserFeatureDecision={options.browserFeatureDecision}
                    desktopWebViewAvailability={options.desktopWebViewAvailability}
                    allowExternalUrlBrowsing={options.allowExternalUrlBrowsing}
                    launchpadRows={options.launchpadRows}
                    launchpadRefreshStatus={options.launchpadRefreshStatus}
                    launchpadRefreshError={options.launchpadRefreshError}
                    onOpenTarget={options.onOpenTarget}
                    onViewTargetChange={handleViewTargetChange}
                    nowMs={options.nowMs}
                    testID="browser-view-details-surface"
                />
            );
        },
    };
}
