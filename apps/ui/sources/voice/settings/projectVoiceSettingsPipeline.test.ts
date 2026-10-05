import { describe, expect, it } from 'vitest';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { projectVoiceSettingsPipeline } from './projectVoiceSettingsPipeline';

const ready: VoiceRoleReadiness = {
    role: 'realtime_conversation', providerId: 'test.service', status: 'ready', code: 'ready',
    reasonKey: 'voice.readiness.ready', recoveryAction: 'none',
};
const engine = { kind: 'service', providerId: 'test.service', title: 'Service' } as const;
const placement = { kind: 'cloud' } as const;

describe('Voice settings pipeline', () => {
    it('combines a service owning Hear, Think and Speak without losing a repair prerequisite', () => {
        const blocked = { ...ready, status: 'needs_setup', code: 'credential_missing', recoveryAction: 'configure_credential' } as const;
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: engine.providerId, steps: [
            { roles: ['hear'], engine, placement, readiness: ready },
            { roles: ['think'], engine, placement, readiness: blocked },
            { roles: ['speak'], engine, placement, readiness: ready },
        ] });
        expect(pipeline.steps).toHaveLength(1);
        expect(pipeline.steps[0]).toMatchObject({ roles: ['hear', 'think', 'speak'], readiness: blocked });
        expect(pipeline.readiness).toEqual(blocked);
    });

    it('keeps Dictation destination distinct and never turns unknown readiness into success', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'dictation', providerId: 'test.speech', steps: [
            { roles: ['hear'], engine: { kind: 'speech', providerId: 'test.speech', title: 'Speech' }, placement: { kind: 'machine', machineId: 'offline' }, readiness: null },
            { roles: ['write'], engine: { kind: 'message', title: 'Message' }, placement: { kind: 'message' }, readiness: null },
        ] });
        expect(pipeline.steps).toHaveLength(2);
        expect(pipeline.steps[0]?.placement).toEqual({ kind: 'machine', machineId: 'offline' });
        expect(pipeline.readiness).toBeNull();
    });
});
