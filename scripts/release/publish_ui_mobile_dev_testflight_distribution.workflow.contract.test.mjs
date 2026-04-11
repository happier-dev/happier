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
  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_SUBMIT_BETA_REVIEW:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_SUBMIT_BETA_REVIEW\s*\}\}/);
  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_WAIT_PROCESSING:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_WAIT_PROCESSING\s*\}\}/);
  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_PROCESSING_TIMEOUT_SECONDS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_PROCESSING_TIMEOUT_SECONDS\s*\}\}/);
  assert.doesNotMatch(src, /node scripts\/pipeline\/run\.mjs expo-testflight-distribute/);
  assert.match(src, /--build-json "\/tmp\/eas_build\.ios\.json"/);
});
