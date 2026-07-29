import * as React from 'react';

import type {
    DetailsSurfaceRendererV1,
    DetailsSurfaceRenderInputV1,
} from '@/components/appShell/panes/details/surfaces';
import {
    createBrowserViewDetailsSurfaceRenderer,
    createOpenBrowserTargetInWorkspace,
    resolveBrowserSurfacePlatform,
    type BrowserDetailsSurfaceRendererOptions,
} from '@/components/browser/surfaces';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { WorkspaceFileDetailsView, type WorkspaceFileDeepLinkAnchor } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { WorkspaceCommitDetailsView } from '@/components/projects/panes/details/views/WorkspaceCommitDetailsView';
import { WorkspaceScmReviewDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView';
import { WorkspaceScmStashDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmStashDetailsView';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { readTerminalDetailsCwd, readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

type WorkspaceDetailsOpenFile = (path: string, intent?: 'default' | 'pinned') => void;

export type WorkspaceDetailsSurfaceRendererOptions = Readonly<{
    scopeId: string;
    workspaceRefId: string;
    workspaceCacheKey: string;
    workspaceScope: WorkspaceScopeBase;
    serverId: string;
    machineId: string;
    rootPath: string;
    activeRootPath: string;
    presentation: 'screen' | 'panel';
    sessionIdForAugmentation?: string | null;
    pinDetailsTab: (tabKey: string) => void;
    openDetailsTab?: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    openFileTab: WorkspaceDetailsOpenFile;
    renderWorkspaceInfo: () => React.ReactNode;
}> & BrowserDetailsSurfaceRendererOptions;

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

function readOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readDeepLinkAnchor(resource: unknown): WorkspaceFileDeepLinkAnchor | null {
    if (resource == null || typeof resource !== 'object') return null;
    if (!('deepLinkAnchor' in resource)) return null;
    const value = (resource as { deepLinkAnchor?: unknown }).deepLinkAnchor;
    if (value == null || typeof value !== 'object') return null;
    if (!('source' in value) || !('anchor' in value)) return null;
    return value as WorkspaceFileDeepLinkAnchor;
}

function readCommitSha(resource: unknown): string {
    if (resource == null || typeof resource !== 'object') return '';
    const r = resource as { sha?: unknown; commitHash?: unknown };
    return readOptionalString(r.sha) ?? readOptionalString(r.commitHash) ?? '';
}

export function createWorkspaceDetailsSurfaceRenderers(
    options: WorkspaceDetailsSurfaceRendererOptions,
): readonly DetailsSurfaceRendererV1[] {
    // Canonical "open target → details tab + live content record" owner for the workspace pane —
    // the same single owner the session pane uses, so opening behaves identically everywhere.
    // Wired only when the pane supplies a details-tab sink (it always does in product).
    const openDetailsTab = options.openDetailsTab;
    const openBrowserViewTarget = openDetailsTab
        ? createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: 'workspaceDetails',
            // OWNER-PLATFORM: resolve through the one Tauri-aware resolver (never a `?? 'web'`
            // fallback, which silently misclassified desktop — DV-PLATFORM-CLOSURE).
            platform: resolveBrowserSurfacePlatform(options.platform),
            localServicePreviewState: options.localServicePreviewState,
        })
        : undefined;
    return [
        {
            id: 'workspace-info',
            owner: 'workspace',
            order: 0,
            canRender: (input) => input.tab.kind === 'workspaceInfo' || readResourceKind(input) === 'workspaceInfo',
            render: () => options.renderWorkspaceInfo(),
        },
        createBrowserViewDetailsSurfaceRenderer({
            localServicePreviewState: options.localServicePreviewState,
            localServicePreviewServerId: options.localServicePreviewServerId,
            machineId: options.machineId,
            serverId: options.serverId,
            pluginUiProjection: options.pluginUiProjection,
            pluginBrowserProjection: options.pluginBrowserProjection,
            pluginBrowserActionSessionId: options.pluginBrowserActionSessionId,
            // OWNER-PLATFORM: the browser renderer resolves Tauri-aware; never the leaked
            // local-preview platform (B-RC1 / DV-PLATFORM-CLOSURE).
            platform: resolveBrowserSurfacePlatform(options.platform),
            launchpadRows: options.launchpadRows,
            launchpadRefreshStatus: options.launchpadRefreshStatus,
            launchpadRefreshError: options.launchpadRefreshError,
            productModels: options.productModels,
            supplementalDiagnostics: options.supplementalDiagnostics,
            onOpenTarget: openBrowserViewTarget,
            nowMs: options.nowMs,
        }),
        {
            id: 'workspace-file',
            owner: 'workspace',
            order: 10,
            canRender: (input) => readResourceKind(input) === 'file' && isFileResource(input.tab.resource),
            render: (input) => {
                if (!isFileResource(input.tab.resource)) return null;
                return (
                    <WorkspaceFileDetailsView
                        scopeId={options.scopeId}
                        scope={options.workspaceScope}
                        filePath={input.tab.resource.path}
                        deepLinkAnchor={readDeepLinkAnchor(input.tab.resource)}
                        presentation={options.presentation}
                        sessionIdForAugmentation={options.sessionIdForAugmentation ?? null}
                        onStartEditingFile={() => {
                            if (input.tab.isPreview) {
                                options.pinDetailsTab(input.tab.key);
                            }
                        }}
                    />
                );
            },
        },
        {
            id: 'workspace-commit',
            owner: 'scm',
            order: 20,
            canRender: (input) => readResourceKind(input) === 'commit' && isCommitResource(input.tab.resource),
            render: (input) => {
                if (!isCommitResource(input.tab.resource)) return null;
                return (
                    <WorkspaceCommitDetailsView
                        scopeId={options.scopeId}
                        workspaceRefId={options.workspaceRefId}
                        workspaceCacheKey={options.workspaceCacheKey}
                        machineId={options.machineId}
                        rootPath={options.activeRootPath}
                        serverId={options.serverId}
                        sha={readCommitSha(input.tab.resource)}
                        presentation={options.presentation}
                        onOpenFile={(path) => options.openFileTab(path, 'default')}
                        onOpenFilePinned={(path) => options.openFileTab(path, 'pinned')}
                    />
                );
            },
        },
        {
            id: 'workspace-scm-review',
            owner: 'scm',
            order: 30,
            canRender: (input) => readResourceKind(input) === 'scmReview',
            render: () => (
                <WorkspaceScmReviewDetailsView
                    scopeId={options.scopeId}
                    workspaceRefId={options.workspaceRefId}
                    workspaceCacheKey={options.workspaceCacheKey}
                    machineId={options.machineId}
                    rootPath={options.activeRootPath}
                    serverId={options.serverId}
                    onOpenFile={(path) => options.openFileTab(path, 'default')}
                    onOpenFilePinned={(path) => options.openFileTab(path, 'pinned')}
                />
            ),
        },
        {
            id: 'workspace-scm-stash',
            owner: 'scm',
            order: 40,
            canRender: (input) => readResourceKind(input) === 'scmStash',
            render: () => (
                <WorkspaceScmStashDetailsView
                    scopeId={options.scopeId}
                    workspaceRefId={options.workspaceRefId}
                    workspaceCacheKey={options.workspaceCacheKey}
                    machineId={options.machineId}
                    rootPath={options.activeRootPath}
                    serverId={options.serverId}
                    onOpenFile={(path) => options.openFileTab(path, 'default')}
                    onOpenFilePinned={(path) => options.openFileTab(path, 'pinned')}
                />
            ),
        },
        {
            id: 'workspace-terminal',
            owner: 'terminal',
            order: 50,
            canRender: (input) => readResourceKind(input) === 'terminal',
            render: (input) => {
                const fallbackTerminalInstanceId =
                    typeof input.tab.key === 'string' && input.tab.key.startsWith('terminal:')
                        ? input.tab.key.slice('terminal:'.length)
                        : 'main';
                const terminalInstanceId = readTerminalDetailsInstanceId(input.tab.resource, fallbackTerminalInstanceId);
                if (!terminalInstanceId) return null;
                return (
                    <ProjectTerminalSurface
                        scopeId={options.scopeId}
                        workspaceRefId={options.workspaceRefId}
                        machineId={options.machineId}
                        rootPath={readTerminalDetailsCwd(input.tab.resource) ?? options.activeRootPath}
                        serverId={options.serverId}
                        terminalInstanceId={terminalInstanceId}
                        closeOnUnmount={true}
                    />
                );
            },
        },
    ];
}
