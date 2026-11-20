import type { TranslationKey } from '@/text';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';

export type WizardMode = 'onboarding';

export type WizardPlatform = 'web' | 'native' | 'desktop';

export type WizardStepId =
    | 'welcome'
    | 'relay_select'
    | 'relay_enter_url'
    | 'desktop_handoff'
    | 'background_service_handoff'
    | 'host_relay_local'
    | 'host_relay_remote'
    | 'relay_access'
    | 'relay_access_prereqs'
    | 'auth'
    | 'auth_restore'
    | 'auth_secret_key'
    | 'auth_service_select'
    | 'auth_lost_access'
    | 'auth_email_password'
    | 'connect_home'
    | 'confirm_switch_relay';

export type WizardRelayChoiceId = 'cloud' | 'thisComputer' | 'remoteComputer' | 'customUrl';

export type WizardRelaySelection = Readonly<{
    choiceId: WizardRelayChoiceId | null;
    serverUrl: string | null;
    relayProfileId?: string | null;
    locked: boolean;
}>;

export type WizardAuthIntent = 'standard' | 'restore' | 'lost_access';

export type WizardContext = Readonly<{
    mode: WizardMode;
    platform: WizardPlatform;
    canRunSystemTasks: boolean;
    relaySelection: WizardRelaySelection;
    relayAccessProviderId: RelayAccessProviderId | null;
    relaySwitchConfirmationPending: boolean;
    authIntent: WizardAuthIntent;
}>;

export type WizardStepKind = 'entry' | 'choice' | 'auth' | 'recovery' | 'setup' | 'finish';

export type WizardStepDefinition = Readonly<{
    id: WizardStepId;
    titleKey: TranslationKey;
    subtitleKey?: TranslationKey;
    /** The step body titles itself (its heading changes with its own sub-views), so the host draws none. */
    bodyOwnsHeading?: boolean;
    /**
     * Opened by its own entry (a Welcome row, a supplied Home address), never reached by advancing:
     * it may be the wizard's first step though it takes no place in the sequence.
     */
    directEntry?: boolean;
    kind: WizardStepKind;
    surface: WizardMode;
    canSkip: boolean;
    visibleWhen: (context: WizardContext) => boolean;
}>;

export type WizardResumeState = Readonly<{
    mode: WizardMode;
    stepId: WizardStepId;
    relaySelection: WizardRelaySelection;
    authIntent: WizardAuthIntent;
}>;

export type WizardState = Readonly<{
    context: WizardContext;
    currentStepId: WizardStepId;
    history: readonly WizardStepId[];
    resumeState: WizardResumeState | null;
}>;

export type WizardAction =
    | Readonly<{ type: 'wizard/advance' }>
    | Readonly<{ type: 'wizard/back' }>
    | Readonly<{ type: 'wizard/goToStep'; stepId: WizardStepId }>
    | Readonly<{ type: 'wizard/setResumeState'; resumeState: WizardResumeState | null }>
    | Readonly<{ type: 'wizard/setRelaySelection'; relaySelection: WizardRelaySelection }>
    | Readonly<{ type: 'wizard/setRelayAccessProviderId'; providerId: RelayAccessProviderId | null }>
    | Readonly<{ type: 'wizard/setRelaySwitchConfirmationPending'; pending: boolean }>
    | Readonly<{ type: 'wizard/setAuthIntent'; authIntent: WizardAuthIntent }>;
