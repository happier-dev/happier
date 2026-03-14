import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hstackBinPath, runNodeCapture } from './testkit/auth_testkit.mjs';

async function createMonorepoFixture({ prefix }) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const cliSrcDir = join(dir, 'apps', 'cli', 'src');
  await mkdir(cliSrcDir, { recursive: true });
  await mkdir(join(dir, 'apps', 'ui'), { recursive: true });
  await mkdir(join(dir, 'apps', 'server'), { recursive: true });

  await writeFile(join(dir, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'apps', 'cli', 'tsconfig.json'), '{\"compilerOptions\":{}}\n', 'utf-8');
  await writeFile(join(dir, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(dir, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

  await writeFile(
    join(cliSrcDir, 'index.ts'),
    [
      "const args = process.argv.slice(2);",
      "if (args.includes('--help') || args.includes('-h')) {",
      "  console.log('FAKE TS CLI HELP');",
      "  process.exit(0);",
      "}",
      "console.log('FAKE TS CLI RUN');",
      '',
    ].join('\n'),
    'utf-8',
  );

  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function stackRootDirFromMeta(metaUrl) {
  const scriptsDir = dirname(fileURLToPath(metaUrl));
  return dirname(scriptsDir);
}

test('hstack happier falls back to tsx when CLI dist is missing', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-tsx-fallback-' });

  const env = {
    ...process.env,
    // Keep the test hermetic: do not load a real stack env file.
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: join(fixture.dir, '.happy-home'),
  };

  try {
    const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', '--help'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /FAKE TS CLI HELP/, `expected tsx fallback help output\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stdout, /\[happier\] usage:/, `expected wrapper help to be suppressed\nstdout:\n${res.stdout}`);
  } finally {
    await fixture.cleanup();
  }
});

test('hstack happier falls back to tsx when dist entrypoint exists but is incomplete', async () => {
  const rootDir = stackRootDirFromMeta(import.meta.url);
  const fixture = await createMonorepoFixture({ prefix: 'hstack-happier-tsx-incomplete-dist-' });

  const cliDistDir = join(fixture.dir, 'apps', 'cli', 'dist');
  await mkdir(cliDistDir, { recursive: true });
  await writeFile(
    join(cliDistDir, 'index.mjs'),
    [
      "import './missing-chunk.mjs';",
      "console.log('FAKE DIST CLI RUN');",
      '',
    ].join('\n'),
    'utf-8',
  );

  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(rootDir, 'scripts', 'nonexistent-env'),
    HAPPIER_STACK_REPO_DIR: fixture.dir,
    HAPPIER_HOME_DIR: join(fixture.dir, '.happy-home'),
  };

  try {
    const res = await runNodeCapture([hstackBinPath(rootDir), 'happier', '--help'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    assert.match(res.stdout, /FAKE TS CLI HELP/, `expected tsx fallback help output\nstdout:\n${res.stdout}`);
    assert.doesNotMatch(res.stdout, /Cannot find module/, `expected incomplete dist to recover via tsx fallback\nstderr:\n${res.stderr}`);
  } finally {
    await fixture.cleanup();
  }
});
