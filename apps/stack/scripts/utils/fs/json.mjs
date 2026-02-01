import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

export async function readJsonIfExists(path, { defaultValue = null } = {}) {
  try {
    const p = String(path ?? '').trim();
    if (!p || !existsSync(p)) return defaultValue;
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
}

export async function writeJsonAtomic(path, value) {
  const p = String(path ?? '').trim();
  if (!p) throw new Error('writeJsonAtomic: path is required');
  const dir = dirname(p);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const tmp = join(dir, `.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}.json`);
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  await rename(tmp, p);
}

