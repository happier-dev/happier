import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { voiceSettingsDefaults, type VoiceSettings } from '@/sync/domains/settings/voiceSettings';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

function voiceWithUpdates(updates: Partial<VoiceSettings['ui']['updates']>): VoiceSettings {
  return {
    ...voiceSettingsDefaults,
    ui: { ...voiceSettingsDefaults.ui, updates: { ...voiceSettingsDefaults.ui.updates, ...updates } },
  };
}

async function render(voice: VoiceSettings, setVoice = vi.fn()) {
  const { VoiceLiveUpdatesSection } = await import('./VoiceLiveUpdatesSection');
  return renderScreen(React.createElement(VoiceLiveUpdatesSection, { voice, setVoice }));
}

describe('VoiceLiveUpdatesSection', () => {
  it('keeps the message options visible and locked until a session sends messages', async () => {
    const screen = await render(voiceWithUpdates({ activeSession: 'summaries', otherSessions: 'activity' }));

    expect(screen.findByTestId('settings.voice.ui.updates.snippetsMaxMessages.field.increment')?.props.disabled).toBe(true);
    expect(screen.findByTestId('settings.voice.ui.updates.includeUserMessagesInSnippets')?.props.disabled).toBe(true);
    expect(screen.findByTestId('settings.voice.ui.updates.otherSessionsSnippetsMode:auto')).toBeTruthy();
  });

  it('unlocks per-update options for the active session but keeps the other-sessions mode tied to other sessions', async () => {
    const screen = await render(voiceWithUpdates({ activeSession: 'snippets', otherSessions: 'activity' }));

    expect(screen.findByTestId('settings.voice.ui.updates.snippetsMaxMessages.field.increment')?.props.disabled).toBe(false);
    expect(screen.findByTestId('settings.voice.ui.updates.includeUserMessagesInSnippets')?.props.disabled).toBe(false);
    const otherMode = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.ui.updates.otherSessionsSnippetsMode')[0];
    expect(otherMode?.props.disabled).toBe(true);
  });

  it('writes the active and other session levels independently', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithUpdates({ activeSession: 'summaries', otherSessions: 'activity' });
    const screen = await render(voice, setVoice);

    screen.pressByTestId('settings.voice.ui.updates.otherSessions:snippets');
    expect(setVoice).toHaveBeenLastCalledWith(voiceWithUpdates({ activeSession: 'summaries', otherSessions: 'snippets' }));
  });
});
