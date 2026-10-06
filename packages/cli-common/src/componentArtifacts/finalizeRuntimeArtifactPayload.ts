import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fixNodePtyPackageSpawnHelperPermissions } from '../../nodePtySpawnHelperPermissions.cjs';
import type { BinaryTarget } from './targets.js';
import { PUBLIC_SDK_GENERATED_GOVERNANCE_RECORDS } from '../workspaces/index.js';

const AUDITED_DUPLICATE_PACKAGE_PAIRS = [
  { duplicate: '@happier-dev/agents/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/protocol/node_modules/zod', survivor: 'zod' },
  { duplicate: '@modelcontextprotocol/sdk/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugin-sdk/node_modules/esbuild', survivor: 'esbuild' },
  { duplicate: '@happier-dev/plugin-sdk/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-claude/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-codex/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-cursor/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-elevenlabs/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-google/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-kimi/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-openai/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-opencode/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/plugins-xai/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/cli-common/node_modules/tar', survivor: 'tar' },
  { duplicate: '@happier-dev/release-runtime/node_modules/tar', survivor: 'tar' },
  {
    duplicate: 'fastify/node_modules/@fastify/fast-json-stringify-compiler/node_modules/fast-json-stringify',
    survivor: 'fastify/node_modules/fast-json-stringify',
  },
  { duplicate: '@happier-dev/protocol/node_modules/ajv', survivor: 'ajv' },
  { duplicate: '@happier-dev/protocol/node_modules/ajv-formats/node_modules/ajv', survivor: 'ajv' },
  { duplicate: '@modelcontextprotocol/sdk/node_modules/ajv', survivor: 'ajv' },
  { duplicate: '@modelcontextprotocol/sdk/node_modules/ajv-formats/node_modules/ajv', survivor: 'ajv' },
  { duplicate: 'fastify/node_modules/fast-json-stringify/node_modules/ajv', survivor: 'ajv' },
  {
    duplicate: 'fastify/node_modules/fast-json-stringify/node_modules/ajv-formats/node_modules/ajv',
    survivor: 'ajv',
  },
  { duplicate: 'fastify/node_modules/@fastify/ajv-compiler/node_modules/ajv', survivor: 'ajv' },
  {
    duplicate: 'fastify/node_modules/@fastify/ajv-compiler/node_modules/ajv-formats/node_modules/ajv',
    survivor: 'ajv',
  },
  { duplicate: '@happier-dev/sdk/node_modules/undici', survivor: 'undici' },
  {
    duplicate: 'archiver/node_modules/zip-stream/node_modules/archiver-utils',
    survivor: 'archiver/node_modules/archiver-utils',
  },
  {
    duplicate: '@modelcontextprotocol/sdk/node_modules/express/node_modules/body-parser/node_modules/qs',
    survivor: '@modelcontextprotocol/sdk/node_modules/express/node_modules/qs',
  },
  // Sharp 0.34.5 declares libvips 1.2.4 on Darwin/Linux; Windows bundles its libraries.
  ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linuxmusl-arm64', 'linuxmusl-x64'].map((target) => ({
    duplicate: `sharp/node_modules/@img/sharp-${target}/node_modules/@img/sharp-libvips-${target}`,
    survivor: `sharp/node_modules/@img/sharp-libvips-${target}`,
  })),
] as const;

async function lstatIfPresent(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function arePathsRecursivelyByteEquivalent(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([lstatIfPresent(left), lstatIfPresent(right)]);
  if (!leftStat || !rightStat) return false;
  if (leftStat.isFile() && rightStat.isFile()) {
    if (leftStat.size !== rightStat.size || (leftStat.mode & 0o777) !== (rightStat.mode & 0o777)) return false;
    const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
    return leftBytes.equals(rightBytes);
  }
  if (!leftStat.isDirectory() || !rightStat.isDirectory()) return false;
  if ((leftStat.mode & 0o777) !== (rightStat.mode & 0o777)) return false;
  const [leftEntries, rightEntries] = await Promise.all([readdir(left), readdir(right)]);
  leftEntries.sort();
  rightEntries.sort();
  if (leftEntries.length !== rightEntries.length
    || leftEntries.some((entry, index) => entry !== rightEntries[index])) return false;
  for (const entry of leftEntries) {
    if (!await arePathsRecursivelyByteEquivalent(join(left, entry), join(right, entry))) return false;
  }
  return true;
}

async function projectAuditedDuplicatePackages(nodeModulesDir: string): Promise<void> {
  for (const pair of AUDITED_DUPLICATE_PACKAGE_PAIRS) {
    const duplicate = join(nodeModulesDir, pair.duplicate);
    const survivor = join(nodeModulesDir, pair.survivor);
    if (!await arePathsRecursivelyByteEquivalent(duplicate, survivor)) continue;
    const nestedModulesOffset = pair.duplicate.lastIndexOf('/node_modules/');
    const consumerDir = join(nodeModulesDir, pair.duplicate.slice(0, nestedModulesOffset));
    const packageName = pair.duplicate.slice(nestedModulesOffset + '/node_modules/'.length);
    const lookupPaths = createRequire(resolve(consumerDir, 'package.json')).resolve.paths(packageName) ?? [];
    // Retain the copy if another installed package would shadow the audited survivor.
    for (const lookupPath of lookupPaths) {
      const candidate = join(lookupPath, packageName);
      if (candidate === resolve(duplicate)) continue;
      if (candidate === resolve(survivor)) {
        await rm(duplicate, { recursive: true, force: true });
        break;
      }
      if (await lstatIfPresent(candidate)) break;
    }
  }
}

async function readDirectories(directory: string) {
  return (await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter((entry) => entry.isDirectory());
}

function resolveSharpTargetOptionalPackageNames(target: BinaryTarget): readonly string[] {
  const platform = target.os === 'windows' ? 'win32' : target.os;
  return target.os === 'linux'
    ? [
        `sharp-linux-${target.arch}`,
        `sharp-linuxmusl-${target.arch}`,
        `sharp-libvips-linux-${target.arch}`,
        `sharp-libvips-linuxmusl-${target.arch}`,
      ]
    : [
        `sharp-${platform}-${target.arch}`,
        ...(target.os === 'darwin' ? [`sharp-libvips-darwin-${target.arch}`] : []),
      ];
}

function resolveSherpaTargetOptionalPackageName(target: BinaryTarget): string {
  const platform = target.os === 'windows' ? 'win' : target.os;
  return `sherpa-onnx-${platform}-${target.arch}`;
}

async function assertTargetOptionalPackages(params: Readonly<{
  directory: string;
  packageNames: readonly string[];
  scope: string;
  target: BinaryTarget;
}>): Promise<void> {
  const installed = new Set((await readDirectories(params.directory)).map((entry) => entry.name));
  const missing = params.packageNames.filter((name) => !installed.has(name));
  if (missing.length > 0) {
    throw new Error(
      `[component-artifacts] missing target optional runtime package(s) for ${params.target.os}-${params.target.arch}: ${missing.map((name) => `${params.scope}/${name}`).join(', ')}; install dependencies with --ignore-platform before building cross-target artifacts`,
    );
  }
}

function shouldKeepTargetOptionalPackage(directory: string, target: BinaryTarget): boolean | null {
  const name = basename(directory);
  const parent = basename(dirname(directory));

  if (parent === '@esbuild') {
    const platform = target.os === 'windows' ? 'win32' : target.os;
    return name === `${platform}-${target.arch}`;
  }

  if (parent === '@img' && (
    /^sharp(?:-libvips)?-(?:darwin|linux|linuxmusl|win32)-(?:x64|arm64|arm|ia32|ppc64|riscv64|s390x)$/.test(name)
    || name === 'sharp-wasm32'
  )) {
    // The release install materializes every locked optional package. Linux
    // artifacts support both glibc and musl, so retain both libc variants.
    return resolveSharpTargetOptionalPackageNames(target).includes(name);
  }

  if (/^sherpa-onnx-(?:darwin|linux|win)-(?:x64|arm64)$/.test(name) && parent === 'node_modules') {
    return name === resolveSherpaTargetOptionalPackageName(target);
  }

  return null;
}

async function projectNativePackage(directory: string, target: BinaryTarget): Promise<boolean> {
  const platform = target.os === 'windows' ? 'win32' : target.os;
  const name = basename(directory);
  const parent = basename(dirname(directory));
  if (name === 'iroh-native' && parent === '@happier-dev') {
    const nativeDir = join(directory, 'native');
    const files = await readdir(nativeDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const file of files) {
      if (/^happier-iroh-native-lifecycle\.(?:linux|darwin|win32)-(?:x64|arm64)\.node$/.test(file)
        && file !== `happier-iroh-native-lifecycle.${platform}-${target.arch}.node`) await rm(join(nativeDir, file));
    }
  }
  if (name === 'sharp' && parent === 'node_modules') {
    await assertTargetOptionalPackages({
      directory: join(directory, 'node_modules', '@img'),
      packageNames: resolveSharpTargetOptionalPackageNames(target),
      scope: '@img',
      target,
    });
  }
  if (name === 'sherpa-onnx-node' && parent === 'node_modules') {
    await assertTargetOptionalPackages({
      directory: join(directory, 'node_modules'),
      packageNames: [resolveSherpaTargetOptionalPackageName(target)],
      scope: '',
      target,
    });
  }
  const keepTargetOptionalPackage = shouldKeepTargetOptionalPackage(directory, target);
  if (keepTargetOptionalPackage === false) {
    await rm(directory, { recursive: true, force: true });
    return false;
  }
  if (['bare-fs', 'bare-os', 'bare-url', 'bare-path'].includes(name) && parent === 'node_modules') {
    // These packages all use the same explicit prebuilds/<platform>-<arch> layout.
    // Package-level licenses and JavaScript loaders remain outside this directory.
    for (const prebuild of await readDirectories(join(directory, 'prebuilds'))) {
      if (prebuild.name !== `${platform}-${target.arch}`) {
        await rm(join(directory, 'prebuilds', prebuild.name), { recursive: true, force: true });
      }
    }
  }
  if (name === 'ps-list' && parent === 'node_modules' && target.os !== 'windows') {
    // ps-list's POSIX implementation invokes ps; only Windows uses fastlist.
    const vendorDir = join(directory, 'vendor');
    const entries = await readdir(vendorDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isFile() && /^fastlist-.*\.exe$/i.test(entry.name)) await rm(join(vendorDir, entry.name));
    }
  }
  if (name === 'onnxruntime-node' && parent === 'node_modules') {
    // ONNX loads bin/napi-v*/<process.platform>/<process.arch>; retain the whole
    // selected directory, including shared libraries and provider sidecars.
    for (const napi of await readDirectories(join(directory, 'bin'))) {
      if (!/^napi-v\d+$/.test(napi.name)) continue;
      const napiDir = join(directory, 'bin', napi.name);
      for (const os of await readDirectories(napiDir)) {
        if (!['darwin', 'linux', 'win32'].includes(os.name)) continue;
        const platformDir = join(napiDir, os.name);
        if (os.name !== platform) {
          await rm(platformDir, { recursive: true, force: true });
        } else {
          for (const arch of await readDirectories(platformDir)) {
            if (arch.name !== target.arch && ['x64', 'arm64', 'arm', 'ia32'].includes(arch.name)) {
              await rm(join(platformDir, arch.name), { recursive: true, force: true });
            }
          }
        }
      }
    }
  }
  const isPty = (name === 'node-pty' && parent === 'node_modules')
    || (name === 'node-pty-prebuilt-multiarch' && parent === '@homebridge'
      && basename(dirname(dirname(directory))) === 'node_modules');
  if (isPty) {
    // node-pty 1.1.0 and Homebridge 0.13.1 select windowsTerminal/unixTerminal
    // in lib/index.js. Remove only the foreign branch's exact modules;
    // shared loaders, modules, and authoring metadata remain intact.
    const foreignModules = target.os === 'windows'
      ? ['unixTerminal', 'unixTerminal.test', 'prebuild-loader']
      : ['windowsConoutConnection', 'windowsPtyAgent', 'windowsPtyAgent.test',
          'windowsTerminal', 'windowsTerminal.test', 'conpty_console_list_agent',
          'shared/conout', 'worker/conoutSocketWorker'];
    for (const module of foreignModules) {
      await rm(join(directory, 'lib', `${module}.js`), { force: true });
      await rm(join(directory, 'src', `${module}.ts`), { force: true });
    }
    for (const prebuild of await readDirectories(join(directory, 'prebuilds'))) {
      if (/^(darwin|linux|win32)-(x64|arm64|arm|ia32)$/.test(prebuild.name)
        && prebuild.name !== `${platform}-${target.arch}`) {
        await rm(join(directory, 'prebuilds', prebuild.name), { recursive: true, force: true });
      }
    }
    const thirdPartyConptyDir = join(directory, 'third_party', 'conpty');
    if (target.os !== 'windows') {
      await rm(thirdPartyConptyDir, { recursive: true, force: true });
      await rm(join(directory, 'deps', 'winpty'), { recursive: true, force: true });
      await rm(join(directory, 'src', 'win'), { recursive: true, force: true });
    } else {
      await rm(join(directory, 'src', 'unix'), { recursive: true, force: true });
      for (const version of await readDirectories(thirdPartyConptyDir)) {
        const versionDir = join(thirdPartyConptyDir, version.name);
        for (const nativeTarget of await readDirectories(versionDir)) {
          if (/^win10-(?:x64|arm64)$/.test(nativeTarget.name)
            && nativeTarget.name !== `win10-${target.arch}`) {
            await rm(join(versionDir, nativeTarget.name), { recursive: true, force: true });
          }
        }
      }
    }
    // Both PTY implementations also support source-built Release/Debug assets.
    // Leave those intact and repair all surviving helpers through the install owner.
    fixNodePtyPackageSpawnHelperPermissions(directory);
  }
  return true;
}

async function projectNativePackages(directory: string, target: BinaryTarget): Promise<void> {
  if (!await projectNativePackage(directory, target)) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await projectNativePackages(path, target);
    }
  }));
}

async function projectRuntimeMetadata(
  directory: string,
  options: Readonly<{ removeCommonJs: boolean; removeDeclarations: boolean }>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await projectRuntimeMetadata(path, options);
    } else if (entry.isFile() && (/(?:\.d\.[cm]?ts\.map|\.tsbuildinfo)$/.test(entry.name)
      || (options.removeDeclarations && /\.d\.[cm]?ts$/.test(entry.name))
      || (options.removeCommonJs && entry.name.endsWith('.cjs')))) {
      await rm(path);
    }
  }
}

async function removePackageManagerBinDirectories(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.name === '.bin') {
      await rm(path, { recursive: true, force: true });
      return;
    }
    if (entry.isDirectory()) {
      await removePackageManagerBinDirectories(path);
    }
  }));
}

type PayloadTopology = Readonly<{
  hardlinkedFiles: readonly string[];
  symlinks: readonly string[];
}>;

const PAYLOAD_TOPOLOGY_INSPECTION_CONCURRENCY = 128;

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativeCandidate = relative(directory, candidate);
  return relativeCandidate === ''
    || (
      relativeCandidate !== '..'
      && !relativeCandidate.startsWith(`..${sep}`)
      && !isAbsolute(relativeCandidate)
    );
}

function displayPayloadPath(payloadDir: string, path: string): string {
  return relative(payloadDir, path) || '.';
}

async function inspectPayloadTopology(
  payloadDir: string,
  payloadRealPath: string,
  options: Readonly<{ allowPackageManagerBinRemovalLeaves?: boolean }> = {},
): Promise<PayloadTopology> {
  const symlinks: string[] = [];
  const hardlinkedFiles: string[] = [];
  const nodeModulesDir = join(payloadDir, 'node_modules');

  async function inspectPath(path: string): Promise<readonly string[]> {
    const entryStats = await lstat(path);
    if (
      options.allowPackageManagerBinRemovalLeaves === true
      && basename(path) === '.bin'
      && isWithinDirectory(nodeModulesDir, path)
    ) {
      return [];
    }
    if (entryStats.isDirectory()) {
      return (await readdir(path))
        .sort()
        .map((entry) => join(path, entry));
    }
    if (entryStats.isFile()) {
      if (entryStats.nlink > 1) hardlinkedFiles.push(path);
      return [];
    }
    if (entryStats.isSymbolicLink()) {
      let resolvedTarget: string;
      try {
        resolvedTarget = await realpath(path);
      } catch (error) {
        throw new Error(
          `[component-artifacts] runtime payload symlink cannot be resolved: ${displayPayloadPath(payloadDir, path)}`,
          { cause: error },
        );
      }
      if (!isWithinDirectory(payloadRealPath, resolvedTarget)) {
        throw new Error(
          `[component-artifacts] runtime payload symlink escapes the artifact: ${displayPayloadPath(payloadDir, path)} -> ${resolvedTarget}`,
        );
      }

      const targetStats = await stat(path);
      if (!targetStats.isDirectory() && !targetStats.isFile()) {
        throw new Error(
          `[component-artifacts] runtime payload symlink targets an unsupported file type: ${displayPayloadPath(payloadDir, path)}`,
        );
      }
      if (targetStats.isDirectory() && isWithinDirectory(resolvedTarget, path)) {
        throw new Error(
          `[component-artifacts] runtime payload symlink forms a directory cycle: ${displayPayloadPath(payloadDir, path)}`,
        );
      }
      symlinks.push(path);
      return [];
    }
    throw new Error(
      `[component-artifacts] runtime payload contains an unsupported file type: ${displayPayloadPath(payloadDir, path)}`,
    );
  }

  let pendingPaths = (await readdir(payloadDir))
    .sort()
    .map((entry) => join(payloadDir, entry));
  while (pendingPaths.length > 0) {
    const nextPaths: string[] = [];
    for (
      let offset = 0;
      offset < pendingPaths.length;
      offset += PAYLOAD_TOPOLOGY_INSPECTION_CONCURRENCY
    ) {
      const paths = pendingPaths.slice(offset, offset + PAYLOAD_TOPOLOGY_INSPECTION_CONCURRENCY);
      const results = await Promise.allSettled(paths.map(inspectPath));
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
        nextPaths.push(...result.value);
      }
    }
    pendingPaths = nextPaths;
  }
  return {
    hardlinkedFiles: hardlinkedFiles.sort(),
    symlinks: symlinks.sort(),
  };
}

async function materializeSymlink(path: string): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(dirname(path), '.happier-materialize-link-'));
  const stagedPath = join(temporaryDirectory, 'entry');
  const originalPath = join(temporaryDirectory, 'original');
  let originalMoved = false;
  try {
    await cp(path, stagedPath, {
      dereference: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      recursive: true,
    });
    await rename(path, originalPath);
    originalMoved = true;
    try {
      await rename(stagedPath, path);
      originalMoved = false;
    } catch (error) {
      await rename(originalPath, path);
      originalMoved = false;
      throw error;
    }
  } finally {
    if (!originalMoved) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function breakHardlink(path: string): Promise<void> {
  const entryStats = await stat(path);
  const temporaryDirectory = await mkdtemp(join(dirname(path), '.happier-break-hardlink-'));
  const stagedPath = join(temporaryDirectory, 'entry');
  const originalPath = join(temporaryDirectory, 'original');
  let originalMoved = false;
  try {
    await copyFile(path, stagedPath, fsConstants.COPYFILE_EXCL);
    await chmod(stagedPath, entryStats.mode & 0o7777);
    await utimes(stagedPath, entryStats.atime, entryStats.mtime);
    await rename(path, originalPath);
    originalMoved = true;
    try {
      await rename(stagedPath, path);
      originalMoved = false;
    } catch (error) {
      await rename(originalPath, path);
      originalMoved = false;
      throw error;
    }
  } finally {
    if (!originalMoved) {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}

async function projectCliRuntimeTools(payloadDir: string, target: BinaryTarget): Promise<void> {
  const unpackedToolsDir = join(payloadDir, 'tools', 'unpacked');
  await rm(join(unpackedToolsDir, 'ripgrep.node'), { force: true });
  if (target.os === 'windows') {
    await rm(join(unpackedToolsDir, 'zellij.exe'), { force: true });
    await rm(join(unpackedToolsDir, 'zellij-LICENSE'), { force: true });
  }
}

// The generated governance records come from the one shared list; the SDK's
// release-governance `scripts/` subtree is an artifact-only removal.
const PUBLIC_SDK_GOVERNANCE_PROJECTIONS = [
  {
    packageName: '@happier-dev/plugin-sdk',
    packagePath: ['@happier-dev', 'plugin-sdk'],
    removedPaths: [...PUBLIC_SDK_GENERATED_GOVERNANCE_RECORDS['@happier-dev/plugin-sdk'], 'scripts'],
  },
  {
    packageName: '@happier-dev/plugin-ui',
    packagePath: ['@happier-dev', 'plugin-ui'],
    removedPaths: [...PUBLIC_SDK_GENERATED_GOVERNANCE_RECORDS['@happier-dev/plugin-ui']],
  },
  {
    packageName: '@happier-dev/sdk',
    packagePath: ['@happier-dev', 'sdk'],
    removedPaths: [...PUBLIC_SDK_GENERATED_GOVERNANCE_RECORDS['@happier-dev/sdk']],
  },
] as const;

function isExactPackageFileEntry(value: string): boolean {
  return value.length > 0
    && !value.includes('\\')
    && !value.startsWith('/')
    && !value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    && !/[*?{}[\]]/u.test(value);
}

async function publishProjectedPackageManifest(
  packageRoot: string,
  packageJsonPath: string,
  manifest: Readonly<Record<string, unknown>>,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(packageRoot, '.happier-package-manifest-'));
  const stagedManifestPath = join(temporaryDirectory, 'package.json');
  try {
    await writeFile(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(stagedManifestPath, packageJsonPath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function projectPublicSdkGovernanceFiles(payloadDir: string): Promise<void> {
  for (const projection of PUBLIC_SDK_GOVERNANCE_PROJECTIONS) {
    const packageRoot = join(payloadDir, 'node_modules', ...projection.packagePath);
    const packageJsonPath = join(packageRoot, 'package.json');
    const manifestText = await readFile(packageJsonPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // Synthetic payload fixtures and runtimes that do not carry this package
    // have nothing for this package-specific projection to own.
    if (manifestText === null) continue;
    const parsed: unknown = JSON.parse(manifestText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`[component-artifacts] ${projection.packageName} package manifest must be an object`);
    }
    const manifest = parsed as Record<string, unknown>;
    if (manifest.name !== projection.packageName) {
      throw new Error(`[component-artifacts] package at ${projection.packagePath.join('/')} must be ${projection.packageName}`);
    }
    const declaredFiles = manifest.files;
    if (declaredFiles !== undefined) {
      if (!Array.isArray(declaredFiles) || declaredFiles.some((entry) => typeof entry !== 'string')) {
        throw new Error(`[component-artifacts] ${projection.packageName} package files must be exact relative paths`);
      }
      const projectedFiles = declaredFiles.filter((entry): entry is string => {
        if (typeof entry !== 'string' || !isExactPackageFileEntry(entry)) {
          throw new Error(`[component-artifacts] ${projection.packageName} package file must be an exact relative path: '${String(entry)}'`);
        }
        return !projection.removedPaths.some((removedPath) => (
          entry === removedPath || entry.startsWith(`${removedPath}/`)
        ));
      });
      for (const relativePath of projectedFiles) {
        const retainedPath = resolve(packageRoot, relativePath);
        if (!isWithinDirectory(packageRoot, retainedPath)) {
          throw new Error(`[component-artifacts] ${projection.packageName} package file escapes its root: '${relativePath}'`);
        }
        try {
          await lstat(retainedPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`[component-artifacts] ${projection.packageName} retained package file is missing: '${relativePath}'`);
          }
          throw error;
        }
      }
      await publishProjectedPackageManifest(packageRoot, packageJsonPath, {
        ...manifest,
        files: projectedFiles,
      });
    }
    for (const removedPath of projection.removedPaths) {
      await rm(join(packageRoot, removedPath), { recursive: true, force: true });
    }
  }
}

export async function finalizeRuntimeArtifactPayload(
  payloadDir: string,
  target?: BinaryTarget,
  options: Readonly<{ pruneDependencyDeclarations?: boolean }> = {},
): Promise<void> {
  const payloadStats = await lstat(payloadDir);
  if (!payloadStats.isDirectory() || payloadStats.isSymbolicLink()) {
    throw new Error('[component-artifacts] runtime payload root must be a physical directory');
  }

  const payloadRealPath = await realpath(payloadDir);
  await inspectPayloadTopology(payloadDir, payloadRealPath, {
    allowPackageManagerBinRemovalLeaves: true,
  });
  await removePackageManagerBinDirectories(join(payloadDir, 'node_modules'));
  const topology = await inspectPayloadTopology(payloadDir, payloadRealPath);
  const symlinksDeepestFirst = [...topology.symlinks]
    .sort((left, right) => right.split(sep).length - left.split(sep).length);
  for (const path of symlinksDeepestFirst) {
    await materializeSymlink(path);
  }
  for (const path of topology.hardlinkedFiles) {
    await breakHardlink(path);
  }

  // A materialized directory link can introduce package-manager shims that were not
  // traversable during the initial cleanup.
  await removePackageManagerBinDirectories(join(payloadDir, 'node_modules'));

  const finalizedTopology = await inspectPayloadTopology(payloadDir, payloadRealPath);
  if (finalizedTopology.symlinks.length > 0 || finalizedTopology.hardlinkedFiles.length > 0) {
    throw new Error('[component-artifacts] runtime payload finalization left linked entries behind');
  }
  if (target) {
    await projectAuditedDuplicatePackages(join(payloadDir, 'node_modules'));
    await projectNativePackages(join(payloadDir, 'node_modules'), target);
    await projectCliRuntimeTools(payloadDir, target);
    await projectPublicSdkGovernanceFiles(payloadDir);
    await projectRuntimeMetadata(join(payloadDir, 'package-dist'), {
      removeCommonJs: true,
      removeDeclarations: true,
    });
    // Declarations remain available to SDK/plugin authors and executable
    // source maps remain available to Bun and Node diagnostics. Only declaration
    // navigation maps and incremental compiler state are runtime-inert.
    await projectRuntimeMetadata(join(payloadDir, 'node_modules'), {
      removeCommonJs: false,
      removeDeclarations: options.pruneDependencyDeclarations === true,
    });
  }
}
