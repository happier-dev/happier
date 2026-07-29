import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as pm from './pm.mjs';

async function writeMonorepo(root) {
  await writeFile(join(root, 'package.json'), '{"name":"monorepo","private":true}\n', 'utf-8');
  for (const component of ['ui', 'cli', 'server']) {
    const dir = join(root, 'apps', component);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), `{ "name": "@happier-dev/${component}" }\n`, 'utf-8');
  }
}

test('command dependency admission admits one resolved install root while preserving distinct roots', async (t) => {
  assert.equal(typeof pm.createCommandDependencyAdmission, 'function');

  const fixture = await mkdtemp(join(tmpdir(), 'hstack-command-dependency-admission-'));
  t.after(async () => rm(fixture, { recursive: true, force: true }));
  const firstRoot = join(fixture, 'first');
  const secondRoot = join(fixture, 'second');
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await writeMonorepo(firstRoot);
  await writeMonorepo(secondRoot);

  const calls = [];
  const componentPrerequisiteCalls = [];
  const admit = pm.createCommandDependencyAdmission({
    ensureDepsInstalledImpl: async (dir, label) => calls.push({ dir, label }),
    ensureComponentPrerequisitesImpl: async (dir, label) => componentPrerequisiteCalls.push({ dir, label }),
  });

  const first = await admit(join(firstRoot, 'apps', 'ui'), 'ui');
  const duplicate = await admit(join(firstRoot, 'apps', 'cli'), 'cli');
  const serverAfterDuplicateRoot = await admit(join(firstRoot, 'apps', 'server'), 'server');
  const distinct = await admit(join(secondRoot, 'apps', 'server'), 'server');

  assert.equal(first.admitted, true);
  assert.equal(duplicate.admitted, false);
  assert.equal(serverAfterDuplicateRoot.admitted, false);
  assert.equal(distinct.admitted, true);
  assert.deepEqual(calls, [
    { dir: join(firstRoot, 'apps', 'ui'), label: 'ui' },
    { dir: join(secondRoot, 'apps', 'server'), label: 'server' },
  ]);
  assert.deepEqual(componentPrerequisiteCalls, [
    { dir: join(firstRoot, 'apps', 'cli'), label: 'cli' },
    { dir: join(firstRoot, 'apps', 'server'), label: 'server' },
  ]);
});
