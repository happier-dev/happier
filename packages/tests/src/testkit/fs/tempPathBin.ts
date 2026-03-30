import { join } from 'node:path';

import { createTempDir, removeTempDir } from './tempDir';

export type TempPathBin = Readonly<{
  dir: string;
  path: string;
  env: NodeJS.ProcessEnv;
  pathKey: string;
  cleanup: () => Promise<void>;
  extendEnv: (baseEnv?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  resolveCommandPath: (commandName: string) => string;
}>;

type CreateTempPathBinOptions = Readonly<{
  prefix: string;
  baseDir?: string;
  env?: NodeJS.ProcessEnv;
  pathKey?: string;
}>;

export function resolvePathEnvKey(env: NodeJS.ProcessEnv = process.env): string {
  const existing = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return existing ?? 'PATH';
}

export function prependPathEntry(pathEntry: string, env: NodeJS.ProcessEnv = process.env, pathKey = resolvePathEnvKey(env)): NodeJS.ProcessEnv {
  const current = String(env[pathKey] ?? '').trim();
  return {
    ...env,
    [pathKey]: current.length > 0 ? `${pathEntry}${process.platform === 'win32' ? ';' : ':'}${current}` : pathEntry,
  };
}

export async function createTempPathBin(options: CreateTempPathBinOptions): Promise<TempPathBin> {
  const dir = await createTempDir({
    prefix: options.prefix,
    baseDir: options.baseDir,
  });
  const pathKey = options.pathKey ?? resolvePathEnvKey(options.env);
  const env = prependPathEntry(dir, options.env, pathKey);

  return {
    dir,
    path: dir,
    env,
    pathKey,
    cleanup: async () => {
      await removeTempDir(dir);
    },
    extendEnv: (baseEnv = process.env) => prependPathEntry(dir, baseEnv, pathKey),
    resolveCommandPath: (commandName: string) => join(dir, commandName),
  };
}

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
