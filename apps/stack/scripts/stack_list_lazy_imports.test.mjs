import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

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
