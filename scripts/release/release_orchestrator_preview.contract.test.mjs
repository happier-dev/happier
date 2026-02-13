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
  assert.match(raw, /if \[ "\$env_name" = "preview" \]; then[\s\S]*?if \[ "\$confirm" != "release preview from dev" \]; then/);
  assert.doesNotMatch(raw, /\[ "\$confirm" != "release preview from dev" \] && \[ "\$confirm" != "release dev to main" \]/);

  assert.match(raw, /source_ref:\s*\$\{\{ inputs\.environment == 'production' && 'main' \|\| 'dev' \}\}/);
  assert.match(raw, /publish_npm:[\s\S]*?source_ref:\s*\$\{\{ inputs\.environment == 'production' && 'main' \|\| 'dev' \}\}/);
  assert.match(raw, /deploy_ui:[\s\S]*?bump:\s*none/);
  assert.match(raw, /sync_dev:[\s\S]*?if:\s*inputs\.dry_run != true && inputs\.environment == 'production'/);
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

  assert.match(raw, /if \[ "\$src" = "auto" \]; then[\s\S]*?if \[ "\$channel" = "preview" \]; then[\s\S]*?src="dev"[\s\S]*?src="main"/);
  assert.match(raw, /ref:\s*\$\{\{ steps\.resolve_source\.outputs\.ref \}\}/);
});

test('release-npm is compatible with npm trusted publishing (OIDC)', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.match(raw, /npm install --global npm@11/);
  assert.doesNotMatch(raw, /NPM_TOKEN is required for npm publish\./);
});

test('release-npm derives unique preview prerelease versions from base versions', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.doesNotMatch(raw, /version_bump_cli/);
  assert.doesNotMatch(raw, /version_bump_stack/);
  assert.doesNotMatch(raw, /function bumpBase\(base, bump\)/);
  assert.match(raw, /function setPreviewVersion\(pkgPath\)/);
  assert.match(raw, /\$\{base\}-preview\.\$\{run\}\.\$\{attempt\}/);
  assert.match(raw, /publish_server/, 'release-npm should expose publish_server for server runner publishing');
  assert.match(raw, /PUBLISH_SERVER/, 'release-npm preview versioning should gate server runner via env');

  // Server runner package is canonicalized under packages/relay-server.
  assert.doesNotMatch(raw, /packages\/server\//, 'release-npm must not reference removed packages/server');
  assert.match(raw, /dir="packages\/relay-server"/);
  assert.match(raw, /SERVER_RUNNER_DIR:\s*\$\{\{ steps\.server_runner\.outputs\.dir \}\}/);
  assert.match(raw, /versions\.server = setPreviewVersion\(join\(runnerDir,\s*'package\.json'\)\);/);
  assert.match(raw, /yarn --cwd [^\n]*steps\.server_runner\.outputs\.dir[^\n]* test/);
  assert.match(raw, /cd "\$\{SERVER_RUNNER_DIR\}"/);
});

test('stack version bumps use shared bump-version script across release workflows', async () => {
  const orchestrator = await loadWorkflow('release.yml');
  const releaseNpm = await loadWorkflow('release-npm.yml');

  assert.match(orchestrator, /node scripts\/release\/bump-version\.mjs --component stack --bump "\$\{\{ needs\.plan\.outputs\.bump_stack \}\}"/);
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

test('publish-github-release skips asset upload when rolling tag move is blocked', async () => {
  const raw = await loadWorkflow('publish-github-release.yml');
  assert.match(
    raw,
    /- name: Upload assets[\s\S]*?if:\s*\$\{\{\s*\(!inputs\.rolling_tag \|\| steps\.move_rolling_tag\.outputs\.pushed == 'true'\)\s*&&\s*\(inputs\.assets != '' \|\| inputs\.assets_dir != ''\)\s*\}\}/,
    'asset upload must be gated by rolling tag success when using rolling releases',
  );
});
