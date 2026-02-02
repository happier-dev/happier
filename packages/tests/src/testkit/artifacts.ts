import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function writeJsonArtifact(dir: string, name: string, value: unknown): string {
  const path = resolve(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

