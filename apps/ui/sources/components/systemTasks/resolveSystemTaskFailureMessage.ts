import { t, type TranslationKey } from '@/text';
import type { ActionOperationFailureV1 } from '@happier-dev/protocol/actions/operations/v1';
import { resolveCliAcquisitionFailureMessage } from './cliAcquisitionPresentation';

/**
 * Failure codes whose daemon sentence the app replaces with its own copy.
 * Setup decisions and admission failures name their remedy in the user's language.
 */
const SYSTEM_TASK_FAILURE_TRANSLATION_KEYS: Readonly<Record<string, TranslationKey>> = {
    tailscale_operator_authorization_refused: 'settings.relayAccess.tailscaleOperatorAuthorizationRefused',
    managed_controller_request_failed: 'managedMachines.detail.controllerRequestFailed',
    home_not_guest_reachable: 'managedMachines.creation.homeNotGuestReachable',
    preset_limit_reached: 'machinePresets.limitWaits',
    pool_no_available_machine: 'machinePresets.poolNoMachine',
    remote_cli_update_required: 'setupOnboarding.remoteSshChecklist.remoteCliUpdateRequired',
    system_task_setup_in_progress: 'machine.thisComputer.setupAlreadyRunning',
    service_reconciliation_declined: 'machine.backgroundServicePrompt.replaceDeclined',
    release_channel_switch_declined: 'machine.backgroundServicePrompt.channelSwitchDeclined',
    // R12: the one-CLI question was dismissed (or Keep was not possible), or the kept CLI is gone.
    cli_choice_unanswered: 'machine.thisComputer.cliChoice.unanswered',
    cli_own_missing: 'machine.thisComputer.cliChoice.ownMissing',
};

/** The message to show for a failed system task: app copy for known codes, else the task's own message. */
export function resolveSystemTaskFailureMessage(
    error: Readonly<{ code?: string | null; message?: string | null; details?: ActionOperationFailureV1['details'] }>,
): string | undefined {
    const acquisitionFailure = error.code ? resolveCliAcquisitionFailureMessage(error.code) : undefined;
    if (acquisitionFailure) return acquisitionFailure;
    const key = error.code ? SYSTEM_TASK_FAILURE_TRANSLATION_KEYS[error.code] : undefined;
    if (key) {
        const details = error.details;
        return error.code === 'home_not_guest_reachable' && details && 'kind' in details && details.kind === 'managedGuestHome'
            ? `${t(key)} (${details.homeOrigin})` : t(key);
    }
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    return message.length > 0 ? message : undefined;
}
