import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Next typegen does not remove declarations for routes that no longer exist.
 * Clear only its generated type subtree before rebuilding it for this package.
 */
export async function prepareNextTypegen({
  packageRoot = defaultPackageRoot,
  rmImpl = rm,
} = {}) {
  await rmImpl(resolve(packageRoot, '.next', 'types'), { recursive: true, force: true });
}

const isEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isEntrypoint) await prepareNextTypegen();
