import { collectTestFiles } from './utils/test/collect_test_files.mjs';
import { collectStackUnitTestFiles } from './utils/test/test_collection.mjs';
import { runStackTestFiles } from './utils/test/test_process.mjs';
import { createTestTempDirectory } from '../../../scripts/testing/process/temporaryDirectories.mjs';
import { resolveSignalExitCode } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import { prepareStackTestRuntime } from './utils/test/preparation.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

async function main() {
  const { packageRoot, scriptsDir, testsDir, testFiles } = await collectStackUnitTestFiles(import.meta.url, {
    collect: collectTestFiles,
    files: process.argv.slice(2),
  });

  const { monorepoRoot } = await prepareStackTestRuntime(packageRoot);

  if (testFiles.length === 0) {
    process.stderr.write(`[stack:test] no .test.mjs files found under ${scriptsDir} or ${testsDir}\n`);
    process.exit(1);
  }

  // Node 20 does not expand globs for `--test`, so we enumerate files.
  // Run serially: stack tests spawn real `node` subprocesses and mutate local fixture dirs; running
  // them concurrently makes failures non-deterministic (and can race bundled-deps preparation).
  const temporary = createTestTempDirectory('happier-stack-unit-');
  try {
    const res = await runStackTestFiles(testFiles, {
      cwd: packageRoot,
      // Preparation publishes through its finite owner before this separate
      // test envelope. Managed-child custody still owns cancellation/cleanup.
      admission: { repoDir: monorepoRoot || packageRoot },
      env: sanitizeStackTestRunnerEnv(process.env, {
        isolatedStackRoot: temporary.root,
        repoDir: monorepoRoot || packageRoot,
      }),
    });
    process.exitCode = res.ok ? res.code ?? resolveSignalExitCode(res.signal) : 1;
  } finally {
    temporary.cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`[stack:test] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
