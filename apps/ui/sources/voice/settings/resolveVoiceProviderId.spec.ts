import { describe, expect, it } from 'vitest';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

import {
    resolveStoredVoiceProviderId,
    resolveVoiceProviderId,
    resolveVoiceProviderIdFromSettings,
} from './resolveVoiceProviderId';

describe('resolveVoiceProviderId', () => {
    it('preserves the stored local provider id for settings and fallback configuration', () => {
        expect(resolveStoredVoiceProviderId(' local_conversation ')).toBe('local_conversation');
        expect(resolveVoiceProviderId(' local_conversation ')).toBe('local_conversation');
    });

    it('preserves local providers instead of applying platform fallback rewrites', () => {
        expect(resolveVoiceProviderId('local_direct')).toBe('local_direct');
        expect(resolveVoiceProviderId(' local_conversation ')).toBe('local_conversation');
    });

    it('keeps realtime and off provider resolution unchanged', () => {
        expect(resolveVoiceProviderId('realtime_elevenlabs')).toBe('realtime_elevenlabs');
        expect(resolveVoiceProviderId('off')).toBe(null);
        expect(resolveStoredVoiceProviderId('future_vendor')).toBe('future_vendor');
        expect(resolveVoiceProviderId('future_vendor')).toBe(null);
    });

    it('fails runtime selection closed for an unsupported known-provider settings version', () => {
        const supported = voiceSettingsParse({ providerId: 'local_conversation' });
        expect(resolveVoiceProviderIdFromSettings(supported)).toBe('local_conversation');

        const unsupported = voiceSettingsParse({
            providerId: 'local_conversation',
            providers: {
                local_conversation: { schemaVersion: 9, config: { future: true } },
            },
        });
        expect(resolveStoredVoiceProviderId(unsupported.providerId)).toBe('local_conversation');
        expect(resolveVoiceProviderIdFromSettings(unsupported)).toBe(null);
    });

    it('fails runtime selection closed for malformed known-provider config', () => {
        const malformed = voiceSettingsParse({
            providerId: 'local_conversation',
            providers: {
                local_conversation: {
                    schemaVersion: 1,
                    config: { conversationMode: 'not-a-real-mode' },
                },
            },
        });

        expect(resolveStoredVoiceProviderId(malformed.providerId)).toBe('local_conversation');
        expect(resolveVoiceProviderIdFromSettings(malformed)).toBe(null);
    });

    it('accepts the canonical local media QA provider envelope', () => {
        const settings = voiceSettingsParse({
            providerId: 'local_conversation',
            assistantLanguage: 'en',
            providers: {
                local_conversation: {
                    schemaVersion: 1,
                    config: {
                        conversationMode: 'direct_session',
                        handsFree: { enabled: false },
                        stt: {
                            provider: 'openai_compat',
                            openaiCompat: {
                                baseUrl: 'http://127.0.0.1:12345/v1',
                                apiKey: null,
                                model: 'whisper-1',
                            },
                        },
                        tts: { provider: 'device', autoSpeakReplies: false },
                    },
                },
            },
        });

        expect(resolveVoiceProviderIdFromSettings(settings)).toBe('local_conversation');
    });
});
