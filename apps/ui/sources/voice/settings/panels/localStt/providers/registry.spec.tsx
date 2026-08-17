import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import { installLocalSttProviderCommonModuleMocks } from './localSttProviderTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installLocalSttProviderCommonModuleMocks();

vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children ?? null),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) =>
    React.createElement(
      'DropdownMenu',
      props,
      typeof props.trigger === 'function'
        ? props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {} })
        : props.trigger ?? null,
    ),
}));

import { createLocalSttProviderRegistry, getLocalSttProviderSpec, listLocalSttProviderSpecs } from './registry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

describe('local STT provider registry', () => {
  it('contains every built-in STT provider while provider settings remain an open id domain', () => {
    expect(new Set(listLocalSttProviderSpecs().map((spec) => spec.id))).toEqual(
      new Set([
        'device',
        'happier.voice.openai-compat/stt',
        'happier.voice.google/gemini-stt',
        'local_neural',
      ]),
    );
  });

  it('trims provider ids before resolving a provider spec', () => {
    expect(getLocalSttProviderSpec(' happier.voice.google/gemini-stt ')?.id)
      .toBe('happier.voice.google/gemini-stt');
  });

  it('removes bundled providers and fails lookup closed when their package contribution is disabled', () => {
    const registry = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    expect(registry.list.map((spec) => spec.id)).not.toContain('happier.voice.google/gemini-stt');
    expect(registry.get('happier.voice.google/gemini-stt')).toBeNull();
  });

  it('re-admits a bundled provider from a fresh registry after reinstall', () => {
    const disabled = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    const reinstalled = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry());

    expect(disabled.get('happier.voice.google/gemini-stt')).toBeNull();
    expect(reinstalled.get('happier.voice.google/gemini-stt')?.id)
      .toBe('happier.voice.google/gemini-stt');
    expect(reinstalled).not.toBe(disabled);
  });

  it('admits a second bundled STT package from its registry contribution without host provider changes', () => {
    const fakeProviderId = 'acme.voice/speech';
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'speech',
      title: 'Acme Speech',
      kind: 'speech',
      roles: ['dictation_stt'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.transcribe', title: 'API key' },
        requirement: { kind: 'always' },
        sources: [{
          kind: 'savedSecret',
          secretKinds: ['apiKey'],
          rawGrants: [{
            realm: 'daemon',
            phase: 'speech',
            request: { kind: 'environment', keys: ['ACME_VOICE_API_KEY'] },
          }],
        }],
      },
      settings: {
        schemaVersion: 2,
        fields: [{
          id: 'model',
          title: 'Model',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'acme-v1',
          presentation: { control: 'text' },
        }],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const voiceRegistry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.voice',
        providerId: fakeProviderId,
        declaration,
      }],
      bundledPresentations: [{
        providerId: fakeProviderId,
        settingsSectionId: 'voice.stt.acme',
        createSettingsSpec: () => ({
            titleKey: 'acme.title',
            subtitleKey: 'acme.subtitle',
            detailKey: 'acme.detail',
            iconName: 'microphone',
            credential: { titleKey: 'acme.key', promptTitleKey: 'acme.key', promptBodyKey: 'acme.key' },
            fields: [{
              fieldId: 'model',
              titleKey: 'acme.model.title',
              subtitleKey: 'acme.model.subtitle',
            }],
            test: null,
          }),
      }],
    });
    const conversationRegistry = createLocalSttProviderRegistry(voiceRegistry, 'conversation_stt');
    const dictationRegistry = createLocalSttProviderRegistry(voiceRegistry, 'dictation_stt');

    expect(conversationRegistry.get(fakeProviderId)).toBeNull();
    expect(dictationRegistry.get(fakeProviderId)?.id).toBe(fakeProviderId);
  });
});
