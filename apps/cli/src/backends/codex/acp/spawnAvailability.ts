import { existsSync } from 'node:fs';
import { delimiter as pathDelimiter, join } from 'node:path';

import type { SpawnSpec } from './resolveCommand';

type Ok = Readonly<{ ok: true }>;
type Err = Readonly<{ ok: false; errorMessage: string }>;

function isBinOnPath(baseName: string, env: NodeJS.ProcessEnv, existsSyncFn: typeof existsSync): boolean {
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
        if (existsSyncFn(join(trimmed, name))) return true;
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
  }> = {},
): Ok | Err {
  const env = opts.env ?? process.env;
  const existsSyncFn = opts.existsSyncFn ?? existsSync;

  if (spec.command === 'npx') {
    if (isBinOnPath('npx', env, existsSyncFn)) return { ok: true };
    return { ok: false, errorMessage: 'npx is not available on PATH' };
  }

  if (spec.command === 'codex-acp') {
    if (isBinOnPath('codex-acp', env, existsSyncFn)) return { ok: true };
    return { ok: false, errorMessage: 'codex-acp is not available on PATH' };
  }

  // Absolute/relative resolved paths are allowed (env overrides + capability installs).
  // Treat missing paths as unavailable.
  if (!existsSyncFn(spec.command)) {
    return { ok: false, errorMessage: `Resolved command does not exist: ${spec.command}` };
  }

  return { ok: true };
}

