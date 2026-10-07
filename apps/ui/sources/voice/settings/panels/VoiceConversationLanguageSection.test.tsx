import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderSettingsView } from '@/dev/testkit';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { createVoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { projectBundledVoiceManifestContributions } from '@/voice/registry/bundledVoiceManifestProjection';
import { PLUGIN_MANIFEST as OPENAI_MANIFEST } from '../../../../../../packages/plugins/openai/src/manifest';
import { PLUGIN_MANIFEST as ELEVENLABS_MANIFEST } from '../../../../../../packages/plugins/elevenlabs/src/manifest';
import { VOICE_PROVIDER_PRESENTATIONS as OPENAI_PRESENTATIONS } from '../../../../../../packages/plugins/openai/src/ui/voice/entries';
import { VOICE_PROVIDER_PRESENTATIONS as ELEVENLABS_PRESENTATIONS } from '../../../../../../packages/plugins/elevenlabs/src/ui/voice/entries';
import { installVoiceSettingsPanelCommonModuleMocks } from './voiceSettingsPanelTestHelpers';

installVoiceSettingsPanelCommonModuleMocks();
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});

const registry = createVoiceProviderRegistry({
  bundledContributions: [
    ...projectBundledVoiceManifestContributions(OPENAI_MANIFEST),
    ...projectBundledVoiceManifestContributions(ELEVENLABS_MANIFEST),
  ],
  bundledPresentations: [...OPENAI_PRESENTATIONS, ...ELEVENLABS_PRESENTATIONS],
});
const { VoiceConversationLanguageSection } = await import('./VoiceConversationLanguageSection');

describe('Contributed realtime conversation language controls', () => {
  it('retains an unsupported stored language as unavailable instead of claiming the service default', async () => {
    const voice = voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs', assistantLanguage: 'he-IL' });
    const screen = await renderSettingsView(<VoiceConversationLanguageSection voice={voice} setVoice={vi.fn()} registry={registry} />);
    const menu = screen.tree.root.findByType(DropdownMenu);
    expect(menu.props.selectedId).toBe('he-IL');
    expect(menu.props.itemTrigger?.showSelectedSubtitle).toBe(true);
    const choices = menu.props.items;
    expect(choices.find((choice) => choice.id === 'he-IL')?.disabled).toBe(true);
  });
  it('uses one supported language choice for hearing and a read-only coupled reply', async () => {
    const voice = voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs', assistantLanguage: 'de-DE' });
    const setVoice = vi.fn();
    const screen = await renderSettingsView(<VoiceConversationLanguageSection voice={voice} setVoice={setVoice} registry={registry} />);
    const menu = screen.tree.root.findByType(DropdownMenu);
    expect(menu.props.itemTrigger?.title).toBe('settingsVoice.pages.conversations.iSpeakTitle');
    const choices = menu.props.items;
    expect(choices.some((choice) => choice.id === 'he-IL')).toBe(false);
    expect(choices.some((choice) => choice.id === 'fr')).toBe(true);
    const reply = screen.tree.root.findAllByProps({ testID: 'settings.voice.language.replyIn' }).find((row) => typeof row.props.detail === 'string');
    expect(reply?.props.detail).toBe('settingsVoice.pages.conversations.replySame');
    expect(reply?.props.onPress).toBeUndefined();
    await act(async () => menu.props.onSelect('fr'));
    expect(setVoice).toHaveBeenLastCalledWith({ ...voice, assistantLanguage: 'fr' });
  });

  it('shows automatic recognition without coupling the independent reply choice', async () => {
    const voice = voiceSettingsParse({ providerId: 'happier.voice.openai/realtime-openai', assistantLanguage: 'de-DE' });
    const screen = await renderSettingsView(<VoiceConversationLanguageSection voice={voice} setVoice={vi.fn()} registry={registry} />);
    const recognition = screen.tree.root.findAllByProps({ testID: 'settings.voice.language.iSpeak' }).find((row) => typeof row.props.detail === 'string');
    expect(recognition?.props.detail).toBe('settingsVoice.pages.conversations.iSpeakAutomatic');
    expect(recognition?.props.onPress).toBeUndefined();
    expect(screen.tree.root.findByType(DropdownMenu).props.itemTrigger?.title).toBe('settingsVoice.pages.conversations.replyInTitle');
  });

  it('does not advertise a mutable language for an unknown or opaque service', async () => {
    for (const voice of [
      voiceSettingsParse({ providerId: 'acme.unknown/realtime', assistantLanguage: 'fr-FR' }),
      voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs', providers: {
        'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 99, config: { retained: true } },
      } }),
    ]) {
      const screen = await renderSettingsView(<VoiceConversationLanguageSection voice={voice} setVoice={vi.fn()} registry={registry} />);
      expect(screen.tree.root.findAllByType(DropdownMenu)).toHaveLength(0);
    }
  });
});
