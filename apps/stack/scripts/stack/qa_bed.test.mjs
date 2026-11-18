import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { ensureQaBedRunning, projectQaBedReadiness, readQaBedProfile, resolveQaBedDaemonHost, seedAccount, startQaBedStack } from './qa_bed.mjs';

const targets = [
  { name: 'nl3', repoDir: '/home/happier/happier-dev/', platform: 'posix' },
  { name: 'win', repoDir: 'C:\\happier', platform: 'windows' },
];

test('the fake Claude path names the daemon host checkout, next to the server', () => {
  const remote = resolveQaBedDaemonHost({ targets, runtimePlacement: { server: { mode: 'prefer-target', target: 'nl3' } } }, { localRepoDir: '/w/0.3' });
  assert.deepEqual(remote, { target: 'nl3', repoDir: '/home/happier/happier-dev',
    fakeClaudePath: '/home/happier/happier-dev/packages/tests/src/fixtures/fake-claude-code-cli.js' });

  const windows = resolveQaBedDaemonHost({ targets, runtimePlacement: { server: { mode: 'prefer-target', target: 'win' } } }, { localRepoDir: '/w/0.3' });
  assert.equal(windows.fakeClaudePath, 'C:\\happier\\packages\\tests\\src\\fixtures\\fake-claude-code-cli.js');

  const local = resolveQaBedDaemonHost({ targets, runtimePlacement: { server: { mode: 'local' } } }, { localRepoDir: '/w/0.3' });
  assert.equal(local.target, null);
  assert.equal(local.fakeClaudePath, '/w/0.3/packages/tests/src/fixtures/fake-claude-code-cli.js');

  assert.throws(() => resolveQaBedDaemonHost({ targets, runtimePlacement: { server: { mode: 'prefer-target', target: 'gone' } } },
    { localRepoDir: '/w/0.3' }), { code: 'qa_bed_target_unknown' });
});

test('readiness names the first failing check and is READY only when every check passed', () => {
  const ok = { roles: { ok: true }, keyLogin: { status: 200 }, auth: { authenticated: true }, seeded: { ok: true }, agentTurn: { ok: true } };
  assert.equal(projectQaBedReadiness(ok).status, 'READY');
  // The P03-MOBILE-SESSION-OPEN bed: a server without a canonical URL refuses key sign-in.
  assert.deepEqual(
    [projectQaBedReadiness({ ...ok, keyLogin: { status: 503 } }).status, projectQaBedReadiness({ ...ok, keyLogin: { status: 503 } }).check],
    ['NOT_READY', 'key_login'],
  );
  assert.equal(projectQaBedReadiness({ ...ok, agentTurn: { ok: false, phase: 'history' } }).check, 'agent_turn');
  assert.equal(projectQaBedReadiness({ ...ok, auth: { authenticated: false }, seeded: null, agentTurn: null }).check, 'cli_auth');
});

test('a failed bed start stops what it started through the Stack lifecycle, so a retry starts clean', async () => {
  // P03-INFRA-RESPONDER-2 attempt 1 died at server readiness and left nl3 serving
  // on the bed's port; the retry's forward could not bind until `stack stop` ran.
  const calls = [];
  const runStackImpl = async ({ args }) => {
    calls.push(args);
    return args[0] === 'start' ? { ok: false, exitCode: 1 } : { ok: true, exitCode: 0 };
  };
  await assert.rejects(startQaBedStack({ rootDir: '/r', stackName: 'agent-qa-x-bed', step: 'start' }, { runStackImpl }),
    (error) => error.code === 'qa_bed_start_failed' && error.cleanup === 'stopped');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['start', 'agent-qa-x-bed'], ['stop', 'agent-qa-x-bed']]);

  // A stop that cannot finish is reported, never hidden behind the start failure.
  const failedStop = async ({ args }) => ({ ok: false, exitCode: args[0] === 'start' ? 1 : 3 });
  await assert.rejects(startQaBedStack({ rootDir: '/r', stackName: 'agent-qa-x-bed', step: 'restart' }, { runStackImpl: failedStop }),
    (error) => error.code === 'qa_bed_restart_failed' && error.cleanup === 'stop_failed' && /stop also failed \(exit 3\)/.test(error.message));

  // A start that succeeded is left running.
  calls.length = 0;
  await startQaBedStack({ rootDir: '/r', stackName: 'agent-qa-x-bed', step: 'start' }, { runStackImpl: async ({ args }) => { calls.push(args); return { ok: true }; } });
  assert.deepEqual(calls.map((args) => args[0]), ['start']);
});

test('a bed whose marker cannot be read is reported as unreadable, never as a foreign Stack', async () => {
  // P03-RELOAD-RUNNER 19:08Z: a retry of a failed create refused "exists and is not a QA bed".
  const answer = result => async () => result;
  assert.equal(await readQaBedProfile({ rootDir: '/r', stackName: 'b' }, { runStackImpl: answer({ ok: true, out: 'small\n' }) }), 'small');
  assert.equal(await readQaBedProfile({ rootDir: '/r', stackName: 'b' }, { runStackImpl: answer({ ok: true, out: '\n' }) }), null);
  await assert.rejects(readQaBedProfile({ rootDir: '/r', stackName: 'b' }, { runStackImpl: answer({ ok: false, exitCode: 1 }) }),
    error => error.code === 'qa_bed_marker_unreadable');
});

test('reset starts a stopped bed before seeding its fresh Account', async () => {
  // A failed create stops its bed; reset must still work (P03-RELOAD-RUNNER 19:08Z: qa_bed_server_url_missing).
  const starts = [];
  const start = async input => { starts.push(input.step); };
  await ensureQaBedRunning({ rootDir: '/r', stackName: 'b' }, { readServerUrlImpl: async () => '', startImpl: start });
  await ensureQaBedRunning({ rootDir: '/r', stackName: 'b' }, { readServerUrlImpl: async () => 'http://x', startImpl: start });
  assert.deepEqual(starts, ['start']);
});

test('a seed failure reports its fixture operation and HTTP status without exposing child output', async (t) => {
  const fixture = await createTempFixture(t);
  await mkdir(fixture.path('packages', 'tests', 'scripts'), { recursive: true });
  await writeFile(fixture.path('packages', 'tests', 'scripts', 'runTsxEntrypoint.mjs'), `
    console.log(JSON.stringify({ kind: 'qa_bed_seed', ok: false, phase: 'machine_registration', httpStatus: 400 }));
    console.error('fixture-secret-that-must-not-be-printed');
    process.exitCode = 1;
  `);
  await assert.rejects(seedAccount({ repoDir: fixture.root, serverUrl: 'http://qa.test', profile: 'small', keyFile: fixture.path('account.key') }),
    (error) => error.code === 'qa_bed_seed_failed' && /machine_registration.*400/.test(error.message)
      && !error.message.includes('fixture-secret-that-must-not-be-printed'));
});
