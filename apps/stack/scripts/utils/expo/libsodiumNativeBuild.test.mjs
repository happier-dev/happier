import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ensureReactNativeLibsodiumNativeBuild } from './libsodiumNativeBuild.mjs';

const execFileAsync = promisify(execFile);

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

test('ensureReactNativeLibsodiumNativeBuild repairs a partial XCFramework missing the simulator slice', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hs-libsodium-partial-xcframework-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(join(root, 'apps', 'ui'), { recursive: true });
  await mkdir(join(root, 'apps', 'cli'), { recursive: true });
  await mkdir(join(root, 'apps', 'server'), { recursive: true });
  await writeJson(join(root, 'package.json'), { name: 'repo', private: true });
  await writeFile(join(root, 'yarn.lock'), '# lock\n', 'utf-8');

  const packageDir = join(root, 'apps', 'ui', 'node_modules', '@more-tech', 'react-native-libsodium');
  const libsodiumDir = join(packageDir, 'libsodium');
  const xcframeworkDir = join(libsodiumDir, 'build', 'libsodium-apple', 'Clibsodium.xcframework');
  const deviceHeadersDir = join(xcframeworkDir, 'ios-arm64_arm64e', 'Headers');
  await mkdir(deviceHeadersDir, { recursive: true });
  await writeJson(join(packageDir, 'package.json'), { name: '@more-tech/react-native-libsodium' });
  await writeFile(join(deviceHeadersDir, 'sodium.h'), '/* partial */\n', 'utf-8');

  const stagedBuildDir = join(root, 'staged-libsodium-build');
  const simulatorHeadersDir = join(
    stagedBuildDir,
    'build',
    'libsodium-apple',
    'Clibsodium.xcframework',
    'ios-arm64_arm64e_x86_64-simulator',
    'Headers',
  );
  await mkdir(simulatorHeadersDir, { recursive: true });
  await writeFile(join(simulatorHeadersDir, 'sodium.h'), '/* simulator */\n', 'utf-8');
  await writeFile(
    join(stagedBuildDir, 'build', 'libsodium-apple', 'Clibsodium.xcframework', 'ios-arm64_arm64e_x86_64-simulator', 'libsodium.a'),
    'simulator',
    'utf-8',
  );
  await execFileAsync('tar', ['-czf', join(libsodiumDir, 'build.tgz'), '-C', stagedBuildDir, 'build']);

  const result = await ensureReactNativeLibsodiumNativeBuild({
    projectDir: join(root, 'apps', 'ui'),
    runnerDir: root,
    quiet: true,
  });

  assert.equal(result.repaired, true);
  assert.equal(
    await fileExists(join(xcframeworkDir, 'ios-arm64_arm64e_x86_64-simulator', 'Headers', 'sodium.h')),
    true,
  );
});
