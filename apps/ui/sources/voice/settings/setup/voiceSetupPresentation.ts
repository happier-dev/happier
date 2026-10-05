import type { VoiceSetupFacts } from './voiceSetupFacts';

export type VoiceSetupStepId = VoiceSetupFacts['steps'][number]['id'];

/** The step the person is asked for next (current, blocked or working), or null once every step is true. */
export function readVoiceSetupNextStep(facts: VoiceSetupFacts): VoiceSetupFacts['steps'][number] | null {
    return facts.steps.find((step) => step.state !== 'done' && step.state !== 'upcoming') ?? null;
}

/** Daybreak Light for the setup planet: finished steps only, never time or a pending check. */
export function readVoiceSetupLight(facts: VoiceSetupFacts): number {
    return facts.total > 0 ? facts.doneCount / facts.total : 0;
}

/**
 * Partial shade (rose) is failure, not "still to do" (VE-01): a denied microphone or a service that
 * cannot run. A service that only needs setting up keeps the plain night side (lab TS).
 */
export function isVoiceSetupFailed(facts: VoiceSetupFacts): boolean {
    const microphone = facts.steps.find((step) => step.id === 'microphone');
    return microphone?.state === 'blocked'
        || facts.readiness?.status === 'unavailable'
        || facts.readiness?.status === 'incompatible';
}
