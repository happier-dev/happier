import './utils/env/env.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Repo convenience: configure global hstack/happier shims to run from THIS monorepo checkout.
 *
 * Why:
 * - Developers often have a stable runtime install, but want the CLI they run from any terminal
 *   to come from their local clone instead (to test changes).
 *
 * What it does:
 * - Runs: hstack init --cli-root-dir=<repo>/apps/stack --no-runtime --no-bootstrap [--install-path]
 *
 * Notes:
 * - `--install-path` edits shell config; keep it opt-in.
 * - Extra args are forwarded to `hstack init` (e.g. --home-dir=/tmp/... in tests).
 */

function main() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url)); // <repo>/apps/stack/scripts
  const repoRoot = dirname(dirname(dirname(scriptsDir))); // <repo>
  const cliRootDir = join(repoRoot, 'apps', 'stack');
  const hstackBin = join(cliRootDir, 'bin', 'hstack.mjs');

  const forwarded = process.argv.slice(2);
  const argv = [
    'init',
    `--cli-root-dir=${cliRootDir}`,
    '--no-runtime',
    '--no-bootstrap',
    ...forwarded,
  ];

  const res = spawnSync(process.execPath, [hstackBin, ...argv], { stdio: 'inherit', env: process.env });
  process.exit(res.status ?? 1);
}

main();

