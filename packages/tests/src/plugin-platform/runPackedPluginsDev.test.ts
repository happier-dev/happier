import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertPluginExecutableEventsOwnedByDaemons,
  DevChangeStream,
  ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS,
  ISOLATED_DAEMON_RESTART_ARGS,
  PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS,
  PLUGINS_DEV_CHANGE_TIMEOUT_MS,
  resolvePluginInstallReviewFacts,
  resolvePluginsDevPtyLaunch,
  runCommandUntilOutput,
} from './runPackedPluginsDev';

test('allows the Linux author toolchain and daemon decision boundary to finish before timing out', () => {
  assert.equal(PLUGINS_DEV_CHANGE_TIMEOUT_MS, 600_000);
  assert.equal(ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS, PLUGINS_DEV_CHANGE_TIMEOUT_MS);
  assert.equal(PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS, ISOLATED_DAEMON_START_WAIT_TIMEOUT_MS);
});

test('takes over the isolated manual daemon when proving restart recovery', () => {
  assert.deepEqual(ISOLATED_DAEMON_RESTART_ARGS, ['daemon', 'restart', '--takeover', '--json']);
});

test('uses the node-pty terminal adapter without shell argument injection on supported hosts', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const launch = resolvePluginsDevPtyLaunch(platform, '/opt/node binary', [
      '/tmp/happier cli.mjs',
      'plugins',
      'install',
      "/tmp/author's plugin",
    ]);
    assert.ok(launch);
    assert.equal(launch.command, process.execPath);
    assert.match(launch.args[0] ?? '', /run-command-in-pty\.mjs$/u);
    assert.deepEqual(launch.args.slice(1), [
      '--',
      '/opt/node binary',
      '/tmp/happier cli.mjs',
      'plugins',
      'install',
      "/tmp/author's plugin",
    ]);
  }
});

test('compares terminal review evidence against the canonical plugin source path', async () => {
  const facts = await resolvePluginInstallReviewFacts(
    '/var/folders/example/plugin',
    async (path) => {
      assert.equal(path, '/var/folders/example/plugin');
      return '/private/var/folders/example/plugin';
    },
  );

  assert.ok(facts.includes('Source: /private/var/folders/example/plugin'));
  assert.ok(!facts.includes('Source: /var/folders/example/plugin'));
  assert.ok(facts.includes('Required disclosures and cooperative services:'));
  assert.ok(facts.includes('Optional host-owned resources (off by default):'));
});

test('releases a terminal wrapper after the command emits its final success evidence', async () => {
  const startedAt = Date.now();
  const result = await runCommandUntilOutput(
    process.execPath,
    ['-e', "process.stdout.write('installed\\n'); setInterval(() => {}, 1_000)"],
    {
      cwd: process.cwd(),
      env: process.env,
      input: '',
      completionText: 'installed',
      timeoutMs: 2_000,
    },
  );

  assert.equal(result.completedByOutput, true);
  assert.match(result.stdout, /installed/u);
  assert.ok(Date.now() - startedAt < 1_500);
});

test('the node-pty launcher helper presents real terminal streams to its child', async () => {
  const launch = resolvePluginsDevPtyLaunch('win32', process.execPath, [
    '-e',
    "process.stdout.write(JSON.stringify({ stdin: process.stdin.isTTY, stdout: process.stdout.isTTY }) + '\\n')",
  ]);
  assert.ok(launch);

  const result = await runCommandUntilOutput(launch.command, launch.args, {
    cwd: process.cwd(),
    env: process.env,
    input: '',
    completionText: '"stdout":true',
    timeoutMs: 5_000,
  });

  assert.match(result.stdout, /"stdin":true/u);
  assert.match(result.stdout, /"stdout":true/u);
});

test('the node-pty launcher helper exits when its terminal child exits', async () => {
  const launch = resolvePluginsDevPtyLaunch('win32', process.execPath, [
    '-e',
    "process.stdout.write('done\\n'); process.exitCode = 17",
  ]);
  assert.ok(launch);
  const child = spawn(launch.command, [...launch.args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('PTY launcher did not exit after its terminal child'));
      }, 2_000);
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );

  assert.deepEqual(result, { code: 17, signal: null });
});

test('rejects any plugin executable graph observed outside the allowed daemon processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-plugins-dev-daemon-owner-'));
  const markerPath = join(root, 'events.jsonl');
  try {
    await writeFile(markerPath, [
      JSON.stringify({
        kind: 'module',
        activationInstanceId: 'daemon-generation',
        pid: 101,
        state: { revisionTag: 'one', entry: 'one', transitive: 'one', nested: 'one' },
      }),
      JSON.stringify({
        kind: 'activate',
        activationInstanceId: 'cli-generation',
        pid: 202,
        state: { revisionTag: 'one', entry: 'one', transitive: 'one', nested: 'one' },
      }),
      '',
    ].join('\n'), 'utf8');

    await assert.rejects(
      assertPluginExecutableEventsOwnedByDaemons(markerPath, new Set([101]), 'pre-restart'),
      /outside the allowed daemon processes.*pid=202/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('delivers consecutive plugin development changes to consecutive waiters', async () => {
  const stream = new DevChangeStream(() => 'test stream');
  const first = stream.next();

  stream.push({
    ok: true,
    kind: 'plugins_dev_change',
    data: { observedFiles: 1 },
  });
  const firstChange = await first;
  if (!firstChange.ok) assert.fail('Expected the first development change to succeed');
  assert.equal(firstChange.data.observedFiles, 1);

  const second = stream.next(100);
  stream.push({
    ok: true,
    kind: 'plugins_dev_change',
    data: { observedFiles: 2 },
  });
  const secondChange = await second;
  if (!secondChange.ok) assert.fail('Expected the second development change to succeed');
  assert.equal(secondChange.data.observedFiles, 2);
});
