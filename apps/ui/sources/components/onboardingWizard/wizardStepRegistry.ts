import type { WizardContext, WizardStepDefinition, WizardStepId } from './wizardTypes';

const baseRelayStep: Pick<WizardStepDefinition, 'kind' | 'surface' | 'canSkip'> = {
    kind: 'choice',
    surface: 'onboarding',
    canSkip: true,
};

const onboardingVisible = (stepId: WizardStepId) => (context: WizardContext): boolean => {
    if (context.mode !== 'onboarding') return false;
    switch (stepId) {
        case 'scan_code':
            return context.canScanQr && context.scanStepEnabled;
        case 'relay_select':
        case 'confirm_relay_lock':
        case 'host_relay_local':
        case 'relay_access':
        case 'background_service_handoff':
        case 'auth':
        case 'auth_restore':
        case 'auth_lost_access':
        case 'done':
            return true;
        case 'host_relay_remote':
            return context.platform === 'desktop' && context.relaySelection.choiceId === 'remoteComputer';
        case 'relay_enter_url':
            return (
                (context.relaySelection.choiceId === 'customUrl'
                    || (context.platform === 'web' && context.relaySelection.choiceId === 'thisComputer'))
                && (context.relaySelection.serverUrl == null || String(context.relaySelection.serverUrl).trim() === '')
            );
        case 'welcome':
            return true;
        default:
            return false;
    }
};

const setupVisible = (stepId: WizardStepId) => (context: WizardContext): boolean => {
    if (context.mode !== 'setup') return false;
    switch (stepId) {
        case 'setup_chooser':
            return true;
        case 'setup_this_computer':
            return context.setupAction === 'local';
        case 'host_relay_local':
            return context.setupAction === 'relayLocal';
        case 'relay_access': {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            if (!url) return false;
            return context.setupAction === 'relayLocal' || context.setupAction === 'remote';
        }
        case 'confirm_switch_relay': {
            if (context.setupAction !== 'relayLocal' && context.setupAction !== 'remote') {
                return false;
            }
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            return url.length > 0;
        }
        case 'remote_ssh_setup':
            return context.setupAction === 'remote';
        case 'providers_optional':
            return context.setupAction === 'local' || context.setupAction === 'remote';
        case 'secure_access_tailscale':
            return context.setupAction === 'tailscale';
        case 'done':
            return context.setupAction != null;
        default:
            return false;
    }
};

const wizardStepRegistryEntries = [
    {
        id: 'welcome',
        titleKey: 'setupOnboarding.welcomeTitle',
        subtitleKey: 'setupOnboarding.welcomeBody',
        kind: 'entry',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('welcome'),
    },
    {
        id: 'scan_code',
        titleKey: 'setupOnboarding.scanQrCode',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('scan_code'),
    },
    {
        id: 'relay_select',
        titleKey: 'setupOnboarding.preAuthTitle',
        subtitleKey: 'setupOnboarding.preAuthBody',
        ...baseRelayStep,
        visibleWhen: onboardingVisible('relay_select'),
    },
    {
        id: 'confirm_relay_lock',
        titleKey: 'setupOnboarding.confirmSwitchRelayTitle',
        subtitleKey: 'setupOnboarding.confirmSwitchRelaySubtitle',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: (context) => {
            return context.mode === 'onboarding' && context.relayLockConfirmationPending;
        },
    },
    {
        id: 'desktop_handoff',
        titleKey: 'setupOnboarding.webRelayHostHandoffTitle',
        subtitleKey: 'setupOnboarding.webRelayHostHandoffBody',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: (context) => {
            return context.mode === 'onboarding'
                && context.platform === 'web'
                && context.relaySelection.choiceId === 'thisComputer';
        },
    },
    {
        id: 'relay_enter_url',
        titleKey: 'setupOnboarding.customRelayUrlLabel',
        subtitleKey: 'setupOnboarding.relayCustomUrlSubtitle',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('relay_enter_url'),
    },
    {
        id: 'background_service_handoff',
        titleKey: 'sessionGettingStarted.steps.openSetup.title',
        subtitleKey: 'sessionGettingStarted.steps.openSetup.description',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            return context.mode === 'onboarding'
                && context.platform === 'web'
                && context.relaySelection.choiceId === 'thisComputer'
                && url.length > 0;
        },
    },
    {
        id: 'auth',
        titleKey: 'setupOnboarding.resumeIntentTitle',
        subtitleKey: 'setupOnboarding.resumeIntentBody',
        kind: 'auth',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('auth'),
    },
    {
        id: 'auth_restore',
        titleKey: 'setupOnboarding.authRestoreTitle',
        subtitleKey: 'setupOnboarding.authRestoreSubtitle',
        kind: 'recovery',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('auth_restore'),
    },
    {
        id: 'auth_lost_access',
        titleKey: 'setupOnboarding.authLostAccessTitle',
        subtitleKey: 'setupOnboarding.authLostAccessSubtitle',
        kind: 'recovery',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('auth_lost_access'),
    },
    {
        id: 'setup_chooser',
        titleKey: 'setupOnboarding.screenTitle',
        subtitleKey: 'setupOnboarding.postAuthBody',
        kind: 'entry',
        surface: 'setup',
        canSkip: true,
        visibleWhen: setupVisible('setup_chooser'),
    },
    {
        id: 'setup_this_computer',
        titleKey: 'setupOnboarding.setupThisComputerTitle',
        subtitleKey: 'settings.machineSetupCurrentMachineSubtitle',
        kind: 'setup',
        surface: 'setup',
        canSkip: true,
        visibleWhen: setupVisible('setup_this_computer'),
    },
    {
        id: 'host_relay_local',
        titleKey: 'settings.localRelayRuntime.title',
        subtitleKey: 'settings.localRelayRuntime.footer',
        kind: 'setup',
        surface: 'setup',
        canSkip: false,
        visibleWhen: (context) => {
            if (context.mode === 'onboarding') {
                return context.canRunSystemTasks && context.relaySelection.choiceId === 'thisComputer';
            }
            return setupVisible('host_relay_local')(context);
        },
    },
    {
        id: 'relay_access',
        titleKey: 'settings.relayAccess.title',
        subtitleKey: 'settings.relayAccess.footer',
        kind: 'setup',
        surface: 'setup',
        canSkip: true,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            if (!url) return false;
            if (context.mode === 'onboarding') {
                return context.platform === 'desktop' && context.canRunSystemTasks && context.relaySelection.choiceId === 'thisComputer';
            }
            return setupVisible('relay_access')(context);
        },
    },
    {
        id: 'host_relay_remote',
        titleKey: 'setupOnboarding.relayOnRemoteComputerTitle',
        subtitleKey: 'setupOnboarding.relayOnRemoteComputerSubtitle',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: (context) => {
            return context.mode === 'onboarding'
                && context.platform === 'desktop'
                && context.relaySelection.choiceId === 'remoteComputer';
        },
    },
    {
        id: 'secure_access_tailscale',
        titleKey: 'settings.localTailscale.title',
        subtitleKey: 'settings.localTailscale.footer',
        kind: 'setup',
        surface: 'setup',
        canSkip: true,
        visibleWhen: setupVisible('secure_access_tailscale'),
    },
    {
        id: 'remote_ssh_setup',
        titleKey: 'settings.machineSetupSshMachineTitle',
        subtitleKey: 'settings.machineSetupSshMachineSubtitle',
        kind: 'setup',
        surface: 'setup',
        canSkip: false,
        visibleWhen: setupVisible('remote_ssh_setup'),
    },
    {
        id: 'confirm_switch_relay',
        titleKey: 'setupOnboarding.confirmSwitchRelayTitle',
        subtitleKey: 'setupOnboarding.confirmSwitchRelaySubtitle',
        kind: 'setup',
        surface: 'setup',
        canSkip: false,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            if (context.mode === 'setup') {
                return setupVisible('confirm_switch_relay')(context);
            }
            return context.mode === 'onboarding'
                && context.relaySwitchConfirmationPending
                && url.length > 0;
        },
    },
    {
        id: 'providers_optional',
        titleKey: 'settingsProviders.setup.startTitle',
        subtitleKey: 'settingsProviders.setup.selectionFooter',
        kind: 'finish',
        surface: 'setup',
        canSkip: true,
        visibleWhen: setupVisible('providers_optional'),
    },
    {
        id: 'done',
        titleKey: 'setupOnboarding.postAuthTitle',
        subtitleKey: 'setupOnboarding.postAuthBody',
        kind: 'finish',
        surface: 'setup',
        canSkip: true,
        visibleWhen: setupVisible('done'),
    },
] satisfies ReadonlyArray<WizardStepDefinition>;

export const wizardStepRegistry = Object.freeze(wizardStepRegistryEntries);

export function getWizardStepDefinition(stepId: WizardStepId): WizardStepDefinition {
    const step = wizardStepRegistry.find((definition) => definition.id === stepId);
    if (!step) {
        throw new Error(`Unknown wizard step: ${stepId}`);
    }
    return step;
}
