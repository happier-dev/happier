import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runPluginAuthorPhase } from '@/plugins/authoring/phaseLog';

import {
  normalizePluginSdkRegistryOrigin,
  runManagedPluginPnpm,
  type ManagedPluginPnpmRunResult,
} from '@/plugins/authoring/toolchain';

export type PreparedPluginDevelopmentRoot = Readonly<{
  /** The trusted author root itself. Development candidates are never copied. */
  rootPath: string;
  /** Candidate disposal releases process-local work only; it never deletes author bytes. */
  cleanup: () => Promise<void>;
}>;

export type RunManagedPluginPnpmBoundary = (params: Readonly<{
  projectRoot: string;
  args: readonly string[];
  sdkRegistryOrigin?: string | null;
}>) => Promise<ManagedPluginPnpmRunResult>;

async function hasAuthorProvidedPnpmLockfile(rootPath: string): Promise<boolean> {
  try {
    return (await lstat(join(rootPath, 'pnpm-lock.yaml'))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Prepares dependency inputs for a trusted package root in place.
 *
 * Source-only candidates pass `prepareDependencies: false`, which deliberately
 * performs no package-manager work. Dependency-changing candidates use the
 * managed binary-safe toolchain against the author root. Neither mode creates
 * a candidate copy, immutable generation, history directory, or cleanup task
 * that can remove author-owned files.
 */
export async function preparePluginDevelopmentRoot(
  params: Readonly<{
    sourceRootPath: string;
    prepareDependencies: boolean;
    sdkRegistryOrigin?: string | null;
  }>,
  dependencies: Readonly<{
    runManagedPluginPnpm?: RunManagedPluginPnpmBoundary;
  }> = {},
): Promise<PreparedPluginDevelopmentRoot> {
  const sourceRootPath = await realpath(resolve(params.sourceRootPath));
  if (params.prepareDependencies) {
    await runPluginAuthorPhase({ phase: 'dependency prep', projectRoot: sourceRootPath }, async () => {
      const hasAuthorLockfile = await hasAuthorProvidedPnpmLockfile(sourceRootPath);
      const managedPnpm = await (dependencies.runManagedPluginPnpm ?? runManagedPluginPnpm)({
        projectRoot: sourceRootPath,
        args: [
          'install',
          '--ignore-scripts',
          ...(hasAuthorLockfile ? ['--frozen-lockfile'] : []),
        ],
        sdkRegistryOrigin: normalizePluginSdkRegistryOrigin(params.sdkRegistryOrigin),
      });
      if (!managedPnpm.ok) throw new Error(managedPnpm.message);
      if (managedPnpm.result.exitCode !== 0 || managedPnpm.result.signal !== null) {
        const detail = `${managedPnpm.result.stderr}\n${managedPnpm.result.stdout}`.trim();
        throw new Error(`Plugin development dependency preparation failed${detail ? `: ${detail}` : ''}`);
      }
    });
  }
  return Object.freeze({
    rootPath: sourceRootPath,
    cleanup: async () => undefined,
  });
}
