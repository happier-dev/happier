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
  for (const lane of ['run_ui', 'run_server', 'run_cli', 'run_stack', 'run_typecheck', 'run_cli_daemon_e2e', 'run_e2e_core', 'run_e2e_core_slow', 'run_ui_e2e', 'run_server_db_contract', 'run_release_contracts', 'run_installers_smoke', 'run_binary_smoke']) {
    assert.equal(flags[lane], 'true', `${lane} should remain available in deep certification`);
  }
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
