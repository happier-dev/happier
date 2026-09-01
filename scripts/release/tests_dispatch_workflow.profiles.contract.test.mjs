import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const repoRoot = new URL('../..', import.meta.url).pathname;
const workflow = YAML.parse(readFileSync(join(repoRoot, '.github', 'workflows', 'tests-dispatch.yml'), 'utf8'));
const resolver = workflow.jobs.resolve.steps.find((step) => step.id === 'flags');

test('manual CI exposes explicit fast, release, and deep profiles', () => {
  const input = workflow.on.workflow_dispatch.inputs.profile;
  assert.equal(input.default, 'fast');
  assert.deepEqual(input.options, ['fast', 'release', 'deep', 'custom']);
});

test('manual CI only requires custom_checks when the custom profile owns selection', () => {
  const input = workflow.on.workflow_dispatch.inputs.custom_checks;
  assert.equal(input.required, false, 'GitHub must allow non-custom profiles to omit custom_checks');
  assert.equal(input.default, '');

  const release = runResolver({ profile: 'release' });
  assert.equal(release.result.status, 0, release.result.stderr);

  const custom = runResolver({ profile: 'custom' });
  assert.equal(custom.result.status, 1);
  assert.match(custom.result.stderr, /profile=custom requires custom_checks/i);
});

function runResolver({ profile, custom = '', uiE2eSpecs = '' }) {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-ci-profile-'));
  const output = join(scratch, 'output');
  writeFileSync(output, '');
  try {
    const result = spawnSync('bash', ['-c', resolver.run], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        PROFILE: profile,
        CUSTOM: custom,
        UI_E2E_SPECS: uiE2eSpecs,
      },
    });
    return {
      result,
      flags: Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map((line) => line.split('=', 2))),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function resolveProfile(profile) {
  const { result, flags } = runResolver({ profile });
  assert.equal(result.status, 0, result.stderr);
  return flags;
}

test('manual fast CI keeps core feedback and excludes release/deep certification', () => {
  const flags = resolveProfile('fast');
  for (const lane of ['run_ui', 'run_server', 'run_cli', 'run_stack', 'run_typecheck', 'run_e2e_core']) {
    assert.equal(flags[lane], 'true', `${lane} should remain in fast feedback`);
  }
  for (const lane of ['run_ui_e2e', 'run_e2e_core_slow', 'run_server_db_contract', 'run_release_contracts', 'run_installers_smoke', 'run_binary_smoke']) {
    assert.equal(flags[lane], 'false', `${lane} should not block fast feedback`);
  }
});

test('manual release CI retains ship-path evidence without deep-only slow E2E', () => {
  const flags = resolveProfile('release');
  for (const lane of ['run_ui', 'run_server', 'run_cli', 'run_stack', 'run_typecheck', 'run_cli_daemon_e2e', 'run_e2e_core', 'run_ui_e2e', 'run_server_db_contract', 'run_release_contracts', 'run_installers_smoke', 'run_binary_smoke']) {
    assert.equal(flags[lane], 'true', `${lane} should remain in release certification`);
  }
  assert.equal(flags.run_e2e_core_slow, 'false');
});

test('manual deep CI retains the complete source certification set', () => {
  const flags = resolveProfile('deep');
  for (const lane of [
    'run_ui',
    'run_ui_e2e',
    'run_wsrepl_lima',
    'run_mobile_e2e_android',
    'run_mobile_e2e_ios',
    'run_server',
    'run_cli',
    'run_stack',
    'run_typecheck',
    'run_cli_daemon_e2e',
    'run_e2e_core',
    'run_e2e_core_slow',
    'run_server_db_contract',
    'run_stress',
    'run_release_contracts',
    'run_installers_smoke',
    'run_binary_smoke',
    'run_daemon_continuity',
    'run_session_continuity',
    'run_release_assets_docker',
    'run_self_host_systemd',
    'run_self_host_launchd',
    'run_self_host_schtasks',
    'run_self_host_daemon',
    'run_extended_db',
  ]) {
    assert.equal(flags[lane], 'true', `${lane} should remain available in deep certification`);
  }

  assert.equal(flags.run_providers, 'false', 'live provider scenarios remain an explicit credentialed check');
  assert.equal(flags.run_cli_update_continuity, undefined, 'published-channel CLI updates remain release-candidate validation');
  assert.equal(workflow.jobs.tests.with.run_cli_update_continuity, undefined);

  const wsreplLima = workflow.jobs['ui-e2e-wsrepl-lima'];
  assert.deepEqual(wsreplLima.needs, ['resolve', 'release_actor_guard']);
  assert.equal(wsreplLima.if, "${{ needs.resolve.outputs.run_wsrepl_lima == 'true' }}");
  assert.deepEqual(wsreplLima['runs-on'], ['self-hosted', 'macOS', 'wsrepl-lima']);
  const checkout = wsreplLima.steps.find((step) => step.name === 'Checkout');
  assert.deepEqual(checkout.with, {
    repository: '${{ job.workflow_repository }}',
    ref: '${{ job.workflow_sha }}',
    'persist-credentials': false,
  });

  assert.equal(workflow.jobs.extended_db.uses, './.github/workflows/extended-db-tests.yml');
  assert.equal(workflow.jobs.extended_db.if, "${{ needs.resolve.outputs.run_extended_db == 'true' }}");
  assert.deepEqual(
    workflow.jobs.extended_db.needs,
    ['resolve', 'release_actor_guard'],
    'extended database certification must wait for the same trusted-ref and release-admin admission as the reusable test fanout',
  );
  assert.ok(
    Object.values(workflow.jobs).every((job) => !String(job?.uses ?? '').match(/publish|deploy|promote/i)),
    'deep certification must not invoke publication, deployment, or promotion workflows',
  );
});

test('custom CI trims tokens before selecting lanes', () => {
  const { result, flags } = runResolver({
    profile: 'custom',
    custom: '  ui , e2e_core_slow  ',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(flags.run_ui, 'true');
  assert.equal(flags.run_e2e_core, 'true');
  assert.equal(flags.run_e2e_core_slow, 'true');
  assert.equal(flags.run_server, 'false');
});

test('custom CI rejects every empty or unknown token in one early result', () => {
  const { result } = runResolver({
    profile: 'custom',
    custom: ' ui, ,unknown_one,unknown_two,',
    uiE2eSpecs: 'spec-a\nspec-b',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty custom_checks token/i);
  assert.match(result.stderr, /unknown custom_checks: unknown_one, unknown_two/i);
  assert.match(result.stderr, /ui_e2e_specs must be a single comma-separated line/i);
  assert.match(result.stderr, /custom_checks must include ui_e2e when ui_e2e_specs is set/i);
});
