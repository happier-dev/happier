import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseXcodeBuildSettings,
  resolveIosSimulatorDevice,
  runIosProfilingRuntime,
} from './ios_profiling_runtime.mjs';

test('parseXcodeBuildSettings reads indented xcodebuild key/value rows', () => {
  const settings = parseXcodeBuildSettings(`
      ENABLE_DEBUG_DYLIB = NO
      TARGET_BUILD_DIR = /tmp/Build/Products/Release-iphonesimulator
      FULL_PRODUCT_NAME = Happier-Local.app
      PRODUCT_BUNDLE_IDENTIFIER = dev.happier.stack.test
  `);

  assert.equal(settings.ENABLE_DEBUG_DYLIB, 'NO');
  assert.equal(settings.TARGET_BUILD_DIR, '/tmp/Build/Products/Release-iphonesimulator');
  assert.equal(settings.FULL_PRODUCT_NAME, 'Happier-Local.app');
  assert.equal(settings.PRODUCT_BUNDLE_IDENTIFIER, 'dev.happier.stack.test');
});

test('resolveIosSimulatorDevice resolves an explicit simulator UDID from simctl JSON', async () => {
  const device = await resolveIosSimulatorDevice({
    device: 'SIM-2',
    runCapture: async () =>
      JSON.stringify({
        devices: {
          'iOS 26.4': [
            { udid: 'SIM-1', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
            { udid: 'SIM-2', name: 'Happier Perf', state: 'Booted', isAvailable: true },
          ],
        },
      }),
  });

  assert.deepEqual(device, { udid: 'SIM-2', name: 'Happier Perf', runtime: 'iOS 26.4', state: 'Booted' });
});

test('runIosProfilingRuntime builds with debug dylib disabled then installs and launches the same bundle', async () => {
  const calls = [];
  const result = await runIosProfilingRuntime({
    uiDir: '/repo/apps/ui',
    device: 'SIM-1',
    configuration: 'Release',
    runCapture: async (cmd, args) => {
      calls.push(['capture', cmd, args]);
      if (cmd === 'xcrun') {
        return JSON.stringify({
          devices: {
            'iOS 26.4': [{ udid: 'SIM-1', name: 'Happier Perf', state: 'Booted', isAvailable: true }],
          },
        });
      }
      if (cmd === 'xcodebuild') {
        assert.ok(args.includes('ENABLE_DEBUG_DYLIB=NO'), `expected show settings to disable debug dylib: ${args.join(' ')}`);
        assert.ok(args.includes('ONLY_ACTIVE_ARCH=YES'), `expected show settings to use active simulator arch: ${args.join(' ')}`);
        assert.ok(args.includes('SENTRY_DISABLE_AUTO_UPLOAD=true'), `expected show settings to disable Sentry uploads: ${args.join(' ')}`);
        return `
          ENABLE_DEBUG_DYLIB = NO
          TARGET_BUILD_DIR = /tmp/Derived/Release-iphonesimulator
          FULL_PRODUCT_NAME = Happier-Local.app
          PRODUCT_BUNDLE_IDENTIFIER = dev.happier.stack.prof
        `;
      }
      throw new Error(`unexpected capture command ${cmd}`);
    },
    run: async (cmd, args) => {
      calls.push(['run', cmd, args]);
    },
  });

  const buildCall = calls.find((entry) => entry[0] === 'run' && entry[1] === 'xcodebuild');
  assert.ok(buildCall, `expected xcodebuild run call: ${JSON.stringify(calls)}`);
  assert.ok(buildCall[2].includes('ENABLE_DEBUG_DYLIB=NO'), `expected build to disable debug dylib: ${buildCall[2].join(' ')}`);
  assert.ok(buildCall[2].includes('ONLY_ACTIVE_ARCH=YES'), `expected build to use active simulator arch: ${buildCall[2].join(' ')}`);
  assert.ok(buildCall[2].includes('SENTRY_DISABLE_AUTO_UPLOAD=true'), `expected build to disable Sentry uploads: ${buildCall[2].join(' ')}`);
  assert.deepEqual(calls.at(-2), ['run', 'xcrun', ['simctl', 'install', 'SIM-1', '/tmp/Derived/Release-iphonesimulator/Happier-Local.app']]);
  assert.deepEqual(calls.at(-1), [
    'run',
    'xcrun',
    ['simctl', 'launch', '--terminate-running-process', 'SIM-1', 'dev.happier.stack.prof'],
  ]);
  assert.deepEqual(result, {
    appPath: '/tmp/Derived/Release-iphonesimulator/Happier-Local.app',
    bundleId: 'dev.happier.stack.prof',
    configuration: 'Release',
    debugDylib: 'NO',
    device: { udid: 'SIM-1', name: 'Happier Perf', runtime: 'iOS 26.4', state: 'Booted' },
  });
});
