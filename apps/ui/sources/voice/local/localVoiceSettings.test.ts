import { describe, expect, it } from 'vitest';

import { isReadAloudAvailable, isVoiceBargeInEnabled } from './localVoiceSettings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

describe('isVoiceBargeInEnabled', () => {
    it('follows the settings schema default (on) when bargeInEnabled is unset', () => {
        const settings = { voice: voiceSettingsParse({ providerId: 'local_conversation' }) };
        expect(isVoiceBargeInEnabled(settings)).toBe(true);
    });

    it('is off only when explicitly disabled', () => {
        const settings = { voice: voiceSettingsParse({ providerId: 'local_conversation', adapters: { local_conversation: { tts: { bargeInEnabled: false } } } }) };
        expect(isVoiceBargeInEnabled(settings)).toBe(false);
    });
});

describe('isReadAloudAvailable', () => {
    const withTts = (providerId: string, tts: Record<string, unknown>) => ({
        voice: voiceSettingsParse({ providerId, adapters: { local_conversation: { tts }, local_direct: { tts } } }),
    });

    it('is hidden for the realtime provider, even with a local TTS configured', () => {
        expect(isReadAloudAvailable(withTts('realtime_elevenlabs', { provider: 'local_neural' }))).toBe(false);
    });

    it.each(['local_direct', 'local_conversation'])('is available for %s with the system voice', (providerId) => {
        expect(isReadAloudAvailable(withTts(providerId, { provider: 'device' }))).toBe(true);
    });

    it('is available for Kokoro', () => {
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'local_neural' }))).toBe(true);
    });

    it('needs a base URL for OpenAI-compatible TTS', () => {
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'openai_compat' }))).toBe(false);
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'openai_compat', openaiCompat: { baseUrl: '   ' } }))).toBe(false);
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'openai_compat', openaiCompat: { baseUrl: 'http://localhost:8880/v1' } }))).toBe(true);
    });

    it('needs an API key for Google Cloud TTS', () => {
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'google_cloud' }))).toBe(false);
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'google_cloud', googleCloud: { apiKey: { _isSecretValue: true, value: '   ' } } }))).toBe(false);
        expect(isReadAloudAvailable(withTts('local_conversation', { provider: 'google_cloud', googleCloud: { apiKey: { _isSecretValue: true, value: 'k' } } }))).toBe(true);
    });
});
