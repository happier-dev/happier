import { describe, expect, it } from 'vitest';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';

import {
    resolveStoredVoiceProviderId,
    resolveVoiceProviderId,
    resolveVoiceProviderIdForBindingScope,
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

    it('keeps qualified realtime and off provider resolution unchanged', () => {
        expect(resolveVoiceProviderId('happier.voice.elevenlabs/realtime-elevenlabs'))
            .toBe('happier.voice.elevenlabs/realtime-elevenlabs');
        expect(resolveVoiceProviderId('off')).toBe(null);
        expect(resolveStoredVoiceProviderId('future.vendor/conversation')).toBe('future.vendor/conversation');
        expect(resolveVoiceProviderId('future.vendor/conversation')).toBe(null);
        expect(resolveStoredVoiceProviderId('future.vendor//conversation')).toBe(null);
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

    it('admits an Agent-session provider for an exact session while keeping its missing global binding fail-closed', () => {
        const settings = voiceSettingsParse({
            providerId: 'happier.agent.codex/realtime-codex',
            providers: {
                'happier.agent.codex/realtime-codex': {
                    schemaVersion: 2,
                    config: { globalConnectedServices: null },
                },
            },
        });

        expect(resolveVoiceProviderIdForBindingScope(settings, 'session')).toBe('happier.agent.codex/realtime-codex');
        expect(resolveVoiceProviderIdForBindingScope(settings, 'global')).toBe(null);
        expect(resolveVoiceProviderIdFromSettings(settings)).toBe(null);
    });

    it('uses typed Agent-session execution metadata instead of a provider-id special case', () => {
        const builtInRegistry = createDefaultVoiceProviderRegistry();
        const codexEntry = builtInRegistry.get('happier.agent.codex/realtime-codex');
        if (!codexEntry) throw new Error('missing realtime Codex fixture');
        const providerId = 'fixture.voice/realtime-agent-session';
        const fixtureEntry = Object.freeze({
            ...codexEntry,
            providerId,
        });
        const registry: VoiceProviderRegistry = {
            get: (candidateProviderId) => candidateProviderId === providerId ? fixtureEntry : null,
            list: () => [fixtureEntry],
        };
        const settings = voiceSettingsParse({
            providerId,
            providers: {
                [providerId]: {
                    schemaVersion: 2,
                    config: { globalConnectedServices: null },
                },
            },
        });

        expect(resolveVoiceProviderIdForBindingScope(settings, 'session', registry)).toBe(providerId);
        expect(resolveVoiceProviderIdForBindingScope(settings, 'global', registry)).toBe(null);
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
                            provider: 'happier.voice.openai-compat/stt',
                        },
                        tts: { provider: 'device', autoSpeakReplies: false },
                    },
                },
            },
        });

        expect(resolveVoiceProviderIdFromSettings(settings)).toBe('local_conversation');
    });
});
