import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

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

  // Final release promotion consumes the exact already-materialized source; it never creates a later bump commit.
  assert.match(
    raw,
    /promote_main:[\s\S]*?if:\s*always\(\)\s*&&[\s\S]*?inputs\.dry_run != true && inputs\.environment == 'production'[\s\S]*?needs\.plan\.result == 'success'/,
  );
  assert.doesNotMatch(raw, /^  bump_versions_dev:/m);
  assert.doesNotMatch(raw, /needs\.bump_versions_dev/);
  assert.match(raw, /node scripts\/pipeline\/release\/validate-release-dispatch\.mjs/);
  assert.match(raw, /CONFIRM:\s*\$\{\{ inputs\.confirm \}\}/);
  assert.match(raw, /ENVIRONMENT:\s*\$\{\{ inputs\.environment \}\}/);

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
  assert.match(raw, /qualified_v4_activation_approval:\s*\n\s*description: "Qualified V4 activation — explicit irreversible-migration approval only:/);
  assert.match(raw, /QUALIFIED_V4_ACTIVATION_APPROVAL:\s*\$\{\{ inputs\.qualified_v4_activation_approval \}\}/);
  assert.match(raw, /--approval-kind explicit-checkbox/);
  assert.doesNotMatch(raw, /--approval-kind release-confirm/);
  assert.match(raw, /qualified_v4_activation_approval:\s*\$\{\{ inputs\.qualified_v4_activation_approval \}\}/);
  assert.match(raw, /backup\/restore readiness/i);
  assert.match(raw, /old-server or old-daemon rollback/i);
  assert.match(raw, /old API and worker writers are stopped/i);
  assert.match(raw, /remain stopped if migration fails/i);
  assert.doesNotMatch(
    raw,
    /Confirm — Choose the exact action\. If the plan reports Qualified V4 activation/,
    'generic branch-promotion confirmation must not authorize an irreversible migration',
  );
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
  assert.match(String(publisher?.with?.source_ref ?? ''), /needs\.prepare_release_candidate\.outputs\.source_sha/);
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
  assert.match(verifierRaw, /VERIFY_STACK_RELEASE:\s*\$\{\{ inputs\.verify_stack_release \}\}/);
  assert.match(verifierRaw, /--verify-stack-release "\$VERIFY_STACK_RELEASE"/);
});

test('release workflow plans preview-to-main promotions from preview instead of dev', async () => {
  const raw = await loadWorkflow('release.yml');
  const workflow = parse(raw);
  const ci = workflow.jobs.ci;
  const validation = ci.steps.find((step) => step.id === 'dispatch');
  const plan = workflow.jobs.plan;
  const planningCheckout = plan.steps.find((step) => step.name === 'Checkout authorized release planning source');

  assert.match(validation.run, /validate-release-dispatch\.mjs/);
  assert.equal(validation.env.CONFIRM, '${{ inputs.confirm }}');
  assert.equal(validation.env.ENVIRONMENT, '${{ inputs.environment }}');
  assert.equal(ci.outputs.source_ref, '${{ steps.dispatch.outputs.source_ref }}');
  assert.equal(planningCheckout.with.ref, '${{ inputs.authorized_promotion_source_sha || needs.ci.outputs.source_ref }}');
  assert.match(raw, /COMPARE_LABEL:\s*\$\{\{\s*needs\.ci\.outputs\.compare_label\s*\}\}/);
  assert.match(raw, /commits to release \(\$COMPARE_LABEL\)/, 'release plan summary should describe the actual compared branch range');
  assert.match(
    raw,
    /### Changed components \(\$COMPARE_LABEL\)/,
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

test('release workflow computes deploy selection from the final candidate, with a dry-run planning-SHA fallback when preparation is skipped', async () => {
  const raw = await loadWorkflow('release.yml');
  const workflow = parse(raw);
  const plan = workflow.jobs.plan;
  const deployPlan = workflow.jobs.deploy_plan;
  const checkout = deployPlan.steps.find((step) => step.name === 'Checkout release source as inert data');
  const compute = deployPlan.steps.find((step) => step.id === 'plan');
  const planningSource = plan.steps.find((step) => step.id === 'planning_source');
  const candidateOrPlanningSha = '${{ inputs.dry_run == true && needs.plan.outputs.source_sha || needs.prepare_release_candidate.outputs.source_sha }}';

  assert.ok(deployPlan.needs.includes('release_notes_admission'));
  assert.ok(deployPlan.needs.includes('prepare_release_candidate'));
  assert.match(String(deployPlan.if), /inputs\.dry_run == true && needs\.prepare_release_candidate\.result == 'skipped'/);
  assert.match(String(deployPlan.if), /inputs\.dry_run != true && needs\.prepare_release_candidate\.result == 'success'/);
  assert.equal(plan.outputs.source_sha, '${{ steps.planning_source.outputs.source_sha }}');
  assert.match(planningSource.run, /git rev-parse HEAD/);
  assert.equal(checkout.with.ref, candidateOrPlanningSha);
  assert.equal(compute.env.SOURCE_REF, candidateOrPlanningSha);
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

test('release-npm resolves channel metadata and prefers an authorized candidate SHA at checkout', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?source_ref:/);
  assert.match(raw, /workflow_call:[\s\S]*?inputs:[\s\S]*?source_ref:/);
  assert.match(raw, /workflow_dispatch:[\s\S]*?inputs:[\s\S]*?authorized_sha:/);
  assert.match(raw, /workflow_call:[\s\S]*?inputs:[\s\S]*?authorized_sha:/);

  assert.match(raw, /node scripts\/pipeline\/release\/resolve-npm-release-inputs\.mjs/);
  assert.match(raw, /ref:\s*\$\{\{ inputs\.authorized_sha != '' && inputs\.authorized_sha \|\| steps\.release_inputs\.outputs\.source_ref \}\}/);
  assert.match(raw, /test "\$\(git rev-parse HEAD\)" = "\$AUTHORIZED_SHA"/);
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
  assert.match(raw, /node scripts\/pipeline\/npm\/resolve-release-metadata\.mjs/);
  assert.doesNotMatch(raw, /node scripts\/pipeline\/run\.mjs npm-set-preview-versions/);
  assert.doesNotMatch(raw, /function setPreviewVersion\(pkgPath\)/);
  assert.doesNotMatch(raw, /\$\{base\}-preview\.\$\{run\}\.\$\{attempt\}/);
  assert.match(raw, /publish_server/, 'release-npm should expose publish_server for server runner publishing');

  // Server runner package is canonicalized under packages/relay-server.
  assert.doesNotMatch(raw, /packages\/server\//, 'release-npm must not reference removed packages/server');
  assert.match(raw, /dir="packages\/relay-server"/);
  assert.match(raw, /SERVER_RUNNER_DIR:\s*\$\{\{ steps\.server_runner\.outputs\.dir \}\}/);
  assert.match(raw, /SERVER_RUNNER_DIR:\s*\$\{\{ steps\.server_runner\.outputs\.dir \}\}[\s\S]*?yarn --cwd "\$\{SERVER_RUNNER_DIR\}" test/);
  assert.match(raw, /node scripts\/pipeline\/run\.mjs npm-release[\s\S]*?--server-runner-dir "\$\{SERVER_RUNNER_DIR\}"/);

  const script = await loadFile('scripts/pipeline/npm/resolve-release-metadata.mjs');
  assert.match(script, /npm-set-preview-versions/);
  const allocator = await loadFile('scripts/pipeline/npm/set-preview-versions.mjs');
  assert.match(allocator, /resolveRollingPublishVersion/);
  assert.doesNotMatch(allocator, /GITHUB_RUN_NUMBER/, 'workflow metadata must delegate allocation to the canonical allocator');
});

test('final release workflow does not mutate component versions after candidate approval', async () => {
  const orchestrator = await loadWorkflow('release.yml');
  const releaseNpm = await loadWorkflow('release-npm.yml');

  assert.doesNotMatch(orchestrator, /bump-versions-dev\.mjs/);
  assert.doesNotMatch(orchestrator, /BUMP_STACK:\s*\$\{\{ needs\.plan\.outputs\.bump_stack \}\}/);
  assert.doesNotMatch(orchestrator, /--bump-stack "\$BUMP_STACK"/);
  assert.doesNotMatch(orchestrator, /node scripts\/release\/bump-version\.mjs --component stack/, 'release.yml must not create a later Stack version commit');
  assert.doesNotMatch(orchestrator, /BUMP="\$\{\{ needs\.plan\.outputs\.bump_stack \}\}" node - <<'NODE'/);

  // Versions are materialized before final preparation, so publication must not mutate them either.
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

test('release workflow derives Expo updates from the exact-candidate approved notes projection', async () => {
  const raw = await loadWorkflow('release.yml');
  assert.doesNotMatch(raw, /inputs\.release_message/);
  assert.match(
    raw,
    /prepare_release_candidate:[\s\S]*?release_notes_expo_message:\s*\$\{\{\s*steps\.release_notes\.outputs\.expo_message\s*\}\}/,
  );
  assert.match(raw, /project-release-notes\.mjs/);
  assert.match(raw, /deploy_ui:[\s\S]*?uses:\s*\.\/\.github\/workflows\/promote-ui\.yml/);
  assert.doesNotMatch(raw, /deploy_ui:[\s\S]*?expo_update_message:/, 'the UI promoter derives OTA copy from the exact approved release-notes ID');
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
