import { collectTestFiles } from './utils/test/collect_test_files.mjs';
import { collectStackUnitTestFiles } from './utils/test/test_collection.mjs';
import { runNodeTestFilesSync } from './utils/test/test_process.mjs';

async function main() {
  const { packageRoot, scriptsDir, testsDir, testFiles } = await collectStackUnitTestFiles(import.meta.url, {
    collect: collectTestFiles,
  });

  if (testFiles.length === 0) {
    process.stderr.write(`[stack:test] no .test.mjs files found under ${scriptsDir} or ${testsDir}\n`);
    process.exit(1);
  }

  // Node 20 does not expand globs for `--test`, so we enumerate files.
  const res = runNodeTestFilesSync(testFiles, { cwd: packageRoot, env: process.env });
  process.exit(res.status ?? 1);
}

main().catch((e) => {
  process.stderr.write(`[stack:test] ${String(e?.stack ?? e)}\n`);
  process.exit(1);
});
