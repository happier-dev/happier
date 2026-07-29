import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testsDir = join(rootDir, 'packages', 'tests');

const result = spawnSync(
  process.execPath,
  [
    'scripts/runTsxEntrypoint.mjs',
    'src/testkit/terminal/benchReportCli.ts',
    ...process.argv.slice(2),
  ],
  {
    cwd: testsDir,
    env: process.env,
    stdio: 'inherit',
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
