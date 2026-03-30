import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} prefixDir
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {string}
 */
export function resolveInstalledBinPath(prefixDir, options = {}) {
  const platform = options.platform ?? process.platform;
  const exe = platform === 'win32' ? 'happier.cmd' : 'happier';

  const candidates = [
    path.join(prefixDir, 'bin', exe),
    path.join(prefixDir, exe),
    path.join(prefixDir, 'node_modules', '.bin', exe),
    path.join(prefixDir, 'lib', 'node_modules', '.bin', exe),
    path.join(prefixDir, 'lib', 'node_modules', '@happier-dev', 'cli', 'bin', platform === 'win32' ? 'happier.mjs' : 'happier.mjs'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return '';
}
