import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8'));

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
  });
}
