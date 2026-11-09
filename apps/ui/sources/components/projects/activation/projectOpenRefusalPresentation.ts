import { t } from '@/text';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { OpenProjectResultV1 } from '@happier-dev/protocol/projects/openProjectV1';

type ProjectOpenRefusalPresentation = Readonly<{ title: string; description?: string; details: readonly string[] }>;

/**
 * The refusal in the person's terms: what went wrong, then what to do next. Codes stay behind Details:
 * the refusal code, then the failed step's own code or error class when the owner supplied one.
 */
export function projectOpenRefusalPresentation(code: string, gitRef: string | null,
    remediation?: Extract<OpenProjectResultV1, { kind: 'refused' }>['remediation'],
    /** The repository being opened, as the Source row shows it; null when none is known. */
    repository?: string | null,
    failureCause?: ActionFailureCauseV1,
    /** The subfolder this Open asked for; null when it asked for the whole repository. */
    subfolder?: string | null): ProjectOpenRefusalPresentation {
    const failed = failureCause ? (failureCause.errorCode ?? failureCause.errorClass) : null;
    const details = failed && failed !== code ? [code, failed] : [code];
    const shown = (title: string, description?: string): ProjectOpenRefusalPresentation =>
        ({ title, ...(description ? { description } : {}), details });
    if (code === 'REMOTE_AUTH_REQUIRED') return shown(
        repository ? t('projects.open.gitDenied', { repository }) : t('errors.authenticationFailed'),
        remediation?.label ?? t('projects.open.gitDeniedHint'));
    if (code === 'REMOTE_RATE_LIMITED') return shown(t('projects.open.githubRateLimited'),
        remediation?.action === 'connect_github' ? t('projects.open.githubConnectHint') : undefined);
    if (code === 'FEATURE_UNSUPPORTED') return shown(t('projects.open.cloneUnsupported'), t('projects.open.cloneUnsupportedHint'));
    if (code === 'BACKEND_UNAVAILABLE') return shown(t('projects.open.hostingProviderUnavailable'), t('projects.open.hostingProviderUnavailableHint'));
    if (code === 'target_mismatch') return shown(t('projects.open.targetMismatch'), t('projects.open.targetMismatchHint'));
    if (code === 'machine_access_denied') return shown(t('projects.open.accessDenied'), t('projects.open.accessDeniedHint'));
    if (code.startsWith('requester_') || code === 'session_requester_unavailable' || code === 'machine_admission_unavailable')
        return shown(t('projects.open.accessUnconfirmed'), t('projects.open.accessUnconfirmedHint'));
    if (code === 'invalid_input') return shown(t('projects.open.requestUnreadable'), t('projects.open.requestUnreadableHint'));
    if (code.includes('unreachable') || code.includes('offline'))
        return shown(t('workspaceSync.start.blocked.targetMachineOffline'), t('projects.open.machineOfflineHint'));
    if (gitRef && code.includes('ref')) return shown(t('projects.open.refMissing', { ref: gitRef }), t('projects.open.refMissingHint'));
    if (code === 'repository_subfolder_missing') return shown(t('projects.open.subfolderMissing'),
        t('projects.open.subfolderMissingHint', { subfolder: subfolder?.trim() || t('projects.open.subfolderInRepository') }));
    if (code === 'invalid_directory' || code === 'INVALID_PATH') return shown(t('projects.open.folderUnusable'), t('projects.open.folderUnusableHint'));
    // These two sentences already say what to do next.
    if (code.includes('folder') || code.includes('path')) return shown(t('projects.open.invalidFolder'));
    if (code.includes('source') && code.includes('changed')) return shown(t('projects.open.sourceChanged'));
    if (code.includes('source')) return shown(t('projects.open.sourceUnavailable'), t('projects.open.sourceUnavailableHint'));
    // Unclassified: say it failed, never that the Machine can't do it.
    return shown(t('projects.open.failed'), t('projects.open.failedHint'));
}
