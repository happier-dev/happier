export type PackageBuildOutputTarget = string;

export const WORKSPACE_PACKAGE_BUILD_INPUT_RECORD: '.happier-build-inputs.json';
/** Digest of a build input record's manifest, stored only after build-time canonical validation. */
export function digestBuildInputRecordManifest(manifest: unknown): string;
export const PLUGIN_UI_DIST_DIRECTORY: 'happier-plugin-ui';
export const PLUGIN_UI_PACKAGED_RESOURCES_DIRECTORY: 'packaged-resources';
export const SOURCE_PLUGIN_UI_PUBLISHER_ENTRIES: readonly string[];

export type ResolvePackageBuildOutputTargetPathOptions = Readonly<{
  packageDir: string;
  outputDir: string;
  target: PackageBuildOutputTarget;
}>;

export type ResolvePackageBuildOutputTargetMatchesOptions =
  ResolvePackageBuildOutputTargetPathOptions & Readonly<{
    existsSyncImpl?: (path: string) => boolean;
    readdirSyncImpl?: (
      path: string,
      options: Readonly<{ withFileTypes: true }>,
    ) => readonly Readonly<{
      name: string;
      isDirectory: () => boolean;
    }>[];
  }>;

export function collectPackageBuildOutputTargets(packageJson: unknown): PackageBuildOutputTarget[];
export function isLocalPackageBuildOutputTarget(target: PackageBuildOutputTarget): boolean;
export function isPackageBuildDistOutputTarget(target: PackageBuildOutputTarget): boolean;
export function resolvePackageBuildOutputTargetPath(options: ResolvePackageBuildOutputTargetPathOptions): string;
export function resolvePackageBuildOutputTargetMatches(
  options: ResolvePackageBuildOutputTargetMatchesOptions,
): string[];
