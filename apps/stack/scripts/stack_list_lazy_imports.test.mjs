import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildStackFixtureEnv } from './testkit/core/env_scope.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

const execFileAsync = promisify(execFile);

test('stack list does not load Protocol before listing stacks', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'hstack-list-imports-'));
  try {
    const loaderPath = join(fixtureDir, 'reject-protocol.mjs');
    await writeFile(loaderPath, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('@happier-dev/protocol')) {
    throw new Error('stack list loaded Protocol: ' + specifier);
  }
  return nextResolve(specifier, context);
}
`);
    for (const args of [['list', '--json'], ['--json', 'list'], ['list']]) {
      const { stdout } = await execFileAsync(process.execPath, [
        '--no-warnings',
        '--experimental-loader', loaderPath,
        join(import.meta.dirname, 'stack.mjs'),
        ...args,
      ], {
        cwd: join(import.meta.dirname, '..'),
        env: { ...process.env, HAPPIER_STACK_STORAGE_DIR: fixtureDir },
      });
      if (args.includes('--json')) {
        assert.deepEqual(JSON.parse(stdout), { stacks: [] });
      } else {
        assert.equal(stdout, '[stack] no stacks found\n');
      }
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test('hstack stack list preserves output without a second foreground Node process', async t => {
  const { root } = await createTempFixture(t, { prefix: 'hstack-list-processes-' });
  // Run the actual dispatcher with authored dependencies and an isolated
  // launcher root, so this process test never kicks off a checkout install.
  const cliRoot = join(root, 'apps', 'stack');
  await cp(join(import.meta.dirname, '../bin'), join(cliRoot, 'bin'), { recursive: true });
  await symlink(join(import.meta.dirname, '../../../scripts'), join(root, 'scripts'), 'junction');
  await symlink(import.meta.dirname, join(cliRoot, 'scripts'), 'junction');
  const stackDir = join(cliRoot, 'fixture-stacks', 'example');
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'env'), '');

  const counts = join(root, 'node-pids');
  const preload = join(root, 'preload.mjs');
  const runtime = new URL('../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url);
  await writeFile(preload, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(counts)}, process.pid + '\\n');`);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(cliRoot, 'bin/hstack.mjs'), 'stack', 'list', '--json',
  ], {
    cwd: root,
    env: buildStackFixtureEnv({ homeDir: root, storageDir: 'fixture-stacks', stripStackEnv: true,
      extraEnv: { HAPPIER_STACK_TOOLING_PACKAGES: 'live',
        NODE_OPTIONS: `--import=${runtime.href} --import=${pathToFileURL(preload).href}` } }),
  });
  assert.deepEqual(JSON.parse(stdout), { stacks: ['example'] });
  assert.equal(stderr, '');
  const pids = new Set((await readFile(counts, 'utf8')).trim().split('\n'));
  assert.equal(pids.size, 1, 'one Node process owns the invocation');
});

test('Stack dispatch and runtime helpers do not construct the unrelated Protocol root schemas', async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), 'hstack-dispatch-imports-'));
  try {
    const loaderPath = join(fixtureDir, 'reject-protocol-root.mjs');
    await writeFile(loaderPath, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@happier-dev/protocol') {
    throw new Error('Stack loaded the whole Protocol schema graph: ' + context.parentURL);
  }
  return nextResolve(specifier, context);
}
`);
    for (const args of [
      ['stack.mjs', 'info', '--help'],
      ['stack.mjs', 'build', '--help'],
      ['run.mjs', '--help'],
      ['dev.mjs', '--help'],
      ['tui.mjs', '--help'],
    ]) {
      const { stdout } = await execFileAsync(process.execPath, [
        '--no-warnings', '--experimental-loader', loaderPath,
        join(import.meta.dirname, args[0]), ...args.slice(1),
      ], {
        cwd: join(import.meta.dirname, '..'),
        env: { ...process.env, NODE_OPTIONS: '', HAPPIER_STACK_STORAGE_DIR: fixtureDir },
      });
      assert.match(stdout, /usage:/);
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
