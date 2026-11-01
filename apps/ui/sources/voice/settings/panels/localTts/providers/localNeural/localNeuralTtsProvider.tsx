import * as React from 'react';

import { LocalNeuralTtsSettings } from '@/voice/settings/panels/localTts/LocalNeuralTtsSettings';
import { resolveKokoroOperationTimeoutMs } from '@/voice/kokoro/config/kokoroConfig';
import { previewLocalNeuralTts } from './previewLocalNeuralTts';
import { t } from '@/text';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';

import type { LocalTtsProviderSpec } from '../_types';

const LocalNeuralProviderSettings: LocalTtsProviderSpec['Settings'] = (props) => {
  return (
    <LocalNeuralTtsSettings
      cfgKokoro={props.cfgTts.localNeural}
      setKokoro={(next) =>
        props.setTts({
          ...props.cfgTts,
          provider: 'local_neural',
          localNeural: { ...next, model: 'kokoro' },
        })}
      networkTimeoutMs={props.networkTimeoutMs}
      popoverBoundaryRef={props.popoverBoundaryRef}
      daemonRouteDiagnosticReason={props.daemonRouteDiagnosticReason}
    />
  );
};

export const localNeuralTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'local_neural',
  get title() { return t('settingsVoice.local.localNeuralTts.provider.title'); },
  get subtitle() { return t('settingsVoice.local.localNeuralTts.provider.subtitle'); },
  iconName: 'sparkle',
  get detail() { return t('settingsVoice.local.localNeuralTts.provider.detail'); },
  Settings: LocalNeuralProviderSettings,
  resolvePreferredExecution: (requestedExecution) => resolveLocalNeuralExecutionPolicy({ requestedExecution }).preferredExecution,
  test: async ({ cfgTts, networkTimeoutMs, sample, signal, isCurrent, registerPlaybackStopper }) => previewLocalNeuralTts({
    config: cfgTts.localNeural, sample, timeoutMs: resolveKokoroOperationTimeoutMs(networkTimeoutMs),
    signal, isCurrent, registerPlaybackStopper: registerPlaybackStopper ?? ((_stopper) => () => {}),
  }),
};
