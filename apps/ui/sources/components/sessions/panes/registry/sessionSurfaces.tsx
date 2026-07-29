import * as React from 'react';

import {
    BrowserViewTargetV1Schema,
    type BrowserViewTargetV1,
    type PeerMediationObservabilityScopeV1,
    SimulatorDeviceResourceV1Schema,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import {
    BrowserDetailsSurface,
    mergeBrowserSurfaceProductModels,
    resolveBrowserSurfacePlatform,
    resolveBrowserTargetSurfaceSessionId,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import { PluginSurfaceHost } from '@/components/plugins/surfaces';
import { resolvePluginUiOcticonName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { SessionSimulatorPreviewPane } from '@/components/sessions/simulator/SessionSimulatorPreviewPane';
import {
    selectBrowserPreviewProxyDiagnostics,
    type BrowserPreviewProxyDiagnosticsProjection,
} from '@/sync/domains/browser/diagnostics';
import { selectSimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/selectors';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    selectLocalServicePreviewByBrowserTarget,
    type LocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import type { PeerMediationObservabilityUiStore } from '@/sync/domains/machines/peer/mediation/observability';
import { canRenderPluginUiProjectionEntry } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel, PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { selectPluginSessionSurfacePlacementById } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

import { PluginSurfaceFallback } from '../PluginSurfaceFallback';

type PluginSessionSurfaceResource = Readonly<{
    kind: 'pluginSessionSurface';
    surfaceId: string;
    browserTarget?: unknown;
}>;

type SimulatorPreviewSessionSurfaceResource = Readonly<{
    kind: 'simulatorPreview';
    viewerId?: string;
    selectedSimulatorId?: string | null;
    resources?: unknown;
}>;

const EMPTY_SIMULATOR_PREVIEW_ACTIONS: Partial<SimulatorPreviewActions> = Object.freeze({});

function isPluginSessionSurfaceResource(value: unknown): value is PluginSessionSurfaceResource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const maybe = value as { kind?: unknown; surfaceId?: unknown };
    return maybe.kind === 'pluginSessionSurface'
        && typeof maybe.surfaceId === 'string'
        && maybe.surfaceId.trim().length > 0;
}

function isSimulatorPreviewSessionSurfaceResource(value: unknown): value is SimulatorPreviewSessionSurfaceResource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'simulatorPreview';
}

function readSimulatorDeviceResources(value: unknown): readonly SimulatorDeviceResourceV1[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry) => {
        const parsed = SimulatorDeviceResourceV1Schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readOptionalNullableString(value: unknown): string | null | undefined {
    return value === null ? null : readOptionalString(value);
}

function readHostRendererId(
    descriptor: PluginUiSurfacePlacementProjection,
): string | null {
    const renderer = descriptor.renderer;
    if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) {
        return null;
    }
    if ((renderer as { kind?: unknown }).kind !== 'host') {
        return null;
    }
    const rendererId = (renderer as { rendererId?: unknown }).rendererId;
    return typeof rendererId === 'string' && rendererId.trim().length > 0 ? rendererId : null;
}

function readRendererRef(descriptor: PluginUiSurfacePlacementProjection): Readonly<Record<string, unknown>> | null {
    const renderer = descriptor.renderer;
    return renderer && typeof renderer === 'object' && !Array.isArray(renderer)
        ? renderer as Readonly<Record<string, unknown>>
        : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readBrowserViewTarget(value: unknown): BrowserViewTargetV1 | null {
    const result = BrowserViewTargetV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function readSurfaceBrowserTarget(params: Readonly<{
    resource: PluginSessionSurfaceResource;
    descriptor: PluginUiSurfacePlacementProjection;
}>): BrowserViewTargetV1 | null {
    return readBrowserViewTarget(params.resource.browserTarget)
        ?? readBrowserViewTarget(params.descriptor.browserTarget);
}

function resolvePreviewDiagnostics(params: Readonly<{
    previewId: string;
    observabilityState?: PeerMediationObservabilityUiStore | null;
    observabilityScope?: PeerMediationObservabilityScopeV1 | null;
}>): BrowserPreviewProxyDiagnosticsProjection | null {
    if (!params.observabilityState || !params.observabilityScope) {
        return null;
    }

    return selectBrowserPreviewProxyDiagnostics(params.observabilityState, {
        scope: params.observabilityScope,
        previewId: params.previewId,
    });
}

function resolveSimulatorPreviewViewModel(params: Readonly<{
    resource: SimulatorPreviewSessionSurfaceResource;
    runtime?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): SimulatorPreviewViewModel {
    const resourceSelectedSimulatorId = readOptionalNullableString(params.resource.selectedSimulatorId);
    if (
        params.runtime?.viewModel
        && (
            resourceSelectedSimulatorId === undefined
            || params.runtime.viewModel.selectedSimulatorId === resourceSelectedSimulatorId
        )
    ) {
        return params.runtime.viewModel;
    }
    const resources = params.runtime?.resources
        ?? readSimulatorDeviceResources(params.resource.resources);
    return selectSimulatorPreviewViewModel({
        resources,
        selectedSimulatorId:
            params.runtime?.selectedSimulatorId
            ?? readOptionalNullableString(params.resource.selectedSimulatorId)
            ?? null,
        viewerId:
            params.runtime?.viewerId
            ?? readOptionalString(params.resource.viewerId)
            ?? 'session-simulator-viewer',
        previewStatesBySimulatorId: params.runtime?.previewStatesBySimulatorId,
        playerStatesBySimulatorId: params.runtime?.playerStatesBySimulatorId,
        snapshotDiagnostics: params.runtime?.diagnostics,
        nowMs: params.nowMs?.(),
    });
}

export function renderSimulatorSessionSurfaceTab(params: Readonly<{
    sessionId: string;
    tab: DetailsTabState;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): React.ReactNode | null {
    if (!isSimulatorPreviewSessionSurfaceResource(params.tab.resource)) {
        return null;
    }
    return (
        <SessionSimulatorPreviewPane
            sessionId={params.sessionId}
            viewModel={resolveSimulatorPreviewViewModel({
                resource: params.tab.resource,
                runtime: params.simulatorPreview,
                nowMs: params.nowMs,
            })}
            actions={params.simulatorPreview?.actions ?? EMPTY_SIMULATOR_PREVIEW_ACTIONS}
        />
    );
}

export function renderSessionSurfaceTab(params: Readonly<{
    sessionId: string;
    tab: DetailsTabState;
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    peerMediationObservabilityState?: PeerMediationObservabilityUiStore | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    platform?: LocalServicePreviewPlatform;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    productModels?: BrowserSurfaceProductModels;
    browserRecording?: React.ComponentProps<typeof BrowserDetailsSurface>['browserRecording'];
    nowMs?: () => number;
}>): React.ReactNode | null {
    return renderSimulatorSessionSurfaceTab({
        sessionId: params.sessionId,
        tab: params.tab,
        simulatorPreview: params.simulatorPreview,
        nowMs: params.nowMs,
    }) ?? renderPluginSessionSurfaceTab(params);
}

export function renderPluginSessionSurfaceTab(params: Readonly<{
    sessionId?: string | null;
    tab: DetailsTabState;
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    peerMediationObservabilityState?: PeerMediationObservabilityUiStore | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    platform?: LocalServicePreviewPlatform;
    productModels?: BrowserSurfaceProductModels;
    browserRecording?: React.ComponentProps<typeof BrowserDetailsSurface>['browserRecording'];
    nowMs?: () => number;
}>): React.ReactNode | null {
    if (!isPluginSessionSurfaceResource(params.tab.resource)) {
        return null;
    }

    const descriptor = params.pluginUiProjection
        ? selectPluginSessionSurfacePlacementById(params.pluginUiProjection, params.tab.resource.surfaceId)
        : null;
    if (descriptor && !canRenderPluginUiProjectionEntry(descriptor)) {
        return null;
    }
    const renderer = descriptor ? readRendererRef(descriptor) : null;
    if (
        descriptor
        && (
            renderer?.kind === 'hostedWeb'
            || renderer?.kind === 'reactNative'
        )
    ) {
        return (
            <PluginSurfaceHost
                descriptor={descriptor}
                renderer={renderer}
                resourceBrowserTarget={params.tab.resource.browserTarget}
                machineId={params.machineId}
                serverId={params.serverId}
                sessionId={params.sessionId}
                pluginUiProjection={params.pluginUiProjection}
                localServicePreviewState={params.localServicePreviewState}
                platform={params.platform}
                nowMs={params.nowMs}
            />
        );
    }

    const rendererId = descriptor ? readHostRendererId(descriptor) : null;
    if (rendererId) {
        if (rendererId === 'previewPlaceholder' && descriptor) {
            const browserTarget = readSurfaceBrowserTarget({
                resource: params.tab.resource,
                descriptor,
            });
            if (browserTarget?.kind === 'localServicePreview') {
                const preview = params.localServicePreviewState
                    ? selectLocalServicePreviewByBrowserTarget(params.localServicePreviewState, browserTarget)
                    : null;
                // Phase 7.2: route the session local-service-preview pane through the
                // canonical browser surface renderer (`BrowserDetailsSurface`) instead
                // of the transitional `SessionBrowserSurfaceTab` shim — one generic
                // browser-surface render path, no parallel wrapper.
                const previewDiagnostics = preview ? resolvePreviewDiagnostics({
                    previewId: preview.previewId,
                    observabilityState: params.peerMediationObservabilityState,
                    observabilityScope: params.peerMediationObservabilityScope,
                }) : null;
                const productModels = mergeBrowserSurfaceProductModels(params.productModels, {
                    supplementalDiagnostics: previewDiagnostics,
                    browserRecording: params.browserRecording,
                });
                return (
                    <BrowserDetailsSurface
                        resource={{
                            kind: 'browserSurface',
                            target: browserTarget,
                            browserSessionId: resolveBrowserTargetSurfaceSessionId('sessionPane', browserTarget),
                        }}
                        platform={resolveBrowserSurfacePlatform(params.platform, { fallback: 'web' })}
                        presentationSlotId={`session:${browserTarget.targetId}:browser`}
                        active
                        visible
                        localServicePreviewState={params.localServicePreviewState}
                        localServicePreviewServerId={params.serverId}
                        pluginUiProjection={params.pluginUiProjection}
                        productModels={productModels}
                        nowMs={params.nowMs}
                        testID="session-browser-pane"
                    />
                );
            }
        }

        return (
            <PluginSurfaceFallback
                testID={`plugin-session-surface-${rendererId}`}
            />
        );
    }

    return (
        <PluginSurfaceFallback
            testID="plugin-session-surface-unavailable"
        />
    );
}

export function resolvePluginSessionSurfaceTabIconName(params: Readonly<{
    tab: DetailsTabState;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): string | null {
    if (!isPluginSessionSurfaceResource(params.tab.resource)) {
        return null;
    }
    const descriptor = params.pluginUiProjection
        ? selectPluginSessionSurfacePlacementById(params.pluginUiProjection, params.tab.resource.surfaceId)
        : null;
    const iconToken = descriptor?.display && typeof descriptor.display === 'object'
        ? (descriptor.display as { iconToken?: unknown }).iconToken
        : null;
    return resolvePluginUiOcticonName(typeof iconToken === 'string' ? iconToken : null);
}

export function resolveSessionSurfaceTabIconName(params: Readonly<{
    tab: DetailsTabState;
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): string | null {
    if (isSimulatorPreviewSessionSurfaceResource(params.tab.resource)) {
        return 'device-mobile';
    }
    return resolvePluginSessionSurfaceTabIconName(params);
}
