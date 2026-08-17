import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveWorkspaceToolBinDirs } from './workspace_tool_bins.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

test('resolveWorkspaceToolBinDirs publishes default shims outside Yarn-owned installed bins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-workspace-tool-bins-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), {
    name: '@happier-dev/app',
    private: true,
    devDependencies: {
      typescript: '5.9.3',
    },
  });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server', private: true });

  const typescriptDir = join(root, 'node_modules', 'typescript');
  const targetPath = join(typescriptDir, 'bin', 'tsc');
  await mkdir(join(typescriptDir, 'bin'), { recursive: true });
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeJson(join(typescriptDir, 'package.json'), {
    name: 'typescript',
    version: '5.9.3',
    bin: {
      tsc: './bin/tsc',
    },
  });
  const originalTarget = '#!/usr/bin/env node\nconsole.log("real tsc");\n';
  await writeFile(targetPath, originalTarget, 'utf-8');
  await chmod(targetPath, 0o755);
  await symlink('../typescript/bin/tsc', join(root, 'node_modules', '.bin', 'tsc'));

  const binDirs = await resolveWorkspaceToolBinDirs(join(root, 'apps', 'ui'));
  const isolatedBinDir = join(root, '.project', 'tmp', 'workspace-tool-bins');

  assert.deepEqual(binDirs, [isolatedBinDir]);
  assert.equal(await readFile(targetPath, 'utf-8'), originalTarget);
  assert.equal(await readlink(join(root, 'node_modules', '.bin', 'tsc')), '../typescript/bin/tsc');
  const shimPath = join(isolatedBinDir, 'tsc');
  assert.match(await readFile(shimPath, 'utf-8'), new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const firstShimStat = await stat(shimPath, { bigint: true });
  await delay(5);
  await resolveWorkspaceToolBinDirs(join(root, 'apps', 'ui'));
  const secondShimStat = await stat(shimPath, { bigint: true });
  assert.equal(secondShimStat.ino, firstShimStat.ino, 'an identical valid shim must remain read-only');
  assert.equal(secondShimStat.mtimeNs, firstShimStat.mtimeNs, 'an identical valid shim must not be republished');
});

test('resolveWorkspaceToolBinDirs tolerates concurrent isolated shim refreshes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-workspace-tool-bins-concurrent-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app', private: true });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli', private: true });
  await writeJson(join(root, 'apps', 'server', 'package.json'), {
    name: '@happier-dev/server',
    private: true,
    devDependencies: {
      typescript: '5.9.3',
    },
  });

  const typescriptDir = join(root, 'node_modules', 'typescript');
  await mkdir(join(typescriptDir, 'bin'), { recursive: true });
  await writeJson(join(typescriptDir, 'package.json'), {
    name: 'typescript',
    version: '5.9.3',
    bin: {
      tsc: './bin/tsc',
      tsserver: './bin/tsserver',
    },
  });
  await writeFile(join(typescriptDir, 'bin', 'tsc'), '#!/usr/bin/env node\nconsole.log("tsc");\n', 'utf-8');
  await writeFile(join(typescriptDir, 'bin', 'tsserver'), '#!/usr/bin/env node\nconsole.log("tsserver");\n', 'utf-8');
  await chmod(join(typescriptDir, 'bin', 'tsc'), 0o755);
  await chmod(join(typescriptDir, 'bin', 'tsserver'), 0o755);

  const binDir = join(root, '.project', 'tmp', 'workspace-tool-bins');
  let removing = true;
  const removeLoop = (async () => {
    while (removing) {
      await Promise.all([
        rm(join(binDir, 'tsc'), { force: true }),
        rm(join(binDir, 'tsserver'), { force: true }),
      ]);
      await delay(0);
    }
  })();

  try {
    await Promise.all(Array.from({ length: 64 }, () => resolveWorkspaceToolBinDirs(join(root, 'apps', 'server'))));
  } finally {
    removing = false;
    await removeLoop;
  }

  await resolveWorkspaceToolBinDirs(join(root, 'apps', 'server'));

  assert.match(await readFile(join(binDir, 'tsc'), 'utf-8'), /bin\/tsc/);
  assert.match(await readFile(join(binDir, 'tsserver'), 'utf-8'), /bin\/tsserver/);
});

test('resolveWorkspaceToolBinDirs exposes bins from workspace dependencies whose package manifests are not exported', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-workspace-tool-bins-internal-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'packages', 'consumer');
  const toolDir = join(root, 'packages', 'workspace-tool');
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(componentDir, { recursive: true });
  await mkdir(join(toolDir, 'dist'), { recursive: true });
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['packages/*'],
  });
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app' });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli' });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server' });
  await writeJson(join(componentDir, 'package.json'), {
    name: '@happier-dev/consumer',
    dependencies: {
      '@happier-dev/workspace-tool': '0.0.0',
    },
  });
  await writeJson(join(toolDir, 'package.json'), {
    name: '@happier-dev/workspace-tool',
    exports: {
      '.': './dist/index.js',
    },
    bin: {
      'workspace-tool': './dist/bin.js',
    },
  });
  await writeFile(join(toolDir, 'dist', 'index.js'), 'export {};\n', 'utf-8');
  await writeFile(join(toolDir, 'dist', 'bin.js'), '#!/usr/bin/env node\n', 'utf-8');

  const binDirs = await resolveWorkspaceToolBinDirs(componentDir);
  const binDir = join(root, '.project', 'tmp', 'workspace-tool-bins');

  assert.deepEqual(binDirs, [binDir]);
  assert.match(await readFile(join(binDir, 'workspace-tool'), 'utf-8'), /workspace-tool\/dist\/bin\.js/);
});

test('resolveWorkspaceToolBinDirs can publish isolated shims without mutating installed workspace bins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-workspace-tool-bins-isolated-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'packages', 'consumer');
  const toolDir = join(root, 'packages', 'workspace-tool');
  const installedBinDir = join(root, 'node_modules', '.bin');
  const isolatedBinDir = join(root, 'sandbox', 'node_modules', '.bin');
  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await mkdir(componentDir, { recursive: true });
  await mkdir(join(toolDir, 'dist'), { recursive: true });
  await mkdir(installedBinDir, { recursive: true });
  await writeJson(join(root, 'package.json'), {
    private: true,
    workspaces: ['packages/*'],
  });
  await writeFile(join(root, 'yarn.lock'), '# yarn\n', 'utf-8');
  await writeJson(join(root, 'apps', 'ui', 'package.json'), { name: '@happier-dev/app' });
  await writeJson(join(root, 'apps', 'cli', 'package.json'), { name: '@happier-dev/cli' });
  await writeJson(join(root, 'apps', 'server', 'package.json'), { name: '@happier-dev/server' });
  await writeJson(join(componentDir, 'package.json'), {
    name: '@happier-dev/consumer',
    dependencies: {
      '@happier-dev/workspace-tool': '0.0.0',
    },
  });
  await writeJson(join(toolDir, 'package.json'), {
    name: '@happier-dev/workspace-tool',
    bin: {
      'workspace-tool': './dist/bin.js',
    },
  });
  await writeFile(join(toolDir, 'dist', 'bin.js'), '#!/usr/bin/env node\n', 'utf-8');
  await writeFile(join(installedBinDir, 'workspace-tool'), 'installed-shim\n', 'utf-8');

  const binDirs = await resolveWorkspaceToolBinDirs(componentDir, {
    outputBinDir: isolatedBinDir,
  });

  assert.deepEqual(binDirs, [isolatedBinDir]);
  assert.equal(await readFile(join(installedBinDir, 'workspace-tool'), 'utf-8'), 'installed-shim\n');
  assert.match(
    await readFile(join(isolatedBinDir, 'workspace-tool'), 'utf-8'),
    /workspace-tool\/dist\/bin\.js/,
  );
});
