import { createTempPathBin, type TempPathBin } from './tempPathBin';

type CreateTempPathBinOptions = Readonly<{
  prefix: string;
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  pathKey?: string;
}>;

// Compatibility bridge while older callsites still import the dedicated callback wrapper path.
// Canonical shared usage should import from `tempPathBin.ts`.
export async function withTempPathBin<T>(
  options: CreateTempPathBinOptions,
  run: (tempPathBin: TempPathBin) => Promise<T> | T,
): Promise<T> {
  const tempPathBin = await createTempPathBin(options);
  try {
    return await run(tempPathBin);
  } finally {
    await tempPathBin.cleanup();
  }
}
