import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { VOICE_SPEECH_OUTPUT_MAX_BYTES } from '@happier-dev/plugin-sdk/voice';
import { describe, expect, it } from 'vitest';

import {
  PLUGIN_MANIFEST,
} from './manifest.js';
import {
  OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY,
  OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY,
} from './speechIdentity.js';

describe('OpenAI-compatible batch speech manifest', () => {
  it('declares independent final speech identities and exact daemon environment credential grants', () => {
    expect(parsePluginManifest(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(PLUGIN_MANIFEST.id).toBe('happier.voice.openai-compat');
    expect(OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY).toBe('HAPPIER_VOICE_OPENAI_COMPAT_STT_API_KEY');
    expect(OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY).toBe('HAPPIER_VOICE_OPENAI_COMPAT_TTS_API_KEY');
    expect(PLUGIN_MANIFEST.contributes.voiceProviders.map((contribution) => ({
      id: contribution.id,
      slot: contribution.credentials.slot.id,
      grants: contribution.credentials.sources[0]?.rawGrants,
    }))).toEqual([
      {
        id: 'stt',
        slot: 'api_key',
        grants: [{
          realm: 'daemon',
          phase: 'speech',
          request: {
            kind: 'environment',
            keys: [OPENAI_COMPAT_STT_CREDENTIAL_ENVIRONMENT_KEY],
          },
        }],
      },
      {
        id: 'tts',
        slot: 'api_key',
        grants: [{
          realm: 'daemon',
          phase: 'speech',
          request: {
            kind: 'environment',
            keys: [OPENAI_COMPAT_TTS_CREDENTIAL_ENVIRONMENT_KEY],
          },
        }],
      },
    ]);
  });

  it('declares the executable daemon/development entrypoints without an Agent/chat credential', () => {
    const serialized = JSON.stringify(PLUGIN_MANIFEST);
    expect(serialized).not.toContain('httpHeaders');
    expect(serialized).not.toContain('chat_api_key');
    expect(serialized).not.toContain('openai_compat');
    expect(PLUGIN_MANIFEST).toMatchObject({
      entrypoints: {
        daemon: './.happier-plugin/daemon.js',
        development: './src/index.ts',
      },
    });
  });

  it('keeps the two independently persisted speech settings and limits declaration-owned', () => {
    const [stt, tts] = PLUGIN_MANIFEST.contributes.voiceProviders;

    expect(stt).toMatchObject({
      id: 'stt',
      kind: 'speech',
      roles: ['dictation_stt', 'conversation_stt'],
      settings: {
        schemaVersion: 2,
        readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
      },
      limits: { transcribe: { maxInputBytes: 8 * 1024 * 1024 } },
    });
    expect(stt?.settings?.fields.map((field) => field.id)).toEqual([
      'baseUrl',
      'insecureLocalOriginConsent',
      'insecureLocalConsentMachineId',
      'model',
      'language',
    ]);

    expect(tts).toMatchObject({
      id: 'tts',
      kind: 'speech',
      roles: ['conversation_tts'],
      settings: {
        schemaVersion: 2,
        readiness: [{ kind: 'setting_nonempty', settingId: 'baseUrl' }],
      },
      limits: {
        synthesize: {
          maxInputCharacters: 200_000,
          maxOutputBytes: VOICE_SPEECH_OUTPUT_MAX_BYTES,
        },
      },
    });
    expect(tts?.settings?.fields.map((field) => field.id)).toEqual([
      'baseUrl',
      'insecureLocalOriginConsent',
      'insecureLocalConsentMachineId',
      'model',
      'voiceName',
      'format',
    ]);
  });
});
