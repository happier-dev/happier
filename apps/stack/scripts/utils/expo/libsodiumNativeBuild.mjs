import { join, resolve } from 'node:path';

import { pathExists } from '../fs/fs.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { run } from '../proc/proc.mjs';

function uniqueDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir) continue;
    const key = resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function findReactNativeLibsodiumPackageDir({ projectDir, runnerDir }) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(projectDir) ?? coerceHappyMonorepoRootFromPath(runnerDir);
  for (const root of uniqueDirs([projectDir, runnerDir, monorepoRoot])) {
    const packageDir = join(root, 'node_modules', '@more-tech', 'react-native-libsodium');
    if (await pathExists(join(packageDir, 'package.json'))) {
      return packageDir;
    }
  }
  return null;
}

async function hasXcframeworkSlice(xcframeworkDir, sliceName) {
  const sliceDir = join(xcframeworkDir, sliceName);
  return (
    await pathExists(join(sliceDir, 'libsodium.a')) &&
    await pathExists(join(sliceDir, 'Headers', 'sodium.h'))
  );
}

async function hasNativeBuild(packageDir) {
  const xcframeworkDir = join(packageDir, 'libsodium', 'build', 'libsodium-apple', 'Clibsodium.xcframework');
  return (
    await pathExists(xcframeworkDir) &&
    await hasXcframeworkSlice(xcframeworkDir, 'ios-arm64_arm64e') &&
    await hasXcframeworkSlice(xcframeworkDir, 'ios-arm64_arm64e_x86_64-simulator')
  );
}

export async function ensureReactNativeLibsodiumNativeBuild({
  projectDir,
  runnerDir,
  env = process.env,
  quiet = false,
} = {}) {
  const packageDir = await findReactNativeLibsodiumPackageDir({ projectDir, runnerDir });
  if (!packageDir) {
    return { repaired: false, packageDir: null };
  }

  if (await hasNativeBuild(packageDir)) {
    return { repaired: false, packageDir };
  }

  const archivePath = join(packageDir, 'libsodium', 'build.tgz');
  if (!(await pathExists(archivePath))) {
    throw new Error(`Missing react-native-libsodium native build archive: ${archivePath}`);
  }

  await run('tar', ['-xzf', archivePath, '--directory', join(packageDir, 'libsodium')], {
    cwd: packageDir,
    env,
    stdio: quiet ? 'ignore' : 'inherit',
  });
  return { repaired: true, packageDir };
}
