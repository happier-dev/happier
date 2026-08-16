import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpc';

import { t } from '@/text';

export type SessionGoalFailureResult = Readonly<{
    ok: false;
    error: string;
    errorCode?: string;
}>;

export type SessionGoalFailurePresentation = Readonly<{
    title: string;
    message: string;
}>;

const GOAL_CONTROL_NOT_READY_ERROR_CODES: ReadonlySet<string> = new Set([
    'unsupported_session_runtime_method',
    'session_goal_control_remote_unavailable',
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
]);

function isGoalControlNotReadyResult(result: SessionGoalFailureResult): boolean {
    if (result.errorCode && GOAL_CONTROL_NOT_READY_ERROR_CODES.has(result.errorCode)) return true;
    return result.error === 'session_goal_control_remote_unavailable'
        || result.error === RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE
        || result.error === RPC_ERROR_MESSAGES.METHOD_NOT_FOUND
        || result.error.startsWith('unsupported_session_runtime_method:');
}

export function resolveSessionGoalFailurePresentation(
    result: SessionGoalFailureResult,
    options?: Readonly<{ statusOnly?: boolean }>,
): SessionGoalFailurePresentation {
    if (
        options?.statusOnly === true
        && (
            result.errorCode === 'goal_objective_required'
            || result.error === 'goal_objective_required'
            || result.errorCode === 'invalid_parameters'
            || result.error === 'invalid_parameters'
        )
    ) {
        return {
            title: t('session.workState.noCurrentGoalTitle'),
            message: t('session.workState.noCurrentGoalMessage'),
        };
    }
    if (isGoalControlNotReadyResult(result)) {
        return {
            title: t('session.workState.notReadyTitle'),
            message: t('session.workState.notReadyMessage'),
        };
    }
    if (/goals?\s+feature\s+is\s+disabled/i.test(result.error)) {
        return {
            title: t('session.workState.unsupportedTitle'),
            message: t('session.workState.unsupportedMessage'),
        };
    }
    return { title: t('common.error'), message: result.error };
}
