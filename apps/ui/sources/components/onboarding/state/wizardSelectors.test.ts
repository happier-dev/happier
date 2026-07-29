import { describe, expect, it } from 'vitest';

import { canSkipWizardStep, getNextWizardStepId, getPreviousWizardStepId, getVisibleWizardStepIds, getWizardProgress } from './wizardSelectors';

const onboardingContext = {
    mode: 'onboarding' as const,
    platform: 'web' as const,
    canScanQr: true,
    scanStepEnabled: false,
    canRunSystemTasks: false,
    relaySelection: { choiceId: null, serverUrl: null, locked: false },
    relayAccessProviderId: null,
    relayLockConfirmationPending: false,
    relaySwitchConfirmationPending: false,
    authIntent: 'standard' as const,
    setupAction: null,
};

const setupContext = {
    mode: 'setup' as const,
    platform: 'desktop' as const,
    canScanQr: false,
    scanStepEnabled: false,
    canRunSystemTasks: true,
    relaySelection: { choiceId: null, serverUrl: null, locked: false },
    relayAccessProviderId: null,
    relayLockConfirmationPending: false,
    relaySwitchConfirmationPending: false,
    authIntent: 'standard' as const,
    setupAction: null,
};

describe('wizardSelectors', () => {
    it('derives onboarding step order without scan step by default', () => {
        expect(getVisibleWizardStepIds(onboardingContext)).toEqual([
            'welcome',
            'relay_select',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_lost_access',
        ]);
    });

    it('includes the scan step only when the user opted into scanning', () => {
        expect(getVisibleWizardStepIds({ ...onboardingContext, scanStepEnabled: true })).toEqual([
            'welcome',
            'scan_code',
            'relay_select',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_lost_access',
        ]);
    });

    it('includes the relay lock confirmation step only when required by scan intent', () => {
        expect(getVisibleWizardStepIds({ ...onboardingContext, relayLockConfirmationPending: true })).toEqual([
            'welcome',
            'relay_select',
            'confirm_relay_lock',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_lost_access',
        ]);
    });

    it('shows the relay url step only when a custom relay has not been resolved yet', () => {
        expect(getVisibleWizardStepIds({
            ...onboardingContext,
            scanStepEnabled: true,
            relaySelection: { choiceId: 'customUrl' as const, serverUrl: 'https://relay.example.com', locked: false },
        })).toEqual([
            'welcome',
            'scan_code',
            'relay_select',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_lost_access',
        ]);

        expect(getVisibleWizardStepIds({
            ...onboardingContext,
            scanStepEnabled: true,
            relaySelection: { choiceId: 'customUrl' as const, serverUrl: null, locked: false },
        })).toEqual([
            'welcome',
            'scan_code',
            'relay_select',
            'relay_enter_url',
            'auth',
            'auth_restore',
            'auth_secret_key',
            'auth_lost_access',
        ]);
    });

    it('derives setup step order', () => {
        expect(getVisibleWizardStepIds(setupContext)).toEqual([
            'setup_chooser',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'local',
        })).toEqual([
            'setup_chooser',
            'setup_this_computer',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'local',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://local-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'setup_this_computer',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'relayLocal',
        })).toEqual([
            'setup_chooser',
            'host_relay_local',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'relayLocal',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://local-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'host_relay_local',
            'relay_access',
            'confirm_switch_relay',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'relayLocal',
            relayAccessProviderId: 'lan',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://local-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'host_relay_local',
            'relay_access',
            'relay_access_prereqs',
            'confirm_switch_relay',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'relayLocal',
            relayAccessProviderId: 'cloudflareNamed',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://local-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'host_relay_local',
            'relay_access',
            'relay_access_prereqs',
            'confirm_switch_relay',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'relayLocal',
            relayAccessProviderId: 'tailscaleServe',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://local-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'host_relay_local',
            'relay_access',
            'relay_access_prereqs',
            'confirm_switch_relay',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'remote',
        })).toEqual([
            'setup_chooser',
            'remote_ssh_setup',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'remote',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://remote-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'remote_ssh_setup',
            'relay_access',
            'confirm_switch_relay',
            'providers_optional',
            'done',
        ]);

        expect(getVisibleWizardStepIds({
            ...setupContext,
            setupAction: 'remote',
            relayAccessProviderId: 'lan',
            relaySelection: {
                ...setupContext.relaySelection,
                serverUrl: 'https://remote-relay.example.test',
            },
        })).toEqual([
            'setup_chooser',
            'remote_ssh_setup',
            'relay_access',
            'relay_access_prereqs',
            'confirm_switch_relay',
            'providers_optional',
            'done',
        ]);
    });

    it('reports skip and progress metadata', () => {
        expect(canSkipWizardStep(onboardingContext, 'auth')).toBe(false);
        expect(canSkipWizardStep(setupContext, 'confirm_switch_relay')).toBe(false);
        expect(getNextWizardStepId(onboardingContext, 'auth')).toBe('auth_restore');
        expect(getPreviousWizardStepId({
            ...onboardingContext,
            relaySelection: { choiceId: 'customUrl' as const, serverUrl: 'https://relay.example.com', locked: false },
        }, 'auth')).toBe('relay_select');
        expect(getWizardProgress(onboardingContext, 'auth')).toEqual({ current: 3, total: 6 });
    });
});
