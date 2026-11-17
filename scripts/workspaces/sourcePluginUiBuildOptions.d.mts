import type { readWorkspacePackages } from '../../packages/cli-common/sourceRuntimeEntries.mjs';

export const SOURCE_PLUGIN_UI_IMPORT_CONDITIONS: readonly string[];

export function sourcePluginUiBuildOptions(options: {
  repoRoot: string;
  packages?: Awaited<ReturnType<typeof readWorkspacePackages>>;
  resolveSourceImport?: (specifier: string) => string | undefined;
  sourceImportConditions?: readonly string[];
}): Promise<{
  exportConditions: string[];
  resolveSourceImport: (specifier: string) => string | undefined;
}>;
