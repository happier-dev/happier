import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getStackRootFromMeta, runNodeCapture } from './testkit/auth_testkit.mjs';

function parseKeyValueLines(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

test('hstack mobile --run-android passes --port so the native build and dev server use the same Metro port', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const mobileScript = join(rootDir, 'scripts', 'mobile.mjs');

  const tmp = await mkdtemp(join(tmpdir(), 'hstack-mobile-runandroid-port-'));
  const repoDir = join(tmp, 'repo');
  const storageDir = join(tmp, 'storage');

  try {
    const uiDir = join(repoDir, 'apps', 'ui');
    const expoBin = join(uiDir, 'node_modules', '.bin', 'expo');
    await mkdir(join(uiDir, 'node_modules', '.bin'), { recursive: true });
    const staleRootAutolinkingConfig = join(uiDir, 'android', 'build', 'generated', 'autolinking', 'autolinking.json');
    const staleAutolinkingEntryPoint = join(
      uiDir,
      'android',
      'app',
      'build',
      'generated',
      'autolinking',
      'src',
      'main',
      'java',
      'com',
      'facebook',
      'react',
      'ReactNativeApplicationEntryPoint.java'
    );
    await mkdir(dirname(staleRootAutolinkingConfig), { recursive: true });
    await mkdir(dirname(staleAutolinkingEntryPoint), { recursive: true });
    await writeFile(
      staleRootAutolinkingConfig,
      JSON.stringify({ project: { android: { packageName: 'dev.happier.app.dev.internal' } } }),
      'utf-8'
    );
    await writeFile(staleAutolinkingEntryPoint, 'stale generated source', 'utf-8');
    const staleRootNativeModuleBuild = join(
      repoDir,
      'node_modules',
      'expo-modules-core',
      'android',
      'build',
      'intermediates',
      'compile_library_classes_jar',
      'debug',
      'bundleLibCompileToJarDebug',
      'classes.jar'
    );
    const staleRootScopedModuleCxx = join(
      repoDir,
      'node_modules',
      '@expo',
      'dev-launcher',
      'android',
      '.cxx',
      'Debug',
      'stale.txt'
    );
    const staleUiNativeModuleBuild = join(
      uiDir,
      'node_modules',
      'react-native-screens',
      'android',
      'build',
      'intermediates',
      'stale.txt'
    );
    const staleUiScopedModuleCxx = join(
      uiDir,
      'node_modules',
      '@shopify',
      'react-native-skia',
      'android',
      '.cxx',
      'Debug',
      'stale.txt'
    );
    for (const stalePath of [
      staleRootNativeModuleBuild,
      staleRootScopedModuleCxx,
      staleUiNativeModuleBuild,
      staleUiScopedModuleCxx,
    ]) {
      await mkdir(dirname(stalePath), { recursive: true });
      await writeFile(stalePath, 'stale generated native build output', 'utf-8');
    }

    // Stub Expo CLI: print argv + env-derived ports and exit successfully.
    await writeFile(
      expoBin,
      `#!${process.execPath}
console.log('ARGS=' + JSON.stringify(process.argv.slice(2)));
console.log('RCT_METRO_PORT=' + (process.env.RCT_METRO_PORT ?? ''));
console.log('EXPO_PACKAGER_PORT=' + (process.env.EXPO_PACKAGER_PORT ?? ''));
console.log('EXPO_APP_BUNDLE_ID=' + (process.env.EXPO_APP_BUNDLE_ID ?? ''));
console.log('EXPO_ANDROID_PACKAGE=' + (process.env.EXPO_ANDROID_PACKAGE ?? ''));
process.exit(0);
`,
      'utf-8'
    );
    if (process.platform !== 'win32') {
      await chmod(expoBin, 0o755);
    }

    await mkdir(join(storageDir, 'main'), { recursive: true });

    const env = {
      ...process.env,
      HAPPIER_STACK_REPO_DIR: repoDir,
      HAPPIER_STACK_HOME_DIR: join(tmp, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_STACK: 'main',
      USER: 'user',
      HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL: '0',
      HAPPIER_STACK_TAILSCALE_SERVE: '0',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
      HAPPIER_STACK_CLEAR_ANDROID_NATIVE_BUILD_STATE: '1',
    };

    const res = await runNodeCapture([mobileScript, '--run-android', '--no-metro', '--port=14362'], { cwd: rootDir, env });
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    const kv = parseKeyValueLines(res.stdout);
    const args = JSON.parse(kv.ARGS ?? '[]');

    assert.ok(args.includes('run:android'), `expected expo subcommand run:android\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.ok(args.includes('--port'), `expected expo args to include --port\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    const portIdx = args.indexOf('--port');
    assert.ok(portIdx >= 0 && args[portIdx + 1] === '14362', `expected --port 14362\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(
      kv.RCT_METRO_PORT,
      '14362',
      `expected RCT_METRO_PORT to be set from hstack --port\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.equal(
      kv.EXPO_PACKAGER_PORT,
      '14362',
      `expected EXPO_PACKAGER_PORT to match\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.equal(
      kv.EXPO_APP_BUNDLE_ID,
      'com.happier.local.user.dev',
      `expected local iOS bundle id to stay isolated\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.equal(
      kv.EXPO_ANDROID_PACKAGE,
      'dev.happier.app.internaldev',
      `expected Android package to stay on a Firebase-configured app id\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
    );
    assert.equal(
      existsSync(staleAutolinkingEntryPoint),
      false,
      'expected stale generated React Native autolinking entrypoint to be removed before expo run:android'
    );
    assert.equal(
      existsSync(staleRootAutolinkingConfig),
      false,
      'expected stale generated React Native autolinking config to be removed before expo run:android'
    );
    assert.equal(
      existsSync(staleRootNativeModuleBuild),
      false,
      'expected stale root native-module android/build output to be removed before expo run:android'
    );
    assert.equal(
      existsSync(staleRootScopedModuleCxx),
      false,
      'expected stale root scoped native-module android/.cxx output to be removed before expo run:android'
    );
    assert.equal(
      existsSync(staleUiNativeModuleBuild),
      false,
      'expected stale UI native-module android/build output to be removed before expo run:android'
    );
    assert.equal(
      existsSync(staleUiScopedModuleCxx),
      false,
      'expected stale UI scoped native-module android/.cxx output to be removed before expo run:android'
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
