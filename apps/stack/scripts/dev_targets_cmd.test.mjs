import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = join(import.meta.dirname, 'dev_targets.mjs');

async function run(args, storageDir, extraEnv = {}) {
  const result = await execFileAsync(process.execPath, [script, ...args, '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      ...extraEnv,
    },
  });
  return JSON.parse(result.stdout.trim());
}

test('dev-targets command adds, shows, diagnoses, lists, and removes stack-scoped targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-cmd-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    for (const executable of ['mutagen', 'ssh']) {
      const path = join(binDir, executable);
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o700);
    }

    const added = await run(
      [
        'add',
        'linux',
        '--stack=repo-test',
        '--platform=posix',
        '--ssh=happier-stack-linux',
        '--ssh-config-file=/tmp/lima-happier-stack-linux.conf',
        '--lima-instance=hslqa',
        '--lima-home=/tmp/lima-happier',
        '--repo-dir=/home/dev/happier',
        '--cli-home-dir=/home/dev/.happier/linux',
      ],
      root,
    );
    assert.equal(added.target.name, 'linux');
    assert.equal(added.target.sshConfigFile, '/tmp/lima-happier-stack-linux.conf');
    assert.equal(added.target.limaInstance, 'hslqa');
    assert.equal(added.target.limaHome, '/tmp/lima-happier');

    const shown = await run(['show', 'linux', '--stack=repo-test'], root);
    assert.equal(shown.target.repoDir, '/home/dev/happier');

    const diagnosed = await run(['doctor', 'linux', '--stack=repo-test'], root, {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    assert.equal(diagnosed.ok, true);
    assert.equal(diagnosed.mutagen.ok, true);
    assert.deepEqual(
      diagnosed.targets.map((target) => ({ name: target.name, ok: target.ok })),
      [{ name: 'linux', ok: true }],
    );

    const listed = await run(['list', '--stack=repo-test'], root);
    assert.deepEqual(listed.targets.map((target) => target.name), ['linux']);

    const removed = await run(['remove', 'linux', '--stack=repo-test'], root);
    assert.equal(removed.removed, true);
    const empty = await run(['list', '--stack=repo-test'], root);
    assert.deepEqual(empty.targets, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
