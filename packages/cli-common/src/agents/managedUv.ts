import { accessSync, constants, statSync } from 'node:fs';
import { chmod, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractArchivePayloadToDirectory } from '@happier-dev/release-runtime/archiveExtraction';
import { withWorkspaceBundleLock } from '../../workspaceBundleLock.mjs';
import { downloadGitHubReleaseAsset } from './downloadGitHubReleaseAsset.js';
import { createManagedToolScratchDir } from './createManagedToolScratchDir.js';
import { removeHappierTempDirAsync } from '../tempDirs/createHappierTempDir.js';
import { promoteManagedCurrentInstall } from './promoteManagedCurrentInstall.js';
import { resolveManagedToolsRoot } from './managedToolsRoot.js';
import type { AgentInstallProgressCallback } from './installProgress.js';

// Immutable upstream release assets and their publisher SHA-256 files:
// https://github.com/astral-sh/uv/releases/tag/0.13.0
// No latest-release API request is needed on shared, rate-limited IPs.
export const MANAGED_UV_VERSION = '0.13.0';
const UV_ASSETS = {
  'linux-x64': ['x86_64-unknown-linux-gnu', '1468ebd5a5541121837c5a2817b9972ba6090fa6caa3d142620850a47fb75154'],
  'linux-arm64': ['aarch64-unknown-linux-gnu', '3ccfb6af6e242433eb552f7d9676abd5412c6595c497e990d9c8cb7b5bd4d2c3'],
  'darwin-x64': ['x86_64-apple-darwin', '5f44dcbde809b632f47c36fadb241cb4d6f9af71d0c8f172b5d2026d3dde742c'],
  'darwin-arm64': ['aarch64-apple-darwin', 'a9c1b29002cf3c83f07fa9cd8a887a3be0107d90e23189721221e7257db8e3d6'],
  'win32-x64': ['x86_64-pc-windows-msvc', '088962f9e7b7bd9ea740c04c650b2a21c8928c345bd99ac24350dc924dba656c'],
  'win32-arm64': ['aarch64-pc-windows-msvc', 'cb54028b59aa87f11cf6dec293ce000420043a49a8aea522e822a671321f8932'],
} as const;

export function managedUvInstallDir(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(resolveManagedToolsRoot(processEnv), 'uv');
}

export function managedUvBinPath(processEnv: NodeJS.ProcessEnv = process.env): string {
  return join(managedUvInstallDir(processEnv), 'current', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
}

export function resolveExistingManagedUvCommand(processEnv: NodeJS.ProcessEnv = process.env): string | null {
  const command = managedUvBinPath(processEnv);
  try {
    if (!statSync(command).isFile()) return null;
    accessSync(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return command;
  } catch { return null; }
}

/** Shared runtime state; installed Agents override Python/tool directories with their version root. */
export function buildManagedUvEnvironment(processEnv: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const root = managedUvInstallDir(processEnv);
  return { UV_CACHE_DIR: join(root, 'cache'), UV_PYTHON_INSTALL_DIR: join(root, 'python'),
    UV_PYTHON_PREFERENCE: 'only-managed', UV_TOOL_DIR: join(root, 'tools'), UV_TOOL_BIN_DIR: join(root, 'bin') };
}

export async function ensureManagedUvCommand(processEnv: NodeJS.ProcessEnv = process.env,
  deps: Readonly<{ downloadGitHubReleaseAsset?: typeof downloadGitHubReleaseAsset }> = {},
  options: Readonly<{ signal?: AbortSignal; onProgress?: AgentInstallProgressCallback }> = {},
): Promise<string | null> {
  const { signal } = options;
  signal?.throwIfAborted();
  const existing = resolveExistingManagedUvCommand(processEnv);
  if (existing) return existing;
  const target = `${process.platform}-${process.arch}`;
  if (!Object.hasOwn(UV_ASSETS, target)) return null;
  const [triple, digest] = UV_ASSETS[target as keyof typeof UV_ASSETS];
  const archiveName = `uv-${triple}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const root = managedUvInstallDir(processEnv);
  try {
    return await withWorkspaceBundleLock(async () => {
      const afterLock = resolveExistingManagedUvCommand(processEnv);
      if (afterLock) return afterLock;
      const scratch = await createManagedToolScratchDir({ installDir: root, prefix: 'bootstrap' });
      const candidate = join(scratch, 'next');
      try {
        const archive = join(scratch, archiveName);
        await (deps.downloadGitHubReleaseAsset ?? downloadGitHubReleaseAsset)({
          url: `https://releases.astral.sh/github/uv/releases/download/${MANAGED_UV_VERSION}/${archiveName}`,
          destinationPath: archive, digest, signal, onProgress: options.onProgress, userAgent: 'happier-cli',
        });
        const extract = join(scratch, 'extract');
        await extractArchivePayloadToDirectory({ archiveName, archivePath: archive, extractDir: extract, signal });
        const binary = process.platform === 'win32' ? 'uv.exe' : 'uv';
        const output = join(candidate, 'bin', binary);
        await mkdir(dirname(output), { recursive: true });
        await rename(join(extract, ...(process.platform === 'win32' ? [] : [`uv-${triple}`]), binary), output);
        if (process.platform !== 'win32') await chmod(output, 0o755);
        signal?.throwIfAborted();
        await promoteManagedCurrentInstall({ installRoot: root, candidatePath: candidate, signal });
        return resolveExistingManagedUvCommand(processEnv);
      } finally { await removeHappierTempDirAsync(scratch); }
    }, { signal, lockPath: join(root, '.lock', 'bootstrap.lock'), errorLabel: 'managed uv bootstrap lock' });
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}
