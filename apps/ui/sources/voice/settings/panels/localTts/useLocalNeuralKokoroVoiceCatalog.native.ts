import * as React from 'react';

import { getKokoroSherpaVoiceCatalogForSpeakerCount } from '@/voice/kokoro/voices/kokoroSherpaVoiceMapping';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';

export type KokoroVoiceSummary = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
}>;

type InstallSummary = Awaited<ReturnType<typeof getModelPackInstallSummary>>;

function uriToFilePath(uri: string): string {
  if (uri.startsWith('file://')) return uri.slice('file://'.length);
  return uri;
}

function normalizeManifestVoiceRow(row: unknown): KokoroVoiceSummary | null {
  if (!row || typeof row !== 'object') return null;
  const id = (row as any).id;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  const titleRaw = (row as any).title;
  const subtitleRaw = (row as any).subtitle;
  return {
    id: String(id),
    title: typeof titleRaw === 'string' && titleRaw.trim().length > 0 ? titleRaw : String(id),
    subtitle: typeof subtitleRaw === 'string' && subtitleRaw.trim().length > 0 ? subtitleRaw : undefined,
  };
}

export function useLocalNeuralKokoroVoiceCatalog(params: {
  installSummary: InstallSummary | null;
}): KokoroVoiceSummary[] {
  const [voices, setVoices] = React.useState<KokoroVoiceSummary[]>([]);

  React.useEffect(() => {
    let canceled = false;

    fireAndForget((async () => {
      const manifestVoices: unknown[] | null =
        Array.isArray((params.installSummary as any)?.manifest?.voices) ? ((params.installSummary as any).manifest.voices as unknown[]) : null;

      if (manifestVoices && manifestVoices.length > 0) {
        const rows = manifestVoices.map(normalizeManifestVoiceRow).filter((row): row is KokoroVoiceSummary => Boolean(row));
        if (!canceled) setVoices(rows);
        return;
      }

      if ((params.installSummary as any)?.installed && typeof (params.installSummary as any)?.packDirUri === 'string') {
        const assetsDirUri = String((params.installSummary as any).packDirUri);
        const assetsDirPath = uriToFilePath(assetsDirUri);

        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const pkg = require('@happier-dev/sherpa-native') as any;
          const native =
            typeof pkg?.getOptionalHappierSherpaNativeModule === 'function' ? pkg.getOptionalHappierSherpaNativeModule() : null;

          if (native && typeof native.listVoices === 'function') {
            const nativeVoices = await native.listVoices({ assetsDir: assetsDirPath });
            const speakerCount = Array.isArray(nativeVoices) ? nativeVoices.length : null;
            const catalog = getKokoroSherpaVoiceCatalogForSpeakerCount(speakerCount);
            if (catalog) {
              if (!canceled) setVoices(catalog.map((v) => ({ id: v.id, title: v.title, subtitle: v.subtitle })));
              return;
            }
            if (speakerCount && speakerCount > 0) {
              if (!canceled) setVoices(Array.from({ length: speakerCount }).map((_, i) => ({ id: `sid:${i}`, title: `Speaker ${i}` })));
              return;
            }
          }
        } catch {
          // ignore
        }
      }

      // Fallback: show a stable catalog so the dropdown is never empty.
      const fallback = getKokoroSherpaVoiceCatalogForSpeakerCount(53) ?? [];
      if (!canceled) setVoices(fallback.map((v) => ({ id: v.id, title: v.title, subtitle: v.subtitle })));
    })(), { tag: 'useLocalNeuralKokoroVoiceCatalog.load' });

    return () => {
      canceled = true;
    };
  }, [params.installSummary]);

  return voices;
}
