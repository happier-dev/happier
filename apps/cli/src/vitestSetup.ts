import './configureZodLocale';
import './vitestHomeGuard';
import { writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, vi } from 'vitest';
import { createTestTempDirectory } from '../../../scripts/testing/process/temporaryDirectories.mjs';

// The first setup file establishes the disposable Home before this import graph.

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

// Clean non-Windows checkouts lack this release-built native asset. Supply only that missing
// package-owned file at the filesystem boundary; actual runtime roots and staged files remain real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createWindowsServiceLauncherPeFixture } = await import('../../../scripts/testing/windowsServiceLauncherPeFixture.mjs');
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = args[0];
      if (typeof path === 'string' && path.replaceAll('\\', '/').endsWith('/native/windows/bin/windows-x64/happier-service-launcher.exe')
        && !actual.existsSync(path)) {
        const bytes = createWindowsServiceLauncherPeFixture();
        const option = args[1];
        const encoding = typeof option === 'string' ? option : option?.encoding;
        return encoding ? bytes.toString(encoding) : bytes;
      }
      return actual.readFileSync(...args);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { existsSync } = await import('node:fs');
  const { createWindowsServiceLauncherPeFixture } = await import('../../../scripts/testing/windowsServiceLauncherPeFixture.mjs');
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = args[0];
      if (typeof path === 'string' && path.replaceAll('\\', '/').endsWith('/native/windows/bin/windows-x64/happier-service-launcher.exe')
        && !existsSync(path)) {
        const bytes = createWindowsServiceLauncherPeFixture();
        const option = args[1];
        const encoding = typeof option === 'string' ? option : option?.encoding;
        return encoding ? bytes.toString(encoding) : bytes;
      }
      return actual.readFile(...args);
    },
  };
});

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';

// The Home guard must inspect real configuration before test mocks exist.
// Release its product import graph so each file's hoisted OS boundary mocks
// apply when that file imports configuration and its dependent adapters.
vi.resetModules();
