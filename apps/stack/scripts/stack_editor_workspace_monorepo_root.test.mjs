import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeStackCodeWorkspace } from './utils/stack/editor_workspace.mjs';

test('stack code workspace groups monorepo components to the monorepo root', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-stack-workspace-mono-'));

  const storageDir = join(tmp, 'storage');
  const homeDir = join(tmp, 'home');
  const stackName = 'exp-test';

  const prevStorage = process.env.HAPPIER_STACK_STORAGE_DIR;
  const prevHome = process.env.HAPPIER_STACK_HOME_DIR;
  process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;
  process.env.HAPPIER_STACK_HOME_DIR = homeDir;

  try {
    const monoRoot = join(tmp, 'mono');
    await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
    await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
    await writeFile(join(monoRoot, 'apps', 'ui', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'cli', 'package.json'), '{}\n', 'utf-8');
    await writeFile(join(monoRoot, 'apps', 'server', 'package.json'), '{}\n', 'utf-8');

    const envPath = join(storageDir, stackName, 'env');
    await mkdir(dirname(envPath), { recursive: true });
    await writeFile(
      envPath,
      [
        'HAPPIER_STACK_SERVER_COMPONENT=happy-server',
        `HAPPIER_STACK_REPO_DIR=${monoRoot}`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const ws = await writeStackCodeWorkspace({
      rootDir,
      stackName,
      includeStackDir: false,
      includeAllComponents: false,
      includeCliHome: false,
    });

    assert.equal(ws.folders.length, 1);
    assert.equal(ws.folders[0].path, monoRoot);
  } finally {
    if (prevStorage == null) delete process.env.HAPPIER_STACK_STORAGE_DIR;
    else process.env.HAPPIER_STACK_STORAGE_DIR = prevStorage;
    if (prevHome == null) delete process.env.HAPPIER_STACK_HOME_DIR;
    else process.env.HAPPIER_STACK_HOME_DIR = prevHome;
    await rm(tmp, { recursive: true, force: true });
  }
});
