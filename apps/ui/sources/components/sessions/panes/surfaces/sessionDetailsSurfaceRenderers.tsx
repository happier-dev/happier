import { BotTemplateEditor } from '@/components/sessions/bots/templates/BotTemplateEditor';
import { readBotTemplateEditorResource } from '@/components/sessions/bots/templates/botTemplateEditorDestination';
import * as React from 'react';
import { t } from '@/text';

import { readFileTabChanges, readSessionScmReviewTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { createWorkspaceGalleryDetailsTab, readGalleryDetailsResource } from '@/components/appShell/panes/details/galleryDetailsTab';
import { SessionGalleryDetailsView } from '@/components/sessions/panes/details/SessionGalleryDetailsView';

import type {
    DetailsSurfaceRendererV1,
    DetailsSurfaceRenderInputV1,
} from '@/components/appShell/panes/details/surfaces';
import {
    createPluginDetailsDestinationLaunchScopeFacts,
    createPluginDetailsDestinationSurfaceRenderer,
} from '@/components/appShell/panes/details/surfaces/pluginDetailsDestination';
import {
    BrowserDetailsSurface,
    createBrowserViewDetailsSurfaceRenderer,
    mergeBrowserSurfaceProductModels,
    resolveBrowserSurfacePlatform,
    type BrowserDetailsSurfaceRendererOptions,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { readFileTargetAnchorResource, readWorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import { createExecutionRunDetailsSurfaceRenderers } from '@/components/sessions/runs/launcher/executionRunDetailsSurfaceRenderers';
import { createWorkflowDetailsSurfaceRenderers } from '@/components/workflows/run/WorkflowStartDetails';
import { SessionWorkflowStartDetails } from '@/components/sessions/agents/launch/SessionWorkflowStartDetails';
import { DiscussionWorkflowStartDetails, isDiscussionWorkflowStartResource } from '@/components/discussions/DiscussionWorkflowStartDetails';
import { isSessionPeekDetailsResource } from '@/components/sessions/work/createSessionPeekDetailsTab';
import { SessionPeekDetailsView } from '@/components/sessions/work/SessionPeekDetailsView';
import { SessionWorkMapDetailsView, isSessionWorkMapDetailsResource } from '@/components/sessions/work/SessionWorkMapDetailsView';
import { SessionBoardDetailsSurface } from '@/components/sessions/board/SessionBoardDetailsSurface';
import { DiscussionDetailsView } from '@/components/discussions/DiscussionDetailsView';
import { DiscussionSecondOpinionPaneTab } from '@/components/discussions/DiscussionSecondOpinionPaneTab';
import { readDiscussionRouteDraftId } from '@/components/discussions/discussionRoutes';
import { DiscussionAnchorV1Schema } from '@happier-dev/protocol/discussions/replyTargets';
import {
    createSessionBoardDetailsTab,
    createSessionDiscussionDetailsTab,
    type SessionDiscussionDetailsTarget,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionTerminalSurface } from './SessionTerminalSurface';
import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import {
    renderProviderSessionDetailsTab,
} from '@/agents/registry/sessionSubagentUiBehavior';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { PluginUiDestinationRuntimeFormFactorV1 } from '@happier-dev/protocol/plugins/ui';
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
import { SessionScmPullRequestDetailsView } from '@/components/sessions/panes/git/pullRequest/SessionScmPullRequestDetailsView';
import {
    readWorkspaceSyncConflictDetailsResource,
    WorkspaceSyncConflictDetailsView,
} from '@/components/workspaces/sync/WorkspaceSyncConflictDetailsView';

type SessionDetailsOpenFile = (path: string, intent?: 'default' | 'pinned') => void;

function SessionScmReviewSurface(props: Omit<React.ComponentProps<typeof SessionScmReviewDetailsViewForPanel>, 'target'> & Readonly<{
    resource: DetailsTab['resource'];
}>) {
    const { resource, ...viewProps } = props;
    // Parsing creates comparison objects that own the navigation callbacks used by every hunk.
    // Unrelated surface updates must retain them while the tab's resource is unchanged.
    const target = React.useMemo(() => readSessionScmReviewTarget(resource), [resource]);
    return <SessionScmReviewDetailsViewForPanel {...viewProps} target={target} />;
}

type SessionDetailsSurfaceRendererOptions = Readonly<{
    sessionId: string;
    session?: Session;
    scopeId: string;
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginAccountLifetime?: BrowserDetailsSurfaceRendererOptions['pluginAccountLifetime'];
    pluginUiProjectionPhase?: PluginUiProjectionPhase;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    localServiceLauncherState?: BrowserDetailsSurfaceRendererOptions['localServiceLauncherState'];
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    simulatorViewerId?: string;
    platform?: LocalServicePreviewPlatform;
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
    productModels?: BrowserSurfaceProductModels;
    browserRecording?: React.ComponentProps<typeof BrowserDetailsSurface>['browserRecording'];
    launchpadRows?: BrowserDetailsSurfaceRendererOptions['launchpadRows'];
    localServiceTargets?: BrowserDetailsSurfaceRendererOptions['localServiceTargets'];
    launchpadRefreshStatus?: BrowserDetailsSurfaceRendererOptions['launchpadRefreshStatus'];
    launchpadRefreshError?: BrowserDetailsSurfaceRendererOptions['launchpadRefreshError'];
    onRefreshLaunchpad?: BrowserDetailsSurfaceRendererOptions['onRefreshLaunchpad'];
    onOpenTarget?: BrowserDetailsSurfaceRendererOptions['onOpenTarget'];
    nowMs?: () => number;
    openFileTab: SessionDetailsOpenFile;
    getStartEditingFileHandler: (tabKey: string, isPreview: boolean) => () => void;
    sessionScreenTestIdsEnabled: boolean;
    closeDetailsTab: (tabKey: string) => void;
    openDetailsTab?: (tab: DetailsTab, options?: Readonly<{ intent?: 'default' | 'pinned' | 'preview' }>) => void;
    boardHost?: 'details' | 'focusedDetails';
}>;

function readResourceKind(input: DetailsSurfaceRenderInputV1): string | null {
    const resource = input.tab.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        return null;
    }
    const kind = (resource as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : null;
}

/** The Board item this destination selected, when it selected one. */
function readBoardResourceItemId(input: DetailsSurfaceRenderInputV1): string | null {
    const resource = input.tab.resource;
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null;
    const focusTarget = (resource as { focusTarget?: unknown }).focusTarget;
    if (!focusTarget || typeof focusTarget !== 'object' || Array.isArray(focusTarget)) return null;
    if ((focusTarget as { kind?: unknown }).kind !== 'item') return null;
    const itemId = (focusTarget as { itemId?: unknown }).itemId;
    return typeof itemId === 'string' && itemId.length > 0 ? itemId : null;
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

function readSessionDiscussionDetailsTarget(value: unknown): SessionDiscussionDetailsTarget | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resource = value as { kind?: unknown; target?: unknown };
    if (resource.kind !== 'discussion' || !resource.target || typeof resource.target !== 'object' || Array.isArray(resource.target)) {
        return null;
    }
    const target = resource.target as {
        kind?: unknown;
        address?: { serverId?: unknown; sessionId?: unknown };
        discussionId?: unknown;
        draftId?: string | string[];
        anchor?: unknown;
        messageId?: unknown;
    };
    if (
        (target.kind !== 'new' && target.kind !== 'discussion')
        || !target.address
        || typeof target.address.serverId !== 'string'
        || typeof target.address.sessionId !== 'string'
        || !target.address.serverId.trim()
        || !target.address.sessionId.trim()
    ) return null;
    if (target.kind === 'new') {
        const draftId = readDiscussionRouteDraftId(target.draftId);
        const anchor = target.anchor === undefined ? undefined : DiscussionAnchorV1Schema.safeParse(target.anchor);
        if (draftId === null || anchor && !anchor.success) return null;
        return {
            kind: 'new',
            address: { serverId: target.address.serverId, sessionId: target.address.sessionId },
            ...(draftId ? { draftId } : {}),
            ...(anchor?.success ? { anchor: anchor.data } : {}),
        };
    }
    if (typeof target.discussionId !== 'string' || !target.discussionId.trim()) return null;
    return {
        kind: 'discussion',
        address: { serverId: target.address.serverId, sessionId: target.address.sessionId },
        discussionId: target.discussionId,
        ...(typeof target.messageId === 'string' ? { messageId: target.messageId } : {}),
    };
}

function readSessionSecondOpinionDetailsTarget(value: unknown): Readonly<{ address: { serverId: string; sessionId: string }; requestId: string }> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const resource = value as { kind?: unknown; requestId?: unknown; address?: { serverId?: unknown; sessionId?: unknown } };
    if (resource.kind !== 'secondOpinion' || typeof resource.requestId !== 'string' || !resource.address
        || typeof resource.address.serverId !== 'string' || typeof resource.address.sessionId !== 'string') return null;
    return { address: { serverId: resource.address.serverId, sessionId: resource.address.sessionId }, requestId: resource.requestId };
}

function discussionTargetMatchesSession(
    target: SessionDiscussionDetailsTarget,
    options: Pick<SessionDetailsSurfaceRendererOptions, 'sessionId' | 'serverId'>,
): boolean {
    return target.address.sessionId === options.sessionId
        && (!options.serverId || areServerProfileIdentifiersEquivalent(target.address.serverId, options.serverId));
}

function isSimulatorPreviewResource(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    return (value as { kind?: unknown }).kind === 'simulatorPreview';
}

export function createSessionDetailsSurfaceRenderers(
    options: SessionDetailsSurfaceRendererOptions,
): readonly DetailsSurfaceRendererV1[] {
    const productModels = mergeBrowserSurfaceProductModels(options.productModels, {
        browserRecording: options.browserRecording,
    });

    // The pane registers the real workspace opener before any Browser view exists. Renderers
    // consume that admitted callback; only the mounted renderer materializes Browser state.
    const openDetailsTab = options.openDetailsTab;
    const openBrowserViewTarget = options.onOpenTarget;
    const pluginDetailsDestinationMount = {
        machineId: options.machineId,
        serverId: options.serverId,
        sessionId: options.sessionId,
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
        {
            id: 'bot-template-editor', owner: 'session', order: -6,
            canRender: input => readBotTemplateEditorResource(input.tab.resource) !== null,
            render: input => {
                const resource = readBotTemplateEditorResource(input.tab.resource);
                return resource ? <BotTemplateEditor artifactId={resource.artifactId} serverId={resource.serverId} sourceSessionId={options.sessionId} presentation="pane" /> : null;
            },
        },
        {
            id: 'session-board',
            owner: 'session',
            order: -5,
            canRender: (input) => readResourceKind(input) === 'board',
            render: (input) => {
                const host = options.boardHost ?? 'details';
                // The destination carries the selected item, so an "Open in Details"
                // from the sidebar or a "Read full note" opens THAT item's expanded
                // route rather than the generic Board.
                const focusedItemId = readBoardResourceItemId(input);
                const openDetailsTab = options.openDetailsTab;
                return (
                    <SessionBoardDetailsSurface
                        sessionId={options.sessionId}
                        {...(options.session ? { session: options.session } : {})}
                        serverId={options.serverId}
                        paneScopeId={options.scopeId}
                        host={host}
                        active={input.active}
                        {...(focusedItemId ? { focusedItemId } : {})}
                        {...(focusedItemId && openDetailsTab
                            ? { onLeaveFocusedItem: () => openDetailsTab(createSessionBoardDetailsTab(), { intent: 'pinned' }) }
                            : {})}
                        {...(openDetailsTab
                            ? {
                                onReadFullItem: (itemId: string) => openDetailsTab(
                                    createSessionBoardDetailsTab({ kind: 'item', itemId }),
                                    { intent: 'pinned' },
                                ),
                            }
                            : {})}
                        pluginRuntime={{
                            pluginUiProjection: options.pluginUiProjection ?? null,
                            pluginBrowserProjection: options.pluginBrowserProjection ?? null,
                            accountLifetime: options.pluginAccountLifetime ?? null,
                            phase: options.pluginUiProjectionPhase ?? 'unavailable',
                            interactionEnabled: options.pluginUiInteractionEnabled === true,
                            machineId: options.machineId ?? null,
                            serverId: options.serverId ?? null,
                            platform: resolveLocalServicePreviewPlatform(options.platform),
                        } satisfies SessionPluginRuntimeState}
                        {...(options.callerHostedHtmlRuntime
                            ? { callerHostedHtmlRuntime: options.callerHostedHtmlRuntime }
                            : {})}
                    />
                );
            },
        },
        {
            id: 'session-workspace-sync-conflicts',
            owner: 'workspace',
            order: -10,
            canRender: (input) => readWorkspaceSyncConflictDetailsResource(input.tab.resource) !== null,
            render: (input) => {
                const resource = readWorkspaceSyncConflictDetailsResource(input.tab.resource);
                return resource ? <WorkspaceSyncConflictDetailsView resource={resource} /> : null;
            },
        },
        {
            id: 'session-surface-registry',
            owner: 'session',
            order: 0,
            canRender: (input) => readResourceKind(input) === 'simulatorPreview' || readResourceKind(input) === 'computerScreen',
            render: (input) => renderSessionSurfaceTab({
                sessionId: options.sessionId,
                scopeId: options.scopeId,
                serverId: options.serverId,
                machineId: options.machineId,
                simulatorViewerId: options.simulatorViewerId,
                tab: input.tab,
                simulatorPreview: options.simulatorPreview,
                nowMs: options.nowMs,
            }),
        },
        createPluginDetailsDestinationSurfaceRenderer({
            targetKind: 'session',
            projection: options.pluginUiProjection,
            mount: pluginDetailsDestinationMount,
        }),
        createBrowserViewDetailsSurfaceRenderer({
            localServicePreviewState: options.localServicePreviewState,
            localServiceLauncherState: options.localServiceLauncherState,
            sessionId: options.sessionId,
            localServicePreviewServerId: options.serverId,
            // W2-A-1 / A3: scope for the UI→daemon browser control transport so a daemon-authoritative
            // view in this workspace tab dispatches reload/stop/navigate through the daemon broker.
            machineId: options.machineId,
            serverId: options.serverId,
            pluginUiProjection: options.pluginUiProjection,
            pluginAccountLifetime: options.pluginAccountLifetime,
            pluginUiInteractionEnabled: options.pluginUiInteractionEnabled,
            pluginBrowserProjection: options.pluginBrowserProjection,
            pluginBrowserActionSessionId: options.sessionId,
            // OWNER-PLATFORM: the browser renderer resolves Tauri-aware; never the leaked
            // local-preview platform (B-RC1 / DV-PLATFORM-CLOSURE).
            platform: resolveBrowserSurfacePlatform(options.platform),
            productModels,
            launchpadRows: options.launchpadRows,
            localServiceTargets: options.localServiceTargets,
            launchpadRefreshStatus: options.launchpadRefreshStatus,
            launchpadRefreshError: options.launchpadRefreshError,
            onRefreshLaunchpad: options.onRefreshLaunchpad,
            onOpenTarget: openBrowserViewTarget,
            nowMs: options.nowMs,
        }),
        {
            // A folder's or this Session's media as a gallery (lab pr974 SG2).
            id: 'session-gallery',
            owner: 'session',
            order: 10,
            canRender: (input) => readGalleryDetailsResource(input.tab.resource) !== null,
            render: (input) => {
                const resource = readGalleryDetailsResource(input.tab.resource);
                if (!resource) return null;
                return (
                    <SessionGalleryDetailsView
                        sessionId={options.sessionId}
                        serverId={options.serverId ?? null}
                        resource={resource}
                        onNavigate={(path) => input.callbacks.replaceTab?.(input.tab.key,
                            createWorkspaceGalleryDetailsTab({ kind: 'gallery', path }, path.split('/').at(-1) || t('files.projectRoot')),
                            { intent: input.tab.isPreview ? 'preview' : 'pinned' })}
                        onOpenFile={(path) => options.openFileTab(path, 'default')}
                    />
                );
            },
        },
        {
            id: 'session-file',
            owner: 'session',
            order: 10,
            canRender: (input) => readResourceKind(input) === 'file' && isFileResource(input.tab.resource),
            render: (input) => {
                if (!isFileResource(input.tab.resource)) return null;
                return (
                    <SessionFileDetailsViewForPanel
                        active={input.active}
                        sessionId={options.sessionId}
                        serverId={options.serverId}
                        filePath={input.tab.resource.path}
                        deepLinkAnchor={readFileTargetAnchorResource(input.tab.resource)}
                        initialView={readWorkspaceFileLinkView(input.tab.resource)}
                        initialChanges={readFileTabChanges(input.tab.resource)}
                        presentation="panel"
                        scopeId={options.scopeId}
                        openableContentViewer={{
                            targetKind: 'session',
                            projection: options.pluginUiProjection,
                            platform: resolveLocalServicePreviewPlatform(options.platform),
                            details: input,
                            scopedLaunchFacts: pluginDetailsDestinationLaunchScopeFacts,
                        }}
                        onStartEditingFile={options.getStartEditingFileHandler(input.tab.key, input.tab.isPreview)}
                    />
                );
            },
        },
        {
            id: 'session-discussion',
            owner: 'session',
            order: 15,
            canRender: (input) => {
                const target = readSessionDiscussionDetailsTarget(input.tab.resource);
                return target !== null && discussionTargetMatchesSession(target, options);
            },
            render: (input) => {
                const target = readSessionDiscussionDetailsTarget(input.tab.resource);
                if (!target || !discussionTargetMatchesSession(target, options)) return null;
                return (
                    <DiscussionDetailsView
                        target={target.kind === 'new'
                            ? { kind: 'new', address: { serverId: target.address.serverId },
                                anchor: target.anchor ?? { kind: 'session', sessionId: target.address.sessionId },
                                ...(target.draftId ? { draftId: target.draftId } : {}) }
                            : { kind: 'discussion', address: { serverId: target.address.serverId }, discussionId: target.discussionId,
                                ...(target.messageId ? { messageId: target.messageId } : {}) }}
                        active={input.active}
                        hostSessionAddress={target.address}
                        onClose={() => options.closeDetailsTab(input.tab.key)}
                        onCreated={(discussion) => {
                            input.callbacks.replaceTab?.(
                                input.tab.key,
                                createSessionDiscussionDetailsTab({
                                    kind: 'discussion',
                                    address: target.address,
                                    discussionId: discussion.id,
                                    title: discussion.title,
                                }),
                                { intent: input.tab.isPreview ? 'preview' : 'pinned' },
                            );
                        }}
                        onOpened={(discussion) => {
                            // Same tab key, same builder: an opened discussion replaces the
                            // generic label with its decrypted title without moving the tab.
                            input.callbacks.replaceTab?.(
                                input.tab.key,
                                createSessionDiscussionDetailsTab({
                                    kind: 'discussion',
                                    address: target.address,
                                    discussionId: discussion.id,
                                    title: discussion.title,
                                    ...(target.kind === 'discussion' && target.messageId ? { messageId: target.messageId } : {}),
                                }),
                                { intent: input.tab.isPreview ? 'preview' : 'pinned' },
                            );
                        }}
                    />
                );
            },
        },
        {
            // Lab T3: Second opinion / Discuss… beside the transcript; it becomes the Discussion it starts.
            id: 'session-second-opinion',
            owner: 'session',
            order: 15,
            canRender: (input) => {
                const target = readSessionSecondOpinionDetailsTarget(input.tab.resource);
                return target !== null && target.address.sessionId === options.sessionId;
            },
            render: (input) => {
                const target = readSessionSecondOpinionDetailsTarget(input.tab.resource);
                if (!target) return null;
                return (
                    <DiscussionSecondOpinionPaneTab
                        active={input.active}
                        requestId={target.requestId}
                        paneScopeId={options.scopeId}
                        tabKey={input.tab.key}
                        onCloseTab={() => options.closeDetailsTab(input.tab.key)}
                        onOpenDiscussion={(discussionId, title, messageId) => {
                            input.callbacks.replaceTab?.(input.tab.key, createSessionDiscussionDetailsTab({
                                kind: 'discussion', address: target.address, discussionId, title, messageId,
                            }), { intent: 'pinned' });
                        }}
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
                        serverId={options.serverId}
                        sha={String(sha)}
                        onBack={() => options.closeDetailsTab(input.tab.key)}
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
            render: (input) => (
                <SessionScmReviewSurface
                    sessionId={options.sessionId}
                    serverId={options.serverId}
                    scopeId={options.scopeId}
                    active={input.active}
                    resource={input.tab.resource}
                    onOpenDetailsTab={options.openDetailsTab}
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
                    serverId={options.serverId ?? undefined}
                    scopeId={options.scopeId}
                    onOpenFile={(path) => options.openFileTab(path, 'default')}
                    onOpenFilePinned={(path) => options.openFileTab(path, 'pinned')}
                />
            ),
        },
        {
            id: 'session-scm-pull-request',
            owner: 'scm',
            order: 45,
            canRender: (input) => readResourceKind(input) === 'scmPullRequest',
            render: (input) => (
                <SessionScmPullRequestDetailsView
                    sessionId={options.sessionId}
                    serverId={options.serverId ?? undefined}
                    onCloseTab={() => options.closeDetailsTab(input.tab.key)}
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
                    <SessionTerminalSurface
                        sessionId={options.sessionId}
                        scopeId={options.scopeId}
                        presentation="details"
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
                        serverId={options.serverId}
                        scopeId={options.scopeId}
                        subagentId={input.tab.resource.subagentId}
                    />
                );
            },
        },
        {
            id: 'session-peek',
            owner: 'session',
            order: 61,
            canRender: (input) => isSessionPeekDetailsResource(input.tab.resource),
            render: (input) => {
                if (!isSessionPeekDetailsResource(input.tab.resource)) return null;
                return (
                    <SessionPeekDetailsView
                        sessionId={input.tab.resource.sessionId}
                        serverId={options.serverId}
                        active={input.active}
                    />
                );
            },
        },
        {
            id: 'session-work-map',
            owner: 'session',
            order: 62,
            canRender: (input) => isSessionWorkMapDetailsResource(input.tab.resource),
            render: (input) => {
                if (!isSessionWorkMapDetailsResource(input.tab.resource)) return null;
                return (
                    <SessionWorkMapDetailsView
                        sessionId={input.tab.resource.sessionId}
                        serverId={options.serverId ?? null}
                        scopeId={options.scopeId}
                    />
                );
            },
        },
        ...createExecutionRunDetailsSurfaceRenderers({ owner: 'session', sessionId: options.sessionId,
            serverId: options.serverId, closeDetailsTab: options.closeDetailsTab }),
        ...createWorkflowDetailsSurfaceRenderers({ owner: 'session', renderStart: input => isDiscussionWorkflowStartResource(input.tab.resource)
            ? <DiscussionWorkflowStartDetails input={input} />
            : <SessionWorkflowStartDetails input={input} sessionId={options.sessionId} serverId={options.serverId} /> }),
        {
            id: 'session-provider-details',
            owner: 'session',
            order: 1_000,
            canRender: () => true,
            render: (input) => renderProviderSessionDetailsTab({
                sessionId: options.sessionId,
                scopeId: options.scopeId,
                serverId: options.serverId,
                tab: input.tab,
            }),
        },
    ];
}

export function resolveSessionDetailsSurfaceIconName(params: Readonly<{
    tab: DetailsSurfaceRenderInputV1['tab'];
}>): string | null {
    if (isSimulatorPreviewResource(params.tab.resource)) {
        return 'device-mobile';
    }
    return null;
}
