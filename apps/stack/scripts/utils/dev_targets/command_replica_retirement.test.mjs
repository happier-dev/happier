import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { retireRemovedCommandRepositories } from './command_replica_retirement.mjs';
import { resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import { renderMutagenProject, resolveMutagenRepositoryKey, resolveMutagenSessionName } from './mutagen_project.mjs';
import { runDevTargetControlProcess } from './sync_project.mjs';

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
  await writeFile(join(projectDir('gone'), 'mutagen.yml'), renderMutagenProject({
    sourceDir: join(root, 'source/gone'), targets: [target('worker', 'gone')],
  }));
  const session = (identifier, sourceDir, extra = {}) => ({
    identifier,
    name: resolveMutagenSessionName('worker', sourceDir),
    mode: 'one-way-replica',
    alpha: { protocol: 'local', path: sourceDir },
    beta: { protocol: 'ssh', host: 'worker', path: join(workerRoot('worker'), basename(sourceDir)) },
    labels: { 'io.mutagen.project': 'p' },
    ...extra,
  });
  const sessions = [
    session('gone-session', join(root, 'source/gone')),
    session('live-session', join(root, 'source/live')),
    session('primary-session', executorRepoRoot),
    session('unlabelled-session', join(root, 'source/gone'), { labels: {}, beta: { protocol: 'ssh', host: 'unrelated', path: '/unrelated' } }),
  ];
  const calls = [];
  const evidence = [];
  const runProcess =
    (unreachable = new Set(), failedSessions = new Set()) =>
    async ({ command, args, env: commandEnv, input }) => {
      calls.push([command, ...args]);
      if (command === 'mutagen' && args[1] === 'list')
        return { code: 0, out: JSON.stringify(sessions), err: '' };
      if (command === 'mutagen') {
        const session = sessions.find(entry => entry.identifier === args[2]);
        const raw = await readFile(join(stackDir, 'command-replica-retirement.manifest.jsonl'), 'utf8').catch(error => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        evidence.push({ identifier: session.identifier, sourceDir: commandEnv.HAPPIER_STACK_SYNC_SOURCE_DIR,
          manifest: raw ? JSON.parse(raw.trim().split('\n').at(-1)) : null });
        if (failedSessions.has(args[2])) return { code: 1, out: '', err: 'termination refused' };
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
        encoding: 'utf8', input,
      });
      return { code: result.status, out: result.stdout, err: result.stderr };
    };
  const retire = (unreachable, options = {}, failedSessions) =>
    retireRemovedCommandRepositories(
      { stackDir, executorRepoRoot, env, ...options },
      { runProcess: runProcess(unreachable, failedSessions) },
    );
  return { root, stackDir, executorRepoRoot, env, runProcess, target, session, sessions, workerRoot, projectDir, calls, evidence, retire };
}

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

test('bulk retirement streams the removal body through the control transport with one connection per worker', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  const repositories = [];
  // The affected controller retained 229 command states. Long checkout names
  // make that real corpus exceed Linux's 128 KiB single-argument boundary.
  for (let index = 0; index < 229; index += 1) {
    const name = `retired-${index}-${'review-basis-'.repeat(8)}`;
    const target = f.target('worker', name);
    await mkdir(join(target.repoDir, '.happier'), { recursive: true });
    await writeFile(join(target.repoDir, '.happier/command-replica.json'), JSON.stringify({
      version: 1, repoDir: target.repoDir, executorRepoDir: target.executorRepoDir,
    }));
    repositories.push({ sourceDir: join(f.root, 'source', name), targets: [target] });
  }
  const captures = [];
  const result = await retireRemovedCommandRepositories({
    stackDir: f.stackDir, executorRepoRoot: f.executorRepoRoot, env: f.env, repositories,
  }, { runProcess: request => {
    if (request.command === 'mutagen') return { code: 0, out: '[]' };
    return runDevTargetControlProcess(request, { capture: async (_command, args, options) => {
      // OS boundary: execute the remote shell locally while preserving the
      // production control transport's argv and stdin handling.
      const script = args.at(-1);
      const child = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', input: options.input });
      captures.push({ argumentBytes: Buffer.byteLength(script), inputBytes: Buffer.byteLength(options.input ?? ''),
        error: child.error?.code });
      return { exitCode: child.status, out: child.stdout ?? '', err: child.stderr ?? '', error: child.error };
    } });
  } });
  assert.equal(captures.length, 1, 'one SSH connection retires the worker corpus');
  assert.ok(captures[0].argumentBytes + captures[0].inputBytes > 128 * 1024, 'fixture reaches the OS argument boundary');
  t.diagnostic(JSON.stringify({ replicas: repositories.length, ...captures[0] }));
  assert.equal(captures[0].error, undefined, 'retirement must not fail with E2BIG before reaching the worker');
  assert.deepEqual(result.pending, {});
  assert.equal(result.retired.length, repositories.length);
  for (const repository of repositories) assert.equal(await exists(repository.targets[0].repoDir), false);
  assert.equal(await exists(join(f.workerRoot('worker'), 'live')), true);
  assert.equal(await exists(join(f.workerRoot('worker'), 'unmarked')), true);
  assert.equal(await exists(join(f.workerRoot('worker'), '0.3')), true);
});

test('session termination uses its own source environment and a previously written manifest', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.retire();
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].sourceDir, join(f.root, 'source/gone'));
  assert.ok(f.evidence[0].manifest?.sessions.some(session => session.identifier === 'gone-session'));
});

test(
  'a removed sibling worktree retires its controller state, Mutagen sessions and owned worker replicas',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const result = await f.retire();
    // The owner must retain cleanup evidence for unowned worker directories.
    assert.deepEqual(result.retired, ['gone']);
    assert.deepEqual(result.pending, { other: 1, worker: 1 });
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
    assert.equal(await exists(join(f.stackDir, 'commands-unmarked')), true);
    // Pending unowned replicas remain observable, while gone is not retried.
    f.calls.length = 0;
    await f.retire();
    assert.equal(f.calls.filter(call => call[0] === 'mutagen' && call[2] === 'terminate').length, 0);
    assert.ok(f.calls.filter(call => call[0] === 'ssh').every(call => !call.at(-1).includes('/gone')));
  },
);

test('an absent legacy alpha is retired even when command state was lost', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rm(join(f.stackDir, 'commands-gone'), { recursive: true });
  const result = await f.retire();
  assert.ok(result.retired.includes('gone'));
  assert.deepEqual(result.terminated, ['gone-session']);
  assert.equal(await exists(f.projectDir('gone')), false);
  // Lost controller target evidence cannot authorize worker deletion.
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
});

test('extant source evidence makes a quiet retirement pass perform no Mutagen or worker operations', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'source/gone'));
  await mkdir(join(f.root, 'source/unmarked'));
  const result = await f.retire();
  assert.deepEqual(result.retired, []);
  assert.deepEqual(f.calls, []);
});

test('one-off cleanup uses the same marker-owned removal after session termination', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rm(join(f.stackDir, 'commands-gone'), { recursive: true });
  const result = await f.retire(undefined, {
    repositories: [{ sourceDir: join(f.root, 'source/gone'),
      targets: [f.target('worker', 'gone'), { ...f.target('other', 'gone'), repoDir: join(f.workerRoot('other'), '0.3') }] }],
  });
  assert.deepEqual(result.retired, ['gone']);
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), false);
  assert.equal(await exists(join(f.workerRoot('other'), 'gone')), true);
  assert.equal(await exists(join(f.workerRoot('other'), '0.3')), true);
  assert.ok(f.calls.findIndex(call => call[2] === 'terminate') < f.calls.findIndex(call => call[0] === 'ssh'));
});

test('session-only retirement preserves live peers, worker replicas and project/controller state', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const sourceDir = join(f.root, 'source/live');
  f.sessions.push(f.session('live-peer', sourceDir));
  const result = await f.retire(undefined, { repositories: [{ sourceDir, sessionIds: ['live-session'] }] });
  assert.deepEqual(result.terminated, ['live-session']);
  assert.deepEqual(result.retired, []);
  assert.ok(f.sessions.some(session => session.identifier === 'live-peer'));
  assert.equal(await exists(join(f.workerRoot('worker'), 'live')), true);
  assert.equal(await exists(join(f.stackDir, 'commands-live')), true);
  assert.equal(f.calls.filter(call => call[0] === 'ssh').length, 0);
});

test('one-off cleanup without controller state reports a partially unreachable worker and can be retried', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rm(join(f.stackDir, 'commands-gone'), { recursive: true });
  const selection = { repositories: [{ sourceDir: join(f.root, 'source/gone'),
    targets: [f.target('worker', 'gone'), f.target('other', 'gone')] }] };
  const first = await f.retire(new Set(['worker']), selection);
  assert.deepEqual(first.pending, { worker: 1 });
  assert.deepEqual(first.retired, []);
  assert.equal(await exists(join(f.workerRoot('other'), 'gone')), false);
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
  const next = await f.retire(undefined, selection);
  assert.deepEqual(next.retired, ['gone']);
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), false);
});

test('failed session termination preserves its worker replica and controller recovery state', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const result = await f.retire(undefined, {}, new Set(['gone-session']));
  assert.ok(!result.retired.includes('gone'));
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
  assert.deepEqual(result.terminated, []);
  assert.equal(result.pending['sync:gone'], 1);
  assert.equal(await exists(join(f.stackDir, 'commands-gone')), true);
  assert.equal(await exists(f.projectDir('gone')), true);
});

test('one-off cleanup selects its approved alpha and protects the executor', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const result = await f.retire(undefined, { repositories: [{ sourceDir: join(f.root, 'source/live') }] });
  assert.deepEqual(result.retired, ['live']);
  assert.deepEqual(result.terminated, ['live-session']);
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
  assert.equal(await exists(join(f.workerRoot('worker'), 'live')), false);
  await assert.rejects(f.retire(undefined, { repositories: [{ sourceDir: f.executorRepoRoot }] }), /executor/);
});

test('absent nested scratch sources are discovered from generated projects', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const sourceDir = join(f.executorRepoRoot, '.project/tmp/finished/basis');
  const runtime = resolveDevTargetMutagenRuntime({ stackBaseDir: f.stackDir, env: f.env });
  const projectDir = join(runtime.mutagenDir, 'repositories', resolveMutagenRepositoryKey(sourceDir));
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, 'mutagen.yml'), renderMutagenProject({ sourceDir, targets: [f.target('worker', 'basis')] }));
  f.sessions.push(f.session('nested-session', sourceDir));
  const result = await f.retire();
  assert.equal(await exists(projectDir), false);
  assert.ok(result.terminated.includes('nested-session'));
});

test('recorded-done replicas are re-evaluated with one batch per worker when a directory reappears', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await f.retire(new Set(['worker']));
  const restored = join(f.workerRoot('other'), 'gone');
  await mkdir(join(restored, '.happier'), { recursive: true });
  await writeFile(join(restored, '.happier/command-replica.json'), JSON.stringify({ version: 1, repoDir: restored }));
  f.calls.length = 0;
  const result = await f.retire();
  assert.equal(await exists(restored), false);
  assert.deepEqual(result.retired, ['gone']);
  assert.deepEqual(f.calls.filter(call => call[0] === 'ssh').map(call => call.at(-2)).sort(), ['other', 'worker']);
});

test('a successful removal process that leaves the directory cannot retain a done checkpoint', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const stateFile = join(f.stackDir, 'commands-gone/retirement.v1.json');
  await writeFile(stateFile, JSON.stringify({ version: 1, doneTargets: ['worker', 'other'] }));
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  // OS boundary: simulate rm returning success without applying its effect.
  await writeFile(join(bin, 'rm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const runProcess = f.runProcess();
  const result = await retireRemovedCommandRepositories({
    stackDir: f.stackDir, executorRepoRoot: f.executorRepoRoot, env: f.env,
    repositories: [{ sourceDir: join(f.root, 'source/gone') }],
  }, { runProcess: async request => {
    if (request.command !== 'ssh') return runProcess(request);
    f.calls.push([request.command, ...request.args]);
    const child = spawnSync('/bin/sh', ['-c', request.args.at(-1)], {
      encoding: 'utf8', input: request.input, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: child.status, out: child.stdout, err: child.stderr };
  } });
  assert.deepEqual(result.retired, []);
  assert.deepEqual(result.pending, { worker: 1, other: 1 });
  assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).doneTargets, []);
  assert.equal(f.calls.filter(call => call[0] === 'ssh').length, 2);
});

test(
  'an unreachable worker stays pending, and a later pass verifies every share',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const first = await f.retire(new Set(['worker']));
    assert.deepEqual(first.retired, []);
    assert.deepEqual(first.pending, { worker: 2, other: 1 });
    assert.equal(await exists(join(f.workerRoot('other'), 'gone')), false);
    assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), true);
    assert.equal(await exists(join(f.stackDir, 'commands-gone')), true);
    f.calls.length = 0;
    const retried = await f.retire();
    assert.deepEqual(
      f.calls.filter((call) => call[0] === 'ssh').map((call) => call.at(-2)),
      ['worker', 'other'],
    );
    assert.deepEqual(retried.retired, ['gone']);
    assert.deepEqual(retried.pending, { worker: 1, other: 1 });
    assert.equal(await exists(join(f.workerRoot('worker'), 'gone')), false);
    assert.equal(await exists(join(f.stackDir, 'commands-gone')), false);
  },
);
