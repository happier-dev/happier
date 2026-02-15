import { useSetting } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';

export function useVoiceSettingsMutable(): [VoiceSettings, (next: VoiceSettings) => void] {
  const voice = useSetting('voice') as unknown as VoiceSettings;
  const setVoice = (next: VoiceSettings) => {
    sync.applySettings({ voice: next } as any);
  };
  return [voice, setVoice];
}

