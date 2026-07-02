import * as React from 'react';

import { BrowserViewTargetV1Schema, type BrowserViewTargetV1 } from '@happier-dev/protocol';

import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { PluginHostedWebPane } from '@/components/plugins/hostedWeb/PluginHostedWebPane';
import { PluginReactNativeSurface } from '@/components/plugins/reactNative/PluginReactNativeSurface';
import { SessionLocalServicePreviewPane } from '@/components/sessions/localServices/SessionLocalServicePreviewPane';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    selectLocalServicePreviewByBrowserTarget,
    type LocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import { canRenderPluginUiProjectionEntry } from '@/sync/domains/plugins/ui/policy';
import type { PluginUiProjectionModel, PluginUiSessionSurfaceProjection } from '@/sync/domains/plugins/ui/projection';

import { PluginSurfaceFallback } from '../PluginSurfaceFallback';

type PluginSessionSurfaceResource = Readonly<{
    kind: 'pluginSessionSurface';
    surfaceId: string;
    browserTarget?: unknown;
}>;

function isPluginSessionSurfaceResource(value: unknown): value is PluginSessionSurfaceResource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const maybe = value as { kind?: unknown; surfaceId?: unknown };
    return maybe.kind === 'pluginSessionSurface'
        && typeof maybe.surfaceId === 'string'
        && maybe.surfaceId.trim().length > 0;
}

function readHostRendererId(
    descriptor: PluginUiSessionSurfaceProjection,
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

function readRendererRef(descriptor: PluginUiSessionSurfaceProjection): Readonly<Record<string, unknown>> | null {
    const renderer = descriptor.renderer;
    return renderer && typeof renderer === 'object' && !Array.isArray(renderer)
        ? renderer as Readonly<Record<string, unknown>>
        : null;
}

function readFallbackRef(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : undefined;
}

function readBrowserViewTarget(value: unknown): BrowserViewTargetV1 | null {
    const result = BrowserViewTargetV1Schema.safeParse(value);
    return result.success ? result.data : null;
}

function readSurfaceBrowserTarget(params: Readonly<{
    resource: PluginSessionSurfaceResource;
    descriptor: PluginUiSessionSurfaceProjection;
}>): BrowserViewTargetV1 | null {
    return readBrowserViewTarget(params.resource.browserTarget)
        ?? readBrowserViewTarget(params.descriptor.browserTarget);
}

function resolveProjectedContributionId(params: Readonly<{
    kind: 'hostedWeb' | 'reactNativeBundle';
    pluginId: string;
    contributionId: unknown;
    entriesById: Readonly<Record<string, unknown>>;
}>): string | null {
    if (typeof params.contributionId !== 'string' || params.contributionId.trim().length === 0) {
        return null;
    }

    const contributionId = params.contributionId.trim();
    if (contributionId in params.entriesById) {
        return contributionId;
    }

    const qualifiedId = `${params.kind}:${params.pluginId}:${contributionId}`;
    return qualifiedId in params.entriesById ? qualifiedId : null;
}

export function renderPluginSessionSurfaceTab(params: Readonly<{
    tab: DetailsTabState;
    pluginUiProjection?: PluginUiProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    platform?: LocalServicePreviewPlatform;
    nowMs?: () => number;
}>): React.ReactNode | null {
    if (!isPluginSessionSurfaceResource(params.tab.resource)) {
        return null;
    }

    const descriptor = params.pluginUiProjection?.sessionSurfacesById[params.tab.resource.surfaceId];
    if (descriptor && !canRenderPluginUiProjectionEntry(descriptor)) {
        return null;
    }
    const renderer = descriptor ? readRendererRef(descriptor) : null;
    if (descriptor && renderer?.kind === 'hostedWeb') {
        const contributionId = resolveProjectedContributionId({
            kind: 'hostedWeb',
            pluginId: descriptor.pluginId,
            contributionId: renderer.contributionId,
            entriesById: params.pluginUiProjection?.hostedWebById ?? {},
        });
        const browserTarget = readSurfaceBrowserTarget({
            resource: params.tab.resource,
            descriptor,
        });
        const preview = params.localServicePreviewState && browserTarget?.kind === 'localServicePreview'
            ? selectLocalServicePreviewByBrowserTarget(params.localServicePreviewState, browserTarget)
            : null;
        return (
            <PluginHostedWebPane
                contributionId={contributionId ?? ''}
                surfaceId={descriptor.id}
                pluginUiProjection={params.pluginUiProjection}
                endpointUrl={preview?.accessUrl ?? null}
                expiresAt={preview?.expiresAt ?? null}
                platform={params.platform}
                nowMs={params.nowMs}
            />
        );
    }
    if (descriptor && renderer?.kind === 'reactNativeBundle') {
        const contributionId = resolveProjectedContributionId({
            kind: 'reactNativeBundle',
            pluginId: descriptor.pluginId,
            contributionId: renderer.contributionId,
            entriesById: params.pluginUiProjection?.reactNativeBundlesById ?? {},
        });
        return (
            <PluginReactNativeSurface
                surfaceId={descriptor.id}
                decision={{
                    state: 'fallback',
                    reason: contributionId ? 'feature_disabled' : 'unknown',
                    diagnostics: contributionId ? ['react_native_loader_unavailable'] : ['react_native_contribution_unavailable'],
                    fallback: readFallbackRef(descriptor.fallback),
                }}
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
                return (
                    <SessionLocalServicePreviewPane
                        preview={preview}
                        platform={params.platform}
                        nowMs={params.nowMs}
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
    const descriptor = params.pluginUiProjection?.sessionSurfacesById[params.tab.resource.surfaceId];
    const iconToken = descriptor?.display && typeof descriptor.display === 'object'
        ? (descriptor.display as { iconToken?: unknown }).iconToken
        : null;
    return iconToken === 'browser' || iconToken === 'globe' || iconToken === 'preview'
        ? 'browser'
        : 'apps';
}
