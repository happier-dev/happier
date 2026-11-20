import type { BundledPluginPublicationFailure } from '../../../scripts/workspaces/bundledPluginPublicationFailure.mjs';

export declare function prepareSourceCliPluginUiArtifacts(options: Readonly<{
  repoRoot: string;
  workspaceNames: readonly string[];
  pluginFailures?: readonly BundledPluginPublicationFailure[];
}>): Promise<Readonly<{
  outputPath: string;
  pluginFailures: readonly BundledPluginPublicationFailure[];
}> | null>;
