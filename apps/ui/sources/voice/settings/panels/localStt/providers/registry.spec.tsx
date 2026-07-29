import React from 'react';
import { describe, expect, it, vi } from 'vitest';

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

import { createLocalSttProviderRegistry, getLocalSttProviderSpec, localSttProviderSpecs } from './registry';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';

describe('local STT provider registry', () => {
  it('contains every built-in STT provider while provider settings remain an open id domain', () => {
    expect(new Set(localSttProviderSpecs.map((spec) => spec.id))).toEqual(
      new Set(['device', 'openai_compat', 'google_gemini', 'local_neural']),
    );
  });

  it('trims provider ids before resolving a provider spec', () => {
    expect(getLocalSttProviderSpec(' openai_compat ')?.id).toBe('openai_compat');
  });

  it('removes bundled providers and fails lookup closed when their package contribution is disabled', () => {
    const registry = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    expect(registry.list.map((spec) => spec.id)).not.toContain('google_gemini');
    expect(registry.get('google_gemini')).toBeNull();
  });

  it('re-admits a bundled provider from a fresh registry after reinstall', () => {
    const disabled = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    }));
    const reinstalled = createLocalSttProviderRegistry(createDefaultVoiceProviderRegistry());

    expect(disabled.get('google_gemini')).toBeNull();
    expect(reinstalled.get('google_gemini')?.id).toBe('google_gemini');
    expect(reinstalled).not.toBe(disabled);
  });

  it('admits a second bundled STT package from its registry contribution without host provider changes', () => {
    const fakeProviderId = 'acme_speech';
    const registry = createLocalSttProviderRegistry(createVoiceProviderRegistry({
      bundled: [{
        kind: 'voice.speech-engine.v1',
        pluginId: 'acme.voice',
        providerId: fakeProviderId,
        role: 'stt',
        settingsSectionId: 'voice.stt.acme',
        roles: ['dictation_stt'],
        requirements: [],
        internal: {
          createSettingsSpec: (providerId: string) => providerId === fakeProviderId ? {
            kind: 'voice.internal.speech-settings.v1',
            providerId,
            role: 'stt',
            schemaVersion: 3,
            titleKey: 'acme.title',
            subtitleKey: 'acme.subtitle',
            detailKey: 'acme.detail',
            iconName: 'mic-outline',
            credential: { kind: 'api_key', titleKey: 'acme.key', promptTitleKey: 'acme.key', promptBodyKey: 'acme.key', androidRestricted: false, androidRestrictedBodyKey: null },
            fields: [],
            runtime: {},
            defaultConfig: { model: 'acme-v3' },
            parseConfig: (value: unknown) => value && typeof value === 'object' ? {} : null,
            parseLegacyConfig: () => null,
            readLegacySecret: () => null,
            migrateLegacy: () => null,
            classifyLegacyCredential: () => 'importable',
            test: null,
          } : null,
        },
      }],
    }));

    expect(registry.get(fakeProviderId)?.id).toBe(fakeProviderId);
  });
});
