import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { vi } from 'vitest';

import {
  removeTestProcessTempDirsOnExit,
  resolveTestProcessTempDir,
} from './testkit/fs/testProcessTempDirs';
import { createWindowsServiceLauncherPeFixture } from './testkit/fs/windowsServiceLauncherFixture';

// Many CLI tests touch persistence under `HAPPIER_HOME_DIR`. Our `.env.integration-test`
// sets a shared value, which can cause cross-process races when Vitest runs with multiple
// workers. Provide a per-process default home directory instead; individual tests may
// still override `process.env.HAPPIER_HOME_DIR` and call `vi.resetModules()` as needed.
const defaultHomeDir = resolveTestProcessTempDir('home');
const binDir = resolveTestProcessTempDir('bin');
process.env.HAPPIER_HOME_DIR = defaultHomeDir;
mkdirSync(defaultHomeDir, { recursive: true });
removeTestProcessTempDirsOnExit([defaultHomeDir, binDir]);

// CLI unit tests should be machine-agnostic: provider CLIs are not expected to be installed
// on CI runners. Provide a default OpenCode CLI stub unless a test explicitly overrides it.
const opencodePath = String(process.env.HAPPIER_OPENCODE_PATH ?? '').trim();
if (!opencodePath) {
  mkdirSync(binDir, { recursive: true });
  const stubPath = join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
  if (process.platform === 'win32') {
    writeFileSync(stubPath, '@echo off\r\nexit /B 0\r\n', 'utf8');
  } else {
    writeFileSync(stubPath, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(stubPath, 0o755);
  }
  process.env.HAPPIER_OPENCODE_PATH = stubPath;
}

// The packaged Windows service launcher is a release-built native asset that clean checkouts and
// non-Windows runners do not have. Locate it at a per-process minimal launcher PE instead; the
// real resolver and the native binary have their own cli-common and native harness tests.
const windowsServiceLauncherFixturePath = join(binDir, 'happier-service-launcher.exe');
mkdirSync(binDir, { recursive: true });
writeFileSync(windowsServiceLauncherFixturePath, createWindowsServiceLauncherPeFixture());
vi.mock('@/daemon/service/windowsServiceLauncher', async () => {
  const { resolveWindowsServiceLauncherInstallSpec } = await import('@happier-dev/cli-common/service');
  return {
    resolveDaemonWindowsServiceLauncherInstallSpec: () =>
      resolveWindowsServiceLauncherInstallSpec(windowsServiceLauncherFixturePath),
  };
});

// Status reads refresh the CLI update cache in the background (a detached `self check`, which
// reaches the network). Tests exercise that path through explicit params, never by spawning it.
if (!String(process.env.HAPPIER_CLI_UPDATE_CHECK ?? '').trim()) {
  process.env.HAPPIER_CLI_UPDATE_CHECK = '0';
}

// CLI tests should not inherit embedded build-policy gating (set in CI).
// Clear it by default so feature tests can opt-in explicitly per case.
process.env.HAPPIER_FEATURE_POLICY_ENV = '';
