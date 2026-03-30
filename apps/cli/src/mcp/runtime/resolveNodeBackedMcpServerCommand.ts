import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { projectPath } from '@/projectPath';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { resolvePackagedRuntimeEntrypoint } from '@/runtime/resolvePackagedRuntimeEntrypoint';
import { isBun } from '@/utils/runtime';
import { resolveCliTsxTsconfigPath, resolveTsxImportHookPath } from '@/utils/spawnHappyCLI';

export type ResolvedNodeBackedMcpServerCommand = Readonly<{
  command: string;
  args: string[];
  env?: Record<string, string>;
}>;

export async function resolveNodeBackedMcpServerCommand(params: Readonly<{
  distEntrypointSegments: readonly string[];
  sourceEntrypointSegments: readonly string[];
  args?: readonly string[];
  preferSourceEntrypoint?: boolean;
}>): Promise<ResolvedNodeBackedMcpServerCommand> {
  const command = await requireJavaScriptRuntimeExecutable({
    isBunRuntime: isBun(),
    targetLabel: 'built-in MCP server',
  });
  const sourceEntrypoint = join(projectPath(), 'src', ...params.sourceEntrypointSegments);
  const tsxHookPath = resolveTsxImportHookPath();
  const packagedEntrypoint = resolvePackagedRuntimeEntrypoint(join(...params.distEntrypointSegments));
  const shouldPreferSourceEntrypoint = params.preferSourceEntrypoint === true;

  if (shouldPreferSourceEntrypoint && existsSync(sourceEntrypoint) && typeof tsxHookPath === 'string' && tsxHookPath.length > 0) {
    return {
      command,
      args: ['--no-warnings', '--no-deprecation', '--import', tsxHookPath, sourceEntrypoint, ...(params.args ?? [])],
      env: {
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
      },
    };
  }

  if (existsSync(packagedEntrypoint)) {
    return {
      command,
      args: ['--no-warnings', '--no-deprecation', packagedEntrypoint, ...(params.args ?? [])],
    };
  }

  if (existsSync(sourceEntrypoint) && typeof tsxHookPath === 'string' && tsxHookPath.length > 0) {
    return {
      command,
      args: ['--no-warnings', '--no-deprecation', '--import', tsxHookPath, sourceEntrypoint, ...(params.args ?? [])],
      env: {
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
      },
    };
  }

  throw new Error(
    [
      '[mcp] Unable to resolve a runnable Node-backed MCP server entrypoint.',
      `packagedEntrypoint=${packagedEntrypoint}`,
      `sourceEntrypoint=${sourceEntrypoint}`,
      `tsxImportHook=${tsxHookPath ?? 'null'}`,
      'Expected either:',
      '- the packaged entrypoint to exist (package-dist/dist), or',
      '- a TSX import hook + source entrypoint to be available for dev execution.',
    ].join(' '),
  );
}
