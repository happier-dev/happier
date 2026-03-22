import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveFirstPartyInstallLayout,
  resolveInstalledFirstPartyComponentPaths,
} from '../dist/firstPartyRuntime/index.js';

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
