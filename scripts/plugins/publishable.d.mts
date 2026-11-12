export interface PublishablePlugin {
  id: string;
  packageName: string;
  packageDir: string;
}
export function isPublishablePluginPackage(value: unknown): boolean;
export function readPublishablePlugins(repoRoot: string): PublishablePlugin[];
