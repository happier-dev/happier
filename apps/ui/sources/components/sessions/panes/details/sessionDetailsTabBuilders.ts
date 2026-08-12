import { createSessionDetailsTerminalTab } from '@/components/sessions/terminal/embeddedTerminalDocking';
import type { TranscriptJumpScope } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import { t } from '@/text';

import {
    resolveSessionTranscriptDetailsTabKey,
    type SessionTranscriptDetailsTab,
} from './sessionTranscriptDetailsResource';

export const SESSION_DETAILS_SCM_REVIEW_TAB_KEY = 'scmReview:working';
export const SESSION_DETAILS_SCM_STASH_TAB_KEY = 'scmStash';

export function createSessionFileDetailsTab(fullPath: string) {
    const fileName = fullPath.split('/').pop() ?? fullPath;
    return {
        key: `file:${fullPath}`,
        kind: 'file' as const,
        title: fileName,
        resource: { kind: 'file' as const, path: fullPath },
    };
}

export function createSessionCommitDetailsTab(sha: string) {
    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
    if (!safeSha) return null;

    return {
        key: `commit:${safeSha}`,
        kind: 'commit' as const,
        title: safeSha.slice(0, 7),
        resource: { kind: 'commit' as const, sha: safeSha },
    };
}

export function createSessionScmReviewDetailsTab() {
    return {
        key: SESSION_DETAILS_SCM_REVIEW_TAB_KEY,
        kind: 'scmReview' as const,
        title: t('files.toolbar.review'),
        resource: { kind: 'scmReview' as const, scope: 'working' as const },
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

/**
 * A transcript details tab, built the way the subagent one is: the key is derived from the thing
 * being opened, so pressing "open details" twice reuses one tab instead of stacking duplicates.
 *
 * The title falls back to the shared unnamed-agent string rather than to a blank label — an
 * imported sidecar can arrive before its agent is named, and a tab with no name is unfindable.
 */
export function createSessionTranscriptDetailsTab(params: Readonly<{
    scope: TranscriptJumpScope;
    title?: string | null;
}>): SessionTranscriptDetailsTab {
    const title = params.title?.trim();
    return {
        key: resolveSessionTranscriptDetailsTabKey(params.scope),
        kind: 'transcript' as const,
        title: title && title.length > 0 ? title : t('session.agentActivity.untitled'),
        resource: {
            kind: 'transcript' as const,
            scope: params.scope,
            ...(title && title.length > 0 ? { title } : null),
        },
    };
}

export { createSessionDetailsTerminalTab };
