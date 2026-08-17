import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';
import { installLocalTtsCommonModuleMocks } from '../localTtsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installLocalTtsCommonModuleMocks();

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

import { createLocalTtsProviderRegistry, listLocalTtsProviderSpecs } from './registry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

describe('local TTS provider registry', () => {
  it('contains every built-in TTS provider while provider settings remain an open id domain', () => {
    expect(new Set(listLocalTtsProviderSpecs().map((spec) => spec.id))).toEqual(
      new Set([
        'device',
        'happier.voice.openai-compat/tts',
        'happier.voice.google/google-cloud-tts',
        'local_neural',
      ]),
    );
  });

  it('removes bundled providers and fails lookup closed when their package contribution is disabled', () => {
    const registry = createLocalTtsProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    expect(registry.list.map((spec) => spec.id)).not.toContain('happier.voice.google/google-cloud-tts');
    expect(registry.get('happier.voice.google/google-cloud-tts')).toBeNull();
  });

  it('admits a second bundled TTS package from its registry contribution without host provider changes', () => {
    const fakeProviderId = 'acme.voice/speech';
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'speech',
      title: 'Acme Speech',
      kind: 'speech',
      roles: ['conversation_tts'],
      platforms: ['web'],
      credentials: {
        slot: { id: 'api_key', purpose: 'voice.speech.synthesize', title: 'API key' },
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
          id: 'voiceName',
          title: 'Voice',
          schema: { type: 'string', minLength: 1, maxLength: 256 },
          default: 'acme-v1',
          presentation: { control: 'text' },
        }],
      },
    });
    if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
    const registry = createLocalTtsProviderRegistry(createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'acme.voice',
        providerId: fakeProviderId,
        declaration,
      }],
      bundledPresentations: [{
        providerId: fakeProviderId,
        settingsSectionId: 'voice.tts.acme',
        createSettingsSpec: () => ({
            titleKey: 'acme.title',
            subtitleKey: 'acme.subtitle',
            detailKey: 'acme.detail',
            iconName: 'speaker-high',
            credential: { titleKey: 'acme.key', promptTitleKey: 'acme.key', promptBodyKey: 'acme.key' },
            fields: [{
              fieldId: 'voiceName',
              titleKey: 'acme.voice.title',
              subtitleKey: 'acme.voice.subtitle',
            }],
            test: {
              missingValueMessageKey: 'acme.voice.missing',
            },
          }),
      }],
    }));

    expect(registry.get(fakeProviderId)?.id).toBe(fakeProviderId);
  });
});
