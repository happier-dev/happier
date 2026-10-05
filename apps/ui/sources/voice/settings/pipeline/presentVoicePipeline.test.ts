import { describe, expect, it } from 'vitest';

import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { projectVoiceSettingsPipeline } from '@/voice/settings/projectVoiceSettingsPipeline';

import { t } from '@/text';

import { presentVoicePipeline } from './presentVoicePipeline';

const translate = (key: string) => key;

function readiness(status: VoiceRoleReadiness['status'], code: string, recoveryAction: VoiceRoleReadiness['recoveryAction'] = 'none'): VoiceRoleReadiness {
    return { role: 'conversation_tts', providerId: 'p', status, code, reasonKey: `voice.readiness.${code}`, recoveryAction };
}

const hear = { roles: ['hear'] as const, engine: { kind: 'speech' as const, title: 'Whisper' }, placement: { kind: 'machine' as const, machineName: 'devbox' } };
const think = { roles: ['think'] as const, engine: { kind: 'agent' as const, title: 'Claude Code' }, placement: { kind: 'machine' as const, machineName: 'devbox' } };
const speak = { roles: ['speak'] as const, engine: { kind: 'speech' as const, title: 'Kokoro' }, placement: { kind: 'machine' as const, machineName: 'devbox' } };

describe('presentVoicePipeline', () => {
    it('names the one step that needs the person and the action that fixes it; healthy steps stay quiet', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...hear, readiness: readiness('ready', 'ready') },
            { ...think, readiness: readiness('ready', 'ready') },
            { ...speak, readiness: readiness('needs_setup', 'model_missing', 'install_model') },
        ] });
        const presented = presentVoicePipeline(pipeline, translate);
        expect(presented.tone).toBe('needs_you');
        expect(presented.statusWord).toBe(t('settingsVoice.pages.pipeline.oneStepNeedsYou'));
        expect(presented.steps.map((step) => step.readiness?.tone ?? null)).toEqual([null, null, 'needs_you']);
        expect(presented.steps[2]?.readiness).toMatchObject({ recoveryAction: 'install_model', actionLabel: 'voice.readiness.actions.install_model' });
    });

    it('reads an offline computer or a server-held feature as waiting outside, not as the person’s problem', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...hear, readiness: readiness('needs_setup', 'execution_machine_missing', 'select_execution_machine') },
            { ...think, readiness: readiness('unavailable', 'server_feature_disabled', 'switch_provider') },
        ] });
        const presented = presentVoicePipeline(pipeline, translate);
        expect(presented.steps.map((step) => step.readiness?.tone)).toEqual(['waiting', 'waiting']);
        expect(presented.tone).toBe('waiting');
    });

    it('shows a real install as working with its progress', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...speak, readiness: readiness('installing', 'model_installing', 'install_model'), progress: { done: 28, total: 82 } },
        ] });
        const step = presentVoicePipeline(pipeline, translate).steps[0];
        expect(step?.readiness?.tone).toBe('working');
        expect(step?.readiness?.progress).toBeCloseTo(28 / 82);
    });

    it('never calls an unchecked pipeline ready', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'dictation', providerId: 'p', steps: [{ ...hear, readiness: null }] });
        const presented = presentVoicePipeline(pipeline, translate);
        expect(presented.tone).toBe('unknown');
        expect(presented.statusWord).toBe(t('settingsVoice.pages.pipeline.notChecked'));
    });
});
