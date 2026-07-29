import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReactNativeRepackGeneratedProject } from './validateReactNativeRepackGeneratedProject.mjs';

async function createGeneratedProjectFixture({
  iosPodLockIncludesRepack = true,
  iosManifestIncludesRepack = true,
  iosPodfileIncludesDirectRepack = false,
  androidDirectGradleInclude = true,
  androidAutolinkingIncludesRepack = false,
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'rn-repack-generated-project-'));
  const iosDir = join(rootDir, 'ios');
  const podsDir = join(iosDir, 'Pods');
  const androidDir = join(rootDir, 'android');
  const androidAppDir = join(androidDir, 'app');
  const androidGeneratedDir = join(androidDir, 'build', 'generated', 'autolinking');

  await Promise.all([
    mkdir(podsDir, { recursive: true }),
    mkdir(androidAppDir, { recursive: true }),
    mkdir(androidGeneratedDir, { recursive: true }),
  ]);

  await writeFile(
    join(rootDir, 'package.json'),
    JSON.stringify({ dependencies: { '@callstack/repack': '5.2.5' } }, null, 2),
    'utf8',
  );
  await writeFile(
    join(iosDir, 'Podfile'),
    iosPodfileIncludesDirectRepack
      ? [
        "target 'HappierPublicDevClient' do",
        '  config = use_native_modules!(config_command)',
        '  use_react_native!(:path => config[:reactNativePath])',
        '  pod \'callstack-repack\', :path => File.dirname(`node --print "require.resolve(\'@callstack/repack/package.json\')"`)',
        'end',
      ].join('\n')
      : [
        "target 'HappierPublicDevClient' do",
        '  config = use_native_modules!(config_command)',
        '  use_react_native!(:path => config[:reactNativePath])',
        'end',
      ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(iosDir, 'Podfile.lock'),
    iosPodLockIncludesRepack ? 'PODS:\n  - callstack-repack (5.2.5)\n' : 'PODS:\n  - Expo (55.0.0)\n',
    'utf8',
  );
  await writeFile(
    join(podsDir, 'Manifest.lock'),
    iosManifestIncludesRepack ? 'PODS:\n  - callstack-repack (5.2.5)\n' : 'PODS:\n  - Expo (55.0.0)\n',
    'utf8',
  );
  await writeFile(
    join(androidDir, 'settings.gradle'),
    androidDirectGradleInclude
      ? [
        "include ':app'",
        "include ':callstack-repack'",
        "project(':callstack-repack').projectDir = new File(",
        '  providers.exec {',
        '    workingDir(rootDir)',
        '    commandLine("node", "--print", "require(\'path\').join(require(\'path\').dirname(require.resolve(\'@callstack/repack/package.json\')), \'android\')")',
        '  }.standardOutput.asText.get().trim()',
        ')',
      ].join('\n')
      : "include ':app'\n",
    'utf8',
  );
  await writeFile(
    join(androidAppDir, 'build.gradle'),
    androidDirectGradleInclude
      ? "dependencies {\n    implementation project(':callstack-repack')\n}\n"
      : "dependencies {\n    implementation('com.facebook.react:react-android')\n}\n",
    'utf8',
  );
  await writeFile(
    join(androidGeneratedDir, 'autolinking.json'),
    JSON.stringify(
      androidAutolinkingIncludesRepack
        ? {
          dependencies: {
            '@callstack/repack': {
              root: '/tmp/node_modules/@callstack/repack',
              name: '@callstack/repack',
              platforms: {
                android: {
                  sourceDir: '/tmp/node_modules/@callstack/repack/android',
                  packageImportPath: 'import com.callstack.repack.ScriptManagerPackage;',
                },
              },
            },
          },
        }
        : { dependencies: [] },
      null,
      2,
    ),
    'utf8',
  );

  return { rootDir };
}

test('assertReactNativeRepackGeneratedProject passes only when iOS pods and Android Gradle include Re.Pack', async () => {
  const { rootDir } = await createGeneratedProjectFixture();

  const summary = await assertReactNativeRepackGeneratedProject({ cwd: rootDir });

  assert.deepEqual(summary, {
    ios: { podfile: true, podLock: true, manifestLock: true },
    android: { sourceGradle: true, generatedAutolinking: false },
  });
});

test('assertReactNativeRepackGeneratedProject rejects generated iOS projects whose pods are not materialized', async () => {
  const { rootDir } = await createGeneratedProjectFixture({
    iosPodLockIncludesRepack: false,
  });

  await assert.rejects(
    () => assertReactNativeRepackGeneratedProject({ cwd: rootDir }),
    /Podfile\.lock.*callstack-repack/i,
  );
});

test('assertReactNativeRepackGeneratedProject rejects stale direct iOS Podfile Re.Pack wiring', async () => {
  const { rootDir } = await createGeneratedProjectFixture({
    iosPodfileIncludesDirectRepack: true,
  });

  await assert.rejects(
    () => assertReactNativeRepackGeneratedProject({ cwd: rootDir }),
    /Podfile.*callstack-repack.*autolinking/i,
  );
});

test('assertReactNativeRepackGeneratedProject passes when Android autolinking materializes Re.Pack without a direct project', async () => {
  const { rootDir } = await createGeneratedProjectFixture({
    androidDirectGradleInclude: false,
    androidAutolinkingIncludesRepack: true,
  });

  const summary = await assertReactNativeRepackGeneratedProject({ cwd: rootDir });

  assert.deepEqual(summary.android, {
    sourceGradle: false,
    generatedAutolinking: true,
  });
});

test('assertReactNativeRepackGeneratedProject rejects duplicate Android Re.Pack materialization paths', async () => {
  const { rootDir } = await createGeneratedProjectFixture({
    androidDirectGradleInclude: true,
    androidAutolinkingIncludesRepack: true,
  });

  await assert.rejects(
    () => assertReactNativeRepackGeneratedProject({ cwd: rootDir }),
    /duplicate.*callstack-repack/i,
  );
});

test('assertReactNativeRepackGeneratedProject rejects Android projects without a Re.Pack native include', async () => {
  const { rootDir } = await createGeneratedProjectFixture({
    androidDirectGradleInclude: false,
  });

  await assert.rejects(
    () => assertReactNativeRepackGeneratedProject({ cwd: rootDir }),
    /Android.*callstack-repack/i,
  );
});

test('apps/ui prebuild wires React Native Re.Pack generated-project validation into the native workflow', async () => {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const packageJson = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(packageJsonPath, 'utf8')));

  assert.match(
    packageJson?.scripts?.prebuild ?? '',
    /validate:rn:repack:generated-project/,
  );
});
