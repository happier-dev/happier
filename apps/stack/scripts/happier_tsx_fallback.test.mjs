import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';
import { createHappierCliMonorepoFixture } from './testkit/happier_cli_monorepo_testkit.mjs';
import { writeStubHappierCliFiles } from './testkit/core/stub_happier_cli_files.mjs';

async function createMonorepoFixture(t, { prefix }) {
  return createHappierCliMonorepoFixture(t, {
    prefix,
    srcIndexScript: [
      "const args = process.argv.slice(2);",
      "if (args.includes('--help') || args.includes('-h')) {",
      "  console.log('FAKE TS CLI HELP');",
      "  process.exit(0);",
      "}",
      "console.log('FAKE TS CLI RUN');",
      '',
    ].join('\n'),
    tsconfigContent: '{"compilerOptions":{}}\n',
  });
}

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack happier falls back to tsx when CLI dist is missing', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-tsx-fallback-' });

  const env = {
    ...process.env,
    // Keep the test hermetic: do not load a real stack env file.
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: join(fixture.dir, '.happy-home'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /FAKE TS CLI HELP/, `expected tsx fallback help output\nstdout:\n${res.stdout}`);
  assert.doesNotMatch(res.stdout, /\[happier\] usage:/, `expected wrapper help to be suppressed\nstdout:\n${res.stdout}`);
});

test('hstack happier falls back to tsx when dist entrypoint exists but is incomplete', async (t) => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture(t, { prefix: 'hstack-happier-tsx-incomplete-dist-' });
  await writeStubHappierCliFiles(fixture.rootDir, {
    distIndexScript:
    [
      "import './missing-chunk.mjs';",
      "console.log('FAKE DIST CLI RUN');",
      '',
    ].join('\n'),
  });

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: join(fixture.dir, '.happy-home'),
  };

  const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', '--help'], { cwd: rootDir, env });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
  assert.match(res.stdout, /FAKE TS CLI HELP/, `expected tsx fallback help output\nstdout:\n${res.stdout}`);
  assert.doesNotMatch(res.stdout, /Cannot find module/, `expected incomplete dist to recover via tsx fallback\nstderr:\n${res.stderr}`);
});
