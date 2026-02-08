import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function collectIntegrationTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await collectIntegrationTestFiles(p)));
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith('.integration.test.mjs') && !e.name.endsWith('.real.integration.test.mjs')) continue;
    files.push(p);
  }
  files.sort();
  return files;
}

async function main() {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const scriptsDir = join(packageRoot, 'scripts');
  const testsDir = join(packageRoot, 'tests');

  const testFiles = [];
  testFiles.push(...(await collectIntegrationTestFiles(scriptsDir)));
  testFiles.push(...(await collectIntegrationTestFiles(testsDir)));

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
