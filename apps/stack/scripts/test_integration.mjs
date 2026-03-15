import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTestFiles } from './utils/test/collect_test_files.mjs';
import { shouldRunRealIntegrationTests, splitRealIntegrationTests } from './utils/test/integration_test_runner.mjs';

async function main() {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const scriptsDir = join(packageRoot, 'scripts');
  const testsDir = join(packageRoot, 'tests');

  const testFiles = [];
  testFiles.push(...(await collectTestFiles({
    dir: scriptsDir,
    includeSuffixes: ['.integration.test.mjs', '.real.integration.test.mjs'],
  })));
  testFiles.push(...(await collectTestFiles({
    dir: testsDir,
    includeSuffixes: ['.integration.test.mjs', '.real.integration.test.mjs'],
  })));

  if (testFiles.length === 0) {
    process.stdout.write('[stack:test:integration] no integration test files found; skipping\n');
    process.exit(0);
  }

  const { spawnSync } = await import('node:child_process');
  const { regular, real } = splitRealIntegrationTests(testFiles);
  const runReal = shouldRunRealIntegrationTests(process.env);

  if (regular.length > 0) {
    const res = spawnSync(process.execPath, ['--test', ...regular], { stdio: 'inherit' });
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
  }

  if (real.length > 0 && !runReal) {
    process.stdout.write(
      `[stack:test:integration] skipping ${real.length} real integration test file(s). ` +
        `To run them: HAPPIER_STACK_RUN_REAL_INTEGRATION_TESTS=1\n`,
    );
    process.exit(0);
  }

  // Real integration tests may install/uninstall OS services and build global release assets,
  // which is not safe under Node's default parallel test file execution.
  for (const file of real) {
    const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file], { stdio: 'inherit' });
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[stack:test:integration] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
