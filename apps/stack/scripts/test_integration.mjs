import { collectTestFiles } from './utils/test/collect_test_files.mjs';
import { collectStackIntegrationTestFiles } from './utils/test/test_collection.mjs';
import {
  formatRealIntegrationSkipMessage,
  resolveIntegrationRunPlan,
} from './utils/test/integration_test_runner.mjs';
import { runStackTestFiles } from './utils/test/test_process.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';
import { prepareStackTestRuntime } from './utils/test/preparation.mjs';
import { createTestTempDirectory } from '../../../scripts/testing/process/temporaryDirectories.mjs';
import { resolveSignalExitCode } from '../../../scripts/testing/process/managedChildLifecycle.mjs';

async function main() {
  const { packageRoot, scriptsDir, testsDir, testFiles } = await collectStackIntegrationTestFiles(import.meta.url, {
    collect: collectTestFiles,
  });

  if (testFiles.length === 0) {
    process.stdout.write('[stack:test:integration] no integration test files found; skipping\n');
    process.exit(0);
  }

  const { regular, real, runReal } = resolveIntegrationRunPlan(testFiles, process.env);
  const { monorepoRoot } = await prepareStackTestRuntime(packageRoot, { integration: true });
  const temporary = createTestTempDirectory('happier-stack-integration-');
  try {
    const testEnv = sanitizeStackTestRunnerEnv(process.env, {
      isolatedStackRoot: temporary.root,
      repoDir: monorepoRoot || packageRoot,
    });
    // Regular files share mutable runtime outputs and remain serial. Opted-in
    // real tests retain a separate serial process for each file.
    const batches = [...(regular.length ? [regular] : []), ...(runReal ? real.map(file => [file]) : [])];
    for (const files of batches) {
      // Preparation finishes before the finite reader acquires capacity.
      const res = await runStackTestFiles(files, {
        cwd: packageRoot,
        env: testEnv,
        admission: { repoDir: monorepoRoot || packageRoot },
      });
      const code = res.ok ? res.code ?? resolveSignalExitCode(res.signal) : 1;
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    }
    if (real.length > 0 && !runReal) process.stdout.write(formatRealIntegrationSkipMessage(real.length));
  } finally {
    temporary.cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`[stack:test:integration] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
