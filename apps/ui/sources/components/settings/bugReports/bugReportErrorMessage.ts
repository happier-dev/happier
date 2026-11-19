import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionErrorClassV1';

import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

export function bugReportErrorMessage(error: unknown, fallback: string): string {
    const message = error instanceof Error ? error.message : undefined;
    const code = readActionErrorCodeV1(error) ?? message;
    if (code === 'bug_report_diagnostics_scope_changed' || code === 'action_account_scope_changed') {
        return t('bugReports.composer.scopeChanged');
    }
    return resolveActionExecutionErrorMessage(error, message ?? fallback);
}

export function isBugReportDiagnosticsSuperseded(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
        && error.message === 'bug_report_diagnostics_superseded';
}
