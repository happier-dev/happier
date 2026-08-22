import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveTsxEntrypointLaunchSpec } from '../runTsxEntrypoint.mjs';

/**
 * Runs every Plugin Platform contract test under `src/plugin-platform/`.
 *
 * The contract tests used to be reachable only through per-file package scripts, which meant a new
 * `*.test.ts` beside them silently had no runner. The file set is derived from the directory here
 * so adding a contract test is enough to have it executed by `yarn test` and by CI.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const contractDirectory = join(workspaceRoot, 'src', 'plugin-platform');

export function collectPluginPlatformContractEntrypoints(
  readDirectory = () => readdirSync(contractDirectory),
) {
  return readDirectory()
    .filter((entry) => entry.endsWith('.test.ts'))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => `src/plugin-platform/${entry}`);
}

function main() {
  const entrypoints = collectPluginPlatformContractEntrypoints();
  if (entrypoints.length === 0) {
    throw new Error(`No Plugin Platform contract tests were found in ${contractDirectory}`);
  }

  let status = 0;
  for (const entrypoint of entrypoints) {
    console.log(`\n▶ ${entrypoint}`);
    const spec = resolveTsxEntrypointLaunchSpec({ cwd: workspaceRoot, entrypoint, args: [] });
    const result = spawnSync(spec.command, spec.args, {
      cwd: workspaceRoot,
      env: { ...process.env, ...spec.env },
      stdio: 'inherit',
    });
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      status = 1;
    }
  }

  process.exit(status);
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFilePath) {
  main();
}
