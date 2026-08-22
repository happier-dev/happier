import { ingestPluginManifestV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
  ElevenLabsVoiceProviderSettingsSchema,
} from './protocol/voice/index.js';

describe('ElevenLabs public Voice settings declaration', () => {
  it('keeps the published manifest output identical to the final source declaration', async () => {
    const builtManifestUrl = new URL('../dist/manifest.js', import.meta.url);
    const builtModule = await import(/* @vite-ignore */ builtManifestUrl.href) as Readonly<{
      PLUGIN_MANIFEST: unknown;
    }>;
    const sourceResult = ingestPluginManifestV2(PLUGIN_MANIFEST);
    const builtResult = ingestPluginManifestV2(builtModule.PLUGIN_MANIFEST);

    expect(sourceResult).toMatchObject({ ok: true });
    expect(builtResult).toEqual(sourceResult);
    expect(builtModule.PLUGIN_MANIFEST).toEqual(PLUGIN_MANIFEST);

    const builtDeclaration = (
      builtModule.PLUGIN_MANIFEST as typeof PLUGIN_MANIFEST
    ).contributes.voiceProviders[0];
    expect(builtDeclaration).not.toHaveProperty('accountMediation');
    expect(builtDeclaration.capabilities).not.toHaveProperty('readiness');
    expect(builtDeclaration.settings?.readiness).toEqual([{
      kind: 'setting_nonempty',
      settingId: 'agentId',
      when: { settingId: 'billingMode', equals: 'byo' },
    }]);
  });

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
      'agentId',
    ]);
    expect(declaration.capabilities).toMatchObject({
      tools: { effectCalls: 'none' },
    });
    expect(declaration.capabilities).not.toHaveProperty('readiness');
    expect(declaration.credentials).toMatchObject({
      slot: { id: 'api_key', purpose: 'voice.client-auth.elevenlabs' },
      requirement: { kind: 'when_setting_equals', settingId: 'billingMode', value: 'byo' },
      sources: [{
        kind: 'savedSecret',
        operationProjections: expect.arrayContaining([
          expect.objectContaining({ operation: 'conversation-token', phase: 'prepare' }),
          expect.objectContaining({ operation: 'create-agent', phase: 'settings' }),
          expect.objectContaining({ operation: 'update-agent', phase: 'settings' }),
        ]),
      }],
    });
    expect(settings?.readiness).toEqual([{
      kind: 'setting_nonempty',
      settingId: 'agentId',
      when: { settingId: 'billingMode', equals: 'byo' },
    }]);
    expect(settings?.actions?.map((action) => action.id)).toEqual([
      'create-agent',
      'update-agent',
    ]);
    const defaults = {
      ...Object.fromEntries(settings?.fields.map((field) => [field.id, field.default]) ?? []),
    };
    expect(ElevenLabsVoiceProviderSettingsSchema.parse(defaults))
      .toEqual(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS);
    expect(ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS.tts.voiceSettings)
      .toEqual({ stability: null, similarityBoost: null, speed: null });
    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse({
      ...defaults,
      extra: true,
    }).success).toBe(false);
  });

  it('declares bounded cursor pagination for provisioning tool discovery', () => {
    const declaration = PLUGIN_MANIFEST.contributes.voiceProviders[0];
    const toolsOperation = declaration.credentials?.hostMediated?.operations.find(
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

  it('declares bounded cursor pagination for provisioning agent discovery', () => {
    const declaration = PLUGIN_MANIFEST.contributes.voiceProviders[0];
    const agentsOperation = declaration.credentials?.hostMediated?.operations.find(
      (operation) => operation.id === 'agents',
    );

    expect(agentsOperation).toMatchObject({
      request: {
        queryTemplate: [
          { name: 'page_size', value: '50' },
          { name: 'search', value: 'Happier Voice' },
        ],
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
