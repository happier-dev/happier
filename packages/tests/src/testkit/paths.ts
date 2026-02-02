import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRootDir(): string {
  // packages/tests/src/testkit/paths.ts -> repo root is ../../..
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export function projectLogsDir(): string {
  return resolve(repoRootDir(), '.project', 'logs', 'e2e');
}

