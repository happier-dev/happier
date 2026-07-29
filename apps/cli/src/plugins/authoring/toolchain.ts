import { spawn as spawnChild } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  buildManagedPnpmEnvironment,
  ensureManagedPnpmCommand,
  managedPnpmBinPath,
} from '@/packagedRuntime/managedTools/pnpm/managedPnpm';
import {
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeBinPath,
} from '@/packagedRuntime/js/managedJavaScriptRuntime';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { PLUGIN_UI_BUILD_CONFIG_BASENAMES } from '@happier-dev/plugin-sdk/ui/build';

import {
  bundlePluginDaemonRuntime,
  PluginAuthorBundlerUnavailableError,
} from './bundleDaemonRuntime';

export type PluginAuthorToolchainOperation = 'install' | 'typecheck' | 'build' | 'test';

export type PluginAuthorToolchainDiagnostic = Readonly<{
  code:
    | 'plugin_author_invalid_input'
    | 'plugin_author_managed_tool_unavailable'
    | 'plugin_author_tool_failed';
  message: string;
}>;

export type PluginAuthorToolchainResult =
  | Readonly<{
      ok: true;
      operation: PluginAuthorToolchainOperation;
      projectRoot: string;
    }>
  | Readonly<{
      ok: false;
      operation: PluginAuthorToolchainOperation;
      projectRoot: string;
      diagnostics: readonly PluginAuthorToolchainDiagnostic[];
    }>;

export type PluginAuthorToolchainSpawnInput = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

export type PluginAuthorToolchainSpawnResult = Readonly<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;

export type PluginAuthorToolchainSpawnInvocation = PluginAuthorToolchainSpawnInput & Readonly<{
  windowsVerbatimArguments?: boolean;
}>;

export type PluginAuthorToolchainDeps = Readonly<{
  ensureManagedPnpmCommand: typeof ensureManagedPnpmCommand;
  managedPnpmBinPath: typeof managedPnpmBinPath;
  buildManagedPnpmEnvironment: typeof buildManagedPnpmEnvironment;
  ensureManagedJavaScriptRuntimeCommand: typeof ensureManagedJavaScriptRuntimeCommand;
  managedJavaScriptRuntimeBinPath: typeof managedJavaScriptRuntimeBinPath;
  resolveNativeTypeScriptBin: (projectRoot: string) => string;
  resolvePluginUiBuildBin?: (projectRoot: string) => string | null;
  bundlePluginDaemonRuntime?: (projectRoot: string) => Promise<void>;
  spawn: (input: PluginAuthorToolchainSpawnInput) => Promise<PluginAuthorToolchainSpawnResult>;
  processEnv: NodeJS.ProcessEnv;
}>;

function createDiagnostic(
  code: PluginAuthorToolchainDiagnostic['code'],
  message: string,
): PluginAuthorToolchainDiagnostic {
  return { code, message };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function normalizePluginSdkRegistryOrigin(value: string | null | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = new URL(raw);
  const allowed = parsed.protocol === 'https:'
    || (parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname));
  if (!allowed || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Plugin SDK registry must be a credential-free HTTPS origin or loopback HTTP origin');
  }
  return parsed.origin;
}

function resolveProjectRoot(pathLike: string): string {
  const trimmed = pathLike.trim();
  if (!trimmed) throw new Error('Plugin author project root is required');
  return resolve(trimmed);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

export function resolveNativeTypeScriptBin(projectRoot: string): string {
  const require = createRequire(join(projectRoot, 'package.json'));
  const packageJsonPath = require.resolve('@typescript/native/package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: { tsc?: unknown };
    version?: unknown;
  };
  const projectNodeModulesRoot = join(realpathSync(projectRoot), 'node_modules');
  if (!isPathInsideRoot(projectNodeModulesRoot, packageJsonPath)) {
    throw new Error('Resolved @typescript/native package must be project-local');
  }
  if (typeof packageJson.version !== 'string' || !/^7\./u.test(packageJson.version)) {
    throw new Error('Resolved @typescript/native package must provide TypeScript 7');
  }
  const relativeBin = packageJson.bin?.tsc;
  if (typeof relativeBin !== 'string' || !relativeBin.trim()) {
    throw new Error('@typescript/native does not declare the TypeScript compiler entrypoint');
  }
  const packageRoot = realpathSync(dirname(packageJsonPath));
  if (!isPathInsideRoot(projectNodeModulesRoot, packageRoot)) {
    throw new Error('Resolved @typescript/native package root must remain inside project-local node_modules');
  }
  const compilerPath = resolve(packageRoot, relativeBin);
  if (!isPathInsideRoot(packageRoot, compilerPath)) {
    throw new Error('Resolved TypeScript compiler entrypoint must remain inside the installed @typescript/native package');
  }
  const resolvedCompilerPath = realpathSync(compilerPath);
  if (!statSync(resolvedCompilerPath).isFile() || !isPathInsideRoot(packageRoot, resolvedCompilerPath)) {
    throw new Error('Resolved TypeScript compiler entrypoint must be a contained regular file inside @typescript/native');
  }
  return resolvedCompilerPath;
}

export function resolvePluginUiBuildBin(projectRoot: string): string | null {
  const resolvedProjectRoot = realpathSync(projectRoot);
  const hasUiBuildConfig = PLUGIN_UI_BUILD_CONFIG_BASENAMES.some((basename) => {
    try {
      statSync(join(resolvedProjectRoot, basename));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
      throw error;
    }
  });
  if (!hasUiBuildConfig) {
    return null;
  }

  const projectNodeModulesRoot = realpathSync(join(resolvedProjectRoot, 'node_modules'));
  const packageJsonPath = realpathSync(join(
    resolvedProjectRoot,
    'node_modules',
    '@happier-dev',
    'plugin-sdk',
    'package.json',
  ));
  if (!isPathInsideRoot(projectNodeModulesRoot, packageJsonPath)) {
    throw new Error('Resolved Plugin SDK package must be project-local');
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    name?: unknown;
    bin?: Record<string, unknown>;
  };
  if (packageJson.name !== '@happier-dev/plugin-sdk') {
    throw new Error('Resolved Plugin UI builder must come from @happier-dev/plugin-sdk');
  }
  const relativeBin = packageJson.bin?.['happier-plugin-build-ui'];
  if (typeof relativeBin !== 'string' || !relativeBin.trim()) {
    throw new Error('@happier-dev/plugin-sdk does not declare the Plugin UI builder entrypoint');
  }
  const packageRoot = dirname(packageJsonPath);
  const builderPath = resolve(packageRoot, relativeBin);
  if (!isPathInsideRoot(packageRoot, builderPath)) {
    throw new Error('Resolved Plugin UI builder entrypoint must remain inside @happier-dev/plugin-sdk');
  }
  const resolvedBuilderPath = realpathSync(builderPath);
  if (!statSync(resolvedBuilderPath).isFile() || !isPathInsideRoot(packageRoot, resolvedBuilderPath)) {
    throw new Error('Resolved Plugin UI builder entrypoint must be a contained regular file');
  }
  return resolvedBuilderPath;
}

export function resolvePluginAuthorToolchainSpawnInvocation(
  input: PluginAuthorToolchainSpawnInput,
): PluginAuthorToolchainSpawnInvocation {
  const invocation = resolveWindowsCommandInvocation({
    command: input.command,
    args: input.args,
    env: input.env,
  });
  return {
    ...input,
    command: invocation.command,
    args: invocation.args,
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  };
}

async function spawn(input: PluginAuthorToolchainSpawnInput): Promise<PluginAuthorToolchainSpawnResult> {
  const invocation = resolvePluginAuthorToolchainSpawnInvocation(input);
  return await new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawnChild(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      ...(invocation.signal ? { signal: invocation.signal } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once('error', rejectSpawn);
    child.once('close', (exitCode, signal) => resolveSpawn({
      exitCode,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

const defaultDeps: PluginAuthorToolchainDeps = {
  ensureManagedPnpmCommand,
  managedPnpmBinPath,
  buildManagedPnpmEnvironment,
  ensureManagedJavaScriptRuntimeCommand,
  managedJavaScriptRuntimeBinPath,
  resolveNativeTypeScriptBin,
  resolvePluginUiBuildBin,
  bundlePluginDaemonRuntime,
  spawn,
  processEnv: process.env,
};

export type ManagedPluginPnpmRunResult =
  | Readonly<{ ok: true; result: PluginAuthorToolchainSpawnResult }>
  | Readonly<{ ok: false; message: string }>;

export async function runManagedPluginPnpm(
  params: Readonly<{
    projectRoot: string;
    args: readonly string[];
    sdkRegistryOrigin?: string | null;
    signal?: AbortSignal;
  }>,
  deps: Pick<
    PluginAuthorToolchainDeps,
    | 'ensureManagedPnpmCommand'
    | 'managedPnpmBinPath'
    | 'buildManagedPnpmEnvironment'
    | 'spawn'
    | 'processEnv'
  > = defaultDeps,
): Promise<ManagedPluginPnpmRunResult> {
  const projectRoot = resolveProjectRoot(params.projectRoot);
  const registryOrigin = normalizePluginSdkRegistryOrigin(params.sdkRegistryOrigin);
  const pnpmCommand = await deps.ensureManagedPnpmCommand(deps.processEnv);
  if (!pnpmCommand) {
    return { ok: false, message: 'The Happier-managed package materializer is unavailable' };
  }
  if (!isApprovedManagedPnpmCommand(pnpmCommand, deps.managedPnpmBinPath(deps.processEnv))) {
    return {
      ok: false,
      message: 'Plugin dependency installation refuses a PATH package-manager fallback; the Happier-managed package materializer is required',
    };
  }
  return {
    ok: true,
    result: await deps.spawn({
      command: pnpmCommand,
      args: [
        ...params.args,
        ...(registryOrigin ? [`--config.@happier-dev:registry=${registryOrigin}`] : []),
      ],
      cwd: projectRoot,
      env: deps.buildManagedPnpmEnvironment(deps.processEnv),
      ...(params.signal ? { signal: params.signal } : {}),
    }),
  };
}

function failedResult(params: Readonly<{
  operation: PluginAuthorToolchainOperation;
  projectRoot: string;
  code: PluginAuthorToolchainDiagnostic['code'];
  message: string;
}>): PluginAuthorToolchainResult {
  return {
    ok: false,
    operation: params.operation,
    projectRoot: params.projectRoot,
    diagnostics: [createDiagnostic(params.code, params.message)],
  };
}

function processFailureMessage(operation: PluginAuthorToolchainOperation, result: PluginAuthorToolchainSpawnResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim();
  const suffix = detail ? `: ${detail}` : '';
  return `Plugin author ${operation} failed with ${result.signal ?? result.exitCode ?? 'unknown status'}${suffix}`;
}

function isApprovedManagedPnpmCommand(
  command: string,
  expectedManagedPath: string,
): boolean {
  const normalizePath = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return expectedManagedPath.trim().length > 0
    && normalizePath(command) === normalizePath(expectedManagedPath.trim());
}

function isApprovedManagedJavaScriptRuntimeCommand(
  command: string,
  expectedManagedPath: string,
): boolean {
  const normalizePath = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return expectedManagedPath.trim().length > 0
    && normalizePath(command) === normalizePath(expectedManagedPath.trim());
}

export async function runPluginAuthorToolchain(
  params: Readonly<{
    operation: PluginAuthorToolchainOperation;
    projectRoot: string;
    sdkRegistryOrigin?: string | null;
    signal?: AbortSignal;
  }>,
  deps: PluginAuthorToolchainDeps = defaultDeps,
): Promise<PluginAuthorToolchainResult> {
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(params.projectRoot);
  } catch (error) {
    return failedResult({
      operation: params.operation,
      projectRoot: params.projectRoot,
      code: 'plugin_author_invalid_input',
      message: error instanceof Error ? error.message : 'Plugin author project root is invalid',
    });
  }

  try {
    if (params.operation === 'install') {
      const managedPnpm = await runManagedPluginPnpm({
        projectRoot,
        args: ['install', '--ignore-scripts'],
        sdkRegistryOrigin: params.sdkRegistryOrigin,
        ...(params.signal ? { signal: params.signal } : {}),
      }, deps);
      if (!managedPnpm.ok) {
        return failedResult({
          operation: params.operation,
          projectRoot,
          code: 'plugin_author_managed_tool_unavailable',
          message: managedPnpm.message,
        });
      }
      if (managedPnpm.result.exitCode !== 0 || managedPnpm.result.signal !== null) {
        return failedResult({
          operation: params.operation,
          projectRoot,
          code: 'plugin_author_tool_failed',
          message: processFailureMessage(params.operation, managedPnpm.result),
        });
      }
      return { ok: true, operation: params.operation, projectRoot };
    }

    let invocation: PluginAuthorToolchainSpawnInput;
    {
      const runtimeCommand = await deps.ensureManagedJavaScriptRuntimeCommand(deps.processEnv);
      if (!runtimeCommand) {
        return failedResult({
          operation: params.operation,
          projectRoot,
          code: 'plugin_author_managed_tool_unavailable',
          message: 'The Happier-managed JavaScript runtime is unavailable',
        });
      }
      if (!isApprovedManagedJavaScriptRuntimeCommand(
        runtimeCommand,
        deps.managedJavaScriptRuntimeBinPath(deps.processEnv),
      )) {
        return failedResult({
          operation: params.operation,
          projectRoot,
          code: 'plugin_author_managed_tool_unavailable',
          message: 'Plugin author checks refuse the host process runtime; the Happier-managed JavaScript runtime is required',
        });
      }
      if (params.operation === 'test') {
        const compilerPath = deps.resolveNativeTypeScriptBin(projectRoot);
        const compileResult = await deps.spawn({
          command: runtimeCommand,
          args: [compilerPath, '-p', 'tsconfig.json'],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (compileResult.exitCode !== 0 || compileResult.signal !== null) {
          return failedResult({
            operation: params.operation,
            projectRoot,
            code: 'plugin_author_tool_failed',
            message: processFailureMessage(params.operation, compileResult),
          });
        }
        await (deps.bundlePluginDaemonRuntime ?? bundlePluginDaemonRuntime)(projectRoot);
        invocation = {
          command: runtimeCommand,
          args: ['--test', 'test/index.test.mjs'],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        };
      } else {
        const compilerPath = deps.resolveNativeTypeScriptBin(projectRoot);
        invocation = {
          command: runtimeCommand,
          args: [
            compilerPath,
            ...(params.operation === 'typecheck' ? ['--noEmit'] : []),
            '-p',
            'tsconfig.json',
          ],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        };
      }
    }

    const result = await deps.spawn(invocation);
    if (result.exitCode !== 0 || result.signal !== null) {
      return failedResult({
        operation: params.operation,
        projectRoot,
        code: 'plugin_author_tool_failed',
        message: processFailureMessage(params.operation, result),
      });
    }
    if (params.operation === 'build') {
      const uiBuildBin = (deps.resolvePluginUiBuildBin ?? resolvePluginUiBuildBin)(projectRoot);
      if (uiBuildBin) {
        const uiBuildResult = await deps.spawn({
          command: invocation.command,
          args: [uiBuildBin, '--project-root', projectRoot],
          cwd: projectRoot,
          env: deps.processEnv,
          ...(params.signal ? { signal: params.signal } : {}),
        });
        if (uiBuildResult.exitCode !== 0 || uiBuildResult.signal !== null) {
          return failedResult({
            operation: params.operation,
            projectRoot,
            code: 'plugin_author_tool_failed',
            message: processFailureMessage(params.operation, uiBuildResult),
          });
        }
      }
      await (deps.bundlePluginDaemonRuntime ?? bundlePluginDaemonRuntime)(projectRoot);
    }
    return { ok: true, operation: params.operation, projectRoot };
  } catch (error) {
    return failedResult({
      operation: params.operation,
      projectRoot,
      code: error instanceof PluginAuthorBundlerUnavailableError
        ? 'plugin_author_managed_tool_unavailable'
        : 'plugin_author_tool_failed',
      message: error instanceof Error ? error.message : `Plugin author ${params.operation} failed`,
    });
  }
}
