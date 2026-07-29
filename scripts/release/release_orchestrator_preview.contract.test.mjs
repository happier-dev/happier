import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function loadWorkflow(name) {
  return readFile(join(repoRoot, '.github', 'workflows', name), 'utf8');
}

async function loadFile(rel) {
  return readFile(join(repoRoot, rel), 'utf8');
}

test('release workflow only promotes/bumps on production and routes source_ref by environment', async () => {
  const raw = await loadWorkflow('release.yml');

  // If CI gate fails, checks is skipped; downstream must not treat that as OK to promote/deploy.
  assert.doesNotMatch(
    raw,
    /needs\.plan\.result == 'success' \|\| needs\.plan\.result == 'skipped'/,
    'release orchestrator must not treat skipped checks as eligible for promotion/deploy',
  );

  // promote_main must not be skipped when bump_versions_dev is skipped (GitHub skips dependent jobs by default).
  assert.match(
    raw,
    /promote_main:[\s\S]*?if:\s*always\(\)\s*&&[\s\S]*?inputs\.dry_run != true && inputs\.environment == 'production'[\s\S]*?needs\.plan\.result == 'success'[\s\S]*?\(needs\.bump_versions_dev\.result == 'success' \|\| needs\.bump_versions_dev\.result == 'skipped'\)/,
  );
  assert.match(raw, /bump_versions_dev:[\s\S]*?if:\s*inputs\.dry_run != true && needs\.plan\.outputs\.should_bump == 'true'/);
  assert.match(raw, /if \[ "\$env_name" = "preview" \]; then[\s\S]*?if \[ "\$confirm" != "release dev to preview" \]; then/);
  assert.doesNotMatch(raw, /\[ "\$confirm" != "release dev to preview" \] && \[ "\$confirm" != "release dev to main" \]/);

  assert.match(raw, /source_ref:\s*\$\{\{ inputs\.environment == 'production' && 'main' \|\| 'preview' \}\}/);
  assert.match(raw, /publish_npm:[\s\S]*?source_ref:\s*\$\{\{ inputs\.environment == 'production' && 'main' \|\| 'preview' \}\}/);
  assert.match(raw, /deploy_ui:[\s\S]*?bump:\s*none/);
  assert.match(
    raw,
    /sync_dev:[\s\S]*?if:\s*\$\{\{\s*inputs\.dry_run != true && inputs\.environment == 'production'/,
  );
  assert.match(
    raw,
    /Compute versioned component changes \(latest release tags\.\.release head\)[\s\S]*?node scripts\/pipeline\/run\.mjs release-compute-versioned-component-changes/,
  );
  assert.match(raw, /VERSIONED_APP_CHANGED:\s*\$\{\{\s*steps\.versioned_plan\.outputs\.changed_app\s*\}\}/);
  assert.match(raw, /VERSIONED_CLI_CHANGED:\s*\$\{\{\s*steps\.versioned_plan\.outputs\.changed_cli\s*\}\}/);
});

test('unified release records qualified V4 activation admission before branch promotion', async () => {
  const raw = await loadWorkflow('release.yml');
  const admission = raw.indexOf('qualified-connected-accounts-v4-activation-admission.mjs');
  const previewPromotion = raw.indexOf('\n  promote_preview:');
  const productionPromotion = raw.indexOf('\n  promote_main:');

  assert.ok(admission >= 0, 'release planning must run the qualified V4 activation admission check');
  assert.ok(previewPromotion > admission, 'activation admission must precede preview branch promotion');
  assert.ok(productionPromotion > admission, 'activation admission must precede production branch promotion');
  assert.match(raw, /qualified_v4_activation_approval:\s*true/);
  assert.match(raw, /backup\/restore readiness/i);
  assert.match(raw, /old-server or old-daemon rollback/i);
  assert.match(raw, /old API and worker writers are stopped/i);
  assert.match(raw, /remain stopped if migration fails/i);
});

test('release workflow excludes stack npm from full-release signoff', async () => {
  const raw = await loadWorkflow('release.yml');

  assert.doesNotMatch(
    raw,
    /publish_npm:[\s\S]*?publish_stack:/,
    'release workflow should not treat stack publishing as a required npm signoff input',
  );
  assert.doesNotMatch(
    raw,
    /publish_npm:[\s\S]*?needs\.plan\.outputs\.publish_stack/,
    'release workflow should not depend on stack publication when deciding npm publish eligibility',
  );
});

test('release workflow plans preview-to-main promotions from preview instead of dev', async () => {
  const raw = await loadWorkflow('release.yml');

  assert.match(
    raw,
    /- name: Resolve release planning refs[\s\S]*?if \[ "\$ENVIRONMENT" = "production" \] && \{ \[ "\$CONFIRM" = "release preview to main" \] \|\| \[ "\$CONFIRM" = "reset main from preview" \]; \}; then[\s\S]*?source_ref="preview"/,
    'release planning should switch its source ref to preview for preview-to-main promotions',
  );
  assert.match(
    raw,
    /- name: Checkout release planning source[\s\S]*?ref:\s*\$\{\{\s*steps\.plan_refs\.outputs\.source_ref\s*\}\}/,
    'release planning should checkout the resolved source branch instead of always using dev',
  );
  assert.match(
    raw,
    /commits to release \(\$\{\{\s*steps\.plan_refs\.outputs\.compare_label\s*\}\}\)/,
    'release plan summary should describe the actual compared branch range',
  );
  assert.match(
    raw,
    /### Changed components \(\$\{\{\s*steps\.plan_refs\.outputs\.compare_label\s*\}\}\)/,
    'changed component summary should describe the actual compared branch range',
  );
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
    /publish_server_runtime:[\s\S]*?source_ref:\s*\$\{\{\s*inputs\.environment == 'production' && 'main' \|\| 'preview'\s*\}\}/,
    'server runtime publishing should build from main for production and preview for preview releases',
  );
  assert.match(
    raw,
    /publish_server_runtime:[\s\S]*?allow_stable:\s*\$\{\{\s*inputs\.environment == 'production'\s*\}\}/,
    'server runtime publishing should explicitly unlock stable publishing only for production releases',
  );
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'stable' \|\| 'preview'\s*\}\}/,
    'UI web publishing should share the same stable vs preview channel mapping',
  );
  assert.match(
    raw,
    /publish_docker:[\s\S]*?channel:\s*\$\{\{\s*inputs\.environment == 'production' && 'stable' \|\| 'preview'\s*\}\}/,
    'Docker publishing should share the same stable vs preview channel mapping',
  );

  assert.match(
    raw,
    /deploy_server:[\s\S]*?publish_runtime_release:\s*false/,
    'SaaS server deploy must not implicitly publish rolling server runtime releases',
  );
});

test('release workflow can publish self-host UI web bundle via a dedicated workflow', async () => {
  const raw = await loadWorkflow('release.yml');
  assert.match(
    raw,
    /publish_ui_web:[\s\S]*?uses:\s*\.\/\.github\/workflows\/publish-ui-web\.yml/,
    'self-host UI web bundle publishing should be handled by a dedicated workflow',
  );
});

test('release workflow delegates deploy plan computation to pipeline script', async () => {
  const raw = await loadWorkflow('release.yml');

  assert.match(
    raw,
    /- name: Compute deploy plan[\s\S]*?node scripts\/pipeline\/run\.mjs release-compute-deploy-plan/,
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

  assert.match(raw, /node scripts\/pipeline\/run\.mjs npm-publish/, 'release-npm should delegate npm publishing to the pipeline command');
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
  assert.match(
    raw,
    /- name: Install minisign \(signing \+ verification\)[\s\S]*?uses:\s*\.\/\.github\/actions\/bootstrap-minisign/,
    'release-npm should bootstrap minisign via the pinned action instead of apt repositories',
  );
  assert.doesNotMatch(
    raw,
    /- name: Install minisign \(signing \+ verification\)[\s\S]*?apt-get install -y minisign/,
    'release-npm should not rely on apt minisign availability',
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
  assert.match(raw, /yarn --cwd [^\n]*steps\.server_runner\.outputs\.dir[^\n]* test/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs npm-release[\s\S]*?--server-runner-dir "\$\{SERVER_RUNNER_DIR\}"/);

  const script = await loadFile('scripts/pipeline/npm/set-preview-versions.mjs');
  assert.match(script, /resolveRollingPublishVersion/);
  assert.doesNotMatch(script, /GITHUB_RUN_NUMBER/);
});

test('stack version bumps use shared bump-version script across release workflows', async () => {
  const orchestrator = await loadWorkflow('release.yml');
  const releaseNpm = await loadWorkflow('release-npm.yml');

  assert.match(orchestrator, /node scripts\/pipeline\/run\.mjs release-bump-versions-dev/);
  assert.match(orchestrator, /--bump-stack "\$\{\{ needs\.plan\.outputs\.bump_stack \}\}"/);
  assert.doesNotMatch(orchestrator, /node scripts\/release\/bump-version\.mjs --component stack/, 'release.yml should delegate version bumps to the pipeline script');
  assert.doesNotMatch(orchestrator, /BUMP="\$\{\{ needs\.plan\.outputs\.bump_stack \}\}" node - <<'NODE'/);

  // Version bumps are centralized in the release orchestrator (dev commit),
  // so release-npm must not bump versions on main for production.
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

test('promote-ui preview OTA updates are non-interactive and provide an update message', async () => {
  const raw = await loadWorkflow('promote-ui.yml');
  assert.match(raw, /- name: Expo OTA update/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(raw, /--action "\$\{\{ inputs\.expo_action \}\}"/);
  assert.match(raw, /--platform all/);

  const script = await loadFile('scripts/pipeline/expo/ota-update.mjs');
  assert.match(script, /eas-cli@\$\{easCliVersion\}/);
  assert.match(script, /resolveMobileAppEnvironmentConfig\(normalizedEnvironment\)\.updatesChannel/);
  assert.match(script, /--channel/);
  assert.match(script, /resolveExpoInteractivity/);
  assert.match(script, /--message/);
});

test('release workflow can pass a top-level release message down to promote-ui for Expo updates', async () => {
  const raw = await loadWorkflow('release.yml');
  assert.match(raw, /release_message:/, 'release.yml should expose a release_message input');
  assert.match(raw, /deploy_ui:[\s\S]*?uses:\s*\.\/\.github\/workflows\/promote-ui\.yml/);
  assert.match(raw, /expo_update_message:\s*\$\{\{\s*inputs\.release_message\s*\}\}/);
});

test('local release planning delegates remote identity resolution without mutating refs', async () => {
  const run = await loadFile('scripts/pipeline/run.mjs');

  assert.match(
    run,
    /import \{ resolveRemoteReleasePlanningRefs \} from '\.\/release\/lib\/release-planning-remote-refs\.mjs'/,
    'release planning must use the canonical remote-ref resolver',
  );
  assert.match(run, /resolveRemoteReleasePlanningRefs\(\{/);
  assert.doesNotMatch(
    run,
    /execFileSync\(\s*'git',\s*\[\s*'fetch'[\s\S]*?--prune/,
    'release planning must not restore the old ref-pruning fetch path',
  );
});
