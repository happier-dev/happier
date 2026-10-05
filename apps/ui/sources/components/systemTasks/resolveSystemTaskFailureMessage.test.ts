import { describe, expect, it } from 'vitest';
import { t } from '@/text';

describe('resolveSystemTaskFailureMessage', () => {
    it('presents the scoped setup admission conflict in app copy at the start-error boundary', async () => {
        const { readSystemTaskStartErrorMessage } = await import('./systemTaskStartError');
        const error = Object.assign(new Error('system_task_setup_in_progress'), { code: 'system_task_setup_in_progress' });
        expect(readSystemTaskStartErrorMessage(error)).toBe(t('machine.thisComputer.setupAlreadyRunning'));
    });

    it('names the failed acquisition phase without exposing its raw diagnostics', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        expect(resolveSystemTaskFailureMessage({ code: 'cli_acquisition_verifying_failed', message: 'secret URL' }))
            .toBe(t('cliAcquisitionProgress.acquisitionVerificationFailed'));
    });

    it('shows app copy for setup decisions the user declined instead of the daemon sentence', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');

        expect(resolveSystemTaskFailureMessage({
            code: 'service_reconciliation_declined',
            message: 'Existing background services on the remote host were left unchanged, so setup stopped.',
        })).toBe(t('machine.backgroundServicePrompt.replaceDeclined'));
        expect(resolveSystemTaskFailureMessage({
            code: 'release_channel_switch_declined',
            message: 'The remote default release channel stayed stable.',
        })).toBe(t('machine.backgroundServicePrompt.channelSwitchDeclined'));
    });

    it('says in app copy when the one-CLI question (R12) went unanswered or the kept CLI is gone', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');

        expect(resolveSystemTaskFailureMessage({ code: 'cli_choice_unanswered', message: 'Setup stopped before changing anything.' }))
            .toBe(t('machine.thisComputer.cliChoice.unanswered'));
        expect(resolveSystemTaskFailureMessage({ code: 'cli_own_missing', message: 'The Happier CLI this computer keeps is no longer at /x.' }))
            .toBe(t('machine.thisComputer.cliChoice.ownMissing'));
    });

    it('keeps the task message for other failures and returns undefined when there is nothing to show', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');

        expect(resolveSystemTaskFailureMessage({ code: 'ssh_failed', message: ' Connection refused ' })).toBe('Connection refused');
        expect(resolveSystemTaskFailureMessage({ code: 'ssh_failed', message: '' })).toBeUndefined();
    });
});
