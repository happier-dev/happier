import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import {
  activateExecutionHostProfile,
  readExecutionHostProfile,
  resolveExecutionHostProfilePath,
  writeCandidateExecutionHostProfile,
} from './config.mjs';

function candidate(overrides = {}) {
  return {
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'happier-agent-primary',
    limaHome: '/Users/example/.happier-stack/lima',
    profile: 'balanced',
    guestWorkspaceDir: '/home/example/.happier-stack/workspace',
    mirrorWorkspaceDir: '/Users/example/.happier-stack/workspace-mirror',
    ...overrides,
  };
}

test('execution host profile is machine-global Stack state and defaults to absent', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-config-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };
  assert.equal(resolveExecutionHostProfilePath(env), fixture.path('stack-home', 'execution-host.json'));
  assert.equal(readExecutionHostProfile(env), null);
});

test('candidate execution host writes atomically with restrictive permissions and cannot carry Stack authority', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-write-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };
  const profile = candidate();

  await writeCandidateExecutionHostProfile(profile, env);

  assert.deepEqual(readExecutionHostProfile(env), profile);
  const path = resolveExecutionHostProfilePath(env);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(fixture.path('stack-home'))).mode & 0o777, 0o700);
  await assert.rejects(
    writeCandidateExecutionHostProfile({ ...profile, stack: 'dev' }, env),
    /unknown field: stack/,
  );
});

test('ordinary profile writes cannot activate delegation and the cutover seam activates an existing candidate only', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-activation-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };

  await assert.rejects(
    writeCandidateExecutionHostProfile(candidate({ activation: 'active' }), env),
    /candidate activation/,
  );
  await writeCandidateExecutionHostProfile(candidate(), env);
  const active = await activateExecutionHostProfile(env);
  assert.equal(active.activation, 'active');
  assert.equal(readExecutionHostProfile(env).activation, 'active');
});

test('execution host reader rejects malformed or over-authoritative persisted profiles', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'execution-host-invalid-' });
  const env = { HAPPIER_STACK_HOME_DIR: fixture.path('stack-home') };
  const path = resolveExecutionHostProfilePath(env);
  await writeCandidateExecutionHostProfile(candidate(), env);
  await writeFile(path, JSON.stringify({ ...candidate(), serverId: 'split-brain' }), 'utf8');
  await chmod(path, 0o600);

  assert.throws(() => readExecutionHostProfile(env), /unknown field: serverId/);
  assert.match(await readFile(path, 'utf8'), /split-brain/);
});
