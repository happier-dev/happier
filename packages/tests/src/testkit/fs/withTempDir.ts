import { createTempDir, removeTempDir } from './tempDir';

type TempDirOptions = Readonly<{
  prefix: string;
  baseDir?: string;
}>;

// Legacy bridge for string-only callback callsites.
// New shared callsites should prefer `withTempDir` from `tempDir.ts` and use the handle shape.
export async function withTempDir<T>(options: TempDirOptions, run: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = await createTempDir(options);
  try {
    return await run(dir);
  } finally {
    await removeTempDir(dir);
  }
}
