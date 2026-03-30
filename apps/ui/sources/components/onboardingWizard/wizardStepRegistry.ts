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
        case 'host_relay_local':
        case 'auth':
        case 'auth_restore':
        case 'auth_lost_access':
        case 'done':
            return true;
        case 'relay_enter_url':
            return context.relaySelection.choiceId === 'customUrl'
                && (context.relaySelection.serverUrl == null || String(context.relaySelection.serverUrl).trim() === '');
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
            return context.setupAction === 'local';
        case 'confirm_switch_relay': {
            if (context.setupAction !== 'local' && context.setupAction !== 'remote') {
                return false;
            }
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            return url.length > 0;
        }
        case 'remote_ssh_setup':
            return context.setupAction === 'remote';
        case 'host_relay_remote':
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
        id: 'relay_enter_url',
        titleKey: 'setupOnboarding.customRelayUrlLabel',
        subtitleKey: 'setupOnboarding.relayCustomUrlSubtitle',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: onboardingVisible('relay_enter_url'),
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
        titleKey: 'settings.machineSetupCurrentMachineTitle',
        subtitleKey: 'settings.machineSetupCurrentMachineSubtitle',
        kind: 'setup',
        surface: 'setup',
        canSkip: false,
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
                return context.canRunSystemTasks && context.relaySelection.choiceId === 'thisMac';
            }
            return setupVisible('host_relay_local')(context);
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
        id: 'host_relay_remote',
        titleKey: 'settings.machineSetupRemoteRelayRuntimeTitle',
        subtitleKey: 'settings.machineSetupRemoteRelayRuntimeLabel',
        kind: 'setup',
        surface: 'setup',
        canSkip: false,
        visibleWhen: setupVisible('host_relay_remote'),
    },
    {
        id: 'confirm_switch_relay',
        titleKey: 'setupOnboarding.confirmSwitchRelayTitle',
        subtitleKey: 'setupOnboarding.confirmSwitchRelaySubtitle',
        kind: 'setup',
        surface: 'setup',
        canSkip: false,
        visibleWhen: setupVisible('confirm_switch_relay'),
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
