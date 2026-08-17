import * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';
import { LocalNeuralSttSettings } from './LocalNeuralSttSettings';

import type { LocalSttProviderSpec } from '../_types';

const LocalNeuralProviderSettings: LocalSttProviderSpec['Settings'] = (props) => {
  const cfg = props.cfgStt as VoiceLocalSttSettings;
  return (
    <LocalNeuralSttSettings
      cfg={cfg}
      setCfg={props.setStt as any}
      popoverBoundaryRef={props.popoverBoundaryRef}
      daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
    />
  );
};

export const localNeuralSttProviderSpec: LocalSttProviderSpec = {
  id: 'local_neural',
  title: t('settingsVoice.local.localNeuralStt.provider.title'),
  subtitle: t('settingsVoice.local.localNeuralStt.provider.subtitle'),
  iconName: 'sparkle',
  detail: t('settingsVoice.local.localNeuralStt.provider.detail'),
  Settings: LocalNeuralProviderSettings,
};
