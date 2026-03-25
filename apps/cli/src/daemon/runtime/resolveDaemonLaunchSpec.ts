import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseOptionalBooleanEnv } from '@happier-dev/protocol';

import { projectPath } from '@/projectPath';
import { resolvePackagedRuntimeEntrypoint } from '@/runtime/resolvePackagedRuntimeEntrypoint';
import { ensureJavaScriptRuntimeExecutable } from '@/runtime/js/ensureJavaScriptRuntimeExecutable';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

export type DaemonLaunchSpec = Readonly<{
  filePath: string;
  args: string[];
  env?: Record<string, string>;
}>;

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

export async function resolveDaemonLaunchSpec(cliArgs: readonly string[]): Promise<DaemonLaunchSpec> {
  const runtimeExecutable = await ensureJavaScriptRuntimeExecutable({
    isBunRuntime: false,
    currentExecPath: process.execPath,
  });
  if (!runtimeExecutable) {
    throw new Error('Daemon launch requires a JavaScript runtime, but none could be resolved');
  }

  const packagedEntrypoint = resolvePackagedRuntimeEntrypoint('index.mjs');
  if (existsSync(packagedEntrypoint)) {
    return {
      filePath: runtimeExecutable,
      args: ['--no-warnings', '--no-deprecation', packagedEntrypoint, ...cliArgs],
    };
  }

  const sourceEntrypoint = resolveSourceEntrypoint();
  if (shouldAllowDaemonTsxFallback() && existsSync(sourceEntrypoint)) {
    const tsxHook = resolveTsxImportHookPath();
    if (!tsxHook) {
      throw new Error('Daemon launch requires tsx for source fallback, but tsx could not be resolved');
    }
    return {
      filePath: runtimeExecutable,
      args: ['--no-warnings', '--no-deprecation', '--import', tsxHook, sourceEntrypoint, ...cliArgs],
      env: {
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
      },
    };
  }

  throw new Error(`Daemon packaged entrypoint is missing: ${packagedEntrypoint}`);
}
