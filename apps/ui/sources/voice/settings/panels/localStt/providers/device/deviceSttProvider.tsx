import { t } from '@/text';

import type { LocalSttProviderSpec } from '../_types';

export const deviceSttProviderSpec: LocalSttProviderSpec = {
  id: 'device',
  get title() { return t('settingsVoice.local.deviceStt'); },
  get subtitle() { return t('settingsVoice.local.deviceSttSubtitle'); },
  iconName: 'microphone',
  get detail() { return t('settingsVoice.local.deviceSttDetail'); },
};
