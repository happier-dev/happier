import * as React from 'react';

import { t } from '@/text';

import type { LocalSttProviderSpec } from '../_types';

const DeviceSttSettings: LocalSttProviderSpec['Settings'] = () => null;

export const deviceSttProviderSpec: LocalSttProviderSpec = {
  id: 'device',
  title: 'Device speech recognition',
  subtitle: t('settingsVoice.local.deviceSttSubtitle'),
  iconName: 'mic-outline',
  detail: 'Device',
  Settings: DeviceSttSettings,
};
