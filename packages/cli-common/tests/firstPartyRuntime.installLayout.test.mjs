import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFirstPartyInstallLayout,
  resolveInstalledFirstPartyComponentPaths,
} from '../dist/firstPartyRuntime/index.js';

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function withPlatform(platform, fn) {
  Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
  const result = fn();
  if (result && typeof result.finally === 'function') {
    return result.finally(() => {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    });
  }
  Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  return result;
}

test('cli and daemon resolve to the same install root and current payload paths', () => {
  const env = {
    HOME: '/Users/tester',
    HAPPIER_HOME_DIR: '/Users/tester/.happier-custom',
  };

  const cliLayout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv: env });
  const daemonLayout = resolveFirstPartyInstallLayout({ componentId: 'happier-daemon', processEnv: env });

  assert.equal(cliLayout.installRoot, '/Users/tester/.happier-custom/cli');
  assert.equal(daemonLayout.installRoot, cliLayout.installRoot);
  assert.equal(cliLayout.currentPath, '/Users/tester/.happier-custom/cli/current');
  assert.equal(cliLayout.previousPath, '/Users/tester/.happier-custom/cli/previous');
});

test('installed component paths resolve binary, shim, and node entrypoint locations', () => {
  const env = {
    HOME: '/Users/tester',
    HAPPIER_HOME_DIR: '/Users/tester/.happier-custom',
  };

  const paths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-daemon',
    processEnv: env,
  });

  assert.equal(paths.binaryPath, '/Users/tester/.happier-custom/cli/current/happier');
  assert.equal(paths.nodeEntrypointPath, '/Users/tester/.happier-custom/cli/current/package-dist/index.mjs');
  assert.equal(paths.shimPaths[0], '/Users/tester/.happier-custom/bin/happier');
});

test('public release rings resolve to distinct install roots and public shims', () => {
  const env = {
    HOME: '/Users/tester',
    HAPPIER_HOME_DIR: '/Users/tester/.happier-custom',
  };

  const previewLayout = resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    processEnv: env,
    releaseRing: 'preview',
  });
  const publicdevLayout = resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    processEnv: env,
    releaseRing: 'publicdev',
  });
  const previewPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    processEnv: env,
    releaseRing: 'preview',
  });
  const publicdevPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-cli',
    processEnv: env,
    releaseRing: 'publicdev',
  });

  assert.equal(previewLayout.installRoot, '/Users/tester/.happier-custom/cli-preview');
  assert.equal(previewLayout.currentPath, '/Users/tester/.happier-custom/cli-preview/current');
  assert.equal(previewPaths.shimPaths[0], '/Users/tester/.happier-custom/bin/hprev');

  assert.equal(publicdevLayout.installRoot, '/Users/tester/.happier-custom/cli-dev');
  assert.equal(publicdevLayout.currentPath, '/Users/tester/.happier-custom/cli-dev/current');
  assert.equal(publicdevPaths.shimPaths[0], '/Users/tester/.happier-custom/bin/hdev');
});

test('publicdev install layout resolves a side-by-side cli root and shim', () => {
  const env = {
    HOME: '/Users/tester',
    HAPPIER_HOME_DIR: '/Users/tester/.happier-custom',
  };

  const cliLayout = resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    channel: 'publicdev',
    processEnv: env,
  });
  const daemonPaths = resolveInstalledFirstPartyComponentPaths({
    componentId: 'happier-daemon',
    channel: 'publicdev',
    processEnv: env,
  });

  assert.equal(cliLayout.installRoot, '/Users/tester/.happier-custom/cli-dev');
  assert.equal(cliLayout.currentPath, '/Users/tester/.happier-custom/cli-dev/current');
  assert.equal(daemonPaths.binaryPath, '/Users/tester/.happier-custom/cli-dev/current/happier');
  assert.equal(daemonPaths.nodeEntrypointPath, '/Users/tester/.happier-custom/cli-dev/current/package-dist/index.mjs');
  assert.equal(daemonPaths.shimPaths[0], '/Users/tester/.happier-custom/bin/hdev');
});

test('installed component paths use .exe suffixes for Windows binaries and shims', () => {
  withPlatform('win32', () => {
    const env = {
      HOME: 'C:\\Users\\tester',
      HAPPIER_HOME_DIR: 'C:\\Users\\tester\\.happier-custom',
    };

    const stablePaths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
    });
    const previewPaths = resolveInstalledFirstPartyComponentPaths({
      componentId: 'happier-cli',
      processEnv: env,
      releaseRing: 'preview',
    });

    assert.equal(stablePaths.binaryPath, 'C:\\Users\\tester\\.happier-custom\\cli\\current\\happier.exe');
    assert.equal(stablePaths.shimPaths[0], 'C:\\Users\\tester\\.happier-custom\\bin\\happier.exe');
    assert.equal(previewPaths.binaryPath, 'C:\\Users\\tester\\.happier-custom\\cli-preview\\current\\happier.exe');
    assert.equal(previewPaths.shimPaths[0], 'C:\\Users\\tester\\.happier-custom\\bin\\hprev.exe');
  });
});
