import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { downloadRemoteFileWithLimits, resolvePluginRemoteArchiveMaxBytes } from '@/plugins/discovery/remote/fetch';
import { createPluginStateStore } from '@/plugins/store/state';

export async function downloadRemoteArchiveToTempFile(params: Readonly<{
  happyHomeDir: string;
  archiveUrl: string;
  archiveName: string;
}>): Promise<Readonly<{ tempDir: string; archivePath: string }>> {
  const maxBytes = resolvePluginRemoteArchiveMaxBytes();
  const store = createPluginStateStore({ happyHomeDir: params.happyHomeDir });
  await mkdir(store.paths.cacheDir, { recursive: true });
  const tempDir = await mkdtemp(join(store.paths.cacheDir, 'plugin-download-'));
  const archivePath = join(tempDir, params.archiveName);

  try {
    await downloadRemoteFileWithLimits({
      url: params.archiveUrl,
      destinationPath: archivePath,
      maxBytes,
      errorLabel: 'Remote plugin archive',
    });
    return {
      tempDir,
      archivePath,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
