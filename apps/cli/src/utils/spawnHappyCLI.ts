/**
 * Cross-platform Happier CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Happier.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/happier.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`happier.cmd` and `happier.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `happier` command
 * 2. Shell directly executes `bin/happier.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/happier.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `happier` command  
 * 2. NPM wrapper (`happier.cmd`) calls `node bin/happier.mjs`
 * 3. `bin/happier.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Happier CLI as a subprocess (for daemon processes), 
 * we were trying to execute `bin/happier.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific 
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { basename, dirname, join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';
import { createRequire } from 'node:module';

function getSubprocessRuntime(): 'node' | 'bun' {
  const override = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  if (override === 'node' || override === 'bun') return override;
  return isBun() ? 'bun' : 'node';
}

function resolveTsxImportHookPath(): string | null {
  // `node --import tsx` resolves `tsx` relative to the current working directory.
  // Daemon-spawned sessions intentionally run in arbitrary `cwd`s (e.g. /Users/leeroy),
  // so we must use an absolute path to the tsx ESM register hook.
  try {
    const req = createRequire(import.meta.url);
    // Avoid package export maps by resolving package.json and building a file path.
    const pkgJsonPath = req.resolve('tsx/package.json');
    const pkgDir = dirname(pkgJsonPath);
    const hookPath = join(pkgDir, 'dist', 'esm', 'index.mjs');
    if (existsSync(hookPath)) return hookPath;
    return null;
  } catch {
    return null;
  }
}

function resolveSubprocessEntrypoint(): string {
  const override = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
  if (typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return join(projectPath(), 'dist', 'index.mjs');
}

function resolveDevTsxFallbackEntrypoint(entrypoint: string): string {
  const distSegment = `${projectPath()}/dist/`;
  const normalized = entrypoint.replaceAll('\\', '/');
  if (normalized.startsWith(distSegment)) {
    return join(projectPath(), 'src', 'index.ts');
  }
  return join(projectPath(), 'src', 'index.ts');
}

function resolveCliTsxTsconfigPath(): string {
  // The TSX loader resolves TS path aliases (`@/...`) using the tsconfig it finds.
  // Daemon-spawned subprocesses intentionally run in arbitrary `cwd`s, so TSX may
  // pick up the wrong tsconfig (or none) unless we provide an explicit path.
  //
  // TSX supports this via `TSX_TSCONFIG_PATH`, but we only want to set it for the
  // spawned subprocess, not mutate the parent process environment.
  return join(projectPath(), 'tsconfig.json');
}

function shouldAllowDevTsxFallback(): boolean {
  const raw = (process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK ?? '').trim().toLowerCase();
  if (raw) {
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
    return true;
  }
  const isDevVariant = process.env.HAPPIER_VARIANT === 'dev';
  const hasStackContext = Boolean(
    process.env.HAPPIER_STACK_REPO_DIR ||
      process.env.HAPPIER_STACK_CLI_ROOT_DIR ||
      process.env.HAPPIER_STACK_STACK
  );
  if (!isDevVariant && !hasStackContext) return false;
  return true;
}

export type HappyCliSubprocessRuntime = 'node' | 'bun';

export type HappyCliSubprocessInvocation = {
  runtime: HappyCliSubprocessRuntime;
  argv: string[];
  env?: Record<string, string>;
};

export type HappyCliSubprocessLaunchSpec = {
  runtime: HappyCliSubprocessRuntime;
  filePath: string;
  args: string[];
  env?: Record<string, string>;
};

function isRuntimeExecutablePath(pathLike: string): boolean {
  const base = basename(String(pathLike ?? '').trim()).toLowerCase();
  return base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
}

function isCurrentProcessSelfContainedBinary(): boolean {
  const execPath = String(process.execPath ?? '').trim();
  if (!execPath) return false;
  return !isRuntimeExecutablePath(execPath);
}

function resolveCurrentProcessBundledScriptPath(): string | null {
  const scriptPath = String(process.argv[1] ?? '').trim();
  if (!scriptPath) return null;
  const normalized = scriptPath.replaceAll('\\', '/');
  if (normalized.startsWith('/$bunfs/root/')) return scriptPath;
  if (!existsSync(scriptPath)) return null;
  const lowered = normalized.toLowerCase();
  const base = basename(lowered);
  if (base.includes('happier')) return scriptPath;
  if (base === 'index.mjs' && (lowered.includes('/@happier-dev/cli/') || lowered.includes('/happier/'))) {
    return scriptPath;
  }
  return null;
}

function resolveSubprocessRuntimeExecutable(runtime: HappyCliSubprocessRuntime): string {
  // Prefer the currently-running runtime binary when possible. This avoids PATH
  // issues on Windows (and GUI-launched shells) where `node`/`bun` may not resolve.
  if (runtime === 'node' && !isBun()) return process.execPath;
  if (runtime === 'bun' && isBun()) return process.execPath;
  return runtime;
}

export function buildHappyCliSubprocessInvocation(args: string[]): HappyCliSubprocessInvocation {
  const entrypoint = resolveSubprocessEntrypoint();
  const runtime = getSubprocessRuntime();

  // Use the same Node.js flags that the wrapper script uses
  const nodeArgs = [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    const allowTsxFallback = shouldAllowDevTsxFallback();
    if (runtime === 'node' && allowTsxFallback) {
      const tsxEntrypoint = resolveDevTsxFallbackEntrypoint(entrypoint);
      if (existsSync(tsxEntrypoint)) {
        const tsxHook = resolveTsxImportHookPath();
        if (!tsxHook) {
          const errorMessage = `tsx is required for TSX fallback but could not be resolved from the cli package`;
          logger.debug(`[SPAWN HAPPIER CLI] ${errorMessage}`);
          throw new Error(errorMessage);
        }
        return {
          runtime: 'node',
          argv: ['--no-warnings', '--no-deprecation', '--import', tsxHook, tsxEntrypoint, ...args],
          env: { TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath() },
        };
      }
    }
    if (runtime === 'bun') {
      const bundledScriptPath = resolveCurrentProcessBundledScriptPath();
      if (bundledScriptPath) {
        return { runtime: 'bun', argv: [bundledScriptPath, ...args] };
      }
      if (isCurrentProcessSelfContainedBinary()) {
        return { runtime: 'bun', argv: [...args] };
      }
    }
    const errorMessage = `Entrypoint ${entrypoint} does not exist`;
    logger.debug(`[SPAWN HAPPIER CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }

  const argv = runtime === 'node' ? nodeArgs : [entrypoint, ...args];
  return { runtime, argv };
}

export function buildHappyCliSubprocessLaunchSpec(args: string[]): HappyCliSubprocessLaunchSpec {
  const invocation = buildHappyCliSubprocessInvocation(args);
  return {
    runtime: invocation.runtime,
    filePath: resolveSubprocessRuntimeExecutable(invocation.runtime),
    args: invocation.argv,
    env: invocation.env,
  };
}

/**
 * Spawn the Happier CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/happier.mjs) and spawns the 
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Happier CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'happier' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'happier' here because other engineers are typically looking
  // for when "happier" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `happier ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPPIER CLI] Spawning: ${fullCommand} in ${directory}`);

  const launchSpec = buildHappyCliSubprocessLaunchSpec(args);
  const spawnOptions: SpawnOptions = launchSpec.env
    ? { ...options, env: { ...(options.env ?? process.env), ...launchSpec.env } }
    : options;
  return spawn(launchSpec.filePath, launchSpec.args, spawnOptions);
}
