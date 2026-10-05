import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import type { VoiceServiceMark } from '@happier-dev/plugin-sdk/voice';

export type VoiceSettingsPipelineStep = Readonly<{
    roles: readonly ('hear' | 'think' | 'speak' | 'write')[];
    engine: Readonly<{ kind: 'service' | 'speech' | 'agent' | 'session' | 'message'; title: string; providerId?: string; agentId?: string; /** A service's public identity declaration. */ mark?: VoiceServiceMark }>;
    placement: Readonly<{ kind: 'this_device' | 'machine' | 'cloud' | 'session' | 'message'; machineId?: string; machineName?: string; /** Message placement: the language text is written in; null is automatic. */ language?: string | null }>;
    /** Exactly the selected role's canonical readiness; null means not established, not ready. */
    readiness: VoiceRoleReadiness | null;
    progress?: Readonly<{ done: number; total: number }> | null;
}>;

export type VoiceSettingsPipeline = Readonly<{
    mode: 'dictation' | 'conversations';
    providerId: string | null;
    steps: readonly VoiceSettingsPipelineStep[];
    readiness: VoiceRoleReadiness | null;
}>;

/** Rendering projection only: callers supply the canonical selected-role facts, never probe here. */
export function projectVoiceSettingsPipeline(input: Omit<VoiceSettingsPipeline, 'readiness'>): VoiceSettingsPipeline {
    const steps: VoiceSettingsPipelineStep[] = [];
    for (const step of input.steps) {
        const previous = steps.at(-1);
        const sameService = previous?.engine.kind === 'service' && step.engine.kind === 'service'
            && Boolean(step.engine.providerId) && previous.engine.providerId === step.engine.providerId
            && previous.placement.kind === step.placement.kind
            && previous.placement.machineId === step.placement.machineId;
        if (sameService && previous) {
            steps[steps.length - 1] = {
                ...previous,
                roles: [...new Set([...previous.roles, ...step.roles])],
                readiness: combineReadiness([previous.readiness, step.readiness]),
                progress: previous.progress ?? step.progress,
            };
        } else {
            steps.push(step);
        }
    }
    return {
        ...input,
        steps,
        readiness: combineReadiness(steps.filter((step) => step.roles.some((role) => role !== 'write')).map((step) => step.readiness)),
    };
}

function combineReadiness(facts: readonly (VoiceRoleReadiness | null)[]): VoiceRoleReadiness | null {
    const blocked = facts.find((fact) => fact && fact.status !== 'ready');
    if (blocked) return blocked;
    if (facts.some((fact) => fact === null)) return null;
    return facts[0] ?? null;
}
