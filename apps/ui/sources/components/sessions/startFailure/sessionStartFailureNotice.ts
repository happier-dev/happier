import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { presentSessionStartupFailureCause, presentSessionStartupFailureRecovery } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';

export type SessionStartFailureNotice = Readonly<{
    code: string;
    /** The localized cause and recovery step for the closed startup failure. */
    message: string;
    retryable: boolean;
    /** The stored issue the notice states; its raw cause stays one press away under the notice. */
    issue: SessionRuntimeIssueV1;
}>;

/**
 * A Session that never reached a running runtime keeps the closed startup cause on its primary issue.
 * Only those causes explain "couldn't start"; a failure after a successful start (usage limits,
 * session errors) belongs to its own recovery surface.
 */
export function resolveSessionStartFailureNotice(input: Readonly<{
    issue: SessionRuntimeIssueV1 | null | undefined;
    sessionActive: boolean;
}>): SessionStartFailureNotice | null {
    const { issue } = input;
    if (input.sessionActive || !issue || issue.scope !== 'primary_session' || issue.status !== 'failed') return null;
    const message = presentSessionStartupFailureRecovery([issue.code])?.message ?? presentSessionStartupFailureCause(issue.code, issue);
    return message === null ? null : {
        code: issue.code,
        message,
        retryable: issue.code !== 'codex_refresh_free_auth_unsupported' && issue.code !== 'plugin_disabled'
            && issue.failureCause?.failureReason !== 'model_selection_required',
        issue,
    };
}

/**
 * The notice is the one voice for a start that failed: the transcript row the host committed for that
 * same failure defers to it while it is shown, and reads as history once the Session recovers.
 */
export function isRuntimeIssueStatedByStartFailureNotice(
    rowIssue: Pick<SessionRuntimeIssueV1, 'code' | 'occurredAt'>,
    input: Parameters<typeof resolveSessionStartFailureNotice>[0],
): boolean {
    const notice = resolveSessionStartFailureNotice(input);
    return notice !== null && notice.issue.code === rowIssue.code && notice.issue.occurredAt === rowIssue.occurredAt;
}
