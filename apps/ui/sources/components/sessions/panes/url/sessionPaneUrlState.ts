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
    createSessionFileDetailsTab,
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
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { DetailsTab, DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

export type SessionPaneUrlDetailsTarget =
    | Readonly<{ kind: 'file'; path: string }>
    | Readonly<{ kind: 'commit'; sha: string }>
    | (Readonly<{ kind: 'scmReview' }> & SessionScmReviewTarget)
    | Readonly<{ kind: 'scmStash' }>
    | Readonly<{ kind: 'scmPullRequest' }>
    | Readonly<{ kind: 'terminal'; terminalInstanceId?: string }>
    | Readonly<{ kind: 'discussion'; discussionId: string }>
    | Readonly<{ kind: 'board'; focusTarget?: SessionBoardDetailsFocusTarget }>;

/**
 * Every param a Session pane link can carry. The pane-link sync, the browser history push and the
 * route all read this one list, so a target's extra params (a review comparison) survive reload/back.
 */
export const SESSION_PANE_URL_PARAM_KEYS = [
    'right', 'bottom', 'details', 'path', 'sha', 'terminalInstanceId', 'discussionId',
    'comparison', 'comparisonId', 'turnId', 'checkpointReceiptId', 'evidence', 'head', 'base', 'commit', 'parent', 'view', 'pullRequest',
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
    details: Readonly<{ isOpen: boolean; tabs: ReadonlyArray<Readonly<{ key: string; kind: string; resource: unknown }>>; activeTabKey: string | null }>;
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
    return {
        ...(comparison ? { comparison: comparisonId ? { ...comparison, comparisonId } : comparison } : null),
        ...(view ? { view } : null),
    };
}

function serializeScmReviewTarget(target: SessionScmReviewTarget): Record<string, string> {
    const out: Record<string, string> = {};
    const comparison = target.comparison;
    if (comparison) {
        out.comparison = comparison.kind;
        if (comparison.comparisonId) out.comparisonId = comparison.comparisonId;
        if (comparison.kind === 'turnCheckpoint') {
            if (comparison.turnId) out.turnId = comparison.turnId;
            if (comparison.checkpointReceiptId) out.checkpointReceiptId = comparison.checkpointReceiptId;
            if (comparison.evidence) out.evidence = comparison.evidence;
        }
        if (comparison.kind === 'branch') {
            out.head = comparison.head;
            out.base = comparison.base;
        }
        if (comparison.kind === 'commit') {
            out.commit = comparison.commit;
            if (comparison.parent) out.parent = comparison.parent;
        }
        if (comparison.kind === 'pullRequest') out.pullRequest = JSON.stringify(comparison.locator);
    }
    if (target.view) out.view = target.view;
    return out;
}

/** A stored tab's comparison and view, validated by the same reader a link goes through. */
export function readSessionScmReviewTarget(resource: unknown): SessionScmReviewTarget {
    const record = resource && typeof resource === 'object' ? resource as { comparison?: unknown; view?: unknown } : {};
    const comparison = record.comparison && typeof record.comparison === 'object' ? record.comparison as SessionScmReviewComparison : undefined;
    const view = typeof record.view === 'string' ? record.view as SessionScmReviewView : undefined;
    return parseScmReviewTarget(serializeScmReviewTarget({
        ...(comparison ? { comparison } : null),
        ...(view ? { view } : null),
    }));
}

export function parseSessionPaneUrlState(params: Readonly<Record<string, unknown>>): SessionPaneUrlState | null {
    const rightRaw = readSingleStringParam(params, 'right')?.trim() ?? '';
    const rightTabId = RIGHT_SIDEBAR_BUILTIN_TABS.find((tab) => tab.id === rightRaw && tab.scopes.includes('session'))?.id ?? null;
    const bottomRaw = readSingleStringParam(params, 'bottom')?.trim() ?? '';
    const bottomTabId = bottomRaw === 'terminal' ? bottomRaw : null;

    const detailsRaw = readSingleStringParam(params, 'details')?.trim() ?? '';
    const pathRaw = readSingleStringParam(params, 'path')?.trim() ?? '';
    const shaRaw = readSingleStringParam(params, 'sha')?.trim() ?? '';
    const terminalInstanceIdRaw = readSingleStringParam(params, 'terminalInstanceId')?.trim() ?? '';
    const discussionIdRaw = readSingleStringParam(params, 'discussionId')?.trim() ?? '';
    const boardItemIdRaw = readSingleStringParam(params, 'boardItemId')?.trim() ?? '';

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (detailsRaw === 'file' && pathRaw && isSafeWorkspaceRelativePath(pathRaw)) {
        details = { kind: 'file', path: pathRaw.trim() };
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
    return out;
}

export function buildActiveDetailsRouteParams(
    detailsTabs: readonly unknown[],
    activeDetailsKey: string | null
): Record<string, string> {
    const activeTab = (detailsTabs as ReadonlyArray<any>).find((tab) => tab?.key === activeDetailsKey)
        ?? (detailsTabs as ReadonlyArray<any>).at(-1)
        ?? null;
    if (!activeTab) return {};

    if (activeTab.kind === 'file') {
        const path = typeof activeTab.resource?.path === 'string' ? activeTab.resource.path.trim() : '';
        if (!path || !isSafeWorkspaceRelativePath(path)) return {};
        return serializeSessionPaneUrlState({ details: { kind: 'file', path } });
    }

    if (activeTab.kind === 'commit') {
        const rawSha = typeof activeTab.resource?.sha === 'string'
            ? activeTab.resource.sha
            : typeof activeTab.resource?.commitHash === 'string'
                ? activeTab.resource.commitHash
                : '';
        const sha = rawSha.trim().split(/\s+/)[0] ?? '';
        if (!sha) return {};
        return serializeSessionPaneUrlState({ details: { kind: 'commit', sha } });
    }

    if (activeTab.key === SESSION_DETAILS_SCM_REVIEW_TAB_KEY || activeTab.kind === 'scmReview') {
        return serializeSessionPaneUrlState({ details: { kind: 'scmReview', ...readSessionScmReviewTarget(activeTab.resource) } });
    }

    if (activeTab.key === SESSION_DETAILS_SCM_STASH_TAB_KEY || activeTab.kind === 'scmStash') {
        return serializeSessionPaneUrlState({ details: { kind: 'scmStash' } });
    }

    if (activeTab.key === SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY || activeTab.kind === 'scmPullRequest') {
        return serializeSessionPaneUrlState({ details: { kind: 'scmPullRequest' } });
    }

    if (isTerminalDetailsTab({ resource: activeTab.resource, tabKey: activeTab.key })) {
        const terminalInstanceId = resolveTerminalDetailsInstanceId({
            resource: activeTab.resource,
            tabKey: activeTab.key,
        });
        return serializeSessionPaneUrlState({
            details: terminalInstanceId && terminalInstanceId !== SESSION_PRIMARY_TERMINAL_INSTANCE_ID
                ? { kind: 'terminal', terminalInstanceId }
                : { kind: 'terminal' },
        });
    }

    if (activeTab.kind === 'discussion') {
        const resource = activeTab.resource as { target?: { kind?: unknown; discussionId?: unknown } } | null;
        const discussionId = resource?.target?.kind === 'discussion'
            && typeof resource.target.discussionId === 'string'
            ? resource.target.discussionId.trim()
            : '';
        if (!discussionId) return {};
        return serializeSessionPaneUrlState({ details: { kind: 'discussion', discussionId } });
    }


    if (activeTab.kind === 'board') {
        const resource = activeTab.resource as { focusTarget?: unknown } | null;
        const target = resource?.focusTarget;
        const focusTarget = target && typeof target === 'object'
            && (target as { kind?: unknown }).kind === 'item'
            && typeof (target as { itemId?: unknown }).itemId === 'string'
            ? { kind: 'item' as const, itemId: (target as { itemId: string }).itemId }
            : undefined;
        return serializeSessionPaneUrlState({ details: { kind: 'board', ...(focusTarget ? { focusTarget } : {}) } });
    }

    return {};
}

export function deriveSessionPaneUrlStateFromScopeState(scopeState: PaneScopeStateLike | null): SessionPaneUrlState | null {
    if (!scopeState) return null;
    const rightTabId =
        scopeState.right.isOpen
            ? RIGHT_SIDEBAR_BUILTIN_TABS.find((tab) => tab.id === scopeState.right.activeTabId && tab.scopes.includes('session'))?.id ?? null
            : null;
    const bottomTabId =
        scopeState.bottom.isOpen && scopeState.bottom.activeTabId === 'terminal'
            ? scopeState.bottom.activeTabId
            : null;

    let details: SessionPaneUrlDetailsTarget | null = null;
    if (scopeState.details.isOpen && scopeState.details.activeTabKey) {
        const tab = scopeState.details.tabs.find((t) => t.key === scopeState.details.activeTabKey) ?? null;
        if (tab?.kind === 'file') {
            const path = (tab.resource as any)?.path;
            if (typeof path === 'string' && path.trim()) {
                const trimmedPath = path.trim();
                if (isSafeWorkspaceRelativePath(trimmedPath)) {
                    details = { kind: 'file', path: trimmedPath };
                }
            }
        } else if (tab?.kind === 'commit') {
            const sha = (tab.resource as any)?.sha;
            if (typeof sha === 'string' && sha.trim()) {
                const safeSha = sha.trim().split(/\s+/)[0] ?? '';
                if (safeSha) {
                    details = { kind: 'commit', sha: safeSha };
                }
            }
        } else if (tab?.key === SESSION_DETAILS_SCM_REVIEW_TAB_KEY || tab?.kind === 'scmReview') {
            details = { kind: 'scmReview', ...readSessionScmReviewTarget(tab.resource) };
        } else if (tab?.key === SESSION_DETAILS_SCM_STASH_TAB_KEY || tab?.kind === 'scmStash') {
            details = { kind: 'scmStash' };
        } else if (tab?.key === SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY || tab?.kind === 'scmPullRequest') {
            details = { kind: 'scmPullRequest' };
        } else if (tab && isTerminalDetailsTab({ resource: tab.resource, tabKey: tab.key })) {
            const terminalInstanceId = resolveTerminalDetailsInstanceId({
                resource: tab.resource,
                tabKey: tab.key,
            });
            details = terminalInstanceId && terminalInstanceId !== SESSION_PRIMARY_TERMINAL_INSTANCE_ID
                ? { kind: 'terminal', terminalInstanceId }
                : { kind: 'terminal' };
        } else if (tab?.kind === 'discussion') {
            const resource = tab.resource as { target?: { kind?: unknown; discussionId?: unknown } } | null;
            const discussionId = resource?.target?.kind === 'discussion'
                && typeof resource.target.discussionId === 'string'
                ? resource.target.discussionId.trim()
                : '';
            if (discussionId) details = { kind: 'discussion', discussionId };
        } else if (tab?.kind === 'board') {
            const resource = tab.resource as { focusTarget?: unknown } | null;
            const target = resource?.focusTarget;
            const focusTarget = target && typeof target === 'object'
                && (target as { kind?: unknown }).kind === 'item'
                && typeof (target as { itemId?: unknown }).itemId === 'string'
                ? { kind: 'item' as const, itemId: (target as { itemId: string }).itemId }
                : undefined;
            details = { kind: 'board', ...(focusTarget ? { focusTarget } : {}) };
        }
    }

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
            const path = target.path.trim();
            if (isSafeWorkspaceRelativePath(path)) tab = createSessionFileDetailsTab(path);
            break;
        }
        case 'commit':
            tab = createSessionCommitDetailsTab(target.sha);
            break;
        case 'scmReview':
            tab = createSessionScmReviewDetailsTab({
                ...(target.comparison ? { comparison: target.comparison } : null),
                ...(target.view ? { view: target.view } : null),
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
    }
    return tab ? { ...tab, isPinned: true, isPreview: false } : null;
}

export function applySessionPaneUrlState(
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        setRightTab: (tabId: string) => void;
        openBottom: (options?: Readonly<{ tabId?: string }>) => void;
        setBottomTab: (tabId: string) => void;
        openDetailsTab: AppPaneScopeApi['openDetailsTab'];
    }>,
    state: SessionPaneUrlState,
    address?: SessionAddress | null,
): void {
    if (state.rightTabId) {
        pane.openRight({ tabId: state.rightTabId });
        pane.setRightTab(state.rightTabId);
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
        pane.openDetailsTab(tab);
    } else {
        pane.openDetailsTab(tab, { intent: 'pinned' });
    }
}

export function reconcileSessionPaneScopeFromUrlState(
    pane: Readonly<{
        openRight: (options?: Readonly<{ tabId?: string }>) => void;
        closeRight: () => void;
        setRightTab: (tabId: string) => void;
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
        pane.openRight({ tabId: state.rightTabId });
        pane.setRightTab(state.rightTabId);
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
