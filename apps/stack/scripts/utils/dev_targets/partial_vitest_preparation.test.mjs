// @happier-test-preparation source
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { resolveRemoteCommandPolicy, resolvePackageCommandPolicy, renderNativeCommandPolicy } from './remote_commands.mjs';
import { resolveRemoteValidationPreparationComponents } from './validation_preparation_policy.mjs';

test('partial source resolvers retain dist preparation for their emitted protocol dependencies', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'partial-vitest-preparation-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  // These configs mix Protocol source with emitted SDK/deployment-protocol
  // imports. Skipping preparation loads stale JS on a warm replica
  // and fails missing imports on a cold replica, regardless of declarations.
  for (const component of [
    'apps/bootstrap', 'packages/agents', 'packages/channels-protocol', 'packages/deployment-protocol',
    'packages/cli-common', 'packages/embed', 'packages/sdk', 'packages/session-core',
    'packages/support', 'packages/sync-client',
    'packages/email-transports-protocol', 'packages/triage-sources',
    ...['app-context', 'auggie', 'cursor', 'elevenlabs', 'jira', 'kiro', 'linear',
      'machine-boat', 'machine-crabbox', 'machine-cua', 'machine-fly', 'machine-lima',
      'machine-lume', 'machine-vercel', 'openai', 'xai', 'channel-discord', 'channel-email', 'channel-slack', 'channel-telegram',
      'channels', 'deployment-templates', 'inspector', 'onepassword',
      'channels', 'deployment-templates', 'inspector', 'onepassword',
      'scm-azure-devops', 'scm-bitbucket', 'scm-gitlab'].map(name => `packages/plugins/${name}`),
  ]) {
    await t.test(component, () => {
      const args = ['pnpm', '--dir', component, 'exec', 'vitest', 'run'];
      const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: root });
      assert.equal(policy.kind, 'runtime');
      assert.deepEqual(resolveRemoteValidationPreparationComponents(policy.component, policy.kind), [component]);
      if (process.platform === 'win32') return;
      const native = spawnSync('/bin/sh', ['-c',
        '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
        'policy', artifact, root, ...args], { encoding: 'utf8' });
      assert.equal(native.status, 0, native.stderr);
      assert.equal(native.stdout, 'runtime');
    });
  }
});

test('selected source configs prepare emitted dependencies too', async t => {
  const root = fileURLToPath(new URL('../../../../../', import.meta.url));
  const fixture = await createTempFixture(t, { prefix: 'selected-source-preparation-' });
  const artifact = fixture.path('policy.sh');
  await writeFile(artifact, renderNativeCommandPolicy());
  for (const [component, config] of [
    ['packages/triage-protocol', 'vitest.source.config.ts'],
    ['packages/plugin-sdk', 'vitest.source.config.ts'],
    ['packages/voice-modelpacks', 'vitest.direct-source.config.ts'],
    ['packages/plugins/pi', 'vitest.realOwners.config.ts'],
    ['packages/plugins/pi', 'vitest.spawnedRealOwners.config.ts'],
  ]) {
    const args = ['pnpm', '--dir', component, 'exec', 'vitest', 'run', '--config', config];
    const policy = resolveRemoteCommandPolicy(args, { repoRoot: root, cwd: root });
    assert.equal(policy.kind, 'runtime', component);
    assert.deepEqual(resolveRemoteValidationPreparationComponents(policy.component, policy.kind), [component]);
    if (process.platform === 'win32') continue;
    const native = spawnSync('/bin/sh', ['-c',
      '. "$1"; repo_root=$2; invoked_cwd=$2; shift 2; resolve_native_command_policy "$@"; printf "%s" "$policy_kind"',
      'policy', artifact, root, ...args], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.stdout, 'runtime');
  }
  const triageAlias = await resolvePackageCommandPolicy([
    'pnpm', '--dir', 'packages/triage-protocol', 'run', 'test:source', 'src/testing/v1/conformance.test.ts',
  ], { repoRoot: root, cwd: root });
  assert.equal(triageAlias.kind, 'runtime');
  assert.equal(triageAlias.component, 'packages/triage-protocol');
});
