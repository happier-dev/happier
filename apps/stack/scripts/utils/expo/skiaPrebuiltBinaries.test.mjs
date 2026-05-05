import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { run } from '../proc/proc.mjs';
import {
  ensureReactNativeSkiaAndroidBinaries,
  ensureReactNativeSkiaIosBinaries,
} from './skiaPrebuiltBinaries.mjs';

async function withTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-skia-binaries-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeSkiaPackage({ projectDir, script }) {
  const packageDir = join(projectDir, 'node_modules', '@shopify', 'react-native-skia');
  await mkdir(join(packageDir, 'scripts'), { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@shopify/react-native-skia', skia: { version: 'm999' } }),
    'utf-8',
  );
  await writeFile(join(packageDir, 'scripts', 'install-skia.mjs'), script, 'utf-8');
  await chmod(join(packageDir, 'scripts', 'install-skia.mjs'), 0o755);
  return packageDir;
}

async function createTarGz({ rootDir, archivePath, files }) {
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(rootDir, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf-8');
  }
  await run('tar', ['-czf', archivePath, '-C', rootDir, '.'], { stdio: 'ignore' });
}

test('ensureReactNativeSkiaIosBinaries downloads only the iOS xcframework artifact when iOS binaries are missing', async (t) => {
  const projectDir = await withTempDir(t);
  const packageDir = await writeSkiaPackage({
    projectDir,
    script: 'throw new Error("all-platform installer should not run");\n',
  });
  const assetsDir = await withTempDir(t);
  const assetVersionDir = join(assetsDir, 'skia-m999');
  await mkdir(assetVersionDir, { recursive: true });
  const archiveRoot = await withTempDir(t);
  await createTarGz({
    rootDir: archiveRoot,
    archivePath: join(assetVersionDir, 'skia-apple-ios-xcframeworks-skia-m999.tar.gz'),
    files: {
      'skia-apple-ios-xcframeworks/ios/libskia.xcframework/marker.txt': 'installed',
    },
  });

  const result = await ensureReactNativeSkiaIosBinaries({
    projectDir,
    env: {
      ...process.env,
      HAPPIER_STACK_SKIA_RELEASE_BASE_URL: pathToFileURL(assetsDir).href,
    },
    quiet: true,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.packageDir, packageDir);
  assert.equal(await readFile(join(packageDir, 'libs', 'apple', 'ios', 'libskia.xcframework', 'marker.txt'), 'utf-8'), 'installed');
});

test('ensureReactNativeSkiaIosBinaries accepts current root-level iOS artifact layout', async (t) => {
  const projectDir = await withTempDir(t);
  const packageDir = await writeSkiaPackage({
    projectDir,
    script: 'throw new Error("all-platform installer should not run");\n',
  });
  const assetsDir = await withTempDir(t);
  const assetVersionDir = join(assetsDir, 'skia-m999');
  await mkdir(assetVersionDir, { recursive: true });
  const archiveRoot = await withTempDir(t);
  await createTarGz({
    rootDir: archiveRoot,
    archivePath: join(assetVersionDir, 'skia-apple-ios-xcframeworks-skia-m999.tar.gz'),
    files: {
      'ios/libskia.xcframework/marker.txt': 'installed',
    },
  });

  const result = await ensureReactNativeSkiaIosBinaries({
    projectDir,
    env: {
      ...process.env,
      HAPPIER_STACK_SKIA_RELEASE_BASE_URL: pathToFileURL(assetsDir).href,
    },
    quiet: true,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.packageDir, packageDir);
  assert.equal(await readFile(join(packageDir, 'libs', 'apple', 'ios', 'libskia.xcframework', 'marker.txt'), 'utf-8'), 'installed');
});

test('ensureReactNativeSkiaIosBinaries skips the installer when iOS xcframeworks already exist', async (t) => {
  const projectDir = await withTempDir(t);
  const packageDir = await writeSkiaPackage({
    projectDir,
    script: 'throw new Error("installer should not run");\n',
  });
  await mkdir(join(packageDir, 'libs', 'apple', 'ios', 'libskia.xcframework'), { recursive: true });

  const result = await ensureReactNativeSkiaIosBinaries({ projectDir, quiet: true });

  assert.equal(result.repaired, false);
  assert.equal(result.packageDir, packageDir);
});

test('ensureReactNativeSkiaAndroidBinaries downloads only requested Android ABI artifacts', async (t) => {
  const projectDir = await withTempDir(t);
  const packageDir = await writeSkiaPackage({
    projectDir,
    script: 'throw new Error("all-platform installer should not run");\n',
  });
  const assetsDir = await withTempDir(t);
  const assetVersionDir = join(assetsDir, 'skia-m999');
  await mkdir(assetVersionDir, { recursive: true });
  const archiveRoot = await withTempDir(t);
  await createTarGz({
    rootDir: archiveRoot,
    archivePath: join(assetVersionDir, 'skia-android-arm-64-skia-m999.tar.gz'),
    files: {
      'skia-android-arm-64/arm64-v8a/libskia.a': 'installed',
    },
  });

  const result = await ensureReactNativeSkiaAndroidBinaries({
    projectDir,
    architectures: ['arm64-v8a'],
    env: {
      ...process.env,
      HAPPIER_STACK_SKIA_RELEASE_BASE_URL: pathToFileURL(assetsDir).href,
    },
    quiet: true,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.packageDir, packageDir);
  assert.equal(await readFile(join(packageDir, 'libs', 'android', 'arm64-v8a', 'libskia.a'), 'utf-8'), 'installed');
});

test('ensureReactNativeSkiaAndroidBinaries accepts current root-level Android ABI artifact layout', async (t) => {
  const projectDir = await withTempDir(t);
  const packageDir = await writeSkiaPackage({
    projectDir,
    script: 'throw new Error("all-platform installer should not run");\n',
  });
  const assetsDir = await withTempDir(t);
  const assetVersionDir = join(assetsDir, 'skia-m999');
  await mkdir(assetVersionDir, { recursive: true });
  const archiveRoot = await withTempDir(t);
  await createTarGz({
    rootDir: archiveRoot,
    archivePath: join(assetVersionDir, 'skia-android-arm-64-skia-m999.tar.gz'),
    files: {
      'arm64-v8a/libskia.a': 'installed',
    },
  });

  const result = await ensureReactNativeSkiaAndroidBinaries({
    projectDir,
    architectures: ['arm64-v8a'],
    env: {
      ...process.env,
      HAPPIER_STACK_SKIA_RELEASE_BASE_URL: pathToFileURL(assetsDir).href,
    },
    quiet: true,
  });

  assert.equal(result.repaired, true);
  assert.equal(result.packageDir, packageDir);
  assert.equal(await readFile(join(packageDir, 'libs', 'android', 'arm64-v8a', 'libskia.a'), 'utf-8'), 'installed');
});
