import { createSessionDetailsTerminalTab } from '@/components/sessions/terminal/embeddedTerminalDocking';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { t } from '@/text';
import { SCM_COMPARISON_VIEWS, type ScmComparisonView } from '@happier-dev/protocol/scm';
import type { DiscussionAnchorV1 } from '@happier-dev/protocol/discussions/replyTargets';

export const SESSION_DETAILS_SCM_REVIEW_TAB_KEY = 'scmReview:working';
export const SESSION_DETAILS_SCM_STASH_TAB_KEY = 'scmStash';
export const SESSION_DETAILS_SCM_PULL_REQUEST_TAB_KEY = 'scmPullRequest';
export const SESSION_DETAILS_BOARD_TAB_KEY = 'board';

export type SessionBoardDetailsFocusTarget = Readonly<{
    kind: 'item';
    itemId: string;
}>;

export type SessionDiscussionDetailsTarget =
    | Readonly<{ kind: 'new'; address: SessionAddress; draftId?: string; anchor?: DiscussionAnchorV1 }>
    | Readonly<{ kind: 'discussion'; address: SessionAddress; discussionId: string; messageId?: string }>;

export function createSessionDiscussionDetailsTab(
    target: SessionDiscussionDetailsTarget & Readonly<{ title?: string | null }>,
) {
    const targetKey = target.kind === 'new' ? target.draftId ? `new:${target.draftId}` : 'new' : target.discussionId;
    return {
        key: `discussion:${sessionAddressKey(target.address)}:${targetKey}`,
        kind: 'discussion' as const,
        title: target.kind === 'new'
            ? t('session.collaboration.discussion.newDiscussion')
            : target.title?.trim() || t('session.collaboration.discussion.title'),
        resource: {
            kind: 'discussion' as const,
            target: target.kind === 'new'
                ? { kind: 'new' as const, address: target.address,
                    ...(target.draftId ? { draftId: target.draftId } : {}), ...(target.anchor ? { anchor: target.anchor } : {}) }
                : {
                    kind: 'discussion' as const,
                    address: target.address,
                    discussionId: target.discussionId,
                    ...(target.messageId ? { messageId: target.messageId } : {}),
                },
        },
    };
}

/** Lab T3: Second opinion / Discuss… beside the transcript. The request itself stays in memory (see the opener). */
export function createSessionSecondOpinionDetailsTab(input: Readonly<{
    address: SessionAddress;
    requestId: string;
    intent: 'second_opinion' | 'discuss';
}>) {
    return {
        key: `secondOpinion:${sessionAddressKey(input.address)}:${input.requestId}`,
        kind: 'secondOpinion' as const,
        title: input.intent === 'discuss'
            ? t('session.collaboration.discussion.secondOpinion.discussTitle')
            : t('session.collaboration.discussion.secondOpinion.title'),
        resource: { kind: 'secondOpinion' as const, address: input.address, requestId: input.requestId, intent: input.intent },
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
export type SessionScmReviewView = ScmComparisonView;
export const SESSION_SCM_REVIEW_VIEWS = SCM_COMPARISON_VIEWS;

export type SessionScmReviewTarget = Readonly<{
    comparison?: SessionScmReviewComparison;
    view?: SessionScmReviewView;
    explain?: boolean;
    /** Selected evidence identity; the workspace adapter still admits its Home and checkout. */
    evidenceSessionId?: string;
}>;

export function resolveSessionScmReviewComparisonLabel(comparison: SessionScmReviewComparison): string {
    switch (comparison.kind) {
        case 'workingTree': return t('scmComparison.scope.workingTree');
        case 'session': return t('scmComparison.scope.session');
        case 'turnCheckpoint': return t('scmComparison.scope.turn');
        case 'branch': return t('scmComparison.scope.branch', { head: comparison.head, base: comparison.base });
        case 'commit': return t('scmComparison.scope.commit', { commit: comparison.commit.slice(0, 7) });
        case 'revisionRange': return `${comparison.baseOid.slice(0, 7)} → ${comparison.headOid.slice(0, 7)}`;
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
            ...(target.evidenceSessionId ? { evidenceSessionId: target.evidenceSessionId } : {}),
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
