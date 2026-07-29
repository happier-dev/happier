import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as stackHappierPassthrough from './stack_happier_passthrough_command.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';

const { resolveStackHappierPassthroughInvocation } = stackHappierPassthrough;

test('resolveStackHappierPassthroughInvocation strips spaced wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity', 'account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation strips inline wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation preserves child identity args after separator', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--', '--identity', 'child-account', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--identity', 'child-account', '--json']);
});

test('resolveStackHappierPassthroughEntrypoint prefers the stack-pinned repo wrapper over the launcher root', async (t) => {
  const resolveStackHappierPassthroughEntrypoint =
    stackHappierPassthrough.resolveStackHappierPassthroughEntrypoint;
  assert.equal(typeof resolveStackHappierPassthroughEntrypoint, 'function');

  const fixture = await createTempFixture(t, { prefix: 'happier-passthrough-entrypoint-' });
  const fixtureRoot = fixture.root;
  const launcherRoot = join(fixtureRoot, 'launcher', 'apps', 'stack');
  const targetRepoRoot = join(fixtureRoot, 'target-repo');
  const targetStackRoot = join(targetRepoRoot, 'apps', 'stack');
  await mkdir(join(launcherRoot, 'scripts'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'server'), { recursive: true });
  await mkdir(join(targetStackRoot, 'bin'), { recursive: true });
  await writeFile(join(launcherRoot, 'scripts', 'happier.mjs'), 'export {};\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/app"}\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8');
  await writeFile(join(targetStackRoot, 'bin', 'happier.mjs'), 'export {};\n', 'utf-8');

  const resolved = resolveStackHappierPassthroughEntrypoint({
    rootDir: launcherRoot,
    env: {
      HAPPIER_STACK_REPO_DIR: targetRepoRoot,
    },
  });

  assert.deepEqual(resolved, {
    cwd: targetStackRoot,
    entrypoint: join(targetStackRoot, 'bin', 'happier.mjs'),
    source: 'stack-repo-wrapper',
  });
});
