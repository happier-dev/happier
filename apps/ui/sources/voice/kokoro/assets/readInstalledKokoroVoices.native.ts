import { uriToFilePath } from '@/platform/fileUri';
import { getKokoroVoiceCatalog, resolveKokoroModelConfig } from '@happier-dev/protocol/voice/modelPacks/kokoro';
import { getOptionalHappierSherpaNativeModule } from '@happier-dev/sherpa-native';
import { getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';

export type KokoroVoiceSummary = Readonly<{ id: string; title: string; subtitle?: string }>;
export type InstalledKokoroVoiceCatalogInput = Readonly<{
  packId: string;
  installSummary?: Awaited<ReturnType<typeof getModelPackInstallSummary>> | null;
}>;

/** Settings, Work and playback read the installed model's actual catalog, never guessed voices. */
export async function readInstalledKokoroVoices(input: InstalledKokoroVoiceCatalogInput): Promise<readonly KokoroVoiceSummary[]> {
  const summary = input.installSummary === undefined
    ? await getModelPackInstallSummary({ packId: input.packId }) : input.installSummary;
  if (summary?.manifest?.voices?.length) return getKokoroVoiceCatalog(summary.manifest);
  if (summary?.installed && summary.packDirUri && summary.manifest) {
    try {
      const native = getOptionalHappierSherpaNativeModule();
      if (native && typeof native.listVoices === 'function') {
        const voices = await native.listVoices({ assetsDir: uriToFilePath(summary.packDirUri),
          frontend: resolveKokoroModelConfig(summary.manifest) });
        return getKokoroVoiceCatalog(summary.manifest, Array.isArray(voices) ? voices.length : null);
      }
    } catch {
      // An unavailable native catalog is not permission to invent a speaker list.
    }
  }
  return [];
}
