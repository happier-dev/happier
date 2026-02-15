import * as React from 'react';

import { LocalNeuralTtsSettings } from '@/voice/settings/panels/localTts/LocalNeuralTtsSettings';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';

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
    />
  );
};

export const localNeuralTtsProviderSpec: LocalTtsProviderSpec = {
  id: 'local_neural',
  title: 'Local neural (beta)',
  subtitle: 'Kokoro model. Uses Kokoro-js on web and Sherpa-ONNX on native (requires a model download).',
  iconName: 'sparkles-outline',
  detail: 'Kokoro',
  Settings: LocalNeuralProviderSettings,
  test: async ({ cfgTts, networkTimeoutMs, sample }) => {
    await speakKokoroText({
      text: sample,
      assetSetId: cfgTts.localNeural.assetId,
      voiceId: cfgTts.localNeural.voiceId ?? 'af_heart',
      speed: cfgTts.localNeural.speed ?? 1,
      timeoutMs: Math.max(60_000, networkTimeoutMs),
      registerPlaybackStopper: (_stopper) => () => {},
    });
  },
};
