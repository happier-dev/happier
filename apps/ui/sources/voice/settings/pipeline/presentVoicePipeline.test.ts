import { describe, expect, it } from 'vitest';

import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { projectVoiceSettingsPipeline } from '@/voice/settings/projectVoiceSettingsPipeline';

import { t } from '@/text';

import { presentVoicePipeline, resolveVoiceReadinessTone } from './presentVoicePipeline';

const translate = (key: string) => key;

function readiness(status: VoiceRoleReadiness['status'], code: string, recoveryAction: VoiceRoleReadiness['recoveryAction'] = 'none'): VoiceRoleReadiness {
    return { role: 'conversation_tts', providerId: 'p', status, code, reasonKey: `voice.readiness.${code}`, recoveryAction };
}

const hear = { roles: ['hear'] as const, engine: { kind: 'speech' as const, title: 'Whisper' }, placement: { kind: 'machine' as const, machineName: 'devbox' } };
const think = { roles: ['think'] as const, engine: { kind: 'agent' as const, title: 'Claude Code' }, placement: { kind: 'machine' as const, machineName: 'devbox' } };
const speak = { roles: ['speak'] as const, engine: { kind: 'speech' as const, title: 'Kokoro' }, placement: { kind: 'machine' as const, machineName: 'devbox' } };

describe('resolveVoiceReadinessTone', () => {
    it('needs the person only for the option they chose; an unchosen option that needs setup stays quiet', () => {
        const fact = readiness('needs_setup', 'settings_missing_required_setting', 'open_provider_settings');
        expect(resolveVoiceReadinessTone(fact)).toBe('needs_you');
        expect(resolveVoiceReadinessTone(fact, { chosen: true })).toBe('needs_you');
        expect(resolveVoiceReadinessTone(fact, { chosen: false })).toBe('needs_setup');
        // Facts that are not the person's to fix keep their own tone either way.
        expect(resolveVoiceReadinessTone(readiness('unavailable', 'server_feature_disabled'), { chosen: false })).toBe('waiting');
        expect(resolveVoiceReadinessTone(readiness('ready', 'ready'), { chosen: false })).toBe('ready');
    });
});

describe('presentVoicePipeline', () => {
    it('uses the blocked tone for an incompatible or failed pack, including the aggregate', () => {
        const fact = readiness('incompatible', 'model_incompatible', 'install_model');
        const pipeline = projectVoiceSettingsPipeline({ mode: 'dictation', providerId: 'p', steps: [{ ...hear, readiness: fact }] });
        const presented = presentVoicePipeline(pipeline, translate);
        expect(presented.steps[0]?.readiness?.tone).toBe('blocked');
        expect(presented.tone).toBe('blocked');
    });

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

    it('says a fact once when the service-level readiness is the same fact a step already shows', () => {
        const fact = readiness('needs_setup', 'runtime_missing', 'switch_provider');
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...hear, readiness: null },
            { ...think, readiness: fact },
        ] });
        const presented = presentVoicePipeline(pipeline, translate, fact, 'Local voice');
        expect(presented.steps[1]?.readiness).toMatchObject({ recoveryAction: 'switch_provider' });
        expect(presented.card).toBeNull();
        expect(presented.statusWord).toBe(t('settingsVoice.pages.pipeline.needsYou'));
    });

    it('keeps a service-level fact no step carries', () => {
        const fact = readiness('needs_setup', 'runtime_missing', 'switch_provider');
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...hear, readiness: null },
            { ...think, readiness: readiness('needs_setup', 'model_missing', 'install_model') },
        ] });
        expect(presentVoicePipeline(pipeline, translate, fact, 'Local voice').card).toMatchObject({ recoveryAction: 'switch_provider' });
    });

    it.each(['runtime_unknown', 'model_unknown', 'credential_unknown'])(
        'presents an unobserved %s as unchecked without asking the person to repair it', (code) => {
            const fact = readiness('unavailable', code, 'switch_provider');
            const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
                { ...hear, readiness: null },
                { ...think, readiness: fact },
                { ...speak, readiness: null },
            ] });
            const presented = presentVoicePipeline(pipeline, translate, fact, 'Local voice');
            expect(presented.tone).toBe('unknown');
            expect(presented.statusWord).toBe(t('settingsVoice.pages.pipeline.notChecked'));
            expect(presented.steps.every(step => step.readiness === null)).toBe(true);
            expect(presented.card).toBeNull();
        },
    );

    it('retains Retry for withdrawn Machine presence while unobserved service checks stay quiet', () => {
        const fact = readiness('unavailable', 'execution_machine_unknown', 'retry');
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...hear, readiness: fact },
        ] });
        const presented = presentVoicePipeline(pipeline, translate, fact, 'Local voice');
        expect(presented.tone).toBe('waiting');
        expect(presented.steps[0]?.readiness).toMatchObject({
            tone: 'waiting', recoveryAction: 'retry', actionLabel: 'common.retry',
        });
        expect(presented.card).toBeNull();
    });

    it('keeps an unobserved service prerequisite unknown even when all observed steps are ready', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'conversations', providerId: 'p', steps: [
            { ...hear, readiness: readiness('ready', 'ready') },
            { ...think, readiness: readiness('ready', 'ready') },
            { ...speak, readiness: readiness('ready', 'ready') },
        ] });
        const presented = presentVoicePipeline(pipeline, translate,
            readiness('unavailable', 'runtime_unknown', 'switch_provider'), 'Local voice');
        expect(presented.tone).toBe('unknown');
        expect(presented.statusWord).toBe(t('settingsVoice.pages.pipeline.notChecked'));
        expect(presented.card).toBeNull();
    });

    it('never calls an unchecked pipeline ready', () => {
        const pipeline = projectVoiceSettingsPipeline({ mode: 'dictation', providerId: 'p', steps: [{ ...hear, readiness: null }] });
        const presented = presentVoicePipeline(pipeline, translate);
        expect(presented.tone).toBe('unknown');
        expect(presented.statusWord).toBe(t('settingsVoice.pages.pipeline.notChecked'));
    });
});
