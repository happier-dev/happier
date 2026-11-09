import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { t } from '@/text';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
afterEach(standardCleanup);

const ID = 'settings.voice.privacy.path';

describe('VoiceProviderProcessingDisclosureSection', () => {
  it('names the path once in one block rather than one block per service', async () => {
    const { VoiceProviderProcessingDisclosureSection } = await import('./VoiceProviderProcessingDisclosureSection');
    const config = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults, providerId: 'local_conversation' }, {
      ...config, stt: { ...config.stt, provider: 'device' }, tts: { ...config.tts, provider: 'device' },
    });
    const screen = await renderScreen(<VoiceProviderProcessingDisclosureSection voice={voice} />);
    const group = screen.findHostByTestId(`${ID}.facts`);
    expect(group?.props.role).toBe('list');
    for (const [key, title] of [
      ['audio', t('settingsVoice.pages.privacy.audioRowTitle')],
      ['reads', t('settingsVoice.pages.privacy.readsRowTitle')],
      ['recordings', t('settingsVoice.pages.privacy.recordingsRowTitle')],
    ] as const) {
      const row = screen.findHostByTestId(`${ID}.${key}`);
      expect(row?.props.role).toBe('listitem');
      expect(row?.props.accessibilityLabel).toContain(`${title}: `);
      expect(group?.findAll((node) => node === row)).not.toHaveLength(0);
    }
    expect(screen.findHostByTestId(`${ID}.audio`)?.props.accessibilityLabel).toContain(t('settingsVoice.pages.privacy.pathThisDevice'));
    expect(screen.getTextContent().split(t('settingsVoice.pages.privacy.devicePolicy'))).toHaveLength(2);
    expect(screen.findByTestId(`${ID}.details`)).toBeTruthy();
    expect(screen.findByTestId(`${ID}.full`)).toBeNull();
    await act(async () => { await screen.pressByTestId(`${ID}.details`); });
    expect(screen.findByTestId(`${ID}.full`)).toBeTruthy();
  });

  it('shows the selected service as the path and keeps its full disclosure on request', async () => {
    const { VoiceProviderProcessingDisclosureSection } = await import('./VoiceProviderProcessingDisclosureSection');
    const screen = await renderScreen(React.createElement(VoiceProviderProcessingDisclosureSection, {
      voice: voiceSettingsParse({
        providerId: 'happier.voice.openai/realtime-openai',
        providers: { 'happier.voice.openai/realtime-openai': { schemaVersion: 1, config: OPENAI_REALTIME_DEFAULT_SETTINGS } },
      }),
    }));
    expect(screen.findHostByTestId(`${ID}.audio`)?.props.accessibilityLabel).toContain('OpenAI');
    expect(screen.findHostByTestId(`${ID}.reads`)?.props.accessibilityLabel).toContain('OpenAI Realtime');
    expect(screen.findByTestId(`${ID}.full`)).toBeNull();
    await act(async () => { await screen.pressByTestId(`${ID}.details`); });
    expect(screen.findByTestId(`${ID}.full`)).toBeTruthy();
  });
});
