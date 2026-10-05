import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readLocalConversationVoiceSettings, voiceSettingsDefaults, voiceSettingsParse, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';

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
  it('reveals device processing details on request without displaying the full disclosure initially', async () => {
    const { VoiceProviderProcessingDisclosureSection } = await import('./VoiceProviderProcessingDisclosureSection');
    const config = readLocalConversationVoiceSettings(voiceSettingsDefaults);
    const voice = writeLocalConversationVoiceSettings({ ...voiceSettingsDefaults, providerId: 'local_conversation' }, {
      ...config, stt: { ...config.stt, provider: 'device' }, tts: { ...config.tts, provider: 'device' },
    });
    const screen = await renderScreen(<VoiceProviderProcessingDisclosureSection voice={voice} />);
    const id = 'settings.voice.provider.disclosure.device.stt';
    expect(screen.findByTestId(`${id}.audioDestination`)).toBeTruthy();
    expect(screen.findByTestId(`${id}.full`)).toBeNull();
    await act(async () => { await screen.pressByTestId(`${id}.details`); });
    expect(screen.findByTestId(`${id}.full`)).toBeTruthy();
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
    expect(screen.findByTestId(`${id}.audioDestination`)).toBeTruthy();
    expect(screen.findByTestId(`${id}.full`)).toBeNull();
    await act(async () => { await screen.pressByTestId(`${id}.details`); });
    expect(screen.findByTestId(`${id}.full`)).toBeTruthy();
  });
});
