import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  createExpoRouterMock,
  createExpoVectorIconsMock,
  renderScreen,
} from '@/dev/testkit';

const routerMock = createExpoRouterMock();

vi.mock('expo-router', () => routerMock.module);
vi.mock('@expo/vector-icons', () => createExpoVectorIconsMock());

describe('VoiceHistorySettingsEntry', () => {
  it('exposes one ordinary discoverable settings row that opens Voice History', async () => {
    const { VoiceHistorySettingsEntry } = await import('./VoiceHistorySettingsEntry');
    const screen = await renderScreen(<VoiceHistorySettingsEntry />);

    const row = screen.findByTestId('settings-voice-history-entry');
    expect(row?.props.accessibilityRole).toBe('button');
    screen.pressByTestId('settings-voice-history-entry');
    expect(routerMock.spies.push).toHaveBeenCalledWith('/settings/voice-history');

    const { getSettingsStackScreenDefinitions } = await import(
      '@/components/settings/navigation/settingsRouteRegistry'
    );
    const route = getSettingsStackScreenDefinitions((key) => key)
      .find((definition) => definition.name === 'voice-history');
    expect(route?.options.headerTitle).toBe('settingsVoice.history.title');
  });
});
