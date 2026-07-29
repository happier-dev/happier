import { describe, expect, it } from 'vitest';

import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { VoiceLocalTtsSchema } from '@/sync/domains/settings/voiceLocalTtsSettings';
import { VoiceLocalConversationSchema } from '@/voice/adapters/localConversation/settings';

describe('OpenAI-compatible voice settings compatibility', () => {
  it('persists machine-bound exact-origin consent independently for chat, STT, and TTS', () => {
    expect(VoiceLocalSttSchema.parse({
      provider: 'openai_compat',
      openaiCompat: {
        baseUrl: 'http://localhost:11434/v1',
        insecureLocalOriginConsent: 'http://localhost:11434',
        insecureLocalConsentMachineId: 'machine-a',
      },
    }).openaiCompat).toMatchObject({
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
    });
    expect(VoiceLocalTtsSchema.parse({
      provider: 'openai_compat',
      openaiCompat: {
        baseUrl: 'http://localhost:11434/v1',
        insecureLocalOriginConsent: 'http://localhost:11434',
        insecureLocalConsentMachineId: 'machine-a',
      },
    }).openaiCompat).toMatchObject({
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
    });
    expect(VoiceLocalConversationSchema.parse({
      agent: {
        openaiCompat: {
          chatBaseUrl: 'http://localhost:11434/v1',
          insecureLocalOriginConsent: 'http://localhost:11434',
          insecureLocalConsentMachineId: 'machine-a',
        },
      },
    }).agent.openaiCompat).toMatchObject({
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: 'machine-a',
    });
  });

  it('keeps legacy origin-only consent unbound so runtime migration fails closed', () => {
    const parsed = VoiceLocalSttSchema.parse({
      provider: 'openai_compat',
      openaiCompat: {
        baseUrl: 'http://localhost:11434/v1',
        insecureLocalOriginConsent: 'http://localhost:11434',
      },
    });
    expect(parsed.openaiCompat).toMatchObject({
      insecureLocalOriginConsent: 'http://localhost:11434',
      insecureLocalConsentMachineId: null,
    });
  });

  it('keeps encrypted legacy credentials as read-only migration inputs', () => {
    const legacySecret = { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext' } };
    const parsed = VoiceLocalSttSchema.parse({
      provider: 'openai_compat',
      openaiCompat: { apiKey: legacySecret },
    });
    expect(parsed.openaiCompat.apiKey).toEqual(legacySecret);
  });
});
