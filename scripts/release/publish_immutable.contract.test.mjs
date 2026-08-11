import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const cases = [
  { name: 'cli', script: resolve(repoRoot, 'scripts/pipeline/release/publishing/publish-binary-release.mjs'), args: ['--product', 'cli'], immutableTag: /publish-release\.mjs --tag cli-v/u },
  { name: 'hstack', script: resolve(repoRoot, 'scripts/pipeline/release/publish-hstack-binaries.mjs'), args: [], immutableTag: /publish-release\.mjs --tag stack-v/u },
  { name: 'server', script: resolve(repoRoot, 'scripts/pipeline/release/publishing/publish-binary-release.mjs'), args: ['--product', 'server'], immutableTag: /publish-release\.mjs --tag server-v/u },
  { name: 'ui-web', script: resolve(repoRoot, 'scripts/pipeline/release/publish-ui-web.mjs'), args: [], immutableTag: /publish-release\.mjs --tag ui-web-v/u },
];

for (const entry of cases) {
  test(`${entry.name} can publish an immutable candidate without moving a rolling release`, () => {
    const output = execFileSync(process.execPath, [
      entry.script,
      ...entry.args,
      '--channel', 'dev',
      '--allow-stable', 'false',
      '--phase', 'publish-immutable',
      '--run-contracts', 'false',
      '--check-installers', 'false',
      '--dry-run',
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GH_TOKEN: '',
        GH_REPO: '',
        GITHUB_REPOSITORY: '',
        HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });

    assert.match(output, entry.immutableTag);
    assert.doesNotMatch(output, /promote-rolling-release\.mjs/u);
  });
}

test('release verification delegates immutable tag resolution to trusted control code', async () => {
  const [raw, ownerRaw] = await Promise.all([
    readFile(join(repoRoot, '.github', 'workflows', 'release-verify.yml'), 'utf8'),
    readFile(join(repoRoot, '.github', 'actions', 'verify-immutable-release-candidate', 'action.yml'), 'utf8'),
  ]);
  assert.match(raw, /\.release-control\/\.github\/actions\/verify-immutable-release-candidate/);
  assert.match(ownerRaw, /\$control_dir\/scripts\/pipeline\/release\/verify-release-candidate-identity\.mjs/);
  assert.doesNotMatch(raw, /resolve_tag_commit\(\)/);
  assert.doesNotMatch(raw, /verify_tag\(\)/);
  assert.doesNotMatch(ownerRaw, /resolve_tag_commit\(\)/);
  assert.doesNotMatch(ownerRaw, /verify_tag\(\)/);
});
