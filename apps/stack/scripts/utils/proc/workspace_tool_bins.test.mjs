import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveWorkspaceToolBinDirs } from './workspace_tool_bins.mjs';

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

test('resolveWorkspaceToolBinDirs does not overwrite package bin targets through existing symlinks', async (t) => {
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

  assert.ok(binDirs.includes(join(root, 'node_modules', '.bin')));
  assert.equal(await readFile(targetPath, 'utf-8'), originalTarget);
  assert.match(await readFile(join(root, 'node_modules', '.bin', 'tsc'), 'utf-8'), new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resolveWorkspaceToolBinDirs tolerates concurrent shim refreshes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-workspace-tool-bins-concurrent-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'server'), { recursive: true });
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

  const binDir = join(root, 'node_modules', '.bin');
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
