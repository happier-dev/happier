import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { validateReleaseDispatch } from '../pipeline/release/validate-release-dispatch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

test('release workflow only promotes and publishes the exact prepared candidate source', async () => {
  const raw = await loadWorkflow('release.yml');

  // If CI gate fails, checks is skipped; downstream must not treat that as OK to promote/deploy.
  assert.doesNotMatch(
    raw,
    /needs\.plan\.result == 'success' \|\| needs\.plan\.result == 'skipped'/,
    'release orchestrator must not treat skipped checks as eligible for promotion/deploy',
  );

  // promote_main must remain reachable after plan success; final releases never create a post-admission bump commit.
  assert.match(
    raw,
    /promote_main:[\s\S]*?if:\s*always\(\)\s*&&[\s\S]*?inputs\.dry_run != true && inputs\.environment == 'production'[\s\S]*?needs\.plan\.result == 'success'/,
  );
  assert.doesNotMatch(raw, /^  bump_versions_dev:/m);
  assert.doesNotMatch(raw, /needs\.bump_versions_dev/);
  assert.match(raw, /node scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  const previewDispatch = {
    authorizedPromotionSourceSha: 'a'.repeat(40),
    releaseNotesId: 'release-1',
    bump: 'none',
    deployTargets: 'ui,server',
    environment: 'preview',
    dryRun: false,
  };
  assert.equal(validateReleaseDispatch({ ...previewDispatch, confirm: 'release dev to preview' }).mode, 'preview_release');
  assert.throws(
    () => validateReleaseDispatch({ ...previewDispatch, confirm: 'release dev to main' }),
    /Confirmation mismatch for preview releases/u,
  );

  assert.match(raw, /source_ref:\s*\$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/);
  assert.match(raw, /publish_npm:[\s\S]*?source_ref:\s*\$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}/);
  assert.match(raw, /deploy_ui:[\s\S]*?bump:\s*none/);
  assert.match(
    raw,
    /sync_dev:[\s\S]*?if:\s*\$\{\{\s*inputs\.dry_run != true && inputs\.environment == 'production'[\s\S]*?needs\.release_verify\.result == 'success'/,
  );
  assert.doesNotMatch(raw, /needs\.release_verify\.result == 'skipped'/, 'production sync must not accept skipped release verification');
  assert.match(
    raw,
    /Compute versioned component changes \(latest release tags\.\.release head\)[\s\S]*?node scripts\/pipeline\/run\.mjs release-compute-versioned-component-changes/,
  );
  assert.match(raw, /VERSIONED_APP_CHANGED:\s*\$\{\{\s*steps\.versioned_plan\.outputs\.changed_app\s*\}\}/);
  assert.match(raw, /VERSIONED_CLI_CHANGED:\s*\$\{\{\s*steps\.versioned_plan\.outputs\.changed_cli\s*\}\}/);
});

test('release workflow publishes server runner only when explicitly requested', async () => {
  const raw = await loadWorkflow('release.yml');

  // Server runner publishing must be an explicit target so server deploy remains independent.
  // The logic lives in the shared pipeline script (not inline bash).
  assert.match(raw, /node scripts\/pipeline\/run\.mjs release-resolve-bump-plan/);
  assert.match(raw, /--deploy-targets "\$\{DEPLOY_TARGETS\}"/);

  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?uses:\s*\.\/\.github\/workflows\/publish-server-runtime\.yml/,
    'server runtime publishing should be handled by a dedicated workflow (decoupled from SaaS deploy)',
  );
  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'stable' \|\| 'preview'\s*\}\}/,
    'server runtime publishing should select stable vs preview through the shared channel mapping',
  );
  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?source_ref:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/,
    'server runtime publishing should build from the exact prepared candidate',
  );
  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?allow_stable:\s*\$\{\{\s*inputs\.environment == 'production'\s*\}\}/,
    'server runtime publishing should explicitly unlock stable publishing only for production releases',
  );
  assert.match(
    raw,
    /deploy_server:[\s\S]*?publish_runtime_release:\s*false/,
    'SaaS server deploy must not implicitly publish rolling server runtime releases',
  );
});

test('release workflow accepts the public validation profile and routes its automatic suites', async () => {
  const raw = await loadWorkflow('release.yml');
  const workflow = parse(raw);
  const validationProfile = workflow?.on?.workflow_dispatch?.inputs?.validation_profile;
  const candidateVerifier = workflow?.jobs?.verify_release_candidates;

  assert.equal(validationProfile?.type, 'choice');
  assert.equal(validationProfile?.default, 'integrated');
  assert.deepEqual(validationProfile?.options, ['integrated', 'stable']);

  assert.equal(candidateVerifier?.with?.validation_profile, '${{ needs.plan.outputs.validation_profile }}');
  assert.equal(candidateVerifier?.with?.run_binary_smoke, undefined);
  assert.equal(candidateVerifier?.with?.run_session_continuity, undefined);
  assert.equal(candidateVerifier?.with?.run_cli_update_continuity, undefined);
  assert.equal(candidateVerifier?.with?.run_daemon_continuity, undefined);
  assert.equal(candidateVerifier?.with?.run_installers_smoke, undefined);
});

test('release workflow fans a versioned Stack target through immutable publication, staged promotion, npm, and exact signoff', async () => {
  const [raw, verifierRaw] = await Promise.all([
    loadWorkflow('release.yml'),
    loadWorkflow('release-verify.yml'),
  ]);
  const jobs = parse(raw)?.jobs ?? {};
  const publisher = jobs.publish_hstack_binaries;
  const candidateVerifier = jobs.verify_release_candidates;
  const promoter = jobs.promote_hstack_binaries;
  const npm = jobs.publish_npm;
  const finalVerifier = jobs.release_verify;
  const verifierInputs = parse(verifierRaw)?.on?.workflow_call?.inputs ?? {};

  assert.equal(publisher?.uses, './.github/workflows/publish-hstack-binaries.yml');
  assert.match(String(publisher?.if ?? ''), /needs\.plan\.outputs\.publish_stack == 'true'/);
  assert.match(String(publisher?.with?.authorized_sha ?? ''), /needs\.prepare_release_candidate\.outputs\.source_sha/);
  assert.equal(publisher?.with?.publish_rolling, false);

  assert.ok(candidateVerifier?.needs?.includes('publish_hstack_binaries'));
  assert.match(String(candidateVerifier?.with?.candidate_stack_version ?? ''), /needs\.publish_hstack_binaries\.outputs\.version/);
  assert.match(String(candidateVerifier?.with?.verify_stack_release ?? ''), /needs\.publish_hstack_binaries\.result == 'success'/);

  assert.equal(promoter?.uses, './.github/workflows/publish-hstack-binaries.yml');
  assert.ok(promoter?.needs?.includes('verify_release_candidates'));
  assert.ok(promoter?.needs?.includes('publish_hstack_binaries'));
  assert.match(String(promoter?.if ?? ''), /needs\.verify_release_candidates\.result == 'success'/);
  assert.match(String(promoter?.with?.retry_version ?? ''), /needs\.publish_hstack_binaries\.outputs\.version/);

  assert.match(String(npm?.if ?? ''), /needs\.plan\.outputs\.publish_stack == 'true'/);
  assert.match(String(npm?.with?.publish_stack ?? ''), /needs\.plan\.outputs\.publish_stack == 'true'/);

  assert.ok(finalVerifier?.needs?.includes('publish_hstack_binaries'));
  assert.ok(finalVerifier?.needs?.includes('promote_hstack_binaries'));
  assert.match(String(finalVerifier?.if ?? ''), /needs\.promote_hstack_binaries\.result == 'success'/);
  assert.match(String(finalVerifier?.with?.candidate_stack_version ?? ''), /needs\.publish_hstack_binaries\.outputs\.version/);
  assert.match(String(finalVerifier?.with?.verify_stack_release ?? ''), /needs\.promote_hstack_binaries\.result == 'success'/);
  assert.equal(verifierInputs?.verify_stack_release?.type, 'boolean');
  const stackIdentityGuard = parse(verifierRaw)?.jobs?.verify_candidate?.steps?.find(
    (step) => step.name === 'Require requested HStack verification identity',
  );
  assert.ok(stackIdentityGuard);
  assert.match(String(stackIdentityGuard.if ?? ''), /inputs\.verify_stack_release/);
  assert.match(String(stackIdentityGuard.if ?? ''), /inputs\.candidate_stack_version == ''/);
});

test('release workflow can publish self-host UI web bundle via a dedicated workflow', async () => {
  const raw = await loadWorkflow('release.yml');
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?uses:\s*\.\/\.github\/workflows\/publish-ui-web\.yml/,
    'self-host UI web bundle publishing should be handled by a dedicated workflow',
  );
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'stable' \|\| 'preview'\s*\}\}/,
    'ui web bundle publishing should select stable vs preview through the shared channel mapping',
  );
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?source_ref:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/,
    'ui web bundle publishing should build from the exact prepared candidate',
  );
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?allow_stable:\s*\$\{\{\s*inputs\.environment == 'production'\s*\}\}/,
    'ui web bundle publishing should explicitly unlock stable publishing only for production releases',
  );
});

test('release workflow routes docker publishing through stable for production and preview for preview', async () => {
  const raw = await loadWorkflow('release.yml');
  assert.match(
    raw,
    /publish_docker:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'stable' \|\| 'preview'\s*\}\}/,
    'docker publishing should select stable vs preview through the shared channel mapping',
  );
  assert.match(
    raw,
    /publish_docker:[\s\S]*?source_ref:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.source_sha\s*\}\}/,
    'docker publishing should build from the exact prepared candidate',
  );
});

test('release workflow delegates deploy plan computation to pipeline script', async () => {
  const raw = await loadWorkflow('release.yml');

  assert.match(
    raw,
    /- name: Compute deploy plan[\s\S]*?node \.\.\/scripts\/pipeline\/release\/compute-deploy-plan\.mjs/,
    'release.yml should delegate deploy plan computation to compute-deploy-plan.mjs',
  );
  assert.doesNotMatch(raw, /plan_one\(\)/, 'release.yml should not embed deploy plan logic in inline bash');
  assert.doesNotMatch(
    raw,
    /\/tmp\/changed_deploy_/,
    'release.yml should not write deploy plan path lists to /tmp (logic belongs in compute-deploy-plan.mjs)',
  );
});

test('release workflows do not embed invalid JS escaping in node -p/-e snippets', async () => {
  const release = await loadWorkflow('release.yml');
  const releaseNpm = await loadWorkflow('release-npm.yml');
  const promoteServer = await loadWorkflow('promote-server.yml');

  // These sequences produce broken JavaScript (backslashes are passed literally to Node).
  for (const raw of [release, releaseNpm, promoteServer]) {
    assert.doesNotMatch(raw, /require\(\\"/, 'do not use require(\\") style escaping in workflows');
    assert.doesNotMatch(raw, /require\(\\"node:fs\\"/, 'do not escape quotes inside node -e single-quoted strings');
  }
});

test('release-npm resolves source ref from channel and checks out resolved source', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?source_ref:/);
  assert.match(raw, /workflow_call:[\s\S]*?inputs:[\s\S]*?source_ref:/);

  assert.match(raw, /if \[ "\$src" = "auto" \]; then[\s\S]*?if \[ "\$channel" = "preview" \]; then[\s\S]*?src="preview"[\s\S]*?src="main"/);
  assert.match(raw, /ref:\s*\$\{\{ steps\.resolve_source\.outputs\.ref \}\}/);
});

test('release-npm embeds build feature policy defaults by channel', async () => {
  const raw = await loadWorkflow('release-npm.yml');
  assert.match(
    raw,
    /HAPPIER_EMBEDDED_POLICY_ENV:\s*\$\{\{\s*inputs\.channel\s*==\s*'production'\s*&&\s*'production'\s*\|\|\s*'preview'\s*\}\}/,
    'npm publishing should set HAPPIER_EMBEDDED_POLICY_ENV to production for production channel releases',
  );
});

test('release-npm is compatible with npm trusted publishing (OIDC)', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /node scripts\/pipeline\/npm\/publish-tarball\.mjs/, 'trusted release control should invoke the canonical npm tarball publisher directly');
  assert.match(raw, /node scripts\/pipeline\/run\.mjs npm-release/, 'release-npm should delegate npm pack preparation to the pipeline command');
  assert.doesNotMatch(raw, /npm pack --ignore-scripts --json/, 'release-npm should not embed npm pack json parsing boilerplate (use release-packages.mjs)');
  assert.doesNotMatch(raw, /npm install --global npm@11/, 'release-npm should avoid global npm installs (use pinned npm via npx inside the pipeline)');
  assert.doesNotMatch(raw, /NPM_TOKEN is required for npm publish\./);
});

test('release-npm installs Sapling before cli integration tests', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(
    raw,
    /release:[\s\S]*?runs-on:\s*ubuntu-22\.04/,
    'release-npm should pin ubuntu-22.04 because the Sapling installer is Ubuntu 22.04 specific',
  );
  assert.doesNotMatch(
    raw,
    /MINISIGN_|bootstrap-minisign|release-prepare-binary-assets/,
    'npm candidate packing must not cross the binary-signing trust boundary',
  );
  assert.match(
    raw,
    /- name: Install Sapling[\s\S]*?if:\s*inputs\.publish_cli && inputs\.run_tests[\s\S]*?bash scripts\/ci\/install_sapling_ubuntu22\.sh/,
    'release-npm should install Sapling in the cli test lane before running sapling integration tests',
  );
  assert.match(raw, /- name: Run cli tests[\s\S]*?yarn --cwd apps\/cli test:integration/);
});

test('release-npm derives unique preview prerelease versions from base versions', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.doesNotMatch(raw, /version_bump_cli/);
  assert.doesNotMatch(raw, /version_bump_stack/);
  assert.doesNotMatch(raw, /function bumpBase\(base, bump\)/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs npm-set-preview-versions/);
  assert.doesNotMatch(raw, /function setPreviewVersion\(pkgPath\)/);
  assert.doesNotMatch(raw, /\$\{base\}-preview\.\$\{run\}\.\$\{attempt\}/);
  assert.match(raw, /publish_server/, 'release-npm should expose publish_server for server runner publishing');

  // Server runner package is canonicalized under packages/relay-server.
  assert.doesNotMatch(raw, /packages\/server\//, 'release-npm must not reference removed packages/server');
  assert.match(raw, /dir="packages\/relay-server"/);
  assert.match(raw, /SERVER_RUNNER_DIR:\s*\$\{\{ steps\.server_runner\.outputs\.dir \}\}/);
  assert.match(raw, /SERVER_RUNNER_DIR:\s*\$\{\{ steps\.server_runner\.outputs\.dir \}\}[\s\S]*?yarn --cwd "\$\{SERVER_RUNNER_DIR\}" test/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs npm-release[\s\S]*?--server-runner-dir "\$\{SERVER_RUNNER_DIR\}"/);

  const script = await loadFile('scripts/pipeline/npm/set-preview-versions.mjs');
  assert.match(script, /resolveRollingPublishVersion/);
  assert.doesNotMatch(script, /GITHUB_RUN_NUMBER/);
});

test('final release workflows only consume already-materialized version bumps', async () => {
  const orchestrator = await loadWorkflow('release.yml');
  const releaseNpm = await loadWorkflow('release-npm.yml');
  const workflow = parse(orchestrator);

  assert.equal(
    workflow?.on?.workflow_dispatch?.inputs?.bump,
    undefined,
    'manual final release dispatch must not advertise version mutations',
  );

  assert.doesNotMatch(orchestrator, /bump-versions-dev\.mjs/);
  assert.doesNotMatch(orchestrator, /BUMP_STACK:\s*\$\{\{ needs\.plan\.outputs\.bump_stack \}\}/);
  assert.doesNotMatch(orchestrator, /--bump-stack "\$BUMP_STACK"/);
  assert.doesNotMatch(orchestrator, /node scripts\/release\/bump-version\.mjs --component stack/, 'release.yml should delegate version bumps to the pipeline script');
  assert.doesNotMatch(orchestrator, /BUMP="\$\{\{ needs\.plan\.outputs\.bump_stack \}\}" node - <<'NODE'/);

  // The final release consumes an already committed source, so release-npm must not create its own version bumps.
  assert.doesNotMatch(releaseNpm, /bump-version\.mjs --component cli/, 'release-npm should not bump cli on main');
  assert.doesNotMatch(releaseNpm, /bump-version\.mjs --component stack/, 'release-npm should not bump stack on main');
  assert.doesNotMatch(releaseNpm, /npm version "\$\{\{ inputs\.version_bump_stack \}\}"/, 'release-npm must not use npm version for stack bumps');
});

test('release-npm does not manage deploy/* branches (deploy is for server/web apps)', async () => {
  const raw = await loadWorkflow('release-npm.yml');
  assert.doesNotMatch(raw, /update_deploy_branch:/, 'release-npm should not expose update_deploy_branch input');
  assert.doesNotMatch(raw, /deploy\/\$\{\{\s*inputs\.channel\s*\}\}\/cli/, 'release-npm should not promote deploy/<channel>/cli');
  assert.doesNotMatch(raw, /deploy\/\$\{\{\s*inputs\.channel\s*\}\}\/stack/, 'release-npm should not promote deploy/<channel>/stack');
});

test('publish-github-release delegates release creation + asset upload to the pipeline script', async () => {
  const raw = await loadWorkflow('publish-github-release.yml');
  assert.match(raw, /node scripts\/pipeline\/run\.mjs github-publish-release/);
  assert.doesNotMatch(raw, /gh release upload/, 'publish-github-release should not embed gh release upload logic');
  assert.doesNotMatch(raw, /gh api -X DELETE/, 'publish-github-release should not embed release asset pruning logic');
});

test('promote-ui native_submit uses the shared Expo submit script (handles preview credential gaps)', async () => {
  const promoteUi = await loadWorkflow('promote-ui.yml');
  assert.match(promoteUi, /uses:\s*\.\/\.github\/workflows\/build-ui-mobile-local\.yml/);
  assert.match(promoteUi, /action:\s*\$\{\{\s*inputs\.expo_action == 'native_submit' && 'build_and_submit' \|\| 'build_only'\s*\}\}/);

  const buildUiMobileLocal = await loadWorkflow('build-ui-mobile-local.yml');
  assert.match(buildUiMobileLocal, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(buildUiMobileLocal, /--action "\$\{\{\s*inputs\.action == 'build_and_submit' && 'native_submit' \|\| 'native'\s*\}\}"/);
  assert.doesNotMatch(buildUiMobileLocal, /node scripts\/pipeline\/run\.mjs expo-submit/);

  const run = await loadFile('scripts/pipeline/run.mjs');
  assert.match(run, /path\.join\(repoRoot,\s*'scripts',\s*'pipeline',\s*'expo',\s*'submit\.mjs'\)/);

  const script = await loadFile('scripts/pipeline/expo/submit.mjs');
  assert.match(script, /\['ios', 'android'\]/);
  assert.match(script, /for \(const platform of platforms\)/);
  assert.match(script, /allowsBestEffortSubmit\(environment\)/);
  assert.match(script, /::warning::Expo submit failed for/);
});

test('promote-ui prepares OTA bytes without secrets and publishes the exact bound artifacts with trusted control', async () => {
  const raw = await loadWorkflow('promote-ui.yml');
  const workflow = parse(raw);
  const validate = workflow?.jobs?.validate_candidate;
  const promote = workflow?.jobs?.promote;
  const validateText = JSON.stringify(validate);
  const promoteText = JSON.stringify(promote);

  assert.ok(validate, 'promote-ui must validate the exact candidate in a separate job');
  assert.equal(validate.environment, undefined, 'candidate OTA preparation must not receive release secrets');
  assert.doesNotMatch(validateText, /EXPO_TOKEN|RELEASE_BOT_PRIVATE_KEY/);
  assert.match(validateText, /--phase prepare/);
  assert.match(validateText, /--platform android/);
  assert.match(validateText, /--platform ios/);
  assert.match(validateText, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);

  assert.equal(promote?.environment, 'release-shared');
  assert.match(promoteText, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(promoteText, /--phase publish/);
  assert.match(promoteText, /--expected-source-sha/);
  assert.match(promoteText, /EXPO_TOKEN/);
  assert.doesNotMatch(promoteText, /ui-mobile-release/);
  for (const step of promote.steps ?? []) {
    assert.doesNotMatch(String(step?.run ?? ''), /\$\{\{\s*inputs\.expo_update_message\s*\}\}/);
  }

  const script = await loadFile('scripts/pipeline/expo/ota-update.mjs');
  assert.match(script, /eas-cli@\$\{easCliVersion\}/);
  assert.match(script, /resolveMobileAppEnvironmentConfig\(normalizedEnvironment\)\.updatesChannel/);
  assert.match(script, /--channel/);
  assert.match(script, /resolveExpoInteractivity/);
  assert.match(script, /--message/);
  assert.match(script, /--skip-bundler/);
  assert.match(script, /--input-dir/);
});

test('release workflow lets promote-ui derive exact-candidate Expo notes from the approved release ID', async () => {
  const raw = await loadWorkflow('release.yml');
  const workflow = parse(raw);
  assert.equal(workflow?.on?.workflow_dispatch?.inputs?.release_message, undefined, 'release.yml must not accept operator-authored release notes');
  assert.match(raw, /deploy_ui:[\s\S]*?uses:\s*\.\/\.github\/workflows\/promote-ui\.yml/);
  assert.doesNotMatch(raw, /deploy_ui:[\s\S]*?expo_update_message:/);
});

test('local release planning resolves remote identities without changing local refs', async () => {
  const run = await loadFile('scripts/pipeline/run.mjs');

  assert.match(run, /resolveRemoteReleasePlanningRefs\(\{/);
  assert.doesNotMatch(run, /'--prune'/);
  assert.doesNotMatch(run, /refs\/tags\/[^'"]+:[^'"]+/);
});
