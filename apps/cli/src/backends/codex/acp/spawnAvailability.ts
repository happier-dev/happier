import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { delimiter as pathDelimiter, join } from 'node:path';

import type { SpawnSpec } from './resolveCommand';

type Ok = Readonly<{ ok: true }>;
type Err = Readonly<{ ok: false; errorMessage: string }>;

function isRunnablePath(
  candidatePath: string,
  accessSyncFn: typeof accessSync,
): boolean {
  try {
    accessSyncFn(candidatePath, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isBinOnPath(
  baseName: string,
  env: NodeJS.ProcessEnv,
  existsSyncFn: typeof existsSync,
  accessSyncFn: typeof accessSync,
): boolean {
  const path = typeof env.PATH === 'string' ? env.PATH : '';
  if (!path) return false;

  const candidates =
    process.platform === 'win32'
      ? [`${baseName}.cmd`, `${baseName}.exe`, baseName]
      : [baseName];

  for (const dir of path.split(pathDelimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of candidates) {
      try {
        const candidatePath = join(trimmed, name);
        if (existsSyncFn(candidatePath) && isRunnablePath(candidatePath, accessSyncFn)) return true;
      } catch {
        // ignore
      }
    }
  }
  return false;
}

export function validateCodexAcpSpawnAvailability(
  spec: SpawnSpec,
  opts: Readonly<{
    env?: NodeJS.ProcessEnv;
    existsSyncFn?: typeof existsSync;
    accessSyncFn?: typeof accessSync;
  }> = {},
): Ok | Err {
  const env = opts.env ?? process.env;
  const existsSyncFn = opts.existsSyncFn ?? existsSync;
  const accessSyncFn = opts.accessSyncFn ?? accessSync;

  if (spec.command === 'codex-acp') {
    if (isBinOnPath('codex-acp', env, existsSyncFn, accessSyncFn)) return { ok: true };
    return { ok: false, errorMessage: 'codex-acp is not available on PATH' };
  }

  // Absolute/relative resolved paths are allowed (env overrides + capability installs).
  // Treat missing paths as unavailable.
  if (!existsSyncFn(spec.command)) {
    return { ok: false, errorMessage: `Resolved command does not exist: ${spec.command}` };
  }
  if (!isRunnablePath(spec.command, accessSyncFn)) {
    return { ok: false, errorMessage: `Resolved command is not executable: ${spec.command}` };
  }

  return { ok: true };
}
