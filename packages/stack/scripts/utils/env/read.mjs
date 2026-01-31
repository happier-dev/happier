import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { parseDotenv } from './dotenv.mjs';

export async function readEnvValueFromFile(envPath, key, { defaultValue = '' } = {}) {
  try {
    const p = String(envPath ?? '').trim();
    const k = String(key ?? '').trim();
    if (!p || !k) return defaultValue;
    if (!existsSync(p)) return defaultValue;
    const raw = await readFile(p, 'utf-8');
    const parsed = parseDotenv(raw ?? '');
    return String(parsed.get(k) ?? '').trim();
  } catch {
    return defaultValue;
  }
}

export async function readEnvObjectFromFile(envPath) {
  try {
    const p = String(envPath ?? '').trim();
    if (!p || !existsSync(p)) return {};
    const raw = await readFile(p, 'utf-8');
    return Object.fromEntries(parseDotenv(raw ?? '').entries());
  } catch {
    return {};
  }
}

