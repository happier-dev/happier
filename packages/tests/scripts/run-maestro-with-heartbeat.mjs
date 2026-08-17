import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { runManagedChildCommand, resolveSignalExitCode } from '../../../scripts/testing/process/managedChildLifecycle.mjs';

function resolveRepoRoot() {
  // `packages/tests/scripts/run-maestro-with-heartbeat.mjs` -> repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..');
}

function resolveTsxImportHook(repoRoot) {
  const candidates = [
    resolve(repoRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
    resolve(repoRoot, 'packages', 'tests', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

const repoRoot = resolveRepoRoot();
const tsxImportHook = resolveTsxImportHook(repoRoot);
if (!tsxImportHook) {
  // eslint-disable-next-line no-console
  console.error('[tests] Missing `tsx` dependency. Run `yarn install` and retry.');
  process.exit(1);
}

const cliPath = resolve(repoRoot, 'packages', 'tests', 'src', 'testkit', 'maestro', 'mobileMaestroCli.ts');

const result = await runManagedChildCommand({
  command: process.execPath,
  args: ['--import', tsxImportHook, cliPath, ...process.argv.slice(2)],
  spawnOptions: {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
  },
  cleanupPollMs: 25,
  signalCleanupGraceMs: 0,
  exitCleanupGraceMs: 1_000,
  parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  onParentDeath: async () => {
    process.exit(1);
  },
});

if (!result.ok) {
  // eslint-disable-next-line no-console
  console.error('[tests] `tsx` invocation failed.');
  process.exit(1);
}

const exitCode = typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
process.exit(exitCode);
