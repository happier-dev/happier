import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

function resolveCliDistBuildManifestModulePath() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const sourcePath = resolve(repoRoot, 'packages', 'cli-common', 'cliDistBuildManifest.cjs');
  const isRepoSource = existsSync(resolve(repoRoot, 'package.json')) && existsSync(resolve(repoRoot, 'yarn.lock'));
  return isRepoSource && existsSync(sourcePath)
    ? sourcePath
    : '@happier-dev/cli-common/cliDistBuildManifest';
}

export const cliDistBuildManifest = require(resolveCliDistBuildManifestModulePath());

export default cliDistBuildManifest;
