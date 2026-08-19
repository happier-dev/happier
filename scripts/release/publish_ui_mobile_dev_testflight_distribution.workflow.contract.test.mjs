import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('publish-ui-mobile-dev keeps TestFlight external distribution logic inside the shared pipeline', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-ui-mobile-dev.yml'), 'utf8');

  assert.match(src, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(src, /--action native_submit/);
  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS\s*\}\}/);
  assert.doesNotMatch(src, /node scripts\/pipeline\/run\.mjs expo-testflight-distribute/);
  assert.match(src, /--build-json "\/tmp\/eas_build\.ios\.json"/);
  assert.equal(src.match(/--preflight-only/g)?.length, 2);

  const iosCloud = src.slice(src.indexOf('  ios_cloud:'), src.indexOf('  ios_local:'));
  const iosLocal = src.slice(src.indexOf('  ios_local:'));
  for (const job of [iosCloud, iosLocal]) {
    assert.match(job, /name: Checkout trusted TestFlight preflight control bytes/);
    assert.match(job, /repository: \$\{\{ job\.workflow_repository \}\}/);
    assert.match(job, /ref: \$\{\{ job\.workflow_sha \}\}/);
    assert.match(job, /path: \.testflight-preflight-control/);
    assert.match(job, /working-directory: \.testflight-preflight-control/);
  }
});
