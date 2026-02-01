import { readFile } from 'node:fs/promises';

export async function readLastLines(path, lines = 60) {
  try {
    const raw = await readFile(path, 'utf-8');
    const parts = raw.split('\n');
    return parts.slice(Math.max(0, parts.length - lines)).join('\n');
  } catch {
    return null;
  }
}

