import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));

function assertReclaimBeforeCompilation(steps) {
  const xcode = steps.findIndex(step => step.uses === './.github/actions/setup-xcode');
  const reclaim = steps.findIndex(step => step.uses === './.github/actions/reclaim-ios-runner-disk');
  assert.ok(reclaim >= 0, 'iOS compilation must reclaim unused runner SDKs');
  assert.equal(reclaim, xcode + 1, 'reclaim immediately after selecting the Xcode to preserve');
  assert.equal(steps[reclaim].if, steps[xcode].if, 'reclaim has the same platform guard as Xcode');
  assert.equal(steps[reclaim]['continue-on-error'], undefined);
  const compile = steps.findIndex(step => /ensureWorkspacePackagesBuilt|expo prebuild|xcodebuild|ui-mobile-release/.test(step.run ?? '')
    && !/--preflight-only/.test(step.run ?? ''));
  assert.ok(compile > reclaim, 'reclaim before the native build entry point or workspace compilation');
}

test('reclaim action preserves selected Xcode aliases and unrelated tools, and propagates failures', t => {
  const action = parse(readFileSync(new URL('../../.github/actions/reclaim-ios-runner-disk/action.yml', import.meta.url), 'utf8'));
  assert.equal(action.runs.using, 'composite');
  const script = action.runs.steps.find(step => step.run)?.run;
  assert.equal(typeof script, 'string');
  const root = mkdtempSync(join(tmpdir(), 'reclaim-ios-'));
  try {
    const applications = join(root, 'Applications with spaces');
    const selected = join(applications, 'Xcode_27.1.app');
    const stale = join(applications, 'Xcode_26.2.app');
    const sdk = join(root, 'Android/sdk');
    const runtime = join(root, 'Library/Developer/CoreSimulator/Profiles/Runtimes/iOS.simruntime');
    const bin = join(root, 'bin');
    for (const directory of [join(selected, 'Contents/Developer'), stale, sdk, runtime, bin, join(applications, 'Other.app'), join(applications, 'Xcode_27.2_Release_Candidate.app')]) {
      mkdirSync(directory, { recursive: true });
    }
    symlinkSync('Xcode_27.1.app', join(applications, 'Xcode_27.1.0.app'));
    symlinkSync('Xcode_27.1.0.app', join(applications, 'Xcode.app'));
    symlinkSync('Xcode_27.2_Release_Candidate.app', join(applications, 'Xcode_27.2.app'));
    symlinkSync('missing.app', join(applications, 'Xcode_dangling.app'));
    // Only OS commands are replaced; execute the actual composite action shell.
    writeFileSync(join(bin, 'xcode-select'), '#!/bin/bash\nset -euo pipefail\n[[ "$#" == 1 && "$1" == -p ]]\nprintf "%s\\n" "$RECLAIM_TEST_DEVELOPER_DIR"\n', { mode: 0o755 });
    writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nset -euo pipefail\nif [[ "${RECLAIM_TEST_SUDO_FAILURE:-0}" == 1 ]]; then exit 73; fi\nexec "$@"\n', { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      IOS_RUNNER_APPLICATIONS_ROOT: applications,
      ANDROID_HOME: sdk,
      RECLAIM_TEST_DEVELOPER_DIR: join(applications, 'Xcode.app/Contents/Developer'),
      RECLAIM_TEST_SUDO_FAILURE: '0',
    };
    const run = overrides => spawnSync('/bin/bash', ['-c', script], { env: { ...env, ...overrides }, encoding: 'utf8' });
    const initial = readdirSync(applications).sort();
    const invalid = run({ RECLAIM_TEST_DEVELOPER_DIR: root });
    assert.notEqual(invalid.status, 0, 'an unresolved selected Xcode must prevent deletion');
    assert.deepEqual(readdirSync(applications).sort(), initial);
    assert.ok(existsSync(sdk));
    const denied = run({ RECLAIM_TEST_SUDO_FAILURE: '1' });
    assert.equal(denied.status, 73, 'sudo/removal failures must stop the action');
    assert.deepEqual(readdirSync(applications).sort(), initial);
    assert.ok(existsSync(sdk));
    const reclaimed = run({});
    assert.equal(reclaimed.status, 0, reclaimed.stderr);
    assert.deepEqual(readdirSync(applications).sort(), ['Other.app', 'Xcode.app', 'Xcode_27.1.0.app', 'Xcode_27.1.app']);
    assert.ok(existsSync(join(applications, 'Xcode.app/Contents/Developer')), 'selected aliases remain usable');
    assert.equal(existsSync(sdk), false);
    assert.ok(existsSync(runtime), 'simulator runtimes remain untouched');
    t.diagnostic(reclaimed.stdout);
    const repeated = run({});
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.ok(existsSync(join(applications, 'Xcode.app/Contents/Developer')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nightly selection and execution use the same source branch', () => {
  for (const id of ['ci_plan', 'self-host-schtasks-e2e', 'pre-release-packaged-cli', 'pre-release-mobile-native']) {
    const checkout = workflow.jobs[id].steps.find(step => step.uses?.startsWith('actions/checkout@'));
    const expression = checkout?.with.ref?.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
    const ref = Function('inputs', 'github', `return (${expression});`)(
      { checkout_sha: '' }, { event_name: 'schedule', sha: 'default-branch-sha' });
    assert.equal(ref, 'dev', id);
  }
});

test('selected pre-release native validation compiles Android and iOS without publication credentials', () => {
  const job = workflow.jobs['pre-release-mobile-native'];
  assert.ok(job, 'native compilation must run before release');
  assert.deepEqual(job.needs, ['ci_plan']);
  assert.equal(job.if, "${{ !inputs.select_jobs_explicitly && needs.ci_plan.outputs.run_mobile_native == 'true' }}");
  assert.deepEqual(job.strategy.matrix.include, [
    { platform: 'android', runner: 'ubuntu-24.04' },
    { platform: 'ios', runner: 'xcode-27' },
  ]);
  assert.equal(job['runs-on'], '${{ matrix.runner }}');
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.environment, undefined);
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|EXPO_TOKEN|APPLE_API_PRIVATE_KEY|maestro|ui-mobile-release|eas build|eas submit/);

  const steps = job.steps;
  assertReclaimBeforeCompilation(steps);
  const checkout = steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout?.with.ref, "${{ github.event_name == 'schedule' && 'dev' || github.sha }}");
  const commands = steps.map(step => step.run ?? '').join('\n');
  assert.match(commands, /resolveEasBuildProfileEnv/);
  assert.match(commands, /profileId: 'preview'/);
  const prepare = steps.findIndex(step => /node scripts\/ensureWorkspacePackagesBuilt\.mjs/.test(step.run ?? ''));
  const prebuild = steps.findIndex(step => /expo prebuild --platform/.test(step.run ?? ''));
  const patches = steps.findIndex(step => /run eas-build-post-install|yarn -s eas-build-post-install/.test(step.run ?? ''));
  assert.ok(prepare >= 0 && prebuild > prepare && patches > prebuild, 'prepare workspaces, generate native projects, then apply canonical native patches');
  const android = steps.find(step => /\.\/gradlew/.test(step.run ?? ''));
  assert.equal(android?.if, "${{ matrix.platform == 'android' }}");
  assert.match(android.run, /\.\/gradlew :app:assembleDebug/);
  assert.match(commands, /JAVA_HOME_17_X64/);
  const xcode = steps.find(step => step.uses === './.github/actions/setup-xcode');
  assert.equal(xcode?.with.xcode_version, '27.1');
  const pods = steps.findIndex(step => /pod install/.test(step.run ?? ''));
  const ios = steps.findIndex(step => /xcodebuild -workspace/.test(step.run ?? ''));
  assert.ok(pods > patches && ios > pods, 'compile the app with its patched CocoaPods closure');
  assert.equal(steps[ios].if, "${{ matrix.platform == 'ios' }}");
  assert.match(steps[ios].run, /-sdk iphonesimulator/);
  assert.match(steps[ios].run, /-destination 'generic\/platform=iOS Simulator'/);
  assert.match(steps[ios].run, /build CODE_SIGNING_ALLOWED=NO/);
});

for (const [file, jobId] of [
  ['build-ui-mobile-local.yml', 'build_ios'],
  ['publish-ui-mobile-dev.yml', 'ios_local'],
]) {
  test(`${file} compiles iOS with the same stable SDK as native validation`, () => {
    const release = parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
    const job = release.jobs[jobId];
    assert.equal(job['runs-on'], 'xcode-27');
    const xcode = job.steps.find(step => step.uses === './.github/actions/setup-xcode');
    assert.equal(xcode?.with.xcode_version, '27.1');
    assertReclaimBeforeCompilation(job.steps);
  });
}
