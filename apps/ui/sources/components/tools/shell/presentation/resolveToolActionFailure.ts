import type { ToolCall } from '@happier-dev/session-core/messages';
import { readHappierActionToolFailure } from '@happier-dev/protocol/actions/happierActionToolResult';
import type { ActionCurrentSessionScopeFailureDetailsV1 } from '@happier-dev/protocol/actions/executor/sessionListAccess';

import { t } from '@/text';
import { formatApprovalDecisionFailureLabel } from '@/components/approvals/approvalStatusLabel';

export type ToolActionOutcome = 'refused' | 'failed';

export type ToolActionFailurePresentation = Readonly<{
    outcome: ToolActionOutcome;
    /** The typed failure code, kept for the open row; never shown as the cause line. */
    code: string;
    cause: string | null;
    /** A short human cause when the typed result names one the product can say in words. */
    summary: string | null;
    /** The executor's own words for the failure ("Timed out after 120000ms"), when it gave any. */
    message: string | null;
}>;

/** The Action vocabulary's policy, permission and authority denials: the call was not allowed, it did not break. */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
    'unsupported_action', 'permission_denied', 'credential_scope_denied', 'action_disabled', 'present_user_required',
    'approval_rejected', 'approval_canceled', 'subtree_denied', 'policy_denied_field', 'target_declined', 'denied', 'workspace_write_denied',
    'run_access_denied', 'review_comment_permission_denied',
    'codex_tool_restriction_unsupported_auth',
]);
const REFUSAL_CAUSES: ReadonlySet<string> = new Set(['external_authorization_refused']);

type ScopeCause = ActionCurrentSessionScopeFailureDetailsV1['cause'];
const SCOPE_CAUSE_KIND: Readonly<Record<ScopeCause, 'outside' | 'unverified'>> = {
    target_outside_led_subtree: 'outside',
    current_session_only: 'outside',
    action_scope_restricted: 'outside',
    default_session_unavailable: 'unverified',
    session_scope_unavailable: 'unverified',
    caller_context_unavailable: 'unverified',
    caller_identity_mismatch: 'unverified',
    subtree_observation_unavailable: 'unverified',
};

function resolveCauseSummary(cause: string | null): string | null {
    if (cause === null) return null;
    if (cause === 'machine_manage_required') return t('toolView.actionOutcome.cause.machineManageRequired');
    if (cause === 'external_authorization_refused') return t('toolView.actionOutcome.cause.authorizationRefused');
    const scope = Object.hasOwn(SCOPE_CAUSE_KIND, cause) ? SCOPE_CAUSE_KIND[cause as ScopeCause] : null;
    if (scope === 'outside') return t('toolView.actionOutcome.cause.outsideAgentSessions');
    if (scope === 'unverified') return t('toolView.actionOutcome.cause.unverifiedAgentAccess');
    return null;
}

export function toolActionOutcomeLabel(outcome: ToolActionOutcome, code?: string): string {
    const decision = code ? formatApprovalDecisionFailureLabel(code) : null;
    if (decision) return decision;
    return outcome === 'refused' ? t('toolView.actionOutcome.refused') : t('toolView.actionOutcome.failed');
}

/**
 * How a first-party Happier Action call that returned a typed failure reads in the transcript:
 * refused (policy, permission or authority said no) or failed (it could not be done), with the
 * cause in words when the typed result names one. Null for every other call.
 */
export function resolveToolActionFailure(tool: ToolCall): ToolActionFailurePresentation | null {
    const failure = readHappierActionToolFailure(tool.name, tool.input, tool.result);
    if (!failure) return null;
    const refused = REFUSAL_CODES.has(failure.code) || (failure.cause !== null && REFUSAL_CAUSES.has(failure.cause));
    return {
        outcome: refused ? 'refused' : 'failed',
        code: failure.code,
        cause: failure.cause,
        message: failure.message,
        summary: formatApprovalDecisionFailureLabel(failure.code) ?? (failure.code === 'codex_tool_restriction_unsupported_auth'
            ? t('toolView.actionOutcome.cause.toolPolicyUnsupportedAuth') : resolveCauseSummary(failure.cause)),
    };
}
