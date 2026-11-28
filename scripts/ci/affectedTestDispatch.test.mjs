import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';

const execFileAsync = promisify(execFile);

test('the public affected test launcher sends a resolved file list to the worker',
  { skip: process.platform === 'win32' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'happier-affected-dispatch-' });
    const git = (args, input) => {
      const result = spawnSync('git', args, { cwd: fixture.root, input, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '--bare']);
    const file = 'source file\nwith newline.ts';
    const blob = git(['hash-object', '-w', '--stdin'], 'const x = 1;');
    const tree = git(['mktree', '-z'], `100644 blob ${blob}\t${file}\0`);
    const commit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', 'commit-tree', tree, '-m', 'fixture']);
    git(['update-ref', 'HEAD', commit]);

    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    await mkdir(fixture.path('apps/stack/bin'), { recursive: true });
    await mkdir(fixture.path('scripts/testing'), { recursive: true });
    await symlink(fileURLToPath(new URL('../../scripts/testing/dispatchAffectedTests.mjs', import.meta.url)),
      fixture.path('scripts/testing/dispatchAffectedTests.mjs'));
    await writeFile(fixture.path('apps/stack/bin/hstack-exec'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
    const invoke = async (...args) => {
      const { stdout } = await execFileAsync('/bin/sh', ['-c', `${manifest.scripts['test:affected']} "$@"`,
        'test:affected', ...args], { cwd: fixture.root });
      return JSON.parse(stdout);
    };
    const projected = await invoke('--commit', commit, '--plan');
    assert.deepEqual(projected,
      ['--script=test:affected:local', '--plan', '--changed-files-resolved', `--changed-file=${file}`]);
    assert.deepEqual(await invoke('--base', commit, '--plan'),
      ['--script=test:affected:local', '--plan', '--changed-files-resolved']);
    assert.deepEqual(await invoke('--plan', 'existing.ts'),
      ['--script=test:affected:local', '--plan', 'existing.ts']);
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const policy = fileURLToPath(new URL('../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs', import.meta.url));
    await execFileAsync(process.execPath, [policy, repo, repo, 'pnpm', 'test:affected', '--commit', commit, '--plan']);

    const worker = await createTempFixture(t, { prefix: 'happier-gitless-affected-worker-' });
    await mkdir(worker.path('packages'), { recursive: true });
    await symlink(fileURLToPath(new URL('../../packages/tests', import.meta.url)), worker.path('packages/tests'));
    await writeFile(worker.path('pnpm-workspace.yaml'), 'packages: []\n');
    const planner = fileURLToPath(new URL('../../scripts/testing/runAffectedTests.ts', import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', planner, ...projected.slice(1)],
      { cwd: worker.root });
    assert.deepEqual(JSON.parse(stdout).coreFast, []);
  });
