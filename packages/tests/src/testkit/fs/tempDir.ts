import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type TempDirOptions = Readonly<{
  prefix: string;
  baseDir?: string;
}>;

export type TempDirHandle = Readonly<{
  path: string;
  dir: string;
  cleanup: () => Promise<void>;
}>;

function resolveTempDirBase(baseDir?: string): string {
  if (typeof baseDir === 'string' && baseDir.trim().length > 0) {
    return baseDir;
  }
  return tmpdir();
}

export async function createTempDir(options: TempDirOptions): Promise<string> {
  return await mkdtemp(join(resolveTempDirBase(options.baseDir), options.prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function createTempDirHandle(options: TempDirOptions): Promise<TempDirHandle> {
  const dir = await createTempDir(options);
  return {
    path: dir,
    dir,
    cleanup: async () => {
      await removeTempDir(dir);
    },
  };
}

export async function withTempDir<T>(options: TempDirOptions, run: (tempDir: TempDirHandle) => Promise<T> | T): Promise<T> {
  const tempDir = await createTempDirHandle(options);
  try {
    return await run(tempDir);
  } finally {
    await tempDir.cleanup();
  }
}
