import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import {
  readLocalConversationVoiceSettings,
  voiceSettingsDefaults,
  writeLocalConversationVoiceSettings,
  type VoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

vi.mock('@/components/ui/forms/Switch', () => ({
  Switch: (props: any) => React.createElement('Switch', props),
}));
// The persisted-memory reset reaches the daemon and stored transcripts: a system boundary.
vi.mock('@/voice/agent/resetGlobalVoiceAgentPersistence', () => ({
  resetGlobalVoiceAgentPersistence: vi.fn(),
}));
const featureEnabledState: Record<string, boolean> = { 'voice.agent': true };
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => featureEnabledState[featureId] === true,
}));

type Agent = ReturnType<typeof readLocalConversationVoiceSettings>['agent'];

function voiceWithAgent(patch: Partial<Agent>): VoiceSettings {
  const cfg = readLocalConversationVoiceSettings(voiceSettingsDefaults);
  return writeLocalConversationVoiceSettings(voiceSettingsDefaults, { ...cfg, agent: { ...cfg.agent, ...patch } });
}

async function render(voice: VoiceSettings, setVoice = vi.fn()) {
  const { VoiceAgentMemorySection } = await import('./VoiceAgentMemorySection');
  return renderScreen(React.createElement(VoiceAgentMemorySection, { voice, setVoice }));
}

describe('VoiceAgentMemorySection', () => {
  it('shows how memory is restored even when nothing is remembered, locked until Remember is on', async () => {
    const screen = await render(voiceWithAgent({}));

    const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
    expect(restore?.props.disabled).toBe(true);
    expect(screen.findByTestId('settings.voice.local.replay.recentMessagesCount.field')?.props.editable).toBe(false);
    expect(screen.findByTestId('settings.voice.memory.forget')).toBeTruthy();
  });

  it('turning Remember on persists the transcript without touching how it is restored', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithAgent({ replay: { strategy: 'summary_plus_recent', recentMessagesCount: 12 } });
    const screen = await render(voice, setVoice);

    screen.findByTestId('settings.voice.memory.remember')?.props.onValueChange(true);
    const agent = readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent;
    expect(agent.transcript.persistenceMode).toBe('persistent');
    expect(agent.replay).toEqual({ strategy: 'summary_plus_recent', recentMessagesCount: 12 });
  });

  it('chooses resuming the agent as one atomic restore choice', async () => {
    const setVoice = vi.fn();
    const voice = voiceWithAgent({ transcript: { persistenceMode: 'persistent', epoch: 0 } });
    const screen = await render(voice, setVoice);

    screen.pressByTestId('settings.voice.memory.restore:provider_resume');
    const agent = readLocalConversationVoiceSettings(setVoice.mock.lastCall![0]).agent;
    expect(agent.resumabilityMode).toBe('provider_resume');
    expect(screen.findByTestId('settings.voice.memory.fallbackToReplay')).toBeTruthy();
  });

  it('says why resuming is unavailable when the Voice agent is off for this server', async () => {
    featureEnabledState['voice.agent'] = false;
    try {
      const screen = await render(voiceWithAgent({ transcript: { persistenceMode: 'persistent', epoch: 0 } }));
      const restore = screen.findAll((node) => node.props?.testIDPrefix === 'settings.voice.memory.restore')[0];
      const resume = restore?.props.options.find((option: { id: string }) => option.id === 'provider_resume');
      expect(typeof resume?.unavailableReason).toBe('string');
    } finally {
      featureEnabledState['voice.agent'] = true;
    }
  });
});
