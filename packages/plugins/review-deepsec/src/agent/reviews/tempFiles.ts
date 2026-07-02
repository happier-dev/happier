import type { FsRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import type { DeepSecTempFiles, DeepSecTempFileRequest } from './run.js';

export async function createDeepSecTempFiles(fs: Pick<FsRuntimeServiceV1, 'createTempDirectory'>): Promise<DeepSecTempFiles> {
  const directory = await fs.createTempDirectory({ prefix: 'happier-deepsec-' });
  return {
    async createTextFile(request: DeepSecTempFileRequest) {
      return await directory.createTextFile(request);
    },
    async createScopedPathListFile(request) {
      return await directory.createScopedPathListFile(request);
    },
    async readText(path: string) {
      return await directory.readText({ path });
    },
    async cleanup() {
      await directory.cleanup();
    },
  };
}
