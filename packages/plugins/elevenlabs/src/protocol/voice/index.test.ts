import { readFile } from 'node:fs/promises';

import { compilePluginJsonSchema } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION,
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsProvisionRequestSchema,
  ElevenLabsProvisionToolSchema,
  ElevenLabsVoiceProviderSettingsLegacySchema,
  ElevenLabsVoiceProviderSettingsSchema,
} from './index.js';

describe('ElevenLabs versioned credential boundary', () => {
  it('projects every Voice setting schema into the validator-neutral SDK boundary', () => {
    type VoiceSettingSchema = typeof ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields[number]['schema'];

    expectTypeOf<VoiceSettingSchema>()
      .toMatchTypeOf<Parameters<typeof compilePluginJsonSchema>[0]>();
  });

  it('uses public Voice composition at the raw tool-parameter seam', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain('createVoiceRecordSchema');
    expect(source).toContain('withVoiceSchemaField');
    expect(source).toContain('VoiceRealtimeJsonValueSchema');
    expect(source).not.toContain('JsonValueZodAdapter');
    expect(source).not.toContain('z.custom');
    expect(source).not.toContain('@happier-dev/plugin-sdk/protocol-authoring');
  });

  it('uses the provisioning speed bounds as the canonical settings contract', () => {
    const config = (speed: number) => ({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      tts: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts,
        voiceSettings: {
          ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceSettings,
          speed,
        },
      },
    });

    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(0.699_999)).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(0.7)).success).toBe(true);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(1.2)).success).toBe(true);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(config(1.200_001)).success).toBe(false);
  });

  it('validates canonical agent, voice, and model identifiers before persistence', () => {
    const withByo = (agentId: string) => ({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      agentId,
    });
    const withTts = (tts: Readonly<{ voiceId?: string; modelId?: string | null }>) => ({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, ...tts },
    });
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withByo('bad id')).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withTts({ voiceId: '' })).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withTts({ modelId: 'x'.repeat(257) })).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(withByo('  agent_1  ')).success).toBe(false);

    expect(ElevenLabsVoiceProviderSettingsSchema.parse({
      ...withByo('agent_1'),
      tts: { ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts, voiceId: 'voice_1', modelId: 'model_1' },
    })).toMatchObject({
      agentId: 'agent_1',
      tts: { voiceId: 'voice_1', modelId: 'model_1' },
    });
  });

  it('keeps v1 secrets migration-readable while the current canonical schema rejects them', () => {
    const legacy = {
      billingMode: 'byo',
      byo: {
        agentId: 'agent_1',
        apiKey: { _isSecretValue: true, value: 'xi_secret' },
      },
    };

    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(legacy).success).toBe(false);
    expect(ElevenLabsVoiceProviderSettingsLegacySchema.parse(legacy).byo).toEqual(legacy.byo);
    expect(JSON.stringify(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS)).not.toContain('apiKey');
  });

  it('keeps retired tuning readable only through the legacy compatibility schema', () => {
    const legacy = ElevenLabsVoiceProviderSettingsLegacySchema.parse({
      tts: {
        voiceSettings: {
          style: 0.35,
          useSpeakerBoost: true,
        },
      },
    });

    expect(legacy.tts.voiceSettings).toMatchObject({
      style: 0.35,
      useSpeakerBoost: true,
    });
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse({
      ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
      tts: legacy.tts,
    }).success).toBe(false);
  });

  it('rejects retired tuning at the provisioning boundary', () => {
    const request = {
      kind: 'create' as const,
      prompt: 'Create a Happier Voice agent.',
      tools: [],
      tts: {
        voiceId: 'voice_1',
        modelId: null,
        voiceSettings: {
          stability: 0.4,
          similarityBoost: 0.8,
          speed: 1.1,
        },
      },
    };

    expect(ElevenLabsProvisionRequestSchema.safeParse(request).success).toBe(true);
    expect(ElevenLabsProvisionRequestSchema.safeParse({
      ...request,
      tts: {
        ...request.tts,
        voiceSettings: { ...request.tts.voiceSettings, style: 0.35 },
      },
    }).success).toBe(false);
    expect(ElevenLabsProvisionRequestSchema.safeParse({
      ...request,
      tts: {
        ...request.tts,
        voiceSettings: { ...request.tts.voiceSettings, useSpeakerBoost: true },
      },
    }).success).toBe(false);
    expect(ElevenLabsProvisionRequestSchema.safeParse({
      ...request,
      tts: { ...request.tts, voice_settings: request.tts.voiceSettings },
    }).success).toBe(false);
  });

  it('rejects non-JSON tool parameters before public account operations', () => {
    const base = {
      name: 'sendMessage',
      description: 'Send a message.',
    };

    expect(ElevenLabsProvisionToolSchema.safeParse(base).success).toBe(false);
    expect(ElevenLabsProvisionToolSchema.safeParse({
      ...base,
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
      },
    }).success).toBe(true);
    expect(ElevenLabsProvisionToolSchema.safeParse({
      ...base,
      parameters: {
        type: 'object',
        properties: {
          message: undefined,
        },
      },
    }).success).toBe(false);
    expect(ElevenLabsProvisionToolSchema.safeParse({
      ...base,
      parameters: {
        generatedAt: new Date(),
      },
    }).success).toBe(false);
  });

  it('uses the canonical Voice JSON bounds without an aggregate quota', () => {
    const maxVoiceString = 'x'.repeat(64 * 1024);
    expect(ElevenLabsProvisionToolSchema.safeParse({
      name: 'sendMessage',
      description: 'Send a message.',
      parameters: {
        first: maxVoiceString,
        second: maxVoiceString,
      },
    }).success).toBe(true);
    expect(ElevenLabsProvisionToolSchema.safeParse({
      name: 'sendMessage',
      description: 'Send a message.',
      parameters: {
        description: 'x'.repeat(64 * 1024 + 1),
      },
    }).success).toBe(false);
  });

  it('keeps the list branch tool-free after composition', () => {
    const parsed = ElevenLabsProvisionRequestSchema.parse({ kind: 'list' });

    expect(parsed).toEqual({ kind: 'list' });
    expect(Object.hasOwn(parsed, 'tools')).toBe(false);
  });
});
