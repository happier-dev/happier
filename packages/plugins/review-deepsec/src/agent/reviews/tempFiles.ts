import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeepSecTempFiles, DeepSecTempFileRequest } from './run.js';

export async function createDeepSecTempFiles(): Promise<DeepSecTempFiles> {
  const directory = await mkdtemp(join(tmpdir(), 'happier-deepsec-'));
  return {
    async createTextFile(request: DeepSecTempFileRequest) {
      const path = join(directory, `${randomUUID()}${request.suffix}`);
      await writeFile(path, request.contents, 'utf8');
      return path;
    },
    async createScopedPathListFile(request) {
      const path = join(directory, `${randomUUID()}${request.suffix}`);
      await writeFile(path, `${request.paths.join('\n')}\n`, 'utf8');
      return { status: 'created', path, paths: request.paths };
    },
    async readText(path: string) {
      return await readFile(path, 'utf8');
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
