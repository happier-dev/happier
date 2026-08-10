import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');
const reviewedSetupNodeUse = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';

test('workflows use Node 22 policy and do not pin Node 20', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.doesNotMatch(raw, /node-version:\s*20\b/, `${file} must not use node-version: 20`);
    assert.doesNotMatch(raw, /NODE_VERSION:\s*"20"/, `${file} must not use NODE_VERSION=20`);
    assert.doesNotMatch(raw, /node-version:\s*\[[^\]]*\b20\b[^\]]*\]/, `${file} must not include Node 20 in a matrix`);
  }
});

test('workflows that run pipeline scripts set up Node 22', async () => {
  const files = (await readdir(workflowsDir)).filter((name) => name.endsWith('.yml'));

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    if (!raw.includes('node scripts/pipeline/')) continue;
    assert.ok(
      raw.includes(reviewedSetupNodeUse),
      `${file} must include the reviewed actions/setup-node v4 action when running pipeline scripts`,
    );
    const hasDirect22 = /node-version:\s*22(\.x)?\b/.test(raw);
    const usesEnvNodeVersion = /node-version:\s*\$\{\{\s*env\.NODE_VERSION\s*\}\}/.test(raw) && /NODE_VERSION:\s*"?22\.x"?/.test(raw);
    assert.ok(hasDirect22 || usesEnvNodeVersion, `${file} must use node-version 22.x when running pipeline scripts`);
  }
});

test('release workflows pin Yarn via Corepack (avoid runner drift)', async () => {
  const expected = /corepack prepare yarn@1\.22\.22 --activate/;
  const files = [
    'release.yml',
    'release-npm.yml',
    'promote-ui.yml',
    'promote-server.yml',
    'promote-website.yml',
    'promote-docs.yml',
  ];

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.match(raw, expected, `${file} should pin Yarn via corepack prepare yarn@1.22.22`);
  }
});

test('nightly release workflows use the retrying Corepack Yarn owner', async () => {
  const actionUse = 'uses: ./.github/actions/enable-corepack-yarn';
  const files = [
    'publish-cli-binaries.yml',
    'publish-hstack-binaries.yml',
    'publish-server-runtime.yml',
    'publish-ui-web.yml',
    'publish-ui-mobile-dev.yml',
    'build-tauri.yml',
    'publish-docker.yml',
    'tests.yml',
  ];

  for (const file of files) {
    const raw = await readFile(join(workflowsDir, file), 'utf8');
    assert.ok(raw.includes(actionUse), `${file} should use the retrying Corepack Yarn action`);
    assert.doesNotMatch(raw, /corepack prepare yarn@1\.22\.22 --activate/, `${file} should not bypass the retry owner`);
  }

  const action = await readFile(join(repoRoot, '.github', 'actions', 'enable-corepack-yarn', 'action.yml'), 'utf8');
  assert.match(action, /bash scripts\/ci\/corepack-prepare-yarn-with-retry\.sh/);
});
