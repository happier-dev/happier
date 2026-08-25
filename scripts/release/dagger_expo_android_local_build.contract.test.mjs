import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('Dagger module exposes expo-android-local-build function', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'dagger', 'src', 'index.ts'), 'utf8');
  assert.match(src, /\bexpoAndroidLocalBuild\b/);
  assert.match(
    src,
    /containerPlatform:\s*string\s*=\s*"linux\/amd64"/,
    'expected expoAndroidLocalBuild to default the Android build container to linux/amd64 (Android SDK CMake binaries are not arm64)',
  );
  assert.match(src, /dag\.container\(\{\s*platform:\s*containerPlatform\s*}\)/);
  assert.match(src, /from\("ghcr\.io\/cirruslabs\/android-sdk:34"\)/);
  assert.doesNotMatch(
    src,
    /\bexpoAndroidLocalBuild\b[\s\S]*?\.export\(/,
    'expected expoAndroidLocalBuild to return build artifacts instead of exporting inside the module (export should be done by dagger call --output / chaining)',
  );
  assert.match(src, /"git"\s*,\s*"init"/);
  assert.match(
    src,
    /\byarn\b[\s\S]*\binstall\b/,
    'expected expoAndroidLocalBuild to install workspace deps in-container',
  );
  assert.match(
    src,
    /ONNXRUNTIME_NODE_INSTALL_CUDA[\s\S]*skip/,
    'expected expoAndroidLocalBuild to skip optional ONNX Runtime CUDA downloads during in-container installs',
  );
  assert.match(
    src,
    /scripts\/ci\/apt-install-with-retry\.sh/,
    'expected expoAndroidLocalBuild to use the shared apt-install-with-retry helper for transient mirror failures',
  );
  assert.ok(!src.includes('withMountedCache("/repo/node_modules"'), 'expected to avoid caching /repo/node_modules (too large)');
  assert.match(
    src,
    /const terminalNativeBuildInputCacheRoot = "\/root\/.cache\/happier-terminal-native-build-inputs"/,
    'expected the Android local build to provide the canonical terminal-native build-input cache root',
  );
  assert.match(
    src,
    /\.withMountedCache\(terminalNativeBuildInputCacheRoot, dag\.cacheVolume\("happier-terminal-native-build-inputs"\)\)/,
    'expected the package-owned terminal-native materializer cache to persist across Dagger builds',
  );
  assert.match(
    src,
    /\.withEnvVariable\("HAPPIER_TERMINAL_NATIVE_BUILD_INPUT_CACHE_DIR", terminalNativeBuildInputCacheRoot\)/,
    'expected the package-owned materializer to receive the Dagger cache path',
  );
  assert.doesNotMatch(
    src,
    /node-v\$\{nodeVersion\}-linux-x64\.tar\.xz/,
    'expected arch-aware Node download (not hardcoded linux-x64)',
  );
  assert.match(src, /\buname\s+-m\b/, 'expected Node arch detection via uname -m');
  assert.match(src, /node_arch="arm64"/, 'expected arm64 Node tarball selection');
  assert.match(src, /linux-\\\$\{node_arch\}\.tar\.xz/, 'expected Node download to reference ${node_arch}');
  assert.match(src, /registry\.npmjs\.org/, 'expected Yarn install to pin npm registry (avoid transient yarnpkg outages)');
});
