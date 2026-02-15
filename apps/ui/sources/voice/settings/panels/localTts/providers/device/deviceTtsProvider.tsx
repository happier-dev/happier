import * as React from 'react';

import { t } from '@/text';
import { speakDeviceText } from '@/voice/local/speakDeviceText';

import type { LocalTtsProviderSpec } from '../_types';

const DeviceTtsSettings: LocalTtsProviderSpec['Settings'] = () => null;

export const deviceTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'device',
  title: t('settingsVoice.local.deviceTts'),
  subtitle: t('settingsVoice.local.deviceTtsSubtitle'),
  iconName: 'phone-portrait-outline',
  detail: 'Device',
  Settings: DeviceTtsSettings,
  test: async ({ sample }) => {
    await speakDeviceText(sample);
  },
};
