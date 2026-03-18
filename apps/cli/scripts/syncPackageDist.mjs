import { cpSync, existsSync } from 'node:fs';

import { rmDirSafeSync } from './rmDirSafe.mjs';

export function syncPackageDist() {
  if (!existsSync('dist')) {
    throw new Error('Cannot sync package-dist because dist is missing. Run the CLI build first.');
  }

  rmDirSafeSync('package-dist', {
    retries: 25,
    delayMs: 20,
  });
  cpSync('dist', 'package-dist', { recursive: true });
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  return arg.endsWith('/syncPackageDist.mjs') || arg.endsWith('\\syncPackageDist.mjs');
})();

if (isEntrypoint) {
  syncPackageDist();
}
