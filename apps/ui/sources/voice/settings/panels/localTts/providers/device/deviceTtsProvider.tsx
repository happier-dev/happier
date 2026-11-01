import * as React from 'react';

import { t } from '@/text';
import { speakDeviceText } from '@/voice/local/speakDeviceText';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import type { LocalTtsProviderSpec } from '../_types';

const DeviceTtsSettings: LocalTtsProviderSpec['Settings'] = () => null;

export const deviceTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'device',
  get title() { return t('settingsVoice.local.deviceTts'); },
  get subtitle() { return t('settingsVoice.local.deviceTtsSubtitle'); },
  iconName: 'device-mobile',
  get detail() { return t('settingsVoice.local.deviceTtsDetail'); },
  Settings: DeviceTtsSettings,
  test: async ({ sample, signal, isCurrent, registerPlaybackStopper }) => {
    const playback = new AbortController();
    const cancellation = mergeAbortSignals([signal, playback.signal]);
    const unregister = registerPlaybackStopper?.(() => playback.abort());
    try {
      await speakDeviceText(sample, undefined, { signal: cancellation.signal, isCurrent });
    } finally {
      unregister?.();
      cancellation.dispose();
    }
  },
};
