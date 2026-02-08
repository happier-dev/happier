/** Common fields shared by all elicitation requests */
interface CodexElicitationBase {
    message: string;
    codex_elicitation: 'exec-approval' | 'patch-approval';
    codex_mcp_tool_call_id: string;
    codex_event_id: string;
    codex_call_id: string;
}

/** Exec approval request params (command execution) */
interface ExecApprovalParams extends CodexElicitationBase {
    codex_elicitation: 'exec-approval';
    codex_command: string[];
    codex_cwd: string;
    codex_parsed_cmd?: Array<{ cmd: string; args?: string[] }>;
}

/** Patch approval request params (code changes) */
interface PatchApprovalParams extends CodexElicitationBase {
    codex_elicitation: 'patch-approval';
    codex_reason?: string;
    codex_grant_root?: string;
    codex_changes: Record<string, unknown>;
}

export type CodexElicitationParams = ExecApprovalParams | PatchApprovalParams;
export type ElicitationAction = 'accept' | 'decline' | 'cancel';

export type ExecpolicyAmendmentDecision = {
    approved_execpolicy_amendment: {
        proposed_execpolicy_amendment: string[];
    };
};

export type ReviewDecision =
    | 'approved'
    | 'approved_for_session'
    | 'denied'
    | 'abort'
    | ExecpolicyAmendmentDecision;

export function getCodexElicitationToolCallId(params: Record<string, unknown>): string | undefined {
    const callId = params.codex_call_id;
    if (typeof callId === 'string') {
        return callId;
    }

    const mcpToolCallId = params.codex_mcp_tool_call_id;
    if (typeof mcpToolCallId === 'string') {
        return mcpToolCallId;
    }

    return undefined;
}

export function getCodexEventToolCallId(msg: Record<string, unknown>): string | undefined {
    const callId = msg.call_id ?? msg.codex_call_id;
    if (typeof callId === 'string') {
        return callId;
    }

    const mcpToolCallId = msg.mcp_tool_call_id ?? msg.codex_mcp_tool_call_id;
    if (typeof mcpToolCallId === 'string') {
        return mcpToolCallId;
    }

    return undefined;
}

export function isExecpolicyAmendmentDecision(
    decision: ReviewDecision
): decision is ExecpolicyAmendmentDecision {
    return typeof decision === 'object'
        && decision !== null
        && 'approved_execpolicy_amendment' in decision;
}
