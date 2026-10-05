import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import { VoiceConnectionSection } from './VoiceConnectionSection';

describe('VoiceConnectionSection', () => {
  it('edits the request timeout in seconds and keeps it inside the setting’s admitted range', async () => {
    const setVoice = vi.fn();
    const screen = await renderScreen(<VoiceConnectionSection voice={voiceSettingsDefaults} setVoice={setVoice} />);
    const field = () => screen.findByTestId('settings.voice.local.networkTimeoutMs.field');
    expect(field()?.props.value).toBe(String(readLocalConversationVoiceSettings(voiceSettingsDefaults).networkTimeoutMs / 1000));

    await act(async () => { field()!.props.onChangeText('90'); });
    await act(async () => { field()!.props.onBlur(); });
    expect(readLocalConversationVoiceSettings(setVoice.mock.lastCall![0] as VoiceSettings).networkTimeoutMs).toBe(60000);

    await act(async () => { field()!.props.onChangeText('7'); });
    await act(async () => { field()!.props.onBlur(); });
    expect(readLocalConversationVoiceSettings(setVoice.mock.lastCall![0] as VoiceSettings).networkTimeoutMs).toBe(7000);
  });
});
