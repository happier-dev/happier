import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTestFiles } from './utils/test/collect_test_files.mjs';

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
  const res = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

main().catch((e) => {
  process.stderr.write(`[stack:test:integration] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
