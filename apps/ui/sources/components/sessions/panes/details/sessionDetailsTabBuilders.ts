import { createSessionDetailsTerminalTab } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

export const SESSION_DETAILS_SCM_REVIEW_TAB_KEY = 'scmReview:working';
export const SESSION_DETAILS_SCM_STASH_TAB_KEY = 'scmStash';
export const SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY = 'scmPullRequest';
export const SESSION_DETAILS_BOARD_TAB_KEY = 'board';

export type SessionBoardDetailsFocusTarget = Readonly<{
    kind: 'item';
    itemId: string;
}>;

export type SessionDiscussionDetailsTarget =
    | Readonly<{ kind: 'new'; address: SessionAddress }>
    | Readonly<{ kind: 'discussion'; address: SessionAddress; discussionId: string }>;

export function createSessionDiscussionDetailsTab(
    target: SessionDiscussionDetailsTarget & Readonly<{ title?: string | null }>,
) {
    const targetKey = target.kind === 'new' ? 'new' : target.discussionId;
    return {
        key: `discussion:${sessionAddressKey(target.address)}:${targetKey}`,
        kind: 'discussion' as const,
        title: target.kind === 'new'
            ? t('session.collaboration.discussion.newDiscussion')
            : target.title?.trim() || t('session.collaboration.discussion.title'),
        resource: {
            kind: 'discussion' as const,
            target: target.kind === 'new'
                ? { kind: 'new' as const, address: target.address }
                : {
                    kind: 'discussion' as const,
                    address: target.address,
                    discussionId: target.discussionId,
                },
        },
    };
}

/**
 * The Board destination, and — with an item — that item's own expanded
 * destination. They must not share a key: a single `board` tab instance would make
 * the second "Open in Details" reuse the first tab and silently drop its itemId.
 */
export function createSessionBoardDetailsTab(focusTarget?: SessionBoardDetailsFocusTarget) {
    const itemId = focusTarget?.kind === 'item' ? focusTarget.itemId.trim() : '';
    return {
        key: itemId ? `${SESSION_DETAILS_BOARD_TAB_KEY}:${itemId}` : SESSION_DETAILS_BOARD_TAB_KEY,
        kind: 'board' as const,
        title: t('sessionBoard.title'),
        resource: {
            kind: 'board' as const,
            ...(itemId ? { focusTarget: { kind: 'item' as const, itemId } } : {}),
        },
    };
}

export function createSessionFileDetailsTab(fullPath: string, anchor?: FileTargetAnchor, anchorSource?: ReviewCommentSource) {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        key: `file:${fullPath}`,
        kind: 'file' as const,
        title: fileName,
        resource: { kind: 'file' as const, path: fullPath, ...(anchor ? { anchor } : {}), ...(anchorSource ? { anchorSource } : {}) },
    };
}

export function createSessionCommitDetailsTab(sha: string) {
    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
    if (!safeSha) {
        return null;
    }
    return {
        key: `commit:${safeSha}`,
        kind: 'commit' as const,
        title: safeSha.slice(0, 7),
        resource: { kind: 'commit' as const, sha: safeSha },
    };
}

/**
 * Which code the review destination compares (Walkthrough lab WT6-E2). Selectors only: the host
 * captures the exact endpoints. A link without one opens the destination's default comparison.
 */
export type SessionScmReviewComparison = import('@/sync/domains/scm/diffSummary/selection').ScmReviewComparisonSelector;

export type SessionScmReviewTurnEvidence = 'agent_reported' | 'checkpoint';

/** The views of one comparison: Files, Walkthrough, and Commits (pending changes only). */
export type SessionScmReviewView = 'files' | 'walkthrough' | 'commits';
export const SESSION_SCM_REVIEW_VIEWS: readonly SessionScmReviewView[] = ['files', 'walkthrough', 'commits'];

export type SessionScmReviewTarget = Readonly<{
    comparison?: SessionScmReviewComparison;
    view?: SessionScmReviewView;
    explain?: boolean;
}>;

export function resolveSessionScmReviewComparisonLabel(comparison: SessionScmReviewComparison): string {
    switch (comparison.kind) {
        case 'workingTree': return t('scmComparison.scope.workingTree');
        case 'session': return t('scmComparison.scope.session');
        case 'turnCheckpoint': return t('scmComparison.scope.turn');
        case 'branch': return t('scmComparison.scope.branch', { head: comparison.head, base: comparison.base });
        case 'commit': return t('scmComparison.scope.commit', { commit: comparison.commit.slice(0, 7) });
        case 'pullRequest': return `${comparison.locator.repository} #${comparison.locator.number}`;
    }
}

export function resolveSessionScmReviewViewLabel(view: SessionScmReviewView): string {
    switch (view) {
        case 'files': return t('scmComparison.view.files');
        case 'walkthrough': return t('scmComparison.view.walkthrough');
        case 'commits': return t('scmComparison.view.commits');
    }
}

/**
 * One review destination per Session: choosing another comparison or view updates this tab in place
 * (same key), so its scroll and folded files stay with it. Its title says what it shows.
 */
export function createSessionScmReviewDetailsTab(target: SessionScmReviewTarget = {}) {
    const comparison = target.comparison;
    const view = target.view;
    return {
        key: SESSION_DETAILS_SCM_REVIEW_TAB_KEY,
        kind: 'scmReview' as const,
        title: comparison
            ? t('scmComparison.tabTitle', {
                view: resolveSessionScmReviewViewLabel(view ?? 'files'),
                scope: resolveSessionScmReviewComparisonLabel(comparison),
            })
            : t('files.toolbar.review'),
        resource: {
            kind: 'scmReview' as const,
            scope: 'working' as const,
            ...(comparison ? { comparison } : {}),
            ...(view ? { view } : {}),
            ...(typeof target.explain === 'boolean' ? { explain: target.explain } : {}),
        },
    };
}

export function createSessionScmStashDetailsTab() {
    return {
        key: SESSION_DETAILS_SCM_STASH_TAB_KEY,
        kind: 'scmStash' as const,
        title: t('files.stash.detailsTitle'),
        resource: { kind: 'scmStash' as const },
    };
}

/** The session's new pull request form, moved out of the Git sidebar (Git lab PRD). One per session. */
export function createSessionScmPullRequestDetailsTab() {
    return {
        key: SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY,
        kind: 'scmPullRequest' as const,
        title: t('sessionGitPullRequest.form.title'),
        resource: { kind: 'scmPullRequest' as const },
    };
}

export { createSessionDetailsTerminalTab };
