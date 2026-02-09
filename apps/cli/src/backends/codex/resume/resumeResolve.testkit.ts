import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TRACKED_ENV_KEYS = [
  'HAPPIER_HOME_DIR',
  'HAPPIER_CODEX_RESUME_MCP_SERVER_BIN',
  'HAPPIER_CODEX_RESUME_BIN',
] as const;

export function makeTempHomeDir(prefix = 'happier-codex-resume-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/usr/bin/env node\nprocess.exit(0)\n', 'utf8');
  try {
    chmodSync(path, 0o755);
  } catch {
    // ignore on platforms without chmod support for this file kind
  }
}

export function cleanupTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export async function withResumeEnv<T>(vars: Partial<Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined>>, run: () => Promise<T>): Promise<T> {
  const previous: Record<(typeof TRACKED_ENV_KEYS)[number], string | undefined> = {
    HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
    HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: process.env.HAPPIER_CODEX_RESUME_MCP_SERVER_BIN,
    HAPPIER_CODEX_RESUME_BIN: process.env.HAPPIER_CODEX_RESUME_BIN,
  };
  const touchedKeys = new Set<(typeof TRACKED_ENV_KEYS)[number]>();

  for (const key of TRACKED_ENV_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) continue;
    touchedKeys.add(key);
    const next = vars[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    return await run();
  } finally {
    for (const key of touchedKeys) {
      const prev = previous[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}
