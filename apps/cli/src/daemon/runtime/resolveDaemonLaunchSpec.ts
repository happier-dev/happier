import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseOptionalBooleanEnv } from '@happier-dev/protocol';

import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeEntrypoint } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { ensureJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable';
import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';
import {
  buildHappyCliSubprocessLaunchSpec,
  resolveCliTsxTsconfigPath,
  resolveTsxImportHookSpecifier,
} from '@/utils/spawnHappyCLI';

export type DaemonLaunchSpec = Readonly<{
  filePath: string;
  args: string[];
  env?: Record<string, string>;
}>;

function normalizeExecutableBase(pathLike: string): string {
  const normalized = String(pathLike ?? '').trim().replaceAll('\\', '/');
  return normalized.split('/').at(-1)?.toLowerCase() ?? '';
}

function isRuntimeExecutablePath(pathLike: string): boolean {
  const base = normalizeExecutableBase(pathLike);
  return (
    base === 'node'
    || base === 'node.exe'
    || base === 'bun'
    || base === 'bun.exe'
    || base === 'happier-js-runtime'
    || base === 'happier-js-runtime.cmd'
  );
}

function isPackagedEntrypointPath(pathLike: string): boolean {
  const normalized = String(pathLike ?? '').trim().replaceAll('\\', '/').toLowerCase();
  return normalized.endsWith('/package-dist/index.mjs') || normalized.endsWith('/dist/index.mjs');
}

function hasDaemonStackContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.HAPPIER_STACK_REPO_DIR ||
    env.HAPPIER_STACK_CLI_ROOT_DIR ||
    env.HAPPIER_STACK_STACK
  );
}

function shouldPreferDaemonTsxSourceEntrypoint(env: NodeJS.ProcessEnv = process.env): boolean {
  if (
    typeof env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT === 'string'
    && env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT.trim().length > 0
  ) {
    return false;
  }
  const explicitPreference = parseOptionalBooleanEnv(env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX);
  if (explicitPreference !== null) return explicitPreference;
  return env.HAPPIER_VARIANT === 'dev' || hasDaemonStackContext(env);
}

function resolveBundledCurrentProcessLaunchSpec(
  cliArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonLaunchSpec | null {
  const currentExecPath = String(process.execPath ?? '').trim();
  if (!currentExecPath) return null;

  const bundledScriptPath = String(process.argv[1] ?? '').trim();
  if (!isRuntimeExecutablePath(currentExecPath)) {
    return {
      filePath: currentExecPath,
      args: [...cliArgs],
    };
  }

  // When we are already running through a managed JS runtime wrapper with a concrete packaged
  // entrypoint, keep using the same executable + entrypoint pair. This prevents detached daemon
  // relaunch from drifting to a runtime resolved from a different home/profile.
  if (isPackagedEntrypointPath(bundledScriptPath) && !shouldPreferDaemonTsxSourceEntrypoint(env)) {
    const currentExecBase = normalizeExecutableBase(currentExecPath);
    if (currentExecBase !== 'bun' && currentExecBase !== 'bun.exe') {
      return {
        filePath: currentExecPath,
        args: [bundledScriptPath, ...cliArgs],
      };
    }
  }

  if (!isEmbeddedBunBundlePath(bundledScriptPath)) {
    return null;
  }
  const currentExecBase = normalizeExecutableBase(currentExecPath);
  if (currentExecBase !== 'bun' && currentExecBase !== 'bun.exe') {
    return null;
  }
  if (process.platform === 'win32') {
    // Bun virtual bundle paths like `B:/~BUN/root/happier.exe` are process-local and can fail
    // when reused from detached children. On Windows, prefer resolving a packaged entrypoint
    // under a stable JS runtime in the fallback path below.
    return null;
  }

  return {
    filePath: currentExecPath,
    args: [bundledScriptPath, ...cliArgs],
  };
}

function shouldAllowDaemonTsxFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = parseOptionalBooleanEnv(env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK);
  if (explicit !== null) return explicit;
  return env.HAPPIER_VARIANT === 'dev' || hasDaemonStackContext(env);
}

function resolveSourceEntrypoint(): string {
  return join(projectPath(), 'src', 'index.ts');
}

function resolveDaemonTsxSourceLaunchSpec(
  runtimeExecutable: string,
  cliArgs: readonly string[],
): DaemonLaunchSpec | null {
  const sourceEntrypoint = resolveSourceEntrypoint();
  if (!existsSync(sourceEntrypoint)) return null;

  const tsxHookSpecifier = resolveTsxImportHookSpecifier();
  if (!tsxHookSpecifier) {
    throw new Error('Daemon launch requires tsx for source fallback, but tsx could not be resolved');
  }
  return {
    filePath: runtimeExecutable,
    args: ['--no-warnings', '--no-deprecation', '--import', tsxHookSpecifier, sourceEntrypoint, ...cliArgs],
    env: {
      TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
    },
  };
}

function shouldPreferWindowsPackagedBinaryForEmbeddedBunLaunch(): boolean {
  if (process.platform !== 'win32') return false;
  const execBase = normalizeExecutableBase(process.execPath);
  if (execBase !== 'bun' && execBase !== 'bun.exe') return false;
  return isEmbeddedBunBundlePath(String(process.argv[1] ?? '').trim());
}

function resolveWindowsSiblingPackagedBinary(packagedEntrypoint: string): string | null {
  if (process.platform !== 'win32') return null;
  const normalizedEntrypoint = String(packagedEntrypoint ?? '').trim();
  if (!normalizedEntrypoint || isEmbeddedBunBundlePath(normalizedEntrypoint)) {
    return null;
  }
  const entrypointForwardSlashes = normalizedEntrypoint.replaceAll('\\', '/');
  const packageDistSuffix = '/package-dist/index.mjs';
  if (!entrypointForwardSlashes.toLowerCase().endsWith(packageDistSuffix)) {
    return null;
  }
  const runtimeRoot = entrypointForwardSlashes.slice(0, -packageDistSuffix.length);
  if (!runtimeRoot) {
    return null;
  }
  const siblingBinaryForwardSlashes = `${runtimeRoot}/happier.exe`;
  const siblingBinaryNativeSeparators = normalizedEntrypoint.includes('\\')
    ? siblingBinaryForwardSlashes.replaceAll('/', '\\')
    : siblingBinaryForwardSlashes;
  if (
    isEmbeddedBunBundlePath(siblingBinaryNativeSeparators)
    || (
      !existsSync(siblingBinaryNativeSeparators)
      && !existsSync(siblingBinaryForwardSlashes)
    )
  ) {
    return null;
  }
  return siblingBinaryNativeSeparators;
}

export async function resolveDaemonLaunchSpec(
  cliArgs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<DaemonLaunchSpec> {
  const bundledCurrentProcessLaunchSpec = resolveBundledCurrentProcessLaunchSpec(cliArgs, env);
  if (bundledCurrentProcessLaunchSpec) {
    return bundledCurrentProcessLaunchSpec;
  }

  const admittedDaemonDistFingerprint = String(
    env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT ?? '',
  ).trim();
  if (
    hasDaemonStackContext(env)
    && cliArgs[0] === 'daemon'
    && cliArgs[1] === 'start-sync'
    && admittedDaemonDistFingerprint
    && parseOptionalBooleanEnv(env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX) !== true
  ) {
    const launchSpec = buildHappyCliSubprocessLaunchSpec([...cliArgs], {
      allowAdmittedDaemonStartupClosure: true,
      environment: env,
    });
    return {
      filePath: launchSpec.filePath,
      args: launchSpec.args,
      ...(launchSpec.env ? { env: launchSpec.env } : {}),
    };
  }

  const packagedEntrypoint = resolvePackagedRuntimeEntrypoint('index.mjs');
  if (shouldPreferWindowsPackagedBinaryForEmbeddedBunLaunch()) {
    const siblingPackagedBinary = resolveWindowsSiblingPackagedBinary(packagedEntrypoint);
    if (siblingPackagedBinary) {
      return {
        filePath: siblingPackagedBinary,
        args: [...cliArgs],
      };
    }
  }

  const runtimeExecutable = await ensureJavaScriptRuntimeExecutable({
    isBunRuntime: false,
    currentExecPath: process.execPath,
  });
  if (!runtimeExecutable) {
    throw new Error('Daemon launch requires a JavaScript runtime, but none could be resolved');
  }

  if (shouldPreferDaemonTsxSourceEntrypoint(env)) {
    const sourceLaunchSpec = resolveDaemonTsxSourceLaunchSpec(runtimeExecutable, cliArgs);
    if (sourceLaunchSpec) return sourceLaunchSpec;
  }

  const packagedEntrypointIsWindowsEmbeddedBundle =
    process.platform === 'win32' && isEmbeddedBunBundlePath(packagedEntrypoint);
  if (existsSync(packagedEntrypoint) && !packagedEntrypointIsWindowsEmbeddedBundle) {
    return {
      filePath: runtimeExecutable,
      args: ['--no-warnings', '--no-deprecation', packagedEntrypoint, ...cliArgs],
    };
  }

  if (shouldAllowDaemonTsxFallback(env)) {
    const sourceLaunchSpec = resolveDaemonTsxSourceLaunchSpec(runtimeExecutable, cliArgs);
    if (sourceLaunchSpec) return sourceLaunchSpec;
  }

  throw new Error(`Daemon packaged entrypoint is missing: ${packagedEntrypoint}`);
}
