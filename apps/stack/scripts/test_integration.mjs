import { collectTestFiles } from './utils/test/collect_test_files.mjs';
import { collectStackIntegrationTestFiles } from './utils/test/test_collection.mjs';
import {
  formatRealIntegrationSkipMessage,
  resolveIntegrationRunPlan,
} from './utils/test/integration_test_runner.mjs';
import { runNodeTestFilesSync } from './utils/test/test_process.mjs';

async function main() {
  const { packageRoot, scriptsDir, testsDir, testFiles } = await collectStackIntegrationTestFiles(import.meta.url, {
    collect: collectTestFiles,
  });

  if (testFiles.length === 0) {
    process.stdout.write('[stack:test:integration] no integration test files found; skipping\n');
    process.exit(0);
  }

  const { regular, real, runReal } = resolveIntegrationRunPlan(testFiles, process.env);

  if (regular.length > 0) {
    // Stack integration files share mutable workspace build artifacts and bundled runtime outputs.
    // Run them serially to avoid races between files that rebuild or resync those artifacts.
    const res = runNodeTestFilesSync(regular, { cwd: packageRoot, env: process.env, serial: true });
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
  }

  if (real.length > 0 && !runReal) {
    process.stdout.write(formatRealIntegrationSkipMessage(real.length));
    process.exit(0);
  }

  // Real integration tests may install/uninstall OS services and build global release assets,
  // which is not safe under Node's default parallel test file execution.
  for (const file of real) {
    const res = runNodeTestFilesSync([file], { cwd: packageRoot, env: process.env, serial: true });
    if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[stack:test:integration] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
