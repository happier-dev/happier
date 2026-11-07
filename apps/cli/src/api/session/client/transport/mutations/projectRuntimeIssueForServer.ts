import {
    readSessionStartupFailurePreview,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

/** Native diagnostics remain in the private projection, never in E2EE Account Home state. */
export function projectRuntimeIssueForServer(issue: SessionRuntimeIssueV1): SessionRuntimeIssueV1 {
    const staticPreview = readSessionStartupFailurePreview(issue.code) ?? 'Session runtime failed';
    if (!issue.agentProcessExitAfterSwitch && !issue.failureCause?.providerErrorMessage
        && (!issue.sanitizedPreview || issue.sanitizedPreview === staticPreview)) return issue;
    const { agentProcessExitAfterSwitch: _nativeExit, failureCause, ...publicIssue } = issue;
    const projected = {
        ...publicIssue,
        ...(issue.sanitizedPreview ? { sanitizedPreview: staticPreview } : {}),
    };
    if (!failureCause) return projected;
    const { providerErrorMessage: _nativeMessage, ...publicCause } = failureCause;
    return { ...projected, failureCause: publicCause };
}
