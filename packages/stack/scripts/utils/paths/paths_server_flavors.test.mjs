import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getComponentDir } from './paths.mjs';

test('getComponentDir prefers happy-server for happy-server-light when unified schema exists', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'happy-stacks-paths-server-flavors-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };
  const fullDir = join(rootDir, 'components', 'happy-server');
  await mkdir(join(fullDir, 'prisma', 'sqlite'), { recursive: true });
  await writeFile(join(fullDir, 'prisma', 'sqlite', 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

  assert.equal(getComponentDir(rootDir, 'happy-server-light', env), fullDir);
});

test('getComponentDir falls back to components/happy-server-light when unified schema is missing', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'happy-stacks-paths-server-flavors-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const env = { HAPPIER_STACK_WORKSPACE_DIR: rootDir };
  const expected = join(rootDir, 'components', 'happy-server-light');
  assert.equal(getComponentDir(rootDir, 'happy-server-light', env), expected);
});

test('getComponentDir does not alias when HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT is set', async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'happy-stacks-paths-server-flavors-'));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const env = {
    HAPPIER_STACK_WORKSPACE_DIR: rootDir,
    HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT: '/tmp/custom/server-light',
  };
  assert.equal(getComponentDir(rootDir, 'happy-server-light', env), '/tmp/custom/server-light');
});
