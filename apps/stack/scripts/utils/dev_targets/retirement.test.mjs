import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { writeFakeBin } from '../../testkit/core/fake_bin_harness.mjs';
import { retireStackDevTarget } from './retirement.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';

test('remote retirement retains native Session failure ids and reasons in its typed refusal', async () => {
  const actions = { stackName: 'test-stack',
    finalization: { finalized: false, reason: 'session_cleanup_incomplete' },
    errors: [
      { step: 'daemon-sessions', sessionId: 'session-a', reason: 'runner_exit_timeout',
        error: 'Session session-a cleanup incomplete: runner_exit_timeout' },
      { step: 'daemon-sessions', sessionId: 'session-b', reason: 'explicit_stop_failed',
        error: 'Session session-b cleanup incomplete: explicit_stop_failed' },
    ],
  };
  await assert.rejects(retireStackDevTarget({ target: { name: 'nl3', ssh: 'fixture', platform: 'posix',
    repoDir: '/fixture/repo', cliHomeDir: '/fixture/home' }, options: { stackName: 'test-stack' } }, {
    runProcess: async ({ args }) => String(args.at(-1)).includes('stack stop')
      ? { code: 1, out: JSON.stringify({ ok: false, stopped: actions }) } : { code: 1 },
  }), error => {
    assert.equal(error.code, 'EDEVTARGETRETIREMENTREFUSED');
    assert.equal(error.retryable, false);
    assert.deepEqual(error.actions, actions);
    assert.match(error.message, /session-a.*runner_exit_timeout/);
    assert.match(error.message, /session-b.*explicit_stop_failed/);
    return true;
  });
});

for (const runtimeMode of ['source', 'source-snapshot', 'controlled']) {
  test(`native retirement recovery runs in its retained target namespace (${runtimeMode})`,
    { skip: process.platform === 'win32' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack retirement recovery ' });
    const target = { name: 'nl3', platform: 'posix', ssh: 'fixture-ssh',
      repoDir: fixture.path('repo'), cliHomeDir: fixture.path('dev-targets', 'nl3') };
    const options = { stackName: 'agent-qa-find-search', runtimeMode };
    const paths = resolveRemoteStackStatePaths(target, options);
    await mkdir(paths.stackBaseDir, { recursive: true });
    await mkdir(target.repoDir);
    await writeFile(paths.stackEnvPath, '');
    const logPath = fixture.path('invocations.jsonl');
    // Substitute only the external native launcher. Execute the recovery shell
    // verbatim and reject the incident's missing Stack namespace at that boundary.
    const content = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const base = path.join(env.HAPPIER_STACK_STORAGE_DIR || '', env.HAPPIER_STACK_STACK || '');
if (!fs.existsSync(path.join(base, 'env'))) process.exit(7);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args: process.argv.slice(2), storage: env.HAPPIER_STACK_STORAGE_DIR,
  stack: env.HAPPIER_STACK_STACK, cliHome: env.HAPPIER_STACK_CLI_HOME_DIR,
  delegated: env.HAPPIER_DEV_TARGET_EXECUTION || '', cwd: process.cwd(),
}) + '\\n');
`;
    const { binDir } = writeFakeBin({ root: fixture.root, name: 'node', content });
    writeFakeBin({ root: fixture.root, name: 'pnpm', content });
    writeFakeBin({ root: fixture.root, name: 'hstack', content });
    target.remotePath = [binDir];
    let refusal;
    await assert.rejects(retireStackDevTarget({ target, options }, {
      runProcess: async ({ args }) => String(args.at(-1)).includes('stack stop')
        ? { code: 1, out: JSON.stringify({ ok: false, stopped: {
          finalization: { finalized: false, reason: 'session_cleanup_incomplete' },
        } }) }
        : { code: 1 },
    }), error => { refusal = error; return error.code === 'EDEVTARGETRETIREMENTREFUSED'; });
    const nativeCommands = refusal.recovery.split('\n').filter(line => line.startsWith('exec bash -lc '));
    const legacyCommands = refusal.recovery.match(/run (hstack .*?), then (hstack .*?); retry/);
    const commands = nativeCommands.length ? nativeCommands : legacyCommands?.slice(1) ?? [];
    assert.equal(commands.length, 2, 'recovery must supply executable native Stack and daemon stop commands');
    for (const command of commands) {
      const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: {
        ...process.env, PATH: `${binDir}:${process.env.PATH}`,
        HAPPIER_STACK_STORAGE_DIR: '', HAPPIER_STACK_STACK: '',
      } });
      assert.equal(result.status, 0, 'recovery must find the target Stack through its real shell prelude');
    }
    const invocations = (await readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(invocations.length, 2);
    for (const invocation of invocations) {
      assert.equal(invocation.storage, paths.stackStorageDir);
      assert.equal(invocation.stack, paths.stackName);
      assert.equal(invocation.cliHome, paths.cliHomeDir);
      assert.equal(invocation.cwd, target.repoDir);
    }
    const stopArgs = invocations[0].args.slice(invocations[0].args.indexOf('stack'));
    assert.deepEqual(stopArgs, ['stack', 'stop', paths.stackName, '--yes', '--no-docker', '--preserve-daemon', '--json']);
    const daemonArgs = invocations[1].args.slice(invocations[1].args.indexOf('stack'));
    assert.deepEqual(daemonArgs, ['stack', 'daemon', paths.stackName, 'stop', '--json'],
      'a stalled session drain refuses /restart; retire the daemon through canonical Stop instead');
    assert.equal(invocations[1].delegated, '1', 'native stop must not dispatch back to the controller');
  });
}
