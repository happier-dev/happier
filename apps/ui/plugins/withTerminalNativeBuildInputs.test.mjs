import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const withTerminalNativeBuildInputs = require('./withTerminalNativeBuildInputs.js');

test('terminal-native prebuild registers one package-owned build-input materializer for both native platforms', async () => {
  const dangerousMods = new Map();
  const materializations = [];
  const config = { plugins: [] };

  const result = withTerminalNativeBuildInputs(config, {
    withDangerousMod(modConfig, [platform, action]) {
      dangerousMods.set(platform, action);
      return modConfig;
    },
    materialize: async (input) => {
      materializations.push(input);
    },
  });

  assert.equal(result, config);
  assert.deepEqual([...dangerousMods.keys()].sort(), ['android', 'ios']);

  const introspectionConfig = {
    modRequest: {
      projectRoot: '/workspace/apps/ui',
      introspect: true,
    },
  };
  assert.equal(await dangerousMods.get('ios')(introspectionConfig), introspectionConfig);
  assert.deepEqual(materializations, [], 'Expo config introspection/source paths must not materialize native inputs.');

  const androidConfig = {
    modRequest: {
      projectRoot: '/workspace/apps/ui',
      introspect: false,
    },
  };
  assert.equal(await dangerousMods.get('android')(androidConfig), androidConfig);
  assert.deepEqual(materializations, [{
    platform: 'android',
    projectRoot: '/workspace/apps/ui',
  }]);
});

test('terminal-native prebuild resolves the single cross-platform materializer from the package owner', () => {
  const invocation = withTerminalNativeBuildInputs.resolveTerminalNativeBuildInputMaterializer({
    projectRoot: '/workspace/apps/ui',
    platform: 'ios',
    nodePath: '/usr/local/bin/node',
    requireResolve(specifier, options) {
      assert.equal(specifier, '@happier-dev/terminal-native/package.json');
      assert.deepEqual(options, { paths: ['/workspace/apps/ui'] });
      return '/workspace/node_modules/@happier-dev/terminal-native/package.json';
    },
  });

  assert.deepEqual(invocation, {
    command: '/usr/local/bin/node',
    args: [
      '/workspace/node_modules/@happier-dev/terminal-native/scripts/materializeNativeBuildInputs.mjs',
      '--platform',
      'ios',
    ],
  });
});
