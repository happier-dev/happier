import { describe, expect, it } from 'vitest';

import {
    readLocalConversationVoiceSettings,
    readLocalDirectVoiceSettings,
    voiceSettingsDefaults,
    writeLocalConversationVoiceSettings,
    writeLocalDirectVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';

import { buildVoiceConversationsPipeline } from './voicePipelineSteps';

const machine = { machineId: 'machine-a', machineLabel: 'Computer' };
const blocked: VoiceRoleReadiness = {
    role: 'conversation_tts', providerId: 'local_conversation', status: 'needs_setup',
    code: 'credential_missing', reasonKey: 'voice.readiness.credential_missing', recoveryAction: 'configure_credential',
};

describe('local Voice pipeline', () => {
    it('puts the supplied Think prerequisite and recovery on its step while retaining speech facts', () => {
        const voice = { ...voiceSettingsDefaults, providerId: 'local_conversation' };
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
