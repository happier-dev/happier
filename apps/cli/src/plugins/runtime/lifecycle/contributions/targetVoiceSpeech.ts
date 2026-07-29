import type { PluginVoiceSpeechRuntimeRegistration } from '@happier-dev/plugin-sdk/runtime';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

export type TargetVoiceSpeechRuntime = Readonly<{
    generation: string;
    qualifiedId: string;
    runtime: PluginVoiceSpeechRuntimeRegistration;
    isCurrent(): boolean;
}>;

/**
 * Family adapter over the activation manager's authoritative target
 * registrations. It owns neither a second registry nor a second generation
 * decision.
 */
export function createTargetVoiceSpeechRegistry(params: Readonly<{
    generation: number;
    targetRegistrations: readonly TargetRegistration[];
    isGenerationActive(pluginId: string): boolean;
}>): Readonly<{
    read(ref: Readonly<{ pluginId: string; localId: string }>): TargetVoiceSpeechRuntime | null;
}> {
    return Object.freeze({
        read(ref) {
            const entry = [...params.targetRegistrations].reverse().find((candidate) => (
                candidate.pluginId === ref.pluginId
                && candidate.generation === String(params.generation)
                && candidate.registration.family === 'voiceProviders.speech'
                && candidate.registration.localId === ref.localId
            ));
            if (!entry || entry.registration.family !== 'voiceProviders.speech') return null;
            return Object.freeze({
                generation: entry.generation,
                qualifiedId: `${ref.pluginId}/${ref.localId}`,
                runtime: entry.registration.value,
                isCurrent: () => (
                    params.isGenerationActive(ref.pluginId)
                    && params.targetRegistrations.includes(entry)
                ),
            });
        },
    });
}
