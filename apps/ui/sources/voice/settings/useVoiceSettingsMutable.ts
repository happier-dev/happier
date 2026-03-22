import { useSetting } from '@/sync/store/hooks';
import { useApplySettings } from '@/sync/store/settingsWriters';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';

export function useVoiceSettingsMutable(): [VoiceSettings, (next: VoiceSettings) => void] {
  const applySettings = useApplySettings();
  const voice = useSetting('voice') as VoiceSettings;
  const setVoice = (next: VoiceSettings) => {
    applySettings({ voice: next });
  };
  return [voice, setVoice];
}
