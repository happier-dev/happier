import { runCapture } from './proc.mjs';
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';

export async function resolveCommandPath(cmd, { cwd, env, timeoutMs } = {}) {
  const c = String(cmd ?? '').trim();
  if (!c) return '';

  try {
    if (process.platform === 'win32') {
      const out = (await runCapture('where', [c], { cwd, env, timeoutMs })).trim();
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
      return first;
    }

    // Do not invoke a login shell to resolve PATH:
    // - `sh -lc` can source profile scripts that clobber PATH (breaking hermetic callers/tests)
    // - scanning PATH is deterministic and avoids shell injection edge cases
    if (c.includes('/') || c.includes('\\')) {
      if (!existsSync(c)) return '';
      try {
        accessSync(c, constants.X_OK);
        return c;
      } catch {
        return '';
      }
    }

    const e = env && typeof env === 'object' ? env : process.env;
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const pathEntries = String(e.PATH ?? '')
      .split(delimiter)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const dir of pathEntries) {
      const candidate = join(dir, c);
      if (!existsSync(candidate)) continue;
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // ignore non-executable candidates
      }
    }
    return '';
  } catch {
    return '';
  }
}

export async function runCaptureIfCommandExists(cmd, args, { cwd, env, timeoutMs } = {}) {
  const resolved = await resolveCommandPath(cmd, { cwd, env, timeoutMs });
  if (!resolved) return '';
  try {
    return await runCapture(resolved, args, { cwd, env, timeoutMs });
  } catch {
    return '';
  }
}

export async function commandExists(cmd, { cwd, env, timeoutMs } = {}) {
  return Boolean(await resolveCommandPath(cmd, { cwd, env, timeoutMs }));
}
