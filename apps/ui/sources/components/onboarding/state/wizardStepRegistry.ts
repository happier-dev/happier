import { relayAccessProviderUsesPrerequisitesStep as relayAccessProviderNeedsPrerequisitesStep } from '@/components/settings/server/relayAccess/relayAccessUiCatalog';
import type { WizardContext, WizardStepDefinition, WizardStepId } from './wizardTypes';

const baseRelayStep: Pick<WizardStepDefinition, 'kind' | 'surface' | 'canSkip'> = {
    kind: 'choice',
    surface: 'onboarding',
    canSkip: true,
};

const onboardingVisible = (stepId: WizardStepId) => (context: WizardContext): boolean => {
    if (context.mode !== 'onboarding') return false;
    switch (stepId) {
        case 'relay_select':
        case 'auth':
        case 'auth_restore':
        case 'auth_secret_key':
        case 'auth_service_select':
        case 'auth_lost_access':
            return true;
        case 'host_relay_remote':
            return context.platform === 'desktop' && context.relaySelection.choiceId === 'remoteComputer';
        // Only the web "this computer" handoff asks for its own Home's address here; every other
        // address goes through the Welcome's connect step (`connect_home`).
        case 'relay_enter_url':
            return context.platform === 'web'
                && context.relaySelection.choiceId === 'thisComputer'
                && (context.relaySelection.serverUrl == null || String(context.relaySelection.serverUrl).trim() === '');
        case 'welcome':
            return true;
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
        id: 'relay_select',
        titleKey: 'setupOnboarding.preAuthTitle',
        subtitleKey: 'setupOnboarding.preAuthBody',
        ...baseRelayStep,
        visibleWhen: onboardingVisible('relay_select'),
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
                && (context.platform === 'web' || context.platform === 'native')
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
        titleKey: 'setupOnboarding.connectComputerTitle',
        subtitleKey: 'setupOnboarding.connectComputerSubtitle',
        kind: 'choice',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            return context.mode === 'onboarding'
                && (context.platform === 'web' || context.platform === 'native')
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
        canSkip: false,
        visibleWhen: onboardingVisible('auth'),
    },
    {
        id: 'auth_restore',
        titleKey: 'setupOnboarding.authRestoreTitle',
        subtitleKey: 'setupOnboarding.authRestoreSubtitle',
        // Each way titles itself: Approve from a device you use, the recovery key, the camera.
        bodyOwnsHeading: true,
        kind: 'recovery',
        surface: 'onboarding',
        // Another way in, not an optional step: Back is its way out.
        canSkip: false,
        visibleWhen: onboardingVisible('auth_restore'),
    },
    {
        id: 'auth_secret_key',
        titleKey: 'setupOnboarding.authSecretKeyTitle',
        subtitleKey: 'setupOnboarding.authSecretKeySubtitle',
        kind: 'recovery',
        surface: 'onboarding',
        // Another way in, not an optional step: Back is its way out.
        canSkip: false,
        visibleWhen: onboardingVisible('auth_secret_key'),
    },
    {
        id: 'auth_email_password',
        titleKey: 'settingsAccount.nativePassword.title',
        bodyOwnsHeading: true,
        kind: 'auth',
        surface: 'onboarding',
        canSkip: false,
        // Opened only with the sign-in request it answers, never reached by advancing the
        // sequence, so it takes no place in the step order or the progress count.
        visibleWhen: () => false,
    },
    {
        id: 'auth_oauth_browser_wait',
        titleKey: 'common.login',
        bodyOwnsHeading: true,
        kind: 'auth',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: () => false,
    },
    {
        // A Home reached by its link or address, then that Home's own sign-in (owner 11-13: steps of the
        // welcome, not a sheet over it). Each pane titles itself, so the host draws no heading.
        id: 'connect_home',
        titleKey: 'homesJourneys.pathDirectTitle',
        bodyOwnsHeading: true,
        kind: 'auth',
        surface: 'onboarding',
        canSkip: false,
        // Opened from the Welcome's row, the Home chooser's address choice or a supplied Home address.
        directEntry: true,
        visibleWhen: () => false,
    },
    {
        id: 'auth_service_select',
        titleKey: 'welcome.chooseSignInService',
        subtitleKey: 'welcome.signInServiceUrlPrompt',
        kind: 'auth',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: onboardingVisible('auth_service_select'),
    },
    {
        id: 'auth_lost_access',
        titleKey: 'setupOnboarding.authLostAccessTitle',
        subtitleKey: 'setupOnboarding.authLostAccessSubtitle',
        // The step titles itself under its key mark, with what is left on this Home as its purpose line.
        bodyOwnsHeading: true,
        kind: 'recovery',
        surface: 'onboarding',
        // Another way in, not an optional step: Back is its way out.
        canSkip: false,
        visibleWhen: onboardingVisible('auth_lost_access'),
    },
    {
        id: 'host_relay_local',
        titleKey: 'setupOnboarding.hostHereTitle',
        subtitleKey: 'setupOnboarding.hostHereSubtitle',
        kind: 'setup',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: (context) => {
            return context.canRunSystemTasks && context.relaySelection.choiceId === 'thisComputer';
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
        id: 'relay_access',
        titleKey: 'setupOnboarding.relayAccessWizardTitle',
        subtitleKey: 'settings.relayAccess.footer',
        kind: 'setup',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            if (!url) return false;
            return context.platform === 'desktop'
                && context.canRunSystemTasks
                && (context.relaySelection.choiceId === 'thisComputer' || context.relaySelection.choiceId === 'remoteComputer');
        },
    },
    {
        id: 'relay_access_prereqs',
        titleKey: 'setupOnboarding.relayAccessWizardTitle',
        subtitleKey: 'settings.relayAccess.footer',
        kind: 'setup',
        surface: 'onboarding',
        canSkip: true,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            if (!url) return false;
            if (!relayAccessProviderNeedsPrerequisitesStep(context.relayAccessProviderId)) {
                return false;
            }
            return context.platform === 'desktop'
                && context.canRunSystemTasks
                && (context.relaySelection.choiceId === 'thisComputer' || context.relaySelection.choiceId === 'remoteComputer');
        },
    },
    {
        id: 'confirm_switch_relay',
        titleKey: 'setupOnboarding.confirmSwitchRelayTitle',
        subtitleKey: 'setupOnboarding.confirmSwitchRelaySubtitle',
        kind: 'setup',
        surface: 'onboarding',
        canSkip: false,
        visibleWhen: (context) => {
            const url = typeof context.relaySelection.serverUrl === 'string' ? context.relaySelection.serverUrl.trim() : '';
            return context.mode === 'onboarding'
                && context.relaySwitchConfirmationPending
                && url.length > 0;
        },
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
