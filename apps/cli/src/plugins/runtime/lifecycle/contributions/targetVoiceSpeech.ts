import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { SpeechProviderRuntime } from '@happier-dev/plugin-sdk/voice/speech';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';
import type { ResolvedVoiceProviderContribution } from '@/plugins/projection/registry/types';
import type { VoiceSpeechEndpointPolicy } from '@happier-dev/protocol';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

export type TargetVoiceSpeechRuntime = Readonly<{
    generation: string;
    qualifiedId: string;
    runtime: SpeechProviderRuntime;
    contribution: Extract<ResolvedVoiceProviderContribution['definition'], { kind: 'speech' }>;
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
    createHttp(
        signal: AbortSignal,
        isOperationCurrent?: () => boolean,
        endpointPolicy?: VoiceSpeechEndpointPolicy | null,
    ): Pick<HttpService, 'request'>;
}>;

type VoiceSpeechGenerationLifecycle = Readonly<{
    isCurrent(): boolean;
    retirementSignal: AbortSignal;
}>;

/**
 * Family adapter over the activation manager's authoritative target
 * registrations. It owns neither a second registry nor a second generation
 * decision.
 */
export function createTargetVoiceSpeechRegistry(params: Readonly<{
    generation: number;
    voiceProviders: readonly ResolvedVoiceProviderContribution[];
    targetRegistrations: readonly TargetRegistration[];
    resolveGenerationLifecycle(pluginId: string): VoiceSpeechGenerationLifecycle;
    createHttp(input: Readonly<{
        pluginId: string;
        localId: string;
        generation: string;
        signal: AbortSignal;
        endpointPolicy: VoiceSpeechEndpointPolicy | null;
        isCurrent(): boolean;
    }>): Pick<HttpService, 'request'>;
}>): Readonly<{
    read(ref: Readonly<{ pluginId: string; localId: string }>): TargetVoiceSpeechRuntime | null;
}> {
    const declarations = new Map(params.voiceProviders.map((provider) => [
        `${provider.pluginId}/${provider.identity.localId}`,
        provider,
    ]));
    return Object.freeze({
        read(ref) {
            const declaration = declarations.get(`${ref.pluginId}/${ref.localId}`);
            if (!declaration || declaration.definition.kind !== 'speech') return null;
            const entry = [...params.targetRegistrations].reverse().find((candidate) => (
                candidate.pluginId === ref.pluginId
                && candidate.generation === String(params.generation)
                && candidate.registration.family === 'voiceProviders'
                && candidate.registration.localId === ref.localId
            ));
            if (
                !entry
                || entry.registration.family !== 'voiceProviders'
                || entry.registration.value.kind !== 'speech'
            ) return null;
            const lifecycle = params.resolveGenerationLifecycle(ref.pluginId);
            return Object.freeze({
                generation: entry.generation,
                qualifiedId: `${ref.pluginId}/${ref.localId}`,
                runtime: entry.registration.value,
                contribution: declaration.definition,
                isCurrent: () => (
                    lifecycle.isCurrent()
                    && params.targetRegistrations.includes(entry)
                ),
                retirementSignal: lifecycle.retirementSignal,
                createHttp: (signal, isOperationCurrent = () => true, endpointPolicy = null) => params.createHttp({
                    pluginId: ref.pluginId,
                    localId: ref.localId,
                    generation: entry.generation,
                    signal,
                    endpointPolicy,
                    isCurrent: () => (
                        lifecycle.isCurrent()
                        && params.targetRegistrations.includes(entry)
                        && isOperationCurrent()
                    ),
                }),
            });
        },
    });
}
