import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Platform } from 'react-native';
import type { LocalNeuralExecution } from '@happier-dev/protocol';

import {
    readLocalConversationVoiceSettings,
    readLocalDirectVoiceSettings,
    voiceSettingsDefaults,
    writeLocalConversationVoiceSettings,
    writeLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import * as voiceSettings from '@/sync/domains/settings/voiceSettings';
import { getLocalSttProviderSpec } from '@/voice/settings/panels/localStt/providers/registry';
import { getLocalTtsProviderSpec } from '@/voice/settings/panels/localTts/providers/registry';

import { buildVoiceConversationsPipeline, buildVoiceDictationPipeline } from './voicePipelineSteps';

const machine = { machineId: 'machine-a', machineLabel: 'Computer' };
const blocked: VoiceRoleReadiness = {
    role: 'conversation_tts', providerId: 'local_conversation', status: 'needs_setup',
    code: 'credential_missing', reasonKey: 'voice.readiness.credential_missing', recoveryAction: 'configure_credential',
};

describe('local Voice pipeline', () => {
    it('projects speech engine labels in the current locale after module initialization', async () => {
        const { t, getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings } = await import('@/text');
        const original = getPreferredLanguage();
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('en');
        const stt = getLocalSttProviderSpec('local_neural');
        const tts = getLocalTtsProviderSpec('local_neural');
        try {
            setPreferredLanguageFromSettings('fr');
            expect(stt?.title).toBe(t('settingsVoice.local.localNeuralStt.provider.title'));
            expect(tts?.title).toBe(t('settingsVoice.local.localNeuralTts.provider.title'));
        } finally { setPreferredLanguageFromSettings(original); }
    });

    it('gets explicit neural execution placement from the selected speech specs', () => {
        for (const spec of [getLocalSttProviderSpec('local_neural'), getLocalTtsProviderSpec('local_neural')]) {
            expect(spec?.resolvePreferredExecution?.('daemon')).toBe('daemon');
            expect(spec?.resolvePreferredExecution?.('device')).toBe('device');
        }
    });

    it.each([
        { platform: 'web', execution: null, placement: 'machine' },
        { platform: 'ios', execution: null, placement: 'this_device' },
        { platform: 'android', execution: 'auto', placement: 'this_device' },
        { platform: 'web', execution: 'device', placement: 'this_device' },
        { platform: 'ios', execution: 'daemon', placement: 'machine' },
    ] satisfies Array<{ platform: string; execution: LocalNeuralExecution | null; placement: string }>)
    ('keeps $platform/$execution speech placement for Conversations and Dictation', ({ platform, execution, placement }) => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: platform, configurable: true });
        try {
            const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
            const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults, providerId: 'local_conversation' }, {
                ...cfg,
                stt: { ...cfg.stt, provider: 'local_neural', localNeural: { ...cfg.stt.localNeural, execution: execution ?? 'auto' } },
                tts: { ...cfg.tts, provider: 'local_neural', localNeural: { ...cfg.tts.localNeural, execution: execution ?? 'auto' } },
            });
            const conversation = buildVoiceConversationsPipeline({ voice, machine, serviceTitle: 'Local', readiness: null });
            expect([conversation?.pipeline.steps[0]?.placement.kind, conversation?.pipeline.steps[2]?.placement.kind])
                .toEqual([placement, placement]);
            const dictation = buildVoiceDictationPipeline({
                sttProviderId: 'local_neural', sttTitle: 'Speech model', localNeuralExecution: execution,
                readiness: null, machine,
            });
            expect(dictation.steps[0]?.placement.kind).toBe(placement);
            if (placement === 'machine') expect(dictation.steps[0]?.placement).toEqual({ kind: 'machine', machineId: 'machine-a', machineName: 'Computer' });
        } finally {
            Object.defineProperty(Platform, 'OS', { value: previous, configurable: true });
        }
    });

    it('puts the supplied Think prerequisite and recovery on its step while retaining speech facts', () => {
        const voice = { ...voiceSettingsDefaults, providerId: 'local_conversation' };
        // Multiple readiness consumers share an already-normalized Voice setting.
        const normalize = vi.spyOn(voiceSettings, 'voiceSettingsParse');
        onTestFinished(() => normalize.mockRestore());
        const think: VoiceRoleReadiness = {
            ...blocked, role: 'conversation_stt', code: 'server_feature_disabled',
            status: 'unavailable', reasonKey: 'voice.readiness.server_feature_disabled', recoveryAction: 'switch_provider',
        };
        const hear: VoiceRoleReadiness = { ...blocked, providerId: 'device', status: 'ready', code: 'ready', reasonKey: 'voice.readiness.ready', recoveryAction: 'none' };
        const result = buildVoiceConversationsPipeline({
            voice, machine, serviceTitle: 'Local', readiness: think,
            localSpeechReadiness: { hear, speak: null }, localThinkReadiness: think,
        });
        expect(result?.pipeline.steps.map(step => step.readiness)).toEqual([hear, think, null]);
        expect(result?.cardReadiness).toEqual(think);
        expect(normalize).not.toHaveBeenCalled();
    });

    it('does not fill explicitly withheld speech facts from aggregate readiness', () => {
        const voice = { ...voiceSettingsDefaults, providerId: 'local_conversation' };
        const ready: VoiceRoleReadiness = { ...blocked, status: 'ready', code: 'ready', reasonKey: 'voice.readiness.ready', recoveryAction: 'none' };
        const withheld = buildVoiceConversationsPipeline({ voice, machine, serviceTitle: 'Local', readiness: ready, localSpeechReadiness: null });
        expect(withheld?.pipeline.steps.map((step) => step.readiness)).toEqual([null, ready, null]);
        const partiallyKnown = buildVoiceConversationsPipeline({ voice, machine, serviceTitle: 'Local', readiness: ready, localSpeechReadiness: { hear: ready, speak: null } });
        expect(partiallyKnown?.pipeline.steps.map((step) => step.readiness)).toEqual([ready, ready, null]);
        const omitted = buildVoiceConversationsPipeline({ voice, machine, serviceTitle: 'Local', readiness: ready });
        expect(omitted?.pipeline.steps.map((step) => step.readiness)).toEqual([ready, ready, ready]);
        const unknownThink = buildVoiceConversationsPipeline({ voice, machine, serviceTitle: 'Local', readiness: ready,
            localSpeechReadiness: { hear: ready, speak: ready }, localThinkReadiness: null });
        expect(unknownThink?.pipeline.steps.map((step) => step.readiness)).toEqual([ready, null, ready]);
    });

    it('keeps known Hear readiness while Speak blocks the aggregate and Think is unknown', () => {
        const voice = { ...voiceSettingsDefaults, providerId: 'local_conversation' };
        const hear: VoiceRoleReadiness = {
            role: 'conversation_stt', providerId: 'device', status: 'ready', code: 'ready',
            reasonKey: 'voice.readiness.ready', recoveryAction: 'none',
        };
        const speak = { ...blocked, providerId: 'happier.voice.google/google-cloud-tts' };
        const result = buildVoiceConversationsPipeline({
            voice, machine, serviceTitle: 'Local', readiness: blocked,
            localSpeechReadiness: { hear, speak },
        });
        expect(result?.pipeline.steps.map((step) => step.readiness)).toEqual([hear, null, speak]);
        expect(result?.cardReadiness).toEqual(blocked);
    });

    it('reads the retained direct adapter selection instead of the conversation adapter', () => {
        const conversation = readLocalConversationVoiceSettings(voiceSettingsDefaults);
        const direct = readLocalDirectVoiceSettings(voiceSettingsDefaults);
        const voice = writeLocalDirectVoiceSettings(writeLocalConversationVoiceSettings({
            ...voiceSettingsDefaults, providerId: 'local_direct',
        }, { ...conversation, conversationMode: 'agent', stt: { ...conversation.stt, provider: 'local_neural' } }), {
            ...direct, stt: { ...direct.stt, provider: 'device' }, tts: { ...direct.tts, provider: 'device' },
        });
        const result = buildVoiceConversationsPipeline({ voice, machine, serviceTitle: 'Local', readiness: null });
        expect(result?.pipeline.steps.map((step) => step.engine.kind)).toEqual(['speech', 'session', 'speech']);
        expect(result?.pipeline.steps[0]?.engine.providerId).toBe('device');
        expect(result?.pipeline.steps[2]?.engine.providerId).toBe('device');
    });
});

describe('realtime service pipeline', () => {
    it('draws the service step with the identity mark its presentation declares', async () => {
        const { projectBundledVoiceManifestContributions } = await import('@/voice/registry/bundledVoiceManifestProjection');
        const { createVoiceProviderRegistry } = await import('@/voice/registry/providerRegistry');
        const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/elevenlabs/src/manifest');
        const { VOICE_PROVIDER_PRESENTATIONS } = await import('../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries');
        const registry = createVoiceProviderRegistry({ bundledContributions: projectBundledVoiceManifestContributions(PLUGIN_MANIFEST), bundledPresentations: VOICE_PROVIDER_PRESENTATIONS });
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const result = buildVoiceConversationsPipeline({
            voice: { ...voiceSettingsDefaults, providerId }, machine, serviceTitle: 'ElevenLabs Voice', readiness: null, registry,
        });
        expect(result?.pipeline.steps[0]?.engine).toMatchObject({ kind: 'service', providerId, mark: { kind: 'icon', name: 'waveform' } });
    });
});
