import { RIGHT_SIDEBAR_BUILTIN_TABS, type RightSidebarBuiltInTabId } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { ScmComparisonSourceSchema } from '@happier-dev/protocol/scm';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import {
    createPrimarySessionDetailsTerminalTab,
    createSessionDetailsTerminalTab,
    SESSION_PRIMARY_TERMINAL_INSTANCE_ID,
} from '@/components/sessions/terminal/embeddedTerminalDocking';
import {
    isTerminalDetailsTab,
    resolveTerminalDetailsInstanceId,
} from '@/components/terminal/terminalDetailsTabModel';
import {
    createSessionCommitDetailsTab,
    createSessionScmReviewDetailsTab,
    createSessionScmStashDetailsTab,
    createSessionScmPullRequestDetailsTab,
    createSessionDiscussionDetailsTab,
    createSessionBoardDetailsTab,
    type SessionBoardDetailsFocusTarget,
    type SessionScmReviewComparison,
    type SessionScmReviewTarget,
    type SessionScmReviewView,
    SESSION_SCM_REVIEW_VIEWS,
    SESSION_DETAILS_SCM_REVIEW_TAB_KEY,
    SESSION_DETAILS_SCM_STASH_TAB_KEY,
    SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { createComputerScreenDetailsTab, readComputerScreenSessionSurfaceResource } from '@/components/computer/computerScreenDetailsTab';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import type { DetailsTab, DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { FILE_TARGET_ANCHOR_PARAM_KEYS, parseSessionFileDeepLinkAnchor, readFileTargetAnchorResource, readWorkspaceFileLinkView, serializeFileTargetAnchor, type FileTargetAnchor, type WorkspaceFileLinkView } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { readWorkspaceFileView } from '@/components/workspaces/files/details/workspaceFileDetails/workspaceFileView';
import { resolveFileChangesScope } from '@/components/workspaces/files/file/changes/fileChangesScope';
import { serializeScmReviewTarget } from '@/utils/url/scmReviewTargetUrl';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';

export type SessionPaneUrlDetailsTarget =
    | Readonly<{ kind: 'file'; path: string; anchor?: FileTargetAnchor; anchorSource?: ReviewCommentSource; changes?: SessionScmReviewComparison } & WorkspaceFileLinkView>
    | Readonly<{ kind: 'commit'; sha: string }>
    | (Readonly<{ kind: 'scmReview' }> & SessionScmReviewTarget)
    | Readonly<{ kind: 'scmStash' }>
    | Readonly<{ kind: 'scmPullRequest' }>
    | Readonly<{ kind: 'terminal'; terminalInstanceId?: string }>
    | Readonly<{ kind: 'discussion'; discussionId: string }>
    | Readonly<{ kind: 'board'; focusTarget?: SessionBoardDetailsFocusTarget }>
    | Readonly<{ kind: 'computerScreen'; machineId: string }>;

/**
 * Every param a Session pane link can carry. The pane-link sync, the browser history push and the
 * route all read this one list, so a target's extra params (a review comparison) survive reload/back.
 */
export const SESSION_PANE_URL_PARAM_KEYS = [
    'right', 'bottom', 'details', 'path', 'sha', 'terminalInstanceId', 'discussionId', 'machineId', 'boardItemId',
    'comparison', 'comparisonId', 'turnId', 'checkpointReceiptId', 'evidence', 'head', 'base', 'commit', 'parent', 'view', 'explain', 'pullRequest', 'evidenceSessionId',
    'fileView', 'blame', 'fileOpenAs', 'rootPath',
    ...FILE_TARGET_ANCHOR_PARAM_KEYS,
] as const;
export type SessionPaneUrlParamKey = (typeof SESSION_PANE_URL_PARAM_KEYS)[number];

export type SessionPaneUrlState = Readonly<{
    rightTabId?: RightSidebarBuiltInTabId;
    bottomTabId?: 'terminal';
    details?: SessionPaneUrlDetailsTarget;
}>;

type PaneScopeStateLike = Readonly<{
    right: Readonly<{ isOpen: boolean; activeTabId: string | null }>;
    bottom: Readonly<{ isOpen: boolean; activeTabId: string | null }>;
    details: Readonly<{ isOpen: boolean; tabs: ReadonlyArray<Readonly<{ key: string; kind: string; resource: unknown }>>; activeTabKey: string | null; tabState?: Readonly<Record<string, unknown>> }>;
}>;

function readSingleStringParam(params: Readonly<Record<string, unknown>>, key: string): string | null {
    const raw = params[key];
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        const first = raw[0];
        return typeof first === 'string' ? first : null;
    }
    return null;
}

/**
 * The review destination's comparison and view, read from link params. A selector missing a part it
 * needs (a turn without its id, a branch without its base) is dropped rather than guessed.
 */
function parseScmReviewTarget(params: Readonly<Record<string, unknown>>): SessionScmReviewTarget {
    const read = (key: string) => readSingleStringParam(params, key)?.trim() || null;
    let comparison: SessionScmReviewComparison | null = null;
    switch (read('comparison')) {
        case 'workingTree':
            comparison = { kind: 'workingTree' };
            break;
        case 'session':
            comparison = { kind: 'session' };
            break;
        case 'turnCheckpoint': {
            const turnId = read('turnId');
            const checkpointReceiptId = read('checkpointReceiptId');
            const evidenceRaw = read('evidence');
            const evidence = evidenceRaw === 'agent_reported' || evidenceRaw === 'checkpoint' ? evidenceRaw : null;
            if (turnId || checkpointReceiptId) comparison = { kind: 'turnCheckpoint', ...(turnId ? { turnId } : {}),
                ...(checkpointReceiptId ? { checkpointReceiptId } : {}), ...(evidence ? { evidence } : {}) };
            break;
        }
        case 'branch': {
            const head = read('head');
            const base = read('base');
            if (head && base) comparison = { kind: 'branch', head, base };
            break;
        }
        case 'commit': {
            const commit = read('commit');
            const parent = read('parent');
            if (commit) comparison = parent ? { kind: 'commit', commit, parent } : { kind: 'commit', commit };
            break;
        }
        case 'pullRequest': {
            try {
                const source = ScmComparisonSourceSchema.safeParse({ kind: 'pullRequest', locator: JSON.parse(read('pullRequest') ?? 'null') });
                if (source.success && source.data.kind === 'pullRequest') comparison = source.data;
            } catch { /* A malformed locator cannot select a comparison. */ }
            break;
        }
    }
    const viewRaw = read('view');
    const comparisonId = read('comparisonId');
    const view = SESSION_SCM_REVIEW_VIEWS.find((candidate) => candidate === viewRaw) ?? null;
    const explainRaw = read('explain');
    const explain = explainRaw === 'true' ? true : explainRaw === 'false' ? false : undefined;
    const evidenceSessionId = read('evidenceSessionId');
    return {
        ...(comparison ? { comparison: comparisonId ? { ...comparison, comparisonId } : comparison } : null),
        ...(view ? { view } : null),
        ...(typeof explain === 'boolean' ? { explain } : null),
        ...(evidenceSessionId ? { evidenceSessionId } : null),
    };
}

/** A stored tab's comparison and view, validated by the same reader a link goes through. */
export function readSessionScmReviewTarget(resource: unknown): SessionScmReviewTarget {
    const record = resource && typeof resource === 'object' ? resource as { comparison?: unknown; view?: unknown; explain?: unknown; evidenceSessionId?: unknown } : {};
    const comparison = record.comparison && typeof record.comparison === 'object' ? record.comparison as SessionScmReviewComparison : undefined;
    const view = typeof record.view === 'string' ? record.view as SessionScmReviewView : undefined;
    return parseScmReviewTarget(serializeScmReviewTarget({
        ...(comparison ? { comparison } : null),
        ...(view ? { view } : null),
        ...(typeof record.explain === 'boolean' ? { explain: record.explain } : null),
        ...(typeof record.evidenceSessionId === 'string' ? { evidenceSessionId: record.evidenceSessionId } : null),
    }));
}

export function parseSessionPaneUrlState(params: Readonly<Record<string, unknown>>): SessionPaneUrlState | null {
    const rightRaw = readSingleStringParam(params, 'right')?.trim() ?? '';
    const rightTabId = RIGHT_SIDEBAR_BUILTIN_TABS.find((tab) => tab.id === rightRaw && tab.scopes.includes('session'))?.id ?? null;
    const bottomRaw = readSingleStringParam(params, 'bottom')?.trim() ?? '';
    const bottomTabId = bottomRaw === 'terminal' ? bottomRaw : null;

    const detailsRaw = readSingleStringParam(params, 'details')?.trim() ?? '';
    const pathRaw = readSingleStringParam(params, 'path') ?? '';
    const shaRaw = readSingleStringParam(params, 'sha')?.trim() ?? '';
    const terminalInstanceIdRaw = readSingleStringParam(params, 'terminalInstanceId')?.trim() ?? '';
    const discussionIdRaw = readSingleStringParam(params, 'discussionId')?.trim() ?? '';
    const boardItemIdRaw = readSingleStringParam(params, 'boardItemId')?.trim() ?? '';
    const machineIdRaw = readSingleStringParam(params, 'machineId')?.trim() ?? '';

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (detailsRaw === 'file' && pathRaw && isSafeWorkspaceRelativePath(pathRaw)) {
        const parsed = parseSessionFileDeepLinkAnchor(params);
        const changes = parseScmReviewTarget(params).comparison;
        details = { kind: 'file', path: pathRaw, ...(parsed ? { anchor: parsed.anchor } : {}),
            ...(parsed?.source === 'diff' ? { anchorSource: parsed.source } : {}), ...(changes ? { changes } : {}), ...readWorkspaceFileLinkView(params) };
    }
    if (detailsRaw === 'commit' && shaRaw) {
        details = { kind: 'commit', sha: shaRaw };
    }
    if (detailsRaw === 'scmReview') {
        details = { kind: 'scmReview', ...parseScmReviewTarget(params) };
    }
    if (detailsRaw === 'scmStash') {
        details = { kind: 'scmStash' };
    }
    if (detailsRaw === 'scmPullRequest') {
        details = { kind: 'scmPullRequest' };
    }
    if (detailsRaw === 'terminal') {
        details = terminalInstanceIdRaw
            ? { kind: 'terminal', terminalInstanceId: terminalInstanceIdRaw }
            : { kind: 'terminal' };
    }
    if (detailsRaw === 'discussion' && discussionIdRaw) {
        details = { kind: 'discussion', discussionId: discussionIdRaw };
    }
    if (detailsRaw === 'board') {
        details = boardItemIdRaw
            ? { kind: 'board', focusTarget: { kind: 'item', itemId: boardItemIdRaw } }
            : { kind: 'board' };
    }
    if (detailsRaw === 'computer' && machineIdRaw) {
        details = { kind: 'computerScreen', machineId: machineIdRaw };
    }

    if (!rightTabId && !bottomTabId && !details) return null;
    return {
        ...(rightTabId ? { rightTabId } : null),
        ...(bottomTabId ? { bottomTabId } : null),
        ...(details ? { details } : null),
    };
}

export function serializeSessionPaneUrlState(state: SessionPaneUrlState): Record<string, string> {
    const out: Record<string, string> = {};
    if (state.rightTabId) {
        out.right = state.rightTabId;
    }
    if (state.bottomTabId) {
        out.bottom = state.bottomTabId;
    }
    if (state.details?.kind === 'file') {
        out.details = 'file';
        out.path = state.details.path;
        if (state.details.rootPath) out.rootPath = state.details.rootPath;
        if (state.details.anchor) Object.assign(out, serializeFileTargetAnchor(state.details.anchor, state.details.anchorSource));
        if (state.details.view) out.fileView = state.details.view;
        if (state.details.blame !== undefined) out.blame = state.details.blame ? '1' : '0';
        if (state.details.openAs) out.fileOpenAs = state.details.openAs;
        if (state.details.changes) Object.assign(out, serializeScmReviewTarget({ comparison: state.details.changes }));
    }
    if (state.details?.kind === 'commit') {
        out.details = 'commit';
        out.sha = state.details.sha;
    }
    if (state.details?.kind === 'scmReview') {
        out.details = 'scmReview';
        Object.assign(out, serializeScmReviewTarget(state.details));
    }
    if (state.details?.kind === 'scmStash') {
        out.details = 'scmStash';
    }
    if (state.details?.kind === 'scmPullRequest') {
        out.details = 'scmPullRequest';
    }
    if (state.details?.kind === 'terminal') {
        out.details = 'terminal';
        if (typeof state.details.terminalInstanceId === 'string' && state.details.terminalInstanceId.trim().length > 0) {
            out.terminalInstanceId = state.details.terminalInstanceId.trim();
        }
    }
    if (state.details?.kind === 'discussion') {
        out.details = 'discussion';
        out.discussionId = state.details.discussionId;
    }
    if (state.details?.kind === 'board') {
        out.details = 'board';
        if (state.details.focusTarget?.kind === 'item') out.boardItemId = state.details.focusTarget.itemId;
    }
    if (state.details?.kind === 'computerScreen') {
        out.details = 'computer';
        out.machineId = state.details.machineId;
    }
    return out;
}

function readActiveDetailsUrlTarget(
    detailsTabs: readonly unknown[],
    activeDetailsKey: string | null,
    tabState?: Readonly<Record<string, unknown>>,
): SessionPaneUrlDetailsTarget | null {
    const selected = detailsTabs.find((tab) => tab && typeof tab === 'object' && 'key' in tab && tab.key === activeDetailsKey)
        ?? detailsTabs.at(-1)
        ?? null;
    if (!selected || typeof selected !== 'object' || !('key' in selected) || typeof selected.key !== 'string') return null;
    const activeTab = selected as Readonly<{ key: string; kind?: unknown; resource?: unknown }>;
    const resource = activeTab.resource && typeof activeTab.resource === 'object'
        ? activeTab.resource as Readonly<Record<string, unknown>>
        : null;

    if (activeTab.kind === 'file') {
        const path = typeof resource?.path === 'string' ? resource.path : '';
        if (!path || !isSafeWorkspaceRelativePath(path)) return null;
        const parsed = readFileTargetAnchorResource(activeTab.resource);
        const initialChanges = readSessionScmReviewTarget({ comparison: resource?.changes }).comparison;
        const fileView = readWorkspaceFileView(tabState?.[activeTab.key]);
        const storedScope = fileView.changesScope;
        const changes = storedScope ? resolveFileChangesScope({ storedScope, initialChanges }).selector : initialChanges;
        const { view: openingView, ...linkView } = readWorkspaceFileLinkView(resource);
        // A launch hint cannot keep replaying after a real page control changes the view.
        // Preview has no opener-mode arm; omit the hint and retain it in tab memory.
        const view = fileView.mode === 'diff' ? 'changes' : fileView.mode === 'file' ? 'view'
            : fileView.mode === 'markdown' ? undefined : openingView;
        return { kind: 'file', path, ...(parsed ? { anchor: parsed.anchor } : {}),
            ...(parsed?.source === 'diff' ? { anchorSource: parsed.source } : {}), ...(changes ? { changes } : {}),
            ...linkView, ...(view ? { view } : {}),
            ...(fileView.blame === undefined ? {} : { blame: fileView.blame }),
        };
    }

    if (activeTab.kind === 'commit') {
        const rawSha = typeof resource?.sha === 'string'
            ? resource.sha
            : typeof resource?.commitHash === 'string'
                ? resource.commitHash
                : '';
        const sha = rawSha.trim().split(/\s+/)[0] ?? '';
        return sha ? { kind: 'commit', sha } : null;
    }

    if (activeTab.key === SESSION_DETAILS_SCM_REVIEW_TAB_KEY || activeTab.kind === 'scmReview') {
        return { kind: 'scmReview', ...readSessionScmReviewTarget(activeTab.resource) };
    }
    if (activeTab.key === SESSION_DETAILS_SCM_STASH_TAB_KEY || activeTab.kind === 'scmStash') {
        return { kind: 'scmStash' };
    }
    if (activeTab.key === SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY || activeTab.kind === 'scmPullRequest') {
        return { kind: 'scmPullRequest' };
    }
    if (isTerminalDetailsTab({ resource: activeTab.resource, tabKey: activeTab.key })) {
        const terminalInstanceId = resolveTerminalDetailsInstanceId({
            resource: activeTab.resource,
            tabKey: activeTab.key,
        });
        return terminalInstanceId && terminalInstanceId !== SESSION_PRIMARY_TERMINAL_INSTANCE_ID
            ? { kind: 'terminal', terminalInstanceId }
            : { kind: 'terminal' };
    }
    if (activeTab.kind === 'discussion') {
        const target = resource?.target as { kind?: unknown; discussionId?: unknown } | null | undefined;
        const discussionId = target?.kind === 'discussion' && typeof target.discussionId === 'string'
            ? target.discussionId.trim() : '';
        return discussionId ? { kind: 'discussion', discussionId } : null;
    }
    if (activeTab.kind === 'board') {
        const target = resource?.focusTarget as { kind?: unknown; itemId?: unknown } | null | undefined;
        const focusTarget = target?.kind === 'item' && typeof target.itemId === 'string'
            ? { kind: 'item' as const, itemId: target.itemId } : undefined;
        return { kind: 'board', ...(focusTarget ? { focusTarget } : {}) };
    }
    const computerScreen = readComputerScreenSessionSurfaceResource(activeTab.resource);
    return computerScreen ? { kind: 'computerScreen', machineId: computerScreen.machineId } : null;
}

export function buildActiveDetailsRouteParams(
    detailsTabs: readonly unknown[],
    activeDetailsKey: string | null,
    tabState?: Readonly<Record<string, unknown>>,
): Record<string, string> {
    const details = readActiveDetailsUrlTarget(detailsTabs, activeDetailsKey, tabState);
    return details ? serializeSessionPaneUrlState({ details }) : {};
}

export function deriveSessionPaneUrlStateFromScopeState(scopeState: PaneScopeStateLike | null): SessionPaneUrlState | null {
    if (!scopeState) return null;
    const details = scopeState.details.isOpen && scopeState.details.activeTabKey
        ? readActiveDetailsUrlTarget(scopeState.details.tabs, scopeState.details.activeTabKey, scopeState.details.tabState)
        : null;
    // Retained sidebars are not a substitute destination for a Details tab the URL cannot name.
    if (scopeState.details.isOpen && scopeState.details.activeTabKey && !details) return null;

    const rightTabId =
        scopeState.right.isOpen
            ? RIGHT_SIDEBAR_BUILTIN_TABS.find((tab) => tab.id === scopeState.right.activeTabId && tab.scopes.includes('session'))?.id ?? null
            : null;
    const bottomTabId =
        scopeState.bottom.isOpen && scopeState.bottom.activeTabId === 'terminal'
            ? scopeState.bottom.activeTabId
            : null;

    if (!rightTabId && !bottomTabId && !details) return null;
    return {
        ...(rightTabId ? { rightTabId } : null),
        ...(bottomTabId ? { bottomTabId } : null),
        ...(details ? { details } : null),
    };
}

/** Constructs the existing surface model without selecting a tab in shared pane state. */
export function createSessionPaneDetailsTab(
    target: SessionPaneUrlDetailsTarget,
    address?: SessionAddress | null,
): DetailsTabState | null {
    let tab: DetailsTab | null = null;
    switch (target.kind) {
        case 'file': {
            const path = target.path;
            if (isSafeWorkspaceRelativePath(path)) {
                const file = createWorkspaceFileDetailsTab(path, target.anchor, target.anchorSource, {
                    ...(target.rootPath ? { rootPath: target.rootPath } : {}),
                    ...(target.view ? { view: target.view } : {}),
                    ...(target.blame === undefined ? {} : { blame: target.blame }),
                    ...(target.openAs ? { openAs: target.openAs } : {}),
                });
                tab = target.changes ? { ...file, resource: { ...file.resource, changes: target.changes } } : file;
            }
            break;
        }
        case 'commit':
            tab = createSessionCommitDetailsTab(target.sha);
            break;
        case 'scmReview':
            tab = createSessionScmReviewDetailsTab({
                ...(target.comparison ? { comparison: target.comparison } : null),
                ...(target.view ? { view: target.view } : null),
                ...(typeof target.explain === 'boolean' ? { explain: target.explain } : null),
                ...(target.evidenceSessionId ? { evidenceSessionId: target.evidenceSessionId } : null),
            });
            break;
        case 'scmStash':
            tab = createSessionScmStashDetailsTab();
            break;
        case 'scmPullRequest':
            tab = createSessionScmPullRequestDetailsTab();
            break;
        case 'terminal': {
            const terminalInstanceId = target.terminalInstanceId?.trim();
            tab = terminalInstanceId
                ? createSessionDetailsTerminalTab({ terminalInstanceId })
                : createPrimarySessionDetailsTerminalTab();
            break;
        }
        case 'discussion':
            if (address) tab = createSessionDiscussionDetailsTab({ kind: 'discussion', address, discussionId: target.discussionId });
            break;
        case 'board':
            tab = createSessionBoardDetailsTab(target.focusTarget);
            break;
        case 'computerScreen':
            tab = createComputerScreenDetailsTab({ machineId: target.machineId, title: t('computerUse.presentation.tabFallback') });
            break;
    }
    return tab ? { ...tab, isPinned: true, isPreview: false } : null;
}

export function applySessionPaneUrlState(
    pane: Readonly<{
        openRight: AppPaneScopeApi['openRight'];
        openBottom: (options?: Readonly<{ tabId?: string }>) => void;
        setBottomTab: (tabId: string) => void;
        openDetailsTab: AppPaneScopeApi['openDetailsTab'];
    }>,
    state: SessionPaneUrlState,
    address?: SessionAddress | null,
): void {
    if (state.rightTabId) {
        pane.openRight({ tabId: state.rightTabId, present: false });
    }
    if (state.bottomTabId) {
        pane.openBottom({ tabId: state.bottomTabId });
        pane.setBottomTab(state.bottomTabId);
    }

    if (!state.details) return;
    const constructed = createSessionPaneDetailsTab(state.details, address);
    if (!constructed) return;
    const { isPinned: _isPinned, isPreview: _isPreview, ...tab } = constructed;
    if (state.details.kind === 'file' || state.details.kind === 'commit' || state.details.kind === 'discussion') {
        pane.openDetailsTab(tab, { present: false, ...(state.details.kind === 'file' && state.details.openAs ? { intent: state.details.openAs } : {}) });
    } else {
        pane.openDetailsTab(tab, { intent: 'pinned', present: false });
    }
}

export function reconcileSessionPaneScopeFromUrlState(
    pane: Readonly<{
        openRight: AppPaneScopeApi['openRight'];
        closeRight: () => void;
        openBottom: (options?: Readonly<{ tabId?: string }>) => void;
        closeBottom: () => void;
        setBottomTab: (tabId: string) => void;
        openDetailsTab: AppPaneScopeApi['openDetailsTab'];
        closeDetails: () => void;
    }>,
    state: SessionPaneUrlState | null,
    address?: SessionAddress | null,
): void {
    if (state?.rightTabId) {
        pane.openRight({ tabId: state.rightTabId, present: false });
    } else {
        pane.closeRight();
    }

    if (state?.bottomTabId) {
        pane.openBottom({ tabId: state.bottomTabId });
        pane.setBottomTab(state.bottomTabId);
    } else {
        pane.closeBottom();
    }

    if (state?.details) {
        applySessionPaneUrlState(pane, { details: state.details }, address);
    } else {
        pane.closeDetails();
    }
}

/**
 * The link to one Session details destination (`/session/<id>/details?…`): the page a phone pushes and
 * the destination a workspace tab opens, carrying the same params a pane link does.
 */
export function buildSessionDetailsHref(input: Readonly<{
    sessionId: string;
    serverId?: string | null;
    details: SessionPaneUrlDetailsTarget;
}>): string {
    const query = new URLSearchParams();
    if (input.serverId) query.set('serverId', input.serverId);
    for (const [key, value] of Object.entries(serializeSessionPaneUrlState({ details: input.details }))) {
        query.set(key, value);
    }
    return `/session/${encodeURIComponent(input.sessionId)}/details?${query.toString()}`;
}
