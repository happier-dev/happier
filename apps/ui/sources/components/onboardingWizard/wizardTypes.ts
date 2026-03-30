import type { TranslationKey } from '@/text';

export type WizardMode = 'onboarding' | 'setup';

export type WizardPlatform = 'web' | 'native' | 'desktop';

export type WizardStepId =
    | 'welcome'
    | 'scan_code'
    | 'relay_select'
    | 'relay_enter_url'
    | 'auth'
    | 'auth_restore'
    | 'auth_lost_access'
    | 'setup_chooser'
    | 'setup_this_computer'
    | 'host_relay_local'
    | 'host_relay_remote'
    | 'confirm_switch_relay'
    | 'secure_access_tailscale'
    | 'remote_ssh_setup'
    | 'providers_optional'
    | 'done';

export type WizardRelayChoiceId = 'cloud' | 'thisMac' | 'customUrl';

export type WizardRelaySelection = Readonly<{
    choiceId: WizardRelayChoiceId | null;
    serverUrl: string | null;
    locked: boolean;
}>;

export type WizardAuthIntent = 'standard' | 'restore' | 'lost_access';

export type WizardContext = Readonly<{
    mode: WizardMode;
    platform: WizardPlatform;
    canScanQr: boolean;
    scanStepEnabled: boolean;
    canRunSystemTasks: boolean;
    relaySelection: WizardRelaySelection;
    authIntent: WizardAuthIntent;
    setupAction: 'local' | 'remote' | 'tailscale' | null;
}>;

export type WizardStepKind = 'entry' | 'choice' | 'auth' | 'recovery' | 'setup' | 'finish';

export type WizardStepDefinition = Readonly<{
    id: WizardStepId;
    titleKey: TranslationKey;
    subtitleKey?: TranslationKey;
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
    parsedScanPayload: unknown | null;
}>;

export type WizardAction =
    | Readonly<{ type: 'wizard/advance' }>
    | Readonly<{ type: 'wizard/back' }>
    | Readonly<{ type: 'wizard/goToStep'; stepId: WizardStepId }>
    | Readonly<{ type: 'wizard/setResumeState'; resumeState: WizardResumeState | null }>
    | Readonly<{ type: 'wizard/setParsedScanPayload'; parsedScanPayload: unknown | null }>
    | Readonly<{ type: 'wizard/setRelaySelection'; relaySelection: WizardRelaySelection }>
    | Readonly<{ type: 'wizard/setAuthIntent'; authIntent: WizardAuthIntent }>
    | Readonly<{ type: 'wizard/setSetupAction'; setupAction: 'local' | 'remote' | 'tailscale' | null }>
    | Readonly<{ type: 'wizard/setScanStepEnabled'; enabled: boolean }>;
