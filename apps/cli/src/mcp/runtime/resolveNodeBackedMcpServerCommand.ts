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
}>): Promise<ResolvedNodeBackedMcpServerCommand> {
  const command = await requireJavaScriptRuntimeExecutable({
    isBunRuntime: isBun(),
    targetLabel: 'built-in MCP server',
  });
  const packagedEntrypoint = resolvePackagedRuntimeEntrypoint(join(...params.distEntrypointSegments));
  if (existsSync(packagedEntrypoint)) {
    return {
      command,
      args: ['--no-warnings', '--no-deprecation', packagedEntrypoint, ...(params.args ?? [])],
    };
  }

  const sourceEntrypoint = join(projectPath(), 'src', ...params.sourceEntrypointSegments);
  const tsxHookPath = resolveTsxImportHookPath();
  if (existsSync(sourceEntrypoint) && typeof tsxHookPath === 'string' && tsxHookPath.length > 0) {
    return {
      command,
      args: ['--no-warnings', '--no-deprecation', '--import', tsxHookPath, sourceEntrypoint, ...(params.args ?? [])],
      env: {
        TSX_TSCONFIG_PATH: resolveCliTsxTsconfigPath(),
      },
    };
  }

  return {
    command,
    args: ['--no-warnings', '--no-deprecation', packagedEntrypoint, ...(params.args ?? [])],
  };
}
