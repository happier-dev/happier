import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { CLI_BINARY_TARGETS, resolveCurrentBinaryTarget, resolveExecutableName, type BinaryTarget } from './targets.js';
import { commandExists, compileBunBinary, ensureFileExists, execOrThrow, resolveBunCommand, resolveYarnCommand, type RunCommand } from './commands.js';
import {
  bundleInstalledPackageWithRuntimeDependencies,
  bundleWorkspacePackageWithRuntimeDependencies,
  resolveWorkspaceBundlesFromPackageJson,
  vendorBundledPackageRuntimeDependencies,
} from '../workspaces/index.js';
import type {
  BundledWorkspacePackage,
  EnsureWorkspacePackagesBuiltByName,
} from './ensureBundledWorkspacePackagesBuilt.js';
import { withCliDistBuildLock } from './withCliDistBuildLock.js';
import { ensureBundledWorkspacePackagesBuilt } from './ensureBundledWorkspacePackagesBuilt.js';
import { finalizeRuntimeArtifactPayload } from './finalizeRuntimeArtifactPayload.js';
import { shouldReuseCliDistSnapshot } from './shouldReuseCliDistSnapshot.js';

const CLI_RUNTIME_SIDECAR_ENTRIES = [
  ['childProcessOptions.cjs'],
  ['claude_launcher_runtime.cjs'],
  ['claude_local_launcher.cjs'],
  ['claude_remote_launcher.cjs'],
  ['session_hook_forwarder.cjs'],
  ['permission_hook_forwarder.cjs'],
  ['ripgrep_launcher.cjs'],
  ['statusline_forwarder.cjs'],
  ['terminal_launch_spec_runner.cjs'],
  ['node_pty_relay.cjs'],
  ['runtime'],
  ['shims'],
] as const;

const CLI_RUNTIME_EXTERNAL_PACKAGES = [
  '@huggingface/transformers',
  'node-pty',
  '@homebridge/node-pty-prebuilt-multiarch',
] as const;

// Bun's `--compile` tree-shakes apps/cli's own source into the compiled binary (confirmed via
// `strings` on the real shipped binary: reachable files carry provenance comments, unreachable
// ones don't), so any statically-imported, non-external dependency reachable from that source is
// already embedded in the executable. These declared apps/cli dependencies were audited (see
// investigate/compiled-in-vs-vendored-audit) and confirmed to have no runtime code path --
// bin/*.mjs entrypoint, scripts/*.cjs sidecar, or dynamic require()/import() with a non-static
// path -- that reads them from an on-disk node_modules copy. Vendoring a duplicate loose copy of
// these onto disk alongside the compiled binary is therefore pure waste.
//
// This exclusion is scoped to the compiled CLI binary payload only (copyCliNodeRuntimePayload,
// below). Other vendorBundledPackageRuntimeDependencies call sites (npm-published tarball builds,
// apps/stack, packages/relay-server) do not compile their source into a binary and must keep
// vendoring these packages in full.
//
// Keep this list scoped to packages with concrete, checked evidence; when in doubt, leave a
// package vendored. Notably `sharp` is NOT included here: it does a runtime-constructed
// `require()` of a platform-specific native `.node` binding, the same reason node-pty is external
// above, so it must stay vendored on disk.
// Same rationale and audit trail as CLI_BINARY_PAYLOAD_VENDORING_EXCLUDED_PACKAGES above, but for
// the runtime dependencies declared by apps/cli's own bundled @happier-dev/* workspace packages
// (see bundleWorkspacePackageWithRuntimeDependencies below), rather than apps/cli's own
// dependencies. Confirmed via `strings` on a real compiled binary that these packages' distinctive
// exports (not just an inert package-name string) are compiled in -- e.g. @happier-dev/protocol's
// own nested tweetnacl/@noble/hashes/base64-js/zod-to-json-schema copies -- and that no sidecar or
// dynamic require() reads any of them from disk. See investigate/workspace-bundle-vendoring-audit.
//
// Scoped to the compiled CLI binary payload only, same as CLI_BINARY_PAYLOAD_VENDORING_EXCLUDED_PACKAGES.
const CLI_BINARY_PAYLOAD_WORKSPACE_BUNDLE_VENDORING_EXCLUDED_PACKAGES = new Set<string>([
  '@noble/hashes',
  'base64-js',
  'tweetnacl',
  'zod-to-json-schema',
]);

const CLI_BINARY_PAYLOAD_VENDORING_EXCLUDED_PACKAGES = new Set<string>([
  '@agentclientprotocol/sdk',
  '@anthropic-ai/claude-agent-sdk',
  '@modelcontextprotocol/sdk',
  '@stablelib/hex',
  'archiver',
  'axios',
  'chalk',
  'cross-spawn',
  'diff',
  'expo-server-sdk',
  'fastify',
  'fastify-type-provider-zod',
  'http-proxy',
  'https-proxy-agent',
  'ink',
  'open',
  'openapi-types',
  'ps-list',
  'qrcode-terminal',
  'react',
  'react-devtools-core',
  'socket.io-client',
  'tar',
  'tmp',
  'zod',
]);

type CliToolUnpackModule = {
  unpackTools?: (options: Readonly<{ platformDir: string; toolsDir: string }>) => Promise<unknown> | unknown;
};

function resolveCliToolsPlatformDir(target: BinaryTarget): string {
  const targetKey = `${target.arch}-${target.os}`;
  switch (targetKey) {
    case 'arm64-darwin':
    case 'x64-darwin':
    case 'arm64-linux':
    case 'x64-linux':
      return targetKey;
    case 'x64-windows':
      return 'x64-win32';
    default:
      throw new Error(`[component-artifacts] unsupported CLI tools binary target: ${targetKey}`);
  }
}

async function copyCliRuntimeSidecars(repoRoot: string, payloadDir: string): Promise<void> {
  for (const segments of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const sourcePath = join(repoRoot, 'apps', 'cli', 'scripts', ...segments);
    const targetPath = join(payloadDir, 'scripts', ...segments);
    await mkdir(join(targetPath, '..'), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });
  }

  const resolveFromPackageJsonPath = join(repoRoot, 'package.json');
  for (const packageName of CLI_RUNTIME_EXTERNAL_PACKAGES) {
    bundleInstalledPackageWithRuntimeDependencies({
      packageName,
      resolveFromPackageJsonPath,
      destNodeModulesDir: join(payloadDir, 'node_modules'),
    });
  }
}

async function copyCliRuntimeTools(repoRoot: string, payloadDir: string, target: BinaryTarget): Promise<void> {
  const sourceToolsDir = join(repoRoot, 'apps', 'cli', 'tools');
  const targetToolsDir = join(payloadDir, 'tools');
  const targetArchivesDir = join(targetToolsDir, 'archives');
  await rm(targetToolsDir, { recursive: true, force: true });
  await mkdir(targetToolsDir, { recursive: true });
  await cp(join(sourceToolsDir, 'archives'), targetArchivesDir, { recursive: true });

  const unpackToolsScript = join(repoRoot, 'apps', 'cli', 'scripts', 'unpack-tools.cjs');
  const requireFromUnpackTools = createRequire(unpackToolsScript);
  const unpackToolsModule = requireFromUnpackTools(unpackToolsScript) as CliToolUnpackModule;
  if (typeof unpackToolsModule.unpackTools !== 'function') {
    throw new Error('[component-artifacts] apps/cli/scripts/unpack-tools.cjs must export unpackTools()');
  }

  await unpackToolsModule.unpackTools({
    platformDir: resolveCliToolsPlatformDir(target),
    toolsDir: targetToolsDir,
  });
  await rm(targetArchivesDir, { recursive: true, force: true });
}

async function copyCliNodeRuntimePayload(
  repoRoot: string,
  payloadDir: string,
  distDir: string,
  workspaceBundles: readonly BundledWorkspacePackage[],
  params: Readonly<{
    yarn: Readonly<{ cmd: string; args: string[] }>;
    runCommand: RunCommand;
  }>,
): Promise<void> {
  const cliDir = join(repoRoot, 'apps', 'cli');

  await cp(distDir, join(payloadDir, 'package-dist'), { recursive: true });
  vendorBundledPackageRuntimeDependencies({
    srcPackageJsonPath: join(cliDir, 'package.json'),
    destPackageDir: payloadDir,
    excludePackageNames: CLI_BINARY_PAYLOAD_VENDORING_EXCLUDED_PACKAGES,
  });
  for (const { packageName, srcDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(payloadDir, 'node_modules', ...packageName.split('/')),
      excludePackageNames: CLI_BINARY_PAYLOAD_WORKSPACE_BUNDLE_VENDORING_EXCLUDED_PACKAGES,
    });
  }
}

function syncCliBundledWorkspacePackagesForCompile(cliDir: string, workspaceBundles: readonly BundledWorkspacePackage[]): void {
  for (const { packageName, srcDir } of workspaceBundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      packageName,
      srcDir,
      destDir: join(cliDir, 'node_modules', ...packageName.split('/')),
    });
  }
}

async function reclaimAbandonedCliDistSnapshots(cliDir: string): Promise<void> {
  const entries = await readdir(cliDir, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.name.startsWith('.dist.hstack-snapshot-') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map((entry) => rm(join(cliDir, entry.name), { recursive: true, force: true })));
}

async function snapshotCliDistDir(params: Readonly<{ cliDir: string; distDir: string }>): Promise<string> {
  await reclaimAbandonedCliDistSnapshots(params.cliDir);
  const snapshotDir = await mkdtemp(join(params.cliDir, '.dist.hstack-snapshot-'));
  let liveDistRenamed = false;
  try {
    await rename(params.distDir, snapshotDir);
    liveDistRenamed = true;
    await cp(snapshotDir, params.distDir, { recursive: true });
    return snapshotDir;
  } catch (error) {
    const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null;
    if (!liveDistRenamed && existsSync(params.distDir) && (code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')) {
      try {
        await cp(params.distDir, snapshotDir, { recursive: true });
        return snapshotDir;
      } catch (copyError) {
        await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
        throw copyError;
      }
    }
    if (liveDistRenamed && !existsSync(params.distDir) && existsSync(snapshotDir)) {
      await rename(snapshotDir, params.distDir).catch(() => {});
    }
    await rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function buildCliBinaryArtifactPayload({
  repoRoot,
  payloadDir,
  target = resolveCurrentBinaryTarget({ availableTargets: CLI_BINARY_TARGETS }),
  externals = [],
  runCommand = execOrThrow,
  commandProbe = commandExists,
  compileBinary = compileBunBinary,
  ensureWorkspacePackagesBuiltByName,
}: {
  repoRoot: string;
  payloadDir: string;
  target?: BinaryTarget;
  externals?: string[];
  runCommand?: RunCommand;
  commandProbe?: (cmd: string) => boolean;
  compileBinary?: typeof compileBunBinary;
  ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
}): Promise<{ executableName: string; entrypoint: string }> {
  const bunCommand = resolveBunCommand({ commandProbe });
  if (!bunCommand) {
    throw new Error('[component-artifacts] bun is required to build CLI binary artifacts');
  }

  const cliDir = join(repoRoot, 'apps', 'cli');
  const distDir = join(cliDir, 'dist');
  const distBackupDir = join(cliDir, '.dist.hstack-backup');
  const entrypoint = join(distDir, 'index.mjs');
  const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
  const yarn = resolveYarnCommand({ commandProbe });
  const workspaceBundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot,
    hostPackageDir: cliDir,
  });
  const executableName = resolveExecutableName({ baseName: 'happier', target });
  const mergedExternals = [...new Set([...CLI_RUNTIME_EXTERNAL_PACKAGES, ...externals.map((value) => String(value ?? '').trim()).filter(Boolean)])];

  await withCliDistBuildLock(async ({ heldLockValue }) => {
    const runCommandWithHeldDistLock: RunCommand = (cmd, args, options = {}) => runCommand(cmd, args, {
      ...options,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
      },
    });
    let snapshotDistDir: string | null = null;
    try {
      await ensureBundledWorkspacePackagesBuilt({
        repoRoot,
        bundles: workspaceBundles.map(({ packageName, srcDir }) => ({ packageName, srcDir })),
        ensureWorkspacePackagesBuiltByName,
      });
      syncCliBundledWorkspacePackagesForCompile(cliDir, workspaceBundles);

      if (!existsSync(distDir) && existsSync(distBackupDir)) {
        await rename(distBackupDir, distDir);
      }

      // If the CLI dist entrypoint is already present, prefer snapshotting it instead of rebuilding.
      // Rebuilding `apps/cli` is expensive and can disrupt long-running processes in dev checkouts.
      if (await shouldReuseCliDistSnapshot({
        distEntrypointPath: entrypoint,
        inputPaths: [
          join(cliDir, 'src'),
          join(cliDir, 'package.json'),
          ...workspaceBundles.map(({ srcDir }) => join(srcDir, 'dist')),
        ],
      })) {
        snapshotDistDir = await snapshotCliDistDir({ cliDir, distDir });
      } else {
        const hadDistBeforeBuild = existsSync(distDir);
        if (hadDistBeforeBuild) {
          await rm(distBackupDir, { recursive: true, force: true });
          await rename(distDir, distBackupDir);
        }

        try {
          await runCommandWithHeldDistLock(yarn.cmd, [...yarn.args, '--cwd', 'apps/cli', 'build'], { cwd: repoRoot });
          await ensureFileExists(entrypoint);
          if (hadDistBeforeBuild) {
            await rm(distBackupDir, { recursive: true, force: true });
          }
        } catch (error) {
          if (hadDistBeforeBuild && existsSync(distBackupDir)) {
            await rm(distDir, { recursive: true, force: true });
            await rename(distBackupDir, distDir);
          }
          throw error;
        }
        snapshotDistDir = await snapshotCliDistDir({ cliDir, distDir });
      }

      await rm(payloadDir, { recursive: true, force: true });
      await mkdir(payloadDir, { recursive: true });
      await compileBinary({
        entrypoint: join(snapshotDistDir, 'index.mjs'),
        bunTarget: target.bunTarget,
        outfile: join(payloadDir, executableName),
        cwd: repoRoot,
        externals: mergedExternals,
        bunCommand,
        runCommand,
      });
      await rm(join(payloadDir, 'node_modules'), { recursive: true, force: true });
      await copyCliNodeRuntimePayload(repoRoot, payloadDir, snapshotDistDir, workspaceBundles, { yarn, runCommand });
    } finally {
      if (snapshotDistDir) {
        await rm(snapshotDistDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, { lockPath });

  await copyCliRuntimeSidecars(repoRoot, payloadDir);
  await copyCliRuntimeTools(repoRoot, payloadDir, target);
  await finalizeRuntimeArtifactPayload(payloadDir);

  return {
    executableName,
    entrypoint: executableName,
  };
}
