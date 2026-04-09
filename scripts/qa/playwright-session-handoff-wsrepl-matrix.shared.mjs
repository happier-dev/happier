// @ts-check

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveRepoRoot() {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(join(here, '..', '..'));
}
