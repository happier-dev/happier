import { describe, expect, it } from 'vitest';

import {
  VoiceBundledUiDescriptorV1Schema,
  VoiceReadinessRoleSchema,
} from './capabilities.js';

describe('voice realtime capability contracts', () => {
  it('keeps role capabilities semantic and provider-neutral', () => {
    expect(VoiceReadinessRoleSchema.options).toEqual([
      'dictation_stt',
      'conversation_stt',
      'conversation_tts',
      'vad',
      'endpointing',
      'realtime_conversation',
      'turn_control',
    ]);
  });

  it('accepts complete bundled conversation and speech-engine descriptors', () => {
    expect(VoiceBundledUiDescriptorV1Schema.parse({
      kind: 'voice.conversation-provider.v1',
      pluginId: 'happier.voice.example',
      providerId: 'example_realtime',
      settingsSectionId: 'voice.provider.example',
      roles: ['realtime_conversation', 'conversation_stt', 'conversation_tts'],
      requirements: [],
      requirementsByMode: {
        byo: ['execution_machine', 'credential', 'endpoint'],
        hosted: ['server_feature'],
      },
      selectionOptions: [
        { id: 'hosted', modeId: 'hosted', order: 10, titleKey: 'voice.hosted', subtitleKey: 'voice.hosted.subtitle', configPatch: { billingMode: 'hosted' } },
        { id: 'byo', modeId: 'byo', order: 20, titleKey: 'voice.byo', subtitleKey: 'voice.byo.subtitle', configPatch: { billingMode: 'byo' } },
      ],
      supportedPlatforms: ['web', 'ios', 'android'],
    })).toMatchObject({ providerId: 'example_realtime' });

    expect(VoiceBundledUiDescriptorV1Schema.parse({
      kind: 'voice.speech-engine.v1',
      pluginId: 'happier.voice.example',
      providerId: 'example_stt',
      role: 'both',
      settingsSectionId: 'voice.stt.example',
      roles: ['dictation_stt', 'conversation_stt'],
      requirements: ['execution_machine', 'credential', 'runtime'],
    })).toMatchObject({ providerId: 'example_stt', role: 'both' });

    expect(VoiceBundledUiDescriptorV1Schema.parse({
      kind: 'voice.turn-support.v1',
      pluginId: 'happier.voice.builtin',
      providerId: 'host_turn_detection',
      settingsSectionId: 'voice.turnDetection',
      roles: ['vad', 'endpointing'],
      requirements: ['runtime'],
      supportedPlatforms: ['web', 'ios', 'android'],
    })).toMatchObject({ providerId: 'host_turn_detection' });
  });

  it('rejects duplicate semantic capabilities and invalid mode identifiers', () => {
    expect(VoiceBundledUiDescriptorV1Schema.safeParse({
      kind: 'voice.conversation-provider.v1',
      pluginId: 'happier.voice.example',
      providerId: 'example_realtime',
      settingsSectionId: 'voice.provider.example',
      roles: ['realtime_conversation', 'realtime_conversation'],
      requirements: [],
    }).success).toBe(false);

    expect(VoiceBundledUiDescriptorV1Schema.safeParse({
      kind: 'voice.conversation-provider.v1',
      pluginId: 'happier.voice.example',
      providerId: 'example_realtime',
      settingsSectionId: 'voice.provider.example',
      roles: ['realtime_conversation'],
      requirements: [],
      requirementsByMode: { 'Not Valid': ['credential'] },
    }).success).toBe(false);
  });

  it('rejects incomplete descriptors and unknown semantic requirements', () => {
    expect(VoiceBundledUiDescriptorV1Schema.safeParse({
      kind: 'voice.conversation-provider.v1',
      pluginId: 'happier.voice.example',
      providerId: 'example_realtime',
    }).success).toBe(false);

    expect(VoiceBundledUiDescriptorV1Schema.safeParse({
      kind: 'voice.speech-engine.v1',
      pluginId: 'happier.voice.example',
      providerId: 'example_stt',
      role: 'stt',
      settingsSectionId: 'voice.stt.example',
      roles: ['dictation_stt'],
      requirements: ['vendor_magic'],
    }).success).toBe(false);
  });
});
