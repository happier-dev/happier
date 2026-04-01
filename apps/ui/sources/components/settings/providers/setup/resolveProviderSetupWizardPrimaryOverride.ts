export type ProviderSetupWizardPrimaryPhase = 'select' | 'queue' | 'complete';

export type ProviderSetupWizardPrimaryOverride = Readonly<{
    label: string;
    disabled: boolean;
    onPress: () => void | Promise<void>;
}>;

export function buildProviderSetupWizardPrimaryOverride(params: Readonly<{
    phase: ProviderSetupWizardPrimaryPhase;
    canStart: boolean;
    hasPendingProviders: boolean;
    labels: Readonly<{ start: string; continue: string; done: string }>;
    start: () => void | Promise<void>;
    continueQueue: () => void;
    finish: () => void;
    onRequestAdvance?: () => void;
}>): ProviderSetupWizardPrimaryOverride {
    if (params.phase === 'select') {
        return {
            label: params.labels.start,
            disabled: !params.canStart,
            onPress: async () => {
                if (!params.canStart) return;
                await params.start();
            },
        };
    }

    if (params.phase === 'queue') {
        return {
            label: params.hasPendingProviders ? params.labels.continue : params.labels.done,
            disabled: false,
            onPress: () => {
                params.continueQueue();
            },
        };
    }

    return {
        label: params.labels.done,
        disabled: false,
        onPress: () => {
            params.finish();
            params.onRequestAdvance?.();
        },
    };
}
