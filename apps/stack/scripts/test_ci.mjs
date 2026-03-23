import { collectTestFiles } from './utils/test/collect_test_files.mjs';
import { collectStackUnitTestFiles } from './utils/test/test_collection.mjs';
import { runNodeTestFilesSync } from './utils/test/test_process.mjs';
import { ensureWorkspacePackagesBuiltForComponent } from './utils/proc/pm.mjs';
import { coerceHappyMonorepoRootFromPath } from './utils/paths/paths.mjs';
import { bundleWorkspaceDeps } from './bundleWorkspaceDeps.mjs';

async function main() {
  const { packageRoot, scriptsDir, testsDir, testFiles } = await collectStackUnitTestFiles(import.meta.url, {
    collect: collectTestFiles,
  });

  // Stack scripts import internal workspace packages via `exports` pointing at `dist/**`.
  // Ensure those packages are built so `node --test` can execute stack scripts in a fresh checkout.
  await ensureWorkspacePackagesBuiltForComponent(packageRoot, { quiet: true, env: process.env });

  // Stack unit tests execute `bin/hstack.mjs`, which runs as if `@happier-dev/stack` were installed
  // from npm with bundled internal deps. Ensure those bundled deps exist and have their external
  // runtime dependency trees vendored (e.g. `zod` for `@happier-dev/agents`).
  const monorepoRoot = coerceHappyMonorepoRootFromPath(packageRoot);
  if (monorepoRoot) {
    bundleWorkspaceDeps({ repoRoot: monorepoRoot, stackDir: packageRoot });
  }

  if (testFiles.length === 0) {
    process.stderr.write(`[stack:test] no .test.mjs files found under ${scriptsDir} or ${testsDir}\n`);
    process.exit(1);
  }

  // Node 20 does not expand globs for `--test`, so we enumerate files.
  // Run serially: stack tests spawn real `node` subprocesses and mutate local fixture dirs; running
  // them concurrently makes failures non-deterministic (and can race bundled-deps preparation).
  const res = runNodeTestFilesSync(testFiles, { cwd: packageRoot, env: process.env, serial: true });
  process.exit(res.status ?? 1);
}

main().catch((e) => {
  process.stderr.write(`[stack:test] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
