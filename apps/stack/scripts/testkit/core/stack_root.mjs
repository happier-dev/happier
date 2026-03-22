import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function resolveStackRootFromMeta(metaUrl) {
  let current = dirname(fileURLToPath(metaUrl));
  while (basename(current) !== 'stack') {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve apps/stack root from ${metaUrl}`);
    }
    current = parent;
  }
  return current;
}

export function resolveStackScriptPath(rootDir, scriptName) {
  return join(rootDir, 'scripts', scriptName);
}

export function resolveStackBinPath(rootDir, binName = 'hstack.mjs') {
  return join(rootDir, 'bin', binName);
}

export function resolveHstackBinPath(rootDir) {
  return resolveStackBinPath(rootDir, 'hstack.mjs');
}
