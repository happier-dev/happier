import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';

export function LocalNeuralSttSettings(_props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  return (
    <Item
      title={t('settingsVoice.local.neuralStt.title')}
      subtitle={t('settingsVoice.local.neuralStt.webNotAvailableSubtitle')}
      detail={t('common.unavailable')}
      showChevron={false}
      selected={false}
    />
  );
}
