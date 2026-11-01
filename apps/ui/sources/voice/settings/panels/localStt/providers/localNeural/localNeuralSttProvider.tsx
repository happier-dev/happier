import * as React from 'react';

import type { VoiceLocalSttSettings } from '@/sync/domains/settings/voiceLocalSttSettings';
import { t } from '@/text';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
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
  get title() { return t('settingsVoice.local.localNeuralStt.provider.title'); },
  get subtitle() { return t('settingsVoice.local.localNeuralStt.provider.subtitle'); },
  iconName: 'sparkle',
  get detail() { return t('settingsVoice.local.localNeuralStt.provider.detail'); },
  Settings: LocalNeuralProviderSettings,
  resolvePreferredExecution: (requestedExecution) => resolveLocalNeuralExecutionPolicy({ requestedExecution }).preferredExecution,
};
