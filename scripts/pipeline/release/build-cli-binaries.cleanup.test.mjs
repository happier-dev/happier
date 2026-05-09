import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupTempDirBestEffort, resolveReleaseTempCleanupTimeoutMs } from './build-cli-binaries.mjs';

test('resolveReleaseTempCleanupTimeoutMs uses bounded default', () => {
  assert.equal(resolveReleaseTempCleanupTimeoutMs({}), 30_000);
  assert.equal(resolveReleaseTempCleanupTimeoutMs({ HAPPIER_RELEASE_TEMP_CLEANUP_TIMEOUT_MS: '1' }), 1_000);
  assert.equal(resolveReleaseTempCleanupTimeoutMs({ HAPPIER_RELEASE_TEMP_CLEANUP_TIMEOUT_MS: '999999' }), 300_000);
});

test('cleanupTempDirBestEffort resolves when cleanup stalls', async () => {
  let cleanupInvoked = false;
  const result = await cleanupTempDirBestEffort({
    tempDir: '/tmp/not-used',
    timeoutMs: 10,
    rmImpl: async () => {
      cleanupInvoked = true;
      await new Promise(() => {});
    },
    logger: { warn() {} },
  });

  assert.equal(cleanupInvoked, true);
  assert.equal(result.timedOut, true);
});

