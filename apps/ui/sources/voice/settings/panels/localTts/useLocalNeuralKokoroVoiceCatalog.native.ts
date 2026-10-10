import * as React from 'react';

import { readInstalledKokoroVoices, type KokoroVoiceSummary } from '@/voice/kokoro/assets/readInstalledKokoroVoices';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';

export type { KokoroVoiceSummary } from '@/voice/kokoro/assets/readInstalledKokoroVoices';

type InstallSummary = Awaited<ReturnType<typeof getModelPackInstallSummary>>;

export function useLocalNeuralKokoroVoiceCatalog(params: {
  installSummary: InstallSummary | null;
}): KokoroVoiceSummary[] {
  const [voices, setVoices] = React.useState<KokoroVoiceSummary[]>([]);

  React.useEffect(() => {
    let canceled = false;

    fireAndForget((async () => {
      const summary = params.installSummary;
      const catalog = await readInstalledKokoroVoices({ packId: summary?.manifest?.packId ?? '', installSummary: summary });
      if (!canceled) setVoices([...catalog]);
    })(), { tag: 'useLocalNeuralKokoroVoiceCatalog.load' });

    return () => {
      canceled = true;
    };
  }, [params.installSummary]);

  return voices;
}
