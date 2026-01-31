import { homedir } from 'node:os';
import { join } from 'node:path';

export function parseDotenv(contents) {
  const out = new Map();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const idx = line.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('~/')) {
      value = join(homedir(), value.slice(2));
    }
    out.set(key, value);
  }
  return out;
}

export function parseEnvToObject(contents) {
  return Object.fromEntries(parseDotenv(contents));
}
