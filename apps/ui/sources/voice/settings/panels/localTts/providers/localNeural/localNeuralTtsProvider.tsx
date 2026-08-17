import * as React from 'react';

import { LocalNeuralTtsSettings } from '@/voice/settings/panels/localTts/LocalNeuralTtsSettings';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { resolveKokoroOperationTimeoutMs } from '@/voice/kokoro/config/kokoroConfig';
import { DaemonTtsController } from '@/voice/runtime/daemonInference/DaemonTtsController';
import {
  resolveDaemonVoiceInferenceExecution,
  resolveLocalNeuralExecutionPolicy,
} from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { t } from '@/text';

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
  title: t('settingsVoice.local.localNeuralTts.provider.title'),
  subtitle: t('settingsVoice.local.localNeuralTts.provider.subtitle'),
  iconName: 'sparkle',
  detail: t('settingsVoice.local.localNeuralTts.provider.detail'),
  Settings: LocalNeuralProviderSettings,
  test: async ({ cfgTts, networkTimeoutMs, sample }) => {
    const executionPolicy = resolveLocalNeuralExecutionPolicy({
      requestedExecution: cfgTts.localNeural.execution,
    });
    const resolvedExecution = await resolveDaemonVoiceInferenceExecution({
      requestedExecution: cfgTts.localNeural.execution ?? 'auto',
      surface: 'tts',
    });

    if (resolvedExecution === 'daemon') {
      await new DaemonTtsController().speak({
        text: sample,
        packId: resolveKokoroDaemonTtsPackId(cfgTts.localNeural.assetId),
        voiceId: cfgTts.localNeural.voiceId ?? 'af_heart',
        speed: cfgTts.localNeural.speed ?? 1,
        registerPlaybackStopper: (_stopper) => () => {},
        onSpeaking: () => {},
      });
      return;
    }

    if (executionPolicy.preferredExecution !== 'device') {
      return;
    }

    await speakKokoroText({
      text: sample,
      assetSetId: cfgTts.localNeural.assetId,
      voiceId: cfgTts.localNeural.voiceId ?? 'af_heart',
      speed: cfgTts.localNeural.speed ?? 1,
      timeoutMs: resolveKokoroOperationTimeoutMs(networkTimeoutMs),
      registerPlaybackStopper: (_stopper) => () => {},
    });
  },
};
