import { t } from '@/text';

export function formatUsageLimitRecoveryOperationError(result: Readonly<{
    error?: string;
    errorCode?: string;
}>): string {
    const code = result.errorCode ?? result.error ?? 'session_usage_limit_recovery_control_failed';
    switch (code) {
        case 'session_usage_limit_recovery_control_remote_unavailable':
        case 'session_usage_limit_recovery_control_machine_unavailable':
        case 'session_usage_limit_recovery_control_current_machine_unknown':
        case 'session_usage_limit_recovery_control_session_machine_unknown':
        case 'session_usage_limit_recovery_control_metadata_unavailable':
            return t('errors.daemonUnavailableBody');
        case 'session_usage_limit_recovery_control_inactive':
        case 'session_usage_limit_recovery_control_issue_mismatch':
        case 'session_usage_limit_recovery_control_cwd_unavailable':
            return t('errors.tryAgain');
        default:
            return code.startsWith('session_usage_limit_recovery_control_')
                ? t('errors.operationFailed')
                : code;
    }
}
