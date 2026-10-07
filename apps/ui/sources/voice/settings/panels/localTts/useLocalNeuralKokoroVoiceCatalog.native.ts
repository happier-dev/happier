import * as React from 'react';

import { uriToFilePath } from '@/platform/fileUri';
import { getKokoroVoiceCatalog, resolveKokoroModelConfig } from '@happier-dev/protocol/voice/modelPacks/kokoro';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';

export type KokoroVoiceSummary = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
}>;

type InstallSummary = Awaited<ReturnType<typeof getModelPackInstallSummary>>;

export function useLocalNeuralKokoroVoiceCatalog(params: {
  installSummary: InstallSummary | null;
}): KokoroVoiceSummary[] {
  const [voices, setVoices] = React.useState<KokoroVoiceSummary[]>([]);

  React.useEffect(() => {
    let canceled = false;

    fireAndForget((async () => {
      const summary = params.installSummary;
      if (summary?.manifest?.voices?.length) {
        if (!canceled) setVoices([...getKokoroVoiceCatalog(summary.manifest)]);
        return;
      }

      if (summary?.installed && summary.packDirUri && summary.manifest) {
        const assetsDirUri = summary.packDirUri;
        const assetsDirPath = uriToFilePath(assetsDirUri);

        try {
          const native = getOptionalHappierSherpaNativeModule();

          if (native && typeof native.listVoices === 'function') {
            const nativeVoices = await native.listVoices({ assetsDir: assetsDirPath, frontend: resolveKokoroModelConfig(summary.manifest) });
            const speakerCount = Array.isArray(nativeVoices) ? nativeVoices.length : null;
            if (!canceled) setVoices([...getKokoroVoiceCatalog(summary.manifest, speakerCount)]);
            return;
          }
        } catch {
          // ignore
        }
      }

      if (!canceled) setVoices([]);
    })(), { tag: 'useLocalNeuralKokoroVoiceCatalog.load' });

    return () => {
      canceled = true;
    };
  }, [params.installSummary]);

  return voices;
}
