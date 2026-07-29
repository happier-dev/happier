import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from './protocol/voice/index.js';

describe('ElevenLabs public Voice settings declaration', () => {
  it('is the complete schema/default authority for billing, BYO, and TTS runtime config', () => {
    const declaration = PLUGIN_MANIFEST.contributes.voiceProviders[0];
    const settings = declaration.settings;
    expect(ingestPluginManifestV2(PLUGIN_MANIFEST)).toMatchObject({ ok: true });
    expect(settings?.schemaVersion).toBe(2);
    expect(settings?.privacyDisclosure).toBe(
      'Audio and conversation content are sent from this device to ElevenLabs through the ElevenLabs client connection. Depending on the selected setup, Happier may also send ElevenLabs bounded agent instructions, client-tool definitions and results, and authentication or provisioning requests needed for the feature. Happier’s server may participate in hosted authentication and usage accounting, but neither Happier’s server nor relay carries the live conversation audio. ElevenLabs may process and retain received data under your ElevenLabs account settings and its terms. Voice context-sharing controls are separate from this provider processing.',
    );
    expect(settings?.fields.map((field) => field.id)).toEqual([
      'billingMode',
      'tts',
      'byo',
    ]);
    const defaults = {
      mode: 'default',
      ...Object.fromEntries(settings?.fields.map((field) => [field.id, field.default]) ?? []),
    };
    expect(ElevenLabsVoiceProviderSettingsSchema.parse(defaults))
      .toEqual(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse({
      ...defaults,
      extra: true,
    }).success).toBe(false);
  });

  it('declares bounded cursor pagination for provisioning tool discovery', () => {
    const declaration = PLUGIN_MANIFEST.contributes.voiceProviders[0];
    const toolsOperation = declaration.accountMediation?.operations.find(
      (operation) => operation.id === 'tools',
    );

    expect(toolsOperation).toMatchObject({
      request: {
        queryTemplate: [{ name: 'page_size', value: '100' }],
      },
      parameters: {
        schema: {
          type: 'object',
          properties: {
            cursor: {
              type: 'string',
              minLength: 1,
              maxLength: 512,
            },
          },
          additionalProperties: false,
        },
        mapping: [{
          parameter: 'cursor',
          target: { kind: 'query', name: 'cursor' },
        }],
      },
    });
  });
});
