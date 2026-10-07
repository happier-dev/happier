import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { createTestTempDirectory } from '../../../scripts/testing/process/temporaryDirectories.mjs';

// Many CLI tests touch persistence under `HAPPIER_HOME_DIR`. Our `.env.integration-test`
// sets a shared value, which can cause cross-process races when Vitest runs with multiple
// workers. Provide a per-process default home directory instead; individual tests may
// still override `process.env.HAPPIER_HOME_DIR` and call `vi.resetModules()` as needed.
const defaultHome = createTestTempDirectory('happier-dev-test-');
const defaultHomeDir = defaultHome.root;
process.env.HAPPIER_HOME_DIR = defaultHomeDir;
afterAll(defaultHome.cleanup);

// CLI unit tests should be machine-agnostic: provider CLIs are not expected to be installed
// on CI runners. Provide a default OpenCode CLI stub unless a test explicitly overrides it.
const opencodePath = String(process.env.HAPPIER_OPENCODE_PATH ?? '').trim();
if (!opencodePath) {
  const bin = createTestTempDirectory('happier-dev-test-bin-');
  const binDir = bin.root;
  const stubPath = join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  if (process.platform === 'win32') {
    writeFileSync(stubPath, '@echo off\r\nexit /B 0\r\n', 'utf8');
  } else {
    writeFileSync(stubPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(stubPath, 0o755);
  }
  process.env.HAPPIER_OPENCODE_PATH = stubPath;
  afterAll(() => {
    if (process.env.HAPPIER_OPENCODE_PATH === stubPath) delete process.env.HAPPIER_OPENCODE_PATH;
    bin.cleanup();
  });
}

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';
