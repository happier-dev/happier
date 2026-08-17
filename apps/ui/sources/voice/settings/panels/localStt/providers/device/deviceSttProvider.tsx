import * as React from 'react';

import { t } from '@/text';

import type { LocalSttProviderSpec } from '../_types';

const DeviceSttSettings: LocalSttProviderSpec['Settings'] = () => null;

export const deviceSttProviderSpec: LocalSttProviderSpec = {
  id: 'device',
  title: t('settingsVoice.local.deviceStt'),
  subtitle: t('settingsVoice.local.deviceSttSubtitle'),
  iconName: 'microphone',
  detail: t('settingsVoice.local.deviceSttDetail'),
  Settings: DeviceSttSettings,
};
