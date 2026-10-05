import * as React from 'react';

import { readSessionScmReviewTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';

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
    createOpenBrowserTargetInWorkspace,
    mergeBrowserSurfaceProductModels,
    resolveBrowserSurfacePlatform,
    type BrowserDetailsSurfaceRendererOptions,
    type BrowserSurfaceProductModels,
} from '@/components/browser/surfaces';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { readFileTargetAnchorResource } from '@/utils/url/sessionFileDeepLink';
import { SessionInteractiveExecutionRunDraftView } from '@/components/sessions/runs/launcher/SessionInteractiveExecutionRunDraftView';
import { isSessionPeekDetailsResource } from '@/components/sessions/work/createSessionPeekDetailsTab';
import { SessionPeekDetailsView } from '@/components/sessions/work/SessionPeekDetailsView';
import { SessionWorkMapDetailsView, isSessionWorkMapDetailsResource } from '@/components/sessions/work/SessionWorkMapDetailsView';
import { SessionExecutionRunDetailsView } from '@/components/sessions/runs/details/SessionExecutionRunDetailsView';
import { createExecutionRunDetailsTab } from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { SessionBoardDetailsSurface } from '@/components/sessions/board/SessionBoardDetailsSurface';
import { SessionDiscussionDetailsView } from '@/components/sessions/conversations/SessionDiscussionDetailsView';
import {
    createSessionBoardDetailsTab,
    createSessionDiscussionDetailsTab,
    type SessionDiscussionDetailsTarget,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { SessionEmbeddedTerminalPane } from '@/components/sessions/terminal/SessionEmbeddedTerminalPane';
import { SESSION_PRIMARY_TERMINAL_INSTANCE_ID } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { readTerminalDetailsInstanceId } from '@/components/terminal/terminalDetailsTabModel';
import {
    renderProviderSessionDetailsTab,
} from '@/agents/registry/sessionSubagentUiBehavior';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/actions';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { PeerMediationObservabilityUiStore } from '@/sync/domains/machines/peer/mediation/observability';
import {
    SessionDiscussionSelectionSourceV1Schema,
    type PeerMediationObservabilityScopeV1,
    type SessionDiscussionSelectionSourceV1,
} from '@happier-dev/protocol';
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

type SessionDetailsSurfaceRendererOptions = Readonly<{
    sessionId: string;
    session?: Session;
    scopeId: string;
    machineId?: string | null;
    serverId?: string | null;
    pluginUiProjection?: PluginUiProjectionModel | null;
    pluginUiProjectionPhase?: PluginUiProjectionPhase;
    pluginUiInteractionEnabled?: boolean;
    pluginBrowserProjection?: PluginBrowserProjectionModel | null;
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime | null;
    localServicePreviewState?: LocalServicePreviewState | null;
    peerMediationObservabilityState?: PeerMediationObservabilityUiStore | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    platform?: LocalServicePreviewPlatform;
    formFactor?: PluginUiDestinationRuntimeFormFactorV1;
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
    boardHost?: 'details' | 'focusedDetails';
    resolveBoardPrimaryHost?: SessionBoardPrimaryMountResolver;
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

function isExecutionRunLauncherResource(value: unknown): value is Readonly<{
    kind: 'executionRunLauncher';
    mode?: 'conversation';
    intent?: 'review' | 'plan' | 'delegate';
    source?: SessionDiscussionSelectionSourceV1;
    initialInstructions?: string;
    roleId?: string;
}> {
    if (!value || typeof value !== 'object') return false;
    const maybe = value as {
        kind?: unknown;
        intent?: unknown;
        roleId?: unknown;
        source?: unknown;
        initialInstructions?: unknown;
        mode?: unknown;
    };
    if (maybe.kind !== 'executionRunLauncher') return false;
    if (!(maybe.mode == null || maybe.mode === 'conversation')) return false;
    if (maybe.mode === 'conversation' && maybe.intent != null) {
        return false;
    }
    if (!(maybe.intent == null || maybe.intent === 'review' || maybe.intent === 'plan' || maybe.intent === 'delegate')) {
        return false;
    }
    if (maybe.initialInstructions != null && typeof maybe.initialInstructions !== 'string') return false;
    if (maybe.roleId != null && (typeof maybe.roleId !== 'string' || maybe.roleId.trim().length === 0)) return false;
    if (maybe.source == null) return true;
    const source = SessionDiscussionSelectionSourceV1Schema.safeParse(maybe.source);
    if (!source.success) return false;
    return maybe.mode !== 'conversation'
        || (typeof source.data.draftCorrelationId === 'string' && source.data.draftCorrelationId.trim().length > 0);
}

function isExecutionRunResource(value: unknown): value is Readonly<{ kind: 'executionRun'; runId: string; retryInputLocalId?: string }> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const maybe = value as { kind?: unknown; runId?: unknown; retryInputLocalId?: unknown };
    return maybe.kind === 'executionRun'
        && typeof maybe.runId === 'string'
        && maybe.runId.trim().length > 0
        && (maybe.retryInputLocalId === undefined
            || (typeof maybe.retryInputLocalId === 'string' && maybe.retryInputLocalId.trim().length > 0));
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
        return {
            kind: 'new',
            address: { serverId: target.address.serverId, sessionId: target.address.sessionId },
        };
    }
    if (typeof target.discussionId !== 'string' || !target.discussionId.trim()) return null;
    return {
        kind: 'discussion',
        address: { serverId: target.address.serverId, sessionId: target.address.sessionId },
        discussionId: target.discussionId,
    };
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
                        resolvePrimaryHost={options.resolveBoardPrimaryHost}
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
                serverId: options.serverId,
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
                        active={input.active}
                        sessionId={options.sessionId}
                        serverId={options.serverId}
                        filePath={input.tab.resource.path}
                        deepLinkAnchor={readFileTargetAnchorResource(input.tab.resource)}
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
                    <SessionDiscussionDetailsView
                        target={target}
                        active={input.active}
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
                                }),
                                { intent: input.tab.isPreview ? 'preview' : 'pinned' },
                            );
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
                <SessionScmReviewDetailsViewForPanel
                    sessionId={options.sessionId}
                    serverId={options.serverId}
                    scopeId={options.scopeId}
                    active={input.active}
                    target={readSessionScmReviewTarget(input.tab.resource)}
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
        {
            id: 'session-execution-run-launcher',
            owner: 'session',
            order: 70,
            canRender: (input) => readResourceKind(input) === 'executionRunLauncher' && isExecutionRunLauncherResource(input.tab.resource),
            render: (input) => {
                if (!isExecutionRunLauncherResource(input.tab.resource)) return null;
                if (
                    input.tab.resource.source
                    && input.tab.resource.source.sessionId !== options.sessionId
                ) return null;
                // One composer-first start for every ask (lab `convo-S1`): a conversation draft carries
                // no intent; a Review, Plan or Delegate tab carries its own; the old intent-less
                // "Advanced" tab asks for a review with every choice, as the form did.
                const resource = input.tab.resource;
                return (
                    <SessionInteractiveExecutionRunDraftView
                        sessionId={options.sessionId}
                        serverId={options.serverId}
                        autoFocusComposer
                        intent={resource.mode === 'conversation' ? null : resource.intent ?? 'review'}
                        roleId={resource.roleId ?? null}
                        initialText={resource.initialInstructions}
                        launchOrigin={resource.source && 'draftCorrelationId' in resource.source
                            ? resource.source as SessionDiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>
                            : undefined}
                        onRunStarted={(runId, recovery, presentation) => {
                            input.callbacks.replaceTab?.(
                                input.tab.key,
                                createExecutionRunDetailsTab(runId, recovery, presentation?.title),
                                { intent: input.tab.isPreview ? 'preview' : 'pinned' },
                            );
                        }}
                    />
                );
            },
        },
        {
            id: 'session-execution-run',
            owner: 'session',
            order: 71,
            canRender: (input) => readResourceKind(input) === 'executionRun' && isExecutionRunResource(input.tab.resource),
            render: (input) => {
                if (!isExecutionRunResource(input.tab.resource)) return null;
                return (
                    <SessionExecutionRunDetailsView
                        sessionId={options.sessionId}
                        runId={input.tab.resource.runId}
                        retryInputLocalId={input.tab.resource.retryInputLocalId}
                        serverId={options.serverId}
                        presentation="panel"
                        openingTitle={input.tab.title}
                        onRequestClose={() => options.closeDetailsTab(input.tab.key)}
                        onTitleResolved={(title) => {
                            input.callbacks.replaceTab?.(
                                input.tab.key,
                                // Same key and resource: only the name changes; pin and preview state stay.
                                { key: input.tab.key, kind: input.tab.kind, title, resource: input.tab.resource },
                            );
                        }}
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
