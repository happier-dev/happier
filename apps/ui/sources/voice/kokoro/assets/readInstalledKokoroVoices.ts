import type { InstalledKokoroVoiceCatalogInput, KokoroVoiceSummary } from './readInstalledKokoroVoices.native';
export type { InstalledKokoroVoiceCatalogInput, KokoroVoiceSummary } from './readInstalledKokoroVoices.native';

/** Device Kokoro is native-only. Browser/Node paths cannot resurrect the retired web runtime. */
export async function readInstalledKokoroVoices(_input: InstalledKokoroVoiceCatalogInput): Promise<readonly KokoroVoiceSummary[]> {
  return [];
}
