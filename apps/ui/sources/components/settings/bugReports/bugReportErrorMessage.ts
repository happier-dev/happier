import { t } from '@/text';

export function bugReportErrorMessage(error: unknown, fallback: string): string {
    if (!(error instanceof Error)) return fallback;
    return error.message === 'bug_report_diagnostics_scope_changed' || error.message === 'action_account_scope_changed'
        ? t('bugReports.composer.scopeChanged')
        : error.message;
}

export function isBugReportDiagnosticsSuperseded(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
        && error.message === 'bug_report_diagnostics_superseded';
}
