import React from 'react';
import { describe, expect, it, vi } from 'vitest';
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

import { createLocalTtsProviderRegistry, localTtsProviderSpecs } from './registry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

describe('local TTS provider registry', () => {
  it('contains every built-in TTS provider while provider settings remain an open id domain', () => {
    expect(new Set(localTtsProviderSpecs.map((spec) => spec.id))).toEqual(
      new Set(['device', 'openai_compat', 'google_cloud', 'local_neural']),
    );
  });

  it('removes bundled providers and fails lookup closed when their package contribution is disabled', () => {
    const registry = createLocalTtsProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    expect(registry.list.map((spec) => spec.id)).not.toContain('google_cloud');
    expect(registry.get('google_cloud')).toBeNull();
  });

  it('admits a second bundled TTS package from its registry contribution without host provider changes', () => {
    const fakeProviderId = 'acme_speech';
    const registry = createLocalTtsProviderRegistry(createVoiceProviderRegistry({
      bundled: [{
        kind: 'voice.speech-engine.v1',
        pluginId: 'acme.voice',
        providerId: fakeProviderId,
        role: 'tts',
        settingsSectionId: 'voice.tts.acme',
        roles: ['conversation_tts'],
        requirements: [],
        internal: {
          createSettingsSpec: (providerId: string) => providerId === fakeProviderId ? {
            kind: 'voice.internal.speech-settings.v1',
            providerId,
            role: 'tts',
            schemaVersion: 3,
            titleKey: 'acme.title',
            subtitleKey: 'acme.subtitle',
            detailKey: 'acme.detail',
            iconName: 'volume-high-outline',
            credential: { kind: 'api_key', titleKey: 'acme.key', promptTitleKey: 'acme.key', promptBodyKey: 'acme.key', androidRestricted: false, androidRestrictedBodyKey: null },
            fields: [],
            runtime: {},
            defaultConfig: { voiceName: 'acme-v3' },
            parseConfig: (value: unknown) => value && typeof value === 'object' ? {} : null,
            parseLegacyConfig: () => null,
            readLegacySecret: () => null,
            migrateLegacy: () => null,
            classifyLegacyCredential: () => 'importable',
            test: {
              kind: 'synthesize',
              missingValueKey: 'voiceName',
              missingValueMessageKey: 'acme.voice.missing',
            },
          } : null,
        },
      }],
    }));

    expect(registry.get(fakeProviderId)?.id).toBe(fakeProviderId);
  });
});
