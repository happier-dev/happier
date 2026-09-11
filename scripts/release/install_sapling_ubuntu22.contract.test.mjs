import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('Sapling download retries transient transport failures within bounded time', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/ci/install_sapling_ubuntu22.sh'), 'utf8');
  const curlCommand = source.match(/curl\s+[\s\S]*?"\$\{SAPLING_DOWNLOAD_URL\}"/)?.[0] ?? '';

  assert.match(curlCommand, /--retry\s+[1-9][0-9]*/);
  assert.match(curlCommand, /--retry-delay\s+[1-9][0-9]*/);
  assert.match(curlCommand, /--retry-max-time\s+[1-9][0-9]*/);
  assert.match(curlCommand, /--connect-timeout\s+[1-9][0-9]*/);
  assert.match(curlCommand, /--max-time\s+[1-9][0-9]*/);
  assert.doesNotMatch(curlCommand, /--retry-all-errors/, 'permanent HTTP failures should not be retried');
});
