import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { t, tLoose } from '@/text';
import { projectVoiceProcessingDisclosures } from '@/voice/settings/projectVoiceProcessingDisclosures';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
afterEach(standardCleanup);

describe('VoiceProviderProcessingDisclosureSection', () => {
  it('groups every declared fact under its service and keeps STT and TTS details independent', async () => {
    const { VoiceProviderProcessingDisclosureSection } = await import('./VoiceProviderProcessingDisclosureSection');
    const config = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults, providerId: 'local_conversation' }, {
      ...config, stt: { ...config.stt, provider: 'device' }, tts: { ...config.tts, provider: 'device' },
    });
    const screen = await renderScreen(<VoiceProviderProcessingDisclosureSection voice={voice} />);
    const id = 'settings.voice.provider.disclosure.device.stt';
    const ttsId = 'settings.voice.provider.disclosure.device.tts';
    for (const entry of projectVoiceProcessingDisclosures(voice)) {
      const serviceId = `settings.voice.provider.disclosure.device.${entry.roles.join('-')}`;
      const group = screen.findHostByTestId(`${serviceId}.facts`);
      expect(group?.props.role).toBe('list');
      expect(group?.props.accessibilityLabel).toBe(tLoose(entry.titleKey));
      expect(screen.findByTestId(`${serviceId}.details`)?.props.accessibilityLabel).toBe(`${t('common.details')}: ${tLoose(entry.titleKey)}`);
      for (const [key, title] of [
        ['audioDestination', t('settingsVoice.pages.privacy.audioTitle')],
        ['processor', t('settingsVoice.pages.privacy.processorTitle')],
        ['retention', t('settingsVoice.pages.privacy.retentionTitle')],
      ] as const) {
        const declared = entry.facts![key];
        const value = typeof declared === 'string' ? declared : tLoose(declared.key) === declared.key ? declared.fallback : tLoose(declared.key);
        const row = screen.findHostByTestId(`${serviceId}.${key}`);
        expect(row?.props.role).toBe('listitem');
        expect(row?.props.accessibilityLabel).toBe(`${title}: ${value}`);
        expect(group?.findAll((node) => node === row)).not.toHaveLength(0);
        // Inspect the native Text boundary: the complete value must render without a line cap.
        const painted = row?.findAll((node) => typeof node.type === 'string' && node.props.children === value);
        expect(painted?.length).toBeGreaterThan(0);
        expect(painted?.every((node) => !node.props.numberOfLines)).toBe(true);
      }
    }
    expect(screen.findByTestId(`${id}.full`)).toBeNull();
    expect(screen.findByTestId(`${ttsId}.full`)).toBeNull();
    expect(screen.findByTestId(`${id}.details`)?.props.accessibilityLabel).not.toBe(
      screen.findByTestId(`${ttsId}.details`)?.props.accessibilityLabel,
    );
    await act(async () => { await screen.pressByTestId(`${id}.details`); });
    expect(screen.findByTestId(`${id}.full`)).toBeTruthy();
    expect(screen.findByTestId(`${ttsId}.full`)).toBeNull();
    await act(async () => { await screen.pressByTestId(`${ttsId}.details`); });
    expect(screen.findByTestId(`${ttsId}.full`)).toBeTruthy();
    await act(async () => { await screen.pressByTestId(`${id}.details`); });
    // The canonical disclosure retains its body during the closing animation.
    expect(screen.findByTestId(`${id}.details`)?.props.accessibilityState.expanded).toBe(false);
    expect(screen.findByTestId(`${ttsId}.details`)?.props.accessibilityState.expanded).toBe(true);
    expect(screen.findByTestId(`${ttsId}.full`)).toBeTruthy();
    expect(screen.findHostByTestId(`${id}.retention`)).toBeTruthy();
  });
  it('keeps the selected service facts visible and reveals its full disclosure only on request', async () => {
    const { VoiceProviderProcessingDisclosureSection } = await import('./VoiceProviderProcessingDisclosureSection');
    const screen = await renderScreen(React.createElement(VoiceProviderProcessingDisclosureSection, {
      voice: voiceSettingsParse({
        providerId: 'happier.voice.openai/realtime-openai',
        providers: {
          'happier.voice.openai/realtime-openai': {
            schemaVersion: 1,
            config: OPENAI_REALTIME_DEFAULT_SETTINGS,
          },
        },
      }),
    }));

    const id = 'settings.voice.provider.disclosure.happier.voice.openai%2Frealtime-openai';
    const group = screen.findHostByTestId(`${id}.facts`);
    expect(group?.props.role).toBe('list');
    for (const key of ['audioDestination', 'processor', 'retention']) {
      const row = screen.findHostByTestId(`${id}.${key}`);
      expect(row?.props.role).toBe('listitem');
      expect(group?.findAll((node) => node === row)).not.toHaveLength(0);
    }
    expect(screen.findByTestId(`${id}.full`)).toBeNull();
    await act(async () => { await screen.pressByTestId(`${id}.details`); });
    expect(screen.findByTestId(`${id}.full`)).toBeTruthy();
  });
});
