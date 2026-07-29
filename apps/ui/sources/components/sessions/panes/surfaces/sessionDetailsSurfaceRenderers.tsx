import * as React from 'react';

import type {
    DetailsSurfaceRendererV1,
    DetailsSurfaceRenderInputV1,
} from '@/components/appShell/panes/details/surfaces';
import {
    BrowserDetailsSurface,
    createBrowserViewDetailsSurfaceRenderer,
    createOpenBrowserTargetInWorkspace,
    mergeBrowserSurfaceProductModels,
    resolveBrowserSurfacePlatform,
    type BrowserDetailsSurfaceRendererOptions,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { SessionFileDeepLinkAnchor } from '@/components/sessions/files/views/SessionFileDetailsView';
import { resolvePluginUiOcticonName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { SessionExecutionRunLauncherView } from '@/components/sessions/runs/launcher/SessionExecutionRunLauncherView';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import {
    renderProviderSessionDetailsTab,
} from '@/agents/registry/sessionSubagentUiBehavior';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { selectPluginSessionSurfacePlacementById } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import type { PeerMediationObservabilityUiStore } from '@/sync/domains/machines/peer/mediation/observability';
import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import {
    SessionCommitDetailsViewForPanel,
    SessionFileDetailsViewForPanel,
    SessionScmReviewDetailsViewForPanel,
    SessionScmStashDetailsViewForPanel,
    SessionSubagentDetailsViewForPanel,
} from '../SessionDetailsPanelDetailViews';
import { renderSessionSurfaceTab } from '../registry/sessionSurfaces';

type SessionDetailsOpenFile = (path: string, intent?: 'default' | 'pinned') => void;

type SessionDetailsSurfaceRendererOptions = Readonly<{
    sessionId: string;
    scopeId: string;
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    peerMediationObservabilityState?: PeerMediationObservabilityUiStore | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    platform?: LocalServicePreviewPlatform;
    productModels?: BrowserSurfaceProductModels;
    browserRecording?: React.ComponentProps<typeof BrowserDetailsSurface>['browserRecording'];
    launchpadRows?: BrowserDetailsSurfaceRendererOptions['launchpadRows'];
    launchpadRefreshStatus?: BrowserDetailsSurfaceRendererOptions['launchpadRefreshStatus'];
    launchpadRefreshError?: BrowserDetailsSurfaceRendererOptions['launchpadRefreshError'];
    nowMs?: () => number;
    requestClose: () => void;
    openFileTab: SessionDetailsOpenFile;
    getStartEditingFileHandler: (tabKey: string, isPreview: boolean) => () => void;
    sessionScreenTestIdsEnabled: boolean;
    closeDetailsTab: (tabKey: string) => void;
    openDetailsTab?: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
}>;

function readResourceKind(input: DetailsSurfaceRenderInputV1): string | null {
    const resource = input.tab.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        return null;
    }
    const kind = (resource as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : null;
}

function isFileResource(value: unknown): value is Readonly<{ kind: 'file'; path: string; deepLinkAnchor?: unknown }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; path?: unknown };
    return maybe.kind === 'file' && typeof maybe.path === 'string';
}

function isCommitResource(value: unknown): value is Readonly<{ kind: 'commit'; sha?: string; commitHash?: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; sha?: unknown; commitHash?: unknown };
    const sha = typeof maybe.sha === 'string' ? maybe.sha : typeof maybe.commitHash === 'string' ? maybe.commitHash : null;
    return maybe.kind === 'commit' && typeof sha === 'string';
}

function isSubagentResource(value: unknown): value is Readonly<{ kind: 'subagent'; subagentId: string }> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; subagentId?: unknown };
    return maybe.kind === 'subagent' && typeof maybe.subagentId === 'string' && maybe.subagentId.trim().length > 0;
}

function isExecutionRunLauncherResource(value: unknown): value is Readonly<{
    kind: 'executionRunLauncher';
    intent?: 'review' | 'plan' | 'delegate';
}> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as { kind?: unknown; intent?: unknown };
    if (maybe.kind !== 'executionRunLauncher') return false;
    return maybe.intent == null || maybe.intent === 'review' || maybe.intent === 'plan' || maybe.intent === 'delegate';
}

function isPluginSessionSurfaceResource(value: unknown): value is Readonly<{
    kind: 'pluginSessionSurface';
    surfaceId: string;
}> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const maybe = value as { kind?: unknown; surfaceId?: unknown };
    return maybe.kind === 'pluginSessionSurface'
        && typeof maybe.surfaceId === 'string'
        && maybe.surfaceId.trim().length > 0;
}

function isSimulatorPreviewResource(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (value as { kind?: unknown }).kind === 'simulatorPreview';
}

function readDeepLinkAnchor(resource: unknown): SessionFileDeepLinkAnchor | null {
    if (resource == null || typeof resource !== 'object') return null;
    if (!('deepLinkAnchor' in resource)) return null;
    const value = (resource as { deepLinkAnchor?: unknown }).deepLinkAnchor;
    if (value == null || typeof value !== 'object') return null;
    if (!('source' in value) || !('anchor' in value)) return null;
    return value as SessionFileDeepLinkAnchor;
}

export function createSessionDetailsSurfaceRenderers(
    options: SessionDetailsSurfaceRendererOptions,
): readonly DetailsSurfaceRendererV1[] {
    const productModels = mergeBrowserSurfaceProductModels(options.productModels, {
        browserRecording: options.browserRecording,
    });

    // Canonical "open target → details tab + live content record" owner. Every launchpad row /
    // URL-box open from this session's browser surface routes here, producing a NEW workspace tab
    // (not an in-place host swap) plus the seeded content record under one identity. Wired only
    // when the pane supplies a details-tab sink (it always does in product).
    const openDetailsTab = options.openDetailsTab;
    const openBrowserViewTarget = openDetailsTab
        ? createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: 'sessionDetails',
            // OWNER-PLATFORM: resolve through the one Tauri-aware resolver (never a `?? 'web'`
            // fallback, which silently misclassified desktop — DV-PLATFORM-CLOSURE).
            platform: resolveBrowserSurfacePlatform(options.platform),
            localServicePreviewState: options.localServicePreviewState,
        })
        : undefined;

    return [
        {
            id: 'session-surface-registry',
            owner: 'session',
            order: 0,
            canRender: (input) => {
                const kind = readResourceKind(input);
                return kind === 'pluginSessionSurface' || kind === 'simulatorPreview';
            },
            render: (input) => renderSessionSurfaceTab({
                sessionId: options.sessionId,
                tab: input.tab,
                machineId: options.machineId,
                serverId: options.serverId,
                pluginUiProjection: options.pluginUiProjection,
                localServicePreviewState: options.localServicePreviewState,
                peerMediationObservabilityState: options.peerMediationObservabilityState,
                peerMediationObservabilityScope: options.peerMediationObservabilityScope,
                simulatorPreview: options.simulatorPreview,
                platform: options.platform,
                productModels,
                browserRecording: options.browserRecording,
                nowMs: options.nowMs,
            }),
        },
        createBrowserViewDetailsSurfaceRenderer({
            localServicePreviewState: options.localServicePreviewState,
            localServicePreviewServerId: options.serverId,
            // W2-A-1 / A3: scope for the UI→daemon browser control transport so a daemon-authoritative
            // view in this workspace tab dispatches reload/stop/navigate through the daemon broker.
            machineId: options.machineId,
            serverId: options.serverId,
            pluginUiProjection: options.pluginUiProjection,
            pluginUiInteractionEnabled: options.pluginUiInteractionEnabled,
            pluginBrowserProjection: options.pluginBrowserProjection,
            pluginBrowserActionSessionId: options.sessionId,
            // OWNER-PLATFORM: the browser renderer resolves Tauri-aware; never the leaked
            // local-preview platform (B-RC1 / DV-PLATFORM-CLOSURE).
            platform: resolveBrowserSurfacePlatform(options.platform),
            productModels,
            launchpadRows: options.launchpadRows,
            launchpadRefreshStatus: options.launchpadRefreshStatus,
            launchpadRefreshError: options.launchpadRefreshError,
            onOpenTarget: openBrowserViewTarget,
            nowMs: options.nowMs,
        }),
        {
            id: 'session-file',
            owner: 'session',
            order: 10,
            canRender: (input) => readResourceKind(input) === 'file' && isFileResource(input.tab.resource),
            render: (input) => {
                if (!isFileResource(input.tab.resource)) return null;
                return (
                    <SessionFileDetailsViewForPanel
                        sessionId={options.sessionId}
                        filePath={input.tab.resource.path}
                        deepLinkAnchor={readDeepLinkAnchor(input.tab.resource)}
                        presentation="panel"
                        scopeId={options.scopeId}
                        onStartEditingFile={options.getStartEditingFileHandler(input.tab.key, input.tab.isPreview)}
                    />
                );
            },
        },
        {
            id: 'session-commit',
            owner: 'scm',
            order: 20,
            canRender: (input) => readResourceKind(input) === 'commit' && isCommitResource(input.tab.resource),
            render: (input) => {
                if (!isCommitResource(input.tab.resource)) return null;
                const sha = input.tab.resource.sha ?? input.tab.resource.commitHash ?? '';
                return (
                    <SessionCommitDetailsViewForPanel
                        sessionId={options.sessionId}
                        sha={String(sha)}
                        onBack={options.requestClose}
                        presentation="panel"
                        onOpenFile={(path) => options.openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => options.openFileTab(path, 'pinned')}
                    />
                );
            },
        },
        {
            id: 'session-scm-review',
            owner: 'scm',
            order: 30,
            canRender: (input) => readResourceKind(input) === 'scmReview',
            render: () => (
                <SessionScmReviewDetailsViewForPanel
                    sessionId={options.sessionId}
                    scopeId={options.scopeId}
                />
            ),
        },
        {
            id: 'session-scm-stash',
            owner: 'scm',
            order: 40,
            canRender: (input) => readResourceKind(input) === 'scmStash',
            render: () => (
                <SessionScmStashDetailsViewForPanel
                    sessionId={options.sessionId}
                    scopeId={options.scopeId}
                    onOpenFile={(path) => options.openFileTab(path, 'default')}
                    onOpenFilePinned={(path) => options.openFileTab(path, 'pinned')}
                />
            ),
        },
        {
            id: 'session-terminal',
            owner: 'terminal',
            order: 50,
            canRender: (input) => readResourceKind(input) === 'terminal',
            render: (input) => {
                const fallbackTerminalInstanceId =
                    typeof input.tab.key === 'string' && input.tab.key.startsWith('terminal:')
                        ? input.tab.key.slice('terminal:'.length)
                        : SESSION_PRIMARY_TERMINAL_INSTANCE_ID;
                const terminalInstanceId = readTerminalDetailsInstanceId(input.tab.resource, fallbackTerminalInstanceId);
                if (!terminalInstanceId) return null;
                return (
                    <SessionEmbeddedTerminalPane
                        sessionId={options.sessionId}
                        scopeId={options.scopeId}
                        currentDockLocation="details"
                        terminalInstanceId={terminalInstanceId}
                        testIdPrefix={options.sessionScreenTestIdsEnabled ? 'session-details-terminal' : null}
                    />
                );
            },
        },
        {
            id: 'session-subagent',
            owner: 'session',
            order: 60,
            canRender: (input) => readResourceKind(input) === 'subagent' && isSubagentResource(input.tab.resource),
            render: (input) => {
                if (!isSubagentResource(input.tab.resource)) return null;
                return (
                    <SessionSubagentDetailsViewForPanel
                        sessionId={options.sessionId}
                        scopeId={options.scopeId}
                        subagentId={input.tab.resource.subagentId}
                    />
                );
            },
        },
        {
            id: 'session-execution-run-launcher',
            owner: 'session',
            order: 70,
            canRender: (input) => readResourceKind(input) === 'executionRunLauncher' && isExecutionRunLauncherResource(input.tab.resource),
            render: (input) => {
                if (!isExecutionRunLauncherResource(input.tab.resource)) return null;
                return (
                    <SessionExecutionRunLauncherView
                        sessionId={options.sessionId}
                        scopeId={options.scopeId}
                        presentation="panel"
                        initialIntent={input.tab.resource.intent}
                        onRequestClose={() => options.closeDetailsTab(input.tab.key)}
                    />
                );
            },
        },
        {
            id: 'session-provider-details',
            owner: 'session',
            order: 1_000,
            canRender: () => true,
            render: (input) => renderProviderSessionDetailsTab({
                sessionId: options.sessionId,
                scopeId: options.scopeId,
                tab: input.tab,
            }),
        },
    ];
}

export function resolveSessionDetailsSurfaceIconName(params: Readonly<{
    tab: DetailsSurfaceRenderInputV1['tab'];
    pluginUiProjection?: PluginUiProjectionModel | null;
}>): string | null {
    if (isSimulatorPreviewResource(params.tab.resource)) {
        return 'device-mobile';
    }
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
