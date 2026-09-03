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

test('release-npm leaves signed CLI binary assets to the dedicated binary publisher', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.doesNotMatch(
    raw,
    /release-prepare-binary-assets|MINISIGN_|bootstrap-minisign/,
    'npm package preparation must not sign or prepare the separately published CLI binary release',
  );
  assert.match(raw, /trusted-control\/scripts\/pipeline\/npm\/release-packages\.mjs[\s\S]*?--mode pack/);
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-build-cli-binaries/,
    'release-npm should not own CLI build orchestration directly',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-publish-manifests/,
    'release-npm should not own manifest generation directly',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-validate[\s\S]*?--suite artifact-verify/,
    'release-npm should not own a separate artifact verification step once asset preparation owns it',
  );
  assert.doesNotMatch(
    raw,
    /test -f "dist\/release-assets\/cli\/checksums-happier-v\$\{version\}\.txt"/,
    'release-npm should not keep CLI artifact preflight business logic in YAML',
  );
  assert.doesNotMatch(
    raw,
    /test -f "dist\/release-assets\/stack\/checksums-hstack-v\$\{version\}\.txt"/,
    'release-npm should not keep stack artifact preflight business logic in YAML',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-verify-artifacts/,
    'release-npm should not bypass release-validate for artifact verification',
  );
});

test('release-npm keeps hstack out of release-signoff binary artifact paths', async () => {
  const raw = await loadWorkflow('release-npm.yml');

  assert.doesNotMatch(raw, /release-build-hstack-binaries/, 'release-npm should not build hstack release binaries');
  assert.doesNotMatch(raw, /--product[ =]hstack/, 'release-npm should not generate or verify hstack release manifests');
  assert.doesNotMatch(raw, /mirror-stack-/, 'release-npm should not mirror hstack GitHub releases as a release product');
});

test('promote-server runtime publishing uses the shared server binary publisher', async () => {
  const raw = await loadWorkflow('promote-server.yml');

  assert.match(
    raw,
    /publish_runtime_release:[\s\S]*?uses:\s*\.\/\.github\/workflows\/publish-server-runtime\.yml[\s\S]*?source_ref:\s*\$\{\{\s*needs\.finalize_source\.outputs\.authorized_sha\s*\}\}[\s\S]*?authorized_sha:\s*\$\{\{\s*needs\.finalize_source\.outputs\.authorized_sha\s*\}\}/,
    'promote-server should propagate the exact finalized SHA through the reusable server-runtime publisher boundary',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-build-server-binaries/,
    'promote-server should not own server runtime build orchestration directly',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-publish-manifests/,
    'promote-server should not own server manifest generation directly',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-validate[\s\S]*?--suite artifact-verify/,
    'promote-server should not own a separate artifact verification step once the shared publisher owns it',
  );
  assert.doesNotMatch(
    raw,
    /test -f "dist\/release-assets\/server\/checksums-happier-server-v\$\{version\}\.txt"/,
    'promote-server should not keep server artifact preflight business logic in YAML',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs release-verify-artifacts/,
    'promote-server should not bypass release-validate for artifact verification',
  );
  assert.doesNotMatch(
    raw,
    /node scripts\/pipeline\/run\.mjs github-publish-release/,
    'promote-server should not inline rolling/versioned GitHub release publishing',
  );
});
