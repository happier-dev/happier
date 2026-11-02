import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { runDesktopSetupValidation } from '../pipeline/release-validation/executors/desktop-setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const validateScript = resolve(repoRoot, 'scripts', 'pipeline', 'release-validation', 'validate-release.mjs');
const suiteScript = resolve(repoRoot, 'scripts', 'release', 'release-assets-e2e', 'desktop-setup.mjs');

function dryRun(args) {
  return spawnSync(process.execPath, [validateScript, '--suite', 'desktop-setup', '--dry-run', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('release-validate plans desktop-setup against a published CLI tag and the desktop artifact under test', () => {
  const out = dryRun(['--platform', 'linux', '--source', 'published-tag', '--ref', 'cli-v0.2.13', '--desktop-artifact', 'dist/tauri/app.deb']);
  assert.equal(out.status, 0, out.stderr);
  const parsed = JSON.parse(out.stdout);
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [suiteScript, '--desktop-artifact', resolve(repoRoot, 'dist/tauri/app.deb'), '--cli-tag', 'cli-v0.2.13'],
    cwd: repoRoot,
  });
});

test('release-validate plans desktop-setup local builds from the CLI release asset directory', () => {
  const out = dryRun(['--platform', 'linux', '--source', 'local-build', '--ref', '.', '--desktop-artifact', 'app.AppImage', '--release-channel', 'preview']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).execution.args.slice(3), ['--cli-assets-dir', resolve(repoRoot, 'dist', 'release-assets', 'cli'), '--channel', 'preview']);
});

test('release-validate plans desktop-setup against the published channel CLI for a desktop-only release', () => {
  const out = dryRun(['--platform', 'linux', '--source', 'published-channel', '--ref', 'stable', '--desktop-artifact', 'dist/tauri/app.deb']);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout).execution.args.slice(3), ['--cli-channel', 'stable']);
});

test('release-validate refuses desktop-setup without an artifact, off Linux, or from a rolling tag', () => {
  assert.match(dryRun(['--platform', 'linux', '--source', 'published-tag', '--ref', 'cli-v0.2.13']).stderr, /--desktop-artifact/);
  assert.match(dryRun(['--platform', 'darwin', '--source', 'published-tag', '--ref', 'cli-v0.2.13', '--desktop-artifact', 'a.deb']).stderr, /--platform linux only/);
  assert.match(dryRun(['--platform', 'linux', '--source', 'published-tag', '--ref', 'cli-stable', '--desktop-artifact', 'a.deb']).stderr, /immutable cli-v<version>/);
  assert.match(
    spawnSync(process.execPath, [validateScript, '--suite', 'binary-smoke', '--source', 'local-build', '--ref', '.', '--desktop-artifact', 'a.deb', '--dry-run'], { cwd: repoRoot, encoding: 'utf8' }).stderr,
    /only for --suite desktop-setup/,
  );
});

test('a run over the registry budget warns instead of failing; a failed run still fails', () => {
  const warnings = [];
  let clock = 0;
  const base = {
    repoRoot,
    platform: 'linux',
    source: { kind: 'published-tag', ref: 'cli-v0.2.13' },
    options: { desktopArtifact: 'a.deb' },
    timeBudgetMinutes: 10,
    assertDockerAvailable: () => {},
    now: () => clock,
    warn: (message) => warnings.push(message),
  };
  runDesktopSetupValidation({ ...base, exec: () => { clock += 11 * 60_000; } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /over its 10-minute release-validation budget/);

  clock = 0;
  assert.throws(() => runDesktopSetupValidation({ ...base, exec: () => { throw new Error('suite failed'); } }), /suite failed/);
  assert.throws(() => runDesktopSetupValidation({ ...base, timeBudgetMinutes: undefined, exec: () => {} }), /timeBudgetMinutes/);
});

const loadWorkflow = async (name) => YAML.parse(await readFile(join(repoRoot, '.github', 'workflows', name), 'utf8'), { prettyErrors: true });

test('build-tauri gates the production desktop publish on desktop-setup against the just-built Linux bundle', async () => {
  const workflow = await loadWorkflow('build-tauri.yml');
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    assert.equal(workflow.on[trigger].inputs.candidate_cli_version?.type, 'string', `${trigger} takes the CLI candidate`);
    assert.equal(workflow.on[trigger].inputs.candidate_cli_version?.default, '');
  }

  const job = workflow.jobs.desktop_setup;
  assert.ok(job, 'build-tauri must own one desktop-setup gate job');
  assert.match(job.if, /!cancelled\(\)/);
  assert.ok(job.if.includes("needs.resolve_source.result == 'success'"));
  assert.ok(job.if.includes("needs.finalize.result == 'success'"), 'it consumes the finalized (signed) Linux bundle');
  const admitsSetup = (finalizeNeeded, reuseNeeded, finalizeResult, reuseResult, preparationOnly = false) => {
    const expression = job.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    return Function('needs', 'cancelled', 'inputs', `return Boolean(${expression});`)({
      resolve_source: { result: 'success', outputs: { finalize_needed: finalizeNeeded, reuse_needed: reuseNeeded } },
      finalize: { result: finalizeResult },
      reuse_finalized: { result: reuseResult },
    }, () => false, { preparation_only: preparationOnly });
  };
  assert.equal(admitsSetup('true', 'false', 'success', 'skipped'), true, 'new signed artifacts need no restore job');
  assert.equal(admitsSetup('false', 'true', 'skipped', 'success'), true, 'a fully restored signed candidate still runs the setup gate');
  assert.equal(admitsSetup('true', 'true', 'success', 'success'), true, 'mixed candidates require both artifact producers');
  assert.equal(admitsSetup('true', 'false', 'success', 'skipped', true), false, 'preparation does not run the final setup gate');
  for (const [finalizeNeeded, reuseNeeded, finalizeResult, reuseResult] of [
    ['true', 'false', 'failure', 'skipped'],
    ['false', 'true', 'skipped', 'failure'],
    ['true', 'true', 'success', 'failure'],
    ['true', 'true', 'failure', 'success'],
    ['true', 'false', 'skipped', 'skipped'],
    ['false', 'true', 'skipped', 'skipped'],
  ]) {
    assert.equal(admitsSetup(finalizeNeeded, reuseNeeded, finalizeResult, reuseResult), false, 'missing or failed planned artifacts cannot pass setup admission');
  }
  assert.deepEqual(job.needs, ['resolve_source', 'finalize', 'reuse_finalized']);
  // Linux desktop bundles ship for x86_64 only; hosted ubuntu runners are x86_64 with Docker.
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.environment, undefined, 'the gate must not enter the secret-bearing release environment');
  assert.doesNotMatch(JSON.stringify(job), /secrets\./, 'the gate needs no secrets');

  const steps = job.steps;
  const checkouts = steps.filter((step) => String(step.uses ?? '').startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1, 'candidate runtimes come from artifacts, not another source checkout');
  const checkout = checkouts[0];
  assert.equal(checkout.with.ref, '${{ job.workflow_sha }}', 'control-only recovery must load the corrected harness, not preserved candidate source');
  assert.equal(checkout.with.repository, '${{ job.workflow_repository }}');
  assert.equal(checkout.with.path, undefined, 'trusted validation control owns the workspace root');
  assert.equal(checkout.with['persist-credentials'], false);

  // The registry is the one selection owner: the job asks it, and every later step follows it.
  const plan = steps.find((step) => step.id === 'plan');
  assert.match(String(plan.run), /resolve-validation-plan\.mjs/);
  assert.match(String(plan.run), /--suite desktop-setup/);
  assert.match(String(plan.run), /--has-desktop-candidate true/);
  assert.match(String(plan.run), /--candidate-cli-version "\$CANDIDATE_CLI_VERSION"/);
  assert.match(String(plan.run), /--candidate-channel "\$RELEASE_ENVIRONMENT"/);
  assert.equal(plan.env.CANDIDATE_CLI_VERSION, '${{ inputs.candidate_cli_version }}');
  assert.equal(plan.env.RELEASE_ENVIRONMENT, '${{ inputs.environment }}');
  const skipNotice = steps.find((step) => step.if === "steps.plan.outputs.run != 'true'");
  assert.match(String(skipNotice?.run ?? ''), /::notice/, 'a skip is reported with its reason');
  assert.match(String(skipNotice.env?.SKIP_REASON ?? ''), /steps\.plan\.outputs\.skip_reason/);

  const download = steps.find((step) => String(step.uses ?? '').startsWith('actions/download-artifact@'));
  assert.equal(download.with.name, 'tauri-updates-${{ inputs.environment }}-linux-x86_64', 'the same-run, same-channel bundle finalize uploaded');
  assert.equal(download.with['run-id'], undefined);
  assert.equal(download.with.path, 'dist/desktop-setup-candidate', 'artifact data stays outside trusted workflow control');
  const finalizerUpload = workflow.jobs.finalize.steps.find((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'));
  assert.equal(finalizerUpload.with.name, 'tauri-updates-${{ inputs.environment }}-${{ matrix.platform_key }}');
  const runStep = steps.find((step) => /--suite desktop-setup/.test(String(step.run ?? '')) && /release-validate/.test(String(step.run ?? '')));
  assert.ok(steps.indexOf(plan) < steps.indexOf(download) && steps.indexOf(download) < steps.indexOf(runStep));
  for (const step of steps.slice(steps.indexOf(plan) + 1)) {
    if (step === skipNotice) continue;
    assert.match(String(step.if ?? ''), /steps\.plan\.outputs\.run == 'true'/, `${step.name} runs only when the registry selects the suite`);
  }
  assert.equal(runStep['timeout-minutes'], '${{ fromJSON(steps.plan.outputs.timeout_minutes) }}', 'the hard stop derives from the registry budget');
  assert.ok(job['timeout-minutes'] > 20, 'the job leaves room for setup around the derived suite timeout');
  const run = String(runStep.run);
  assert.match(run, /find dist\/desktop-setup-candidate -maxdepth 1 -type f -name '\*\.deb'/);
  assert.match(run, /if \[ "\$\{#debs\[@\]\}" -ne 1 \]/, 'the gate refuses an ambiguous finalized desktop artifact');
  assert.match(run, /--platform linux/);
  // The registry picks the CLI: the candidate's immutable tag, else the published channel CLI.
  assert.match(run, /--source "\$\{CLI_SOURCE\}"/);
  assert.match(run, /--ref "\$\{CLI_REF\}"/);
  assert.match(run, /--desktop-artifact "\$\{desktop_artifact\}"/);
  assert.equal(runStep.env.CLI_SOURCE, '${{ steps.plan.outputs.cli_source }}');
  assert.equal(runStep.env.CLI_REF, '${{ steps.plan.outputs.cli_ref }}');

  // The production publish waits for the gate; a failed gate never publishes.
  const publish = workflow.jobs.publish_stable_release;
  assert.ok(publish.needs.includes('desktop_setup'));
  assert.ok(publish.if.includes("needs.desktop_setup.result == 'success'"));
  const admits = (desktopSetupResult) => Function('needs', 'inputs', 'cancelled', `return ${publish.if.slice(3, -2)}`)(
    {
      resolve_source: { result: 'success', outputs: { retry_version: '' } },
      prepare_assets: { result: 'success' },
      desktop_setup: { result: desktopSetupResult },
    },
    { publish_release: true, environment: 'production' },
    () => false,
  );
  assert.equal(admits('success'), true);
  for (const result of ['failure', 'cancelled', 'skipped']) assert.equal(admits(result), false, `publish must not follow a ${result} gate`);
});

test('every desktop release caller passes its CLI candidate to the build-tauri gate', async () => {
  const release = await loadWorkflow('release-channel.yml');
  assert.ok(release.jobs.deploy_ui.needs.includes('publish_cli_binaries'));
  assert.equal(
    release.jobs.deploy_ui.with.candidate_cli_version,
    "${{ needs.publish_cli_binaries.result == 'success' && needs.publish_cli_binaries.outputs.version || '' }}",
  );
  const promoteUi = await loadWorkflow('promote-ui.yml');
  assert.equal(promoteUi.on.workflow_call.inputs.candidate_cli_version?.default, '');
  assert.equal(promoteUi.jobs.desktop.with.candidate_cli_version, '${{ inputs.candidate_cli_version }}');
  const nightly = await loadWorkflow('nightly-dev.yml');
  assert.ok(nightly.jobs.ui_desktop.needs.includes('cli'));
  assert.equal(nightly.jobs.ui_desktop.with.candidate_cli_version, '${{ needs.cli.outputs.version }}');
});

test('desktop-setup runs in exactly one place: release verification no longer stages or runs it', async () => {
  const releaseVerify = await loadWorkflow('release-verify.yml');
  assert.equal(releaseVerify.on.workflow_call.inputs.candidate_desktop_run_id, undefined);
  assert.equal(releaseVerify.jobs.stage_desktop_candidate, undefined);
  assert.doesNotMatch(JSON.stringify(releaseVerify), /desktop.setup|desktop_setup|has-desktop-candidate/);

  const tests = await loadWorkflow('tests.yml');
  assert.equal(tests.jobs['desktop-setup'], undefined);
  for (const input of ['run_desktop_setup', 'desktop_setup_artifact', 'desktop_setup_cli_ref']) {
    assert.equal(tests.on.workflow_call.inputs[input], undefined, `tests.yml must not keep ${input}`);
  }
  assert.doesNotMatch(JSON.stringify(tests), /desktop.setup|DESKTOP_SETUP/);
});
