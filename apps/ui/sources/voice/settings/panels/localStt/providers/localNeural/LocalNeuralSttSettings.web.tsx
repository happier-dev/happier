import * as React from 'react';

import { Item } from '@/components/ui/lists/Item';
import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';

export function LocalNeuralSttSettings(_props: {
  cfg: VoiceLocalSttSettings;
  setCfg: (next: VoiceLocalSttSettings) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}) {
  return (
    <Item
      title="On-device STT"
      subtitle="Not available on web. Use Device, OpenAI-compatible, or Gemini STT."
      detail="Unavailable"
      showChevron={false}
      selected={false}
    />
  );
}

