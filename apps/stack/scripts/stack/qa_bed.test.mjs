import test from 'node:test';
import assert from 'node:assert/strict';

import { projectQaBedReadiness, resolveQaBedDaemonHost } from './qa_bed.mjs';

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
