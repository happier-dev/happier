import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import { presentSessionStartupFailureCause } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';

export type SessionStartFailureNotice = Readonly<{
    code: string;
    /** The localized cause and recovery step for the closed startup failure. */
    message: string;
    retryable?: boolean;
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
    const message = presentSessionStartupFailureCause(issue.code);
    return message === null ? null : { code: issue.code, message, retryable: issue.code !== 'plugin_disabled' };
}
