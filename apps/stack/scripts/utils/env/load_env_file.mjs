import { readFile } from 'node:fs/promises';
import { parseDotenv } from './dotenv.mjs';

export async function loadEnvFile(path, { override = false, overridePrefix = null } = {}) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      const allowOverride = override && (!overridePrefix || k.startsWith(overridePrefix));
      if (allowOverride || process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}

export async function loadEnvFileIgnoringPrefixes(path, { ignorePrefixes = [] } = {}) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      if (ignorePrefixes.some((p) => k.startsWith(p))) {
        continue;
      }
      if (process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}
