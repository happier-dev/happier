import * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { LocalNeuralSttSettings } from './LocalNeuralSttSettings';

import type { LocalSttProviderSpec } from '../_types';

const LocalNeuralProviderSettings: LocalSttProviderSpec['Settings'] = (props) => {
  const cfg = props.cfgStt as VoiceLocalSttSettings;
  return (
    <LocalNeuralSttSettings
      cfg={cfg}
      setCfg={props.setStt as any}
      popoverBoundaryRef={props.popoverBoundaryRef}
    />
  );
};

export const localNeuralSttProviderSpec: LocalSttProviderSpec = {
  id: 'local_neural',
  title: 'Local neural (beta)',
  subtitle: 'Streaming STT via Sherpa-ONNX on native (requires a model download).',
  iconName: 'sparkles-outline',
  detail: 'Sherpa',
  Settings: LocalNeuralProviderSettings,
};
