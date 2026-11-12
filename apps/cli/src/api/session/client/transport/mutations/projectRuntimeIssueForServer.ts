import {
    readSessionRuntimeIssueNativeAuthAgentId,
    readSessionStartupFailurePreview,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { createProviderErrorV1, ProviderErrorCodeV1Schema } from '@happier-dev/protocol/providers/errors';

import { SESSION_RUNTIME_ISSUE_PREVIEW_BY_SOURCE } from '@/agent/runtime/session/errors/sessionRuntimeIssuePreview';
import { presentProviderCliRefusal } from '@/providers/lifecycle/presentProviderCliRefusal';

/** Native diagnostics remain in the private projection, never in E2EE Account Home state. */
export function projectRuntimeIssueForServer(issue: SessionRuntimeIssueV1): SessionRuntimeIssueV1 {
    const providerCode = ProviderErrorCodeV1Schema.safeParse(issue.code);
    const providerCause = providerCode.success ? providerCode : ProviderErrorCodeV1Schema.safeParse(issue.failureCause?.code);
    // Rebuild only the closed code's presentation: no native prose or binding context crosses this boundary.
    const staticPreview = readSessionStartupFailurePreview(issue.code, null, issue.failureCause)
        ?? (readSessionRuntimeIssueNativeAuthAgentId(issue) ? SESSION_RUNTIME_ISSUE_PREVIEW_BY_SOURCE.auth_error : null)
        ?? (providerCause.success ? presentProviderCliRefusal(createProviderErrorV1(providerCause.data)).slice(0, 2).join(' ') : null)
        ?? SESSION_RUNTIME_ISSUE_PREVIEW_BY_SOURCE[issue.source];
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
