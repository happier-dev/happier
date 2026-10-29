import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { retireRemovedCommandRepositories } from './command_replica_retirement.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { resolveMutagenRepositoryKey } from './mutagen_project.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hstack-command-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
  };
  const executorRepoRoot = join(root, 'source/0.3');
  const stackDir = join(root, 'stack');
  await mkdir(executorRepoRoot, { recursive: true });
  await mkdir(join(root, 'source/live'));
  const workerRoot = (ssh) => join(root, ssh);
  const target = (ssh, name) => ({
    name: ssh,
    platform: 'posix',
    ssh,
    repoDir: join(workerRoot(ssh), name),
    executorRepoDir: join(workerRoot(ssh), '0.3'),
    cliHomeDir: join(root, `${ssh}-home`),
  });
  for (const name of ['gone', 'live', 'unmarked']) {
    await mkdir(join(stackDir, `commands-${name}`), { recursive: true });
    // A Stack runtime target keeps its own repository; it is never a sibling replica.
    const runtime = {
      name: 'runtime',
      platform: 'posix',
      ssh: 'runtime',
      repoDir: join(workerRoot('runtime'), '0.3'),
      executorRepoDir: join(workerRoot('runtime'), '0.3'),
      cliHomeDir: join(root, 'runtime-home'),
    };
    await writeFile(
      join(stackDir, `commands-${name}`, 'dev-targets.json'),
      JSON.stringify({
        version: 3,
        targets: [target('worker', name), target('other', name), runtime],
      }),
    );
    for (const ssh of ['worker', 'other'])
      await mkdir(join(workerRoot(ssh), name, 'node_modules'), {
        recursive: true,
      });
  }
  for (const ssh of ['worker', 'other', 'runtime'])
    await mkdir(join(workerRoot(ssh), '0.3'), { recursive: true });
  // Same owner record the worker-side replica producer writes.
  for (const ssh of ['worker', 'other']) {
    for (const name of ['gone', 'live']) {
      await mkdir(join(workerRoot(ssh), name, '.happier'));
      await writeFile(
        join(workerRoot(ssh), name, '.happier/command-replica.json'),
        `${JSON.stringify({ version: 1, repoDir: join(workerRoot(ssh), name), executorRepoDir: join(workerRoot(ssh), '0.3') })}\n`,
      );
    }
  }
  const runtime = resolveDevTargetMutagenRuntime({
    stackBaseDir: stackDir,
    env,
  });
  const projectDir = (name) =>
    join(
      runtime.mutagenDir,
      'repositories',
      resolveMutagenRepositoryKey(join(root, 'source', name)),
    );
  await mkdir(projectDir('gone'), { recursive: true });
  await writeFile(join(projectDir('gone'), 'mutagen.yml'), 'sync: {}\n');
  const session = (identifier, sourceDir, extra = {}) => ({
    identifier,
    name: `happier-worker-${identifier}`,
    mode: 'one-way-replica',
    alpha: { protocol: 'local', path: sourceDir },
    labels: { 'io.mutagen.project': 'p' },
    ...extra,
  });
  const sessions = [
    session('gone-session', join(root, 'source/gone')),
    session('live-session', join(root, 'source/live')),
    session('primary-session', executorRepoRoot),
    session('unlabelled-session', join(root, 'source/gone'), { labels: {} }),
  ];
  const calls = [];
  const runProcess =
    (unreachable = new Set()) =>
    async ({ command, args }) => {
      calls.push([command, ...args]);
      if (command === 'mutagen' && args[1] === 'list')
        return { code: 0, out: JSON.stringify(sessions), err: '' };
      if (command === 'mutagen') {
        const index = sessions.findIndex(
          (entry) => entry.identifier === args[2],
        );
        if (index >= 0) sessions.splice(index, 1);
        return { code: 0, out: '', err: '' };
      }
      if (unreachable.has(args.at(-2)))
        return { code: 255, out: '', err: 'ssh: connect refused' };
      // The worker boundary: execute the remote command in a real shell.
      const result = spawnSync('/bin/sh', ['-c', args.at(-1)], {
        encoding: 'utf8',
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
  const retire = (unreachable) =>
    retireRemovedCommandRepositories(
      { stackDir, executorRepoRoot, env },
      { runProcess: runProcess(unreachable) },
    );
  return { root, stackDir, workerRoot, projectDir, calls, retire };
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

test(
  'a removed sibling worktree retires its controller state, Mutagen sessions and owned worker replicas',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const result = await f.retire();
    assert.deepEqual(result.retired.sort(), ['gone', 'unmarked']);
    assert.deepEqual(result.pending, {});
    const terminated = f.calls
      .filter((call) => call[0] === 'mutagen' && call[2] === 'terminate')
      .map((call) => call[3]);
    assert.deepEqual(terminated, ['gone-session']);
    // One connection per worker; a Stack runtime target is never contacted.
    assert.deepEqual(
      f.calls
        .filter((call) => call[0] === 'ssh')
        .map((call) => call.at(-2))
        .sort(),
      ['other', 'worker'],
    );
    // Only owned replicas of the removed checkout are deleted on the workers.
    for (const ssh of ['worker', 'other']) {
      assert.equal(await exists(join(f.workerRoot(ssh), 'gone')), false, ssh);
      for (const kept of ['live', 'unmarked', '0.3'])
        assert.equal(
          await exists(join(f.workerRoot(ssh), kept)),
          true,
          `${ssh}/${kept}`,
        );
    }
    assert.equal(await exists(join(f.workerRoot('runtime'), '0.3')), true);
    assert.equal(await exists(join(f.stackDir, 'commands-gone')), false);
    assert.equal(await exists(f.projectDir('gone')), false);
    assert.equal(await exists(join(f.stackDir, 'commands-live')), true);
    // Nothing is left to retire: a later dispatch neither lists Mutagen nor reaches a worker.
    f.calls.length = 0;
    await f.retire();
    assert.deepEqual(f.calls, []);
  },
);

test(
  'an unreachable worker keeps only its share pending, and a later pass retries just that worker',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const first = await f.retire(new Set(['worker']));
    assert.deepEqual(first.retired, []);
    assert.deepEqual(first.pending, { worker: 2 });
    assert.equal(await exists(join(f.workerRoot('other'), 'gone')), false);
    assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
    assert.equal(await exists(join(f.stackDir, 'commands-gone')), true);
    f.calls.length = 0;
    const retried = await f.retire();
    assert.deepEqual(
      f.calls.filter((call) => call[0] === 'ssh').map((call) => call.at(-2)),
      ['worker'],
    );
    assert.deepEqual(retried.retired.sort(), ['gone', 'unmarked']);
    assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), false);
    assert.equal(await exists(join(f.stackDir, 'commands-gone')), false);
  },
);
