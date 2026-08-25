import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const withTerminalNativeGhosttyKit = require('./withTerminalNativeGhosttyKit.js');

test('iOS prebuild materializes GhosttyKit through the terminal-native package owner', async () => {
    const invocation = withTerminalNativeGhosttyKit.resolveTerminalNativeGhosttyKitMaterializer({
        projectRoot: '/workspace/apps/ui',
        nodePath: '/usr/local/bin/node',
        requireResolve(specifier, options) {
            assert.equal(specifier, '@happier-dev/terminal-native/package.json');
            assert.deepEqual(options, { paths: ['/workspace/apps/ui'] });
            return '/workspace/node_modules/@happier-dev/terminal-native/package.json';
        },
    });

    assert.deepEqual(invocation, {
        command: '/usr/local/bin/node',
        args: ['/workspace/node_modules/@happier-dev/terminal-native/scripts/buildGhosttyKitIos.mjs'],
    });
});

test('iOS prebuild runs the resolved terminal-native materializer before CocoaPods', async () => {
    const calls = [];
    await withTerminalNativeGhosttyKit.materializeTerminalNativeGhosttyKit({
        projectRoot: '/workspace/apps/ui',
        resolveMaterializer: () => ({
            command: '/usr/local/bin/node',
            args: ['/workspace/node_modules/@happier-dev/terminal-native/scripts/buildGhosttyKitIos.mjs'],
        }),
        execFileAsync: async (...args) => {
            calls.push(args);
        },
    });

    assert.deepEqual(calls, [[
        '/usr/local/bin/node',
        ['/workspace/node_modules/@happier-dev/terminal-native/scripts/buildGhosttyKitIos.mjs'],
        {
            cwd: '/workspace/apps/ui',
            env: process.env,
            maxBuffer: 1024 * 1024,
        },
    ]]);
});
