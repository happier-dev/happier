import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function resolveRepoRoot() {
  // `packages/tests/scripts/run-maestro-with-heartbeat.mjs` -> repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

function resolveTsxBin(repoRoot) {
  const candidates = [
    resolve(repoRoot, 'node_modules', '.bin', 'tsx'),
    resolve(repoRoot, 'node_modules', '.bin', 'tsx.cmd'),
    resolve(repoRoot, 'packages', 'tests', 'node_modules', '.bin', 'tsx'),
    resolve(repoRoot, 'packages', 'tests', 'node_modules', '.bin', 'tsx.cmd'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const repoRoot = resolveRepoRoot();
const tsxBin = resolveTsxBin(repoRoot);
if (!tsxBin) {
  // eslint-disable-next-line no-console
  console.error('[tests] Missing `tsx` dependency. Run `yarn install` and retry.');
  process.exit(1);
}

const cliPath = resolve(repoRoot, 'packages', 'tests', 'src', 'testkit', 'maestro', 'mobileMaestroCli.ts');

const result = spawnSync(tsxBin, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
  cwd: process.cwd(),
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

// eslint-disable-next-line no-console
console.error('[tests] `tsx` invocation failed.');
process.exit(1);
