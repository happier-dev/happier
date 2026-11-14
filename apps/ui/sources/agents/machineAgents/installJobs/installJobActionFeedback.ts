import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { Modal } from '@/modal';

import { AgentInstallJobRpcError } from './api';
import { presentAgentInstallJobRpcFailure } from './presentAgentInstallJobFailure';

/** Typed Action refusals resolve normally; mounted install controls must still show them. */
export async function withAgentInstallJobFailureFeedback(
    request: Promise<ActionExecuteResult>,
    isCurrent: () => boolean,
): Promise<ActionExecuteResult> {
    const report = (error: unknown) => {
        if (!isCurrent()) return;
        if (error instanceof AgentInstallJobRpcError && (
            isActionApprovalDeclinedErrorCode(error.code)
            || error.code === 'cancelled' || error.code === 'scope_retired'
            || error.code === 'action_account_scope_changed'
        )) return;
        const failure = presentAgentInstallJobRpcFailure(error);
        Modal.alert(failure.title, failure.body);
    };
    try {
        const result = await request;
        if (!result.ok) report(new AgentInstallJobRpcError(result.errorCode));
        return result;
    } catch (error) {
        report(error);
        throw error;
    }
}
