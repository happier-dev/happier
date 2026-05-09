import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parseOptionalBooleanEnv } from '@happier-dev/protocol';

import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeEntrypoint } from '@/packagedRuntime/resolvePackagedRuntimeEntrypoint';
import { ensureJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable';
import { isEmbeddedBunBundlePath } from '@/packagedRuntime/js/isEmbeddedBunBundlePath';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookSpecifier } from '@/utils/spawnHappyCLI';

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

function resolveBundledCurrentProcessLaunchSpec(cliArgs: readonly string[]): DaemonLaunchSpec | null {
  const currentExecPath = String(process.execPath ?? '').trim();
  if (!currentExecPath) return null;

  if (!isRuntimeExecutablePath(currentExecPath)) {
    return {
      filePath: currentExecPath,
      args: [...cliArgs],
    };
  }

  const bundledScriptPath = String(process.argv[1] ?? '').trim();
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

function shouldAllowDaemonTsxFallback(): boolean {
  const explicit = parseOptionalBooleanEnv(process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK);
  if (explicit !== null) return explicit;
  return process.env.HAPPIER_VARIANT === 'dev' || Boolean(
    process.env.HAPPIER_STACK_REPO_DIR ||
    process.env.HAPPIER_STACK_CLI_ROOT_DIR ||
    process.env.HAPPIER_STACK_STACK
  );
}

function resolveSourceEntrypoint(): string {
  return join(projectPath(), 'src', 'index.ts');
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

export async function resolveDaemonLaunchSpec(cliArgs: readonly string[]): Promise<DaemonLaunchSpec> {
  const bundledCurrentProcessLaunchSpec = resolveBundledCurrentProcessLaunchSpec(cliArgs);
  if (bundledCurrentProcessLaunchSpec) {
    return bundledCurrentProcessLaunchSpec;
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

  const packagedEntrypointIsWindowsEmbeddedBundle =
    process.platform === 'win32' && isEmbeddedBunBundlePath(packagedEntrypoint);
  if (existsSync(packagedEntrypoint) && !packagedEntrypointIsWindowsEmbeddedBundle) {
    return {
      filePath: runtimeExecutable,
      args: ['--no-warnings', '--no-deprecation', packagedEntrypoint, ...cliArgs],
    };
  }

  const sourceEntrypoint = resolveSourceEntrypoint();
  if (shouldAllowDaemonTsxFallback() && existsSync(sourceEntrypoint)) {
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

  throw new Error(`Daemon packaged entrypoint is missing: ${packagedEntrypoint}`);
}
