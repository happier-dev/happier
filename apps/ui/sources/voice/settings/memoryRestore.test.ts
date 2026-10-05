import { describe, expect, it } from 'vitest';

import {
  readLocalConversationVoiceSettings,
  voiceSettingsParse,
  writeLocalConversationVoiceSettings,
} from '@/sync/domains/settings/voiceSettings';

import { applyVoiceMemoryRestoreChoice, resolveVoiceMemoryRestoreChoice } from './memoryRestore';

function voiceWithAgent(patch: Record<string, unknown>) {
  const voice = voiceSettingsParse({});
  const cfg = readLocalConversationVoiceSettings(voice);
  return writeLocalConversationVoiceSettings(voice, { ...cfg, agent: { ...cfg.agent, ...patch } as typeof cfg.agent });
}

describe('Voice agent memory restore choice', () => {
  it('reads replay strategies and native resume as one choice', () => {
    expect(resolveVoiceMemoryRestoreChoice(voiceWithAgent({}))).toBe('recent_messages');
    expect(resolveVoiceMemoryRestoreChoice(voiceWithAgent({ replay: { strategy: 'summary_plus_recent', recentMessagesCount: 16 } })))
      .toBe('summary_plus_recent');
    expect(resolveVoiceMemoryRestoreChoice(voiceWithAgent({ resumabilityMode: 'provider_resume', replay: { strategy: 'summary_plus_recent', recentMessagesCount: 16 } })))
      .toBe('provider_resume');
  });

  it('choosing native resume keeps the replay strategy its fallback uses', () => {
    const before = voiceWithAgent({ replay: { strategy: 'summary_plus_recent', recentMessagesCount: 24 } });
    const agent = readLocalConversationVoiceSettings(applyVoiceMemoryRestoreChoice(before, 'provider_resume')).agent;
    expect(agent.resumabilityMode).toBe('provider_resume');
    expect(agent.replay).toEqual({ strategy: 'summary_plus_recent', recentMessagesCount: 24 });
  });

  it('choosing a replay strategy leaves native resume and keeps the restore count', () => {
    const before = voiceWithAgent({ resumabilityMode: 'provider_resume', replay: { strategy: 'summary_plus_recent', recentMessagesCount: 24 } });
    const agent = readLocalConversationVoiceSettings(applyVoiceMemoryRestoreChoice(before, 'recent_messages')).agent;
    expect(agent.resumabilityMode).toBe('replay');
    expect(agent.replay).toEqual({ strategy: 'recent_messages', recentMessagesCount: 24 });
  });
});
