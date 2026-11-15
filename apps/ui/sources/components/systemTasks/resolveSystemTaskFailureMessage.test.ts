import { describe, expect, it } from 'vitest';
import { t } from '@/text';

describe('resolveSystemTaskFailureMessage', () => {
    it.each(['home_not_guest_reachable', 'bootstrap.home_not_guest_reachable'])(
        'keeps authored-network recovery visible for %s', async code => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        const message = resolveSystemTaskFailureMessage({ code, message: 'private native diagnostic',
            details: { kind: 'managedGuestHome', homeOrigin: 'https://home.example.test:9443', reason: 'authored_network' } });
        expect(message).toBe(`${t('managedMachines.creation.homeAuthoredNetworkNotReachable')} (https://home.example.test:9443)`);
        expect(message).not.toContain('private native diagnostic');
    });
    it('presents operator authorization recovery through the existing typed cause owner', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        const message = resolveSystemTaskFailureMessage({
            code: 'tailscale_operator_authorization_refused', message: 'private native diagnostic',
        });
        expect(message).toBe(t('settings.relayAccess.tailscaleOperatorAuthorizationRefused'));
        expect(message).not.toBe('private native diagnostic');
    });
    it('replaces a managed controller request code with localized recovery copy', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        expect(resolveSystemTaskFailureMessage({ code: 'managed_controller_request_failed', message: 'managed_controller_request_failed' }))
            .toBe(t('managedMachines.detail.controllerRequestFailed'));
    });
    it.each([['preset_limit_reached', 'machinePresets.limitWaits'], ['pool_no_available_machine', 'machinePresets.poolNoMachine']] as const)(
        'says what a refused Preset acquire means instead of its code (%s)', async (code, key) => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        expect(resolveSystemTaskFailureMessage({ code, message: null })).toBe(t(key));
    });
    it('replaces a remote guest update failure with actionable app copy', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        const message = resolveSystemTaskFailureMessage({ code: 'remote_cli_update_required', message: 'legacy daemon diagnostic' });
        expect(message).not.toBe('legacy daemon diagnostic');
        expect(message).toBe(t('setupOnboarding.remoteSshChecklist.remoteCliUpdateRequired'));
    });

    it('presents the scoped setup admission conflict in app copy at the start-error boundary', async () => {
        const { readSystemTaskStartErrorMessage } = await import('./systemTaskStartError');
        const error = Object.assign(new Error('system_task_setup_in_progress'), { code: 'system_task_setup_in_progress' });
        expect(readSystemTaskStartErrorMessage(error)).toBe(t('machine.thisComputer.setupAlreadyRunning'));
        expect(readSystemTaskStartErrorMessage(new Error('  failed to start hsetup  '))).toBe('failed to start hsetup');
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

    it.each(['home_not_guest_reachable', 'bootstrap.home_not_guest_reachable'])(
        'maps the task and retained bootstrap cause to the same Home recovery (%s)', async (code) => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');
        const homeOrigin = 'https://home.example.test:9443';
        expect(resolveSystemTaskFailureMessage({ code, message: null,
            details: { kind: 'managedGuestHome', homeOrigin } }))
            .toBe(`${t('managedMachines.creation.homeNotGuestReachable')} (${homeOrigin})`);
    });

    it('keeps the task message for other failures and returns undefined when there is nothing to show', async () => {
        const { resolveSystemTaskFailureMessage } = await import('./resolveSystemTaskFailureMessage');

        expect(resolveSystemTaskFailureMessage({ code: 'ssh_failed', message: ' Connection refused ' })).toBe('Connection refused');
        expect(resolveSystemTaskFailureMessage({ code: 'ssh_failed', message: '' })).toBeUndefined();
    });
});
