export type AgentSetupWizardPrimaryPhase = 'select' | 'queue' | 'complete';

export type AgentSetupWizardPrimaryOverride = Readonly<{
    label: string;
    disabled: boolean;
    onPress: () => void | Promise<void>;
}>;

export function buildAgentSetupWizardPrimaryOverride(params: Readonly<{
    phase: AgentSetupWizardPrimaryPhase;
    canStart: boolean;
    hasPendingProviders: boolean;
    labels: Readonly<{ start: string; continue: string; done: string }>;
    start: () => void | Promise<void>;
    continueQueue: () => void;
    finish: () => void;
    onRequestAdvance?: () => void;
}>): AgentSetupWizardPrimaryOverride {
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
