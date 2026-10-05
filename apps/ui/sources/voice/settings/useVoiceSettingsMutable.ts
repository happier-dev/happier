import { useSetting } from '@/sync/store/hooks';
import * as React from 'react';
import { useApplyVoiceSettingsEdit } from '@/sync/store/settingsWriters';
import type { VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Modal } from '@/modal';
import { t } from '@/text';

export function useVoiceSettingsMutable(): [VoiceSettings, (next: VoiceSettings) => void] {
  const applyEdit = useApplyVoiceSettingsEdit();
  const voice = useSetting('voice') as VoiceSettings;
  const setVoice = React.useCallback((next: VoiceSettings) => {
    fireAndForget(applyEdit(voice, next), { tag: 'Voice settings edit', logError: false, onError: () => Modal.alert(t('common.error'), t('common.saveError')) });
  }, [applyEdit, voice]);
  return [voice, setVoice];
}
