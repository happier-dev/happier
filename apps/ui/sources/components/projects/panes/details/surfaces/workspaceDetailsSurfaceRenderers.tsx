import * as React from 'react';
import { createExecutionRunDetailsSurfaceRenderers } from '@/components/sessions/runs/launcher/executionRunDetailsSurfaceRenderers';

import type {
    DetailsSurfaceRendererV1,
    DetailsSurfaceRenderInputV1,
} from '@/components/appShell/panes/details/surfaces';
import {
    createPluginDetailsDestinationLaunchScopeFacts,
    createPluginDetailsDestinationSurfaceRenderer,
} from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';
import {
    createBrowserViewDetailsSurfaceRenderer,
    resolveBrowserSurfacePlatform,
    type BrowserDetailsSurfaceRendererOptions,
} from '@/components/browser/surfaces';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { WorkspaceFileDetailsView } from '@/components/workspaces/files/details/WorkspaceFileDetailsView';
import { readFileTargetAnchorResource, readWorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import { FileFindSeedHost } from '@/components/appShell/panes/fileFindSeedHost';
import { WorkspaceCommitDetailsView } from '@/components/projects/panes/details/views/WorkspaceCommitDetailsView';
import { WorkspaceScmReviewDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { readFileTabChanges, readSessionScmReviewTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { WorkspaceScmStashDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmStashDetailsView';
import { ProjectTerminalSurface } from '@/components/projects/detail/surfaces/ProjectTerminalSurface';
import { readTerminalDetailsCwd, readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { PluginUiDestinationRuntimeFormFactorV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { ProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import {
    readWorkspaceSyncConflictDetailsResource,
    WorkspaceSyncConflictDetailsView,
} from '@/components/workspaces/sync/WorkspaceSyncConflictDetailsView';

type WorkspaceDetailsOpenFile = (path: string, intent?: 'default' | 'pinned') => void;

export type WorkspaceDetailsSurfaceRendererOptions = Readonly<{
    scopeId: string;
    onRevealInFilesTree?: (path: string) => void;
    onOpenChanges?: () => void;
    workspaceRefId: string;
    projectContext?: ProjectWidgetAreaContextV1;
    workspaceCacheKey: string;
    workspaceScope: WorkspaceScopeBase;
    serverId: string;
    machineId: string;
    rootPath: string;
    activeRootPath: string;
    terminalWorkspace?: WorkspaceAddressV1 | null;
    presentation: 'screen' | 'panel';
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
    pluginUiProjectionPhase?: PluginUiProjectionPhase;
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

function readCommitSha(resource: unknown): string {
    if (resource == null || typeof resource !== 'object') return '';
    const r = resource as { sha?: unknown; commitHash?: unknown };
    return readOptionalString(r.sha) ?? readOptionalString(r.commitHash) ?? '';
}

export function createWorkspaceDetailsSurfaceRenderers(
    options: WorkspaceDetailsSurfaceRendererOptions,
): readonly DetailsSurfaceRendererV1[] {
    // Consume the pane's registered workspace Action owner, not an unmounted Browser view.
    const openDetailsTab = options.openDetailsTab;
    const openBrowserViewTarget = options.onOpenTarget;
    const pluginDetailsDestinationMount = {
        machineId: options.machineId,
        serverId: options.serverId,
        projectId: options.projectContext ? options.projectContext.target?.checkout?.id : options.workspaceRefId,
        projectContext: options.projectContext,
        policyContext: options.projectContext?.policyContext,
        platform: options.platform,
        formFactor: options.formFactor,
        projectionPhase: options.pluginUiProjectionPhase ?? 'unavailable',
        projectionInteractionEnabled: options.pluginUiInteractionEnabled,
    };
    const pluginDetailsDestinationLaunchScopeFacts = createPluginDetailsDestinationLaunchScopeFacts({
        projection: options.pluginUiProjection,
        mount: pluginDetailsDestinationMount,
    });
    return [
        ...createExecutionRunDetailsSurfaceRenderers({ owner: 'workspace', sessionId: null, serverId: options.serverId,
            workspace: { machineId: options.machineId, cwd: options.activeRootPath || options.rootPath } }),
        {
            id: 'workspace-sync-conflicts',
            owner: 'workspace',
            order: -10,
            canRender: (input) => readWorkspaceSyncConflictDetailsResource(input.tab.resource) !== null,
            render: (input) => {
                const resource = readWorkspaceSyncConflictDetailsResource(input.tab.resource);
                return resource ? <WorkspaceSyncConflictDetailsView resource={resource} /> : null;
            },
        },
        {
            id: 'workspace-info',
            owner: 'workspace',
            order: 0,
            canRender: (input) => input.tab.kind === 'workspaceInfo' || readResourceKind(input) === 'workspaceInfo',
            render: () => options.renderWorkspaceInfo(),
        },
        createPluginDetailsDestinationSurfaceRenderer({
            targetKind: 'project',
            projection: options.pluginUiProjection,
            mount: pluginDetailsDestinationMount,
        }),
        createBrowserViewDetailsSurfaceRenderer({
            localServicePreviewState: options.localServicePreviewState,
            localServiceLauncherState: options.localServiceLauncherState,
            localServicePreviewServerId: options.localServicePreviewServerId,
            machineId: options.machineId,
            serverId: options.serverId,
            pluginUiProjection: options.pluginUiProjection,
            pluginAccountLifetime: options.pluginAccountLifetime,
            pluginUiInteractionEnabled: options.pluginUiInteractionEnabled,
            pluginBrowserProjection: options.pluginBrowserProjection,
            pluginBrowserActionSessionId: options.pluginBrowserActionSessionId,
            // OWNER-PLATFORM: the browser renderer resolves Tauri-aware; never the leaked
            // local-preview platform (B-RC1 / DV-PLATFORM-CLOSURE).
            platform: resolveBrowserSurfacePlatform(options.platform),
            launchpadRows: options.launchpadRows,
            localServiceTargets: options.localServiceTargets,
            launchpadRefreshStatus: options.launchpadRefreshStatus,
            launchpadRefreshError: options.launchpadRefreshError,
            onRefreshLaunchpad: options.onRefreshLaunchpad,
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
                const filePath = input.tab.resource.path;
                return (
                    <FileFindSeedHost destination={{ host: 'project', id: options.workspaceRefId, scope: options.workspaceScope, path: filePath }} active={input.active}>
                    {({ findSeed, consumeFindSeed }) => (
                    <WorkspaceFileDetailsView
                        findSeed={findSeed}
                        onFindSeedConsumed={consumeFindSeed}
                        onRevealInFilesTree={options.onRevealInFilesTree}
                        onOpenChanges={options.onOpenChanges}
                        scopeId={options.scopeId}
                        scope={options.workspaceScope}
                        workspaceRefId={options.workspaceRefId}
                        targetKind="project"
                        filePath={filePath}
                        initialView={readWorkspaceFileLinkView(input.tab.resource)}
                        initialChanges={readFileTabChanges(input.tab.resource)}
                        deepLinkAnchor={readFileTargetAnchorResource(input.tab.resource)}
                        presentation={options.presentation}
                        sessionIdForAugmentation={options.sessionIdForAugmentation ?? null}
                        openableContentViewer={{
                            targetKind: 'project',
                            projection: options.pluginUiProjection,
                            platform: resolveLocalServicePreviewPlatform(options.platform),
                            details: input,
                            scopedLaunchFacts: pluginDetailsDestinationLaunchScopeFacts,
                        }}
                        onStartEditingFile={() => {
                            if (input.tab.isPreview) {
                                options.pinDetailsTab(input.tab.key);
                            }
                        }}
                    />
                    )}
                    </FileFindSeedHost>
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
                        {...options.workspaceScope}
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
            render: (input) => (
                <WorkspaceScmReviewDetailsView
                    key={options.workspaceCacheKey}
                    scopeId={options.scopeId}
                    {...options.workspaceScope}
                    {...readSessionScmReviewTarget(input.tab.resource)}
                    onSelectTarget={input.callbacks.replaceTab ? (target) => input.callbacks.replaceTab?.(input.tab.key,
                        createSessionScmReviewDetailsTab(target), { intent: 'pinned' }) : undefined}
                    onShowInGit={options.onOpenChanges}
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
                    {...options.workspaceScope}
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
                        presentation="details"
                        workspace={options.terminalWorkspace}
                    />
                );
            },
        },
    ];
}
