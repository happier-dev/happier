import { t, type TranslationKey } from '@/text';
import { resolveCliAcquisitionFailureMessage } from './cliAcquisitionPresentation';

/**
 * Failure codes whose daemon sentence the app replaces with its own copy.
 * Setup decisions and admission failures name their remedy in the user's language.
 */
const SYSTEM_TASK_FAILURE_TRANSLATION_KEYS: Readonly<Record<string, TranslationKey>> = {
    system_task_setup_in_progress: 'machine.thisComputer.setupAlreadyRunning',
    service_reconciliation_declined: 'machine.backgroundServicePrompt.replaceDeclined',
    release_channel_switch_declined: 'machine.backgroundServicePrompt.channelSwitchDeclined',
    // R12: the one-CLI question was dismissed (or Keep was not possible), or the kept CLI is gone.
    cli_choice_unanswered: 'machine.thisComputer.cliChoice.unanswered',
    cli_own_missing: 'machine.thisComputer.cliChoice.ownMissing',
};

/** The message to show for a failed system task: app copy for known codes, else the task's own message. */
export function resolveSystemTaskFailureMessage(
    error: Readonly<{ code?: string | null; message?: string | null }>,
): string | undefined {
    const acquisitionFailure = error.code ? resolveCliAcquisitionFailureMessage(error.code) : undefined;
    if (acquisitionFailure) return acquisitionFailure;
    const key = error.code ? SYSTEM_TASK_FAILURE_TRANSLATION_KEYS[error.code] : undefined;
    if (key) {
        return t(key);
    }
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    return message.length > 0 ? message : undefined;
}
