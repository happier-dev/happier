import { lstat, readFile, readdir, readlink, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { fixNodePtyPackageSpawnHelperPermissions } from '../../nodePtySpawnHelperPermissions.cjs';
import { resolveInstalledPackage } from '../workspaces/index.js';
import type { BinaryTarget } from './targets.js';

const AUDITED_DUPLICATE_PACKAGE_PAIRS = [
  {
    duplicate: '@anthropic-ai/claude-agent-sdk/node_modules/@modelcontextprotocol/sdk',
    survivor: '@modelcontextprotocol/sdk',
  },
  { duplicate: '@happier-dev/agents/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/protocol/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/protocol/node_modules/zod-to-json-schema/node_modules/zod', survivor: 'zod' },
  { duplicate: '@modelcontextprotocol/sdk/node_modules/zod', survivor: 'zod' },
  { duplicate: '@happier-dev/release-runtime/node_modules/tar', survivor: 'tar' },
  {
    duplicate: 'archiver/node_modules/zip-stream/node_modules/archiver-utils',
    survivor: 'archiver/node_modules/archiver-utils',
  },
  {
    duplicate: '@modelcontextprotocol/sdk/node_modules/express/node_modules/body-parser/node_modules/qs',
    survivor: '@modelcontextprotocol/sdk/node_modules/express/node_modules/qs',
  },
  // Sharp's Darwin/Linux packages depend on separate libvips packages;
  // Windows packages contain their own libraries and have no libvips package.
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
  // Equal link text at different depths need not refer to equal content.
  // Audited vendored copies are physical trees; retain any copy containing links.
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

async function resolvePeerPackageDirectory(packageDir: string, peerName: string): Promise<string | null> {
  const lookupPaths = createRequire(resolve(packageDir, 'package.json')).resolve.paths(peerName) ?? [];
  for (const lookupPath of lookupPaths) {
    const candidate = join(lookupPath, peerName);
    if (await lstatIfPresent(candidate)) return candidate;
  }
  return null;
}

async function haveEquivalentPeerResolution(duplicate: string, survivor: string): Promise<boolean> {
  const manifest: unknown = JSON.parse(await readFile(join(duplicate, 'package.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object') return false;
  if (!('peerDependencies' in manifest)) return true;
  const peers = manifest.peerDependencies;
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) return false;
  for (const peerName of Object.keys(peers)) {
    // Runtime dependencies are physically vendored, but MCP's optional
    // @cfworker/json-schema peer can still come from a different ancestor.
    const [left, right] = await Promise.all([
      resolvePeerPackageDirectory(duplicate, peerName),
      resolvePeerPackageDirectory(survivor, peerName),
    ]);
    if (left === right) continue;
    // Peer copies inside the equal trees were included in the byte comparison.
    if (left === resolve(duplicate, 'node_modules', peerName)
      && right === resolve(survivor, 'node_modules', peerName)) continue;
    return false;
  }
  return true;
}

async function projectAuditedDuplicatePackages(nodeModulesDir: string): Promise<void> {
  // Outer packages precede their nested dependencies so an audited outer copy
  // cannot be made different merely by pruning one of its descendants first.
  for (const pair of AUDITED_DUPLICATE_PACKAGE_PAIRS) {
    const duplicate = join(nodeModulesDir, pair.duplicate);
    const survivor = join(nodeModulesDir, pair.survivor);
    if (!await arePathsRecursivelyByteEquivalent(duplicate, survivor)) continue;
    if (!await haveEquivalentPeerResolution(duplicate, survivor)) continue;

    const nestedModulesOffset = pair.duplicate.lastIndexOf('/node_modules/');
    const consumerDir = join(nodeModulesDir, pair.duplicate.slice(0, nestedModulesOffset));
    const packageName = pair.duplicate.slice(nestedModulesOffset + '/node_modules/'.length);
    const lookupPaths = createRequire(resolve(consumerDir, 'package.json')).resolve.paths(packageName) ?? [];
    // Removing a copy is safe only when lookup reaches the audited survivor
    // before another installed version (including an unaudited scope ancestor).
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

async function assertTargetOptionalPackages(params: Readonly<{
  consumerDirectory: string;
  nodeModulesDirectory: string;
  packageNames: readonly string[];
  scope: string;
  target: BinaryTarget;
}>): Promise<void> {
  const require = createRequire(join(params.consumerDirectory, 'package.json'));
  const missing = params.packageNames.filter((name) => {
    let installed: ReturnType<typeof resolveInstalledPackage>;
    try {
      installed = resolveInstalledPackage({ require, packageName: `${params.scope}/${name}` });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') return true;
      throw error;
    }
    const path = relative(params.nodeModulesDirectory, installed.packageDir);
    return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
  });
  if (missing.length > 0) {
    throw new Error(
      `[component-artifacts] missing target optional runtime package(s) for ${params.target.os}-${params.target.arch}: ${missing.map((name) => `${params.scope}/${name}`).join(', ')}; install dependencies with --ignore-platform before building cross-target artifacts`,
    );
  }
}

function shouldKeepTargetOptionalPackage(directory: string, target: BinaryTarget): boolean | null {
  const name = basename(directory);
  const parent = basename(dirname(directory));

  if (parent === '@img' && (
    /^sharp(?:-libvips)?-(?:darwin|linux|linuxmusl|win32)-(?:x64|arm64|arm|ia32|ppc64|riscv64|s390x)$/.test(name)
    || /^sharp-(?:(?:freebsd|webcontainers)-)?wasm32$/.test(name)
  )) {
    // The cross-target release install materializes every locked optional package.
    // Linux artifacts support both glibc and musl, so retain both libc variants.
    return resolveSharpTargetOptionalPackageNames(target).includes(name);
  }

  if (parent === '@anthropic-ai'
    && /^claude-agent-sdk-(?:darwin|linux|win32)-(?:x64|arm64)(?:-musl)?$/.test(name)) {
    // Happier always supplies the separately resolved provider CLI through
    // pathToClaudeCodeExecutable. The SDK's optional native CLI fallback is
    // therefore unreachable in standalone artifacts on every target.
    return false;
  }

  return null;
}

async function projectNativePackage(directory: string, target: BinaryTarget, nodeModulesDirectory: string): Promise<boolean> {
  const platform = target.os === 'windows' ? 'win32' : target.os;
  const name = basename(directory);
  const parent = basename(dirname(directory));
  if (name === 'sharp' && parent === 'node_modules') {
    await assertTargetOptionalPackages({
      consumerDirectory: directory,
      nodeModulesDirectory,
      packageNames: resolveSharpTargetOptionalPackageNames(target),
      scope: '@img',
      target,
    });
  }
  const keepTargetOptionalPackage = shouldKeepTargetOptionalPackage(directory, target);
  if (keepTargetOptionalPackage === false) {
    await rm(directory, { recursive: true, force: true });
    return false;
  }
  if (['bare-fs', 'bare-os', 'bare-url'].includes(name) && parent === 'node_modules') {
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
    // The locked ONNX 1.21.0 dist/binding.js requires this exact N-API path;
    // another ABI directory or an empty target directory cannot satisfy it.
    const bindingPath = `bin/napi-v3/${platform}/${target.arch}/onnxruntime_binding.node`;
    const binding = await stat(join(directory, bindingPath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!binding?.isFile()) {
      throw new Error(`[component-artifacts] missing target ONNX runtime binding for ${target.os}-${target.arch}: ${directory}/${bindingPath}`);
    }
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
    // in lib/index.js. These exact modules belong only to the foreign branch,
    // including its workers and tests; shared loaders and modules stay intact.
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

async function projectNativePackages(directory: string, target: BinaryTarget, nodeModulesDirectory = directory): Promise<void> {
  if (!await projectNativePackage(directory, target, nodeModulesDirectory)) return;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });

  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await projectNativePackages(path, target, nodeModulesDirectory);
    } else if (entry.isFile() && /(?:\.d\.(?:ts|mts|cts)\.map|\.tsbuildinfo)$/.test(entry.name)) {
      // Declarations remain available to SDK/plugin authors and executable
      // source maps remain available to Bun and Node diagnostics. Only declaration
      // navigation maps and incremental compiler state are runtime-inert.
      await rm(path);
    }
  }));
}

async function projectCliRuntimeFormats(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await projectCliRuntimeFormats(path);
    } else if (entry.isFile() && /(?:\.cjs|\.d\.(?:ts|mts|cts)(?:\.map)?|\.tsbuildinfo)$/.test(entry.name)) {
      await rm(path);
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

async function sanitizePayloadLinks(payloadDir: string, directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    // Package-manager links may point into the source checkout. Remove them
    // before native projection; only surviving links constrain the payload.
    if (entry.name === '.bin' && relative(payloadDir, path).startsWith(`node_modules${sep}`)) {
      await rm(path, { recursive: true, force: true });
      return;
    }
    if (entry.isDirectory()) {
      await sanitizePayloadLinks(payloadDir, path);
      return;
    }
    if (!entry.isSymbolicLink()) return;

    const target = await readlink(path);
    const resolvedTarget = resolve(dirname(path), target);
    const relativeTarget = relative(payloadDir, resolvedTarget);
    const escapesPayload = relativeTarget === '..'
      || relativeTarget.startsWith(`..${sep}`)
      || isAbsolute(relativeTarget);
    if (isAbsolute(target) || escapesPayload) {
      throw new Error(
        `[component-artifacts] runtime payload symlink escapes the artifact: ${relative(payloadDir, path)} -> ${target}`,
      );
    }
  }));
}

export async function finalizeRuntimeArtifactPayload(payloadDir: string, target?: BinaryTarget): Promise<void> {
  // Validate links before any operation that could follow a native helper link.
  await sanitizePayloadLinks(payloadDir, payloadDir);
  if (target) {
    const nodeModulesDir = join(payloadDir, 'node_modules');
    await projectNativePackages(nodeModulesDir, target);
    await projectAuditedDuplicatePackages(nodeModulesDir);
    await projectCliRuntimeTools(payloadDir, target);
    // Only the binary CLI's root disk entrypoints use the ESM build. Published
    // npm/library distributions and dependency/sidecar CJS remain untouched.
    await projectCliRuntimeFormats(join(payloadDir, 'package-dist'));
  }
}
